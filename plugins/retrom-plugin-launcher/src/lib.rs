use desktop::Launcher;
pub use error::{Error, Result};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod desktop;
mod error;
mod foreground;
#[cfg(windows)]
mod gamepad;
mod launch;
#[cfg(windows)]
mod quit;
#[cfg(windows)]
mod window;

pub use foreground::bring_to_foreground;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the launcher APIs.
pub trait LauncherExt<R: Runtime> {
    fn launcher(&self) -> &Launcher<R>;
}

impl<R: Runtime, T: Manager<R>> crate::LauncherExt<R> for T {
    fn launcher(&self) -> &Launcher<R> {
        self.try_state::<Launcher<R>>()
            .expect("Could not get launcher from app instance")
            .inner()
    }
}

/// Initializes the plugin.
pub async fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("launcher")
        .setup(|app, api| {
            let launcher = desktop::init(app, api)?;
            app.manage(launcher);

            // Forward native (XInput) controller input to the UI so the fullscreen
            // experience keeps responding to the controller even when the WebView2
            // Gamepad API is frozen by losing focus (e.g. after a Steam game). See
            // `gamepad`. The same reader also detects the quit-to-library hold (see
            // `quit`) and creates its display-only indicator window once the event
            // loop is running — NOT here in setup, where WebviewWindow::build()
            // would deadlock (the loop isn't pumping yet) and hang startup.
            #[cfg(windows)]
            gamepad::spawn(app.clone(), app.launcher().game_active_flag());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::play_game,
            commands::stop_game,
            commands::get_game_play_status,
        ])
        .build()
}
