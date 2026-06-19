//! Bring a window to the OS foreground, like a game launching into fullscreen.
//! Centralized here so the app's `request_foreground` command (entering
//! fullscreen), the launcher's return-to-library (foregrounding the main window
//! when a game exits), and foregrounding a freshly-launched game window all share
//! a single implementation.

use tauri::{Runtime, WebviewWindow};

/// Best-effort request to bring the window identified by a raw HWND to the
/// foreground. Returns whether it actually became the foreground window.
///
/// This is intentionally simple and, above all, **hang-proof**: it does NOT use
/// `AttachThreadInput`. Attaching our input queue to whatever currently holds the
/// foreground can deadlock when that "window" is a non-pumping service window —
/// e.g. Win11's `GameInputServiceWindow`, which grabs the foreground after a
/// controller game exits. Doing that on the UI thread froze Retrom ("not
/// responding"). We don't need the foreground steal anymore: native controller
/// input (see `gamepad`) keeps the fullscreen UI usable even when this fails, so
/// reclaiming the foreground is now just a nicety (mainly so emulators visibly
/// return, and for keyboard/mouse focus).
///
/// We lower the foreground-lock timeout first (no `SPIF_SENDCHANGE`, so no
/// WM_SETTINGCHANGE broadcast) so a plain `SetForegroundWindow` has the best
/// chance of being honored when it legitimately can be. Every call here returns
/// promptly, so it's safe on any thread. Taking the handle as `isize` keeps it
/// `Send`.
#[cfg(windows)]
pub(crate) fn raise_hwnd(hwnd: isize) -> bool {
    use core::ffi::c_void;
    use std::ptr;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SetActiveWindow, SetFocus};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, SetForegroundWindow, ShowWindow, SystemParametersInfoW,
        SPI_GETFOREGROUNDLOCKTIMEOUT, SPI_SETFOREGROUNDLOCKTIMEOUT, SW_RESTORE, SW_SHOW,
    };

    let hwnd = hwnd as HWND;

    unsafe {
        if GetForegroundWindow() == hwnd {
            SetFocus(hwnd);
            return true;
        }

        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        } else {
            ShowWindow(hwnd, SW_SHOW);
        }

        // Lower the foreground-lock timeout so SetForegroundWindow isn't refused
        // outright, then restore it. No flags => no WM_SETTINGCHANGE broadcast.
        let mut prev_timeout: u32 = 0;
        let restore_timeout = SystemParametersInfoW(
            SPI_GETFOREGROUNDLOCKTIMEOUT,
            0,
            &mut prev_timeout as *mut u32 as *mut c_void,
            0,
        ) != 0;
        SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ptr::null_mut(), 0);

        SetForegroundWindow(hwnd);
        SetActiveWindow(hwnd);
        SetFocus(hwnd);

        if restore_timeout {
            SystemParametersInfoW(
                SPI_SETFOREGROUNDLOCKTIMEOUT,
                0,
                prev_timeout as usize as *mut c_void,
                0,
            );
        }

        GetForegroundWindow() == hwnd
    }
}

/// A short human-readable description of the current foreground window (handle,
/// owning pid, and window-class name) for diagnostics — so logs show exactly what
/// is holding the foreground when a reclaim is refused.
#[cfg(windows)]
pub(crate) fn foreground_window_desc() -> String {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
    };

    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return "<none>".to_string();
        }

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(fg, &mut pid);

        let mut buf = [0u16; 256];
        let len = GetClassNameW(fg, buf.as_mut_ptr(), buf.len() as i32);
        let class = if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            "<unknown>".to_string()
        };

        format!("hwnd={fg:?} pid={pid} class={class:?}")
    }
}

/// Bring the given Retrom window to the OS foreground.
#[cfg(windows)]
pub fn bring_to_foreground<R: Runtime>(window: &WebviewWindow<R>) {
    let hwnd = match window.hwnd() {
        Ok(handle) => handle.0 as isize,
        Err(why) => {
            tracing::warn!("bring_to_foreground: failed to get window handle: {why}");
            return;
        }
    };

    // Run the activation on the window's OWN UI thread (see `raise_hwnd`): the
    // AttachThreadInput foreground-steal trick only works from the thread that
    // owns the target window. `raise_hwnd` no longer sleeps, so it returns
    // promptly and the message pump stays free to process the activation.
    if let Err(why) = window.run_on_main_thread(move || {
        raise_hwnd(hwnd);
    }) {
        tracing::warn!("bring_to_foreground: failed to dispatch to main thread: {why}");
    }
}

/// macOS/Linux don't impose Windows' foreground-stealing restriction, so a plain
/// focus request is enough to raise the window.
#[cfg(not(windows))]
pub fn bring_to_foreground<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(why) = window.set_focus() {
        tracing::warn!("bring_to_foreground: failed to focus window: {why}");
    }
}
