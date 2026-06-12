use axum::{
    body::Bytes,
    extract::{Path, Query},
    http::{header, StatusCode},
    response::Response,
    routing::{delete, get, post},
    Extension, Router,
};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use futures_util::TryStreamExt;
use retrom_codegen::retrom::{self, NewEmulatorPackageFile};
use retrom_codegen::timestamp::Timestamp;
use retrom_db::{schema, Pool};
use serde::Deserialize;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

pub fn emulator_package_file_routes() -> Router {
    Router::new()
        .route("/{fileId}", get(emulator_package_file_handler))
        .route("/{packageId}/manifest", get(emulator_package_manifest_handler))
        .route("/preserve/{package_id}", post(upload_preserve_file_handler))
        .route("/preserve/{package_id}", delete(delete_preserve_file_handler))
}

async fn emulator_package_file_handler(
    Extension(pool): Extension<Arc<Pool>>,
    Path(file_id): Path<i32>,
) -> Result<Response, StatusCode> {
    let mut conn = pool.get().await.unwrap();

    let package_file = schema::emulator_package_files::table
        .filter(schema::emulator_package_files::id.eq(file_id))
        .filter(schema::emulator_package_files::is_deleted.eq(false))
        .first::<retrom::EmulatorPackageFile>(&mut conn)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let file_path = package_file.absolute_path;
    let filename = std::path::Path::new(&package_file.relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");

    let file = File::open(&file_path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let reader_stream = ReaderStream::new(file).map_ok(Bytes::from);
    let body = axum::body::Body::from_stream(reader_stream);

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(response)
}

#[derive(Debug, Deserialize)]
struct UploadPreserveQuery {
    relative_path: String,
}

async fn upload_preserve_file_handler(
    Extension(pool): Extension<Arc<Pool>>,
    Path(package_id): Path<i32>,
    Query(query): Query<UploadPreserveQuery>,
    body: Bytes,
) -> Result<StatusCode, StatusCode> {
    if body.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut conn = pool.get().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let package = schema::emulator_packages::table
        .filter(schema::emulator_packages::id.eq(package_id))
        .filter(schema::emulator_packages::is_deleted.eq(false))
        .first::<retrom::EmulatorPackage>(&mut conn)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    // Read preserve prefixes from the on-disk manifest (authoritative for what is user data area)
    let manifest_path = std::path::Path::new(&package.root_path).join("retrom-emulator-package.json");
    let manifest_data = std::fs::read_to_string(&manifest_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let preserve_paths: Vec<String> = manifest
        .get("preserve_paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| s.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let rel = query.relative_path.replace('\\', "/").trim_start_matches('/').to_string();
    if rel.is_empty() || rel.contains("..") {
        return Err(StatusCode::BAD_REQUEST);
    }

    let is_allowed = preserve_paths.iter().any(|prefix| {
        let p = prefix.trim_end_matches('/');
        rel == p || rel.starts_with(&format!("{}/", p))
    });
    if !is_allowed {
        // Only allow writes inside declared preserve areas (games, firmware, keys, raps etc.)
        return Err(StatusCode::FORBIDDEN);
    }

    let dest_path = std::path::Path::new(&package.root_path).join(&rel);
    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }

    // Write (overwrite ok for push-latest-wins within personal cloud)
    let mut file = File::create(&dest_path).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    file.write_all(&body).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    file.flush().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Keep the package file index live so that GetEmulatorPackageFiles immediately
    // reflects the uploaded user data (new RAP, installed game, firmware, key, etc.).
    // Other clients will see the new files on their next ensure without requiring
    // a manual "Update Emulator Packages".
    let now = SystemTime::now();
    let size = body.len() as i64;
    // Compute sha for the just-written content (small overhead, keeps index accurate).
    let sha = sha256_bytes(&body);

    let new_file = NewEmulatorPackageFile {
        package_id,
        relative_path: rel.clone(),
        byte_size: size,
        sha256: sha,
        absolute_path: dest_path.to_string_lossy().to_string(),
        file_modified_at: Some(Timestamp::from(now)),
        optional: false,
        is_deleted: Some(false),
        deleted_at: None,
        created_at: Some(Timestamp::from(now)),
        updated_at: Some(Timestamp::from(now)),
    };

    // Upsert so new files appear and existing ones get updated sha/size/mtime.
    let _ = diesel::insert_into(schema::emulator_package_files::table)
        .values(&new_file)
        .on_conflict((
            schema::emulator_package_files::package_id,
            schema::emulator_package_files::relative_path,
        ))
        .do_update()
        .set((
            schema::emulator_package_files::byte_size.eq(size),
            schema::emulator_package_files::sha256.eq(&new_file.sha256),
            schema::emulator_package_files::absolute_path.eq(&new_file.absolute_path),
            schema::emulator_package_files::file_modified_at.eq(new_file.file_modified_at),
            schema::emulator_package_files::updated_at.eq(new_file.updated_at),
            schema::emulator_package_files::is_deleted.eq(false),
            schema::emulator_package_files::deleted_at.eq(None::<Timestamp>),
        ))
        .execute(&mut conn)
        .await;

    Ok(StatusCode::OK)
}

async fn delete_preserve_file_handler(
    Extension(pool): Extension<Arc<Pool>>,
    Path(package_id): Path<i32>,
    Query(query): Query<UploadPreserveQuery>,
) -> Result<StatusCode, StatusCode> {
    let mut conn = pool.get().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let package = schema::emulator_packages::table
        .filter(schema::emulator_packages::id.eq(package_id))
        .filter(schema::emulator_packages::is_deleted.eq(false))
        .first::<retrom::EmulatorPackage>(&mut conn)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    // Authorize: must be under user_data or preserve paths
    let manifest_path = std::path::Path::new(&package.root_path).join("retrom-emulator-package.json");
    let manifest_data = std::fs::read_to_string(&manifest_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let user_data_paths: Vec<String> = manifest
        .get("user_data_paths")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let preserve_paths: Vec<String> = manifest
        .get("preserve_paths")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_else(|| user_data_paths.clone());  // fallback

    let all_allowed: Vec<String> = if !user_data_paths.is_empty() {
        user_data_paths
    } else {
        preserve_paths
    };

    let rel = query.relative_path.replace('\\', "/").trim_start_matches('/').to_string();
    if rel.is_empty() || rel.contains("..") {
        return Err(StatusCode::BAD_REQUEST);
    }

    let is_allowed = all_allowed.iter().any(|prefix| {
        let p = prefix.trim_end_matches('/');
        rel == p || rel.starts_with(&format!("{}/", p))
    });
    if !is_allowed {
        return Err(StatusCode::FORBIDDEN);
    }

    let dest_path = std::path::Path::new(&package.root_path).join(&rel);

    // Delete from FS if exists
    if dest_path.exists() {
        if dest_path.is_dir() {
            std::fs::remove_dir_all(&dest_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        } else {
            std::fs::remove_file(&dest_path).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
    }

    // Remove from index so it no longer appears in remote files for clients
    let _ = diesel::delete(
        schema::emulator_package_files::table
            .filter(schema::emulator_package_files::package_id.eq(package_id))
            .filter(schema::emulator_package_files::relative_path.eq(&rel)),
    )
    .execute(&mut conn)
    .await;

    Ok(StatusCode::OK)
}

fn sha256_bytes(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

pub async fn emulator_package_manifest_handler(
    Extension(pool): Extension<Arc<Pool>>,
    Path(package_id): Path<i32>,
) -> Result<Response, StatusCode> {
    let mut conn = pool.get().await.unwrap();

    let package = schema::emulator_packages::table
        .filter(schema::emulator_packages::id.eq(package_id))
        .filter(schema::emulator_packages::is_deleted.eq(false))
        .first::<retrom::EmulatorPackage>(&mut conn)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let manifest_path = std::path::Path::new(&package.root_path)
        .join("retrom-emulator-package.json");

    let file = File::open(&manifest_path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let reader_stream = ReaderStream::new(file).map_ok(Bytes::from);
    let body = axum::body::Body::from_stream(reader_stream);

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"retrom-emulator-package.json\"",
        )
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(response)
}
