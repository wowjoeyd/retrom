//! Read Xbox/XInput controllers natively and forward their input to the UI.
//!
//! The WebView2 Gamepad API only delivers input to a *focused* document. After a
//! game exits, a window we cannot steal the foreground from (e.g. Win11's
//! `GameInputServiceWindow`) can hold it while Retrom is still visible, which
//! freezes the Gamepad API and leaves the controller dead in the fullscreen UI.
//! Native launchers (Playnite, LaunchBox) don't hit this because they read the
//! controller through XInput, which is unaffected by window focus. We do the
//! same: poll XInput on a background thread, do edge-detection and key-repeat
//! here, and emit events the frontend re-dispatches into its existing input
//! system — but only while our window is NOT the foreground, so the normal
//! focused path (driven by the Gamepad API) is left completely untouched.
//!
//! Button indices and axes follow the W3C "standard gamepad" mapping so the
//! frontend can treat these exactly like Gamepad-API input.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tracing::info;
use windows_sys::Win32::UI::Input::XboxController::XINPUT_STATE;
use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// How often to poll the controller. ~60 Hz, matching the frontend's rAF poll.
const POLL_INTERVAL: Duration = Duration::from_millis(16);

// Key-repeat timing — mirrors the frontend GamepadProvider so held-direction
// behavior feels identical whether input comes from the Gamepad API or here.
const REPEAT_START_DELAY: Duration = Duration::from_millis(300);
const REPEAT_START_INTERVAL: Duration = Duration::from_millis(190);
const REPEAT_MIN_INTERVAL: Duration = Duration::from_millis(60);
const REPEAT_ACCELERATION: Duration = Duration::from_millis(18);

const BUTTON_COUNT: usize = 17;
/// D-pad button indices (standard mapping) — these key-repeat while held.
const DPAD: [usize; 4] = [12, 13, 14, 15];
/// Left-stick axes (standard mapping) — these drive navigation and key-repeat.
const NAV_AXES: [usize; 2] = [0, 1];
const NAV_AXIS_THRESHOLD: f32 = 0.5;
const AXIS_THRESHOLD: f32 = 0.1;
/// Analog trigger value (0-255) above which we treat the trigger as a button.
const TRIGGER_THRESHOLD: u8 = 30;

/// XInput reports Xbox-style controllers; the "xbox" substring lets the frontend
/// pick Xbox button glyphs (`getControllerMapping`).
const PAD_ID: &str = "Xbox Controller (XInput STANDARD GAMEPAD)";

/// One forwarded input event, shaped so the frontend can build a synthetic
/// `Gamepad` (with live button/axis state) and re-dispatch the matching event.
#[derive(Clone, Serialize)]
struct InputEvent {
    index: u32,
    id: &'static str,
    /// "button-down" | "button-up" | "axis-active" | "axis-inactive"
    event: &'static str,
    button: i32,
    axis: i32,
    value: f32,
    repeat: bool,
    buttons: [bool; BUTTON_COUNT],
    axes: [f32; 4],
}

#[derive(Clone, Copy)]
struct Repeat {
    started: Instant,
    last_fired: Instant,
    count: u32,
}

#[derive(Default, Clone)]
struct PadState {
    connected: bool,
    buttons: [bool; BUTTON_COUNT],
    /// Per-axis state: -1 negative, 0 neutral, 1 positive.
    axis_state: [i8; 4],
    btn_repeat: [Option<Repeat>; BUTTON_COUNT],
    axis_repeat: [Option<Repeat>; 4],
}

type XInputGetStateFn = unsafe extern "system" fn(u32, *mut XINPUT_STATE) -> u32;

/// Statically-linked `XInputGetState` (no Guide button) used as a fallback.
unsafe extern "system" fn xinput_get_state_basic(index: u32, state: *mut XINPUT_STATE) -> u32 {
    windows_sys::Win32::UI::Input::XboxController::XInputGetState(index, state)
}

