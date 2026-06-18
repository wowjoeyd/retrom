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
    use std::{ptr, thread, time::Duration};
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        keybd_event, SetActiveWindow, SetFocus, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        AllowSetForegroundWindow, BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId,
        IsIconic, SetForegroundWindow, ShowWindow, ASFW_ANY, SW_RESTORE, SW_SHOW,
    };

    let hwnd = hwnd as HWND;

    // Port of the sequence AutoHotkey's WinActivate uses — the most reliable
    // non-injection way to take the foreground on Windows. Steam Big Picture
    // "just works" because it injects an overlay into games (an in-process hook
    // we can't replicate); short of that, this sequence is the proven approach.
    // Deliberately avoids SystemParametersInfo(SPIF_SENDCHANGE) (it broadcasts to
    // every window and can hang the UI thread) and a persistent minimize (it
    // suspends the webview).
    unsafe {
        if GetForegroundWindow() == hwnd {
            SetFocus(hwnd);
            return;
        }

        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        } else {
            ShowWindow(hwnd, SW_SHOW);
        }

        // Simple attempt first.
        SetForegroundWindow(hwnd);

        // If refused, attach our input thread to the current foreground thread
        // (so Windows treats us as sharing its input state) and retry a few times.
        if GetForegroundWindow() != hwnd {
            let current_thread = GetCurrentThreadId();
            let foreground_thread =
                GetWindowThreadProcessId(GetForegroundWindow(), ptr::null_mut());
            let attached = foreground_thread != 0
                && foreground_thread != current_thread
                && AttachThreadInput(current_thread, foreground_thread, 1) != 0;

            AllowSetForegroundWindow(ASFW_ANY);
            BringWindowToTop(hwnd);

            for _ in 0..5 {
                SetForegroundWindow(hwnd);
                if GetForegroundWindow() == hwnd {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }

            if attached {
                AttachThreadInput(current_thread, foreground_thread, 0);
            }
        }

        // Last resort: tapping Alt resets the foreground lock so the final
        // SetForegroundWindow is honored (also AutoHotkey's fallback).
        if GetForegroundWindow() != hwnd {
            keybd_event(VK_MENU as u8, 0, 0, 0);
            keybd_event(VK_MENU as u8, 0, KEYEVENTF_KEYUP, 0);
            SetForegroundWindow(hwnd);
        }

        SetActiveWindow(hwnd);
        SetFocus(hwnd);
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

    // Run the activation off the window's own UI thread. The sequence sleeps
    // briefly between attempts, and doing that on the UI thread blocks the very
    // message pump that has to process the activation — which is why running it
    // inline never took effect. AutoHotkey works for the same reason: it acts
    // from a separate thread.
    std::thread::spawn(move || raise_hwnd(hwnd));
}

/// macOS/Linux don't impose Windows' foreground-stealing restriction, so a plain
/// focus request is enough to raise the window.
#[cfg(not(windows))]
pub fn bring_to_foreground<R: Runtime>(window: &WebviewWindow<R>) {
    if let Err(why) = window.set_focus() {
        tracing::warn!("bring_to_foreground: failed to focus window: {why}");
    }
}
