//! Steam implementation of [`AchievementProvider`].
//!
//! Keys entirely off the `steam_app_id` Retrom already stores (no hashing) and
//! reuses the existing [`SteamWebApiProvider`] HTTP client + the `config.steam`
//! credentials used for library import. Combines three Steam Web API calls:
//! GetSchemaForGame (definitions), GetPlayerAchievements (the user's unlocks),
//! and GetGlobalAchievementPercentagesForApp (rarity).

use std::{cmp::Ordering, sync::Arc};

use async_trait::async_trait;
use retrom_codegen::retrom::Game;

use crate::{
    config::ServerConfigManager, metadata_providers::steam::provider::SteamWebApiProvider,
};

use super::{
    AchievementProvider, AchievementsOutcome, ProviderAchievement, ProviderAchievementSet,
};

pub struct SteamAchievementProvider {
    steam: Arc<SteamWebApiProvider>,
    config: Arc<ServerConfigManager>,
}

impl SteamAchievementProvider {
    pub fn new(steam: Arc<SteamWebApiProvider>, config: Arc<ServerConfigManager>) -> Self {
        Self { steam, config }
    }
}

#[async_trait]
impl AchievementProvider for SteamAchievementProvider {
    fn id(&self) -> &'static str {
        "steam"
    }

    async fn applies_to(&self, game: &Game) -> bool {
        game.steam_app_id.is_some_and(|id| id > 0)
    }

    async fn fetch(&self, game: &Game) -> AchievementsOutcome {
        let Some(app_id) = game.steam_app_id.filter(|id| *id > 0).map(|id| id as u32) else {
            return AchievementsOutcome::NotConfigured;
        };

        let config = self.config.get_config().await;
        let steam = match config.steam {
            Some(steam) if !steam.api_key.is_empty() && !steam.user_id.is_empty() => steam,
            _ => return AchievementsOutcome::NotConfigured,
        };

        // Definitions first: this also tells us whether the game has a set at all.
        let schema = match self
            .steam
            .get_schema_achievements(app_id, &steam.api_key)
            .await
        {
            Ok(schema) => schema,
            Err(status) => {
                return AchievementsOutcome::NeedsAttention(format!(
                    "Steam returned {status} while loading the achievement list. Check your Steam Web API key."
                ));
            }
        };

        if schema.is_empty() {
            return AchievementsOutcome::Empty;
        }

        // Rarity (best-effort) + the user's unlocks.
        let globals = self.steam.get_global_achievement_percentages(app_id).await;

        let player = match self
            .steam
            .get_player_achievements(app_id, &steam.api_key, &steam.user_id)
            .await
        {
            Ok(player) => player,
            Err(status) => {
                return AchievementsOutcome::NeedsAttention(format!(
                    "Steam returned {status} while loading your achievements."
                ));
            }
        };

        if !player.success {
            let err = player.error.unwrap_or_default();
            let lower = err.to_lowercase();
            // A game whose stats aren't published reads as "empty" rather than a
            // problem the user must fix; a private profile is needs-attention.
            if lower.contains("no stats") {
                return AchievementsOutcome::Empty;
            }
            let message = if err.is_empty() {
                "Could not load your Steam achievements. Make sure your Steam profile (and game details) are set to public.".to_string()
            } else {
                err
            };
            return AchievementsOutcome::NeedsAttention(message);
        }

        let unlocks: std::collections::HashMap<String, (bool, i64)> = player
            .achievements
            .unwrap_or_default()
            .into_iter()
            .map(|a| (a.apiname, (a.achieved == 1, a.unlocktime)))
            .collect();

        let mut achievements: Vec<ProviderAchievement> = schema
            .into_iter()
            .map(|s| {
                let (unlocked, unlocktime) = unlocks.get(&s.name).copied().unwrap_or((false, 0));
                let icon = if unlocked { s.icon } else { s.icongray };
                let description = if s.description.is_empty() && s.hidden == 1 {
                    "Hidden achievement".to_string()
                } else {
                    s.description
                };

                ProviderAchievement {
                    id: s.name.clone(),
                    name: s.display_name,
                    description,
                    unlocked,
                    // Steam has no per-achievement points.
                    points: None,
                    rarity_percent: globals.get(&s.name).copied(),
                    icon_url: if icon.is_empty() { None } else { Some(icon) },
                    unlocked_at: if unlocked && unlocktime > 0 {
                        Some(unlocktime)
                    } else {
                        None
                    },
                }
            })
            .collect();

        // Unlocked first (most recent unlock first), then locked ordered by
        // rarity (most common first — i.e. the easiest next targets).
        achievements.sort_by(|a, b| match (a.unlocked, b.unlocked) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (true, true) => b.unlocked_at.cmp(&a.unlocked_at),
            (false, false) => b
                .rarity_percent
                .partial_cmp(&a.rarity_percent)
                .unwrap_or(Ordering::Equal),
        });

        let unlocked = achievements.iter().filter(|a| a.unlocked).count() as i32;
        let total = achievements.len() as i32;

        AchievementsOutcome::Populated(ProviderAchievementSet {
            provider: self.id().to_string(),
            unlocked,
            total,
            // Steam has no points model; the UI falls back to rarity.
            points_earned: 0,
            points_total: 0,
            achievements,
        })
    }
}
