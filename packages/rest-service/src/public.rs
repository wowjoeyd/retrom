use axum::{
    extract::Path,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{any_service, get},
    Json, Router,
};
use http::Uri;
use std::collections::HashMap;
use retrom_codegen::retrom::{files::File, FilesystemNodeType};

use retrom_service_common::retrom_dirs::RetromDirs;
use std::path::PathBuf;
use tower_http::services::ServeDir;

pub fn public_routes() -> Router {
    let public_dir = RetromDirs::new().public_dir().clone();
    let dir_service = ServeDir::new(public_dir);

    Router::new()
        .route("/media/games/{game_id}/theme", get(serve_game_theme))
        // We keep the .ext variant so that direct requests like /theme.m4a still
        // go through our handler (which will serve a playable theme if any
        // theme.* exists for the game). The catch-all static ServeDir will
        // handle other media paths.
        .route("/media/games/{game_id}/theme.{ext}", get(serve_game_theme))
        .route(
            "/{*tail}",
            any_service(dir_service).post(post_file).delete(delete_file),
        )
}

#[tracing::instrument]
async fn post_file(Json(file): Json<File>) -> Result<Response, StatusCode> {
    let stat = match file.stat {
        Some(stat) => stat,
        None => return Err(StatusCode::BAD_REQUEST),
    };

    if PathBuf::from(&stat.path).is_absolute() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let path = RetromDirs::new().public_dir().join(stat.path);

    match FilesystemNodeType::try_from(stat.node_type) {
        Ok(FilesystemNodeType::File) => {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|_| StatusCode::NOT_FOUND)?;
            }
        }
        _ => return Err(StatusCode::BAD_REQUEST),
    }

    tokio::fs::write(&path, file.content)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    tracing::info!("File written to {:?}", path);

    Ok((StatusCode::CREATED, "Created").into_response())
}

#[tracing::instrument]
async fn delete_file(tail: Uri) -> Result<Response, StatusCode> {
    let path = RetromDirs::new().public_dir().join(tail.path());

    tracing::info!("Deleting filesystem entry at {:?}", tail.path());
    if !path.exists() {
        tracing::warn!("Filesystem entry not found at {:?}", path);
        return Err(StatusCode::NOT_FOUND);
    }

    match path.is_file() {
        true => {
            tokio::fs::remove_file(&path)
                .await
                .map_err(|_| StatusCode::NOT_FOUND)?;
        }
        false => {
            tokio::fs::remove_dir_all(&path)
                .await
                .map_err(|_| StatusCode::NOT_FOUND)?;
        }
    }

    tracing::info!("Filesystem entry deleted from {:?}", path);

    Ok((StatusCode::OK, "Deleted").into_response())
}

/// Special handler for the "magic" bare theme audio path.
/// Clients (fullscreen player and non-fullscreen Theme tab) may request the
/// bare /rest/public/media/games/{id}/theme when the metadata response only
/// gave the magic base (no exact themeAudioUrl with .ext).
/// We look under the *public* dir (where ServeDir serves the .m4a/.webm etc.
/// that the user can directly access) for any "theme.*" file and serve its
/// content with the correct type. This makes the bare magic path work
/// whenever a theme.* physically exists under the public/media/games/{id}/ tree,
/// without relying on the GetGameMetadata "include" having populated the exact URL.
///
/// The Path extractor provides the game_id (and optional ext) regardless of
/// nesting under /rest/public.
async fn serve_game_theme(Path(params): Path<HashMap<String, String>>) -> Response {
    let game_id = match params.get("game_id").and_then(|s| s.parse::<i32>().ok()) {
        Some(id) => id,
        None => return StatusCode::NOT_FOUND.into_response(),
    };

    let dirs = RetromDirs::new();
    let public_dir = dirs.public_dir();
    let game_dir = public_dir
        .join("media")
        .join("games")
        .join(game_id.to_string());
    if let Ok(entries) = std::fs::read_dir(&game_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                if name.starts_with("theme.") {
                    match tokio::fs::read(&p).await {
                        Ok(content) => {
                            let content_type = match p
                                .extension()
                                .and_then(|e| e.to_str())
                                .unwrap_or("")
                            {
                                "m4a" | "mp4" => "audio/mp4",
                                "webm" => "audio/webm",
                                "opus" | "ogg" => "audio/ogg",
                                "mp3" => "audio/mpeg",
                                "flac" => "audio/flac",
                                "wav" => "audio/wav",
                                _ => "audio/mpeg",
                            };
                            return (
                                StatusCode::OK,
                                [(header::CONTENT_TYPE, content_type)],
                                content,
                            )
                                .into_response();
                        }
                        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    }
                }
            }
        }
    }
    StatusCode::NOT_FOUND.into_response()
}
