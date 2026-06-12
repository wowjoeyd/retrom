use crate::sync_state::{load_sync_state, save_sync_state, SyncState, SYNC_STATE_FILE_NAME};
use prost::Message;
use reqwest::header::{HeaderMap, HeaderValue, ACCESS_CONTROL_ALLOW_ORIGIN};
use retrom_codegen::{
    retrom::{
        client::emulator_sync::{
            EmulatorSyncIndex, EmulatorSyncMetrics, EmulatorSyncProgressUpdate, EmulatorSyncStatus,
        },
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
    time::SystemTime,
};
use tauri::{ipc::Channel, plugin::PluginApi, AppHandle, Runtime};
use tokio::sync::RwLock;
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

    async fn resolve_package(&self, package_id: i32) -> crate::Result<EmulatorPackage> {
        let mut package_client = self.app_handle.get_emulator_package_client().await;
        let response = package_client
            .get_emulator_packages(GetEmulatorPackagesRequest {
                ids: vec![package_id],
                package_slug: None,
                catalog_id: None,
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
        let manifest_url = format!(
            "{host}/rest/emulator-package-file/{}/manifest",
            package.id
        );

        let resp = self
            .http_client
            .get(&manifest_url)
            .send()
            .await
            .map_err(|e| {
                crate::Error::Internal(format!("Failed to fetch manifest for package {}: {e}", package.id))
            })?;

        if !resp.status().is_success() {
            return Err(crate::Error::Internal(format!(
                "Manifest fetch for package {} returned status {}",
                package.id,
                resp.status()
            )));
        }

        let bytes = resp.bytes().await.map_err(|e| {
            crate::Error::Internal(format!("Failed to read manifest bytes: {e}"))
        })?;

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

        let package = self.resolve_package(linked_package_id).await?;
        if let Some(latest_id) = self
            .latest_package_id_for_slug(&package.package_slug)
            .await?
        {
            if latest_id != linked_package_id {
                return Ok(EmulatorSyncStatus::OutOfDate);
            }
        }

        let cache_root = self.cache_root_for_package(&package).await?;
        let remote_files = self.get_package_files(package.id).await?;

        if self.files_need_sync(
            &cache_root,
            linked_package_id,
            &package.version,
            &remote_files,
        )? {
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
        let package = self.resolve_package(linked_package_id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;

        // Always fetch the latest manifest first so preserve_paths / user_data_paths
        // are available for decisions.
        self.fetch_and_write_manifest(&package, &cache_root).await?;

        let remote_files = self.get_package_files(package.id).await?;
        let total_bytes: u64 = remote_files.iter().map(|file| file.byte_size as u64).sum();

        // Automatic cloud sync *up* for shareable user data (firmware, keys, RAPs,
        // installed games/roms inside the emulator, etc.). After the user has used
        // the explicit push to promote a local setup as the NAS source of truth,
        // subsequent launches will push any new local changes in the user_data paths.
        // This makes "rom installs, rap files, etc." flow to the server like other
        // cloud sync, while PC-specific config (if excluded from user_data_paths in
        // the catalog) stays local.
        let _ = self.push_preserve_data(emulator_id).await;

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
        let mut synced_files = load_sync_state(&cache_root)?
            .map(|state| state.files)
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

            if self.should_skip_preserved_file(&cache_root, &file.relative_path, Some(local_config.preserve_paths_override.clone()))? {
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

        let preserve_paths = self.read_preserve_paths(&cache_root, Some(local_config.preserve_paths_override.clone()))?;
        self.prune_stale_files(&cache_root, &remote_files, &preserve_paths, &previous_known)?;

        save_sync_state(
            &cache_root,
            &SyncState {
                linked_package_id,
                version: package.version.clone(),
                files: synced_files,
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

    fn read_preserve_paths(&self, cache_root: &Path, override_paths: Option<Vec<String>>) -> crate::Result<Vec<String>> {
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
    fn read_user_data_paths(&self, cache_root: &Path, override_paths: Option<Vec<String>>) -> crate::Result<Vec<String>> {
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
            if previous_known_package_files.contains(&relative)
                && !remote_paths.contains(&relative)
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
    pub async fn push_preserve_data(&self, emulator_id: EmulatorId) -> crate::Result<PreservePushResult> {
        let local_config = self.get_local_config(emulator_id).await?;
        if !local_config.managed_paths {
            return Ok(PreservePushResult::default());
        }

        let Some(linked_package_id) = local_config.linked_package_id else {
            return Err(crate::Error::EmulatorPackageNotLinked(emulator_id));
        };

        let package = self.resolve_package(linked_package_id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;

        // Ensure we have up-to-date manifest (also ensures cache has it)
        self.fetch_and_write_manifest(&package, &cache_root).await?;

        let push_paths = self.read_user_data_paths(&cache_root, Some(local_config.user_data_paths_override.clone()))?;
        if push_paths.is_empty() {
            return Ok(PreservePushResult::default());
        }

        let remote_files = self.get_package_files(package.id).await?;
        let remote_sha: HashMap<String, String> = remote_files
            .into_iter()
            .map(|f| (f.relative_path, f.sha256))
            .collect();

        let host = self.service_host().await?;

        let mut uploaded: u32 = 0;
        let mut bytes: u64 = 0;

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

            let local_sha = Self::sha256_file(path).map_err(|e| {
                crate::Error::Internal(format!("sha for {}: {e}", relative))
            })?;

            let needs_push = match remote_sha.get(&relative) {
                Some(r) if r == &local_sha => false,
                _ => true,
            };

            if needs_push {
                let upload_url = format!(
                    "{host}/rest/emulator-package-file/preserve/{}",
                    package.id
                );

                let content = std::fs::read(path)?;
                let resp = self
                    .http_client
                    .post(&upload_url)
                    .query(&[("relative_path", &relative)])
                    .body(content.clone())
                    .send()
                    .await
                    .map_err(|e| {
                        crate::Error::Internal(format!("upload {} failed: {e}", relative))
                    })?;

                if !resp.status().is_success() {
                    return Err(crate::Error::Internal(format!(
                        "upload {} rejected: {}",
                        relative,
                        resp.status()
                    )));
                }

                uploaded += 1;
                bytes = bytes.saturating_add(content.len() as u64);
            }
        }

        // Deletion support in up-sync (push local as truth): if a user data file
        // is present in the cloud index but no longer exists locally, delete it
        // on the NAS so the cloud exactly matches this local instance.
        for (rel, _) in &remote_sha {
            let is_user_data = push_paths
                .iter()
                .any(|prefix| rel.starts_with(prefix.trim_end_matches('/')));
            if is_user_data && !cache_root.join(rel).exists() {
                let delete_url = format!(
                    "{host}/rest/emulator-package-file/preserve/{}",
                    package.id
                );
                let _ = self
                    .http_client
                    .delete(&delete_url)
                    .query(&[("relative_path", rel.as_str())])
                    .send()
                    .await;
            }
        }

        Ok(PreservePushResult {
            files_uploaded: uploaded,
            bytes_uploaded: bytes,
        })
    }

    /// Pulls cloud user data into local cache (overwrites local versions) and
    /// removes local files under user data paths that no longer exist on the cloud.
    /// Supports "force cloud" / reset local from NAS.
    pub async fn pull_user_data(&self, emulator_id: EmulatorId) -> crate::Result<PreservePushResult> {
        let local_config = self.get_local_config(emulator_id).await?;
        if !local_config.managed_paths {
            return Ok(PreservePushResult::default());
        }

        let Some(linked_package_id) = local_config.linked_package_id else {
            return Err(crate::Error::EmulatorPackageNotLinked(emulator_id));
        };

        let package = self.resolve_package(linked_package_id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;

        self.fetch_and_write_manifest(&package, &cache_root).await?;

        let pull_paths = self.read_user_data_paths(&cache_root, Some(local_config.user_data_paths_override.clone()))?;
        if pull_paths.is_empty() {
            return Ok(PreservePushResult::default());
        }

        let remote_files = self.get_package_files(package.id).await?;
        let host = self.service_host().await?;

        let mut pulled: u32 = 0;
        let mut bytes_pulled: u64 = 0;

        let cloud_user_rels: HashSet<String> = remote_files
            .iter()
            .filter(|f| pull_paths.iter().any(|p| f.relative_path.starts_with(p.trim_end_matches('/'))))
            .map(|f| f.relative_path.clone())
            .collect();

        // Ensure all cloud user data files are downloaded to local (force match cloud)
        for f in &remote_files {
            if !pull_paths.iter().any(|p| f.relative_path.starts_with(p.trim_end_matches('/'))) {
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

            if pull_paths.iter().any(|p| relative.starts_with(p.trim_end_matches('/')))
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
