use diesel::{upsert::excluded, ExpressionMethods, QueryDsl};
use diesel_async::RunQueryDsl;
use retrom_codegen::{
    retrom::{EmulatorPackageStatus, NewEmulatorPackage, NewEmulatorPackageFile},
    timestamp::Timestamp,
};
use retrom_db::{schema, Pool};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tracing::warn;

use super::manifest::{os_from_manifest, read_manifest, PackageManifest};

#[derive(Debug, thiserror::Error)]
pub enum ResolverError {
    #[error(transparent)]
    Diesel(#[from] diesel::result::Error),
    #[error(transparent)]
    Pool(#[from] deadpool::managed::PoolError<diesel_async::pooled_connection::PoolError>),
    #[error("manifest error: {0}")]
    Manifest(String),
}

pub struct ResolvedPackageFile {
    pub relative_path: String,
    pub byte_size: i64,
    pub sha256: String,
    pub absolute_path: String,
    pub file_modified_at: SystemTime,
    pub optional: bool,
}

pub struct ResolvedPackage {
    pub package_slug: String,
    pub version: String,
    pub display_name: String,
    pub catalog_id: Option<String>,
    pub os: i32,
    pub root_path: String,
    pub manifest_sha256: String,
    pub executable_rel: String,
    pub status: i32,
    pub files: Vec<ResolvedPackageFile>,
}

pub async fn resolve_package_at_root(
    package_root: &Path,
) -> Result<ResolvedPackage, ResolverError> {
    let manifest =
        read_manifest(package_root).map_err(|why| ResolverError::Manifest(why.to_string()))?;

    let manifest_sha256 = sha256_file(&manifest_path(package_root)).unwrap_or_default();

    let files = inventory_files(package_root, &manifest)?;

    let status = if files
        .iter()
        .any(|f| !f.optional && !Path::new(&f.absolute_path).exists())
    {
        EmulatorPackageStatus::Degraded as i32
    } else {
        EmulatorPackageStatus::Healthy as i32
    };

    Ok(ResolvedPackage {
        package_slug: manifest.package_slug,
        version: manifest.version,
        display_name: manifest.display_name,
        catalog_id: manifest.retrom.and_then(|r| r.catalog_id),
        os: os_from_manifest(&manifest.platform),
        root_path: package_root
            .canonicalize()
            .unwrap_or_else(|_| package_root.to_path_buf())
            .to_string_lossy()
            .to_string(),
        manifest_sha256,
        executable_rel: manifest.executable.relative_path,
        status,
        files,
    })
}

pub async fn upsert_resolved_package(
    db_pool: Arc<Pool>,
    resolved: ResolvedPackage,
) -> Result<i32, ResolverError> {
    let mut conn = db_pool.get().await?;

    let new_package = NewEmulatorPackage {
        package_slug: resolved.package_slug.clone(),
        version: resolved.version.clone(),
        display_name: resolved.display_name,
        catalog_id: resolved.catalog_id,
        os: resolved.os,
        root_path: resolved.root_path.clone(),
        manifest_sha256: resolved.manifest_sha256,
        executable_rel: resolved.executable_rel,
        status: resolved.status,
        is_deleted: Some(false),
        deleted_at: None,
        created_at: Some(Timestamp::from(SystemTime::now())),
        updated_at: Some(Timestamp::from(SystemTime::now())),
    };

    let package = diesel::insert_into(schema::emulator_packages::table)
        .values(&new_package)
        .on_conflict((
            schema::emulator_packages::package_slug,
            schema::emulator_packages::version,
            schema::emulator_packages::os,
        ))
        .do_update()
        .set((
            schema::emulator_packages::display_name
                .eq(excluded(schema::emulator_packages::display_name)),
            schema::emulator_packages::catalog_id
                .eq(excluded(schema::emulator_packages::catalog_id)),
            schema::emulator_packages::os.eq(excluded(schema::emulator_packages::os)),
            schema::emulator_packages::root_path.eq(excluded(schema::emulator_packages::root_path)),
            schema::emulator_packages::manifest_sha256
                .eq(excluded(schema::emulator_packages::manifest_sha256)),
            schema::emulator_packages::executable_rel
                .eq(excluded(schema::emulator_packages::executable_rel)),
            schema::emulator_packages::status.eq(excluded(schema::emulator_packages::status)),
            schema::emulator_packages::is_deleted.eq(false),
            schema::emulator_packages::deleted_at.eq(None::<Timestamp>),
            schema::emulator_packages::updated_at.eq(Some(Timestamp::from(SystemTime::now()))),
        ))
        .get_result::<retrom_codegen::retrom::EmulatorPackage>(&mut conn)
        .await?;

    let seen_paths: HashSet<String> = resolved
        .files
        .iter()
        .map(|f| f.relative_path.clone())
        .collect();

    for file in resolved.files {
        let new_file = NewEmulatorPackageFile {
            package_id: package.id,
            relative_path: file.relative_path.clone(),
            byte_size: file.byte_size,
            sha256: file.sha256,
            absolute_path: file.absolute_path,
            file_modified_at: Some(Timestamp::from(file.file_modified_at)),
            optional: file.optional,
            is_deleted: Some(false),
            deleted_at: None,
            created_at: Some(Timestamp::from(SystemTime::now())),
            updated_at: Some(Timestamp::from(SystemTime::now())),
        };

        diesel::insert_into(schema::emulator_package_files::table)
            .values(&new_file)
            .on_conflict((
                schema::emulator_package_files::package_id,
                schema::emulator_package_files::relative_path,
            ))
            .do_update()
            .set((
                schema::emulator_package_files::byte_size
                    .eq(excluded(schema::emulator_package_files::byte_size)),
                schema::emulator_package_files::sha256
                    .eq(excluded(schema::emulator_package_files::sha256)),
                schema::emulator_package_files::absolute_path
                    .eq(excluded(schema::emulator_package_files::absolute_path)),
                schema::emulator_package_files::file_modified_at
                    .eq(excluded(schema::emulator_package_files::file_modified_at)),
                schema::emulator_package_files::optional
                    .eq(excluded(schema::emulator_package_files::optional)),
                schema::emulator_package_files::is_deleted.eq(false),
                schema::emulator_package_files::deleted_at.eq(None::<Timestamp>),
                schema::emulator_package_files::updated_at
                    .eq(Some(Timestamp::from(SystemTime::now()))),
            ))
            .execute(&mut conn)
            .await?;
    }

    let stale_rows = schema::emulator_package_files::table
        .filter(schema::emulator_package_files::package_id.eq(package.id))
        .filter(schema::emulator_package_files::is_deleted.eq(false))
        .load::<retrom_codegen::retrom::EmulatorPackageFile>(&mut conn)
        .await?;

    for row in stale_rows {
        if !seen_paths.contains(&row.relative_path) {
            diesel::update(schema::emulator_package_files::table)
                .filter(schema::emulator_package_files::id.eq(row.id))
                .set((
                    schema::emulator_package_files::is_deleted.eq(true),
                    schema::emulator_package_files::deleted_at
                        .eq(Some(Timestamp::from(SystemTime::now()))),
                    schema::emulator_package_files::updated_at
                        .eq(Some(Timestamp::from(SystemTime::now()))),
                ))
                .execute(&mut conn)
                .await?;
        }
    }

    Ok(package.id)
}

pub async fn scan_package_roots(
    db_pool: Arc<Pool>,
    package_roots: Vec<PathBuf>,
) -> Result<Vec<i32>, ResolverError> {
    let mut package_ids = Vec::new();

    for root in package_roots {
        match resolve_package_at_root(&root).await {
            Ok(resolved) => match upsert_resolved_package(db_pool.clone(), resolved).await {
                Ok(id) => package_ids.push(id),
                Err(why) => warn!("Failed to upsert emulator package at {:?}: {}", root, why),
            },
            Err(why) => warn!("Failed to resolve emulator package at {:?}: {}", root, why),
        }
    }

    Ok(package_ids)
}

fn inventory_files(
    package_root: &Path,
    manifest: &PackageManifest,
) -> Result<Vec<ResolvedPackageFile>, ResolverError> {
    if manifest.files.is_empty() {
        return walk_inventory(package_root);
    }

    manifest
        .files
        .iter()
        .map(|entry| {
            let absolute = package_root.join(&entry.relative_path);
            let metadata = std::fs::metadata(&absolute).ok();
            Ok(ResolvedPackageFile {
                relative_path: entry.relative_path.clone(),
                byte_size: metadata
                    .as_ref()
                    .map(|m| m.len() as i64)
                    .unwrap_or(entry.size.unwrap_or(0) as i64),
                sha256: entry.sha256.clone(),
                absolute_path: absolute.to_string_lossy().to_string(),
                file_modified_at: metadata
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(SystemTime::UNIX_EPOCH),
                optional: entry.optional.unwrap_or(false),
            })
        })
        .collect()
}

fn walk_inventory(package_root: &Path) -> Result<Vec<ResolvedPackageFile>, ResolverError> {
    let mut files = Vec::new();
    for entry in walkdir::WalkDir::new(package_root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        if path.file_name().and_then(|n| n.to_str()) == Some(super::manifest::MANIFEST_FILE_NAME) {
            continue;
        }

        let relative = path
            .strip_prefix(package_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        let metadata = entry.metadata().ok();
        files.push(ResolvedPackageFile {
            relative_path: relative,
            byte_size: metadata.as_ref().map(|m| m.len() as i64).unwrap_or(0),
            sha256: String::new(),
            absolute_path: path.to_string_lossy().to_string(),
            file_modified_at: metadata
                .and_then(|m| m.modified().ok())
                .unwrap_or(SystemTime::UNIX_EPOCH),
            optional: false,
        });
    }

    Ok(files)
}

fn manifest_path(package_root: &Path) -> PathBuf {
    package_root.join(super::manifest::MANIFEST_FILE_NAME)
}

fn sha256_file(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).ok()?;
    let hash = Sha256::digest(bytes);
    Some(format!("{:x}", hash))
}

/// Compute the latest package id per slug.
///
/// When `os_filter` is `Some`, only packages for that OS are considered, so the
/// returned "latest" is per-OS — this is what clients want (they only run their
/// own OS build). When `None`, the newest version across all OSes wins per slug
/// (used by OS-agnostic views).
pub fn latest_package_ids_by_slug(
    packages: &[retrom_codegen::retrom::EmulatorPackage],
    os_filter: Option<i32>,
) -> HashMap<String, i32> {
    use retrom_service_common::emulator_packages::version::compare_package_versions;

    let mut latest: HashMap<String, (String, i32)> = HashMap::new();

    for package in packages
        .iter()
        .filter(|p| !p.is_deleted)
        .filter(|p| match os_filter {
            Some(os) => p.os == os,
            None => true,
        })
    {
        let entry = latest.get(&package.package_slug);
        let replace = match entry {
            None => true,
            Some((version, _)) => {
                compare_package_versions(&package.version, version) == std::cmp::Ordering::Greater
            }
        };

        if replace {
            latest.insert(
                package.package_slug.clone(),
                (package.version.clone(), package.id),
            );
        }
    }

    latest
        .into_iter()
        .map(|(slug, (_, id))| (slug, id))
        .collect()
}
