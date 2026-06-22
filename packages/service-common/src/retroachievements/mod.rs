//! RetroAchievements integration primitives: content hashing (rc_hash FFI), the
//! identification endpoint (hash → game id), and the Web API call used to fetch
//! a game's achievement set + a user's progress.
//!
//! These back both the Phase B `AchievementProvider` and the standalone
//! `ra-hash` gate command, so there is one resolution path.

pub mod hash;
pub mod override_store;

use std::collections::HashMap;

use serde::{Deserialize, Deserializer};

/// Unauthenticated "connect" identification endpoint (hash → game id).
const DOREQUEST_URL: &str = "https://retroachievements.org/dorequest.php";
/// Web API base (authenticated with username + web API key).
const WEB_API_URL: &str = "https://retroachievements.org/API";
/// Badge image CDN. Unlocked badge is `<name>.png`, locked is `<name>_lock.png`.
pub const BADGE_BASE_URL: &str = "https://media.retroachievements.org/Badge";

#[derive(Debug, thiserror::Error)]
pub enum RetroAchievementsError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
}

#[derive(Deserialize, Debug)]
struct GameIdResponse {
    #[serde(rename = "Success", default)]
    success: bool,
    #[serde(rename = "GameID", default, deserialize_with = "de_i64")]
    game_id: i64,
}

/// Resolve a single content hash to a RetroAchievements game id via the
/// `dorequest.php?r=gameid` identification endpoint. Returns `0` when the hash
/// is not linked to any game (the "not identified" case).
pub async fn resolve_hash_to_game_id(
    client: &reqwest::Client,
    hash: &str,
) -> Result<i64, RetroAchievementsError> {
    let resp = client
        .get(DOREQUEST_URL)
        .query(&[("r", "gameid"), ("m", hash)])
        .send()
        .await?
        .error_for_status()?;

    let body: GameIdResponse = resp.json().await?;
    Ok(if body.success { body.game_id } else { 0 })
}

/// One achievement as returned by GetGameInfoAndUserProgress.
#[derive(Deserialize, Debug)]
pub struct RaAchievement {
    #[serde(rename = "ID", default, deserialize_with = "de_i64")]
    pub id: i64,
    #[serde(rename = "Title", default)]
    pub title: String,
    #[serde(rename = "Description", default)]
    pub description: String,
    #[serde(rename = "Points", default, deserialize_with = "de_i64")]
    pub points: i64,
    #[serde(rename = "BadgeName", default)]
    pub badge_name: String,
    #[serde(rename = "NumAwarded", default, deserialize_with = "de_opt_i64")]
    pub num_awarded: Option<i64>,
    #[serde(rename = "DisplayOrder", default, deserialize_with = "de_i64")]
    pub display_order: i64,
    /// Present (UTC "YYYY-MM-DD HH:MM:SS") only when the user has earned it.
    #[serde(rename = "DateEarned", default)]
    pub date_earned: Option<String>,
    #[serde(rename = "DateEarnedHardcore", default)]
    pub date_earned_hardcore: Option<String>,
}

/// GetGameInfoAndUserProgress response (the subset we render).
#[derive(Deserialize, Debug)]
pub struct GameInfoAndUserProgress {
    #[serde(rename = "ID", default, deserialize_with = "de_i64")]
    pub id: i64,
    #[serde(rename = "Title", default)]
    pub title: String,
    #[serde(rename = "NumAchievements", default, deserialize_with = "de_i64")]
    pub num_achievements: i64,
    #[serde(
        rename = "NumDistinctPlayers",
        default,
        deserialize_with = "de_opt_i64"
    )]
    pub num_distinct_players: Option<i64>,
    #[serde(
        rename = "NumDistinctPlayersCasual",
        default,
        deserialize_with = "de_opt_i64"
    )]
    pub num_distinct_players_casual: Option<i64>,
    #[serde(rename = "Achievements", default)]
    pub achievements: HashMap<String, RaAchievement>,
}

impl GameInfoAndUserProgress {
    /// Player base used for rarity (global unlock %). Prefer the total distinct
    /// players, falling back to the casual count.
    pub fn player_base(&self) -> Option<i64> {
        self.num_distinct_players
            .or(self.num_distinct_players_casual)
            .filter(|n| *n > 0)
    }
}

/// Fetch a game's achievement set + the configured user's progress.
pub async fn get_game_info_and_user_progress(
    client: &reqwest::Client,
    username: &str,
    api_key: &str,
    game_id: i64,
) -> Result<GameInfoAndUserProgress, RetroAchievementsError> {
    let url = format!("{WEB_API_URL}/API_GetGameInfoAndUserProgress.php");
    let resp = client
        .get(&url)
        .query(&[
            ("z", username),
            ("y", api_key),
            ("u", username),
            ("g", &game_id.to_string()),
        ])
        .send()
        .await?
        .error_for_status()?;

    Ok(resp.json().await?)
}

/// Parse RA's "YYYY-MM-DD HH:MM:SS" (UTC) timestamps into unix seconds.
pub fn parse_ra_datetime(raw: &str) -> Option<i64> {
    chrono::NaiveDateTime::parse_from_str(raw.trim(), "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.and_utc().timestamp())
}

// RA's APIs are inconsistent about whether numerics arrive as JSON numbers or
// strings; accept either so a representation change doesn't drop fields.
fn de_i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<i64, D::Error> {
    Ok(de_opt_i64(deserializer)?.unwrap_or(0))
}

fn de_opt_i64<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        Num(i64),
        Float(f64),
        Str(String),
        Null,
    }

    Ok(match Option::<NumOrStr>::deserialize(deserializer)? {
        None | Some(NumOrStr::Null) => None,
        Some(NumOrStr::Num(n)) => Some(n),
        Some(NumOrStr::Float(f)) => Some(f as i64),
        Some(NumOrStr::Str(s)) => s.trim().parse().ok(),
    })
}
