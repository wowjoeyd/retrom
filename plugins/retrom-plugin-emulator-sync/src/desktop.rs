use crate::sync_state::{
    load_sync_state, save_sync_state, SyncState, UserDataFileState, SYNC_STATE_FILE_NAME,
};
use prost::Message;
use reqwest::header::{HeaderMap, HeaderValue, ACCESS_CONTROL_ALLOW_ORIGIN};
use retrom_codegen::{
    retrom::{
        client::emulator_sync::{
            AnalyzeEmulatorUserDataResponse, EmulatorSyncIndex, EmulatorSyncMetrics,
            EmulatorSyncProgressUpdate, EmulatorSyncStatus,
        },
        emulator::OperatingSystem,
        Client, EmulatorPackage, EmulatorPackageFile, GetEmulatorPackageFilesRequest,
        GetEmulatorPackagesRequest, GetLocalEmulatorConfigsRequest, LocalEmulatorConfig,
        UpdateLocalEmulatorConfigsRequest, UpdatedLocalEmulatorConfig,
    },
    timestamp::Timestamp,
};
use retrom_download::{stream_to_file, StreamControl};
use retrom_plugin_config::ConfigExt;
use retrom_plugin_service_client::RetromPluginServiceClientExt;
use serde::de::DeserializeOwned;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, plugin::PluginApi, AppHandle, Runtime};
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
pub const MANIFEST_FILE_NAME: &str = "retrom-emulator-package.json";

#[derive(Default)]
pub struct PreservePushResult {
    pub files_uploaded: u32,
    pub bytes_uploaded: u64,
}

type EmulatorId = i32;

#[derive(Debug, Clone)]
struct SyncProgress {
    emulator_id: EmulatorId,
    status: i32,
    metrics: Option<EmulatorSyncMetrics>,
}

pub struct EmulatorSyncManager<R: Runtime> {
    app_handle: AppHandle<R>,
    http_client: reqwest::Client,
    sync_index: RwLock<HashMap<EmulatorId, SyncProgress>>,
    update_subscriptions: RwLock<Vec<Channel<&'static [u8]>>>,
    abort_flags: RwLock<HashMap<EmulatorId, Arc<AtomicBool>>>,
}

#[derive(Debug, serde::Deserialize)]
struct PackageManifest {
    #[serde(default)]
    preserve_paths: Vec<String>,
    #[serde(default)]
    user_data_paths: Vec<String>,
}

/// The OS this client runs on, as a proto `Emulator.OperatingSystem` value.
fn client_os() -> i32 {
    match std::env::consts::OS {
        "windows" => OperatingSystem::Windows as i32,
        "macos" => OperatingSystem::Macos as i32,
        // linux and any other unix-like fall back to the linux build
        _ => OperatingSystem::LinuxX8664 as i32,
    }
}

fn os_label(os: i32) -> &'static str {
    match OperatingSystem::try_from(os) {
        Ok(OperatingSystem::Windows) => "Windows",
        Ok(OperatingSystem::Macos) => "macOS",
        Ok(OperatingSystem::LinuxX8664) => "Linux",
        Ok(OperatingSystem::Wasm) => "WASM",
        Err(_) => "unknown",
    }
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<EmulatorSyncManager<R>> {
    Ok(EmulatorSyncManager {
        app_handle: app.clone(),
        http_client: reqwest::Client::new(),
        sync_index: RwLock::new(HashMap::new()),
        update_subscriptions: RwLock::new(Vec::new()),
        abort_flags: RwLock::new(HashMap::new()),
    })
}

impl<R: Runtime> EmulatorSyncManager<R> {
    pub(crate) fn sync_enabled() -> bool {
        match std::env::var("EMULATOR_PACKAGE_SYNC") {
            Ok(value) => !matches!(value.to_ascii_lowercase().as_str(), "false" | "0" | "no"),
            Err(_) => true,
        }
    }

    async fn client_id(&self) -> crate::Result<i32> {
        let config = self.app_handle.config_manager().get_config().await.config;
        let Some(Client { id, .. }) = config.and_then(|c| c.client_info) else {
            return Err(crate::Error::Internal(
                "Client info is not set in the configuration".into(),
            ));
        };
        Ok(id)
    }

    async fn service_host(&self) -> crate::Result<String> {
        let client_config = self.app_handle.config_manager().get_config().await;
        Ok(match client_config.server {
            Some(server) => {
                let mut host = server.hostname;
                if let Some(port) = server.port {
                    host.push_str(&format!(":{port}"));
                }
                host
            }
            None => {
                tracing::warn!("No server configuration found");
                "http://localhost:5101".to_string()
            }
        })
    }

    async fn get_local_config(
        &self,
        emulator_id: EmulatorId,
    ) -> crate::Result<LocalEmulatorConfig> {
        let client_id = self.client_id().await?;
        let mut emulator_client = self.app_handle.get_emulator_client().await;
        let response = emulator_client
            .get_local_emulator_configs(GetLocalEmulatorConfigsRequest {
                emulator_ids: vec![emulator_id],
                client_id,
            })
            .await?
            .into_inner();

        response
            .configs
            .into_iter()
            .find(|config| config.emulator_id == emulator_id)
            .ok_or_else(|| {
                crate::Error::Internal(format!(
                    "No local emulator config for emulator {emulator_id}"
                ))
            })
    }

