use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub const SYNC_STATE_FILE_NAME: &str = "sync_state.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncState {
    pub linked_package_id: i32,
    pub version: String,
    #[serde(default)]
    pub files: HashMap<String, String>,
}

pub fn sync_state_path(cache_root: &Path) -> PathBuf {
    cache_root.join(SYNC_STATE_FILE_NAME)
}

pub fn load_sync_state(cache_root: &Path) -> crate::Result<Option<SyncState>> {
    let path = sync_state_path(cache_root);
    if !path.exists() {
        return Ok(None);
    }

    let data = std::fs::read_to_string(path)?;
    Ok(Some(serde_json::from_str(&data)?))
}

pub fn save_sync_state(cache_root: &Path, state: &SyncState) -> crate::Result<()> {
    let path = sync_state_path(cache_root);
    let data = serde_json::to_string_pretty(state)?;
    std::fs::write(path, data)?;
    Ok(())
}