//! Host-agent flow for Remote Play.
//!
//! Driven by `retrom-host-agent run-pending-session` (forwarded into the running
//! client by the single-instance plugin): claim the pending brokered session,
//! resolve the game, launch it via the EXISTING [`crate::launch::dispatch`], and
//! drive the session state machine. The actual launching is never reimplemented
//! here -- this module only wraps `dispatch` and the broker RPCs.
//!
//! The decision logic is kept behind two boundaries ([`SessionBroker`] and
//! [`SessionLaunch`]) plus pure helpers, so it is unit-testable without a real
//! game or server.

use async_trait::async_trait;
use retrom_codegen::retrom::{
    emulator::OperatingSystem, Emulator, EmulatorProfile, Game, GameFile,
    GetDefaultEmulatorProfilesRequest, GetEmulatorProfilesRequest, GetEmulatorsRequest,
    GetGamesRequest, GetPendingSessionForHostRequest, RemotePlaySession, RemotePlaySessionState,
    UpdateSessionStateRequest,
};
use retrom_plugin_config::ConfigExt;
use retrom_plugin_service_client::RetromPluginServiceClientExt;
use tauri::{AppHandle, Runtime};
use tracing::{error, info, warn};

use crate::launch::LaunchContext;

const NOT_STREAM_TARGET_REASON: &str =
    "Game runs in-webview (EmulatorJS/wasm) and is not a Remote Play stream target";

/// Whether a game launched with this emulator is a valid Remote Play stream
/// target. EmulatorJS/wasm cores run in an embedded webview (no host OS window
/// for Sunshine to capture), so they are never stream targets. This mirrors the
/// condition the `WasmAdapter` matches on, negated.
pub fn is_stream_target(emulator: &Emulator) -> bool {
    let wasm_only = emulator.libretro_name.is_some()
        && emulator
            .operating_systems
            .contains(&(OperatingSystem::Wasm as i32));

    !wasm_only
}

/// Whether dispatch will route this game to the SteamAdapter -- the same keys
/// `SteamAdapter::matches` uses (third-party + a valid Steam app id). Mirroring
/// the adapter guarantees a Steam-resolved context will actually match it.
pub(crate) fn is_steam_game(game: &Game) -> bool {
    game.third_party
        && game
            .steam_app_id
            .and_then(|app_id| u32::try_from(app_id).ok())
            .is_some()
}

/// Whether the brokered game is a Remote Play stream target. Steam games always
/// are; emulator games are unless the emulator is wasm-only. A non-Steam game
/// with no resolved emulator can't be launched, so it isn't a stream target.
pub(crate) fn game_is_stream_target(game: &Game, emulator: Option<&Emulator>) -> bool {
    is_steam_game(game) || emulator.map(is_stream_target).unwrap_or(false)
}

/// What to do when a launch's lifecycle ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitAction {
    /// Normal local play: bring the host's own Retrom UI back to the foreground.
    ForegroundLocalUi,
    /// Remote-play session: do NOT foreground the host UI; end the session.
    EndSession(i32),
}

/// Decide how a finished launch should end, based on whether it belongs to a
/// remote-play session. The local-play path (`None`) is unchanged.
pub fn exit_action(remote_play_session_id: Option<i32>) -> ExitAction {
    match remote_play_session_id {
        Some(session_id) => ExitAction::EndSession(session_id),
        None => ExitAction::ForegroundLocalUi,
    }
}

/// The broker boundary (the RemotePlay RPCs), abstracted for testing.
#[async_trait]
pub(crate) trait SessionBroker {
    async fn pending_for_host(
        &self,
        host_client_id: i32,
    ) -> crate::Result<Option<RemotePlaySession>>;

    async fn set_state(
        &self,
        id: i32,
        state: RemotePlaySessionState,
        error_message: Option<String>,
    ) -> crate::Result<()>;
}

/// The launch boundary (resolve + dispatch), abstracted for testing.
#[async_trait]
pub(crate) trait SessionLaunch {
    /// Whether the brokered game is a valid stream target (false ⇒ wasm-only).
    async fn is_stream_target(&self, game_id: i32) -> crate::Result<bool>;

