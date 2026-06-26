use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::sunshine::{
    self, EnsureOutcome, HostReadiness, HttpSunshineClient, SunshineClient, SunshineConfig,
    RETROM_HOST_AGENT_CMD,
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

        HttpSunshineClient::new(config)
            .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
            .await
    }
}
