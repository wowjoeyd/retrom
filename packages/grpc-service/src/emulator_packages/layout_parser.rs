use retrom_codegen::retrom::EmulatorPackageDirectory;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::manifest::{ManifestError, MANIFEST_FILE_NAME};

#[derive(Debug, thiserror::Error)]
pub enum LayoutError {
    #[error("package directory path is empty")]
    EmptyPath,
    #[error("package root does not exist: {0}")]
    MissingRoot(String),
    #[error(transparent)]
    Manifest(#[from] ManifestError),
}

/// Discover package version roots under a configured emulator package directory.
pub fn discover_package_roots(directory: &EmulatorPackageDirectory) -> Result<Vec<PathBuf>, LayoutError> {
    let root = PathBuf::from(&directory.path);
    if directory.path.is_empty() {
        return Err(LayoutError::EmptyPath);
    }
    if !root.exists() {
        return Err(LayoutError::MissingRoot(directory.path.clone()));
    }

    let mut roots = Vec::new();

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        if entry.file_name() != MANIFEST_FILE_NAME {
            continue;
        }

        if let Some(parent) = entry.path().parent() {
            roots.push(parent.to_path_buf());
        }
    }

    roots.sort();
    roots.dedup();
    Ok(roots)
}

pub fn default_package_layout_hint(root: &Path) -> String {
    format!("{}/{{packageSlug}}/{{version}}/", root.display())
}