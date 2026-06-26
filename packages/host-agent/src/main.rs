//! `retrom-host-agent` — the thin Sunshine-invoked host agent.
//!
//! Sunshine runs `retrom-host-agent run-pending-session`. This binary does as
//! little as possible: it forwards the request to the already-running Retrom
//! client by launching the client with the `run-pending-session` argument. The
//! client runs single-instance (`tauri-plugin-single-instance`), so that argument
//! is forwarded to the running instance and this launched copy exits immediately.
//! The running client then drives the existing launcher in-process — the agent
//! itself never launches a game or talks to the server.

use std::process::Command;

const RUN_PENDING_SESSION: &str = "run-pending-session";

fn client_executable_name() -> &'static str {
    #[cfg(windows)]
    {
        "Retrom.exe"
    }
    #[cfg(not(windows))]
    {
        "Retrom"
    }
}

fn main() {
    let subcommand = std::env::args().nth(1);
    if subcommand.as_deref() != Some(RUN_PENDING_SESSION) {
        eprintln!("retrom-host-agent: usage: retrom-host-agent {RUN_PENDING_SESSION}");
        std::process::exit(2);
    }

    // The Retrom client lives next to this binary in the install directory.
    let client_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(client_executable_name())));

    let Some(client_exe) = client_exe else {
        eprintln!("retrom-host-agent: could not resolve the Retrom client executable path");
        std::process::exit(1);
    };

    // Launch the client with the run-pending-session argument. In Personal Host
    // Mode the client is already running, so single-instance forwards this to it
    // and the launched copy exits right away.
    match Command::new(&client_exe).arg(RUN_PENDING_SESSION).spawn() {
        Ok(_) => {}
        Err(why) => {
            eprintln!(
                "retrom-host-agent: failed to launch the Retrom client at {client_exe:?}: {why}"
            );
            std::process::exit(1);
        }
    }
}
