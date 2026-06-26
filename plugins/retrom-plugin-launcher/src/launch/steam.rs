//! Launches third-party (Steam) titles via the OS `steam://` handler.
//!
//! Steam runs the game in its own process that Retrom doesn't own, so there's no
//! child handle to wait on. Instead we watch the keys Steam maintains under
//! `HKCU\Software\Valve\Steam` to learn when the game starts and stops — a small
//! state machine (launch → wait-for-appear → wait-for-clear → stopped) that
//! gives Steam games playtime tracking and the same return-to-library behavior
//! as native games. Exit detection is currently Windows-only; on other
//! platforms the game still launches, just without tracking.

use async_trait::async_trait;
use retrom_plugin_steam::SteamExt;
use tauri::Runtime;

use super::{LaunchAdapter, LaunchContext};

pub(crate) struct SteamAdapter;

/// Extract a valid Steam AppID from the game, if it has one.
fn steam_app_id<R: Runtime>(ctx: &LaunchContext<R>) -> Option<u32> {
    ctx.game
        .steam_app_id
        .and_then(|app_id| u32::try_from(app_id).ok())
}

#[async_trait]
impl<R: Runtime> LaunchAdapter<R> for SteamAdapter {
    fn name(&self) -> &'static str {
        "steam"
    }

    fn matches(&self, ctx: &LaunchContext<R>) -> bool {
        ctx.game.third_party && steam_app_id(ctx).is_some()
    }

    async fn launch(&self, ctx: LaunchContext<R>) -> crate::Result<()> {
        // `matches` guarantees a valid app id is present.
        let app_id =
            steam_app_id(&ctx).expect("SteamAdapter launched without a valid Steam app id");
        let game_id = ctx.game.id;
        let remote_play_session_id = ctx.remote_play_session_id;

        // The install dir lets us identify the game's own process for precise exit
        // detection (Steam launches the game itself, so we never get its PID).
        #[cfg_attr(not(windows), allow(unused_variables))]
        let install_dir = {
            let steam = ctx
                .app
                .steam()
                .ok_or_else(|| crate::Error::InternalError("Steam is not initialized".into()))?;

            steam.launch_game(app_id).await?;
            steam.get_install_dir(app_id)
        };

        #[cfg(windows)]
        {
            let app = ctx.app.clone();
            tokio::spawn(async move {
                windows::watch(app, app_id, game_id, install_dir, remote_play_session_id).await
            });
        }

        #[cfg(not(windows))]
        {
            // Exit detection is Windows-only for now; the game still launched.
            let _ = (game_id, remote_play_session_id);
        }

        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use std::{sync::Arc, time::SystemTime};

    use tauri::{AppHandle, Runtime};
    use tokio::{
        sync::Mutex,
        time::{sleep, Duration, Instant},
    };
    use tracing::{info, warn};

    use crate::{desktop::GameProcess, LauncherExt};

    /// How often to poll while waiting for the game to start.
    const POLL_INTERVAL: Duration = Duration::from_secs(2);
    /// How often to poll while the game is running, watching for it to stop. Kept
    /// short so we react quickly and can grab the foreground back before Steam
    /// (which also grabs it on game close) fully settles in front.
    const STOP_POLL_INTERVAL: Duration = Duration::from_millis(500);
    /// How long to wait for the game to actually start before giving up — Steam
    /// can take a while (updates, "ready to play" prompts, first-run setup).
    const APPEAR_TIMEOUT: Duration = Duration::from_secs(120);

    /// Whether Steam currently reports the given app as running.
    ///
    /// Prefers the per-app `Running` flag and falls back to the global
    /// `RunningAppID`. Returns `None` if neither key could be read (e.g. Steam
    /// isn't installed), so callers can distinguish "not running" from "unknown".
    fn app_running(app_id: u32) -> Option<bool> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);

        if let Ok(key) = hkcu.open_subkey(format!("Software\\Valve\\Steam\\Apps\\{app_id}")) {
            if let Ok(running) = key.get_value::<u32, _>("Running") {
                return Some(running != 0);
            }
        }

        if let Ok(key) = hkcu.open_subkey("Software\\Valve\\Steam") {
            if let Ok(running_app_id) = key.get_value::<u32, _>("RunningAppID") {
                return Some(running_app_id == app_id);
            }
        }

        None
    }

    /// Drive a Steam game's lifecycle: wait for it to appear, register the
    /// session, wait for it to stop, then return the player to the library.
    pub(super) async fn watch<R: Runtime>(
        app: AppHandle<R>,
        app_id: u32,
        game_id: i32,
        install_dir: Option<std::path::PathBuf>,
        remote_play_session_id: Option<i32>,
    ) {
        // Wait for the game to actually start running. If it never does within the
        // timeout (e.g. the user cancelled at a Steam prompt), give up quietly —
        // no session was registered, so there's nothing to clean up and no bogus
        // playtime is recorded.
        let deadline = Instant::now() + APPEAR_TIMEOUT;
        loop {
            if app_running(app_id) == Some(true) {
                break;
            }

            if Instant::now() >= deadline {
                info!("Steam game {app_id} never reported running within the timeout; giving up");
                return;
            }

            sleep(POLL_INTERVAL).await;
        }

        info!("Steam game {app_id} is running");

        // Register the session now that it's actually running, so the UI reflects
        // play state and playtime is tracked from this point.
        let (send, mut recv) = tokio::sync::mpsc::channel(1);
        let send = Arc::new(Mutex::new(send));
        if let Err(why) = app
            .launcher()
            .mark_game_as_running(
                game_id,
                GameProcess {
                    send,
                    start_time: SystemTime::now(),
                },
            )
            .await
        {
            warn!("Failed to mark Steam game {game_id} as running: {why}");
            return;
        }

        // Remote-play session: the Steam game is now up, so PREPARING→RUNNING.
        if let Some(session_id) = remote_play_session_id {
            crate::remote_play::report_session_running(&app, session_id).await;
        }

        let stop_requested = wait_for_stop(app_id, install_dir.clone(), &mut recv).await;

        info!("Steam game {app_id} stopped; returning to library");

        // An explicit stop (UI stop button or the quit-to-library hotkey) means
        // the game is still running and must actually be killed. Steam runs it in
        // its own process, so there's no child handle — terminate it by install
        // dir. A natural exit skips this (the game's already gone).
        if stop_requested {
            if let Some(dir) = install_dir.as_deref() {
                crate::window::kill_pids_under_dir(dir);
            }
        }

        // Session-aware exit: a remote-play launch must not foreground the host's
        // own UI (the host is headless to the player) -- end the session instead.
        // The local Steam path (no session id) is unchanged.
        match crate::remote_play::exit_action(remote_play_session_id) {
            crate::remote_play::ExitAction::ForegroundLocalUi => {
                app.launcher().foreground_main_window();
            }
            crate::remote_play::ExitAction::EndSession(session_id) => {
                info!("Steam game {app_id} teardown: ending remote-play session {session_id} (no host foreground)");
                crate::remote_play::report_session_ended(&app, session_id).await;
            }
        }

        if let Err(why) = app.launcher().mark_game_as_stopped(game_id).await {
            warn!("Failed to mark Steam game {game_id} as stopped: {why}");
        }
    }

    /// Block until the game stops (or a UI/hotkey stop is requested). Returns
    /// `true` if the stop was explicitly requested (the game is still running and
    /// must be killed), `false` if the game exited on its own.
    ///
    /// Prefer watching the game's actual process (found via its install dir):
    /// `WaitForSingleObject` lets us react the *instant* it exits, which is what
    /// makes reclaiming the foreground work — emulators succeed for the same
    /// reason, whereas the slower registry poll fires only after Steam has already
    /// grabbed the foreground for itself. Falls back to the registry when the
    /// process can't be located.
    async fn wait_for_stop(
        app_id: u32,
        install_dir: Option<std::path::PathBuf>,
        recv: &mut tokio::sync::mpsc::Receiver<()>,
    ) -> bool {
        // Try to lock onto the game's process. Give it a few seconds to appear
        // under the install dir before falling back to registry polling.
        if let Some(dir) = install_dir {
            let appear_deadline = Instant::now() + Duration::from_secs(8);
            let mut pid = None;
            while Instant::now() < appear_deadline {
                pid = crate::window::pid_under_dir(&dir);
                if pid.is_some() {
                    break;
                }
                tokio::select! {
                    _ = recv.recv() => return true,
                    _ = sleep(Duration::from_millis(200)) => {}
                }
            }

            if pid.is_some() {
                // Wait on each game process instantly; when none remain, it's
                // stopped (some games re-exec into a child, so re-scan after each).
                loop {
                    let Some(pid) = crate::window::pid_under_dir(&dir) else {
                        break;
                    };

                    tokio::select! {
                        _ = recv.recv() => return true,
                        _ = tokio::task::spawn_blocking(move || {
                            crate::window::wait_for_pid_exit(pid)
                        }) => {}
                    }
                }
                return false;
            }
        }

        // Fallback: poll Steam's running flag.
        loop {
            if app_running(app_id) == Some(false) {
                return false;
            }

            tokio::select! {
                _ = recv.recv() => return true,
                _ = sleep(STOP_POLL_INTERVAL) => {}
            }
        }
    }
}
