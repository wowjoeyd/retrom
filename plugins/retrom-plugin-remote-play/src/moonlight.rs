//! Client/viewer-side Moonlight launching for Remote Play.
//!
//! Launches Moonlight straight into the host's managed "Retrom Remote Play"
//! Sunshine app (`moonlight stream <host> "<App Name>"`, see
//! `design/remote-play/04-moonlight.md`). Everything Moonlight-specific lives
//! behind the [`StreamLauncher`] trait so tests need no real Moonlight, and the
//! create-session/launch sequence is generic over the broker + stream boundaries.

use async_trait::async_trait;
use retrom_codegen::retrom::{
    CreateSessionRequest, NewRemotePlaySession, RemotePlaySession, RemotePlaySessionState,
};
use retrom_plugin_launcher::LauncherExt;
use retrom_plugin_service_client::RetromPluginServiceClientExt;
use tauri::{AppHandle, Runtime};

use crate::error::{Error, Result};

/// Flatpak application id for Moonlight on Linux / Steam Deck.
pub const MOONLIGHT_FLATPAK_ID: &str = "com.moonlight_stream.Moonlight";

/// How to invoke Moonlight on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoonlightInvocation {
    /// `flatpak run com.moonlight_stream.Moonlight ...`
    Flatpak,
    /// An explicit path, or a bare `moonlight`/`moonlight.exe` resolved on PATH.
    Executable(String),
}

/// Resolved Moonlight + host settings. From config/env, never hardcoded.
#[derive(Debug, Clone)]
pub struct MoonlightConfig {
    pub invocation: MoonlightInvocation,
    /// Host name/UUID/IP passed to `moonlight stream`.
    pub host: String,
}

fn default_moonlight_exe() -> &'static str {
    #[cfg(windows)]
    {
        "moonlight.exe"
    }
    #[cfg(not(windows))]
    {
        "moonlight"
    }
}

impl MoonlightConfig {
    /// Resolve from environment. `None` when the host isn't configured (v4 has one
    /// configured host -- no picker, that's Phase 5):
    /// `RETROM_REMOTE_PLAY_HOST` (required), `RETROM_MOONLIGHT_PATH` (explicit
    /// executable, overrides), `RETROM_MOONLIGHT_FLATPAK` (force the Flatpak id).
    pub fn from_env() -> Option<Self> {
        let host = std::env::var("RETROM_REMOTE_PLAY_HOST").ok()?;

        let invocation = if let Ok(path) = std::env::var("RETROM_MOONLIGHT_PATH") {
            MoonlightInvocation::Executable(path)
        } else if cfg!(target_os = "linux") || std::env::var("RETROM_MOONLIGHT_FLATPAK").is_ok() {
            MoonlightInvocation::Flatpak
        } else {
            MoonlightInvocation::Executable(default_moonlight_exe().to_string())
        };

        Some(Self { invocation, host })
    }
}

/// Build the Moonlight command (program + args) to stream `app_name` on the
/// configured host: `moonlight stream <host> "<App Name>"`. The app name is a
/// single argv element, so its space needs no shell quoting.
pub fn build_moonlight_command(config: &MoonlightConfig, app_name: &str) -> (String, Vec<String>) {
    match &config.invocation {
        MoonlightInvocation::Flatpak => (
            "flatpak".to_string(),
            vec![
                "run".to_string(),
                MOONLIGHT_FLATPAK_ID.to_string(),
                "stream".to_string(),
                config.host.clone(),
                app_name.to_string(),
            ],
        ),
        MoonlightInvocation::Executable(path) => (
            path.clone(),
            vec![
                "stream".to_string(),
                config.host.clone(),
                app_name.to_string(),
            ],
        ),
    }
}

/// Creates the brokered session (CreateSession RPC), abstracted for testing.
#[async_trait]
pub(crate) trait SessionCreator {
    async fn create_session(
        &self,
        game_id: i32,
        host_client_id: i32,
        client_client_id: i32,
        app_name: &str,
    ) -> Result<RemotePlaySession>;
}

/// Launches the stream client (Moonlight) and returns when it exits, abstracted
/// for testing.
#[async_trait]
pub(crate) trait StreamLauncher {
    /// Whether a Moonlight client can be found.
    async fn is_available(&self) -> bool;

