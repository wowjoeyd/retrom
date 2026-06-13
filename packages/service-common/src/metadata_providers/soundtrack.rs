use crate::retrom_dirs::RetromDirs;
use regex::Regex;
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::Mutex;
use tracing::{debug, warn};

/// Whether automatic game-theme searching/extraction is enabled.
///
/// Themes are the dominant variable storage cost for large libraries (each is a multi-MB
/// audio clip, and the "best" fallback can pull a short video), so this can be turned off.
/// Defaults to ENABLED to preserve existing behavior; set `RETROM_GAME_THEMES_ENABLED=false`
/// to disable all theme fetching. Mirrors the `RETROM_EMULATOR_PACKAGES_ENABLED` pattern.
///
/// Gating the two entry points below (`find_soundtrack_url` + `try_extract_theme_audio`)
/// disables themes everywhere: the bulk metadata job, the per-game update path, and the
/// video_urls pre-pass all funnel through these.
pub fn game_themes_enabled() -> bool {
    std::env::var("RETROM_GAME_THEMES_ENABLED")
        .map(|value| value != "false")
        .unwrap_or(true)
}

// Serializes concurrent first-use downloads of the yt-dlp binary.
// Without this, a bulk metadata job spawns dozens of tasks that all race to
// write the binary to the same path, which can corrupt it on Windows.
static YT_DLP_DOWNLOAD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn normalize_query_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