    async fn resolve_package_by_id(&self, package_id: i32) -> crate::Result<EmulatorPackage> {
        let mut package_client = self.app_handle.get_emulator_package_client().await;
        let response = package_client
            .get_emulator_packages(GetEmulatorPackagesRequest {
                ids: vec![package_id],
                package_slug: None,
                catalog_id: None,
                operating_system: None,
            })
            .await?
            .into_inner();

        response
            .packages
            .into_iter()
            .find(|package| package.id == package_id)
            .ok_or_else(|| {
                crate::Error::Internal(format!("Emulator package {package_id} not found"))
            })
    }

    /// Resolve the package this client should actually pull and run: the build
    /// for this client's OS, sharing the linked package's slug. Prefers the exact
    /// pinned version, then the latest build for this OS. The linked package is
    /// the per-client pin, which may have been created for another OS (e.g. the
    /// server's host OS at install time), so this is what makes a Windows desktop
    /// pull the Windows build off a Linux server.
    async fn resolve_package_for_os(
        &self,
        linked_package_id: i32,
    ) -> crate::Result<EmulatorPackage> {
        let linked = self.resolve_package_by_id(linked_package_id).await?;
        let my_os = client_os();

        if linked.os == my_os {
            return Ok(linked);
        }

        let mut package_client = self.app_handle.get_emulator_package_client().await;
        let response = package_client
            .get_emulator_packages(GetEmulatorPackagesRequest {
                ids: vec![],
                package_slug: Some(linked.package_slug.clone()),
                catalog_id: None,
                operating_system: Some(my_os),
            })
            .await?
            .into_inner();

        let latest_id = response
            .latest_package_id_by_slug
            .get(&linked.package_slug)
            .copied();

        let candidates: Vec<EmulatorPackage> = response
            .packages
            .into_iter()
            .filter(|p| p.os == my_os && !p.is_deleted)
            .collect();

        candidates
            .iter()
            .find(|p| p.version == linked.version)
            .or_else(|| latest_id.and_then(|id| candidates.iter().find(|p| p.id == id)))
            .or_else(|| candidates.first())
            .cloned()
            .ok_or_else(|| {
                crate::Error::Internal(format!(
                    "No {} build available for this client's OS ({}). \
                     Installed builds target other operating systems — \
                     re-install with {} included in the server's emulator package OS list.",
                    linked.display_name,
                    os_label(my_os),
                    os_label(my_os),
                ))
            })
    }

    async fn get_package_files(&self, package_id: i32) -> crate::Result<Vec<EmulatorPackageFile>> {
        let mut package_client = self.app_handle.get_emulator_package_client().await;
        let response = package_client
            .get_emulator_package_files(GetEmulatorPackageFilesRequest { package_id })
            .await?
            .into_inner();
        Ok(response.files)
    }