    /// Launch Moonlight into `app_name` and return when it exits.
    async fn launch_stream(&self, app_name: &str, game_id: i32) -> Result<()>;
}

/// The viewer flow: create the session, then launch Moonlight IMMEDIATELY.
///
/// Ordering is critical: the session is created PENDING and Moonlight is launched
/// without waiting for RUNNING. The session only reaches RUNNING after Moonlight
/// connects and the host agent claims it, so waiting for RUNNING first would
/// deadlock. Generic over the boundaries so the sequence is unit-testable.
pub(crate) async fn start_remote_play_with<C, S>(
    creator: &C,
    streamer: &S,
    game_id: i32,
    host_client_id: i32,
    client_client_id: i32,
    app_name: &str,
) -> Result<RemotePlaySession>
where
    C: SessionCreator + Sync,
    S: StreamLauncher + Sync,
{
    // Pre-flight: don't create a session we can't fulfill.
    if !streamer.is_available().await {
        return Err(Error::MoonlightNotFound);
    }

    // (a) Create the session -- it starts PENDING (REQUESTED).
    let session = creator
        .create_session(game_id, host_client_id, client_client_id, app_name)
        .await?;

    // (b) Launch Moonlight now, while the session is still PENDING. Do NOT wait
    // for RUNNING -- nothing reaches RUNNING until Moonlight connects.
    streamer.launch_stream(app_name, game_id).await?;

    Ok(session)
}

/// Production [`SessionCreator`] backed by the RemotePlay gRPC client.
pub(crate) struct GrpcSessionCreator<R: Runtime> {
    pub app: AppHandle<R>,
}

#[async_trait]
impl<R: Runtime> SessionCreator for GrpcSessionCreator<R> {
    async fn create_session(
        &self,
        game_id: i32,
        host_client_id: i32,
        client_client_id: i32,
        app_name: &str,
    ) -> Result<RemotePlaySession> {
        let mut client = self.app.get_remote_play_client().await;
        let response = client
            .create_session(CreateSessionRequest {
                session: Some(NewRemotePlaySession {
                    game_id,
                    host_client_id,
                    client_client_id,
                    state: RemotePlaySessionState::Requested as i32,
                    sunshine_app_name: app_name.to_string(),
                    created_at: None,
                    updated_at: None,
                }),
            })
            .await
            .map_err(|status| Error::Status(status.to_string()))?
            .into_inner();

        response
            .session
            .ok_or_else(|| Error::Internal("CreateSession returned no session".into()))
    }
}

/// Production [`StreamLauncher`] that launches Moonlight and reuses the launcher's
/// external-process + return-to-fullscreen machinery.
pub(crate) struct MoonlightStreamLauncher<R: Runtime> {
    pub app: AppHandle<R>,
    pub config: MoonlightConfig,
}

#[async_trait]
impl<R: Runtime> StreamLauncher for MoonlightStreamLauncher<R> {
    async fn is_available(&self) -> bool {
        match &self.config.invocation {
            // `flatpak info <id>` exits 0 when the app is installed.
            MoonlightInvocation::Flatpak => tokio::process::Command::new("flatpak")
                .args(["info", MOONLIGHT_FLATPAK_ID])
                .output()
                .await
                .map(|out| out.status.success())
                .unwrap_or(false),
            MoonlightInvocation::Executable(path) => executable_on_path(path),
        }
    }

    async fn launch_stream(&self, app_name: &str, game_id: i32) -> Result<()> {
        let (program, args) = build_moonlight_command(&self.config, app_name);

        let mut command = tokio::process::Command::new(program);
        command.args(args);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW

        // Reuse the launcher's spawn + foreground-reclaim + return-to-library:
        // Moonlight is treated like a native game launch on the viewer, so on its
        // exit Retrom comes back to the foreground exactly as after a local game.
        self.app
            .launcher()
            .run_foregrounding_process(game_id, command)
            .await
            .map_err(|why| Error::Internal(why.to_string()))
    }
}

