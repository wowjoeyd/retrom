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
    #[serde(default)]
    pub user_data_files: HashMap<String, UserDataFileState>,
    #[serde(default)]
    pub last_user_data_sync_unix_secs: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserDataFileState {
    pub sha256: String,
    pub byte_size: u64,
    pub modified_unix_secs: u64,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_state_accepts_legacy_json_without_user_data_fields() {
        let state: SyncState = serde_json::from_str(
            r#"{
                "linked_package_id": 7,
                "version": "1.0.0",
                "files": { "emu.exe": "abc" }
            }"#,
        )
        .expect("legacy sync state should deserialize");

        assert_eq!(state.linked_package_id, 7);
        assert_eq!(state.files.get("emu.exe"), Some(&"abc".to_string()));
        assert!(state.user_data_files.is_empty());
        assert!(state.last_user_data_sync_unix_secs.is_none());
    }

    #[test]
    fn sync_state_round_trips_user_data_manifest() {
        let mut state = SyncState {
            linked_package_id: 8,
            version: "2.0.0".to_string(),
            last_user_data_sync_unix_secs: Some(42),
            ..Default::default()
        };
        state.user_data_files.insert(
            "dev_hdd0/home/key.rap".to_string(),
            UserDataFileState {
                sha256: "def".to_string(),
                byte_size: 123,
                modified_unix_secs: 456,
            },
        );

        let encoded = serde_json::to_string(&state).expect("serialize sync state");
        let decoded: SyncState = serde_json::from_str(&encoded).expect("deserialize sync state");

        assert_eq!(decoded.last_user_data_sync_unix_secs, Some(42));
        assert_eq!(
            decoded
                .user_data_files
                .get("dev_hdd0/home/key.rap")
                .map(|entry| (&entry.sha256, entry.byte_size, entry.modified_unix_secs)),
            Some((&"def".to_string(), 123, 456))
        );
    }
}
