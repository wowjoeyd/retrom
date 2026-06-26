use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use retrom_codegen::retrom::{GamePlayStatusUpdate, PlayStatus, UpdateGamePlaytimeRequest};
use retrom_plugin_service_client::RetromPluginServiceClientExt;
use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Emitter, Manager, Runtime};
use tokio::{
    process::Command,
    sync::{Mutex, RwLock},
};
use tracing::{info, instrument, warn};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Launcher<R>> {
    Ok(Launcher::new(app.clone()))
}

type GameId = i32;
pub struct GameProcess {
    pub send: Arc<Mutex<tokio::sync::mpsc::Sender<()>>>,
    pub start_time: std::time::SystemTime,
}

/// Access to the launcher APIs.
pub struct Launcher<R: Runtime> {
    app_handle: AppHandle<R>,
    pub child_processes: RwLock<HashMap<GameId, GameProcess>>,
    /// True while a game is running. The native gamepad reader (Windows) checks
    /// this so it stays out of the way during gameplay — otherwise it would keep
    /// forwarding the controller to Retrom's UI while the game (also reading the
    /// pad) is in the foreground.
    #[cfg_attr(not(windows), allow(dead_code))]
    game_active: Arc<AtomicBool>,
    /// True while the settings UI is capturing a new quit-to-library combo. The
    /// native gamepad reader (Windows) watches this and, while set, broadcasts
    /// the held button union so the UI can capture chords (incl. the Guide
    /// button the Gamepad API can't see). Toggled via `set_quit_rebind_active`.
    #[cfg_attr(not(windows), allow(dead_code))]
    rebind_active: Arc<AtomicBool>,
}

