//! RetroAchievements implementation of [`AchievementProvider`].
//!
//! Applies to emulated (scanned, non-Steam) games. Resolves the game either via
//! a durable manual override or by content-hashing its ROM (rcheevos rc_hash)
//! and looking the hash up, then fetches the set + the user's progress from the
//! RA Web API and renders it through the same pipeline as Steam. Auth comes from
//! the `retro_achievements { username, api_key }` server config.

use std::{cmp::Ordering, path::Path, sync::Arc};

use async_trait::async_trait;
use retrom_codegen::retrom::Game;

use crate::{
    config::ServerConfigManager,
    retroachievements::{
        get_game_info_and_user_progress, hash::rc_hash_candidates, override_store::RaOverrideStore,
        parse_ra_datetime, resolve_hash_to_game_id, RaAchievement, BADGE_BASE_URL,
    },
};

use super::{
    AchievementProvider, AchievementsOutcome, ProviderAchievement, ProviderAchievementSet,
};

pub struct RetroAchievementsProvider {
    config: Arc<ServerConfigManager>,
    overrides: Arc<RaOverrideStore>,
    http: reqwest::Client,
}

impl RetroAchievementsProvider {
    pub fn new(config: Arc<ServerConfigManager>, overrides: Arc<RaOverrideStore>) -> Self {
        Self {
            config,
            overrides,
            http: reqwest::Client::new(),
        }
    }

    /// Resolve the RA game id for a game: a manual override wins outright and
    /// skips hashing; otherwise hash the ROM and look up each candidate hash.
    /// Returns `None` when nothing resolves (the not-identified case).
    async fn resolve_game_id(&self, game: &Game, rom_path: Option<&Path>) -> Option<i64> {
        if let Some(id) = self.overrides.get(game.id).await {
            return Some(id);
        }

        let path = rom_path?.to_path_buf();
        // rc_hash reads from disk — keep it off the async worker threads.
        let candidates = tokio::task::spawn_blocking(move || rc_hash_candidates(&path))
            .await
            .unwrap_or_default();

        for hash in &candidates {
            if let Ok(id) = resolve_hash_to_game_id(&self.http, hash).await {
                if id != 0 {
                    return Some(id);
                }
            }
        }

        None
    }
}

#[async_trait]
impl AchievementProvider for RetroAchievementsProvider {
    fn id(&self) -> &'static str {
        "retroachievements"
    }

    async fn applies_to(&self, game: &Game) -> bool {
        // Emulated, scanned games. Steam (and other store) entries are third
        // party; those are handled by their own providers.
        !game.third_party && game.steam_app_id.is_none()
    }

    async fn fetch(&self, game: &Game, rom_path: Option<&Path>) -> AchievementsOutcome {
        let config = self.config.get_config().await;
        let ra = match config.retro_achievements {
            Some(ra) if !ra.username.is_empty() && !ra.api_key.is_empty() => ra,
            _ => return AchievementsOutcome::NotConfigured,
        };

        let Some(game_id) = self.resolve_game_id(game, rom_path).await else {
            return AchievementsOutcome::NotIdentified;
        };

        let info = match get_game_info_and_user_progress(
            &self.http,
            &ra.username,
            &ra.api_key,
            game_id,
        )
        .await
        {
            Ok(info) => info,
            Err(why) => {
                return AchievementsOutcome::NeedsAttention(format!(
                        "Could not load RetroAchievements data: {why}. Check your RA username and web API key."
                    ));
            }
        };

        if info.achievements.is_empty() {
            return AchievementsOutcome::Empty;
        }

        let player_base = info.player_base();

        let mut raws: Vec<RaAchievement> = info.achievements.into_values().collect();
        // Unlocked first (most recent first), then locked in the set's intended
        // display order.
        raws.sort_by(|a, b| {
            let a_at = earned_at(a);
            let b_at = earned_at(b);
            match (a_at.is_some(), b_at.is_some()) {
                (true, false) => Ordering::Less,
                (false, true) => Ordering::Greater,
                (true, true) => b_at.cmp(&a_at),
                (false, false) => a.display_order.cmp(&b.display_order),
            }
        });

        let achievements: Vec<ProviderAchievement> = raws
            .into_iter()
            .map(|a| {
                let unlocked_at = earned_at(&a);
                let unlocked = unlocked_at.is_some();
                let icon_url = (!a.badge_name.is_empty()).then(|| {
                    if unlocked {
                        format!("{BADGE_BASE_URL}/{}.png", a.badge_name)
                    } else {
                        format!("{BADGE_BASE_URL}/{}_lock.png", a.badge_name)
                    }
                });
                let rarity_percent = match (player_base, a.num_awarded) {
                    (Some(base), Some(n)) if base > 0 => Some(n as f64 / base as f64 * 100.0),
                    _ => None,
                };

                ProviderAchievement {
                    id: a.id.to_string(),
                    name: a.title,
                    description: a.description,
                    unlocked,
                    points: Some(a.points as i32),
                    rarity_percent,
                    icon_url,
                    unlocked_at,
                }
            })
            .collect();

        let unlocked = achievements.iter().filter(|a| a.unlocked).count() as i32;
        let total = achievements.len() as i32;
        let points_total = achievements.iter().filter_map(|a| a.points).sum();
        let points_earned = achievements
            .iter()
            .filter(|a| a.unlocked)
            .filter_map(|a| a.points)
            .sum();

        AchievementsOutcome::Populated(ProviderAchievementSet {
            provider: self.id().to_string(),
            unlocked,
            total,
            points_earned,
            points_total,
            achievements,
        })
    }
}

/// Unix-seconds the achievement was earned (hardcore preferred), if at all.
fn earned_at(a: &RaAchievement) -> Option<i64> {
    a.date_earned_hardcore
        .as_deref()
        .or(a.date_earned.as_deref())
        .and_then(parse_ra_datetime)
}
