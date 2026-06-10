use retrom_codegen::retrom::EmulatorCatalogInstall;
use rayon::prelude::*;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};
use thiserror::Error;
use walkdir::WalkDir;

pub const MANIFEST_FILE_NAME: &str = "retrom-emulator-package.json";

#[derive(Debug, Error)]
pub enum ManifestEmitError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("executable not found in package")]
    ExecutableNotFound,
}

#[derive(Debug, serde::Serialize)]
struct PackageManifest {
    schema_version: u32,
    package_slug: String,
    display_name: String,
    version: String,
    platform: ManifestPlatform,
    executable: ManifestExecutable,
    preserve_paths: Vec<String>,
    files: Vec<ManifestFileEntry>,
    retrom: ManifestRetromMeta,
}

#[derive(Debug, serde::Serialize)]
struct ManifestPlatform {
    os: String,
    arch: String,
}

#[derive(Debug, serde::Serialize)]
struct ManifestExecutable {
    relative_path: String,
    working_dir_relative: String,
}

#[derive(Debug, serde::Serialize)]
struct ManifestFileEntry {
    relative_path: String,
    size: u64,
    sha256: String,
    optional: bool,
}

#[derive(Debug, serde::Serialize)]
struct ManifestRetromMeta {
    catalog_id: String,
    emulator_name: String,
}

pub struct EmitManifestParams<'a> {
    pub package_root: &'a Path,
    pub package_slug: &'a str,
    pub display_name: &'a str,
    pub version: &'a str,
    pub catalog_id: &'a str,
    pub os: &'a str,
    pub install: &'a EmulatorCatalogInstall,
    pub executable_rel: &'a str,
}

pub fn emit_manifest(params: EmitManifestParams<'_>) -> Result<(), ManifestEmitError> {
    let files = inventory_files(params.package_root)?;
    let manifest = PackageManifest {
        schema_version: 1,
        package_slug: params.package_slug.to_string(),
        display_name: params.display_name.to_string(),
        version: params.version.to_string(),
        platform: ManifestPlatform {
            os: params.os.to_string(),
            arch: "x86_64".to_string(),
        },
        executable: ManifestExecutable {
            relative_path: params.executable_rel.to_string(),
            working_dir_relative: ".".to_string(),
        },
        preserve_paths: params.install.preserve_paths.clone(),
        files,
        retrom: ManifestRetromMeta {
            catalog_id: params.catalog_id.to_string(),
            emulator_name: params.display_name.to_string(),
        },
    };

    let manifest_path = params.package_root.join(MANIFEST_FILE_NAME);
    let json = serde_json::to_string_pretty(&manifest)?;
    std::fs::write(manifest_path, json)?;
    Ok(())
}

fn inventory_files(package_root: &Path) -> Result<Vec<ManifestFileEntry>, ManifestEmitError> {
    let paths: Vec<PathBuf> = WalkDir::new(package_root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| e.file_name() != MANIFEST_FILE_NAME)
        .map(|e| e.path().to_path_buf())
        .collect();

    let entries: Vec<ManifestFileEntry> = paths
        .par_iter()
        .map(|path| {
            let metadata = std::fs::metadata(path)?;
            let relative_path = path
                .strip_prefix(package_root)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            let sha256 = sha256_file(path)?;
            Ok(ManifestFileEntry {
                relative_path,
                size: metadata.len(),
                sha256,
                optional: false,
            })
        })
        .collect::<Result<Vec<_>, ManifestEmitError>>()?;

    Ok(entries)
}

fn sha256_file(path: &Path) -> Result<String, ManifestEmitError> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub fn ensure_preserve_paths(package_root: &Path, preserve_paths: &[String]) -> Result<(), ManifestEmitError> {
    for path in preserve_paths {
        std::fs::create_dir_all(package_root.join(path))?;
    }
    Ok(())
}

pub fn find_previous_version_dir(slug_root: &Path, current_version: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(slug_root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().ok().is_some_and(|t| t.is_dir()))
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name != current_version)
        })
        .collect();

    candidates.sort();
    candidates.pop()
}