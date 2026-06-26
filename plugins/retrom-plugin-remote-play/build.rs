const COMMANDS: &[&str] = &[
    "remote_play_host_readiness",
    "remote_play_ensure_host_app",
    "start_remote_play",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