    /// Resolve and launch the game for this session via the existing dispatch.
    async fn launch(&self, game_id: i32, session_id: i32) -> crate::Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunOutcome {
    NoPendingSession,
    RejectedNotStreamTarget(i32),
    Launched(i32),
    LaunchFailed(i32),
}

/// Core host-agent flow, generic over the broker + launch boundaries so it can be
/// unit-tested with mocks. PREPARING→RUNNING is reported from inside the launcher
/// adapter once the game is actually up (dispatch blocks until exit), not here.
pub(crate) async fn run_pending_session_with<B, L>(
    broker: &B,
    launcher: &L,
    host_client_id: i32,
) -> crate::Result<RunOutcome>
where
    B: SessionBroker + Sync,
    L: SessionLaunch + Sync,
{
    let Some(session) = broker.pending_for_host(host_client_id).await? else {
        return Ok(RunOutcome::NoPendingSession);
    };

    // wasm/EmulatorJS titles have no host window to capture: fail cleanly, never
    // launch in-webview.
    if !launcher.is_stream_target(session.game_id).await? {
        broker
            .set_state(
                session.id,
                RemotePlaySessionState::Failed,
                Some(NOT_STREAM_TARGET_REASON.to_string()),
            )
            .await?;
        return Ok(RunOutcome::RejectedNotStreamTarget(session.id));
    }

    broker
        .set_state(session.id, RemotePlaySessionState::Preparing, None)
        .await?;

    match launcher.launch(session.game_id, session.id).await {
        Ok(()) => Ok(RunOutcome::Launched(session.id)),
        Err(why) => {
            broker
                .set_state(
                    session.id,
                    RemotePlaySessionState::Failed,
                    Some(why.to_string()),
                )
                .await?;
            Ok(RunOutcome::LaunchFailed(session.id))
        }
    }
}

/// Entry point: claim and run the next pending session for this host. Wired from
/// the client's single-instance handler when it sees `run-pending-session`.
pub async fn run_pending_session<R: Runtime>(app: AppHandle<R>) {
    let Some(client_id) = resolve_client_id(&app).await else {
        warn!("run-pending-session: no client id configured; ignoring");
        return;
    };

    let broker = GrpcSessionBroker { app: app.clone() };
    let launcher = LauncherSessionLaunch { app: app.clone() };

    match run_pending_session_with(&broker, &launcher, client_id).await {
        Ok(outcome) => info!("run-pending-session outcome: {outcome:?}"),
        Err(why) => warn!("run-pending-session failed: {why}"),
    }
}

/// Report PREPARING→RUNNING once the game process is up. Called from the adapter.
pub(crate) async fn report_session_running<R: Runtime>(app: &AppHandle<R>, session_id: i32) {
    let broker = GrpcSessionBroker { app: app.clone() };
    if let Err(why) = broker
        .set_state(session_id, RemotePlaySessionState::Running, None)
        .await
    {
        warn!("Failed to mark remote-play session {session_id} running: {why}");
    }
}

/// Report RUNNING→ENDED when the game exits. Called from the adapter teardown.
pub(crate) async fn report_session_ended<R: Runtime>(app: &AppHandle<R>, session_id: i32) {
    let broker = GrpcSessionBroker { app: app.clone() };
    if let Err(why) = broker
        .set_state(session_id, RemotePlaySessionState::Ended, None)
        .await
    {
        warn!("Failed to mark remote-play session {session_id} ended: {why}");
    }
}

async fn report_session_failed<R: Runtime>(app: &AppHandle<R>, session_id: i32, message: String) {
    let broker = GrpcSessionBroker { app: app.clone() };
    if let Err(why) = broker
        .set_state(session_id, RemotePlaySessionState::Failed, Some(message))
        .await
    {
        warn!("Failed to mark remote-play session {session_id} failed: {why}");
    }
}

async fn resolve_client_id<R: Runtime>(app: &AppHandle<R>) -> Option<i32> {
    app.config_manager()
        .get_config()
        .await
        .config
        .and_then(|config| config.client_info.map(|info| info.id))
}

fn grpc_err(status: tonic::Status) -> crate::Error {
    crate::Error::InternalError(status.to_string())
}

/// Production [`SessionBroker`] backed by the RemotePlay gRPC client.
struct GrpcSessionBroker<R: Runtime> {
    app: AppHandle<R>,
}

#[async_trait]
impl<R: Runtime> SessionBroker for GrpcSessionBroker<R> {
    async fn pending_for_host(
        &self,
        host_client_id: i32,
    ) -> crate::Result<Option<RemotePlaySession>> {
        let mut client = self.app.get_remote_play_client().await;
        let response = client
            .get_pending_session_for_host(GetPendingSessionForHostRequest { host_client_id })
            .await
            .map_err(grpc_err)?
            .into_inner();

        Ok(response.session)
    }

