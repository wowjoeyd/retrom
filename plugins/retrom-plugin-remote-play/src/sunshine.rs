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
        match self
            .authed(self.http.get(self.endpoint("api/apps")))
            .send()
            .await
        {
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

#[cfg(test)]
mod tests {
    use super::{
        readiness, EnsureOutcome, SunshineApp, SunshineClient, RETROM_APP_NAME,
        RETROM_HOST_AGENT_CMD,
    };
    use crate::error::Result;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    /// In-memory Sunshine test double. Records the apps it's been told to create
    /// so tests can assert idempotency without a real Sunshine.
    struct MockSunshineClient {
        available: bool,
        apps: Mutex<Vec<SunshineApp>>,
        needs_restart: AtomicBool,
        restart_count: AtomicUsize,
    }

    impl MockSunshineClient {
        fn new(available: bool) -> Self {
            Self {
                available,
                apps: Mutex::new(Vec::new()),
                needs_restart: AtomicBool::new(false),
                restart_count: AtomicUsize::new(0),
            }
        }

        fn app_count(&self) -> usize {
            self.apps.lock().unwrap().len()
        }

        fn restart_count(&self) -> usize {
            self.restart_count.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl SunshineClient for MockSunshineClient {
        async fn is_available(&self) -> bool {
            self.available
        }

        async fn list_apps(&self) -> Result<Vec<SunshineApp>> {
            Ok(self.apps.lock().unwrap().clone())
        }

        async fn ensure_retrom_app(&self, host_agent_cmd: &str) -> Result<EnsureOutcome> {
            let mut apps = self.apps.lock().unwrap();
            if apps.iter().any(|app| app.name == RETROM_APP_NAME) {
                return Ok(EnsureOutcome::AlreadyPresent);
            }

            apps.push(SunshineApp {
                name: RETROM_APP_NAME.to_string(),
                cmd: host_agent_cmd.to_string(),
            });
            self.needs_restart.store(true, Ordering::SeqCst);
            Ok(EnsureOutcome::Created)
        }

        async fn restart_if_needed(&self) -> Result<()> {
            if self.needs_restart.swap(false, Ordering::SeqCst) {
                self.restart_count.fetch_add(1, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn ensure_retrom_app_creates_exactly_one_and_is_idempotent() {
        let client = MockSunshineClient::new(true);
        assert_eq!(client.app_count(), 0);

        // First call creates the single managed app.
        let first = client
            .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
            .await
            .unwrap();
        assert_eq!(first, EnsureOutcome::Created);
        assert_eq!(client.app_count(), 1);

        // Second call is a no-op: already present, no duplicate.
        let second = client
            .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
            .await
            .unwrap();
        assert_eq!(second, EnsureOutcome::AlreadyPresent);
        assert_eq!(client.app_count(), 1);

        // Exactly one app, and it's the managed one with the host-agent command.
        let apps = client.list_apps().await.unwrap();
        let retrom_apps: Vec<_> = apps.iter().filter(|a| a.name == RETROM_APP_NAME).collect();
        assert_eq!(retrom_apps.len(), 1);
        assert_eq!(retrom_apps[0].cmd, RETROM_HOST_AGENT_CMD);
    }

    #[tokio::test]
    async fn ensure_retrom_app_never_duplicates_across_many_calls() {
        let client = MockSunshineClient::new(true);
        for _ in 0..5 {
            client
                .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
                .await
                .unwrap();
        }
        assert_eq!(client.app_count(), 1);
    }

    #[tokio::test]
    async fn restart_if_needed_only_restarts_after_a_change() {
        let client = MockSunshineClient::new(true);

        // No change yet => no restart.
        client.restart_if_needed().await.unwrap();
        assert_eq!(client.restart_count(), 0);

        // Creating the app marks a change => exactly one restart, then it clears.
        client
            .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
            .await
            .unwrap();
        client.restart_if_needed().await.unwrap();
        client.restart_if_needed().await.unwrap();
        assert_eq!(client.restart_count(), 1);
    }

    #[tokio::test]
    async fn readiness_reflects_availability_and_managed_app() {
        // Unavailable host: not ready.
        let down = MockSunshineClient::new(false);
        let r = readiness(&down).await;
        assert!(!r.sunshine_available);
        assert!(!r.retrom_app_present);

        // Available but no managed app yet.
        let up = MockSunshineClient::new(true);
        let r = readiness(&up).await;
        assert!(r.sunshine_available);
        assert!(!r.retrom_app_present);

        // After ensuring the app, readiness reports it present.
        up.ensure_retrom_app(RETROM_HOST_AGENT_CMD).await.unwrap();
        let r = readiness(&up).await;
        assert!(r.sunshine_available);
        assert!(r.retrom_app_present);
    }
}