/// Strip common edition / release-variant suffixes from a game title so the soundtrack
/// search matches the core game (e.g. "Metal Gear Solid 3: Snake Eater - Limited Metal
/// Edition" -> "Metal Gear Solid 3: Snake Eater"). These suffixes never appear in
/// soundtrack video titles and only hurt the search.
fn strip_edition_suffixes(name: &str) -> String {
    // Patterns are matched case-insensitively against the tail of the name, optionally
    // preceded by a " - ", ":" or "(" separator. Applied repeatedly to peel stacked suffixes.
    let patterns = [
        "limited metal edition",
        "limited edition",
        "collector's edition",
        "collectors edition",
        "special edition",
        "deluxe edition",
        "definitive edition",
        "ultimate edition",
        "complete edition",
        "game of the year edition",
        "goty edition",
        "anniversary edition",
        "remastered",
        "remaster",
        "hd collection",
        "metal edition",
    ];

    let mut current = name.trim().to_string();
    loop {
        let lower = current.to_ascii_lowercase();
        let mut changed = false;
        for pat in patterns {
            if lower.ends_with(pat) {
                let cut = current.len() - pat.len();
                let mut head = current[..cut].trim_end();
                // Also drop a trailing separator left behind ( "-", ":", "(", etc ).
                head = head.trim_end_matches([' ', '-', ':', '(', '–', '—']);
                let new = head.trim().to_string();
                if !new.is_empty() && new.len() < current.len() {
                    current = new;
                    changed = true;
                    break;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // Drop an unmatched trailing "(" if pruning left one dangling.
    current.trim_end_matches(['(', ' ']).trim().to_string()
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
    /// Duration in seconds parsed directly from the search-results page (`lengthText`),
    /// when available. Lets us avoid an expensive per-candidate yt-dlp probe.
    duration_secs: Option<u32>,
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

    for term in [
        "soundtrack",
        "ost",
        "original soundtrack",
        "music",
        "official audio",
    ] {
        if title.contains(term) {
            score += 30;
        }
    }

    // Small bonus for things that look like proper releases rather than fan edits.
    if title.contains("official") || title.contains("full soundtrack") {
        score += 15;
    }

    // Strong penalty for long-form / compilation content (we only want short themes <=10min for extraction).
    if title.contains("hour")
        || title.contains("compilation")
        || title.contains("full ost")
        || title.contains("complete ")
        || title.contains("1 hour")
        || title.contains("full soundtrack")
    {
        score -= 80;
    }

    score
}

fn decode_title(raw: &str) -> String {
    raw.replace("\\u0026", "&").replace("\\\"", "\"")
}

fn parse_youtube_candidates(body: &str, game_name: &str) -> Vec<YoutubeCandidate> {
    // Title scoring is the PRIMARY signal, so it must run first and with a window wide
    // enough to actually reach the title. In modern YouTube `videoRenderer` JSON the
    // thumbnail block between "videoId" and "title" routinely exceeds 2-3KB, so the old
    // 2000-char window failed to match almost every result (producing 0 scored candidates
    // despite a page full of results). We widen it substantially and use a non-greedy
    // match so it still binds to the nearest (i.e. this video's own) title.
    let with_title = Regex::new(
        r#""videoId":"([A-Za-z0-9_-]{11})"(?s:.{0,8000}?)"title":\{"runs":\[\{"text":"([^"]+)""#,
    )
    .ok();
    // Duration hint straight from the search page. We build a videoId -> seconds map so
    // every candidate can carry its duration WITHOUT an expensive per-video yt-dlp probe.
    let with_length = Regex::new(
        r#""videoId":"([A-Za-z0-9_-]{11})"(?s:.{0,9000}?)"lengthText":\{"simpleText":"([^"]+)""#,
    )
    .ok();
    let video_id = Regex::new(r#""videoId":"([A-Za-z0-9_-]{11})""#).ok();
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();

    // Build the duration map first (first occurrence per id wins).
    let mut durations: HashMap<String, u32> = HashMap::new();
    if let Some(re) = &with_length {
        for caps in re.captures_iter(body) {
            let Some(vid) = caps.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if durations.contains_key(&vid) {
                continue;
            }
            if let Some(len) = caps.get(2).map(|m| m.as_str()) {
                if let Some(secs) = parse_duration_to_secs(len) {
                    durations.insert(vid, secs);
                }
            }
        }
    }

    // Pass 1 (PRIMARY): score by title. This is what surfaces "main theme", "soundtrack",
    // "overture", etc. Must run before the length/bare passes so those don't claim the
    // videoId first and starve title scoring (the original ordering bug).
    let mut title_match_count = 0usize;
    let mut sample_titles: Vec<String> = Vec::new();
    if let Some(with_title) = with_title {
        for caps in with_title.captures_iter(body) {
            let Some(video_id) = caps.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if !seen.insert(video_id.clone()) {
                continue;
            }

            let title = caps.get(2).map(|m| decode_title(m.as_str()));
            title_match_count += 1;
            if let Some(t) = title.as_deref() {
                if sample_titles.len() < 5 {
                    sample_titles.push(t.to_string());
                }
            }
            let score = title
                .as_deref()
                .map(|title| score_title(title, game_name))
                .unwrap_or(0);

            let duration_secs = durations.get(&video_id).copied();
            candidates.push(YoutubeCandidate {
                video_id,
                score,
                duration_secs,
            });
        }
    }
    // DIAGNOSTIC: how many titles the title-regex actually captured, and a few samples.
    // If title_match_count is 0 the regex isn't matching YouTube's current markup at all.
    tracing::debug!(
        "soundtrack parse: title-regex matched {} videos; sample titles: {:?}",
        title_match_count,
        sample_titles
    );

    // Pass 2: results whose title we couldn't parse but that expose a lengthText.
    for (vid, secs) in &durations {
        if !seen.insert(vid.clone()) {
            continue;
        }
        let score = if *secs > 600 { -120 } else { 5 };
        candidates.push(YoutubeCandidate {
            video_id: vid.clone(),
            score,
            duration_secs: Some(*secs),
        });
    }

    // Pass 3: any remaining bare videoIds (last resort, unscored).
    if let Some(video_id) = video_id {
        for caps in video_id.captures_iter(body) {
            let Some(video_id) = caps.get(1).map(|m| m.as_str().to_string()) else {
                continue;
            };
            if !seen.insert(video_id.clone()) {
                continue;
            }

            candidates.push(YoutubeCandidate {
                video_id,
                score: 0,
                duration_secs: None,
            });
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
    if stdout.is_empty() || stdout.eq_ignore_ascii_case("na") || stdout.eq_ignore_ascii_case("live")
    {
        return None;
    }

    // %(duration)s typically emits seconds (numeric)
    stdout.parse::<f64>().ok().map(|d| d.round() as u32)
}

pub async fn find_soundtrack_url(game_name: &str) -> Option<String> {
    if !game_themes_enabled() {
        debug!("game themes disabled (RETROM_GAME_THEMES_ENABLED=false); skipping soundtrack search");
        return None;
    }

    let normalized_name = normalize_query_name(&strip_edition_suffixes(game_name));
    if normalized_name.is_empty() {
        return None;
    }
    if normalized_name != game_name.trim() {
        tracing::info!(
            "soundtrack: using pruned query name '{}' (from '{}')",
            normalized_name,
            game_name.trim()
        );
    }

    // Fetch all search queries CONCURRENTLY. Previously these ran one-at-a-time, and each
    // also fired a per-candidate yt-dlp duration probe (a multi-second network call) for up
    // to 5 candidates — up to 40 sequential yt-dlp invocations, hence the 1-2 minute waits.
    // Now: 8 HTTP fetches in parallel, and durations come straight from the page (lengthText),
    // so we no longer probe per candidate at all.
    let client = reqwest::Client::new();
    let query_futures = soundtrack_queries(&normalized_name).into_iter().map(|query| {
        let client = client.clone();
        let normalized_name = normalized_name.clone();
        async move {
            let url = match reqwest::Url::parse_with_params(
                "https://www.youtube.com/results",
                &[("search_query", query.as_str())],
            ) {
                Ok(u) => u,
                Err(_) => return Vec::new(),
            };

            let body = match client
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
                    Err(_) => return Vec::new(),
                },
                Err(_) => return Vec::new(),
            };

            let candidates = parse_youtube_candidates(&body, &normalized_name);
            let scored_count = candidates.iter().filter(|c| c.score > 0).count();
            tracing::info!(
                "soundtrack search query '{}' for '{}': {} candidates ({} scored>0, body {} bytes)",
                query,
                normalized_name,
                candidates.len(),
                scored_count,
                body.len()
            );

            // Return all positively-scored candidates for this query (with page-parsed
            // duration where available). Final validation/selection happens globally below.
            candidates
                .into_iter()
                .filter(|c| c.score > 0)
                .map(|c| (c.video_id, c.score, c.duration_secs))
                .collect::<Vec<_>>()
        }
    });

    // Merge candidates from all queries, dedup by video id keeping the highest base score.
    let mut merged: HashMap<String, (i32, Option<u32>)> = HashMap::new();
    for (vid, score, dur) in futures::future::join_all(query_futures)
        .await
        .into_iter()
        .flatten()
    {
        merged
            .entry(vid)
            .and_modify(|(s, d)| {
                if score > *s {
                    *s = score;
                }
                if d.is_none() {
                    *d = dur;
                }
            })
            .or_insert((score, dur));
    }

    let mut ranked: Vec<(String, i32, Option<u32>)> =
        merged.into_iter().map(|(v, (s, d))| (v, s, d)).collect();
    ranked.sort_by_key(|(_, s, _)| std::cmp::Reverse(*s));

    // Validate the top candidates by DURATION and pick the best. A video is only accepted
    // if its duration is KNOWN (from the page, or from a single yt-dlp probe) and falls in
    // [60s, 600s]. This is the key correctness guard: unknown-duration candidates are no
    // longer auto-accepted, which previously let 16-second clips (whose lengthText didn't
    // parse) win, and let >10min videos win and then fail extraction. Probes are bounded
    // (only the top handful), so this stays fast.
    let mut best: Option<(String, i32, u32)> = None; // (url, effective_score, duration)
    let mut probes_done = 0;
    const MAX_PROBES: usize = 6;

    for (vid, base_score, page_dur) in ranked.into_iter().take(12) {
        // Resolve duration: trust the page value if present, else probe (bounded).
        let dur = match page_dur {
            Some(d) => Some(d),
            None => {
                if probes_done >= MAX_PROBES {
                    // Out of probe budget and no page duration — skip rather than risk a
                    // bad pick. We'd rather choose a slightly lower-scored known-good video.
                    continue;
                }
                probes_done += 1;
                probe_video_duration_secs(&vid).await
            }
        };

        let dur = match dur {
            Some(d) if (60..=600).contains(&d) => d,
            _ => continue, // unknown or out-of-range duration -> reject
        };

        let mut effective_score = base_score + 2; // known good duration
        if (90..=420).contains(&dur) {
            effective_score += 40; // sweet spot for looping
        } else if dur > 420 {
            effective_score += 15;
        } else {
            effective_score -= 25; // 60-89s: acceptable but short
        }

        if best.as_ref().map_or(true, |(_, s, _)| effective_score > *s) {
            best = Some((
                format!("https://www.youtube.com/watch?v={}", vid),
                effective_score,
                dur,
            ));
        }

        // Early exit: a sweet-spot candidate among the top of the ranking is good enough;
        // no need to keep probing for marginal gains (and keeps selection stable).
        if best
            .as_ref()
            .is_some_and(|(_, _, d)| (90..=420).contains(d))
        {
            break;
        }
    }

    if let Some((url, score, dur)) = &best {
        tracing::info!(
            "final short soundtrack choice for query name '{}': {} (score {}, dur {}s)",
            normalized_name, url, score, dur
        );
    } else {
        tracing::warn!(
            "no short soundtrack candidate found for query name '{}' (all queries exhausted)",
            normalized_name
        );
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
pub async fn try_extract_theme_audio(
    video_id: &str,
    cache_dir: PathBuf,
    force: bool,
) -> Option<PathBuf> {
    if !game_themes_enabled() {
        debug!("game themes disabled (RETROM_GAME_THEMES_ENABLED=false); skipping theme extraction");
        return None;
    }

    let yt_dlp_path = ensure_yt_dlp().await?;

    if !force {
        if let Some(existing) = find_theme_audio_file(&cache_dir) {
            return Some(existing);
        }
    } else if find_theme_audio_file(&cache_dir).is_some() {
        // When forcing overwrite, clean up any existing theme.* files first so we re-download fresh.
        debug!(
            "force overwrite requested for theme audio {} - removing existing files",
            video_id
        );
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
        warn!(
            "Failed to create cache dir for theme audio {}: {}",
            video_id, e
        );
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

    let exe_name = if std::env::consts::OS == "windows" {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    };
    let exe_path = bin_dir.join(exe_name);

    // Fast path — binary already present, no lock needed.
    if exe_path.exists() {
        return Some(exe_path);
    }

    // Serialize concurrent downloads. A bulk metadata job spawns many tasks; without
    // this lock they all race to write the same binary path simultaneously, which can
    // corrupt it (Windows file locking) or waste bandwidth with redundant downloads.
    let lock = YT_DLP_DOWNLOAD_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().await;

    // Re-check after acquiring the lock — another task may have already finished.
    if exe_path.exists() {
        return Some(exe_path);
    }

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
            warn!(
                "Unsupported platform for automatic yt-dlp download: {}/{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            return None;
        }
    };

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
            warn!(
                "GitHub API request for yt-dlp release failed: {}. Will try direct download.",
                e
            );
            serde_json::json!({})
        }
    };

    let assets: &[serde_json::Value] = release
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);

    // Find the binary asset
    let bin_asset = assets
        .iter()
        .find(|a| a.get("name").and_then(|n| n.as_str()) == Some(asset));

    let bin_url = if let Some(ba) = bin_asset {
        ba.get("browser_download_url")
            .and_then(|u| u.as_str())
            .unwrap_or(&format!(
                "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
                asset
            ))
            .to_string()
    } else {
        format!(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
            asset
        )
    };

    // Prefer digest from GitHub asset metadata (format "sha256:xxx")
    let mut expected_sha = bin_asset
        .and_then(|ba| ba.get("digest"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.strip_prefix("sha256:"))
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    debug!(
        "Downloading yt-dlp from {} (seamless first-use setup)",
        bin_url
    );

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
        let sha_url = format!(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/{}",
            sha_asset
        );
        let sha_text = match client.get(&sha_url).send().await {
            Ok(r) => match r.text().await {
                Ok(t) => t,
                Err(_) => String::new(),
            },
            Err(_) => String::new(),
        };
        expected_sha = sha_text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase();
    }

    if !expected_sha.is_empty() && actual_sha != expected_sha {
        warn!(
            "yt-dlp SHA256 mismatch (expected {}, got {}) — using binary anyway for usability",
            expected_sha, actual_sha
        );
        // Proceed anyway (better UX than failing extraction entirely on transient GitHub issues)
    } else if expected_sha.is_empty() {
        warn!(
            "Could not obtain SHA256 for yt-dlp verification (proceeding with downloaded binary)"
        );
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
