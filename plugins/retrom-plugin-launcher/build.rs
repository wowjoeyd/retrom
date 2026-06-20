const COMMANDS: &[&str] = &[
    "play_game",
    "stop_game",
    "get_game_play_status",
    "set_quit_rebind_active",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
