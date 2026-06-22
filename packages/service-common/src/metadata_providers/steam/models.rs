use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct GetOwnedGamesResponse {
    pub response: GetOwnedGamesData,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GetOwnedGamesData {
    pub game_count: i32,
    pub games: Vec<Game>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Game {
    pub appid: u32,
    pub name: String,
    pub playtime_forever: i32,
    pub rtime_last_played: i64,
    pub img_icon_url: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AppDetailsData {
    pub success: bool,
    pub data: Option<AppDetails>,
}

pub type AppDetailsResponse = HashMap<String, AppDetailsData>;

#[derive(Serialize, Deserialize, Debug)]
pub struct ReleaseDate {
    pub coming_soon: bool,
    pub date: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AppDetails {
    pub name: Option<String>,
    pub steam_appid: Option<u32>,
    pub detailed_description: Option<String>,
    pub short_description: Option<String>,
    pub header_image: Option<String>,
    pub background: Option<String>,
    pub background_raw: Option<String>,
    pub capsule_image: Option<String>,
    pub capsule_imagev5: Option<String>,
    pub website: Option<String>,
    pub developers: Option<Vec<String>>,
    pub publishers: Option<Vec<String>>,
    pub platforms: Option<Platforms>,
    pub genres: Option<Vec<Genre>>,
    pub movies: Option<Vec<Movie>>,
    pub screenshots: Option<Vec<Screenshot>>,
    pub release_date: Option<ReleaseDate>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Platforms {
    pub windows: bool,
    pub mac: bool,
    pub linux: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Genre {
    pub description: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Category {
    pub id: i32,
    pub description: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Screenshot {
    pub id: i32,
    pub path_thumbnail: String,
    pub path_full: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MovieQualities {
    #[serde(rename = "480")]
    pub _480: Option<String>,
    pub max: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Movie {
    pub id: i32,
    pub name: String,
    pub thumbnail: String,
    pub webm: Option<MovieQualities>,
    pub mp4: Option<MovieQualities>,
    pub highlight: bool,
}

// ── Achievements: GetSchemaForGame (ISteamUserStats/GetSchemaForGame/v2) ──────

#[derive(Serialize, Deserialize, Debug)]
pub struct GetSchemaForGameResponse {
    pub game: Option<SchemaGame>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SchemaGame {
    #[serde(rename = "availableGameStats")]
    pub available_game_stats: Option<AvailableGameStats>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AvailableGameStats {
    #[serde(default)]
    pub achievements: Vec<SchemaAchievement>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SchemaAchievement {
    /// Stable api name (e.g. "ACH_WIN_ONE_GAME"); the join key for player + global.
    pub name: String,
    #[serde(rename = "displayName", default)]
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub hidden: i32,
    /// Unlocked (colour) badge URL.
    #[serde(default)]
    pub icon: String,
    /// Locked (grey) badge URL.
    #[serde(default)]
    pub icongray: String,
}

// ── Achievements: GetPlayerAchievements (ISteamUserStats/GetPlayerAchievements/v1) ──

#[derive(Serialize, Deserialize, Debug)]
pub struct GetPlayerAchievementsResponse {
    pub playerstats: PlayerStats,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PlayerStats {
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub achievements: Option<Vec<PlayerAchievement>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerAchievement {
    pub apiname: String,
    pub achieved: i32,
    #[serde(default)]
    pub unlocktime: i64,
}

// ── Achievements: GetGlobalAchievementPercentagesForApp (v2) ──────────────────

#[derive(Serialize, Deserialize, Debug)]
pub struct GetGlobalAchievementPercentagesResponse {
    #[serde(rename = "achievementpercentages")]
    pub achievement_percentages: Option<GlobalPercentages>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct GlobalPercentages {
    #[serde(default)]
    pub achievements: Vec<GlobalAchievementPercent>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GlobalAchievementPercent {
    pub name: String,
    /// Steam returns this as a JSON number, but has historically also sent it as
    /// a string — accept either so a format change doesn't drop all rarity data.
    #[serde(deserialize_with = "de_percent")]
    pub percent: f64,
}

fn de_percent<'de, D>(deserializer: D) -> Result<f64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr {
        Num(f64),
        Str(String),
    }

    Ok(match NumOrStr::deserialize(deserializer)? {
        NumOrStr::Num(n) => n,
        NumOrStr::Str(s) => s.trim().parse().unwrap_or(0.0),
    })
}
