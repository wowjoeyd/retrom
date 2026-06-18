//! Bring a window to the OS foreground, like a game launching into fullscreen.
//! Centralized here so the app's `request_foreground` command (entering
//! fullscreen), the launcher's return-to-library (foregrounding the main window
//! when a game exits), and foregrounding a freshly-launched game window all share
//! a single implementation.

use tauri::{Runtime, WebviewWindow};

/// Bring the window identified by a raw HWND (as an `isize`) to the foreground.
///
/// On Windows a background process can't simply call `SetForegroundWindow` (the
/// OS foreground lock ignores it and at most flashes the taskbar). Temporarily
/// attaching our input thread to the current foreground window's thread lifts
/// that restriction long enough to legitimately take focus — the same approach
/// used by launchers and window managers. This does NOT pin the window
/// always-on-top, so other windows can still be brought forward normally
/// afterwards.
///
/// Taking the handle as an `isize` keeps it `Send`, so callers can resolve a
/// window on a worker thread and hop to the main thread to raise it.
#[cfg(windows)]
pub(crate) fn raise_hwnd(hwnd: isize) {
    use std::ptr;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let hwnd = hwnd as HWND;

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground == hwnd {
            return;
        }

        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }

        let current_thread = GetCurrentThreadId();
        let foreground_thread = GetWindowThreadProcessId(foreground, ptr::null_mut());

        let attached = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, 1) != 0;

        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);

        if attached {
            AttachThreadInput(current_thread, foreground_thread, 0);
        }
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

    raise_hwnd(hwnd);
}

/// macOS/Linux don't impose Windows' foreground-stealing restriction, so a plain
/// focus request is enough to raise the window.
#[cfg(not(windows))]
pub fn bring_to_foreground<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(why) = window.set_focus() {
        tracing::warn!("bring_to_foreground: failed to focus window: {why}");
    }
}