    async fn fetch_and_write_manifest(
        &self,
        package: &EmulatorPackage,
        cache_root: &Path,
    ) -> crate::Result<()> {
        let host = self.service_host().await?;
        let manifest_url = format!("{host}/rest/emulator-package-file/{}/manifest", package.id);

        let resp = self
            .http_client
            .get(&manifest_url)
            .send()
            .await
            .map_err(|e| {
                crate::Error::Internal(format!(
                    "Failed to fetch manifest for package {}: {e}",
                    package.id
                ))
            })?;

        if !resp.status().is_success() {
            return Err(crate::Error::Internal(format!(
                "Manifest fetch for package {} returned status {}",
                package.id,
                resp.status()
            )));
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| crate::Error::Internal(format!("Failed to read manifest bytes: {e}")))?;

        let dest = cache_root.join(MANIFEST_FILE_NAME);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest, &bytes)?;
        Ok(())
    }

    async fn latest_package_id_for_slug(&self, slug: &str) -> crate::Result<Option<i32>> {
        let mut package_client = self.app_handle.get_emulator_package_client().await;
        let response = package_client
            .get_emulator_packages(GetEmulatorPackagesRequest {
                ids: vec![],
                package_slug: Some(slug.to_string()),
                catalog_id: None,
                operating_system: Some(client_os()),
            })
            .await?
            .into_inner();

        Ok(response.latest_package_id_by_slug.get(slug).copied())
    }

    pub async fn get_emulator_sync_status(
        &self,
        emulator_id: EmulatorId,
    ) -> crate::Result<EmulatorSyncStatus> {
        if let Some(progress) = self.sync_index.read().await.get(&emulator_id) {
            if progress.status == EmulatorSyncStatus::Syncing as i32 {
                return Ok(EmulatorSyncStatus::Syncing);
            }
        }

        let local_config = self.get_local_config(emulator_id).await?;
        if !local_config.managed_paths {
            return Ok(EmulatorSyncStatus::Synced);
        }

        let Some(linked_package_id) = local_config.linked_package_id else {
            return Ok(EmulatorSyncStatus::NotCached);
        };

        let package = self.resolve_package_for_os(linked_package_id).await?;
        if let Some(latest_id) = self
            .latest_package_id_for_slug(&package.package_slug)
            .await?
        {
            if latest_id != package.id {
                return Ok(EmulatorSyncStatus::OutOfDate);
            }
        }

        let cache_root = self.cache_root_for_package(&package).await?;
        let remote_files = self.get_package_files(package.id).await?;

        if self.files_need_sync(&cache_root, package.id, &package.version, &remote_files)? {
            Ok(EmulatorSyncStatus::NotCached)
        } else {
            Ok(EmulatorSyncStatus::Synced)
        }
    }

    pub async fn get_emulator_sync_index(&self) -> crate::Result<EmulatorSyncIndex> {
        let client_id = self.client_id().await?;
        let mut emulator_client = self.app_handle.get_emulator_client().await;
        let response = emulator_client
            .get_local_emulator_configs(GetLocalEmulatorConfigsRequest {
                emulator_ids: vec![],
                client_id,
            })
            .await?
            .into_inner();

        let mut emulators = HashMap::new();
        for config in response.configs {
            if !config.managed_paths {
                continue;
            }
            let status = self.get_emulator_sync_status(config.emulator_id).await?;
            emulators.insert(config.emulator_id, status as i32);
        }

        Ok(EmulatorSyncIndex { emulators })
    }

    pub async fn ensure_emulator_synced(&self, emulator_id: EmulatorId) -> crate::Result<PathBuf> {
        let local_config = self.get_local_config(emulator_id).await?;

        if !local_config.managed_paths {
            return Ok(PathBuf::from(local_config.executable_path));
        }

        if !Self::sync_enabled() {
            return Ok(PathBuf::from(local_config.executable_path));
        }

        let linked_package_id = local_config
            .linked_package_id
            .ok_or(crate::Error::EmulatorPackageNotLinked(emulator_id))?;

        let abort_flag = Arc::new(AtomicBool::new(false));
        self.abort_flags
            .write()
            .await
            .insert(emulator_id, abort_flag.clone());

        let result = self
            .run_sync(emulator_id, &local_config, linked_package_id, abort_flag)
            .await;

        self.abort_flags.write().await.remove(&emulator_id);

        result
    }

    async fn run_sync(
        &self,
        emulator_id: EmulatorId,
        local_config: &LocalEmulatorConfig,
        linked_package_id: i32,
        abort_flag: Arc<AtomicBool>,
    ) -> crate::Result<PathBuf> {
        let package = self.resolve_package_for_os(linked_package_id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;

        // Always fetch the latest manifest first so preserve_paths / user_data_paths
        // are available for decisions.
        self.fetch_and_write_manifest(&package, &cache_root).await?;
        self.migrate_user_data_from_previous_cache(local_config, &cache_root)
            .await?;

        let remote_files = self.get_package_files(package.id).await?;
        let total_bytes: u64 = remote_files.iter().map(|file| file.byte_size as u64).sum();

        // Automatic cloud sync *up* for shareable user data (firmware, keys, RAPs,
        // installed games/roms inside the emulator, etc.). After the user has used
        // the explicit push to promote a local setup as the NAS source of truth,
        // subsequent launches will push any new local changes in the user_data paths.
        // This makes "rom installs, rap files, etc." flow to the server like other
        // cloud sync, while PC-specific config (if excluded from user_data_paths in
        // the catalog) stays local.
        if let Err(why) = self.push_preserve_data(emulator_id).await {
            tracing::warn!("Auto-push of emulator user data failed before launch: {why}");
        }

        self.set_progress(
            emulator_id,
            EmulatorSyncStatus::Syncing,
            Some(EmulatorSyncMetrics {
                bytes_per_second: 0.0,
                bytes_transferred: 0,
                total_bytes,
                percent_complete: 0,
                updated_at: Some(SystemTime::now().into()),
            }),
        )
        .await;

        let host = self.service_host().await?;
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_str(&host).map_err(|why| {
                crate::Error::Internal(format!("Invalid download header value: {why}"))
            })?,
        );

        let mut bytes_transferred: u64 = 0;
        let previous_state = load_sync_state(&cache_root)?;
        let mut synced_files = previous_state
            .as_ref()
            .map(|state| state.files.clone())
            .unwrap_or_default();

        // Track files that the server package has ever declared for this version.
        // This is used by prune to only remove "stale package files" (things that
        // used to be part of the declared emulator package on the NAS) rather than
        // blindly deleting any local file not present in the current remote list.
        // Result: files the running emulator or user creates (firmware, new RAPs,
        // installed games, keys, etc. in dirs the catalog didn't perfectly anticipate)
        // survive repeated syncs, while still allowing the package definition to
        // drive cleanup of obsolete declared files on updates.
        let previous_known: HashSet<String> = synced_files.keys().cloned().collect();

        for file in &remote_files {
            if abort_flag.load(Ordering::Relaxed) {
                self.set_progress(emulator_id, EmulatorSyncStatus::Failed, None)
                    .await;
                return Err(crate::Error::SyncAborted);
            }

            if synced_files.get(&file.relative_path) == Some(&file.sha256)
                && cache_root.join(&file.relative_path).exists()
            {
                continue;
            }

            if self.should_skip_preserved_file(
                &cache_root,
                &file.relative_path,
                Some(local_config.preserve_paths_override.clone()),
            )? {
                synced_files.insert(file.relative_path.clone(), file.sha256.clone());
                continue;
            }

            let download_uri = format!("{host}/rest/emulator-package-file/{}", file.id);
            let dest = cache_root.join(&file.relative_path);

            let downloaded = stream_to_file(
                &self.http_client,
                &download_uri,
                &dest,
                Some(&headers),
                |_| {},
                || {
                    if abort_flag.load(Ordering::Relaxed) {
                        StreamControl::Abort
                    } else {
                        StreamControl::Continue
                    }
                },
            )
            .await?;

            bytes_transferred = bytes_transferred.saturating_add(downloaded);
            let percent = if total_bytes == 0 {
                100
            } else {
                ((bytes_transferred as f64 / total_bytes as f64) * 100.0) as u32
            };

            self.set_progress(
                emulator_id,
                EmulatorSyncStatus::Syncing,
                Some(EmulatorSyncMetrics {
                    bytes_per_second: 0.0,
                    bytes_transferred,
                    total_bytes,
                    percent_complete: percent.min(100),
                    updated_at: Some(SystemTime::now().into()),
                }),
            )
            .await;

            synced_files.insert(file.relative_path.clone(), file.sha256.clone());
        }

        let preserve_paths = self.read_preserve_paths(
            &cache_root,
            Some(local_config.preserve_paths_override.clone()),
        )?;
        self.prune_stale_files(&cache_root, &remote_files, &preserve_paths, &previous_known)?;

        save_sync_state(
            &cache_root,
            &SyncState {
                linked_package_id: package.id,
                version: package.version.clone(),
                files: synced_files,
                user_data_files: previous_state
                    .as_ref()
                    .map(|state| state.user_data_files.clone())
                    .unwrap_or_default(),
                last_user_data_sync_unix_secs: previous_state
                    .and_then(|state| state.last_user_data_sync_unix_secs),
            },
        )?;

        let executable = cache_root.join(&package.executable_rel);
        self.update_executable_path(local_config, &executable)
            .await?;

        self.set_progress(
            emulator_id,
            EmulatorSyncStatus::Synced,
            Some(EmulatorSyncMetrics {
                bytes_per_second: 0.0,
                bytes_transferred: total_bytes,
                total_bytes,
                percent_complete: 100,
                updated_at: Some(SystemTime::now().into()),
            }),
        )
        .await;

        Ok(executable)
    }

    fn files_need_sync(
        &self,
        cache_root: &Path,
        linked_package_id: i32,
        version: &str,
        remote_files: &[EmulatorPackageFile],
    ) -> crate::Result<bool> {
        let Some(state) = load_sync_state(cache_root)? else {
            return Ok(true);
        };

        if state.linked_package_id != linked_package_id || state.version != version {
            return Ok(true);
        }

        for file in remote_files {
            if state.files.get(&file.relative_path) != Some(&file.sha256) {
                return Ok(true);
            }
            if !cache_root.join(&file.relative_path).exists() {
                return Ok(true);
            }
        }

        Ok(false)
    }

    fn should_skip_preserved_file(
        &self,
        cache_root: &Path,
        relative_path: &str,
        override_paths: Option<Vec<String>>,
    ) -> crate::Result<bool> {
        let preserve_paths = self.read_preserve_paths(cache_root, override_paths)?;
        let dest = cache_root.join(relative_path);
        if !dest.exists() {
            return Ok(false);
        }

        let is_preserved = preserve_paths
            .iter()
            .any(|prefix| relative_path.starts_with(prefix.trim_end_matches('/')));
        if !is_preserved {
            return Ok(false);
        }

        let local_modified = dest.metadata().and_then(|meta| meta.modified()).ok();
        Ok(local_modified.is_some())
    }

    fn read_preserve_paths(
        &self,
        cache_root: &Path,
        override_paths: Option<Vec<String>>,
    ) -> crate::Result<Vec<String>> {
        if let Some(ov) = override_paths {
            if !ov.is_empty() {
                return Ok(ov);
            }
        }
        let manifest_path = cache_root.join(MANIFEST_FILE_NAME);
        if !manifest_path.exists() {
            return Ok(Vec::new());
        }

        let data = std::fs::read_to_string(manifest_path)?;
        let manifest: PackageManifest = serde_json::from_str(&data)?;
        Ok(manifest.preserve_paths)
    }

    /// Returns the paths to treat as shareable user data for cloud sync / push
    /// (firmware, keys, RAPs, installed games etc.). Falls back to preserve_paths
    /// for packages created before user_data_paths was added.
    fn read_user_data_paths(
        &self,
        cache_root: &Path,
        override_paths: Option<Vec<String>>,
    ) -> crate::Result<Vec<String>> {
        if let Some(ov) = override_paths {
            if !ov.is_empty() {
                return Ok(ov);
            }
        }
        let manifest_path = cache_root.join(MANIFEST_FILE_NAME);
        if !manifest_path.exists() {
            return Ok(Vec::new());
        }

        let data = std::fs::read_to_string(manifest_path)?;
        let manifest: PackageManifest = serde_json::from_str(&data)?;
        if !manifest.user_data_paths.is_empty() {
            Ok(manifest.user_data_paths)
        } else {
            Ok(manifest.preserve_paths)
        }
    }

    async fn migrate_user_data_from_previous_cache(
        &self,
        local_config: &LocalEmulatorConfig,
        cache_root: &Path,
    ) -> crate::Result<()> {
        let previous_executable = PathBuf::from(&local_config.executable_path);
        let Some(previous_root) = previous_executable
            .parent()
            .and_then(Self::find_manifest_root)
        else {
            return Ok(());
        };

        if previous_root == cache_root {
            return Ok(());
        }

        let user_data_paths = self.read_user_data_paths(
            cache_root,
            Some(local_config.user_data_paths_override.clone()),
        )?;
        if user_data_paths.is_empty() {
            return Ok(());
        }

        let mut copied = 0u64;
        for rel in user_data_paths {
            let source_root = previous_root.join(&rel);
            if !source_root.exists() {
                continue;
            }

            if source_root.is_file() {
                let dest = cache_root.join(&rel);
                if !dest.exists() {
                    if let Some(parent) = dest.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::copy(&source_root, &dest)?;
                    copied = copied.saturating_add(1);
                }
                continue;
            }

            for entry in walkdir::WalkDir::new(&source_root)
                .follow_links(false)
                .into_iter()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_type().is_file())
            {
                let source = entry.path();
                let relative = source.strip_prefix(&previous_root).unwrap_or(source);
                let dest = cache_root.join(relative);
                if dest.exists() {
                    continue;
                }
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::copy(source, &dest)?;
                copied = copied.saturating_add(1);
            }
        }

        if copied > 0 {
            tracing::info!(
                "Migrated {copied} emulator user data file(s) from {} to {}",
                previous_root.display(),
                cache_root.display()
            );
        }

        Ok(())
    }

    fn find_manifest_root(start: &Path) -> Option<PathBuf> {
        let mut current = Some(start);
        while let Some(path) = current {
            if path.join(MANIFEST_FILE_NAME).exists() {
                return Some(path.to_path_buf());
            }
            current = path.parent();
        }
        None
    }

    // Small sha helper for push comparisons (mirrors server emit + client needs).
    fn sha256_file(path: &Path) -> std::io::Result<String> {
        use sha2::{Digest, Sha256};
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 8192];
        loop {
            let n = std::io::Read::read(&mut file, &mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    }

    fn modified_unix_secs(path: &Path) -> u64 {
        path.metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs())
            .unwrap_or_default()
    }

    fn user_data_max_walk_files() -> u64 {
        std::env::var("EMULATOR_USER_DATA_MAX_WALK_FILES")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(20_000)
    }

    fn user_data_large_warning_bytes() -> u64 {
        std::env::var("EMULATOR_USER_DATA_LARGE_WARNING_BYTES")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(25 * 1024 * 1024 * 1024)
    }

    fn prune_stale_files(
        &self,
        cache_root: &Path,
        remote_files: &[EmulatorPackageFile],
        preserve_paths: &[String],
        previous_known_package_files: &HashSet<String>,
    ) -> crate::Result<()> {
        let remote_paths: HashSet<String> = remote_files
            .iter()
            .map(|file| file.relative_path.clone())
            .collect();

        for entry in walkdir::WalkDir::new(cache_root)
            .follow_links(false)
            .into_iter()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_file())
        {
            let path = entry.path();
            let relative = path
                .strip_prefix(cache_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            if relative == SYNC_STATE_FILE_NAME || relative == MANIFEST_FILE_NAME {
                continue;
            }

            if preserve_paths
                .iter()
                .any(|prefix| relative.starts_with(prefix.trim_end_matches('/')))
            {
                continue;
            }

            // Only prune files that the server package previously declared for this
            // exact version. Purely local creations (firmware blobs, new keys, RAPs,
            // game installs, emulator-generated caches, etc. that were never part of
            // the NAS package manifest) are left alone. This is the key to making
            // real-world "install once, it stays" work without requiring perfect
            // preserve_paths coverage in every catalog entry.
            if previous_known_package_files.contains(&relative) && !remote_paths.contains(&relative)
            {
                std::fs::remove_file(path)?;
            }
        }

        Ok(())
    }

    async fn cache_root_for_package(&self, package: &EmulatorPackage) -> crate::Result<PathBuf> {
        let cache_dir = self
            .app_handle
            .config_manager()
            .get_emulator_cache_dir()
            .await?;
        let cache_root = cache_dir.join(&package.package_slug).join(&package.version);
        std::fs::create_dir_all(&cache_root)?;
        Ok(cache_root)
    }

    async fn update_executable_path(
        &self,
        local_config: &LocalEmulatorConfig,
        executable: &Path,
    ) -> crate::Result<()> {
        let mut emulator_client = self.app_handle.get_emulator_client().await;
        emulator_client
            .update_local_emulator_configs(UpdateLocalEmulatorConfigsRequest {
                configs: vec![UpdatedLocalEmulatorConfig {
                    id: local_config.id,
                    executable_path: Some(executable.to_string_lossy().to_string()),
                    updated_at: Some(Timestamp::from(SystemTime::now())),
                    ..Default::default()
                }],
            })
            .await?;
        Ok(())
    }

    pub async fn abort_emulator_sync(&self, emulator_id: EmulatorId) -> crate::Result<()> {
        if let Some(flag) = self.abort_flags.read().await.get(&emulator_id) {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(())
    }

    pub async fn open_emulator_cache_dir(&self) -> crate::Result<PathBuf> {
        self.app_handle
            .config_manager()
            .get_emulator_cache_dir()
            .await
            .map_err(Into::into)
    }

    /// Pushes local files under the package's user_data_paths (or preserve_paths
    /// fallback) from the client cache up to the NAS package tree.
    ///
    /// This is the "promote my local setup as the cloud source of truth" action for
    /// the shareable assets (firmware, decryption keys, RAPs, installed titles/games,
    /// etc.). Config/ and other PC-specific settings are intentionally left out when
    /// the catalog uses separate user_data_paths.
    ///
    /// Only files whose local content sha differs from (or is absent in) the current
    /// indexed remote files are uploaded. The upload handler keeps the DB file list
    /// live so other clients see the changes on their next ensure without a full rescan.
    pub async fn push_preserve_data(
        &self,
        emulator_id: EmulatorId,
    ) -> crate::Result<PreservePushResult> {
        let local_config = self.get_local_config(emulator_id).await?;
        if !local_config.managed_paths {
            return Ok(PreservePushResult::default());
        }

        let Some(linked_package_id) = local_config.linked_package_id else {
            return Err(crate::Error::EmulatorPackageNotLinked(emulator_id));
        };

        let package = self.resolve_package_for_os(linked_package_id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;

        // Ensure we have up-to-date manifest (also ensures cache has it)
        self.fetch_and_write_manifest(&package, &cache_root).await?;

        let push_paths = self.read_user_data_paths(
            &cache_root,
            Some(local_config.user_data_paths_override.clone()),
        )?;
        if push_paths.is_empty() {
            return Ok(PreservePushResult::default());
        }

        let remote_files = self.get_package_files(package.id).await?;
        let remote_sha: HashMap<String, String> = remote_files
            .into_iter()
            .map(|f| (f.relative_path, f.sha256))
            .collect();
        let mut sync_state = load_sync_state(&cache_root)?.unwrap_or_else(|| SyncState {
            linked_package_id: package.id,
            version: package.version.clone(),
            ..Default::default()
        });
        sync_state.linked_package_id = package.id;
        sync_state.version = package.version.clone();

        let host = self.service_host().await?;

        let mut uploaded: u32 = 0;
        let mut bytes: u64 = 0;
        let mut scanned: u64 = 0;
        let mut bytes_scanned: u64 = 0;
        let mut large_warning_logged = false;
        let max_walk_files = Self::user_data_max_walk_files();
        let large_warning_bytes = Self::user_data_large_warning_bytes();

        self.set_progress(
            emulator_id,
            EmulatorSyncStatus::Syncing,
            Some(EmulatorSyncMetrics {
                bytes_per_second: 0.0,
                bytes_transferred: 0,
                total_bytes: 0,
                percent_complete: 0,
                updated_at: Some(SystemTime::now().into()),
            }),
        )
        .await;

        // Walk only under the shareable user data paths (firmware, keys, raps, games etc.)
        for entry in walkdir::WalkDir::new(&cache_root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            let relative = path
                .strip_prefix(&cache_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            if relative == SYNC_STATE_FILE_NAME || relative == MANIFEST_FILE_NAME {
                continue;
            }

            let is_user_data = push_paths
                .iter()
                .any(|prefix| relative.starts_with(prefix.trim_end_matches('/')));
            if !is_user_data {
                continue;
            }
            scanned = scanned.saturating_add(1);
            if scanned > max_walk_files {
                tracing::warn!(
                    "Emulator user data push stopped after {max_walk_files} files for emulator {emulator_id}; set EMULATOR_USER_DATA_MAX_WALK_FILES to raise the cap"
                );
                break;
            }

            let metadata = path.metadata()?;
            let byte_size = metadata.len();
            let modified_unix_secs = Self::modified_unix_secs(path);
            bytes_scanned = bytes_scanned.saturating_add(byte_size);
            if !large_warning_logged && bytes_scanned > large_warning_bytes {
                large_warning_logged = true;
                tracing::warn!(
                    "Emulator user data under {} exceeds {} bytes for emulator {emulator_id}",
                    cache_root.display(),
                    large_warning_bytes
                );
            }

            if let Some(cached) = sync_state.user_data_files.get(&relative) {
                if cached.byte_size == byte_size
                    && cached.modified_unix_secs == modified_unix_secs
                    && remote_sha.get(&relative) == Some(&cached.sha256)
                {
                    continue;
                }
            }

            let local_sha = Self::sha256_file(path)
                .map_err(|e| crate::Error::Internal(format!("sha for {}: {e}", relative)))?;

            let needs_push = match remote_sha.get(&relative) {
                Some(r) if r == &local_sha => false,
                _ => true,
            };

            if needs_push {
                let upload_url =
                    format!("{host}/rest/emulator-package-file/preserve/{}", package.id);

                let content = std::fs::read(path)?;
                self.upload_preserve_file_with_retry(&upload_url, &relative, content.clone())
                    .await?;

                uploaded += 1;
                bytes = bytes.saturating_add(content.len() as u64);

                self.set_progress(
                    emulator_id,
                    EmulatorSyncStatus::Syncing,
                    Some(EmulatorSyncMetrics {
                        bytes_per_second: 0.0,
                        bytes_transferred: bytes,
                        total_bytes: bytes,
                        percent_complete: 100,
                        updated_at: Some(SystemTime::now().into()),
                    }),
                )
                .await;
            }

            sync_state.user_data_files.insert(
                relative,
                UserDataFileState {
                    sha256: local_sha,
                    byte_size,
                    modified_unix_secs,
                },
            );
        }

        // Deletion support in up-sync (push local as truth): if a user data file
        // is present in the cloud index but no longer exists locally, delete it
        // on the NAS so the cloud exactly matches this local instance.
        for (rel, _) in &remote_sha {
            let is_user_data = push_paths
                .iter()
                .any(|prefix| rel.starts_with(prefix.trim_end_matches('/')));
            if is_user_data && !cache_root.join(rel).exists() {
                let delete_url =
                    format!("{host}/rest/emulator-package-file/preserve/{}", package.id);
                let _ = self
                    .http_client
                    .delete(&delete_url)
                    .query(&[("relative_path", rel.as_str())])
                    .send()
                    .await;
                sync_state.user_data_files.remove(rel);
            }
        }

        sync_state.last_user_data_sync_unix_secs = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or_default(),
        );
        save_sync_state(&cache_root, &sync_state)?;

        tracing::info!(
            "Emulator user data push complete for emulator {emulator_id}: scanned {scanned}, scanned_bytes {bytes_scanned}, uploaded {uploaded}, bytes {bytes}"
        );

        self.set_progress(
            emulator_id,
            EmulatorSyncStatus::Synced,
            Some(EmulatorSyncMetrics {
                bytes_per_second: 0.0,
                bytes_transferred: bytes,
                total_bytes: bytes,
                percent_complete: 100,
                updated_at: Some(SystemTime::now().into()),
            }),
        )
        .await;

        Ok(PreservePushResult {
            files_uploaded: uploaded,
            bytes_uploaded: bytes,
        })
    }

    async fn upload_preserve_file_with_retry(
        &self,
        upload_url: &str,
        relative_path: &str,
        content: Vec<u8>,
    ) -> crate::Result<()> {
        let mut last_error = None;

        for attempt in 1..=3 {
            match self
                .http_client
                .post(upload_url)
                .query(&[("relative_path", relative_path)])
                .body(content.clone())
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                Ok(resp) if resp.status().is_server_error() || resp.status().as_u16() == 429 => {
                    last_error = Some(format!(
                        "upload {relative_path} rejected: {}",
                        resp.status()
                    ));
                }
                Ok(resp) => {
                    return Err(crate::Error::Internal(format!(
                        "upload {relative_path} rejected: {}",
                        resp.status()
                    )));
                }
                Err(why) if why.is_timeout() || why.is_connect() => {
                    last_error = Some(format!("upload {relative_path} failed: {why}"));
                }
                Err(why) => {
                    return Err(crate::Error::Internal(format!(
                        "upload {relative_path} failed: {why}"
                    )));
                }
            }

            if attempt < 3 {
                sleep(Duration::from_millis(250 * attempt)).await;
            }
        }

        Err(crate::Error::Internal(last_error.unwrap_or_else(|| {
            format!("upload {relative_path} failed")
        })))
    }

    /// Pulls cloud user data into local cache (overwrites local versions) and
    /// removes local files under user data paths that no longer exist on the cloud.
    /// Supports "force cloud" / reset local from NAS.
    pub async fn pull_user_data(
        &self,
        emulator_id: EmulatorId,
    ) -> crate::Result<PreservePushResult> {
        let local_config = self.get_local_config(emulator_id).await?;
        if !local_config.managed_paths {
            return Ok(PreservePushResult::default());
        }

        let Some(linked_package_id) = local_config.linked_package_id else {
            return Err(crate::Error::EmulatorPackageNotLinked(emulator_id));
        };

        let package = self.resolve_package_for_os(linked_package_id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;

        self.fetch_and_write_manifest(&package, &cache_root).await?;

        let pull_paths = self.read_user_data_paths(
            &cache_root,
            Some(local_config.user_data_paths_override.clone()),
        )?;
        if pull_paths.is_empty() {
            return Ok(PreservePushResult::default());
        }

        let remote_files = self.get_package_files(package.id).await?;
        let host = self.service_host().await?;

        let mut pulled: u32 = 0;
        let mut bytes_pulled: u64 = 0;

        let cloud_user_rels: HashSet<String> = remote_files
            .iter()
            .filter(|f| {
                pull_paths
                    .iter()
                    .any(|p| f.relative_path.starts_with(p.trim_end_matches('/')))
            })
            .map(|f| f.relative_path.clone())
            .collect();

        // Ensure all cloud user data files are downloaded to local (force match cloud)
        for f in &remote_files {
            if !pull_paths
                .iter()
                .any(|p| f.relative_path.starts_with(p.trim_end_matches('/')))
            {
                continue;
            }
            let dest = cache_root.join(&f.relative_path);
            let download_uri = format!("{host}/rest/emulator-package-file/{}", f.id);
            let downloaded = stream_to_file(
                &self.http_client,
                &download_uri,
                &dest,
                None,
                |_| {},
                || StreamControl::Continue,
            )
            .await?;
            pulled += 1;
            bytes_pulled = bytes_pulled.saturating_add(downloaded);
        }

        // Remove local user data files not present in cloud (to match exactly)
        for entry in walkdir::WalkDir::new(&cache_root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            let relative = path
                .strip_prefix(&cache_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            if relative == SYNC_STATE_FILE_NAME || relative == MANIFEST_FILE_NAME {
                continue;
            }

            if pull_paths
                .iter()
                .any(|p| relative.starts_with(p.trim_end_matches('/')))
                && !cloud_user_rels.contains(&relative)
            {
                let _ = std::fs::remove_file(path);
            }
        }

        Ok(PreservePushResult {
            files_uploaded: pulled,
            bytes_uploaded: bytes_pulled,
        })
    }

    /// Analyzes the current local emulator cache to suggest additional user_data_paths
    /// and preserve_paths beyond the base manifest. This helps users discover firmware,
    /// keys, RAPs, installed titles, etc. that should be synced upstream.
    /// Heuristics: diff from manifest base paths, recent mtime, size, name patterns
    /// (customizable per slug), and files not in previous sync state.
    /// Called from UI "Analyze" button; suggestions auto-applied to overrides if empty.
    /// (Future: lightweight auto on link/first ensure using last_analyzed timestamp in sync_state.)
    pub async fn analyze_emulator_user_data(
        &self,
        emulator_id: EmulatorId,
    ) -> crate::Result<AnalyzeEmulatorUserDataResponse> {
        let local_config = self.get_local_config(emulator_id).await?;
        if !local_config.managed_paths {
            return Ok(AnalyzeEmulatorUserDataResponse {
                emulator_id,
                suggested_user_data_paths: vec![],
                suggested_preserve_paths: vec![],
            });
        }

        let Some(linked_package_id) = local_config.linked_package_id else {
            return Err(crate::Error::EmulatorPackageNotLinked(emulator_id));
        };

        let package = self.resolve_package_for_os(linked_package_id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;

        // Ensure manifest is present for base paths
        self.fetch_and_write_manifest(&package, &cache_root).await?;

        let manifest_path = cache_root.join(MANIFEST_FILE_NAME);
        let manifest_data = std::fs::read_to_string(&manifest_path)?;
        let manifest: PackageManifest = serde_json::from_str(&manifest_data)?;

        let base_user: std::collections::HashSet<String> =
            manifest.user_data_paths.iter().cloned().collect();
        let base_preserve: std::collections::HashSet<String> =
            manifest.preserve_paths.iter().cloned().collect();

        let mut candidates: std::collections::HashSet<String> = std::collections::HashSet::new();

        // Walk to find top-level dirs with content not in base
        for entry in walkdir::WalkDir::new(&cache_root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.path();
            let relative = path
                .strip_prefix(&cache_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            if relative == SYNC_STATE_FILE_NAME || relative == MANIFEST_FILE_NAME {
                continue;
            }

            let is_base = base_user
                .iter()
                .any(|p| relative.starts_with(p.trim_end_matches('/')))
                || base_preserve
                    .iter()
                    .any(|p| relative.starts_with(p.trim_end_matches('/')));
            if is_base {
                continue;
            }

            if let Some(top) = relative.split('/').next() {
                if !top.is_empty() {
                    candidates.insert(top.to_string());
                }
            }
        }

        let mut suggested_user_data = vec![];
        let mut suggested_preserve = vec![];

        // Simple heuristics: name patterns + assume data-like unless config-like
        let user_patterns = [
            "dev_hdd0",
            "games",
            "user",
            "nand",
            "sdmc",
            "firmware",
            "keys",
            "exdata",
            "home",
            "installed",
            "rap",
            "title",
        ];
        let preserve_patterns = ["config", "inis", "settings", "portable", "shader", "cache"];

        for c in candidates {
            let lower = c.to_lowercase();
            let looks_user = user_patterns.iter().any(|p| lower.contains(p));
            let looks_preserve = preserve_patterns.iter().any(|p| lower.contains(p));

            if looks_user && !looks_preserve {
                suggested_user_data.push(c);
            } else if looks_preserve {
                suggested_preserve.push(c);
            } else {
                // default new stuff to user data (shareable)
                suggested_user_data.push(c);
            }
        }

        // Also consider recent mtime or large size for boost, but simple for now
        // (can enhance with fs metadata loop if needed)

        Ok(AnalyzeEmulatorUserDataResponse {
            emulator_id,
            suggested_user_data_paths: suggested_user_data,
            suggested_preserve_paths: suggested_preserve,
        })
    }

    pub(crate) async fn set_progress(
        &self,
        emulator_id: EmulatorId,
        status: EmulatorSyncStatus,
        metrics: Option<EmulatorSyncMetrics>,
    ) {
        let status_i32 = status as i32;
        self.sync_index.write().await.insert(
            emulator_id,
            SyncProgress {
                emulator_id,
                status: status_i32,
                metrics: metrics.clone(),
            },
        );

        let update = EmulatorSyncProgressUpdate {
            emulator_id,
            status: status_i32,
            metrics,
        };

        let encoded = update.encode_to_vec();
        let mut subscriptions = self.update_subscriptions.write().await;
        subscriptions.retain(|channel| channel.send(encoded.as_slice()).is_ok());
    }

    pub(crate) async fn add_update_subscription(
        &self,
        channel: Channel<&'static [u8]>,
    ) -> crate::Result<()> {
        for progress in self.sync_index.read().await.values() {
            let update = EmulatorSyncProgressUpdate {
                emulator_id: progress.emulator_id,
                status: progress.status,
                metrics: progress.metrics.clone(),
            };
            if channel.send(update.encode_to_vec().as_slice()).is_err() {
                return Ok(());
            }
        }

        self.update_subscriptions.write().await.push(channel);
        Ok(())
    }

    pub(crate) async fn remove_update_subscription(&self, channel_id: u32) {
        self.update_subscriptions
            .write()
            .await
            .retain(|channel| channel.id() != channel_id);
    }
}
