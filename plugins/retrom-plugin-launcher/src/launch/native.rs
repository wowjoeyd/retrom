//! Launches and monitors native emulator/game processes spawned by Retrom.

use std::{ffi::OsStr, path::PathBuf, sync::Arc};

use async_trait::async_trait;
use retrom_codegen::retrom::{
    client::{installation::InstallationStatus, saves::SaveSyncStatus},
    GetLocalEmulatorConfigsRequest,
};
use retrom_plugin_config::ConfigExt;
use retrom_plugin_installer::InstallerExt;
use retrom_plugin_save_manager::{SaveKind, SaveManagerExt};
use retrom_plugin_service_client::RetromPluginServiceClientExt;
use tauri::Runtime;
use tokio::sync::Mutex;
use tracing::{info, warn};
use walkdir::WalkDir;

use crate::{desktop::GameProcess, LauncherExt};

use super::{LaunchAdapter, LaunchContext};

pub(crate) struct NativeAdapter;

fn emulator_package_sync_enabled() -> bool {
    match std::env::var("EMULATOR_PACKAGE_SYNC") {
        Ok(value) => !matches!(value.to_ascii_lowercase().as_str(), "false" | "0" | "no"),
        Err(_) => true,
    }
}

#[async_trait]
impl<R: Runtime> LaunchAdapter<R> for NativeAdapter {
    fn name(&self) -> &'static str {
        "native"
    }

    /// The catch-all adapter: handles anything the more specific adapters didn't.
    fn matches(&self, _ctx: &LaunchContext<R>) -> bool {
        true
    }

    async fn launch(&self, ctx: LaunchContext<R>) -> crate::Result<()> {
        let LaunchContext {
            app,
            game,
            emulator,
            profile,
            file,
            standalone,
        } = ctx;

        let profile = profile.expect("No emulator profile provided");
        let emulator = emulator.expect("No emulator provided");

        let launcher = app.launcher();
        let installer = app.installer();

        let game_id = game.id;
        let emulator_id = emulator.id;
        let maybe_default_game_file = file;

        let maybe_default_file = maybe_default_game_file
            .clone()
            .map(|file| file.path)
            .map(PathBuf::from);

        if !standalone
            && installer.get_game_installation_status(game_id).await
                != InstallationStatus::Installed
        {
            return Err(crate::Error::NotInstalled(game_id));
        }

        let install_dir = match standalone {
            true => PathBuf::from(&game.path),
            false => match installer.get_game_installation_path(game_id).await {
                Some(path) => path,
                None => return Err(crate::Error::NotInstalled(game_id)),
            },
        };

        let mut files: Vec<PathBuf> = WalkDir::new(&install_dir)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.into_path())
            .filter(|p| p.is_file())
            .collect();

        files.sort();

        tracing::debug!("Files: {:?}", files);
        tracing::debug!("Default file: {:?}", &maybe_default_file);

        let fallback_file = match profile.supported_extensions.is_empty() {
            true => files
                .iter()
                .find(|file| Some(*file) != maybe_default_file.as_ref()),
            false => files.iter().find(|file| {
                profile
                    .supported_extensions
                    .iter()
                    .any(|ext| file.extension().and_then(OsStr::to_str) == Some(ext.as_str()))
            }),
        };

        tracing::debug!("Fallback file: {:?}", fallback_file);

        let relative_to_install_dir = maybe_default_file
            .as_deref()
            .and_then(|f| f.strip_prefix(&game.path).ok());

        let file_path = match files
            .iter()
            .find(|f| f.strip_prefix(&install_dir).ok() == relative_to_install_dir)
        {
            Some(file) => file,
            None => match fallback_file {
                Some(file) => file,
                None => return Err(crate::Error::FileNotFound(game_id)),
            },
        };

        tracing::debug!("File path: {:?}", file_path);

        let file_path = match file_path.canonicalize()?.to_str() {
            Some(path) => path.to_string(),
            None => return Err(crate::Error::FileNotFound(game_id)),
        };

        let install_dir = match install_dir.canonicalize()?.to_str() {
            Some(path) => path.to_string(),
            None => return Err(crate::Error::FileNotFound(game_id)),
        };

        let client_config = app.config_manager().get_config().await;

        let client_id = client_config
            .config
            .and_then(|c| c.client_info.map(|info| info.id))
            .expect("Client ID not found");

        let mut emulator_client = app.get_emulator_client().await;
        let res = emulator_client
            .get_local_emulator_configs(GetLocalEmulatorConfigsRequest {
                client_id,
                emulator_ids: vec![emulator.id],
            })
            .await
            .expect("Failed to get local emulator configs")
            .into_inner();

        let local_config = res.configs.first().expect("No emulator config found");

        let executable_path = if local_config.managed_paths && emulator_package_sync_enabled() {
            let path = PathBuf::from(&local_config.executable_path);
            if !path.exists() {
                return Err(crate::Error::EmulatorSyncFailed(
                    emulator_id,
                    "Executable not in cache; launch from Play button to sync".into(),
                ));
            }
            local_config.executable_path.clone()
        } else {
            local_config.executable_path.clone()
        };

        let mut cmd = launcher.get_open_cmd(&executable_path);

        tracing::Span::current().record("command", format!("{cmd:?}"));
        info!("Command: {cmd:?}");

        let args = if !profile.custom_args.is_empty() {
            #[allow(clippy::literal_string_with_formatting_args)]
            profile
                .custom_args
                .into_iter()
                .map(|arg| match arg.starts_with("\"") && arg.ends_with("\"") {
                    false => arg,
                    true => arg[1..arg.len() - 1].to_string(),
                })
                .map(|arg| match arg.starts_with("'") && arg.ends_with("'") {
                    false => arg,
                    true => arg[1..arg.len() - 1].to_string(),
                })
                .map(|arg| arg.replace("{file}", &file_path))
                .map(|arg| arg.replace("{install_dir}", &install_dir))
                .collect()
        } else {
            vec![file_path]
        };

        tracing::Span::current().record("args", format!("{args:?}"));
        info!("Args Constructed: {:?}", args);

        cmd.args(args);

        let (send, mut recv) = tokio::sync::mpsc::channel(1);
        let mut process = cmd.spawn()?;
        #[cfg(windows)]
        let game_pid = process.id();
        let send = Arc::new(Mutex::new(send));

        launcher
            .mark_game_as_running(
                game_id,
                GameProcess {
                    send: send.clone(),
                    start_time: std::time::SystemTime::now(),
                },
            )
            .await?;

        // Retrom holds the foreground when it spawns the game, so Windows blocks
        // the new window from taking focus — bring it forward ourselves. Runs in
        // the background since the game's window can take a moment to appear.
        #[cfg(windows)]
        if let Some(game_pid) = game_pid {
            tokio::spawn(crate::window::foreground_game(app.clone(), game_pid));
        }

        let save_manager = app.save_manager();
        let sync_saves = || async move {
            match save_manager
                .check_save_sync_status(emulator_id, SaveKind::Saves)
                .await
            {
                Ok(result) => {
                    tracing::debug!(
                        "Save sync status for emulator {emulator_id}: {:?}",
                        result.status
                    );

                    if let SaveSyncStatus::LocalNewer = result.status {
                        if let Err(why) = save_manager
                            .upload_local_save_files(emulator_id, SaveKind::Saves)
                            .await
                        {
                            tracing::warn!(
                                "Failed to upload local save files for emulator {emulator_id}: {:#?}",
                                why
                            );
                        }
                    }
                }
                Err(why) => {
                    tracing::warn!(
                        "Failed to check save sync status for emulator {emulator_id}: {:#?}",
                        why
                    );
                }
            };

            match save_manager
                .check_save_sync_status(emulator_id, SaveKind::SaveStates)
                .await
            {
                Ok(result) => {
                    tracing::debug!(
                        "Save state sync status for emulator {emulator_id}: {:?}",
                        result.status
                    );

                    if let SaveSyncStatus::LocalNewer = result.status {
                        if let Err(why) = save_manager
                            .upload_local_save_files(emulator_id, SaveKind::SaveStates)
                            .await
                        {
                            tracing::warn!(
                                "Failed to upload local save state files for emulator {emulator_id}: {:#?}",
                                why
                            );
                        }
                    }
                }
                Err(why) => {
                    tracing::warn!(
                        "Failed to check save state sync status for emulator {emulator_id}: {:#?}",
                        why
                    );
                }
            };
        };

        let app = app.clone();
        tokio::select! {
            _ = recv.recv() => {
                info!("Received stop signal for game {game_id}");

                // Capture the process tree BEFORE killing. Emulators commonly
                // re-exec into a child that owns the real window, and Windows
                // doesn't reparent orphans, so once the tracked parent dies we
                // can no longer find them. `process.kill()` only terminates the
                // direct child — without killing the tree, the real emulator
                // survives and fights Retrom for the OS foreground, freezing the
                // return to the library (whereas a natural exit leaves nothing
                // behind). So kill the whole captured tree on an explicit stop.
                #[cfg(windows)]
                let process_tree = game_pid.map(crate::window::descendant_pids);

                if let Err(why) = process.kill().await {
                    warn!("Failed to kill game process for game {game_id}: {why}");
                } else {
                    info!("Killed game process for game {game_id}");
                }

                #[cfg(windows)]
                if let Some(tree) = process_tree {
                    crate::window::kill_pids(tree);
                }
            }
            _ = process.wait() => {
                info!("Game process for game {game_id} exited");
            }
        };

        // Hand control back to the player FIRST, THEN sync saves. mark_game_as_stopped
        // clears the `game_active` flag (so the native gamepad reader resumes driving
        // the UI) and emits game-stopped; save sync is a network/IPC call that can
        // stall or hang. Running it BEFORE marking stopped — the old order — left
        // `game_active` set for the whole sync, so a controller-only Big Picture
        // session was stranded (controller dead, restart-only) until the upload
        // finished or timed out. This is emulator-only because only the native path
        // syncs saves. Tracing each phase so a hang here is pinpointed in retrom.log.
        info!("Game {game_id} teardown: reclaiming foreground");
        app.launcher().foreground_main_window();

        // Always mark the game as stopped, even if a teardown step above errored,
        // so a failed teardown can never leave Retrom wedged believing a game is
        // running.
        info!("Game {game_id} teardown: marking stopped");
        if let Err(why) = app.launcher().mark_game_as_stopped(game_id).await {
            warn!("Failed to mark game {game_id} as stopped: {why}");
        }

        info!("Game {game_id} teardown: syncing saves");
        sync_saves().await;
        info!("Game {game_id} teardown: complete");

        Ok(())
    }
}
