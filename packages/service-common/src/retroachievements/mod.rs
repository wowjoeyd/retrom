//! RetroAchievements integration primitives: content hashing (rc_hash FFI) and
//! the API calls used to identify a game and fetch a user's progress.
//!
//! The hashing + game-id resolution here back both the Phase B `AchievementProvider`
//! and the standalone `ra-hash` gate command, so there is one resolution path.

pub mod hash;

use serde::Deserialize;

/// Base host for the unauthenticated "connect" identification endpoint.
const DOREQUEST_URL: &str = "https://retroachievements.org/dorequest.php";

#[derive(Debug, thiserror::Error)]
pub enum RetroAchievementsError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
}

#[derive(Deserialize, Debug)]
struct GameIdResponse {
    #[serde(rename = "Success", default)]
    success: bool,
    #[serde(rename = "GameID", default)]
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
