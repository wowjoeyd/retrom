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

/// Bare host-agent invocation; used as a fallback when the absolute path can't be
/// resolved. [`resolved_host_agent_cmd`] is what the managed app actually uses.
pub const RETROM_HOST_AGENT_CMD: &str = "retrom-host-agent run-pending-session";

fn host_agent_bin_name() -> &'static str {
    #[cfg(windows)]
    {
        "retrom-host-agent.exe"
    }
    #[cfg(not(windows))]
    {
        "retrom-host-agent"
    }
}

/// The managed Sunshine app's command: the absolute path to the bundled
/// `retrom-host-agent` executable (next to this client binary), the
/// `run-pending-session` subcommand, and the host id + broker URL the agent needs
/// to watch the session (so Sunshine keeps streaming until the game exits). Falls
/// back to the bare command name if the path can't be resolved.
pub fn resolved_host_agent_cmd(host_client_id: i32, server_url: &str) -> String {
    let agent = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(host_agent_bin_name())));

    let program = match agent {
        Some(path) => format!("\"{}\"", path.display()),
        None => "retrom-host-agent".to_string(),
    };

    format!("{program} run-pending-session --host-id {host_client_id} --server {server_url}")
}

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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnsureOutcome {
    /// The managed app was missing and has been created (POSTed with index -1).
    Created,
    /// The managed app existed but had a stale command and was updated in place
    /// (POSTed with its current index).
    Updated,
    /// The managed app already existed and was current; nothing changed.
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

    /// List the apps Sunshine currently knows about, in index order.
    async fn list_apps(&self) -> Result<Vec<SunshineApp>>;

    /// Save (create or update) an application via Sunshine's "save application"
    /// endpoint (`POST /api/apps`). Per the Sunshine API, `index` must be `-1` to
    /// create a new app, or the app's current index (its position in
    /// [`list_apps`](Self::list_apps)) to update an existing one.
    async fn save_app(&self, app: &SunshineApp, index: i32) -> Result<()>;

    /// Restart Sunshine if a previous call made a change that requires it.
    async fn restart_if_needed(&self) -> Result<()>;

    /// Idempotently ensure the single managed "Retrom Remote Play" app exists and
    /// runs `host_agent_cmd`: create it (index `-1`) when missing, update it at
    /// its current index when the command is stale, and do nothing when it's
    /// already correct. Never creates per-game apps and never duplicates the
    /// managed app.
    ///
    /// This is a shared default so the real client and the test mock exercise the
    /// exact same create-vs-update index logic.
    async fn ensure_retrom_app(&self, host_agent_cmd: &str) -> Result<EnsureOutcome> {
        let apps = self.list_apps().await?;

        match apps.iter().position(|app| app.name == RETROM_APP_NAME) {
            // Missing: create. The Sunshine API requires index -1 for a new app.
            None => {
                self.save_app(&managed_app(host_agent_cmd), -1).await?;
                Ok(EnsureOutcome::Created)
            }
            // Present and current: nothing to do.
            Some(index) if apps[index].cmd == host_agent_cmd => Ok(EnsureOutcome::AlreadyPresent),
            // Present but stale: update in place, reusing its current index.
            Some(index) => {
                self.save_app(&managed_app(host_agent_cmd), index as i32)
                    .await?;
                Ok(EnsureOutcome::Updated)
            }
        }
    }
}

