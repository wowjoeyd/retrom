use axum::{
    body::Bytes,
    extract::Path,
    http::{header, StatusCode},
    response::Response,
    routing::get,
    Extension, Router,
};
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use futures_util::TryStreamExt;
use retrom_codegen::retrom;
use retrom_db::{schema, Pool};
use std::sync::Arc;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

pub fn emulator_package_file_routes() -> Router {
    Router::new().route("/{fileId}", get(emulator_package_file_handler))
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
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(response)
}