impl<R: Runtime> Launcher<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            app_handle,
            child_processes: RwLock::new(HashMap::new()),
            game_active: Arc::new(AtomicBool::new(false)),
            rebind_active: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Shared "a game is running" flag, for the native gamepad reader.
    #[cfg(windows)]
    pub(crate) fn game_active_flag(&self) -> Arc<AtomicBool> {
        self.game_active.clone()
    }

    /// Shared "settings is capturing a combo" flag, for the native gamepad reader.
    #[cfg(windows)]
    pub(crate) fn rebind_active_flag(&self) -> Arc<AtomicBool> {
        self.rebind_active.clone()
    }

    /// Toggle combo-capture mode (see [`Self::rebind_active_flag`]). Called by the
    /// `set_quit_rebind_active` command when the user starts/stops a rebind.
    pub fn set_rebind_active(&self, active: bool) {
        self.rebind_active.store(active, Ordering::SeqCst);
    }

    #[instrument(skip_all)]
    pub async fn is_game_running(&self, game_id: GameId) -> bool {
        self.child_processes.read().await.contains_key(&game_id)
    }

    /// Bring the main Big Picture window back to the OS foreground. Called when a
    /// game exits so the player lands straight back in the library, mirroring
    /// Steam Big Picture's return-to-library behavior.
    ///
    /// A game's window can linger for a moment after its process exits, during
    /// which the foreground steal is refused, so we retry a few times on a spaced
    /// schedule. Each reclaim attempt runs on the window's UI thread (required for
    /// the `AttachThreadInput` steal to work — see `raise_hwnd`); the waits between
    /// attempts run on this background task so the UI message pump stays free.
    pub fn foreground_main_window(&self) {
        let Some(window) = self.app_handle.get_webview_window("main") else {
            return;
        };

        #[cfg(windows)]
        {
            let hwnd = match window.hwnd() {
                Ok(handle) => handle.0 as isize,
                Err(why) => {
                    warn!("Failed to get main window handle to foreground: {why}");
                    return;
                }
            };

            std::thread::spawn(move || {
                use std::time::Duration;

                // Best-effort foreground reclaim — all an emulator needs (it wins
                // on the first attempt). `raise_hwnd` is hang-proof and returns
                // promptly, so run it directly on this worker thread: NEVER on the
                // UI thread, where its old AttachThreadInput steal could deadlock
                // against a non-pumping service window (GameInputServiceWindow) and
                // freeze Retrom. If the reclaim fails, native controller input
                // keeps the UI usable anyway.
                let mut won = false;
                for delay_ms in [0u64, 250, 600, 1200] {
                    if delay_ms > 0 {
                        std::thread::sleep(Duration::from_millis(delay_ms));
                    }

                    won = crate::foreground::raise_hwnd(hwnd);

                    // Also nudge the WebView2 *content* to take focus: the Gamepad
                    // API only delivers input to a focused document, so this lets it
                    // resume if we did regain the foreground (emulator case). It's a
                    // non-blocking dispatch and a no-op if content already has focus.
                    let webview: &tauri::Webview<R> = window.as_ref();
                    let _ = webview.set_focus();

                    if won {
                        break;
                    }
                }

                // If we couldn't reclaim the foreground, that's no longer fatal:
                // Windows can park it on a window we can't steal from (e.g.
                // GameInputServiceWindow after a controller game), but the native
                // gamepad reader forwards controller input to the UI regardless of
                // focus, so fullscreen navigation keeps working anyway.
                if !won {
                    warn!(
                        "Could not reclaim the OS foreground after a game exit \
                         (foreground now: {}); native controller input remains active",
                        crate::foreground::foreground_window_desc()
                    );
                }
            });
        }

        #[cfg(not(windows))]
        {
            if let Err(why) = window.set_focus() {
                warn!("Failed to focus main window on game exit: {why}");
            }
        }
    }

    /// Run an external process (e.g. Moonlight) and drive the same
    /// return-to-library lifecycle a native game uses: mark the game running,
    /// wait for the process to exit (or a stop signal), then reclaim the OS
    /// foreground and mark it stopped. This is the shared machinery that returns
    /// the user to Retrom fullscreen after an external process exits, so the
    /// Moonlight viewer flow reuses it instead of forking the native spawn +
    /// foreground-reclaim code.
    #[instrument(skip(self, command))]
    pub async fn run_foregrounding_process(
        &self,
        game_id: GameId,
        mut command: Command,
    ) -> crate::Result<()> {
        let (send, mut recv) = tokio::sync::mpsc::channel(1);
        let mut process = command.spawn()?;
        #[cfg(windows)]
        let pid = process.id();
        let send = Arc::new(Mutex::new(send));

        self.mark_game_as_running(
            game_id,
            GameProcess {
                send,
                start_time: std::time::SystemTime::now(),
            },
        )
        .await?;

        // Bring the new window forward (Windows blocks a background process from
        // taking the foreground), same as a native game launch.
        #[cfg(windows)]
        if let Some(pid) = pid {
            tokio::spawn(crate::window::foreground_game(self.app_handle.clone(), pid));
        }

        tokio::select! {
            _ = recv.recv() => {
                if let Err(why) = process.kill().await {
                    warn!("Failed to kill external process for game {game_id}: {why}");
                }
            }
            _ = process.wait() => {}
        }

        // Reclaim the foreground and mark stopped, returning to Retrom fullscreen.
        self.foreground_main_window();
        if let Err(why) = self.mark_game_as_stopped(game_id).await {
            warn!("Failed to mark game {game_id} as stopped: {why}");
        }

        Ok(())
    }

    #[instrument(skip_all)]
    pub async fn mark_game_as_running(
        &self,
        game_id: GameId,
        child: GameProcess,
    ) -> crate::Result<()> {
        let already_running = self.child_processes.write().await.insert(game_id, child);
        self.game_active.store(true, Ordering::SeqCst);

        info!("Marking game {game_id} as running");

        if already_running.is_some() {
            warn!("Game {game_id} is already running");
        }

        self.app_handle.emit(
            "game-running",
            GamePlayStatusUpdate {
                game_id,
                play_status: PlayStatus::Playing.into(),
            },
        )?;

        Ok(())
    }

    #[instrument(skip_all)]
    pub async fn mark_game_as_stopped(&self, game_id: GameId) -> crate::Result<()> {
        let mut processes = self.child_processes.write().await;
        let child = processes.remove(&game_id);
        // Only clear the "game running" flag once nothing else is still running.
        self.game_active
            .store(!processes.is_empty(), Ordering::SeqCst);
        drop(processes);

        info!("Marking game {game_id} as stopped");

        if child.is_none() {
            warn!("Game {game_id} is not running");
        }

        // Tell the UI the game stopped RIGHT AWAY — before the playtime RPC below.
        // `game_active` is already cleared (above), so emitting here hands the
        // controller back to the library (the frontend gamepad provider clears its
        // own running-game guard on this event) without waiting on a network call.
        self.app_handle.emit(
            "game-stopped",
            GamePlayStatusUpdate {
                game_id,
                play_status: PlayStatus::NotPlaying.into(),
            },
        )?;

        // Record only what a play session needs — minutes played + last-played —
        // via the narrow UpdateGamePlaytime RPC. Going through update_game_metadata
        // here would make the server wipe and re-cache ALL of the game's media and
        // re-extract its theme audio on every exit, which is pure waste for a
        // playtime bump. Done LAST so a slow/unreachable server can't delay the
        // controller hand-back above.
        if let Some(child) = child {
            let session_minutes = std::time::SystemTime::now()
                .duration_since(child.start_time)
                .ok()
                .map(|dur| dur.as_secs() / 60)
                .and_then(|mins| i32::try_from(mins).ok())
                .unwrap_or(0);

            info!("Game {game_id} played for {session_minutes} minutes");

            let mut metadata_client = self.app_handle.get_metadata_client().await;
            let request = tonic::Request::new(UpdateGamePlaytimeRequest {
                game_id,
                additional_minutes: session_minutes,
            });

            if let Err(why) = metadata_client.update_game_playtime(request).await {
                warn!("Failed to update game playtime: {:#?}", why);
            }
        }

        info!("Game {game_id} marked stopped");
        Ok(())
    }

    #[instrument(skip_all)]
    pub async fn stop_game(&self, game_id: GameId) -> crate::Result<()> {
        // Clone the stop-signal sender out from under the lock, then release the
        // child_processes read lock BEFORE sending. Holding that read lock across
        // the channel send (an await) can deadlock against mark_game_as_stopped's
        // write().await: a redundant/late stop whose bounded channel is already
        // full would block the send while still holding the read lock, and the
        // exit task — the channel's only consumer — would then wait forever for
        // the write lock (and, since it never clears game_active, the native
        // gamepad reader keeps suppressing input → the UI freezes, restart-only).
        let sender = {
            let processes = self.child_processes.read().await;
            processes.get(&game_id).map(|game| game.send.clone())
        };

        info!("Stopping game {game_id}");

        if let Some(sender) = sender {
            // One queued stop signal is all the teardown needs. If one is already
            // pending (channel full) or the game already exited (channel closed),
            // try_send drops it harmlessly instead of blocking — so a re-entrant
            // stop can never wedge the exit path.
            let _ = sender.lock().await.try_send(());

            info!("Game {game_id} stop signal sent");
        }

        Ok(())
    }

    fn prepare_command(&self, executable: std::path::PathBuf) -> Command {
        #[cfg(not(target_os = "windows"))]
        {
            let base_cmd = if cfg!(feature = "flatpak") {
                // Must use flatpak-spawn to launch host executables from within a Flatpak
                let mut cmd = Command::new("flatpak-spawn");
                cmd.arg("--host").arg(executable);
                cmd
            } else {
                Command::new(executable)
            };

            base_cmd
        }

        #[cfg(target_os = "windows")]
        {
            let mut base_cmd = Command::new(executable);

            // Don't show the console window
            base_cmd.creation_flags(0x08000000);

            base_cmd
        }
    }

    pub(crate) fn get_open_cmd(&self, program: impl Into<PathBuf>) -> Command {
        let program: PathBuf = program.into();

        #[cfg(target_os = "macos")]
        {
            let program = if program.extension().is_some_and(|ext| ext == "app") {
                program.join("Contents/MacOS/").join(
                    program
                        .file_stem()
                        .unwrap_or_else(|| panic!("Failed to get file stem for file: {program:?}")),
                )
            } else {
                program
            };

            self.prepare_command(program)
        }

        #[cfg(not(target_os = "macos"))]
        {
            self.prepare_command(program)
        }
    }
}
