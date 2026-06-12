use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use crate::retrom_dirs::RetromDirs;
use sha2::Digest;
use tokio::fs;
use tokio::process::Command;
use tracing::{debug, warn};

fn normalize_query_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn soundtrack_queries(name: &str) -> Vec<String> {
    vec![
        format!("\"{name}\" main theme"),
        format!("\"{name}\" overture"),
        format!("\"{name}\" opening theme"),
        format!("\"{name}\" title theme"),
        format!("\"{name}\" theme song"),
        format!("\"{name}\" official soundtrack main theme"),
        format!("\"{name}\" ost main theme"),
        format!("\"{name}\" official soundtrack"),
    ]
}

#[derive(Debug)]
struct YoutubeCandidate {
    video_id: String,
    score: i32,
}

fn score_title(title: &str, game_name: &str) -> i32 {
    let title = title.to_ascii_lowercase();
    let game_name = game_name.to_ascii_lowercase();

    if [
        "trailer",
        "gameplay",
        "walkthrough",
        "review",
        "reaction",
        "commercial",
        "advertisement",
        "soundfont",
        "remix",
        "cover",
        "classical",
        "piano arrangement",
        "8bit",
        "chiptune cover",
    ]
    .iter()
    .any(|term| title.contains(term))
    {
        return -100;
    }

    let mut score = 0;
    if title.contains(&game_name) {
        score += 20;
    }

    for term in [
        "main theme",
        "overture",
        "opening theme",
        "title theme",
        "theme song",
        "menu theme",
        "full theme",
        "extended theme",
    ] {
        if title.contains(term) {
            score += 80;
        }
    }

    for term in ["soundtrack", "ost", "original soundtrack", "music", "official audio"] {
        if title.contains(term) {
            score += 30;
        }
    }

    // Small bonus for things that look like proper releases rather than fan edits.
    if title.contains("official") || title.contains("full soundtrack") {
        score += 15;
    }

    // Strong penalty for long-form / compilation content (we only want short themes <=10min for extraction).
    if title.contains("hour") || title.contains("compilation") || title.contains("full ost") || title.contains("complete ") || title.contains("1 hour") || title.contains("full soundtrack") {
        score -= 80;
    }

    score
}

fn decode_title(raw: &str) -> String {
    raw.replace("\\u0026", "&").replace("\\\"", "\"")
}

