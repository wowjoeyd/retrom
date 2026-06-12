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
        let remote_files = self.get_package_files(package.id).await?;
        let cache_root = self.cache_root_for_package(&package).await?;
        let total_bytes: u64 = remote_files.iter().map(|file| file.byte_size as u64).sum();

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

            if self.should_skip_preserved_file(&cache_root, &file.relative_path)? {
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

        let preserve_paths = self.read_preserve_paths(&cache_root)?;
        self.prune_stale_files(&cache_root, &remote_files, &preserve_paths)?;

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
    ) -> crate::Result<bool> {
        let preserve_paths = self.read_preserve_paths(cache_root)?;
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

    fn read_preserve_paths(&self, cache_root: &Path) -> crate::Result<Vec<String>> {
        let manifest_path = cache_root.join(MANIFEST_FILE_NAME);
        if !manifest_path.exists() {
            return Ok(Vec::new());
        }

        let data = std::fs::read_to_string(manifest_path)?;
        let manifest: PackageManifest = serde_json::from_str(&data)?;
        Ok(manifest.preserve_paths)
    }

    fn prune_stale_files(
        &self,
        cache_root: &Path,
        remote_files: &[EmulatorPackageFile],
        preserve_paths: &[String],
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

            if !remote_paths.contains(&relative) {
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
