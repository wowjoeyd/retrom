use crate::retrom_dirs::RetromDirs;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::OnceLock;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::{Mutex, RwLock, Semaphore};
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

// Same guard for ffmpeg binary downloads.
static FFMPEG_DOWNLOAD_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

// Global cap on concurrent YouTube search requests. Without this, a 350-game
// library triggers 350 simultaneous HTTP fetches and YouTube rate-limits the lot.
static YOUTUBE_SEARCH_SEMAPHORE: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn youtube_search_semaphore() -> Arc<Semaphore> {
    YOUTUBE_SEARCH_SEMAPHORE
        .get_or_init(|| Arc::new(Semaphore::new(4)))
        .clone()
}

// ── YouTube cookies path ──────────────────────────────────────────────────────
// Set once at service startup (or on config update) by the gRPC service via
// `set_youtube_cookies_path`. Falls back to env var RETROM_YOUTUBE_COOKIES.
static YOUTUBE_COOKIES_PATH: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

fn cookies_lock() -> &'static RwLock<Option<PathBuf>> {
    YOUTUBE_COOKIES_PATH.get_or_init(|| RwLock::new(None))
}

/// Called at service startup (and on config update) to configure the cookies
/// path used by all YouTube searches and yt-dlp invocations.
pub async fn set_youtube_cookies_path(path: Option<PathBuf>) {
    *cookies_lock().write().await = path;
}

async fn get_youtube_cookies_path() -> Option<PathBuf> {
    // Runtime config takes priority.
    if let Some(p) = cookies_lock().read().await.clone() {
        return Some(p);
    }
    // Fallback to environment variable.
    std::env::var("RETROM_YOUTUBE_COOKIES")
        .ok()
        .map(PathBuf::from)
}

// ── Persistent soundtrack URL cache ──────────────────────────────────────────
// Caches game_name → YouTube URL (or None = confirmed no result) across runs.
// Uses a lazy-loaded in-process HashMap backed by a JSON file on disk.

#[derive(Serialize, Deserialize, Clone)]
struct CachedSoundtrackEntry {
    /// None means we searched and found nothing (negative cache).
    url: Option<String>,
    cached_at_secs: u64,
}

type SoundtrackUrlCache = HashMap<String, CachedSoundtrackEntry>;

/// 30-day TTL for cached entries.
const CACHE_TTL_SECS: u64 = 30 * 24 * 3600;

static SOUNDTRACK_CACHE: OnceLock<Mutex<Option<SoundtrackUrlCache>>> = OnceLock::new();

fn soundtrack_cache_lock() -> &'static Mutex<Option<SoundtrackUrlCache>> {
    SOUNDTRACK_CACHE.get_or_init(|| Mutex::new(None))
}

fn soundtrack_cache_path() -> PathBuf {
    RetromDirs::new()
        .data_dir()
        .join("soundtrack_url_cache.json")
}

