use axum::Router;
use diesel_async::pooled_connection::AsyncDieselConnectionManager;
use emulator_packages::EmulatorPackageServiceHandlers;
use emulators::EmulatorServiceHandlers;
use file_explorer::FileExplorerServiceHandlers;
use games::GameServiceHandlers;
use http::HeaderName;
use jobs::{job_manager::JobManager, JobServiceHandlers};
use library::LibraryServiceHandlers;
use metadata::MetadataServiceHandlers;
use platforms::PlatformServiceHandlers;
use retrom_codegen::{
    descriptors::retrom::FILE_DESCRIPTOR_SET,
    retrom::{
        client_service_server::ClientServiceServer,
        emulator_package_service_server::EmulatorPackageServiceServer,
        emulator_service_server::EmulatorServiceServer,
        file_explorer_service_server::FileExplorerServiceServer,
        game_service_server::GameServiceServer,
        job_service_server::JobServiceServer,
        library_service_server::LibraryServiceServer,
        metadata_service_server::MetadataServiceServer,
        platform_service_server::PlatformServiceServer,
        remote_play_service_server::RemotePlayServiceServer,
        server_service_server::ServerServiceServer,
        services::saves::{
            v1::saves_service_server::SavesServiceServer,
            v2::emulator_saves_service_server::EmulatorSavesServiceServer,
        },
    },
};
use retrom_service_common::{
    achievements::{
        retroachievements::RetroAchievementsProvider, steam::SteamAchievementProvider,
        AchievementProvider, AchievementsService,
    },
    config::ServerConfigManager,
    media_cache::MediaCache,
    metadata_providers::{igdb::provider::IGDBProvider, steam::provider::SteamWebApiProvider},
    retroachievements::override_store::RaOverrideStore,
    retrom_dirs::RetromDirs,
};
use retrom_telemetry::grpc::{GrpcOnRequestSpan, GrpcOnResponseSpanHandler};
use saves::v1::service::SavesServiceHandlers;
use saves::v2::service::EmulatorSavesServiceHandlers;
use std::{sync::Arc, time::Duration};
use tower_http::cors::{AllowOrigin, CorsLayer};

pub mod clients;
pub mod emulator_packages;
pub mod emulators;
pub mod file_explorer;
pub mod games;
pub mod jobs;
pub mod library;
pub mod metadata;
pub mod platforms;
pub mod remote_play;
mod saves;
pub mod server;

const DEFAULT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const DEFAULT_EXPOSED_HEADERS: [HeaderName; 3] = [
    HeaderName::from_static("grpc-status"),
    HeaderName::from_static("grpc-message"),
    HeaderName::from_static("grpc-status-details-bin"),
];

const DEFAULT_ALLOW_HEADERS: [HeaderName; 7] = [
    HeaderName::from_static("x-grpc-web"),
    http::header::CONTENT_TYPE,
    HeaderName::from_static("x-user-agent"),
    HeaderName::from_static("grpc-timeout"),
    HeaderName::from_static("x-client-id"),
    HeaderName::from_static("traceparent"),
    HeaderName::from_static("tracestate"),
];

