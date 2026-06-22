//! Durable per-game RetroAchievements game-id overrides for the manual-match
//! fallback. Stored under the data dir (NOT the media dir, which "Delete local
//! metadata" wipes) as a single JSON map of `game_id -> ra_game_id`.

use std::collections::HashMap;
use std::path::PathBuf;

use tokio::sync::RwLock;

use crate::retrom_dirs::RetromDirs;

pub struct RaOverrideStore {
    path: PathBuf,
    /// Lazily loaded cache of the on-disk map.
    cache: RwLock<Option<HashMap<i32, i64>>>,
}

impl RaOverrideStore {
    pub fn new() -> Self {
        let path = RetromDirs::new()
            .data_dir()
            .join("achievements")
            .join("ra_overrides.json");

        Self {
            path,
            cache: RwLock::new(None),
        }
    }

    async fn load(&self) -> HashMap<i32, i64> {
        if let Some(map) = self.cache.read().await.as_ref() {
            return map.clone();
        }

        let map: HashMap<i32, i64> = match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => HashMap::new(),
        };

        *self.cache.write().await = Some(map.clone());
        map
    }

    /// The RA game id manually bound to this game, if any.
    pub async fn get(&self, game_id: i32) -> Option<i64> {
        self.load().await.get(&game_id).copied()
    }

    /// Bind (or, with `ra_game_id` <= 0, clear) the RA game id for a game and
    /// persist the change.
    pub async fn set(&self, game_id: i32, ra_game_id: i64) -> std::io::Result<()> {
        let mut map = self.load().await;
        if ra_game_id > 0 {
            map.insert(game_id, ra_game_id);
        } else {
            map.remove(&game_id);
        }

        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let data = serde_json::to_vec_pretty(&map)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        tokio::fs::write(&self.path, data).await?;

        *self.cache.write().await = Some(map);
        Ok(())
    }
}

impl Default for RaOverrideStore {
    fn default() -> Self {
        Self::new()
    }
}
