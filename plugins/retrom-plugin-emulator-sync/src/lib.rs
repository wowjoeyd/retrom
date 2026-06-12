use desktop::EmulatorSyncManager;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod desktop;
mod error;
mod sync_state;

pub use error::{Error, Result};

/// Extensions to access emulator sync APIs.
pub trait EmulatorSyncExt<R: Runtime> {
    fn emulator_sync(&self) -> &EmulatorSyncManager<R>;
}

impl<R: Runtime, T: Manager<R>> EmulatorSyncExt<R> for T {
    fn emulator_sync(&self) -> &EmulatorSyncManager<R> {
        self.state::<EmulatorSyncManager<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("emulator-sync")
        .invoke_handler(tauri::generate_handler![
            commands::ensure_emulator_synced,
            commands::get_emulator_sync_status,
            commands::get_emulator_sync_index,
            commands::subscribe_to_emulator_sync_updates,
            commands::unsubscribe_from_emulator_sync_updates,
            commands::abort_emulator_sync,
            commands::open_emulator_cache_dir,
        ])
        .setup(|app, api| {
            let manager = desktop::init(app, api)?;
            app.manage(manager);
            Ok(())
        })
        .build()
}