/// The managed "Retrom Remote Play" app definition for a given host-agent command.
fn managed_app(host_agent_cmd: &str) -> SunshineApp {
    SunshineApp {
        name: RETROM_APP_NAME.to_string(),
        cmd: host_agent_cmd.to_string(),
    }
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

    async fn save_app(&self, app: &SunshineApp, index: i32) -> Result<()> {
        // Per the Sunshine "save application" endpoint, `index` is -1 to create a
        // new app or the app's current index to update an existing one.
        let body = serde_json::json!({
            "index": index,
            "name": app.name,
            "cmd": app.cmd,
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
        Ok(())
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

    /// A recorded `save_app` request, so tests can assert the index that the
    /// shared `ensure_retrom_app` logic chose for create vs. update.
    #[derive(Debug, Clone)]
    struct RecordedSave {
        app: SunshineApp,
        index: i32,
    }

    /// In-memory Sunshine test double. Applies and records the `save_app` requests
    /// it receives so tests can assert behavior without a real Sunshine.
    struct MockSunshineClient {
        available: bool,
        apps: Mutex<Vec<SunshineApp>>,
        saves: Mutex<Vec<RecordedSave>>,
        needs_restart: AtomicBool,
        restart_count: AtomicUsize,
    }

    impl MockSunshineClient {
        fn new(available: bool) -> Self {
            Self::with_apps(available, Vec::new())
        }

        /// Seed the mock with a pre-existing app list (in index order).
        fn with_apps(available: bool, apps: Vec<SunshineApp>) -> Self {
            Self {
                available,
                apps: Mutex::new(apps),
                saves: Mutex::new(Vec::new()),
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

        fn saves(&self) -> Vec<RecordedSave> {
            self.saves.lock().unwrap().clone()
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

        async fn save_app(&self, app: &SunshineApp, index: i32) -> Result<()> {
            self.saves.lock().unwrap().push(RecordedSave {
                app: app.clone(),
                index,
            });

            // Apply the save the way Sunshine would, so list_apps reflects it.
            let mut apps = self.apps.lock().unwrap();
            if index < 0 {
                apps.push(app.clone());
            } else if let Some(slot) = apps.get_mut(index as usize) {
                *slot = app.clone();
            } else {
                apps.push(app.clone());
            }

            self.needs_restart.store(true, Ordering::SeqCst);
            Ok(())
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

    #[tokio::test]
    async fn create_call_uses_index_minus_one() {
        let client = MockSunshineClient::new(true);

        let outcome = client
            .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
            .await
            .unwrap();
        assert_eq!(outcome, EnsureOutcome::Created);

        // The recorded save proves a new app is created with index -1.
        let saves = client.saves();
        assert_eq!(saves.len(), 1);
        assert_eq!(saves[0].index, -1, "a new app must be saved with index -1");
        assert_eq!(saves[0].app.name, RETROM_APP_NAME);
        assert_eq!(saves[0].app.cmd, RETROM_HOST_AGENT_CMD);
    }

    #[tokio::test]
    async fn update_call_uses_existing_index() {
        // Seed Sunshine with another app first, then the managed app at index 1
        // with a stale command.
        let client = MockSunshineClient::with_apps(
            true,
            vec![
                SunshineApp {
                    name: "Desktop".to_string(),
                    cmd: String::new(),
                },
                SunshineApp {
                    name: RETROM_APP_NAME.to_string(),
                    cmd: "stale-command".to_string(),
                },
            ],
        );

        let outcome = client
            .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
            .await
            .unwrap();
        assert_eq!(outcome, EnsureOutcome::Updated);

        // The recorded save proves an update reuses the app's current index (1),
        // not -1.
        let saves = client.saves();
        assert_eq!(saves.len(), 1);
        assert_eq!(
            saves[0].index, 1,
            "an update must reuse the app's current index"
        );
        assert_eq!(saves[0].app.cmd, RETROM_HOST_AGENT_CMD);

        // Still exactly one managed app, now with the new command (no duplicate).
        let apps = client.list_apps().await.unwrap();
        assert_eq!(apps.iter().filter(|a| a.name == RETROM_APP_NAME).count(), 1);
        assert_eq!(apps[1].cmd, RETROM_HOST_AGENT_CMD);
    }

    #[tokio::test]
    async fn already_current_app_is_not_re_saved() {
        let client = MockSunshineClient::with_apps(
            true,
            vec![SunshineApp {
                name: RETROM_APP_NAME.to_string(),
                cmd: RETROM_HOST_AGENT_CMD.to_string(),
            }],
        );

        let outcome = client
            .ensure_retrom_app(RETROM_HOST_AGENT_CMD)
            .await
            .unwrap();
        assert_eq!(outcome, EnsureOutcome::AlreadyPresent);
        assert!(
            client.saves().is_empty(),
            "no save call when the managed app is already correct"
        );
    }
}