    async fn set_state(
        &self,
        id: i32,
        state: RemotePlaySessionState,
        error_message: Option<String>,
    ) -> crate::Result<()> {
        let mut client = self.app.get_remote_play_client().await;
        client
            .update_session_state(UpdateSessionStateRequest {
                id,
                state: state as i32,
                error_code: None,
                error_message,
            })
            .await
            .map_err(grpc_err)?;

        Ok(())
    }
}

/// Production [`SessionLaunch`] that resolves the game's default launch config via
/// the existing service RPCs and hands off to the EXISTING [`crate::launch::dispatch`].
struct LauncherSessionLaunch<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> LauncherSessionLaunch<R> {
    /// Fetch the game and its files.
    async fn resolve_game(&self, game_id: i32) -> crate::Result<(Game, Vec<GameFile>)> {
        let mut game_client = self.app.get_game_client().await;
        let games = game_client
            .get_games(GetGamesRequest {
                ids: vec![game_id],
                ..Default::default()
            })
            .await
            .map_err(grpc_err)?
            .into_inner();

        let game = games
            .games
            .into_iter()
            .next()
            .ok_or(crate::Error::GameNotFound(Some(game_id)))?;

        Ok((game, games.game_files))
    }

    /// Resolve the emulator, default profile, and ROM file for a non-Steam game,
    /// reusing the server's existing resolution RPCs (not reimplementing the
    /// launcher).
    async fn resolve_emulator_play(
        &self,
        game: &Game,
        game_files: &[GameFile],
    ) -> crate::Result<(Emulator, EmulatorProfile, Option<GameFile>)> {
        let client_id = resolve_client_id(&self.app)
            .await
            .ok_or_else(|| crate::Error::InternalError("Client ID not configured".into()))?;

        let platform_id = game.platform_id.ok_or_else(|| {
            crate::Error::InternalError(format!("game {} has no platform", game.id))
        })?;

        let mut emulator_client = self.app.get_emulator_client().await;

        // The default-profile lookup is scoped to this client via the x-client-id
        // header (the request carries only platform ids).
        let mut default_req = tonic::Request::new(GetDefaultEmulatorProfilesRequest {
            platform_ids: vec![platform_id],
        });
        let client_id_header: tonic::metadata::MetadataValue<tonic::metadata::Ascii> = client_id
            .to_string()
            .parse()
            .map_err(|_| crate::Error::InternalError("invalid client id header".into()))?;
        default_req
            .metadata_mut()
            .insert("x-client-id", client_id_header);

        let default_profile = emulator_client
            .get_default_emulator_profiles(default_req)
            .await
            .map_err(grpc_err)?
            .into_inner()
            .default_profiles
            .into_iter()
            .find(|profile| profile.platform_id == platform_id)
            .ok_or_else(|| {
                crate::Error::InternalError(format!(
                    "no default emulator profile for platform {platform_id}"
                ))
            })?;

        let profile = emulator_client
            .get_emulator_profiles(GetEmulatorProfilesRequest {
                ids: vec![default_profile.emulator_profile_id],
                ..Default::default()
            })
            .await
            .map_err(grpc_err)?
            .into_inner()
            .profiles
            .into_iter()
            .next()
            .ok_or_else(|| {
                crate::Error::InternalError(format!(
                    "emulator profile {} not found",
                    default_profile.emulator_profile_id
                ))
            })?;

        let emulator = emulator_client
            .get_emulators(GetEmulatorsRequest {
                ids: vec![profile.emulator_id],
                ..Default::default()
            })
            .await
            .map_err(grpc_err)?
            .into_inner()
            .emulators
            .into_iter()
            .next()
            .ok_or_else(|| {
                crate::Error::InternalError(format!("emulator {} not found", profile.emulator_id))
            })?;

        // Prefer the game's default file, else the first file.
        let file = game
            .default_file_id
            .and_then(|id| game_files.iter().find(|f| f.id == id).cloned())
            .or_else(|| game_files.first().cloned());

        Ok((emulator, profile, file))
    }

    async fn resolve_standalone(&self) -> bool {
        self.app
            .config_manager()
            .get_config()
            .await
            .server
            .and_then(|server| server.standalone)
            .unwrap_or(false)
    }

