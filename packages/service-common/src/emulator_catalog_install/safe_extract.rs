use std::io::{copy, Read};
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExtractError {
    #[error("failed to read archive: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("7z error: {0}")]
    SevenZ(String),
    #[error("tar error: {0}")]
    Tar(String),
    #[error("unsupported archive type: {0}")]
    Unsupported(String),
    #[error("zip slip blocked: {0}")]
    ZipSlip(PathBuf),
}

pub fn safe_extract_archive(
    archive_path: &Path,
    archive_type: &str,
    dest_dir: &Path,
) -> Result<(), ExtractError> {
    std::fs::create_dir_all(dest_dir)?;

    match archive_type {
        "zip" => extract_zip(archive_path, dest_dir),
        "7z" => extract_7z(archive_path, dest_dir),
        "tar_xz" => extract_tar_xz(archive_path, dest_dir),
        "tar_gz" => extract_tar_gz(archive_path, dest_dir),
        "tar_zst" => extract_tar_zst(archive_path, dest_dir),
        "appimage" => copy_appimage(archive_path, dest_dir),
        other => Err(ExtractError::Unsupported(other.to_string())),
    }
}

fn validate_extract_path(base: &Path, entry_path: &Path) -> Result<PathBuf, ExtractError> {
    let dest = base.join(entry_path);
    let normalized_base = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    let normalized_dest = if dest.exists() {
        dest.canonicalize().unwrap_or(dest.clone())
    } else {
        dest.clone()
    };

    if !normalized_dest.starts_with(&normalized_base) {
        return Err(ExtractError::ZipSlip(entry_path.to_path_buf()));
    }

    Ok(dest)
}

fn extract_zip(archive_path: &Path, dest_dir: &Path) -> Result<(), ExtractError> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let entry_path = match entry.enclosed_name() {
            Some(path) => path.to_path_buf(),
            None => continue,
        };

        let out_path = validate_extract_path(dest_dir, &entry_path)?;

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = std::fs::File::create(&out_path)?;
            copy(&mut entry, &mut outfile)?;
        }
    }

    Ok(())
}

fn extract_7z(archive_path: &Path, dest_dir: &Path) -> Result<(), ExtractError> {
    sevenz_rust2::decompress_file(archive_path, dest_dir)
        .map_err(|why| ExtractError::SevenZ(why.to_string()))
}

fn extract_tar_xz(archive_path: &Path, dest_dir: &Path) -> Result<(), ExtractError> {
    let file = std::fs::File::open(archive_path)?;
    let decompressor = xz2::read::XzDecoder::new(file);
    extract_tar_stream(decompressor, dest_dir)
}

fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<(), ExtractError> {
    let file = std::fs::File::open(archive_path)?;
    let decompressor = flate2::read::GzDecoder::new(file);
    extract_tar_stream(decompressor, dest_dir)
}

fn extract_tar_zst(archive_path: &Path, dest_dir: &Path) -> Result<(), ExtractError> {
    let file = std::fs::File::open(archive_path)?;
    let decompressor =
        zstd::Decoder::new(file).map_err(|why| ExtractError::Tar(why.to_string()))?;
    extract_tar_stream(decompressor, dest_dir)
}

fn extract_tar_stream<R: Read>(reader: R, dest_dir: &Path) -> Result<(), ExtractError> {
    let mut archive = tar::Archive::new(reader);

    for entry in archive
        .entries()
        .map_err(|why| ExtractError::Tar(why.to_string()))?
    {
        let mut entry = entry.map_err(|why| ExtractError::Tar(why.to_string()))?;
        let entry_path = entry
            .path()
            .map_err(|why| ExtractError::Tar(why.to_string()))?
            .to_path_buf();

        if entry_path.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(ExtractError::ZipSlip(entry_path));
        }

        let out_path = validate_extract_path(dest_dir, &entry_path)?;
        entry
            .unpack(&out_path)
            .map_err(|why| ExtractError::Tar(why.to_string()))?;
    }

    Ok(())
}

fn copy_appimage(archive_path: &Path, dest_dir: &Path) -> Result<(), ExtractError> {
    let file_name = archive_path
        .file_name()
        .ok_or_else(|| ExtractError::Unsupported("appimage missing filename".into()))?;
    let dest = dest_dir.join(file_name);
    std::fs::copy(archive_path, &dest)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&dest)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&dest, perms)?;
    }
    Ok(())
}

pub fn apply_strip_components(dir: &Path, components: u32) -> Result<(), ExtractError> {
    if components == 0 {
        return Ok(());
    }

    let mut current = dir.to_path_buf();
    for _ in 0..components {
        let entries: Vec<_> = std::fs::read_dir(&current)?
            .filter_map(|e| e.ok())
            .collect();
        if entries.len() != 1 {
            break;
        }
        let entry = &entries[0];
        if !entry.file_type()?.is_dir() {
            break;
        }
        current = entry.path();
    }

    if current == dir {
        return Ok(());
    }

    for entry in std::fs::read_dir(&current)? {
        let entry = entry?;
        let dest = dir.join(entry.file_name());
        if dest.exists() {
            if dest.is_dir() {
                std::fs::remove_dir_all(&dest)?;
            } else {
                std::fs::remove_file(&dest)?;
            }
        }
        std::fs::rename(entry.path(), &dest)?;
    }

    Ok(())
}
