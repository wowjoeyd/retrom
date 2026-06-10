mod download;
mod emit_manifest;
mod safe_extract;

use emit_manifest::{emit_manifest, ensure_preserve_paths, find_previous_version_dir, EmitManifestParams};
use glob::Pattern;
use retrom_codegen::retrom::{
    emulator::OperatingSystem, EmulatorCatalogEntry, EmulatorCatalogInstall,
};
use safe_extract::{apply_strip_components, safe_extract_archive};
use std::path::{Path, PathBuf};
use thiserror::Error;
use walkdir::WalkDir;

pub use download::DownloadError;
pub use emit_manifest::ManifestEmitError;
pub use safe_extract::ExtractError;

use crate::emulator_catalog::{package_slug_from_catalog_id, resolve_target_for_os};

#[derive(Debug, Error)]
pub enum InstallError {
    #[error("download failed: {0}")]
    Download(#[from] DownloadError),
    #[error("extract failed: {0}")]
    Extract(#[from] ExtractError),
    #[error("manifest failed: {0}")]
    Manifest(#[from] ManifestEmitError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("catalog entry not installable")]
    NotInstallable,
    #[error("no install target for operating system")]
    NoTargetForOs,
    #[error("executable not found after extract")]
    ExecutableNotFound,
}

#[derive(Debug, Clone)]
pub struct InstallCatalogParams {
    pub entry: EmulatorCatalogEntry,
    pub target_os: OperatingSystem,
    pub install_root: PathBuf,
    pub subpath: Option<String>,
}

#[derive(Debug, Clone)]
pub struct InstallCatalogResult {
    pub package_root: PathBuf,
    pub package_slug: String,
    pub version: String,
    pub executable_rel: String,
    pub target_os: OperatingSystem,
}

pub async fn install_catalog_package(
    params: InstallCatalogParams,
) -> Result<InstallCatalogResult, InstallError> {
    if !params.entry.installable || params.entry.deprecated {
        return Err(InstallError::NotInstallable);
    }

    let target = resolve_target_for_os(&params.entry, params.target_os)
        .ok_or(InstallError::NoTargetForOs)?;

    let package_slug = package_slug_from_catalog_id(&params.entry.catalog_id);
    let subpath = params
        .subpath
        .as_deref()
        .unwrap_or(&package_slug)
        .trim_matches('/')
        .to_string();

    let temp_dir = tempfile::tempdir()?;
    let downloaded = download::download_upstream_asset(target.upstream, temp_dir.path()).await?;

    let slug_root = params.install_root.join(&subpath).join(&package_slug);
    let package_root = slug_root.join(&downloaded.version);

    if package_root.exists() {
        std::fs::remove_dir_all(&package_root)?;
    }
    std::fs::create_dir_all(&package_root)?;

    let extract_dir = temp_dir.path().join("extract");
    std::fs::create_dir_all(&extract_dir)?;

    safe_extract_archive(
        &downloaded.path,
        &target.install.archive_type,
        &extract_dir,
    )?;

    apply_strip_components(&extract_dir, target.install.strip_components)?;

    for entry in std::fs::read_dir(&extract_dir)? {
        let entry = entry?;
        let dest = package_root.join(entry.file_name());
        if dest.exists() {
            if dest.is_dir() {
                std::fs::remove_dir_all(&dest)?;
            } else {
                std::fs::remove_file(&dest)?;
            }
        }
        std::fs::rename(entry.path(), dest)?;
    }

    if let Some(previous) = find_previous_version_dir(&slug_root, &downloaded.version) {
        for preserve in &target.install.preserve_paths {
            let prev_path = previous.join(preserve);
            let dest_path = package_root.join(preserve);
            if prev_path.is_dir() && !dest_path.exists() {
                std::fs::create_dir_all(&dest_path)?;
            }
        }
    }

    ensure_preserve_paths(&package_root, &target.install.preserve_paths)?;

    let executable_rel =
        resolve_executable_relative(&package_root, target.install, params.target_os)?;

    emit_manifest(EmitManifestParams {
        package_root: &package_root,
        package_slug: &package_slug,
        display_name: &params.entry.display_name,
        version: &downloaded.version,
        catalog_id: &params.entry.catalog_id,
        os: os_string(params.target_os),
        install: target.install,
        executable_rel: &executable_rel,
    })?;

    Ok(InstallCatalogResult {
        package_root,
        package_slug,
        version: downloaded.version,
        executable_rel,
        target_os: params.target_os,
    })
}

fn resolve_executable_relative(
    package_root: &Path,
    install: &EmulatorCatalogInstall,
    target_os: OperatingSystem,
) -> Result<String, InstallError> {
    if let Some(rel) = install.executable_relative_path.as_ref() {
        let path = package_root.join(rel);
        if path.exists() {
            return Ok(normalize_rel_path(package_root, &path));
        }
    }

    if let Some(glob_pattern) = install.executable_glob.as_ref() {
        let pattern = Pattern::new(glob_pattern)
            .map_err(|why| InstallError::Io(std::io::Error::new(std::io::ErrorKind::InvalidInput, why)))?;

        for entry in WalkDir::new(package_root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            let file_name = entry.file_name().to_string_lossy();
            if pattern.matches(&file_name) {
                return Ok(normalize_rel_path(package_root, entry.path()));
            }
        }
    }

    if target_os == OperatingSystem::Windows {
        for entry in WalkDir::new(package_root)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
        {
            if entry
                .path()
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
            {
                return Ok(normalize_rel_path(package_root, entry.path()));
            }
        }
    }

    Err(InstallError::ExecutableNotFound)
}

fn normalize_rel_path(package_root: &Path, absolute: &Path) -> String {
    absolute
        .strip_prefix(package_root)
        .unwrap_or(absolute)
        .to_string_lossy()
        .replace('\\', "/")
}

fn os_string(os: OperatingSystem) -> &'static str {
    match os {
        OperatingSystem::Windows => "windows",
        OperatingSystem::Macos => "macos",
        OperatingSystem::LinuxX8664 => "linux",
        OperatingSystem::Wasm => "wasm",
    }
}

#[cfg(test)]
mod tests {
    use super::os_string;
    use retrom_codegen::retrom::emulator::OperatingSystem;

    #[test]
    fn os_string_maps_variants() {
        assert_eq!(os_string(OperatingSystem::Windows), "windows");
        assert_eq!(os_string(OperatingSystem::Macos), "macos");
        assert_eq!(os_string(OperatingSystem::LinuxX8664), "linux");
    }
}