/// Prefer `XInputGetStateEx` (ordinal 100) — identical signature but it reports
/// the Guide button (0x0400), which the frontend maps to MENU. Fall back to the
/// plain `XInputGetState` if it can't be resolved (Guide just won't be reported).
fn resolve_get_state() -> XInputGetStateFn {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    for name in ["xinput1_4.dll\0", "xinput1_3.dll\0"] {
        let wide: Vec<u16> = name.encode_utf16().collect();
        let module = unsafe { LoadLibraryW(wide.as_ptr()) };
        if module.is_null() {
            continue;
        }

        // Ordinal 100 == XInputGetStateEx (MAKEINTRESOURCE(100)).
        let proc = unsafe { GetProcAddress(module, 100 as *const u8) };
        if let Some(proc) = proc {
            return unsafe {
                std::mem::transmute::<unsafe extern "system" fn() -> isize, XInputGetStateFn>(proc)
            };
        }
    }

    xinput_get_state_basic
}

fn norm(v: i16) -> f32 {
    (v as f32 / 32767.0).clamp(-1.0, 1.0)
}

/// Map a raw XInput state to standard-mapping buttons + axes.
fn map_state(state: &XINPUT_STATE) -> ([bool; BUTTON_COUNT], [f32; 4]) {
    let gp = &state.Gamepad;
    let wb = gp.wButtons;

    let mut b = [false; BUTTON_COUNT];
    b[0] = wb & 0x1000 != 0; // A
    b[1] = wb & 0x2000 != 0; // B
    b[2] = wb & 0x4000 != 0; // X
    b[3] = wb & 0x8000 != 0; // Y
    b[4] = wb & 0x0100 != 0; // Left shoulder
    b[5] = wb & 0x0200 != 0; // Right shoulder
    b[6] = gp.bLeftTrigger > TRIGGER_THRESHOLD; // Left trigger
    b[7] = gp.bRightTrigger > TRIGGER_THRESHOLD; // Right trigger
    b[8] = wb & 0x0020 != 0; // Back / View
    b[9] = wb & 0x0010 != 0; // Start / Menu
    b[10] = wb & 0x0040 != 0; // Left thumb
    b[11] = wb & 0x0080 != 0; // Right thumb
    b[12] = wb & 0x0001 != 0; // D-pad up
    b[13] = wb & 0x0002 != 0; // D-pad down
    b[14] = wb & 0x0004 != 0; // D-pad left
    b[15] = wb & 0x0008 != 0; // D-pad right
    b[16] = wb & 0x0400 != 0; // Guide (only via XInputGetStateEx)

    // Standard mapping has +Y downward, XInput has +Y up — so negate Y.
    let axes = [
        norm(gp.sThumbLX),
        -norm(gp.sThumbLY),
        norm(gp.sThumbRX),
        -norm(gp.sThumbRY),
    ];

    (b, axes)
}

fn axis_state(value: f32, threshold: f32) -> i8 {
    if value > threshold {
        1
    } else if value < -threshold {
        -1
    } else {
        0
    }
}

/// Returns whether a repeat should fire now, advancing the repeat clock if so.
fn should_repeat(repeat: &mut Repeat, now: Instant) -> bool {
    if now.duration_since(repeat.started) < REPEAT_START_DELAY {
        return false;
    }

    let interval = REPEAT_START_INTERVAL
        .saturating_sub(REPEAT_ACCELERATION * repeat.count)
        .max(REPEAT_MIN_INTERVAL);

    if now.duration_since(repeat.last_fired) < interval {
        return false;
    }

    repeat.last_fired = now;
    repeat.count += 1;
    true
}

/// Start the native controller reader. Polls until the app exits.
pub fn spawn<R: Runtime>(app: AppHandle<R>, game_active: Arc<AtomicBool>) {
    std::thread::spawn(move || run(app, game_active));
}

