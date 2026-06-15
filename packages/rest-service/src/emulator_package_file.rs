use axum::{
    body::Bytes,
    extract::{Path, Query},
    http::{header, StatusCode},
    response::Response,
    routing::{get, post},
    Extension, Router,
};
use diesel::{prelude::*, upsert::excluded};
use diesel_async::RunQueryDsl;
use futures_util::TryStreamExt;
use retrom_codegen::{retrom, timestamp::Timestamp};
use retrom_db::{schema, Pool};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path as StdPath, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::{fs, fs::File};
use tokio_util::io::ReaderStream;

pub fn emulator_package_file_routes() -> Router {
    Router::new()
        .route("/{fileId}", get(emulator_package_file_handler))
        .route(
            "/{packageId}/manifest",
            get(emulator_package_manifest_handler),
        )
        .route(
            "/preserve/{packageId}",
            post(upload_preserve_file_handler).delete(delete_preserve_file_handler),
        )
}

#[derive(Debug, Deserialize)]
pub struct PreserveFileQuery {
    relative_path: String,
}

pub async fn emulator_package_file_handler(
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
        .header("x-retrom-emulator-package-file-origin", "package-or-user")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(response)
}

pub async fn emulator_package_manifest_handler(
    Extension(pool): Extension<Arc<Pool>>,
    Path(package_id): Path<i32>,
) -> Result<Response, StatusCode> {
    let mut conn = pool
        .get()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let package = schema::emulator_packages::table
        .filter(schema::emulator_packages::id.eq(package_id))
        .filter(schema::emulator_packages::is_deleted.eq(false))
        .first::<retrom::EmulatorPackage>(&mut conn)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let manifest_path = PathBuf::from(&package.root_path).join("retrom-emulator-package.json");
    let file = File::open(&manifest_path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let reader_stream = ReaderStream::new(file).map_ok(Bytes::from);
    let body = axum::body::Body::from_stream(reader_stream);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"retrom-emulator-package.json\"",
        )
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn upload_preserve_file_handler(
    Extension(pool): Extension<Arc<Pool>>,
    Path(package_id): Path<i32>,
    Query(query): Query<PreserveFileQuery>,
    body: Bytes,
) -> Result<Response, StatusCode> {
    let mut conn = pool
        .get()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let package = schema::emulator_packages::table
        .filter(schema::emulator_packages::id.eq(package_id))
        .filter(schema::emulator_packages::is_deleted.eq(false))
        .first::<retrom::EmulatorPackage>(&mut conn)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let relative_path = sanitize_relative_path(&query.relative_path)?;
    let destination = PathBuf::from(&package.root_path).join(&relative_path);

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    fs::write(&destination, &body)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let now = Timestamp::from(SystemTime::now());
    let sha256 = format!("{:x}", Sha256::digest(&body));
    let new_file = retrom::NewEmulatorPackageFile {
        package_id,
        relative_path: relative_path.clone(),
        byte_size: body.len() as i64,
        sha256,
        absolute_path: destination.to_string_lossy().to_string(),
        file_modified_at: Some(now),
        optional: true,
        is_deleted: Some(false),
        deleted_at: None,
        created_at: Some(now),
        updated_at: Some(now),
    };

    diesel::insert_into(schema::emulator_package_files::table)
        .values(new_file)
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
            schema::emulator_package_files::optional.eq(true),
            schema::emulator_package_files::is_deleted.eq(false),
            schema::emulator_package_files::deleted_at.eq(None::<Timestamp>),
            schema::emulator_package_files::updated_at.eq(Some(now)),
        ))
        .execute(&mut conn)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("x-retrom-emulator-package-file-origin", "user-added")
        .body(axum::body::Body::empty())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

pub async fn delete_preserve_file_handler(
    Extension(pool): Extension<Arc<Pool>>,
    Path(package_id): Path<i32>,
    Query(query): Query<PreserveFileQuery>,
) -> Result<Response, StatusCode> {
    let mut conn = pool
        .get()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let package = schema::emulator_packages::table
        .filter(schema::emulator_packages::id.eq(package_id))
        .filter(schema::emulator_packages::is_deleted.eq(false))
        .first::<retrom::EmulatorPackage>(&mut conn)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;

    let relative_path = sanitize_relative_path(&query.relative_path)?;
    let destination = PathBuf::from(&package.root_path).join(&relative_path);
    let _ = fs::remove_file(&destination).await;

    let now = Timestamp::from(SystemTime::now());
    diesel::update(schema::emulator_package_files::table)
        .filter(schema::emulator_package_files::package_id.eq(package_id))
        .filter(schema::emulator_package_files::relative_path.eq(relative_path))
        .set((
            schema::emulator_package_files::is_deleted.eq(true),
            schema::emulator_package_files::deleted_at.eq(Some(now)),
            schema::emulator_package_files::updated_at.eq(Some(now)),
        ))
        .execute(&mut conn)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("x-retrom-emulator-package-file-origin", "user-added")
        .body(axum::body::Body::empty())
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn sanitize_relative_path(relative_path: &str) -> Result<String, StatusCode> {
    let path = StdPath::new(relative_path);
    if relative_path.trim().is_empty() || path.is_absolute() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(StatusCode::BAD_REQUEST),
        }
    }

    if clean.as_os_str().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }

    Ok(clean.to_string_lossy().replace('\\', "/"))
}