    /// Build the [`LaunchContext`] for a session's game. Steam (third-party) games
    /// resolve to a context the SteamAdapter accepts -- game with `third_party` +
    /// the Steam app id, and no emulator/profile/ROM -- mirroring how the frontend
    /// hands Steam games to the launcher. Everything else resolves the
    /// emulator/profile/ROM. Either way it's handed to the existing dispatch.
    async fn resolve_context(
        &self,
        game_id: i32,
        session_id: i32,
    ) -> crate::Result<LaunchContext<R>> {
        let (game, game_files) = self.resolve_game(game_id).await?;
        let standalone = self.resolve_standalone().await;

        if is_steam_game(&game) {
            return Ok(LaunchContext {
                app: self.app.clone(),
                game,
                emulator: None,
                profile: None,
                file: None,
                standalone,
                remote_play_session_id: Some(session_id),
            });
        }

        let (emulator, profile, file) = self.resolve_emulator_play(&game, &game_files).await?;

        Ok(LaunchContext {
            app: self.app.clone(),
            game,
            emulator: Some(emulator),
            profile: Some(profile),
            file,
            standalone,
            remote_play_session_id: Some(session_id),
        })
    }
}

#[async_trait]
impl<R: Runtime> SessionLaunch for LauncherSessionLaunch<R> {
    async fn is_stream_target(&self, game_id: i32) -> crate::Result<bool> {
        let (game, game_files) = self.resolve_game(game_id).await?;

        // Steam games are stream targets without resolving an emulator.
        if is_steam_game(&game) {
            return Ok(game_is_stream_target(&game, None));
        }

        let (emulator, _, _) = self.resolve_emulator_play(&game, &game_files).await?;
        Ok(game_is_stream_target(&game, Some(&emulator)))
    }

