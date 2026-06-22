//! Unified achievements abstraction (Steam + RetroAchievements).
//!
//! One [`AchievementProvider`] trait declares which games it applies to and
//! fetches the set + the user's progress. The [`AchievementsService`]
//! orchestrator picks the first applicable provider, caches successful results
//! to disk (with a TTL), caches badge images through the shared [`MediaCache`],
//! and serves everything through a single code path. Steam and RA both
//! implement the trait; GOG/Epic can slot in later by adding another impl.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use retrom_codegen::retrom::Game;
use serde::{Deserialize, Serialize};

use crate::{
    media_cache::{get_public_url, CacheMediaOpts, MediaCache},
    retrom_dirs::RetromDirs,
};

pub mod retroachievements;
pub mod steam;

/// How long a successfully fetched achievement set is served from disk before a
/// fresh fetch is triggered. Detail-open issues the query each time; this just
/// prevents hammering provider APIs on every open.
const ACHIEVEMENTS_TTL_SECS: i64 = 6 * 60 * 60;

const CACHE_FILE_NAME: &str = "achievements.json";

/// A single achievement merged from a provider's definition + the user's
/// progress. `icon_url` holds the remote badge URL while the provider produces
/// it, and is rewritten to a relative `media/...` path by the orchestrator once
/// the badge is cached.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProviderAchievement {
    pub id: String,
    pub name: String,
    pub description: String,
    pub unlocked: bool,
    /// Points awarded (RetroAchievements). Steam has no per-achievement points.
    pub points: Option<i32>,
    /// Global unlock percentage (rarity), when the provider supplies it.
    pub rarity_percent: Option<f64>,
    /// State-appropriate badge: remote URL during fetch, relative media path
    /// after caching.
    pub icon_url: Option<String>,
    /// Unix seconds the achievement was unlocked, if known.
    pub unlocked_at: Option<i64>,
}

/// A complete, resolved achievement set for a game.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProviderAchievementSet {
    /// Provider id: "steam" | "retroachievements".
    pub provider: String,
    pub unlocked: i32,
    pub total: i32,
    pub points_earned: i32,
    pub points_total: i32,
    pub achievements: Vec<ProviderAchievement>,
}

/// The outcome of a provider's fetch for a game it applies to.
pub enum AchievementsOutcome {
    /// Credentials are missing/incomplete for this provider.
    NotConfigured,
    /// Configured but progress couldn't be loaded (private profile, bad key,
    /// upstream error). The string is a human-readable detail.
    NeedsAttention(String),
    /// The provider applies and is configured, but the game has no set.
    Empty,
    /// RetroAchievements: content hash did not resolve to an RA game.
    NotIdentified,
    /// Resolved set.
    Populated(ProviderAchievementSet),
}

/// Resolved, provider-agnostic status for a game's achievements.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AchievementsStatus {
    NotSupported,
    NotConfigured,
    NotIdentified,
    NeedsAttention,
    Empty,
    Populated,
}

/// The full result the orchestrator hands back to the RPC layer.
pub struct AchievementsResult {
    pub status: AchievementsStatus,
    pub set: Option<ProviderAchievementSet>,
    pub message: Option<String>,
}

/// A source of achievements for some subset of games (Steam, RetroAchievements,
/// …). Implementations declare which games they apply to and fetch the set +
/// the user's progress into the shared [`ProviderAchievementSet`] shape.
#[async_trait]
pub trait AchievementProvider: Send + Sync {
    /// Stable provider id used in cache keys and the response (`"steam"`).
    fn id(&self) -> &'static str;

    /// Whether this provider can resolve achievements for the given game. Kept
    /// cheap — no network — so the orchestrator can pick a provider quickly.
    async fn applies_to(&self, game: &Game) -> bool;

    /// Fetch the achievement set + the user's progress. Only called for games
    /// this provider [`applies_to`](Self::applies_to). `rom_path` is the game's
    /// resolved primary ROM file on disk (used by RetroAchievements for content
    /// hashing); providers that don't need it ignore it.
    async fn fetch(&self, game: &Game, rom_path: Option<&Path>) -> AchievementsOutcome;
}

/// On-disk cache envelope (per game, under `media/games/<id>/achievements.json`).
#[derive(Serialize, Deserialize, Debug)]
struct CachedAchievements {
    fetched_at: i64,
    /// "populated" | "empty" | "not_identified" — resolved (non-transient) states.
    status: String,
    set: Option<ProviderAchievementSet>,
}

/// Orchestrates providers, caching, and badge resolution behind one method.
pub struct AchievementsService {
    providers: Vec<Arc<dyn AchievementProvider>>,
    media_cache: Arc<MediaCache>,
}

impl AchievementsService {
    pub fn new(providers: Vec<Arc<dyn AchievementProvider>>, media_cache: Arc<MediaCache>) -> Self {
        Self {
            providers,
            media_cache,
        }
    }

    fn game_cache_dir(game_id: i32) -> PathBuf {
        RetromDirs::new()
            .media_dir()
            .join("games")
            .join(game_id.to_string())
    }