pub fn grpc_service(db_url: &str, config_manager: Arc<ServerConfigManager>) -> Router {
    use std::num::NonZeroUsize;
    let shared_pool_config =
        AsyncDieselConnectionManager::<diesel_async::AsyncPgConnection>::new(db_url);

    let library_pool_config =
        AsyncDieselConnectionManager::<diesel_async::AsyncPgConnection>::new(db_url);

    let num_cpus: usize = std::thread::available_parallelism()
        .unwrap_or(NonZeroUsize::new(2_usize).unwrap())
        .into();

    // shared pool used for service endpoints w/ light usage
    let shared_pool = Arc::new(
        deadpool::managed::Pool::builder(shared_pool_config)
            .max_size(num_cpus * 3)
            .build()
            .expect("Could not create pool"),
    );

    // The library service triggers jobs w/ many DB ops -- so we give it its own pool
    // so as to not starve the other services
    let library_pool = Arc::new(
        deadpool::managed::Pool::builder(library_pool_config)
            .max_size(num_cpus)
            .build()
            .expect("Could not create pool"),
    );

    let igdb_client = Arc::new(IGDBProvider::new(config_manager.clone()));
    let steam_web_api_client = Arc::new(SteamWebApiProvider::new(config_manager.clone()));

    let _retrom_dirs = RetromDirs::new();
    let media_cache = Arc::new(MediaCache::new(config_manager.clone()));

    // Unified achievements: one provider per source behind a single fetch/cache
    // service. Steam keys off the appid; RetroAchievements content-hashes ROMs.
    let ra_override_store = Arc::new(RaOverrideStore::new());
    let achievement_providers: Vec<Arc<dyn AchievementProvider>> = vec![
        Arc::new(SteamAchievementProvider::new(
            steam_web_api_client.clone(),
            config_manager.clone(),
        )),
        Arc::new(RetroAchievementsProvider::new(
            config_manager.clone(),
            ra_override_store.clone(),
        )),
    ];
    let achievements_service = Arc::new(AchievementsService::new(
        achievement_providers,
        media_cache.clone(),
    ));

    let job_manager = Arc::new(JobManager::new());

    let reflection_service = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(FILE_DESCRIPTOR_SET)
        .build_v1()
        .unwrap();

    let reflection_service_alpha = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(FILE_DESCRIPTOR_SET)
        .build_v1alpha()
        .unwrap();

    let library_service = LibraryServiceServer::new(LibraryServiceHandlers::new(
        library_pool.clone(),
        igdb_client.clone(),
        steam_web_api_client.clone(),
        job_manager.clone(),
        config_manager.clone(),
    ));

    let emulator_packages_enabled = emulator_packages::emulator_packages_enabled();

    let emulator_package_service =
        EmulatorPackageServiceServer::new(EmulatorPackageServiceHandlers::new(
            library_pool.clone(),
            job_manager.clone(),
            config_manager.clone(),
        ));

    let metadata_service = MetadataServiceServer::new(MetadataServiceHandlers::new(
        shared_pool.clone(),
        igdb_client.clone(),
        steam_web_api_client.clone(),
        media_cache.clone(),
        job_manager.clone(),
        config_manager.clone(),
        achievements_service.clone(),
        ra_override_store.clone(),
    ));

    // Proactively ensure yt-dlp binary is downloaded for the soundtrack theme audio extraction feature.
    // This makes the fullscreen game music preview "just work" in dev (pnpm nx dev retrom-client)
    // and prod without the user manually installing yt-dlp. The binary is placed in the app's
    // data dir (bin/yt-dlp or .exe) on first service start if missing.
    tokio::spawn(async {
        match retrom_service_common::metadata_providers::soundtrack::ensure_yt_dlp().await {
            Some(path) => tracing::info!(
                "yt-dlp binary ensured for theme audio extraction at {:?}",
                path
            ),
            None => tracing::warn!(
                "Could not ensure yt-dlp binary (theme audio extraction may fall back)"
            ),
        }
    });

    let game_service = GameServiceServer::new(GameServiceHandlers::new(shared_pool.clone()));
    let platform_service = PlatformServiceServer::new(PlatformServiceHandlers::new(
        shared_pool.clone(),
        config_manager.clone(),
    ));

    let client_service =
        ClientServiceServer::new(clients::ClientServiceHandlers::new(shared_pool.clone()));

    let remote_play_service = RemotePlayServiceServer::new(
        remote_play::RemotePlayServiceHandlers::new(shared_pool.clone()),
    );

    let server_service = ServerServiceServer::new(server::ServerServiceHandlers {
        config: config_manager.clone(),
    });

    let emulator_service =
        EmulatorServiceServer::new(EmulatorServiceHandlers::new(shared_pool.clone()));

    let job_service = JobServiceServer::new(JobServiceHandlers::new(job_manager.clone()));
    let file_explorer_service = FileExplorerServiceServer::new(FileExplorerServiceHandlers::new());

    let saves_service_v1 = SavesServiceServer::new(SavesServiceHandlers::new(
        shared_pool.clone(),
        config_manager.clone(),
    ));

    let emulator_saves_service_v2 =
        EmulatorSavesServiceServer::new(EmulatorSavesServiceHandlers::new(shared_pool.clone()));

    let mut routes_builder = tonic::service::Routes::builder();
    let mut reflection_route_builder = tonic::service::Routes::builder();
    reflection_route_builder
        .add_service(reflection_service)
        .add_service(reflection_service_alpha);

    let reflection_router = reflection_route_builder.routes();

    routes_builder.add_service(library_service);

    if emulator_packages_enabled {
        routes_builder.add_service(emulator_package_service);

        let scheduler_pool = library_pool.clone();
        let scheduler_jobs = job_manager.clone();
        let scheduler_config = config_manager.clone();
        tokio::spawn(async move {
            emulator_packages::run_emulator_package_scheduler(
                scheduler_pool,
                scheduler_jobs,
                scheduler_config,
            )
            .await;
        });
    }

    routes_builder
        .add_service(game_service)
        .add_service(platform_service)
        .add_service(metadata_service)
        .add_service(client_service)
        .add_service(remote_play_service)
        .add_service(server_service)
        .add_service(emulator_service)
        .add_service(job_service)
        .add_service(file_explorer_service)
        .add_service(saves_service_v1)
        .add_service(emulator_saves_service_v2);

    routes_builder
        .routes()
        .into_axum_router()
        .layer(tonic_web::GrpcWebLayer::new())
        .merge(reflection_router.into_axum_router().reset_fallback())
        .layer(
            tower_http::trace::TraceLayer::new_for_grpc()
                .make_span_with(GrpcOnRequestSpan::default())
                .on_response(GrpcOnResponseSpanHandler::default()),
        )
        .layer(
            CorsLayer::new()
                .allow_origin(AllowOrigin::mirror_request())
                .allow_credentials(true)
                .expose_headers(DEFAULT_EXPOSED_HEADERS)
                .allow_headers(DEFAULT_ALLOW_HEADERS)
                .max_age(DEFAULT_MAX_AGE),
        )
}