fn run<R: Runtime>(app: AppHandle<R>, game_active: Arc<AtomicBool>) {
    // The main window may not exist yet at plugin-setup time, so wait for it.
    let mut main_hwnd = 0isize;
    for _ in 0..100 {
        if let Some(hwnd) = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
        {
            main_hwnd = hwnd;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    let get_state = resolve_get_state();
    let mut pads: [PadState; 4] = Default::default();

    info!("Native gamepad reader started (main_hwnd=0x{main_hwnd:x})");

    loop {
        // Forward to the UI only when BOTH:
        //   - no game is running — during gameplay the game (which reads the pad
        //     itself) is foreground and Retrom must stay out of the way; and
        //   - our window is NOT the foreground — when it is, the WebView2 Gamepad
        //     API is live and handles input, so forwarding too would double every
        //     press.
        // i.e. forward exactly in the stuck state: back at the library, but a
        // window we can't take focus from (e.g. GameInputServiceWindow) holds it.
        let foreground =
            main_hwnd != 0 && unsafe { GetForegroundWindow() } as isize == main_hwnd;
        let forward = !game_active.load(Ordering::Relaxed) && !foreground;

        let now = Instant::now();
        for i in 0..4u32 {
            poll_pad(&app, get_state, i, &mut pads[i as usize], now, forward);
        }

        std::thread::sleep(POLL_INTERVAL);
    }
}

fn poll_pad<R: Runtime>(
    app: &AppHandle<R>,
    get_state: XInputGetStateFn,
    index: u32,
    pad: &mut PadState,
    now: Instant,
    forward: bool,
) {
    let mut state: XINPUT_STATE = unsafe { std::mem::zeroed() };
    // XInputGetState returns ERROR_SUCCESS (0) when the controller is present.
    let connected = unsafe { get_state(index, &mut state) } == 0;

    if !connected {
        if pad.connected {
            *pad = PadState::default();
        }
        return;
    }

    let (buttons, axes) = map_state(&state);

    // Not forwarding (focused, or a game is running): keep the baseline current so
    // the first forwarded poll doesn't replay stale edges, and emit nothing.
    if !forward {
        pad.connected = true;
        pad.buttons = buttons;
        for a in 0..4 {
            let threshold = if NAV_AXES.contains(&a) {
                NAV_AXIS_THRESHOLD
            } else {
                AXIS_THRESHOLD
            };
            pad.axis_state[a] = axis_state(axes[a], threshold);
        }
        pad.btn_repeat = Default::default();
        pad.axis_repeat = Default::default();
        return;
    }

    pad.connected = true;
    let emit = |event: &'static str, button: i32, axis: i32, value: f32, repeat: bool| {
        let _ = app.emit(
            "native-gamepad-input",
            InputEvent {
                index,
                id: PAD_ID,
                event,
                button,
                axis,
                value,
                repeat,
                buttons,
                axes,
            },
        );
    };

    // Buttons (with key-repeat for the D-pad).
    for b in 0..BUTTON_COUNT {
        let now_pressed = buttons[b];
        let was_pressed = pad.buttons[b];

        if now_pressed != was_pressed {
            if now_pressed {
                emit("button-down", b as i32, -1, 0.0, false);
                if DPAD.contains(&b) {
                    pad.btn_repeat[b] = Some(Repeat {
                        started: now,
                        last_fired: now,
                        count: 0,
                    });
                }
            } else {
                pad.btn_repeat[b] = None;
                emit("button-up", b as i32, -1, 0.0, false);
            }
        } else if now_pressed && DPAD.contains(&b) {
            if let Some(repeat) = pad.btn_repeat[b].as_mut() {
                if should_repeat(repeat, now) {
                    emit("button-down", b as i32, -1, 0.0, true);
                }
            }
        }
    }
    pad.buttons = buttons;

    // Axes (with key-repeat for the left stick).
    for a in 0..4 {
        let value = axes[a];
        let is_nav = NAV_AXES.contains(&a);
        let threshold = if is_nav {
            NAV_AXIS_THRESHOLD
        } else {
            AXIS_THRESHOLD
        };
        let now_state = axis_state(value, threshold);
        let was_state = pad.axis_state[a];

        if now_state != was_state {
            if is_nav && was_state != 0 {
                pad.axis_repeat[a] = None;
            }

            if now_state != 0 {
                emit("axis-active", -1, a as i32, value, false);
                if is_nav {
                    pad.axis_repeat[a] = Some(Repeat {
                        started: now,
                        last_fired: now,
                        count: 0,
                    });
                }
            } else {
                emit("axis-inactive", -1, a as i32, value, false);
            }
        } else if is_nav && now_state != 0 {
            if let Some(repeat) = pad.axis_repeat[a].as_mut() {
                if should_repeat(repeat, now) {
                    emit("axis-active", -1, a as i32, value, true);
                }
            }
        }

        pad.axis_state[a] = now_state;
    }
}