/// Whether `exe` exists at its path, or (if bare) is resolvable on `PATH`.
fn executable_on_path(exe: &str) -> bool {
    let path = std::path::Path::new(exe);
    if path.is_absolute() || exe.contains(std::path::MAIN_SEPARATOR) {
        return path.is_file();
    }

    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file()))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct CallLog(Mutex<Vec<&'static str>>);

    impl CallLog {
        fn push(&self, entry: &'static str) {
            self.0.lock().unwrap().push(entry);
        }
        fn calls(&self) -> Vec<&'static str> {
            self.0.lock().unwrap().clone()
        }
    }

    struct MockCreator<'a> {
        log: &'a CallLog,
        created: Mutex<Vec<(i32, i32, i32)>>,
    }

    #[async_trait]
    impl SessionCreator for MockCreator<'_> {
        async fn create_session(
            &self,
            game_id: i32,
            host_client_id: i32,
            client_client_id: i32,
            app_name: &str,
        ) -> Result<RemotePlaySession> {
            self.log.push("create");
            self.created
                .lock()
                .unwrap()
                .push((game_id, host_client_id, client_client_id));
            Ok(RemotePlaySession {
                id: 1,
                game_id,
                host_client_id,
                client_client_id,
                state: RemotePlaySessionState::Requested as i32,
                sunshine_app_name: app_name.to_string(),
                ..Default::default()
            })
        }
    }

    struct MockStreamer<'a> {
        available: bool,
        log: &'a CallLog,
        launched: Mutex<Vec<i32>>,
    }

    #[async_trait]
    impl StreamLauncher for MockStreamer<'_> {
        async fn is_available(&self) -> bool {
            self.log.push("available");
            self.available
        }
        async fn launch_stream(&self, _app_name: &str, game_id: i32) -> Result<()> {
            self.log.push("launch");
            self.launched.lock().unwrap().push(game_id);
            Ok(())
        }
    }

    #[test]
    fn flatpak_command_is_moonlight_stream_host_app() {
        let config = MoonlightConfig {
            invocation: MoonlightInvocation::Flatpak,
            host: "10.0.0.5".into(),
        };
        let (program, args) = build_moonlight_command(&config, "Retrom Remote Play");
        assert_eq!(program, "flatpak");
        assert_eq!(
            args,
            vec![
                "run",
                MOONLIGHT_FLATPAK_ID,
                "stream",
                "10.0.0.5",
                "Retrom Remote Play"
            ]
        );
    }

    #[test]
    fn executable_command_is_moonlight_stream_host_app() {
        let config = MoonlightConfig {
            invocation: MoonlightInvocation::Executable("/usr/bin/moonlight".into()),
            host: "host.local".into(),
        };
        let (program, args) = build_moonlight_command(&config, "Retrom Remote Play");
        assert_eq!(program, "/usr/bin/moonlight");
        assert_eq!(args, vec!["stream", "host.local", "Retrom Remote Play"]);
    }

    #[tokio::test]
    async fn launches_moonlight_while_session_is_pending_not_gated_on_running() {
        let log = CallLog::default();
        let creator = MockCreator {
            log: &log,
            created: Mutex::default(),
        };
        let streamer = MockStreamer {
            available: true,
            log: &log,
            launched: Mutex::default(),
        };

        let session = start_remote_play_with(&creator, &streamer, 42, 7, 3, "Retrom Remote Play")
            .await
            .unwrap();

        // Moonlight is launched right after the session is created -- while it is
        // still PENDING (REQUESTED), with no wait for RUNNING in between.
        assert_eq!(log.calls(), vec!["available", "create", "launch"]);
        assert_eq!(session.state, RemotePlaySessionState::Requested as i32);
        assert_eq!(streamer.launched.lock().unwrap().as_slice(), &[42]);
    }

    #[tokio::test]
    async fn no_moonlight_means_no_session_created() {
        let log = CallLog::default();
        let creator = MockCreator {
            log: &log,
            created: Mutex::default(),
        };
        let streamer = MockStreamer {
            available: false,
            log: &log,
            launched: Mutex::default(),
        };

        let result =
            start_remote_play_with(&creator, &streamer, 42, 7, 3, "Retrom Remote Play").await;

        assert!(matches!(result, Err(Error::MoonlightNotFound)));
        // Never created a session or launched Moonlight.
        assert_eq!(log.calls(), vec!["available"]);
        assert!(creator.created.lock().unwrap().is_empty());
    }
}