    /// Resolve a game's achievements: cache → provider → cache + badge caching.
    /// `rom_path` is the game's primary ROM file on disk (resolved by the caller
    /// from the DB), needed by content-hashing providers like RetroAchievements.
    pub async fn get(
        &self,
        game: &Game,
        rom_path: Option<&Path>,
        force_refresh: bool,
    ) -> AchievementsResult {
        let provider = {
            let mut found = None;
            for p in &self.providers {
                if p.applies_to(game).await {
                    found = Some(p.clone());
                    break;
                }
            }
            found
        };

        let Some(provider) = provider else {
            return AchievementsResult {
                status: AchievementsStatus::NotSupported,
                set: None,
                message: None,
            };
        };

        if !force_refresh {
            if let Some(cached) = self.read_cache(game.id).await {
                return cached;
            }
        }

        match provider.fetch(game, rom_path).await {
            AchievementsOutcome::Populated(mut set) => {
                self.cache_badges(game.id, provider.id(), &mut set).await;
                self.write_cache(game.id, "populated", Some(&set)).await;
                AchievementsResult {
                    status: AchievementsStatus::Populated,
                    set: Some(set),
                    message: None,
                }
            }
            AchievementsOutcome::Empty => {
                self.write_cache(game.id, "empty", None).await;
                AchievementsResult {
                    status: AchievementsStatus::Empty,
                    set: None,
                    message: None,
                }
            }
            // Cached so we don't re-hash the ROM (and re-hit the identification
            // endpoint) on every detail-open; a manual match uses force_refresh.
            AchievementsOutcome::NotIdentified => {
                self.write_cache(game.id, "not_identified", None).await;
                AchievementsResult {
                    status: AchievementsStatus::NotIdentified,
                    set: None,
                    message: None,
                }
            }
            // Transient/credential states are not cached — they should resolve
            // as soon as the user fixes the cause, without waiting out a TTL.
            AchievementsOutcome::NotConfigured => AchievementsResult {
                status: AchievementsStatus::NotConfigured,
                set: None,
                message: None,
            },
            AchievementsOutcome::NeedsAttention(msg) => AchievementsResult {
                status: AchievementsStatus::NeedsAttention,
                set: None,
                message: Some(msg),
            },
        }
    }

    /// Read a fresh cached result, if present and within the TTL.
    async fn read_cache(&self, game_id: i32) -> Option<AchievementsResult> {
        let path = Self::game_cache_dir(game_id).join(CACHE_FILE_NAME);
        let bytes = tokio::fs::read(&path).await.ok()?;
        let cached: CachedAchievements = serde_json::from_slice(&bytes).ok()?;

        let now = chrono::Utc::now().timestamp();
        if now - cached.fetched_at > ACHIEVEMENTS_TTL_SECS {
            return None;
        }

        match cached.status.as_str() {
            "populated" => Some(AchievementsResult {
                status: AchievementsStatus::Populated,
                set: cached.set,
                message: None,
            }),
            "empty" => Some(AchievementsResult {
                status: AchievementsStatus::Empty,
                set: None,
                message: None,
            }),
            "not_identified" => Some(AchievementsResult {
                status: AchievementsStatus::NotIdentified,
                set: None,
                message: None,
            }),
            _ => None,
        }
    }

    async fn write_cache(&self, game_id: i32, status: &str, set: Option<&ProviderAchievementSet>) {
        let dir = Self::game_cache_dir(game_id);
        if let Err(why) = tokio::fs::create_dir_all(&dir).await {
            tracing::warn!("Failed to create achievements cache dir {dir:?}: {why}");
            return;
        }

        let envelope = CachedAchievements {
            fetched_at: chrono::Utc::now().timestamp(),
            status: status.to_string(),
            set: set.cloned(),
        };

        match serde_json::to_vec_pretty(&envelope) {
            Ok(data) => {
                let path = dir.join(CACHE_FILE_NAME);
                if let Err(why) = tokio::fs::write(&path, data).await {
                    tracing::warn!("Failed to write achievements cache {path:?}: {why}");
                }
            }
            Err(why) => tracing::warn!("Failed to serialize achievements cache: {why}"),
        }
    }

    /// Download each badge through the shared media cache and rewrite `icon_url`
    /// to a relative `media/...` path. On failure the remote URL is kept so the
    /// client can still load the badge directly from the provider's CDN.
    async fn cache_badges(
        &self,
        game_id: i32,
        provider_id: &str,
        set: &mut ProviderAchievementSet,
    ) {
        let cache_dir = Self::game_cache_dir(game_id);

        for ach in &mut set.achievements {
            let Some(remote) = ach.icon_url.clone() else {
                continue;
            };
            if remote.is_empty() {
                ach.icon_url = None;
                continue;
            }

            let opts = CacheMediaOpts {
                remote_url: remote.clone(),
                cache_dir: cache_dir.clone(),
                semantic_name: Some(sanitize_badge_name(provider_id, &ach.id)),
                base_dir: Some(PathBuf::from("achievements")),
            };

            match self.media_cache.cache_media_file(&opts).await {
                Ok(path) => ach.icon_url = get_public_url(&path).ok().or(Some(remote)),
                Err(why) => {
                    tracing::debug!(
                        "Failed to cache badge for game {game_id} achievement {}: {why}",
                        ach.id
                    );
                    // Keep the remote URL as a usable fallback.
                    ach.icon_url = Some(remote);
                }
            }
        }
    }
}

/// Build a filesystem-safe, collision-resistant semantic badge name. Provider
/// achievement ids (e.g. Steam apinames) can contain arbitrary characters, so
/// non-alphanumerics are replaced and a short hash of the original id is
/// appended to keep distinct ids distinct after sanitisation.
fn sanitize_badge_name(provider_id: &str, ach_id: &str) -> String {
    use std::hash::{DefaultHasher, Hash, Hasher};

    let cleaned: String = ach_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();

    let mut hasher = DefaultHasher::new();
    ach_id.hash(&mut hasher);
    let suffix = hasher.finish() % 0x1_0000;

    format!("{provider_id}-{cleaned}-{suffix:04x}")
}
