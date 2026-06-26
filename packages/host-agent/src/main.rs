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
    match std::env::args().nth(1).as_deref() {
        Some(RUN_PENDING_SESSION) => forward_run_pending_session(),
        #[cfg(feature = "dev")]
        Some("create-test-session") => dev::create_test_session(),
        _ => {
            eprintln!("retrom-host-agent: usage: retrom-host-agent {RUN_PENDING_SESSION}");
            std::process::exit(2);
        }
    }
}

/// Relaunch the running Retrom client with the run-pending-session argument; the
/// single-instance plugin forwards it to the running instance and this copy exits.
fn forward_run_pending_session() {
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

/// Dev-only helper (built with `--features dev`): create a pending Remote Play
/// session via the CreateSession RPC and print its id, so the host side can be
/// tested in two commands (`create-test-session`, then Sunshine/Moonlight or a
/// manual `run-pending-session`). NOT for production use.
#[cfg(feature = "dev")]
mod dev {
    use retrom_codegen::retrom::{
        remote_play_service_client::RemotePlayServiceClient, CreateSessionRequest,
        NewRemotePlaySession, RemotePlaySessionState,
    };

    fn arg_value(args: &[String], flag: &str) -> Option<String> {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1).cloned())
    }

    pub fn create_test_session() {
        let args: Vec<String> = std::env::args().collect();
        let game_id = arg_value(&args, "--game").and_then(|v| v.parse::<i32>().ok());
        let host_id = arg_value(&args, "--host").and_then(|v| v.parse::<i32>().ok());

        let (Some(game_id), Some(host_client_id)) = (game_id, host_id) else {
            eprintln!(
                "usage: retrom-host-agent create-test-session --game <id> --host <id> \
                 [server url via RETROM_SERVER_URL]"
            );
            std::process::exit(2);
        };

        let server =
            std::env::var("RETROM_SERVER_URL").unwrap_or_else(|_| "http://localhost:5101".into());

        let runtime = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
        runtime.block_on(async move {
            let mut client = match RemotePlayServiceClient::connect(server.clone()).await {
                Ok(client) => client,
                Err(why) => {
                    eprintln!("create-test-session: could not connect to {server}: {why}");
                    std::process::exit(1);
                }
            };

            let response = client
                .create_session(CreateSessionRequest {
                    session: Some(NewRemotePlaySession {
                        game_id,
                        host_client_id,
                        // No real viewer in this dev helper; reuse the host id.
                        client_client_id: host_client_id,
                        state: RemotePlaySessionState::Requested as i32,
                        sunshine_app_name: "Retrom Remote Play".into(),
                        created_at: None,
                        updated_at: None,
                    }),
                })
                .await;

            match response.map(|r| r.into_inner().session) {
                Ok(Some(session)) => {
                    println!(
                        "created pending remote-play session id={} (game={}, host={})",
                        session.id, session.game_id, session.host_client_id
                    );
                }
                Ok(None) => {
                    eprintln!("create-test-session: CreateSession returned no session");
                    std::process::exit(1);
                }
                Err(status) => {
                    eprintln!("create-test-session: CreateSession failed: {status}");
                    std::process::exit(1);
                }
            }
        });
    }
}
