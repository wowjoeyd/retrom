use retrom_codegen::retrom::RemotePlaySession;
use retrom_plugin_config::ConfigExt;
use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::moonlight::{self, GrpcSessionCreator, MoonlightConfig, MoonlightStreamLauncher};
use crate::sunshine::{
    self, EnsureOutcome, HostReadiness, HttpSunshineClient, SunshineClient, SunshineConfig,
};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<RemotePlay<R>> {
    Ok(RemotePlay::new(app.clone()))
}

/// Access to the Remote Play host APIs.
pub struct RemotePlay<R: Runtime> {
    app_handle: AppHandle<R>,
}

impl<R: Runtime> RemotePlay<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self { app_handle }
    }

    /// The owning app handle, for config/launcher integration in later phases.
    pub fn app_handle(&self) -> &AppHandle<R> {
        &self.app_handle
    }

    /// Report whether the host is ready for Remote Play: Sunshine reachable and
    /// the managed app present. Resolves Sunshine credentials from config; if
    /// they're absent, reports not-ready rather than guessing.
    pub async fn host_readiness(&self) -> HostReadiness {
        match SunshineConfig::from_env() {
            Some(config) => sunshine::readiness(&HttpSunshineClient::new(config)).await,
            None => {
                tracing::debug!("Sunshine credentials not configured; reporting host not ready");
                HostReadiness::default()
            }
        }
    }

    /// Setup flow: idempotently ensure the single managed "Retrom Remote Play"
    /// Sunshine app exists, returning whether it was created, updated, or already
    /// present. Errors if Sunshine credentials aren't configured.
    pub async fn ensure_host_app(&self) -> crate::Result<EnsureOutcome> {
        let Some(config) = SunshineConfig::from_env() else {
            return Err(crate::Error::NotConfigured(
                "set RETROM_SUNSHINE_USERNAME and RETROM_SUNSHINE_PASSWORD".to_string(),
            ));
        };

        // Bake this host's own client id + the broker URL into the Sunshine command
        // so the agent can watch the session and keep the stream alive (see
        // `resolved_host_agent_cmd`).
        let host_client_id = self.client_id().await.ok_or_else(|| {
            crate::Error::NotConfigured("client id (no client_info in config)".into())
        })?;
        let server_url = self.service_host().await;

        HttpSunshineClient::new(config)
            .ensure_retrom_app(&sunshine::resolved_host_agent_cmd(
                host_client_id,
                &server_url,
            ))
            .await
    }

    /// The gRPC broker URL this client talks to, mirroring the service client's
    /// `get_service_host`: `config.server.hostname[:port]`, else the local default.
    async fn service_host(&self) -> String {
        self.app_handle
            .config_manager()
            .get_config()
            .await
            .server
            .map(|server| {
                let mut host = server.hostname;
                if let Some(port) = server.port {
                    host.push_str(&format!(":{port}"));
                }
                host
            })
            .unwrap_or_else(|| "http://localhost:5101".to_string())
    }

    /// Viewer flow: start streaming `game_id` from the configured host -- create a
    /// brokered session and launch Moonlight straight into the host's managed
    /// "Retrom Remote Play" app. Blocks until Moonlight exits, at which point
    /// Retrom is back in the foreground. v4 uses one configured host (no picker).
    pub async fn start_remote_play(&self, game_id: i32) -> crate::Result<RemotePlaySession> {
        let host_client_id = std::env::var("RETROM_REMOTE_PLAY_HOST_ID")
            .ok()
            .and_then(|id| id.parse::<i32>().ok())
            .ok_or_else(|| crate::Error::NotConfigured("RETROM_REMOTE_PLAY_HOST_ID".into()))?;

        let client_client_id = self.client_id().await.ok_or_else(|| {
            crate::Error::NotConfigured("client id (no client_info in config)".into())
        })?;

        let config = MoonlightConfig::from_env()
            .ok_or_else(|| crate::Error::NotConfigured("RETROM_REMOTE_PLAY_HOST".into()))?;

        let creator = GrpcSessionCreator {
            app: self.app_handle.clone(),
        };
        let streamer = MoonlightStreamLauncher {
            app: self.app_handle.clone(),
            config,
        };

        moonlight::start_remote_play_with(
            &creator,
            &streamer,
            game_id,
            host_client_id,
            client_client_id,
            sunshine::RETROM_APP_NAME,
        )
        .await
    }

    /// This client's own Retrom client id, from config.
    async fn client_id(&self) -> Option<i32> {
        self.app_handle
            .config_manager()
            .get_config()
            .await
            .config
            .and_then(|config| config.client_info.map(|info| info.id))
    }
}