    async fn launch(&self, game_id: i32, session_id: i32) -> crate::Result<()> {
        let ctx = self.resolve_context(game_id, session_id).await?;

        // dispatch blocks until the game exits, so run it in the background; the
        // adapter drives PREPARING→RUNNING→ENDED via the threaded session id.
        let app = self.app.clone();
        tokio::spawn(async move {
            if let Err(why) = crate::launch::dispatch(ctx).await {
                error!("Remote-play dispatch failed for game {game_id}: {why}");
                report_session_failed(&app, session_id, why.to_string()).await;
            }
        });

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn native_emulator() -> Emulator {
        Emulator {
            libretro_name: None,
            operating_systems: vec![],
            ..Default::default()
        }
    }

    fn wasm_emulator() -> Emulator {
        Emulator {
            libretro_name: Some("fceumm".to_string()),
            operating_systems: vec![OperatingSystem::Wasm as i32],
            ..Default::default()
        }
    }

    #[test]
    fn is_stream_target_rejects_wasm_only() {
        assert!(is_stream_target(&native_emulator()));
        assert!(!is_stream_target(&wasm_emulator()));
    }

    #[test]
    fn exit_action_branches_on_session() {
        assert_eq!(exit_action(None), ExitAction::ForegroundLocalUi);
        assert_eq!(exit_action(Some(7)), ExitAction::EndSession(7));
    }

    fn steam_game(steam_app_id: i64) -> Game {
        Game {
            third_party: true,
            steam_app_id: Some(steam_app_id),
            ..Default::default()
        }
    }

    fn emulator_game() -> Game {
        Game {
            third_party: false,
            steam_app_id: None,
            ..Default::default()
        }
    }

    #[test]
    fn is_steam_game_matches_steam_adapter_keys() {
        // Third-party with a valid app id: SteamAdapter would match this.
        assert!(is_steam_game(&steam_game(440)));
        // Third-party but no app id.
        assert!(!is_steam_game(&Game {
            third_party: true,
            steam_app_id: None,
            ..Default::default()
        }));
        // App id that doesn't fit u32 (SteamAdapter rejects it too).
        assert!(!is_steam_game(&Game {
            third_party: true,
            steam_app_id: Some(-1),
            ..Default::default()
        }));
        // Has an app id but isn't third-party.
        assert!(!is_steam_game(&Game {
            third_party: false,
            steam_app_id: Some(440),
            ..Default::default()
        }));
        assert!(!is_steam_game(&emulator_game()));
    }

    #[test]
    fn steam_game_is_a_stream_target_without_an_emulator() {
        // A Steam game resolves to a Steam-matching context (no emulator) and is a
        // stream target.
        assert!(is_steam_game(&steam_game(440)));
        assert!(game_is_stream_target(&steam_game(440), None));

        // Emulator games: native yes, wasm no, missing-emulator no.
        assert!(game_is_stream_target(
            &emulator_game(),
            Some(&native_emulator())
        ));
        assert!(!game_is_stream_target(
            &emulator_game(),
            Some(&wasm_emulator())
        ));
        assert!(!game_is_stream_target(&emulator_game(), None));

        // And a Steam session ends like any other on exit.
        assert_eq!(exit_action(Some(3)), ExitAction::EndSession(3));
    }

    #[derive(Default)]
    struct MockBroker {
        pending: Option<RemotePlaySession>,
        states: Mutex<Vec<(i32, RemotePlaySessionState, Option<String>)>>,
    }

    #[async_trait]
    impl SessionBroker for MockBroker {
        async fn pending_for_host(
            &self,
            _host_client_id: i32,
        ) -> crate::Result<Option<RemotePlaySession>> {
            Ok(self.pending.clone())
        }

        async fn set_state(
            &self,
            id: i32,
            state: RemotePlaySessionState,
            error_message: Option<String>,
        ) -> crate::Result<()> {
            self.states.lock().unwrap().push((id, state, error_message));
            Ok(())
        }
    }

    struct MockLaunch {
        stream_target: bool,
        launch_result: fn() -> crate::Result<()>,
        launched: Mutex<Vec<(i32, i32)>>,
    }

    #[async_trait]
    impl SessionLaunch for MockLaunch {
        async fn is_stream_target(&self, _game_id: i32) -> crate::Result<bool> {
            Ok(self.stream_target)
        }

        async fn launch(&self, game_id: i32, session_id: i32) -> crate::Result<()> {
            self.launched.lock().unwrap().push((game_id, session_id));
            (self.launch_result)()
        }
    }

    fn session(id: i32, game_id: i32) -> RemotePlaySession {
        RemotePlaySession {
            id,
            game_id,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn no_pending_session_does_nothing() {
        let broker = MockBroker::default();
        let launcher = MockLaunch {
            stream_target: true,
            launch_result: || Ok(()),
            launched: Mutex::default(),
        };

        let outcome = run_pending_session_with(&broker, &launcher, 1)
            .await
            .unwrap();

        assert_eq!(outcome, RunOutcome::NoPendingSession);
        assert!(broker.states.lock().unwrap().is_empty());
        assert!(launcher.launched.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn wasm_session_is_failed_not_launched() {
        let broker = MockBroker {
            pending: Some(session(5, 42)),
            ..Default::default()
        };
        let launcher = MockLaunch {
            stream_target: false,
            launch_result: || Ok(()),
            launched: Mutex::default(),
        };

        let outcome = run_pending_session_with(&broker, &launcher, 1)
            .await
            .unwrap();

        assert_eq!(outcome, RunOutcome::RejectedNotStreamTarget(5));
        let states = broker.states.lock().unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].0, 5);
        assert_eq!(states[0].1, RemotePlaySessionState::Failed);
        assert!(launcher.launched.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn native_session_prepares_then_launches() {
        let broker = MockBroker {
            pending: Some(session(5, 42)),
            ..Default::default()
        };
        let launcher = MockLaunch {
            stream_target: true,
            launch_result: || Ok(()),
            launched: Mutex::default(),
        };

        let outcome = run_pending_session_with(&broker, &launcher, 1)
            .await
            .unwrap();

        assert_eq!(outcome, RunOutcome::Launched(5));
        let states = broker.states.lock().unwrap();
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].1, RemotePlaySessionState::Preparing);
        assert_eq!(launcher.launched.lock().unwrap().as_slice(), &[(42, 5)]);
    }

    #[tokio::test]
    async fn launch_failure_marks_session_failed() {
        let broker = MockBroker {
            pending: Some(session(5, 42)),
            ..Default::default()
        };
        let launcher = MockLaunch {
            stream_target: true,
            launch_result: || Err(crate::Error::InternalError("boom".into())),
            launched: Mutex::default(),
        };

        let outcome = run_pending_session_with(&broker, &launcher, 1)
            .await
            .unwrap();

        assert_eq!(outcome, RunOutcome::LaunchFailed(5));
        let states = broker.states.lock().unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].1, RemotePlaySessionState::Preparing);
        assert_eq!(states[1].1, RemotePlaySessionState::Failed);
    }
}
