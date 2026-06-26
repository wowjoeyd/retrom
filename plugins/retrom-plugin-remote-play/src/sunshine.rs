//! Host-side Sunshine integration for Remote Play.
//!
//! Everything Sunshine-specific lives behind the [`SunshineClient`] trait so the
//! rest of the plugin (and the tests) never touch a real Sunshine.
//! [`HttpSunshineClient`] talks to the local Sunshine REST API documented in
//! `design/remote-play/02-sunshine.md`; tests use an in-memory mock.

use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::Result;

/// The single Sunshine app Retrom manages. Never per-game.
pub const RETROM_APP_NAME: &str = "Retrom Remote Play";

/// Placeholder host-agent invocation used as the managed app's `cmd`. Phase 3
/// resolves the real absolute binary path.
pub const RETROM_HOST_AGENT_CMD: &str = "retrom-host-agent run-pending-session";

/// Default Sunshine web API base URL (HTTPS, self-signed cert, localhost).
pub const DEFAULT_SUNSHINE_BASE_URL: &str = "https://localhost:47990";

/// A Sunshine application, as far as Retrom cares. Extra fields Sunshine returns
/// are ignored on deserialize.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SunshineApp {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cmd: String,
}

/// Outcome of [`SunshineClient::ensure_retrom_app`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureOutcome {
    /// The managed app was missing and has been created.
    Created,
    /// The managed app already existed; nothing changed.
    AlreadyPresent,
}

/// Host-side readiness for Remote Play.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostReadiness {
    /// Sunshine is installed, running, and our credentials are accepted.
    pub sunshine_available: bool,
    /// The managed "Retrom Remote Play" app exists in Sunshine.
    pub retrom_app_present: bool,
}

/// Abstraction over a Sunshine host. Behind a trait so tests need no real Sunshine.
#[async_trait]
pub trait SunshineClient: Send + Sync {
    /// Whether Sunshine is reachable and our credentials are accepted.
    async fn is_available(&self) -> bool;

    /// List the apps Sunshine currently knows about.
    async fn list_apps(&self) -> Result<Vec<SunshineApp>>;

    /// Idempotently ensure the single managed "Retrom Remote Play" app exists,
    /// with `host_agent_cmd` as its command. Never creates per-game apps and
    /// never duplicates the managed app.
    async fn ensure_retrom_app(&self, host_agent_cmd: &str) -> Result<EnsureOutcome>;

    /// Restart Sunshine if a previous call made a change that requires it.
    async fn restart_if_needed(&self) -> Result<()>;
}

/// Compute host readiness from any [`SunshineClient`] (generic, so it's testable
/// with the mock).
pub async fn readiness(client: &impl SunshineClient) -> HostReadiness {
    let sunshine_available = client.is_available().await;

    let retrom_app_present = if sunshine_available {
        client
            .list_apps()
            .await
            .map(|apps| apps.iter().any(|app| app.name == RETROM_APP_NAME))
            .unwrap_or(false)
    } else {
        false
    };

    HostReadiness {
        sunshine_available,
        retrom_app_present,
    }
}

/// Connection settings for the local Sunshine REST API. Resolved from config /
/// environment -- never hardcoded.
#[derive(Debug, Clone)]
pub struct SunshineConfig {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

impl SunshineConfig {
    /// Resolve from environment. Returns `None` when credentials are absent, so
    /// we never guess or hardcode secrets: `RETROM_SUNSHINE_USERNAME`,
    /// `RETROM_SUNSHINE_PASSWORD`, and the optional `RETROM_SUNSHINE_BASE_URL`
    /// (defaults to [`DEFAULT_SUNSHINE_BASE_URL`]).
    pub fn from_env() -> Option<Self> {
        let username = std::env::var("RETROM_SUNSHINE_USERNAME").ok()?;
        let password = std::env::var("RETROM_SUNSHINE_PASSWORD").ok()?;
        let base_url = std::env::var("RETROM_SUNSHINE_BASE_URL")
            .unwrap_or_else(|_| DEFAULT_SUNSHINE_BASE_URL.to_string());

        Some(Self {
            base_url,
            username,
            password,
        })
    }
}

#[derive(Deserialize)]
struct AppsResponse {
    #[serde(default)]
    apps: Vec<SunshineApp>,
}

/// Real Sunshine client talking to the local REST API over HTTPS.
pub struct HttpSunshineClient {
    config: SunshineConfig,
    http: reqwest::Client,
    needs_restart: AtomicBool,
}

impl HttpSunshineClient {
    pub fn new(config: SunshineConfig) -> Self {
        // Sunshine serves the API with a self-signed cert on localhost, so we
        // must accept it. Scoped to this client only.
        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(true)
            .build()
            .unwrap_or_default();

        Self {
            config,
            http,
            needs_restart: AtomicBool::new(false),
        }
    }

    fn endpoint(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.config.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    fn authed(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        builder.basic_auth(&self.config.username, Some(&self.config.password))
    }
}

#[async_trait]
impl SunshineClient for HttpSunshineClient {
    async fn is_available(&self) -> bool {
        match self.authed(self.http.get(self.endpoint("api/apps"))).send().await {
            Ok(res) => res.status().is_success(),
            Err(_) => false,
        }
    }

    async fn list_apps(&self) -> Result<Vec<SunshineApp>> {
        let res = self
            .authed(self.http.get(self.endpoint("api/apps")))
            .send()
            .await?
            .error_for_status()?;

        let body: AppsResponse = res.json().await?;
        Ok(body.apps)
    }

    async fn ensure_retrom_app(&self, host_agent_cmd: &str) -> Result<EnsureOutcome> {
        if self
            .list_apps()
            .await?
            .iter()
            .any(|app| app.name == RETROM_APP_NAME)
        {
            return Ok(EnsureOutcome::AlreadyPresent);
        }

        // No `index` field => create (vs. update). One managed app, never per-game.
        let body = serde_json::json!({
            "name": RETROM_APP_NAME,
            "cmd": host_agent_cmd,
            "auto-detach": true,
            "wait-all": true,
            "exclude-global-prep-cmd": false,
            "elevated": false,
        });

        self.authed(self.http.post(self.endpoint("api/apps")))
            .json(&body)
            .send()
            .await?
            .error_for_status()?;

        self.needs_restart.store(true, Ordering::SeqCst);
        Ok(EnsureOutcome::Created)
    }

    async fn restart_if_needed(&self) -> Result<()> {
        if self.needs_restart.swap(false, Ordering::SeqCst) {
            // Sunshine drops the connection as it restarts; that's expected, so a
            // transport error here isn't fatal.
            let _ = self
                .authed(self.http.post(self.endpoint("api/restart")))
                .send()
                .await;
        }

        Ok(())
    }
}