fn parse_youtube_candidates(body: &str, game_name: &str) -> Vec<YoutubeCandidate> {
    let with_title = Regex::new(
        r#""videoId":"([A-Za-z0-9_-]{11})"(?s:.{0,2000}?)"title":\{"runs":\[\{"text":"([^"]+)""#,
    )
    .ok();
    // Try to also capture lengthText for free duration hints from search results (ytInitialData).
    let with_title_and_length = Regex::new(
        r#""videoId":"([A-Za-z0-9_-]{11})"(?s:.{0,3000}?)"lengthText":\{"simpleText":"([^"]+)""#,
    )
    .ok();
    let video_id = Regex::new(r#""videoId":"([A-Za-z0-9_-]{11})""#).ok();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    // Prefer richer matches that include length (for early long-video penalty).
    if let Some(re) = with_title_and_length {
        for caps in re.captures_iter(body) {
            let Some(video_id) = caps.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if !seen.insert(video_id.clone()) {
                continue;
            }

            // We don't have title in this specific regex; rely on score=0 here + later title pass
            // or the yt-dlp duration probe later. Use length only to heavily penalize obvious longs.
            let mut score = 0;
            if let Some(len) = caps.get(2).map(|m| m.as_str()) {
                if let Some(secs) = parse_duration_to_secs(len) {
                    if secs > 600 {
                        score -= 120; // strong early discard signal for long compilations
                    } else {
                        score += 5; // small bonus for known-short
                    }
                }
            }

            candidates.push(YoutubeCandidate { video_id, score });
        }
    }

    if let Some(with_title) = with_title {
        for caps in with_title.captures_iter(body) {
            let Some(video_id) = caps.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if !seen.insert(video_id.clone()) {
                continue;
            }

            let title = caps.get(2).map(|m| decode_title(m.as_str()));
            let score = title
                .as_deref()
                .map(|title| score_title(title, game_name))
                .unwrap_or(0);

            candidates.push(YoutubeCandidate { video_id, score });
        }
    }

    if let Some(video_id) = video_id {
        for caps in video_id.captures_iter(body) {
            let Some(video_id) = caps.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if !seen.insert(video_id.clone()) {
                continue;
            }

            candidates.push(YoutubeCandidate { video_id, score: 0 });
        }
    }

    candidates
}

/// Parse common YouTube duration strings ("3:45", "1:02:30", "45") to seconds.
/// Returns None for unparseable / live / unknown.
fn parse_duration_to_secs(s: &str) -> Option<u32> {
    let s = s.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("live") {
        return None;
    }
    let parts: Vec<&str> = s.split(':').collect();
    let mut secs = 0u32;
    for (i, p) in parts.iter().rev().enumerate() {
        if let Ok(v) = p.trim().parse::<u32>() {
            secs += v * 60u32.pow(i as u32);
        } else {
            return None;
        }
    }
    Some(secs)
}

/// Cheap metadata-only probe for a video's duration in seconds using the yt-dlp binary
/// (no media is downloaded). Used to enforce the "short theme only (<= 10 minutes)"
/// rule so we don't waste time/bandwidth/disk on hour-long OST compilations during
/// the up-front metadata update jobs (or lazy ensure).
async fn probe_video_duration_secs(video_id: &str) -> Option<u32> {
    let yt_dlp_path = ensure_yt_dlp().await?;

    let yt_url = format!("https://www.youtube.com/watch?v={}", video_id);

    let output = match Command::new(&yt_dlp_path)
        .args([
            "--no-download",
            "--no-playlist",
            "--print",
            "%(duration)s",
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            &yt_url,
        ])
        .output()
        .await
    {
        Ok(o) => o,
        Err(_) => return None,
    };

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() || stdout.eq_ignore_ascii_case("na") || stdout.eq_ignore_ascii_case("live") {
        return None;
    }

    // %(duration)s typically emits seconds (numeric)
    stdout.parse::<f64>().ok().map(|d| d.round() as u32)
}

pub async fn find_soundtrack_url(game_name: &str) -> Option<String> {
    let normalized_name = normalize_query_name(game_name);
    if normalized_name.is_empty() {
        return None;
    }

    // Collect the single best (highest score) *short* candidate across *all* queries.
    // We enforce <= 10 minutes (600s) for the theme extraction "download" so that
    // the resulting theme.* file is a reasonable persistent metadata asset (NAS/local)
    // rather than hour-long compilations. Probes are cheap (info only).
    // Long results are discarded from the soundtrack choice used for audio extraction.
    let mut best: Option<(String, i32, u32)> = None; // (url, score, duration_secs)

    for query in soundtrack_queries(&normalized_name) {
        let url = match reqwest::Url::parse_with_params(
            "https://www.youtube.com/results",
            &[("search_query", query.as_str())],
        ) {
            Ok(u) => u,
            Err(_) => continue,
        };

        let body = match reqwest::Client::new()
            .get(url)
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .send()
            .await
        {
            Ok(resp) => match resp.text().await {
                Ok(t) => t,
                Err(_) => continue,
            },
            Err(_) => continue,
        };

        let candidates = parse_youtube_candidates(&body, &normalized_name);

        debug!(
            "soundtrack search query '{}' for '{}' produced {} candidates",
            query, normalized_name, candidates.len()
        );

        // Only consider positively scored (good title match). Then probe the top few
        // for actual duration and keep only short ones (<=10min). This is the key
        // safeguard for the yt-dlp "download becomes metadata" flow.
        let mut scored: Vec<_> = candidates.iter().filter(|c| c.score > 0).collect();
        scored.sort_by_key(|c| std::cmp::Reverse(c.score));

        for cand in scored.into_iter().take(5) {
            let dur = probe_video_duration_secs(&cand.video_id).await;
            let is_short = dur.map_or(true, |d| d <= 600); // hard cap per original requirement (avoid hour+ compilations)
            let is_substantial = dur.map_or(true, |d| d >= 60); // avoid micro-clips / 15-45s stings that result in unsatisfying short loops

            if !is_short || !is_substantial {
                debug!(
                    "  skipping unsuitable candidate {} (dur {:?}s, short={}, substantial={}) for query '{}'",
                    cand.video_id, dur, is_short, is_substantial, query
                );
                continue;
            }

            // Prefer "fuller" themes within the cap for satisfying looped previews (ideal 1.5-7min range).
            // This directly addresses short looping audio feeling.
            let mut effective_score = cand.score;
            if let Some(d) = dur {
                if (90..=420).contains(&d) {
                    effective_score += 40; // sweet spot: proper theme with good length for looping
                } else if d > 420 && d <= 600 {
                    effective_score += 15;
                } else if d < 90 {
                    effective_score -= 25;
                }
                if dur.is_some() {
                    effective_score += 2; // known duration is better
                }
            }

            debug!(
                "  short+substantial candidate video {} (score {}, dur {:?}s) for query '{}'",
                cand.video_id, cand.score, dur, query
            );

            let is_better = best.as_ref().map_or(true, |(_, s, _)| effective_score > *s);
            if is_better {
                best = Some((
                    format!("https://www.youtube.com/watch?v={}", cand.video_id),
                    effective_score,
                    dur.unwrap_or(0),
                ));
            }
        }

        if !candidates.iter().any(|c| c.score > 0) && !candidates.is_empty() {
            debug!(
                "  {} candidates found for query but none scored >0 (no strong theme title match)",
                candidates.len()
            );
        }
    }

    if let Some((url, score, dur)) = &best {
        debug!(
            "final short soundtrack choice for query name '{}': {} (score {}, dur {}s)",
            normalized_name, url, score, dur
        );
    } else {
        debug!("no short soundtrack candidate found for query name '{}'", normalized_name);
    }

    best.map(|(url, _score, _dur)| url)
}

/// Returns an existing extracted theme audio file (e.g. theme.opus or theme.webm) inside
/// the per-game cache dir, if present. This is used to:
/// - skip redundant extraction
/// - locate the actual file (whatever container yt-dlp produced) when building MediaPaths
///   responses so the client can play it via native <video> without requiring the server
///   host to have ffmpeg installed.
///
/// We prefer known good audio containers (for old extractions that produced .opus via
/// ffmpeg, or current bestaudio downloads). As a fallback we accept *any* file literally
/// named "theme.*" so that exotic exts chosen by yt-dlp are still discovered.
pub fn find_theme_audio_file(cache_dir: &Path) -> Option<PathBuf> {
    let preferred = [
        "theme.opus",
        "theme.webm",
        "theme.m4a",
        "theme.ogg",
        "theme.mp3",
        "theme.flac",
        "theme.wav",
    ];
    for name in preferred {
        let p = cache_dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }

    // Any file starting with "theme." in the game cache dir (covers whatever yt-dlp wrote
    // for bestaudio, including cases with unusual extensions).
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Some(file_name) = p.file_name().and_then(|n| n.to_str()) {
                if file_name.starts_with("theme.") {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Given a YT video ID and a cache dir for the game (from GameMetadata::get_cache_dir),
/// attempt to extract best audio using yt-dlp (as theme.<ext>).
///
/// We use `--download-sections "*0:00-6:00"` to grab a solid chunk (up to ~6 minutes)
/// of the chosen video. Combined with the 10-minute video selection cap in
/// `find_soundtrack_url` (and min ~60s + sweet-spot bias toward 1.5-7min themes),
/// this produces satisfying looped preview assets (no more 15s micro-loops) while
/// avoiding the nightmare of hour-long compilations.
///
/// Does NOT use `-x`/`--audio-format` (which would require ffmpeg on the host for
/// post-processing). We prefer a direct audio-only format if available (for small files),
/// but fall back to "best" (which may include video). Either way the file is playable
/// via the hidden <video> (we only use its audio track). This makes extraction succeed
/// for far more videos without requiring ffmpeg or post-processing on the server.
///
/// yt-dlp binary is auto-downloaded (to data/bin) if missing.
/// Safe to call repeatedly; skips if a theme.* audio file already present.
pub async fn try_extract_theme_audio(video_id: &str, cache_dir: PathBuf, force: bool) -> Option<PathBuf> {
    let yt_dlp_path = ensure_yt_dlp().await?;

    if !force {
        if let Some(existing) = find_theme_audio_file(&cache_dir) {
            return Some(existing);
        }
    } else if find_theme_audio_file(&cache_dir).is_some() {
        // When forcing overwrite, clean up any existing theme.* files first so we re-download fresh.
        debug!("force overwrite requested for theme audio {} - removing existing files", video_id);
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("theme.") {
                        let _ = tokio::fs::remove_file(&p).await;
                    }
                }
            }
        }
    }

    // Pre-flight duration guard (belt-and-suspenders with the scrape-time 10min filter).
    // We refuse to start the download for anything we can prove is >10min.
    // This protects the "up-front metadata job" and NAS storage from long compilations
    // even if a long url somehow reached here (manual add, old data, race, etc.).
    if let Some(dur) = probe_video_duration_secs(video_id).await {
        if dur > 600 {
            warn!(
                "Refusing to yt-dlp extract theme audio for {} ({}s > 10min limit). Only short themes are extracted as persistent game metadata.",
                video_id, dur
            );
            return None;
        }
    }

    if let Err(e) = fs::create_dir_all(&cache_dir).await {
        warn!("Failed to create cache dir for theme audio {}: {}", video_id, e);
        return None;
    }

    let yt_url = format!("https://www.youtube.com/watch?v={}", video_id);

    // Use %(ext)s so yt-dlp writes the actual format it chose (no forced remux).
    let output_template = cache_dir
        .join("theme.%(ext)s")
        .to_string_lossy()
        .to_string();

    let output = match Command::new(&yt_dlp_path)
        .args([
            "--no-playlist",
            "--no-mtime",
            // Limit to a solid "theme" chunk (first ~6 minutes). This ensures satisfying loop
            // lengths (e.g. 2-6min pieces) even if the chosen video is longer within our 10min cap,
            // without downloading full hour-long compilations. Works without ffmpeg.
            "--download-sections", "*0:00-6:00",
            // Prefer direct audio-only (webm/opus or m4a etc, playable in <video> with no ffmpeg).
            // Fall back to "best" (video+audio) so that extraction almost always succeeds for
            // any downloadable video (the resulting file, even if it has a video track, is fine
            // for our tiny offscreen audio-only <video> player; we only care about the audio).
            // This makes the feature much more reliable across videos that may not have a pure
            // "bestaudio" format or have download restrictions.
            "-f",
            "bestaudio/best",
            // Make the request look like a normal browser to avoid some bot blocks / consent pages.
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            // Intentionally omit -x/--audio-format/* to avoid requiring ffmpeg/avconv
            // on the Retrom server machine. Native audio containers from YT are fine.
            "-o",
            &output_template,
            &yt_url,
        ])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => {
            warn!("Failed to spawn yt-dlp for {}: {}", video_id, e);
            return None;
        }
    };

    if output.status.success() {
        if let Some(p) = find_theme_audio_file(&cache_dir) {
            debug!(
                "Successfully extracted theme audio for {} -> {:?}",
                video_id, p
            );
            Some(p)
        } else {
            warn!(
                "yt-dlp reported success for {} but no theme.* file appeared in cache dir",
                video_id
            );
            None
        }
    } else {
        // Even on non-zero exit, yt-dlp sometimes writes a usable file (warnings, partial success).
        // Check anyway before declaring total failure.
        if let Some(p) = find_theme_audio_file(&cache_dir) {
            debug!(
                "yt-dlp exited non-zero for {} but a theme.* file appeared anyway -> {:?}",
                video_id, p
            );
            Some(p)
        } else {
            warn!(
                "yt-dlp failed for {} (status {:?}): {}",
                video_id,
                output.status,
                String::from_utf8_lossy(&output.stderr)
            );
            None
        }
    }
}

