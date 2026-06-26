use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod desktop;
mod error;
pub mod sunshine;

pub use desktop::RemotePlay;
pub use error::{Error, Result};

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to
/// access the Remote Play host APIs.
pub trait RemotePlayExt<R: Runtime> {
    fn remote_play(&self) -> &RemotePlay<R>;
}

impl<R: Runtime, T: Manager<R>> crate::RemotePlayExt<R> for T {
    fn remote_play(&self) -> &RemotePlay<R> {
        self.state::<RemotePlay<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("remote-play")
        .invoke_handler(tauri::generate_handler![
            commands::remote_play_host_readiness
        ])
        .setup(|app, api| {
            let remote_play = desktop::init(app, api)?;
            app.manage(remote_play);
            Ok(())
        })
        .build()
}
