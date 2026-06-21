//! Quit-to-library controller hotkey (Windows).
//!
//! While a game is running, holding a deliberate button combo — LB + RB + Menu —
//! for ~1.5s kills the game and returns to Big Picture, reusing the existing
//! `stop_game` + foreground-on-exit path. Detection lives in the native XInput
//! reader (see [`crate::gamepad`]) because the main window may be unfocused or
//! throttled while a game owns the foreground, whereas the native reader runs
//! regardless of focus. This is especially valuable for emulators that have no
//! in-game "quit".
//!
//! A separate, display-only `quit-indicator` window shows the hold progress over
//! the game (created at plugin setup; see [`crate::lib`]). It NEVER takes focus
//! or input — it's transparent and click-through — so it sidesteps all the
//! focus/bleed-through problems of an interactive over-the-game overlay.
//!
//! NOTE: the indicator only composites over borderless/windowed games. Over an
//! exclusive-fullscreen game it may not appear, but the quit action still WORKS
//! because the hold is detected here in Rust regardless of what's on screen.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tracing::{info, warn};

use crate::LauncherExt;

/// Window label of the display-only hold-to-quit indicator.
pub(crate) const INDICATOR_LABEL: &str = "quit-indicator";

/// How long the combo must be held continuously to trigger the quit.
const HOLD_DURATION: Duration = Duration::from_millis(1500);

/// How long the indicator lingers (flashing "complete") after a successful hold
/// before we hide it and tear down the game.
const CONFIRM_FLASH: Duration = Duration::from_millis(350);

/// The default combo, as W3C standard-gamepad button indices: LB + RB +
/// Menu(Start). Bumpers + Menu held together is reported reliably by XInput
/// (unlike the Guide button, which Game Bar masks/claims) and is very unlikely
/// to be triggered by accident during normal play. Used when the user hasn't
/// rebound the combo (see [`configured_combo`]).
pub(crate) const COMBO: [usize; 3] = [4, 5, 9];

/// Fewest buttons a custom combo may have. A rebind with fewer than this is
/// ignored in favor of the default, so a single stray button can never quit a
/// game (the frontend enforces the same floor when capturing — see the settings
/// menus). The held-duration requirement is the other half of that protection.
pub(crate) const MIN_COMBO_BUTTONS: usize = 2;

/// The user-configured quit combo (W3C standard-gamepad button indices), or the
/// built-in [`COMBO`] when unset/too short/invalid. Read off the config the same
/// way the enable toggle is, so a save in settings is visible immediately; the
/// gamepad reader refreshes this once per game session (see [`crate::gamepad`]).
pub(crate) fn configured_combo<R: Runtime>(app: &AppHandle<R>) -> Vec<usize> {
    use retrom_plugin_config::ConfigExt;

    let configured: Vec<usize> = app
        .config_manager()
        .get_config_off_runtime()
        .config
        .and_then(|c| c.interface)
        .map(|i| i.quit_to_library_hotkey_buttons)
        .unwrap_or_default()
        .into_iter()
        .map(|b| b as usize)
        // Drop anything outside the standard-mapping range so a malformed config
        // can't panic the indexing in `combo_pressed`.
        .filter(|&b| b < crate::gamepad::BUTTON_COUNT)
        .collect();

    if configured.len() >= MIN_COMBO_BUTTONS {
        configured
    } else {
        COMBO.to_vec()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HoldStart {
    duration_ms: u64,
    /// The active combo (standard-gamepad button indices) so the indicator
    /// renders the buttons actually bound, not the hardcoded default.
    buttons: Vec<u32>,
}

/// Create the display-only hold-to-quit indicator window: transparent,
/// undecorated, always-on-top, skip-taskbar, hidden, never focused, and
/// click-through. Created once at startup and reused (shown/hidden as the combo
/// is held). Best-effort — if creation fails the quit hotkey still works, just
/// without the on-screen indicator.
pub(crate) fn create_indicator_window<R: Runtime>(app: &AppHandle<R>) {
    if app.get_webview_window(INDICATOR_LABEL).is_some() {
        return;
    }

    let window = match WebviewWindowBuilder::new(
        app,
        INDICATOR_LABEL,
        WebviewUrl::App("index.html?window=quit-indicator".into()),
    )
    .title("Retrom")
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .resizable(false)
    .focused(false)
    .visible(false)
    .build()
    {
        Ok(window) => window,
        Err(why) => {
            warn!("Failed to create quit-to-library indicator window: {why}");
            return;
        }
    };

    // Click-through: never intercept mouse events (WS_EX_TRANSPARENT|WS_EX_LAYERED).
    if let Err(why) = window.set_ignore_cursor_events(true) {
        warn!("Failed to make quit indicator click-through: {why}");
    }

    // Also mark it WS_EX_NOACTIVATE (so showing it never steals focus from the
    // game, even via ShowWindow) and WS_EX_TOOLWINDOW (keep it out of Alt-Tab).
    if let Ok(handle) = window.hwnd() {
        set_overlay_ex_styles(handle.0 as isize);
    }
}

fn set_overlay_ex_styles(hwnd: isize) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    };

    unsafe {
        let hwnd = hwnd as HWND;
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
            hwnd,
            GWL_EXSTYLE,
            current | (WS_EX_NOACTIVATE as isize) | (WS_EX_TOOLWINDOW as isize),
        );
    }
}

