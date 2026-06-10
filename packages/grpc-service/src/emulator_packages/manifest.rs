use retrom_codegen::retrom::emulator::OperatingSystem;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const MANIFEST_FILE_NAME: &str = "retrom-emulator-package.json";

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("failed to read manifest: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse manifest: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("manifest missing executable.relative_path")]
    MissingExecutable,
}

#[derive(Debug, Deserialize)]
pub struct PackageManifest {
    pub schema_version: u32,
    pub package_slug: String,
    pub display_name: String,
    pub version: String,
    #[serde(default)]
    pub platform: Option<ManifestPlatform>,
    pub executable: ManifestExecutable,
    #[serde(default)]
    pub files: Vec<ManifestFileEntry>,
    #[serde(default)]
    pub retrom: Option<ManifestRetromMeta>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestPlatform {
    pub os: String,
    #[serde(default)]
    pub arch: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestExecutable {
    pub relative_path: String,
    #[serde(default)]
    pub working_dir_relative: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestFileEntry {
    pub relative_path: String,
    #[serde(default)]
    pub size: Option<u64>,
    pub sha256: String,
    #[serde(default)]
    pub optional: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ManifestRetromMeta {
    #[serde(default)]
    pub catalog_id: Option<String>,
}

pub fn read_manifest(package_root: &Path) -> Result<PackageManifest, ManifestError> {
    let manifest_path = package_root.join(MANIFEST_FILE_NAME);
    let data = std::fs::read_to_string(&manifest_path)?;
    let manifest: PackageManifest = serde_json::from_str(&data)?;
    Ok(manifest)
}

pub fn manifest_path(package_root: &Path) -> PathBuf {
    package_root.join(MANIFEST_FILE_NAME)
}

pub fn os_from_manifest(platform: &Option<ManifestPlatform>) -> i32 {
    let os = platform
        .as_ref()
        .map(|p| p.os.to_ascii_lowercase())
        .unwrap_or_else(|| "windows".to_string());

    match os.as_str() {
        "windows" => OperatingSystem::Windows as i32,
        "macos" => OperatingSystem::Macos as i32,
        "linux" => OperatingSystem::LinuxX8664 as i32,
        _ => OperatingSystem::Windows as i32,
    }
}