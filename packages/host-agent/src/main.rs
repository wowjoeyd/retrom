//! `retrom-host-agent` — the Sunshine-invoked host agent.
//!
//! Sunshine runs `retrom-host-agent run-pending-session --host-id <id> --server <url>`.
//! The agent does two things:
//!
//! 1. Forwards the request to the already-running Retrom client by launching the
//!    client with `run-pending-session`. The client runs single-instance
//!    (`tauri-plugin-single-instance`), so that argument is forwarded to the running
//!    instance and this launched copy exits immediately; the running client then
//!    drives the existing launcher in-process to start the game.
//! 2. Stays alive until the brokered session for this host reaches a terminal state
//!    (ENDED/FAILED/CANCELLED), polling the RemotePlay broker. Sunshine ties the
//!    stream's lifetime to the command it launched (this agent), so the agent must
//!    outlive the game: otherwise Sunshine tears the stream down the moment the
//!    agent exits — right as the game appears. Watching the session keeps the stream
//!    up for the whole game and ends it cleanly when the game exits.
//!
//! Without `--host-id` (or `RETROM_REMOTE_PLAY_HOST_ID`) the agent can't find the
//! session and degrades to forward-and-exit (the game still launches).

use std::process::Command;
use std::time::Duration;

use retrom_codegen::retrom::{
    remote_play_service_client::RemotePlayServiceClient, GetPendingSessionForHostRequest,
    GetSessionRequest, RemotePlaySessionState,
};
use tonic::transport::Channel;

const RUN_PENDING_SESSION: &str = "run-pending-session";
const DEFAULT_SERVER_URL: &str = "http://localhost:5101";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

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

/// Read a `--flag value` pair from the argument list.
fn arg_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some(RUN_PENDING_SESSION) => forward_run_pending_session(&args),
        #[cfg(feature = "dev")]
        Some("create-test-session") => dev::create_test_session(),
        _ => {
            eprintln!(
                "retrom-host-agent: usage: retrom-host-agent {RUN_PENDING_SESSION} \
                 [--host-id <id>] [--server <url>]"
            );
            std::process::exit(2);
        }
    }
}

/// Forward the request to the running client, then stay alive until the session
/// ends so Sunshine keeps streaming for the whole game (see the module docs).
fn forward_run_pending_session(args: &[String]) {
    let host_id = arg_value(args, "--host-id")
        .or_else(|| std::env::var("RETROM_REMOTE_PLAY_HOST_ID").ok())
        .and_then(|v| v.parse::<i32>().ok());
    let server = arg_value(args, "--server")
        .or_else(|| std::env::var("RETROM_SERVER_URL").ok())
        .unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());

    let runtime = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");

    // Find the still-pending session BEFORE forwarding: GetPendingSessionForHost
    // only returns REQUESTED sessions, and the client claims (advances) it the
    // moment we forward, after which it would no longer be found.
    let tracked = host_id.and_then(|id| runtime.block_on(find_pending_session(&server, id)));

    forward_to_client();

    // Keep this process (Sunshine's tracked command) alive until the game ends.
    if let Some((session_id, mut client)) = tracked {
        runtime.block_on(wait_until_session_ends(&mut client, session_id));
    }
}

/// Relaunch the running Retrom client with `run-pending-session`; single-instance
/// forwards it to the running instance and the launched copy exits right away.
fn forward_to_client() {
    let client_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(client_executable_name())));

    let Some(client_exe) = client_exe else {
        eprintln!("retrom-host-agent: could not resolve the Retrom client executable path");
        std::process::exit(1);
    };

    if let Err(why) = Command::new(&client_exe).arg(RUN_PENDING_SESSION).spawn() {
        eprintln!("retrom-host-agent: failed to launch the Retrom client at {client_exe:?}: {why}");
        std::process::exit(1);
    }
}

/// Connect to the broker and return the REQUESTED session for this host (with a few
/// quick retries to cover any tiny ordering gap), plus the connection to reuse for
/// polling. `None` if the broker is unreachable or there's no pending session.
async fn find_pending_session(
    server: &str,
    host_id: i32,
) -> Option<(i32, RemotePlayServiceClient<Channel>)> {
    let mut client = connect(server).await?;

    for _ in 0..5 {
        match client
            .get_pending_session_for_host(GetPendingSessionForHostRequest {
                host_client_id: host_id,
            })
            .await
        {
            Ok(response) => {
                if let Some(session) = response.into_inner().session {
                    return Some((session.id, client));
                }
            }
            Err(why) => {
                eprintln!("retrom-host-agent: could not query the pending session: {why}");
                return None;
            }
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    None
}

/// Poll the session until it reaches a terminal state (or the broker stays
/// unreachable), then return so the process exits and Sunshine ends the stream.
async fn wait_until_session_ends(client: &mut RemotePlayServiceClient<Channel>, session_id: i32) {
    let mut consecutive_errors = 0;
    loop {
        tokio::time::sleep(POLL_INTERVAL).await;

        match client
            .get_session(GetSessionRequest { id: session_id })
            .await
        {
            Ok(response) => {
                consecutive_errors = 0;
                match response.into_inner().session {
                    Some(session) => {
                        let state = RemotePlaySessionState::try_from(session.state)
                            .unwrap_or(RemotePlaySessionState::Requested);
                        if is_terminal(state) {
                            return;
                        }
                    }
                    // Session vanished; nothing left to wait for.
                    None => return,
                }
            }
            Err(why) => {
                consecutive_errors += 1;
                eprintln!("retrom-host-agent: polling session {session_id} failed: {why}");
                // Give up rather than hang forever if the broker stays unreachable.
                if consecutive_errors >= 5 {
                    return;
                }
            }
        }
    }
}

/// A session state it never leaves — the game is done.
fn is_terminal(state: RemotePlaySessionState) -> bool {
    matches!(
        state,
        RemotePlaySessionState::Ended
            | RemotePlaySessionState::Failed
            | RemotePlaySessionState::Cancelled
    )
}

/// Connect a RemotePlay gRPC client with a bounded connect timeout.
async fn connect(server: &str) -> Option<RemotePlayServiceClient<Channel>> {
    let endpoint = match tonic::transport::Endpoint::from_shared(server.to_string()) {
        Ok(endpoint) => endpoint.connect_timeout(CONNECT_TIMEOUT),
        Err(why) => {
            eprintln!("retrom-host-agent: invalid server url {server:?}: {why}");
            return None;
        }
    };

    match endpoint.connect().await {
        Ok(channel) => Some(RemotePlayServiceClient::new(channel)),
        Err(why) => {
            eprintln!("retrom-host-agent: could not connect to {server}: {why}");
            None
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
