const COMMANDS: &[&str] = &["remote_play_host_readiness"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