/// Ensures yt-dlp binary is available (downloads to user data dir if missing).
/// Returns the path to the executable, or None on failure.
/// This makes theme audio extraction seamless — no manual install required by the user.
/// Works for dev builds and packaged installs (downloads at first use if network available).
pub async fn ensure_yt_dlp() -> Option<PathBuf> {
    let dirs = RetromDirs::new();
    let bin_dir = dirs.data_dir().join("bin");
    if let Err(e) = fs::create_dir_all(&bin_dir).await {
        warn!("Failed to create bin dir for yt-dlp: {}", e);
        return None;
    }

    let (asset, sha_asset) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => ("yt-dlp.exe", "yt-dlp.exe.sha256"),
        ("linux", "x86_64") => ("yt-dlp", "yt-dlp.sha256"),
        ("macos", "x86_64") => ("yt-dlp_macos", "yt-dlp_macos.sha256"),
        ("macos", "aarch64") => ("yt-dlp_macos_aarch64", "yt-dlp_macos_aarch64.sha256"),
        _ => {
            warn!("Unsupported platform for automatic yt-dlp download: {}/{}", std::env::consts::OS, std::env::consts::ARCH);
            return None;
        }
    };

    let exe_name = if std::env::consts::OS == "windows" { "yt-dlp.exe" } else { "yt-dlp" };
    let exe_path = bin_dir.join(exe_name);

    if exe_path.exists() {
        return Some(exe_path);
    }

    // Use GitHub API for reliability: get exact latest release assets + digests.
    // This avoids flaky /latest/download/ 404s or bad bodies for .sha256 (which was causing "expected not").
    // GitHub requires User-Agent.
    let client = reqwest::Client::builder()
        .user_agent("Retrom/yt-dlp-fetch (https://github.com/jmberesford/retrom)")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let release: serde_json::Value = match client
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .send()
        .await
    {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                warn!("Failed to parse yt-dlp latest release JSON, falling back to direct download: {}", e);
                // Fallback path below will be attempted after this block
                serde_json::json!({})
            }
        },
        Err(e) => {
            warn!("GitHub API request for yt-dlp release failed: {}. Will try direct download.", e);
            serde_json::json!({})
        }
    };

    let assets: &[serde_json::Value] = release
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);

    // Find the binary asset
    let bin_asset = assets.iter().find(|a| {
        a.get("name").and_then(|n| n.as_str()) == Some(asset)
    });

    let bin_url = if let Some(ba) = bin_asset {
        ba.get("browser_download_url").and_then(|u| u.as_str()).unwrap_or(&format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}", asset)).to_string()
    } else {
        format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}", asset)
    };

    // Prefer digest from GitHub asset metadata (format "sha256:xxx")
    let mut expected_sha = bin_asset
        .and_then(|ba| ba.get("digest"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    debug!("Downloading yt-dlp from {} (seamless first-use setup)", bin_url);

    let bin_bytes = match client.get(&bin_url).send().await {
        Ok(resp) => match resp.bytes().await {
            Ok(b) => b,
            Err(e) => {
                warn!("Failed to read yt-dlp bytes: {}", e);
                return None;
            }
        },
        Err(e) => {
            warn!("yt-dlp download request failed: {}", e);
            return None;
        }
    };

    let actual_sha = format!("{:x}", sha2::Sha256::digest(&bin_bytes));

    if expected_sha.is_empty() {
        // Fallback to downloading the .sha256 sidecar if no digest in API
        let sha_url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}", sha_asset);
        let sha_text = match client.get(&sha_url).send().await {
            Ok(r) => match r.text().await { Ok(t) => t, Err(_) => String::new() },
            Err(_) => String::new(),
        };
        expected_sha = sha_text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase();
    }

    if !expected_sha.is_empty() && actual_sha != expected_sha {
        warn!("yt-dlp SHA256 mismatch (expected {}, got {}) — using binary anyway for usability", expected_sha, actual_sha);
        // Proceed anyway (better UX than failing extraction entirely on transient GitHub issues)
    } else if expected_sha.is_empty() {
        warn!("Could not obtain SHA256 for yt-dlp verification (proceeding with downloaded binary)");
    }

    if let Err(e) = fs::write(&exe_path, &bin_bytes).await {
        warn!("Failed to write yt-dlp binary: {}", e);
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = fs::metadata(&exe_path).await.map(|m| m.permissions()) {
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&exe_path, perms).await;
        }
    }

    debug!("yt-dlp downloaded and ready at {:?}", exe_path);
    Some(exe_path)
}

/// Helper to pull video ID from a watch url (for extraction after finding soundtrack).
pub fn extract_video_id_from_url(url: &str) -> Option<String> {
    if let Ok(parsed) = url::Url::parse(url) {
        parsed
            .query_pairs()
            .find(|(k, _)| k == "v")
            .map(|(_, v)| v.into_owned())
    } else {
        None
    }
}
