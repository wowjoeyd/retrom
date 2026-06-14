use axum::{
    middleware::{self as axum_middleware},
    response::Redirect,
    routing::get,
    Extension, Router,
};
use axum_tracing_opentelemetry::middleware::{OtelAxumLayer, OtelInResponseLayer};
use emulator_package_file::emulator_package_file_routes;
use file::file_routes;
use game::game_routes;
use middleware::{
    cache_control::cache_control_middleware,
    cross_origin_isolation::cross_origin_isolation_middleware,
};
use public::public_routes;
use retrom_db::Pool;
use std::sync::Arc;
use tower_http::{
    compression::{
        predicate::{DefaultPredicate, NotForContentType, Predicate},
        CompressionLayer,
    },
    cors::CorsLayer,
    decompression::RequestDecompressionLayer,
};
use web::web_routes;

pub mod emulator_package_file;
pub mod error;
pub mod file;
pub mod game;
mod middleware;
mod public;
mod web;

fn emulator_packages_enabled() -> bool {
    std::env::var("RETROM_EMULATOR_PACKAGES_ENABLED")
        .map(|value| value != "false")
        .unwrap_or(true)
}

pub fn rest_service(pool: Arc<Pool>) -> Router {
    let mut api_routes = Router::new()
        .nest("/file", file_routes())
        .nest("/game", game_routes())
        .nest("/public", public_routes());

    if emulator_packages_enabled() {
        api_routes = api_routes.nest("/emulator-package-file", emulator_package_file_routes());
    }

    Router::new()
        .nest("/rest", api_routes)
        // use nest_service so both `/web` and `/web/` are defined
        // https://github.com/tokio-rs/axum/issues/2659#issuecomment-2676985411
        .nest_service("/web", web_routes())
        .layer(OtelInResponseLayer)
        .layer(OtelAxumLayer::default())
        .layer(axum_middleware::from_fn(cross_origin_isolation_middleware))
        .route(
            "/",
            get(|| async { Redirect::to("/web") }).head(|| async { Redirect::to("/web") }),
        )
        .layer(Extension(pool))
        .layer(CorsLayer::permissive())
        .layer(RequestDecompressionLayer::new())
        // Compress text/JSON responses, but NEVER compress binary file downloads
        // (ROMs, emulator packages). Gzipping multi-GB incompressible octet-streams on the
        // fly wastes huge CPU and throttles download throughput to a crawl.
        .layer(CompressionLayer::new().compress_when(
            DefaultPredicate::new().and(NotForContentType::const_new("application/octet-stream")),
        ))
        .layer(axum_middleware::from_fn(cache_control_middleware))
}