/// Tracks the quit-combo hold across poll ticks. Owned by the gamepad reader and
/// driven once per poll via [`Self::poll`].
#[derive(Default)]
pub(crate) struct QuitHoldDetector {
    /// When the current hold began, if the combo is currently down.
    held_since: Option<Instant>,
    /// Whether the hotkey was enabled when this hold began. Cached so the config
    /// is read only once per hold (on the rising edge), not every poll.
    enabled: bool,
    /// Whether the confirm has already fired for the current hold (so a held
    /// combo can't re-trigger it every tick).
    confirmed: bool,
}

impl QuitHoldDetector {
    /// Drive the state machine for one poll tick.
    ///
    /// `combo_down` — whether any connected pad currently holds the full combo.
    /// `game_active` — whether a game session is currently running.
    /// `combo` — the active combo's button indices, forwarded to the indicator
    /// so it shows the buttons actually bound.
    pub(crate) fn poll<R: Runtime>(
        &mut self,
        app: &AppHandle<R>,
        combo_down: bool,
        game_active: bool,
        combo: &[usize],
        now: Instant,
    ) {
        let active = combo_down && game_active;

        if active {
            match self.held_since {
                None => {
                    // Rising edge: read the toggle once, and only arm (show the
                    // indicator + emit) if the hotkey is enabled.
                    self.held_since = Some(now);
                    self.confirmed = false;
                    self.enabled = hotkey_enabled(app);

                    if self.enabled {
                        show_indicator(app);
                        let _ = app.emit(
                            "quit-hold:start",
                            HoldStart {
                                duration_ms: HOLD_DURATION.as_millis() as u64,
                                buttons: combo.iter().map(|&b| b as u32).collect(),
                            },
                        );
                    }
                }
                Some(started) => {
                    if self.enabled
                        && !self.confirmed
                        && now.duration_since(started) >= HOLD_DURATION
                    {
                        self.confirmed = true;
                        info!("Quit-to-library combo held to completion; quitting");
                        let _ = app.emit("quit-hold:confirm", ());
                        confirm_quit(app);
                    }
                }
            }
        } else if self.held_since.take().is_some() {
            // Released early (or the game ended) — cancel the in-progress hold,
            // unless we already confirmed (then the teardown owns the indicator).
            if self.enabled && !self.confirmed {
                let _ = app.emit("quit-hold:cancel", ());
                hide_indicator(app);
            }
            self.confirmed = false;
        }
    }
}

/// Whether the quit-to-library hotkey is enabled in the shared interface config.
/// Absent is treated as enabled (default on).
fn hotkey_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    use retrom_plugin_config::ConfigExt;

    app.config_manager()
        .get_config_off_runtime()
        .config
        .and_then(|c| c.interface)
        .and_then(|i| i.quit_to_library_hotkey_enabled)
        .unwrap_or(true)
}

/// Show the indicator over the monitor the game is on, WITHOUT activating it, so
/// it never steals focus/input from the running game. No-op if the window
/// doesn't exist (it's still created best-effort at startup).
fn show_indicator<R: Runtime>(app: &AppHandle<R>) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW,
    };

    let Some(win) = app.get_webview_window(INDICATOR_LABEL) else {
        return;
    };
    let Ok(handle) = win.hwnd() else {
        return;
    };
    let ind_hwnd = handle.0 as isize;

    // The game currently holds the foreground, so its window resolves the right
    // monitor. If we can't resolve one, show at the window's current geometry.
    let fg = unsafe { GetForegroundWindow() } as isize;
    let rect = crate::window::monitor_rect_for_window(fg);

    unsafe {
        let (x, y, w, h, flags) = match rect {
            Some((x, y, w, h)) => (x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW),
            None => (
                0,
                0,
                0,
                0,
                SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOMOVE | SWP_NOSIZE,
            ),
        };

        SetWindowPos(ind_hwnd as HWND, HWND_TOPMOST, x, y, w, h, flags);
    }
}

/// Hide the indicator via a raw `ShowWindow(SW_HIDE)`. We deliberately bypass
/// `WebviewWindow::hide()`: because we SHOW the window with a raw `SetWindowPos`
/// (for monitor placement + no-activate), Tauri's tracked visibility state never
/// flips to "shown", so its `hide()` can no-op and leave the popup stuck on
/// screen. `SW_HIDE` doesn't activate anything, so it's safe from any thread.
fn hide_indicator<R: Runtime>(app: &AppHandle<R>) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};

    if let Some(win) = app.get_webview_window(INDICATOR_LABEL) {
        if let Ok(handle) = win.hwnd() {
            unsafe {
                ShowWindow(handle.0 as HWND, SW_HIDE);
            }
        }
    }
}

/// Tear down the running game(s) and return to the library. Spawned onto the
/// async runtime since the detector runs on the (sync) gamepad thread.
fn confirm_quit<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        // Let the indicator flash "complete" briefly before we tear down.
        tokio::time::sleep(CONFIRM_FLASH).await;
        hide_indicator(&app);

        let launcher = app.launcher();
        let ids: Vec<i32> = launcher
            .child_processes
            .read()
            .await
            .keys()
            .copied()
            .collect();

        if ids.is_empty() {
            // Nothing tracked (e.g. an exclusive-fullscreen game we couldn't
            // register) — at least bring Retrom back to the foreground.
            launcher.foreground_main_window();
            return;
        }

        // stop_game reuses each adapter's own teardown (kill + foreground-on-exit
        // for native, kill-by-install-dir for Steam, close-window for WASM).
        for id in ids {
            if let Err(why) = launcher.stop_game(id).await {
                warn!("Quit-to-library: failed to stop game {id}: {why}");
            }
        }
    });
}
