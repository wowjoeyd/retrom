//! Find a freshly-launched game's top-level window and bring it to the
//! foreground (Windows only).
//!
//! When Retrom (fullscreen, holding the OS foreground) spawns a native emulator,
//! Windows' foreground lock keeps the new process from stealing focus — it opens
//! behind Retrom and only flashes in the taskbar. Since Retrom currently holds
//! the foreground it *can* legitimately hand it to the game, so we resolve the
//! game's window and raise it.
//!
//! The spawned process often has no top-level window for a moment (and emulators
//! frequently relaunch into a child process that owns the real window), so we
//! walk the spawned PID's descendant tree and poll for a visible, titled window.

use std::collections::HashSet;

use tauri::{AppHandle, Runtime};
use tokio::time::{sleep, Duration, Instant};

/// How often to poll for the game's window.
const POLL_INTERVAL: Duration = Duration::from_millis(300);
/// How long to keep looking before giving up (the game still launched; it just
/// won't be force-raised).
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(20);

/// Poll for the window owned by `pid` (or any descendant) and, once found, bring
/// it to the foreground on the main thread.
pub(crate) async fn foreground_game<R: Runtime>(app: AppHandle<R>, pid: u32) {
    let deadline = Instant::now() + RESOLVE_TIMEOUT;

    loop {
        if let Some(hwnd) = resolve_game_hwnd(pid) {
            if let Err(why) = app.run_on_main_thread(move || crate::foreground::raise_hwnd(hwnd)) {
                tracing::warn!("Failed to foreground game window for pid {pid}: {why}");
            }
            return;
        }

        if Instant::now() >= deadline {
            tracing::debug!("No window found for game pid {pid} to foreground");
            return;
        }

        sleep(POLL_INTERVAL).await;
    }
}

/// Find a visible, titled top-level window owned by `root_pid` or one of its
/// descendants. Returns the HWND as an `isize` (so it stays `Send`).
fn resolve_game_hwnd(root_pid: u32) -> Option<isize> {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    };

    struct EnumCtx {
        pids: *const HashSet<u32>,
        found: *mut Vec<isize>,
    }

    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let ctx = &*(lparam as *const EnumCtx);
        let pids = &*ctx.pids;
        let found = &mut *ctx.found;

        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);

        if pids.contains(&pid) && IsWindowVisible(hwnd) != 0 && GetWindowTextLengthW(hwnd) > 0 {
            found.push(hwnd as isize);
        }

        // TRUE: keep enumerating.
        1
    }

    let pids = descendant_pids(root_pid);
    let mut found: Vec<isize> = Vec::new();
    let mut ctx = EnumCtx {
        pids: &pids,
        found: &mut found,
    };

    unsafe {
        EnumWindows(Some(enum_cb), &mut ctx as *mut EnumCtx as LPARAM);
    }

    found.into_iter().next()
}

/// Collect `root` and every descendant process of it, via a process snapshot.
fn descendant_pids(root: u32) -> HashSet<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut result = HashSet::new();
    result.insert(root);

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return result;
    }

    // Snapshot every (pid, parent) pair first, then expand from the root.
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

    if unsafe { Process32FirstW(snapshot, &mut entry) } != 0 {
        loop {
            pairs.push((entry.th32ProcessID, entry.th32ParentProcessID));
            if unsafe { Process32NextW(snapshot, &mut entry) } == 0 {
                break;
            }
        }
    }

    unsafe {
        CloseHandle(snapshot);
    }

    // Repeatedly pull in any process whose parent is already in the set. Bounded
    // by the number of processes; `insert` returning false stops cycles.
    let mut changed = true;
    while changed {
        changed = false;
        for &(pid, parent) in &pairs {
            if result.contains(&parent) && result.insert(pid) {
                changed = true;
            }
        }
    }

    result
}