async fn load_soundtrack_cache_from_disk() -> SoundtrackUrlCache {
    let path = soundtrack_cache_path();
    match fs::read_to_string(&path).await {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Look up a cached result. Returns `Some(Some(url))` for a hit, `Some(None)`
/// for a confirmed negative, and `None` when there is no (valid) cache entry.
async fn cache_lookup(key: &str) -> Option<Option<String>> {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let mut guard = soundtrack_cache_lock().lock().await;
    if guard.is_none() {
        *guard = Some(load_soundtrack_cache_from_disk().await);
    }
    guard.as_ref()?.get(key).and_then(|e| {
        if now_secs.saturating_sub(e.cached_at_secs) < CACHE_TTL_SECS {
            Some(e.url.clone())
        } else {
            None // expired
        }
    })
}

/// Store a result (positive or negative) in the cache and persist to disk.
/// The disk write happens outside the Mutex to avoid holding it across async IO.
async fn cache_store(key: &str, url: Option<String>) {
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let snapshot = {
        let mut guard = soundtrack_cache_lock().lock().await;
        if guard.is_none() {
            *guard = Some(load_soundtrack_cache_from_disk().await);
        }
        if let Some(cache) = guard.as_mut() {
            cache.insert(
                key.to_string(),
                CachedSoundtrackEntry {
                    url: url.clone(),
                    cached_at_secs: now_secs,
                },
            );
        }
        // Only snapshot for disk write when we have a positive result.
        // Negative results (None) are kept in-memory for within-session deduplication
        // but must not be persisted — a future run (with cookies, better regex, etc.)
        // should always retry games that previously had no match.
        if url.is_some() {
            guard.clone()
        } else {
            None
        }
    };

    if let Some(cache) = snapshot {
        let path = soundtrack_cache_path();
        // Only write positive entries to the on-disk cache.
        let positive_only: SoundtrackUrlCache =
            cache.into_iter().filter(|(_, e)| e.url.is_some()).collect();
        if let Ok(json) = serde_json::to_string(&positive_only) {
            let _ = fs::write(&path, json).await;
        }
    }
}

// ── Netscape cookie file parsing ──────────────────────────────────────────────
// Builds a `Cookie:` header value from a Netscape cookies.txt file.
// Only cookies for *.youtube.com are included.

fn parse_netscape_cookies(text: &str) -> String {
    text.lines()
        .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
        .filter_map(|line| {
            let fields: Vec<&str> = line.splitn(7, '\t').collect();
            if fields.len() < 7 {
                return None;
            }
            let domain = fields[0];
            let name = fields[5];
            let value = fields[6];
            // Include .youtube.com and youtube.com cookies.
            if domain.contains("youtube.com") && !name.is_empty() {
                Some(format!("{}={}", name, value))
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Reads the configured cookies file and returns the `Cookie:` header value,
/// or `None` if no cookies file is configured or the file can't be read.
async fn build_cookie_header() -> Option<String> {
    let path = get_youtube_cookies_path().await?;
    let text = fs::read_to_string(&path).await.ok()?;
    let header = parse_netscape_cookies(&text);
    if header.is_empty() {
        None
    } else {
        Some(header)
    }
}

/// Check whether ffmpeg is already available (PATH or our bin dir) WITHOUT downloading.
/// Used to optionally pass `--ffmpeg-location` to yt-dlp during extraction.
async fn find_ffmpeg_if_present() -> Option<PathBuf> {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = Command::new(which_cmd).arg("ffmpeg").output().await {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let line = s.lines().next().unwrap_or("").trim().to_string();
            if !line.is_empty() {
                return Some(PathBuf::from(line));
            }
        }
    }
    let dirs = RetromDirs::new();
    let exe = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let p = dirs.data_dir().join("bin").join(exe);
    if p.exists() {
        Some(p)
    } else {
        None
    }
}

// Minimum effective score a candidate must reach to be returned from
// find_soundtrack_url. Prevents gameplay clips and untitled videos from winning
// when title parsing succeeds but every result scores poorly.
const MIN_ACCEPT_SCORE: i32 = 30;

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
        "enhanced edition",
        "game of the year edition",
        "game of the year",
        "goty edition",
        "goty",
        "director's cut",
        "directors cut",
        "anniversary edition",
        "remastered",
        "remaster",
        "hd collection",
        "metal edition",
        "reloaded",
        "complete pack",
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

/// Full normalization pipeline for YouTube search: remove bracket/paren segments,
/// replace colons with spaces, strip edition suffixes, collapse whitespace.
fn normalize_game_name_for_search(name: &str) -> String {
    // Remove bracketed/parenthetical segments (ROM tags, disc labels, version numbers).
    let mut result = String::with_capacity(name.len());
    let mut bracket_depth = 0u32;
    let mut paren_depth = 0u32;
    for ch in name.chars() {
        match ch {
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.saturating_sub(1),
            // YouTube treats ':' as a search operator; replace with space to keep the subtitle.
            ':' if bracket_depth == 0 && paren_depth == 0 => result.push(' '),
            _ if bracket_depth == 0 && paren_depth == 0 => result.push(ch),
            _ => {}
        }
    }
    normalize_query_name(&strip_edition_suffixes(result.trim()))
}

#[derive(Debug)]
struct YoutubeCandidate {
    video_id: String,
    title: String,
    score: i32,
    /// Duration in seconds parsed directly from the search-results page (`lengthText`),
    /// when available. Lets us avoid an expensive per-candidate yt-dlp probe.
    duration_secs: Option<u32>,
}

/// A ranked YouTube soundtrack match returned by the public search API.
#[derive(Debug, Clone)]
pub struct SoundtrackCandidate {
    pub video_id: String,
    pub title: String,
    pub duration_secs: Option<u32>,
    pub thumbnail_url: String,
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
        "let's play",
        "lets play",
        "playthrough",
        "no commentary",
        "part 1",
        "episode",
        "fan made",
        "fan-made",
        "animated",
        "animation",
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

/// Extract the `ytInitialData` JSON blob embedded in a YouTube search-results page.
/// YouTube writes the full structured search response as an assignment
/// `var ytInitialData = {...};` (or just `ytInitialData = {...}`) in a `<script>` tag.
/// Parsing this gives us accurate videoId↔title pairings because both fields live in
/// the same `videoRenderer` JSON object — unlike the position-based regex approach, which
/// can proximity-match a title from an adjacent video block to the wrong videoId.
///
/// Uses `serde_json::Deserializer` in streaming mode so it reads exactly one JSON value
/// starting from the `{` and ignores the trailing `;</script>` text without errors.
fn extract_yt_initial_data_json(body: &str) -> Option<serde_json::Value> {
    let key_pos = body.find("ytInitialData")?;
    let after_key = &body[key_pos + "ytInitialData".len()..];
    let eq_pos = after_key.find('=')?;
    let from_val = after_key[eq_pos + 1..].trim_start();
    if !from_val.starts_with('{') {
        return None;
    }
    let mut de = serde_json::Deserializer::from_str(from_val);
    serde_json::Value::deserialize(&mut de).ok()
}

/// Walk the parsed `ytInitialData` object and extract video candidates.
/// Each `videoRenderer` contains both `videoId` and `title.runs[0].text` in the same
/// object, guaranteeing correct pairings regardless of surrounding HTML layout.
fn candidates_from_yt_initial_data(
    data: &serde_json::Value,
    game_name: &str,
) -> Vec<YoutubeCandidate> {
    let mut candidates = Vec::new();

    let sections = match data
        .pointer(
            "/contents/twoColumnSearchResultsRenderer/primaryContents/sectionListRenderer/contents",
        )
        .and_then(|v| v.as_array())
    {
        Some(s) => s,
        None => return candidates,
    };

    for section in sections {
        let items = match section
            .pointer("/itemSectionRenderer/contents")
            .and_then(|v| v.as_array())
        {
            Some(i) => i,
            None => continue,
        };

        for item in items {
            let renderer = match item.get("videoRenderer") {
                Some(r) => r,
                None => continue,
            };

            let video_id = match renderer.get("videoId").and_then(|v| v.as_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };

            let raw_title = renderer
                .pointer("/title/runs/0/text")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let title = decode_title(raw_title);

            let duration_secs = renderer
                .pointer("/lengthText/simpleText")
                .and_then(|v| v.as_str())
                .and_then(parse_duration_to_secs);

            let score = score_title(&title, game_name);
            candidates.push(YoutubeCandidate {
                video_id,
                title,
                score,
                duration_secs,
            });
        }
    }

    candidates
}

fn parse_youtube_candidates(body: &str, game_name: &str) -> (Vec<YoutubeCandidate>, usize) {
    // Preferred path: parse the structured ytInitialData JSON blob.
    // This gives guaranteed title↔videoId pairings because they come from the same
    // videoRenderer object. Falls through when ytInitialData is absent (bot-detection
    // page, network error, or YouTube structure change).
    if let Some(data) = extract_yt_initial_data_json(body) {
        let candidates = candidates_from_yt_initial_data(&data, game_name);
        if !candidates.is_empty() {
            let title_count = candidates.iter().filter(|c| !c.title.is_empty()).count();
            tracing::debug!(
                "soundtrack parse (ytInitialData): {} candidates, {} with titles",
                candidates.len(),
                title_count
            );
            return (candidates, title_count);
        }
    }

    // Fallback: position-based approach. Used when ytInitialData is absent or empty,
    // e.g. YouTube served a bot-detection interstitial instead of real results.
    //
    // Position-based approach: extract all videoId, title, and duration positions
    // separately then pair by byte-position proximity.  This is robust to YouTube's
    // changing JSON field order (title before/after videoId) and the 2024+ layout where
    // an `"accessibility"` block precedes `"runs"` inside both "title" and "lengthText".
    //
    // The old single-pass combined regexes (videoId → 32 KB → exact JSON key sequence)
    // broke when YouTube inserted the accessibility wrapper, yielding 0 title matches for
    // every game.  The position-based approach is immune to key-ordering changes.

    let vid_re = Regex::new(r#""videoId":"([A-Za-z0-9_-]{11})""#).ok();

    // Title: allow up to 900 lazy chars between "title":{ and "runs":[{"text":" so that
    // the accessibility block (typically ~150-250 chars) is bridged transparently.
    let title_re = Regex::new(r#""title":\{(?s:.{0,900}?)"runs":\[\{"text":"([^"]{1,300})""#).ok();

    // Duration: allow up to 600 lazy chars between "lengthText":{ and "simpleText":" for
    // the same reason (accessibility wrapper added by YouTube in 2024).
    let dur_re = Regex::new(r#""lengthText":\{(?s:.{0,600}?)"simpleText":"([0-9][0-9:]+)""#).ok();

    let body_len = body.len();

    // Build sorted position maps.
    let mut title_pos: Vec<(usize, String)> = Vec::new();
    if let Some(re) = &title_re {
        for caps in re.captures_iter(body) {
            if let (Some(m), Some(t)) = (caps.get(0), caps.get(1)) {
                title_pos.push((m.start(), decode_title(t.as_str())));
            }
        }
    }
    title_pos.sort_unstable_by_key(|(p, _)| *p);

    let mut dur_pos: Vec<(usize, u32)> = Vec::new();
    if let Some(re) = &dur_re {
        for caps in re.captures_iter(body) {
            if let (Some(m), Some(t)) = (caps.get(0), caps.get(1)) {
                if let Some(secs) = parse_duration_to_secs(t.as_str()) {
                    dur_pos.push((m.start(), secs));
                }
            }
        }
    }
    dur_pos.sort_unstable_by_key(|(p, _)| *p);

    // For each unique videoId, find the nearest title and duration within a byte window.
    // A videoRenderer object is typically 3–10 KB; using 16 KB forward + 4 KB backward
    // gives enough slack while staying within the same renderer in practice.
    // Backward matches are penalised 3× to prefer the title that follows the videoId
    // (the normal JSON ordering).
    const FORWARD_WINDOW: usize = 16_000;
    const BACKWARD_WINDOW: usize = 4_000;

    let mut seen: HashSet<String> = HashSet::new();
    let mut candidates: Vec<YoutubeCandidate> = Vec::new();
    let mut title_match_count = 0usize;
    let mut sample_titles: Vec<String> = Vec::new();

    if let Some(re) = &vid_re {
        for caps in re.captures_iter(body) {
            let Some(vm) = caps.get(0) else { continue };
            let Some(v) = caps.get(1) else { continue };
            let vid = v.as_str().to_string();
            let vid_pos = vm.start();

            if !seen.insert(vid.clone()) {
                continue;
            }

            let lo = vid_pos.saturating_sub(BACKWARD_WINDOW);
            let hi = (vid_pos + FORWARD_WINDOW).min(body_len);

            // Nearest title: forward distance preferred 3× over backward distance.
            let nearest_title = title_pos
                .iter()
                .filter(|(tp, _)| *tp >= lo && *tp <= hi)
                .min_by_key(|(tp, _)| {
                    if *tp >= vid_pos {
                        tp - vid_pos
                    } else {
                        (vid_pos - tp).saturating_mul(3)
                    }
                });

            let title_str = nearest_title.map(|(_, t)| t.as_str());
            if let Some(t) = title_str {
                title_match_count += 1;
                if sample_titles.len() < 5 {
                    sample_titles.push(t.to_string());
                }
            }

            let score = title_str.map(|t| score_title(t, game_name)).unwrap_or(0);

            // Nearest duration — no directional preference.
            let dur = dur_pos
                .iter()
                .filter(|(dp, _)| *dp >= lo && *dp <= hi)
                .min_by_key(|(dp, _)| dp.abs_diff(vid_pos))
                .map(|(_, d)| *d);

            candidates.push(YoutubeCandidate {
                video_id: vid,
                title: title_str.unwrap_or("").to_string(),
                score,
                duration_secs: dur,
            });
        }
    }

    tracing::debug!(
        "soundtrack parse: title-regex matched {} videos (position-based); sample titles: {:?}",
        title_match_count,
        sample_titles
    );

    (candidates, title_match_count)
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

/// Fetch YouTube search results for a single query and return positively-scored
/// candidates plus the raw title-match count (for the title-guard check).
async fn fetch_youtube_candidates(
    client: &reqwest::Client,
    query: &str,
    game_name: &str,
    cookie_header: Option<&str>,
) -> (Vec<(String, String, i32, Option<u32>)>, usize) {
    let url = match reqwest::Url::parse_with_params(
        "https://www.youtube.com/results",
        &[("search_query", query)],
    ) {
        Ok(u) => u,
        Err(_) => return (Vec::new(), 0),
    };

    let mut req = client
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        )
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

    if let Some(cookies) = cookie_header {
        req = req.header(reqwest::header::COOKIE, cookies);
    }

    let body = match req.send().await {
        Ok(resp) => match resp.text().await {
            Ok(t) => t,
            Err(_) => return (Vec::new(), 0),
        },
        Err(_) => return (Vec::new(), 0),
    };

    let (candidates, title_count) = parse_youtube_candidates(&body, game_name);
    let scored_count = candidates.iter().filter(|c| c.score > 0).count();
    tracing::info!(
        "soundtrack search query '{}' for '{}': {} candidates ({} scored>0, body {} bytes)",
        query,
        game_name,
        candidates.len(),
        scored_count,
        body.len()
    );

    let positive = candidates
        .into_iter()
        .filter(|c| c.score > 0)
        .map(|c| (c.video_id, c.title, c.score, c.duration_secs))
        .collect();

    (positive, title_count)
}

/// Search YouTube for soundtrack candidates for a game and return ranked results.
/// This is the public entry-point for the per-game Music tab — it runs the same
/// two-pass YouTube search used by `find_soundtrack_url` but returns all candidates
/// instead of picking a single winner.
pub async fn search_soundtrack_candidates(game_name: &str) -> Vec<SoundtrackCandidate> {
    if !game_themes_enabled() {
        return Vec::new();
    }

    let normalized_name = normalize_game_name_for_search(game_name);
    if normalized_name.is_empty() {
        return Vec::new();
    }

    let _permit = match youtube_search_semaphore().acquire_owned().await {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    let cookie_header = build_cookie_header().await;
    let cookie_ref = cookie_header.as_deref();
    let client = reqwest::Client::new();

    let primary_query = format!("{} main theme official soundtrack", normalized_name);
    let (primary, _) =
        fetch_youtube_candidates(&client, &primary_query, &normalized_name, cookie_ref).await;

    let all = if primary.is_empty() {
        let fallback_query = format!("{} OST", normalized_name);
        let (fallback, _) =
            fetch_youtube_candidates(&client, &fallback_query, &normalized_name, cookie_ref).await;
        fallback
    } else {
        primary
    };

    // Deduplicate, keeping highest score per video_id, preserving the title.
    let mut seen: HashMap<String, (String, i32, Option<u32>)> = HashMap::new();
    for (vid, title, score, dur) in all {
        seen.entry(vid)
            .and_modify(|(t, s, d)| {
                if score > *s {
                    *s = score;
                    if !title.is_empty() {
                        *t = title.clone();
                    }
                }
                if d.is_none() {
                    *d = dur;
                }
            })
            .or_insert((title, score, dur));
    }

    let mut ranked: Vec<(String, String, i32, Option<u32>)> = seen
        .into_iter()
        .map(|(v, (t, s, d))| (v, t, s, d))
        .collect();
    ranked.sort_by_key(|(_, _, s, _)| std::cmp::Reverse(*s));

    ranked
        .into_iter()
        .take(10)
        .map(|(video_id, title, _, duration_secs)| SoundtrackCandidate {
            thumbnail_url: format!("https://i.ytimg.com/vi/{}/mqdefault.jpg", video_id),
            video_id,
            title,
            duration_secs,
        })
        .collect()
}

pub async fn find_soundtrack_url(game_name: &str) -> Option<String> {
    if !game_themes_enabled() {
        debug!(
            "game themes disabled (RETROM_GAME_THEMES_ENABLED=false); skipping soundtrack search"
        );
        return None;
    }

    let normalized_name = normalize_game_name_for_search(game_name);
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

    // Cache check — avoids re-querying YouTube for the same game.
    if let Some(cached) = cache_lookup(&normalized_name).await {
        match &cached {
            Some(url) => {
                tracing::info!("soundtrack cache hit for '{}': {}", normalized_name, url);
                return cached;
            }
            None => {
                tracing::debug!(
                    "soundtrack negative cache hit for '{}' — skipping search",
                    normalized_name
                );
                return None;
            }
        }
    }

    // Global cap: at most 4 concurrent YouTube searches across all tasks.
    // Prevents the bulk job from flooding YouTube with 350+ simultaneous requests.
    let _permit = youtube_search_semaphore().acquire_owned().await.ok()?;

    let cookie_header = build_cookie_header().await;
    let cookie_ref = cookie_header.as_deref();

    let client = reqwest::Client::new();

    // Primary query — always run.
    let primary_query = format!("{} main theme official soundtrack", normalized_name);
    let (primary_candidates, primary_title_count) =
        fetch_youtube_candidates(&client, &primary_query, &normalized_name, cookie_ref).await;

    // Fallback query — only when primary produced no positively-scored candidates.
    let (all_candidates, total_title_count) = if primary_candidates.is_empty() {
        let fallback_query = format!("{} OST", normalized_name);
        let (fallback_candidates, fallback_title_count) =
            fetch_youtube_candidates(&client, &fallback_query, &normalized_name, cookie_ref).await;
        let mut merged = primary_candidates;
        merged.extend(fallback_candidates);
        (merged, primary_title_count + fallback_title_count)
    } else {
        (primary_candidates, primary_title_count)
    };

    // Title guard: if the regex matched zero titles across all queries, YouTube's
    // JSON structure may have changed. Refuse to pick an untitled candidate.
    if total_title_count == 0 {
        tracing::warn!(
            "soundtrack: title regex matched 0 videos for '{}' — YouTube markup may have changed; refusing untitled picks",
            normalized_name
        );
        return None;
    }

    // Merge by video_id, keeping highest base score.
    let mut merged: HashMap<String, (i32, Option<u32>)> = HashMap::new();
    for (vid, _title, score, dur) in all_candidates {
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

    // Validate by duration and apply sweet-spot bonuses.
    let mut best: Option<(String, i32, u32)> = None; // (url, effective_score, duration)
    let mut probes_done = 0;
    const MAX_PROBES: usize = 6;

    for (vid, base_score, page_dur) in ranked.into_iter().take(12) {
        let dur = match page_dur {
            Some(d) => Some(d),
            None => {
                if probes_done >= MAX_PROBES {
                    continue;
                }
                probes_done += 1;
                probe_video_duration_secs(&vid).await
            }
        };

        let dur = match dur {
            Some(d) if (60..=600).contains(&d) => d,
            _ => continue,
        };

        let mut effective_score = base_score + 2;
        if (90..=420).contains(&dur) {
            effective_score += 40;
        } else if dur > 420 {
            effective_score += 15;
        } else {
            effective_score -= 25;
        }

        if best.as_ref().map_or(true, |(_, s, _)| effective_score > *s) {
            best = Some((
                format!("https://www.youtube.com/watch?v={}", vid),
                effective_score,
                dur,
            ));
        }

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
            normalized_name,
            url,
            score,
            dur
        );
    } else {
        tracing::warn!(
            "no short soundtrack candidate found for query name '{}' (all queries exhausted)",
            normalized_name
        );
    }

    // Quality floor: reject if best effective score is below threshold.
    let result = best.and_then(|(url, score, _dur)| {
        if score >= MIN_ACCEPT_SCORE {
            Some(url)
        } else {
            tracing::warn!(
                "soundtrack: best score {} < MIN_ACCEPT_SCORE {} for '{}' — returning None",
                score,
                MIN_ACCEPT_SCORE,
                normalized_name
            );
            None
        }
    });

    // Persist to cache (positive and negative alike so we don't hammer YouTube
    // repeatedly for games with no good result).
    cache_store(&normalized_name, result.clone()).await;

    result
}

// Audio container extensions we recognize for theme tracks, in preference order.
const THEME_AUDIO_EXTS: [&str; 8] = ["opus", "webm", "m4a", "ogg", "mp3", "flac", "wav", "aac"];

/// Theme tracks are stored per-game as `theme.<ext>` (slot 1, the primary track)
/// and `theme-2.<ext>`, `theme-3.<ext>`, … for additional playlist entries. This
/// returns the 1-based slot for a path whose stem matches that scheme, else None.
fn theme_slot(path: &Path) -> Option<u32> {
    let stem = path.file_stem()?.to_str()?;
    if stem == "theme" {
        Some(1)
    } else {
        stem.strip_prefix("theme-")?
            .parse::<u32>()
            .ok()
            .filter(|n| *n >= 2)
    }
}

/// All extracted theme audio tracks for a game, ordered by playlist slot (the
/// primary `theme.*` first, then `theme-2`, `theme-3`, …). Within a slot the most
/// preferred container is chosen. Handles whatever exotic ext yt-dlp produced.
pub fn find_theme_audio_files(cache_dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(u32, usize, PathBuf)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(slot) = theme_slot(&path) else {
                continue;
            };
            let ext_rank = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .and_then(|e| THEME_AUDIO_EXTS.iter().position(|x| *x == e));
            let Some(ext_rank) = ext_rank else {
                continue;
            };
            found.push((slot, ext_rank, path));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    // Keep one file per slot (best container).
    let mut seen = HashSet::new();
    found
        .into_iter()
        .filter(|(slot, _, _)| seen.insert(*slot))
        .map(|(_, _, path)| path)
        .collect()
}

/// The primary (lowest-slot) theme audio file, if any. Backward-compatible entry
/// point used widely to detect/serve "the" theme.
pub fn find_theme_audio_file(cache_dir: &Path) -> Option<PathBuf> {
    find_theme_audio_files(cache_dir).into_iter().next()
}

/// Locate the file for a specific track slot basename (e.g. "theme" or
/// "theme-2"), regardless of which container ext was produced.
fn find_theme_file_for_basename(cache_dir: &Path, basename: &str) -> Option<PathBuf> {
    for ext in THEME_AUDIO_EXTS {
        let p = cache_dir.join(format!("{basename}.{ext}"));
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.file_stem().and_then(|s| s.to_str()) == Some(basename) {
                return Some(p);
            }
        }
    }
    None
}

/// The basename for the next free playlist slot: "theme" when the primary slot is
/// empty, else "theme-N" for the lowest free N ≥ 2. Lets downloads append tracks
/// instead of replacing the existing one.
pub fn next_theme_basename(cache_dir: &Path) -> String {
    let used: HashSet<u32> = find_theme_audio_files(cache_dir)
        .iter()
        .filter_map(|p| theme_slot(p))
        .collect();
    if !used.contains(&1) {
        return "theme".to_string();
    }
    let mut n = 2u32;
    while used.contains(&n) {
        n += 1;
    }
    format!("theme-{n}")
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
    output_basename: &str,
    force: bool,
    skip_preflight_probe: bool,
) -> Option<PathBuf> {
    if !game_themes_enabled() {
        debug!(
            "game themes disabled (RETROM_GAME_THEMES_ENABLED=false); skipping theme extraction"
        );
        return None;
    }

    let yt_dlp_path = ensure_yt_dlp().await?;

    if !force {
        if let Some(existing) = find_theme_file_for_basename(&cache_dir, output_basename) {
            return Some(existing);
        }
    } else if find_theme_file_for_basename(&cache_dir, output_basename).is_some() {
        // When forcing overwrite, clean up only THIS slot's existing files first
        // so we re-download fresh without disturbing other playlist tracks.
        debug!(
            "force overwrite requested for theme audio {} ({output_basename}) - removing existing slot files",
            video_id
        );
        if let Ok(entries) = std::fs::read_dir(&cache_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.file_stem().and_then(|n| n.to_str()) == Some(output_basename) {
                    let _ = tokio::fs::remove_file(&p).await;
                }
            }
        }
    }

    // Pre-flight duration guard: only run when the URL provenance is unknown (e.g. manual
    // add or legacy path). When called from the bulk job or per-game update path the URL
    // already passed find_soundtrack_url's [60s, 600s] validation, so the probe is
    // redundant and just adds a yt-dlp subprocess per game.
    if !skip_preflight_probe {
        if let Some(dur) = probe_video_duration_secs(video_id).await {
            if dur > 600 {
                warn!(
                    "Refusing to yt-dlp extract theme audio for {} ({}s > 10min limit). Only short themes are extracted as persistent game metadata.",
                    video_id, dur
                );
                return None;
            }
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
        .join(format!("{output_basename}.%(ext)s"))
        .to_string_lossy()
        .to_string();

    // If ffmpeg is present (system PATH or our bin dir), pass its location to yt-dlp.
    // This makes --download-sections reliable for all format types (without ffmpeg,
    // some WebM streams are downloaded in full then truncated in post).
    let ffmpeg_location = find_ffmpeg_if_present().await;
    let ffmpeg_location_str = ffmpeg_location
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());

    let cookies_path = get_youtube_cookies_path().await;
    let cookies_path_str = cookies_path
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());

    let mut cmd = Command::new(&yt_dlp_path);
    cmd.args([
        "--no-playlist",
        "--no-mtime",
        // Prefer direct audio-only (webm/opus or m4a), fall back to best.
        "-f", "bestaudio/best",
        "--user-agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "-o", &output_template,
        &yt_url,
    ]);
    // `--download-sections` requires ffmpeg — yt-dlp aborts the whole download
    // ("ffmpeg is not installed. Aborting") when it is missing. Only trim to the
    // first ~6 minutes when ffmpeg is available; otherwise download the full audio
    // so extraction still succeeds (theme playback only uses the audio track).
    if let Some(ref loc) = ffmpeg_location_str {
        cmd.args(["--download-sections", "*0:00-6:00", "--ffmpeg-location", loc]);
    } else {
        tracing::warn!(
            "ffmpeg not found; downloading full soundtrack audio without trimming. \
             Install ffmpeg on the server to limit theme audio to ~6 minutes."
        );
    }
    if let Some(ref cp) = cookies_path_str {
        cmd.args(["--cookies", cp]);
    }

    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) => {
            warn!("Failed to spawn yt-dlp for {}: {}", video_id, e);
            return None;
        }
    };

    if output.status.success() {
        if let Some(p) = find_theme_file_for_basename(&cache_dir, output_basename) {
            debug!(
                "Successfully extracted theme audio for {} -> {:?}",
                video_id, p
            );
            Some(p)
        } else {
            warn!(
                "yt-dlp reported success for {} but no {output_basename}.* file appeared in cache dir",
                video_id
            );
            None
        }
    } else {
        // Even on non-zero exit, yt-dlp sometimes writes a usable file (warnings, partial success).
        // Check anyway before declaring total failure.
        if let Some(p) = find_theme_file_for_basename(&cache_dir, output_basename) {
            debug!(
                "yt-dlp exited non-zero for {} but a {output_basename}.* file appeared anyway -> {:?}",
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

/// Ensures ffmpeg binary is available (downloads if missing). Returns path or None.
/// Checks: (1) system PATH, (2) our bin dir, (3) auto-downloads eugeneware/ffmpeg-static.
/// The download is serialized so concurrent calls don't race on the binary file.
pub async fn ensure_ffmpeg() -> Option<PathBuf> {
    // Fast paths — no lock needed.
    if let Some(p) = find_ffmpeg_if_present().await {
        return Some(p);
    }

    let dirs = RetromDirs::new();
    let bin_dir = dirs.data_dir().join("bin");
    let exe_name = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let exe_path = bin_dir.join(exe_name);

    let lock = FFMPEG_DOWNLOAD_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().await;

    // Re-check after acquiring the lock.
    if exe_path.exists() {
        return Some(exe_path);
    }

    let (asset_name, write_name) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => ("ffmpeg-win32-x64", "ffmpeg.exe"),
        ("linux", "x86_64") => ("ffmpeg-linux-x64", "ffmpeg"),
        ("macos", "x86_64") => ("ffmpeg-darwin-x64", "ffmpeg"),
        ("macos", "aarch64") => ("ffmpeg-darwin-arm64", "ffmpeg"),
        _ => {
            warn!(
                "No ffmpeg auto-download for {}/{}. Install ffmpeg to enable audio compression.",
                std::env::consts::OS,
                std::env::consts::ARCH
            );
            return None;
        }
    };

    let client = reqwest::Client::builder()
        .user_agent("Retrom/ffmpeg-fetch (https://github.com/jmberesford/retrom)")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let release: serde_json::Value = match client
        .get("https://api.github.com/repos/eugeneware/ffmpeg-static/releases/latest")
        .send()
        .await
    {
        Ok(r) => r.json().await.unwrap_or(serde_json::json!({})),
        Err(e) => {
            warn!("Failed to fetch ffmpeg release info: {}", e);
            return None;
        }
    };

    let assets = release
        .get("assets")
        .and_then(|a| a.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);

    let download_url = assets
        .iter()
        .find(|a| a.get("name").and_then(|n| n.as_str()) == Some(asset_name))
        .and_then(|a| a.get("browser_download_url").and_then(|u| u.as_str()))
        .map(|s| s.to_string());

    let Some(url) = download_url else {
        warn!(
            "ffmpeg asset '{}' not found in eugeneware/ffmpeg-static latest release. \
             Install ffmpeg manually to enable audio compression.",
            asset_name
        );
        return None;
    };

    tracing::info!(
        "Downloading ffmpeg from {} (one-time ~60–80 MB download)",
        url
    );

    if let Err(e) = fs::create_dir_all(&bin_dir).await {
        warn!("Failed to create bin dir for ffmpeg: {}", e);
        return None;
    }

    let bytes = match client.get(&url).send().await {
        Ok(r) => match r.bytes().await {
            Ok(b) => b,
            Err(e) => {
                warn!("Failed to read ffmpeg bytes: {}", e);
                return None;
            }
        },
        Err(e) => {
            warn!("ffmpeg download request failed: {}", e);
            return None;
        }
    };

    let out_path = bin_dir.join(write_name);
    if let Err(e) = fs::write(&out_path, &bytes).await {
        warn!("Failed to write ffmpeg binary: {}", e);
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(mut perms) = fs::metadata(&out_path).await.map(|m| m.permissions()) {
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&out_path, perms).await;
        }
    }

    tracing::info!("ffmpeg downloaded to {:?}", out_path);
    Some(out_path)
}

/// Cheap metadata-only probe for a video's title using the yt-dlp binary (no media
/// is downloaded). Mirrors `probe_video_duration_secs`. Used to capture the real
/// source track title at theme-download time so it can be embedded into the opus
/// file and persisted, instead of the UI only ever seeing "theme.opus".
pub async fn probe_video_title(video_id: &str) -> Option<String> {
    let yt_dlp_path = ensure_yt_dlp().await?;

    let yt_url = format!("https://www.youtube.com/watch?v={}", video_id);

    let output = Command::new(&yt_dlp_path)
        .args([
            "--no-download",
            "--no-playlist",
            "--print",
            "%(title)s",
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            &yt_url,
        ])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let title = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if title.is_empty() || title.eq_ignore_ascii_case("na") {
        None
    } else {
        Some(title)
    }
}

/// Normalize a raw source track title for display/storage: strip a trailing audio
/// file extension (junk for filename-derived names), drop the YouTube " - Topic"
/// channel suffix, trim, and collapse internal whitespace. Returns None if the
/// result is empty so callers can fall back to the embedded tag / "Theme".
pub fn normalize_track_title(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_string();

    for ext in [
        ".opus", ".webm", ".m4a", ".ogg", ".mp3", ".flac", ".wav", ".aac",
    ] {
        if s.to_ascii_lowercase().ends_with(ext) {
            s.truncate(s.len() - ext.len());
            break;
        }
    }

    if let Some(stripped) = s.strip_suffix(" - Topic") {
        s = stripped.to_string();
    }

    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let collapsed = collapsed.trim();
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed.to_string())
    }
}

/// Read the Vorbis-comment TITLE tag embedded in an Ogg Opus file (the tag we now
/// write at compress time via `-metadata title=`). Used on the read path to
/// backfill the stored title for older themes that predate the DB column, so the
/// UI shows a real name instead of "theme.opus" for existing files too.
///
/// Parses the `OpusTags` comment header packet directly (a vendor string followed
/// by a length-prefixed list of `KEY=VALUE` comments) by scanning the first 64 KiB
/// — enough to cover the comment header, which immediately follows the ID header.
/// All slicing is bounds-checked, so a malformed/truncated file just yields None.
pub fn read_opus_title(path: &Path) -> Option<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let n = file.read(&mut buf).ok()?;
    let buf = &buf[..n];

    let magic = b"OpusTags";
    let mut pos = buf.windows(magic.len()).position(|w| w == magic)? + magic.len();

    let read_u32 = |p: usize| -> Option<u32> {
        buf.get(p..p + 4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    };

    // Skip the vendor string.
    let vendor_len = read_u32(pos)? as usize;
    pos += 4 + vendor_len;

    // Iterate the user comment list.
    let count = read_u32(pos)? as usize;
    pos += 4;
    for _ in 0..count.min(256) {
        let len = read_u32(pos)? as usize;
        pos += 4;
        let comment = buf.get(pos..pos + len)?;
        pos += len;
        if let Ok(s) = std::str::from_utf8(comment) {
            if let Some(eq) = s.find('=') {
                let (key, value) = s.split_at(eq);
                if key.eq_ignore_ascii_case("title") {
                    let value = value[1..].trim();
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }

    None
}

/// Compress a downloaded theme audio file to opus at 64 kbps using ffmpeg.
/// Replaces the original file on success; returns the final file path either way.
/// No-ops if ffmpeg is unavailable (returns the original path) or if the file is
/// already opus-encoded. When `title` is provided it is embedded as the Opus/
/// Vorbis TITLE tag so the source track name survives on disk.
pub async fn compress_theme_audio(
    audio_path: &Path,
    cache_dir: &Path,
    output_basename: &str,
    title: Option<&str>,
) -> PathBuf {
    // Already opus — nothing to do.
    if audio_path.extension().and_then(|e| e.to_str()) == Some("opus") {
        return audio_path.to_path_buf();
    }

    let compressed = cache_dir.join(format!("{output_basename}.opus"));

    // Already compressed on a previous run.
    if compressed.exists() {
        if audio_path != compressed.as_path() {
            let _ = tokio::fs::remove_file(audio_path).await;
        }
        return compressed;
    }

    let ffmpeg_path = match ensure_ffmpeg().await {
        Some(p) => p,
        None => {
            debug!(
                "ffmpeg not available; skipping compression of {:?}",
                audio_path
            );
            return audio_path.to_path_buf();
        }
    };

    let Some(in_str) = audio_path.to_str() else {
        return audio_path.to_path_buf();
    };
    let Some(out_str) = compressed.to_str() else {
        return audio_path.to_path_buf();
    };

    tracing::debug!(
        "Compressing theme audio {:?} → {:?} (opus 64 kbps)",
        audio_path,
        compressed
    );

    let mut cmd = Command::new(&ffmpeg_path);
    cmd.args([
        "-i", in_str, "-c:a", "libopus", "-b:a", "64k", "-vn", // strip video track
    ]);
    // Embed the source track title as the Opus/Vorbis TITLE tag so the name is
    // preserved on disk (and recoverable later via read_opus_title).
    if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {
        cmd.args(["-metadata", &format!("title={title}")]);
    }
    cmd.args([
        "-y", // overwrite output if present
        out_str,
    ]);

    let result = cmd.output().await;

    match result {
        Ok(o) if o.status.success() && compressed.exists() => {
            if audio_path != compressed.as_path() {
                let _ = tokio::fs::remove_file(audio_path).await;
            }
            tracing::info!("Compressed theme audio → {:?}", compressed);
            compressed
        }
        Ok(o) => {
            warn!(
                "ffmpeg compression failed for {:?}: {}",
                audio_path,
                String::from_utf8_lossy(&o.stderr)
                    .lines()
                    .last()
                    .unwrap_or("(no output)")
            );
            audio_path.to_path_buf()
        }
        Err(e) => {
            warn!("ffmpeg spawn failed: {}", e);
            audio_path.to_path_buf()
        }
    }
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
