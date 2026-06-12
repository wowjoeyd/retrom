const COMMANDS: &[&str] = &[
    "ensure_emulator_synced",
    "get_emulator_sync_status",
    "get_emulator_sync_index",
    "subscribe_to_emulator_sync_updates",
    "unsubscribe_from_emulator_sync_updates",
    "abort_emulator_sync",
    "open_emulator_cache_dir",
    "push_emulator_preserve_data",
    "pull_emulator_user_data",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
