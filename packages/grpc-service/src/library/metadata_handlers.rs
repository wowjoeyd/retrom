use super::LibraryServiceHandlers;
use crate::jobs::job_manager::{JobError, JobOptions};
use bigdecimal::ToPrimitive;
use chrono::DateTime;
use diesel::prelude::*;
use diesel_async::RunQueryDsl;
use retrom_codegen::retrom::{
    self,
    get_igdb_search_request::IgdbSearchType,
    igdb_fields::{IncludeFields, Selector},
    igdb_filters::{FilterOperator, FilterValue},
    igdb_game_search_query, igdb_platform_search_query, GameGenre, GameMetadata,
    GetIgdbSearchRequest, IgdbFields, IgdbFilters, IgdbGameSearchQuery, IgdbPlatformSearchQuery,
    NewGameGenre, NewGameGenreMap, NewSimilarGameMap, PlatformMetadata,
    UpdateLibraryMetadataResponse, UpdatedGameMetadata,
};
use retrom_codegen::timestamp::Timestamp;
use retrom_db::schema;
use retrom_service_common::media_cache::cacheable_media::CacheableMetadata;
use retrom_service_common::metadata_providers::{
    igdb::provider::IgdbSearchData,
    soundtrack::{compress_theme_audio, find_theme_audio_file, set_youtube_cookies_path},
    GameMetadataProvider, MetadataProvider, PlatformMetadataProvider,
};
use retrom_service_common::retrom_dirs::RetromDirs;
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    sync::Arc,
};
use tracing::instrument;

#[instrument(skip(state))]
pub async fn update_metadata(
    state: &LibraryServiceHandlers,
    req: retrom_codegen::retrom::UpdateLibraryMetadataRequest,
) -> Result<UpdateLibraryMetadataResponse, String> {
    let overwrite = req.overwrite.unwrap_or(false);
    let db_pool = state.db_pool.clone();

    // Sync cookies path from config into the global soundtrack module state.
    {
        let cfg = state.config_manager.get_config().await;
        let cookies_path = cfg
            .metadata
            .as_ref()
            .and_then(|m| m.youtube_cookies_path.as_ref())
            .map(std::path::PathBuf::from);
        set_youtube_cookies_path(cookies_path).await;
    }
    let mut conn = match db_pool.get().await {
        Ok(conn) => conn,
        Err(why) => {
            tracing::error!("Failed to get connection: {}", why);
            return Err(why.to_string());
        }
    };

    let platforms = match schema::platforms::table
        .filter(schema::platforms::third_party.eq(false))
        .load::<retrom::Platform>(&mut conn)
        .await
    {
        Ok(platforms) => platforms,
        Err(e) => {
            tracing::error!("Failed to load platforms: {}", e);
            vec![]
        }
    };

    let platform_tasks = platforms
        .into_iter()
        .map(|platform| {
            let igdb_provider = state.igdb_client.clone();
            let db_pool = db_pool.clone();

            async move {
                let mut conn = match db_pool.get().await {
                    Ok(conn) => conn,
                    Err(why) => {
                        tracing::error!("Failed to get connection: {}", why);
                        return Err(why.to_string());
                    }
                };

                let existing = PlatformMetadata::belonging_to(&platform)
                    .first::<PlatformMetadata>(&mut conn)
                    .await
                    .optional()
                    .ok()
                    .flatten();

                let mut query = IgdbPlatformSearchQuery {
                    fields: Some(igdb_platform_search_query::Fields::default()),
                    ..Default::default()
                };

                if let Some(exists) = existing.and_then(|meta| meta.igdb_id) {
                    query
                        .fields
                        .as_mut()
                        .unwrap()
                        .id
                        .replace(exists.to_u64().unwrap());
                };

                drop(conn);

                let metadata = igdb_provider
                    .get_platform_metadata(platform, Some(query))
                    .await;

                if let Some(metadata) = metadata {
                    let mut conn = match db_pool.get().await {
                        Ok(conn) => conn,
                        Err(why) => {
                            tracing::error!("Failed to get connection: {}", why);
                            return Err(why.to_string());
                        }
                    };

                    diesel::insert_into(schema::platform_metadata::table)
                        .values(&metadata)
                        .on_conflict(schema::platform_metadata::platform_id)
                        .do_update()
                        .set(&metadata)
                        .execute(&mut conn)
                        .await
                        .map_err(|e| {
                            tracing::error!("Failed to insert metadata: {}", e);
                            e.to_string()
                        })?;
                };

                tracing::debug!("Platform metadata task completed");

                Ok(())
            }
        })
        .collect();

    let games: Vec<retrom::Game> = schema::games::table
        .filter(schema::games::third_party.eq(false))
        .load(&mut conn)
        .await
        .map_err(|e| {
            tracing::error!("Failed to load games: {}", e);
            e.to_string()
        })?;

    // Collect IDs before `games` is moved into extra_metadata_tasks below.
    let non_third_party_game_ids: Vec<i32> = games.iter().map(|g| g.id).collect();

    let game_tasks = games
        .iter()
        .map(|game| {
            let game = game.clone();
            let igdb_provider = state.igdb_client.clone();
            let db_pool = db_pool.clone();

            async move {
                let mut conn = match db_pool.get().await {
                    Ok(conn) => conn,
                    Err(why) => {
                        return Err(why.to_string());
                    }
                };

                let existing = GameMetadata::belonging_to(&game)
                    .first::<GameMetadata>(&mut conn)
                    .await
                    .optional()
                    .ok()
                    .flatten();

                if existing.is_some() && !overwrite {
                    return Ok(());
                }

                let mut query = IgdbGameSearchQuery {
                    fields: Some(igdb_game_search_query::Fields::default()),
                    ..Default::default()
                };

                if let Some(id) = game.platform_id {
                    let platform_meta: Option<PlatformMetadata> = schema::platform_metadata::table
                        .find(id)
                        .first(&mut conn)
                        .await
                        .ok();

                    let platform_igdb_id = platform_meta
                        .and_then(|meta| meta.igdb_id)
                        .and_then(|id| id.to_u64());

                    if let Some(igdb_id) = platform_igdb_id {
                        query.fields.as_mut().unwrap().platform.replace(igdb_id);
                    }
                };

                if let Some(igdb_id) = existing.as_ref().and_then(|meta| meta.igdb_id) {
                    query
                        .fields
                        .as_mut()
                        .unwrap()
                        .id
                        .replace(igdb_id.to_u64().unwrap());
                };

                // don't hold the db connection while we fetch metadata, as we are likely
                // to be rate limited
                drop(conn);
                let metadata = igdb_provider.get_game_metadata(game, Some(query)).await;

                if let Some(mut metadata) = metadata {
                    // When overwriting, preserve non-empty media arrays from the existing row.
                    // IGDB sometimes returns no artwork/screenshots for a match (e.g. a less
                    // common region variant), which would wipe the Images/Screenshots UI tabs.
                    if overwrite {
                        if let Some(ref existing_meta) = existing {
                            if metadata.artwork_urls.is_empty() {
                                metadata.artwork_urls = existing_meta.artwork_urls.clone();
                            }
                            if metadata.screenshot_urls.is_empty() {
                                metadata.screenshot_urls = existing_meta.screenshot_urls.clone();
                            }
                        }
                    }

                    let mut conn = match db_pool.get().await {
                        Ok(conn) => conn,
                        Err(why) => {
                            return Err(why.to_string());
                        }
                    };

                    if let Err(e) = diesel::insert_into(schema::game_metadata::table)
                        .values(&metadata)
                        .on_conflict(schema::game_metadata::game_id)
                        .do_update()
                        .set(&metadata)
                        .get_results::<retrom::GameMetadata>(&mut conn)
                        .await
                        .optional()
                    {
                        return Err(e.to_string());
                    };
                };

                tracing::debug!("Game metadata task completed");

                Ok(())
            }
        })
        .collect();

    let extra_metadata_tasks = games
        .into_iter()
        .map(|game| {
            let igdb_provider = state.igdb_client.clone();
            let db_pool = db_pool.clone();

            async move {
                let mut conn = match db_pool.get().await {
                    Ok(conn) => conn,
                    Err(why) => {
                        return Err(why.to_string());
                    }
                };

                let game_meta: GameMetadata = match schema::game_metadata::table
                    .filter(schema::game_metadata::game_id.eq(game.id))
                    .first::<retrom::GameMetadata>(&mut conn)
                    .await
                {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        tracing::debug!("Game does not have metadata");
                        return Ok(());
                    }
                };

                // don't hold the db connection while we fetch metadata, as we are likely
                // to be rate limited
                drop(conn);

                let game_igdb_id = match game_meta.igdb_id {
                    Some(id) => id,
                    None => {
                        tracing::debug!("Game does not have an IGDB ID");
                        return Ok(());
                    }
                };

                let mut filter_map = HashMap::<String, FilterValue>::new();

                filter_map.insert(
                    "id".to_string(),
                    FilterValue {
                        value: game_igdb_id.to_string(),
                        operator: i32::from(FilterOperator::Equal).into(),
                    },
                );

                let filters = IgdbFilters {
                    filters: filter_map,
                }
                .into();

                let fields = IgdbFields {
                    selector: Some(Selector::Include(IncludeFields {
                        value: [
                            "genres.*",
                            "similar_games.id",
                            "franchise.games.id",
                            "franchises.games.id",
                        ]
                        .into_iter()
                        .map(String::from)
                        .collect(),
                    })),
                }
                .into();

                let query = GetIgdbSearchRequest {
                    search_type: IgdbSearchType::Game.into(),
                    fields,
                    filters,
                    ..Default::default()
                };

                let extra_metadata = match igdb_provider.search_metadata(query).await {
                    Some(IgdbSearchData::Game(matches)) => matches,
                    _ => {
                        return Ok(());
                    }
                };

                let mut similar_game_ids = HashSet::new();

                extra_metadata.games.iter().for_each(|game| {
                    game.similar_games.iter().for_each(|game| {
                        similar_game_ids.insert(game.id);
                    });

                    if let Some(franchise) = game.franchise.as_ref() {
                        franchise.games.iter().for_each(|game| {
                            similar_game_ids.insert(game.id);
                        });
                    }

                    game.franchises.iter().for_each(|franchise| {
                        franchise.games.iter().for_each(|game| {
                            similar_game_ids.insert(game.id);
                        });
                    });
                });

                let mut conn = match db_pool.get().await {
                    Ok(conn) => conn,
                    Err(why) => {
                        return Err(why.to_string());
                    }
                };

                let similar_game_metas = match schema::game_metadata::table
                    .filter(
                        schema::game_metadata::igdb_id
                            .eq_any(similar_game_ids.iter().map(|id| id.to_i64())),
                    )
                    .load::<retrom::GameMetadata>(&mut conn)
                    .await
                {
                    Ok(metas) => metas,
                    Err(why) => {
                        tracing::error!("Failed to load similar game metadata: {}", why);
                        return Err(why.to_string());
                    }
                };

                drop(conn);

                let new_similar_game_maps = similar_game_ids
                    .into_iter()
                    .filter_map(|id| {
                        let similar_game_id = match similar_game_metas
                            .iter()
                            .find(|metadata| metadata.igdb_id == id.to_i64())
                            .map(|metadata| metadata.game_id)
                        {
                            Some(id) => id,
                            None => return None,
                        };

                        if similar_game_id == game_meta.game_id {
                            return None;
                        }

                        Some(NewSimilarGameMap {
                            game_id: game_meta.game_id,
                            similar_game_id,
                            ..Default::default()
                        })
                    })
                    .collect::<Vec<_>>();

                let new_genres = extra_metadata
                    .games
                    .iter()
                    .flat_map(|igdb_game| {
                        igdb_game.genres.iter().map(|genre| NewGameGenre {
                            slug: genre.slug.clone(),
                            name: genre.name.clone(),
                            ..Default::default()
                        })
                    })
                    .collect::<Vec<_>>();

                let mut conn = match db_pool.get().await {
                    Ok(conn) => conn,
                    Err(why) => {
                        return Err(why.to_string());
                    }
                };

                if let Err(why) = diesel::insert_into(schema::similar_game_maps::table)
                    .values(&new_similar_game_maps)
                    .on_conflict_do_nothing()
                    .execute(&mut conn)
                    .await
                {
                    tracing::error!("Failed to insert similar games: {}", why);
                }

                if let Err(why) = diesel::insert_into(schema::game_genres::table)
                    .values(&new_genres)
                    .on_conflict_do_nothing()
                    .execute(&mut conn)
                    .await
                {
                    tracing::error!("Failed to insert genres: {}", why);
                }

                let genres: Vec<GameGenre> = schema::game_genres::table
                    .filter(
                        schema::game_genres::slug
                            .eq_any(new_genres.iter().map(|genre| &genre.slug)),
                    )
                    .load(&mut conn)
                    .await
                    .unwrap_or_default();

                let new_genre_maps = genres
                    .into_iter()
                    .map(|genre| NewGameGenreMap {
                        game_id: game_meta.game_id,
                        genre_id: genre.id,
                        ..Default::default()
                    })
                    .collect::<Vec<_>>();

                if let Err(why) = diesel::insert_into(schema::game_genre_maps::table)
                    .values(&new_genre_maps)
                    .on_conflict_do_nothing()
                    .execute(&mut conn)
                    .await
                {
                    tracing::error!("Failed to insert genre maps: {}", why);
                }

                drop(conn);

                tracing::debug!("Extra metadata task completed");

                Ok(())
            }
        })
        .collect();

    let steam_provider = state.steam_web_api_client.clone();
    let all_steam_apps = match steam_provider.get_owned_games().await {
        Ok(res) => res.response.games,
        Err(e) => {
            // This is common and non-fatal when Steam integration is not fully
            // configured, the token is expired, or the user has no Steam games.
            // It only affects Steam-linked titles; regular emulator ROM metadata
            // continues via IGDB.
            tracing::warn!("Failed to get owned Steam games: {}", e);
            vec![]
        }
    };

    let steam_games: Arc<Vec<retrom::Game>> = Arc::new(
        schema::games::table
            .filter(schema::games::steam_app_id.is_not_null())
            .load::<retrom::Game>(&mut conn)
            .await
            .unwrap_or_default(),
    );

    let steam_tasks: Vec<_> = all_steam_apps
        .into_iter()
        .filter_map(|app| {
            let steam_provider = steam_provider.clone();
            let db_pool = db_pool.clone();
            let steam_games = steam_games.clone();
            let steam_appid = app.appid;

            let game = match steam_games
                .iter()
                .find(|game| game.steam_app_id == steam_appid.to_i64())
            {
                Some(game) => game.clone(),
                None => {
                    tracing::warn!("No game found for Steam App ID: {}", steam_appid);
                    return None;
                }
            };

            let game_id = game.id;

            Some(async move {
                let mut conn = db_pool.get().await.expect("Failed to get connection");

                let existing = schema::game_metadata::table
                    .find(game.id)
                    .first::<retrom::GameMetadata>(&mut conn)
                    .await;

                // don't hold the db connection while we fetch metadata, as we are likely
                // to be rate limited
                drop(conn);

                // Fast path: metadata exists WITH Steam-sourced content (screenshots or artwork)
                // and the caller did not request overwrite. Only refresh playtime/last-played.
                //
                // An existing row WITHOUT screenshots/artwork (e.g. an IGDB-only row written by
                // a concurrent IGDB task, or a prior partial scrape) does not qualify — we still
                // run the full Steam fetch so the game gets its images and videos.
                let has_steam_content = existing.as_ref().ok().is_some_and(|meta| {
                    !meta.screenshot_urls.is_empty() || !meta.artwork_urls.is_empty()
                });
                if has_steam_content && !overwrite {
                    let last_played = if app.rtime_last_played > 0 {
                        DateTime::from_timestamp(app.rtime_last_played, 0).map(|dt| Timestamp {
                            seconds: dt.timestamp(),
                            nanos: 0,
                        })
                    } else {
                        None
                    };
                    let minutes_played = if app.playtime_forever > 0 {
                        Some(app.playtime_forever)
                    } else {
                        None
                    };

                    let updated_meta = UpdatedGameMetadata {
                        last_played,
                        minutes_played,
                        ..Default::default()
                    };

                    let mut conn = db_pool.get().await.expect("Failed to get connection");
                    if let Err(why) = diesel::update(schema::game_metadata::table)
                        .filter(schema::game_metadata::game_id.eq(game_id))
                        .set(&updated_meta)
                        .execute(&mut conn)
                        .await
                    {
                        tracing::error!("Failed to update metadata: {}", why);
                    }

                    return Ok(());
                }

                // Slow path: no existing metadata OR overwrite requested — call the Store API.
                let metadata = match steam_provider.get_game_metadata(game, Some(app)).await {
                    Some(meta) => meta,
                    None => {
                        tracing::warn!(
                            "No metadata found for game with Steam App ID: {}",
                            steam_appid
                        );
                        return Ok(());
                    }
                };

                let mut conn = db_pool.get().await.expect("Failed to get connection");

                if let Err(why) = diesel::insert_into(schema::game_metadata::table)
                    .values(&metadata)
                    .on_conflict(schema::game_metadata::game_id)
                    .do_update()
                    .set(&metadata)
                    .execute(&mut conn)
                    .await
                {
                    tracing::error!("Failed to update metadata: {}", why);
                }

                tracing::debug!("Steam metadata task completed");

                Ok::<(), Infallible>(())
            })
        })
        .collect();

    let job_manager = state.job_manager.clone();
    let platform_metadata_job_id = match job_manager
        .spawn("Downloading Platform Metadata", platform_tasks, None)
        .await
    {
        Ok(id) => id,
        Err(JobError::JobAlreadyRunning(_)) => {
            return Err("Platform metadata job is already running".to_string())
        }
        _ => return Err("Failed to spawn platform metadata job".to_string()),
    };

    // Spawn Steam metadata tasks BEFORE the IGDB game tasks so the game tasks can depend
    // on them. This eliminates the race where IGDB inserts a row first, causing the Steam
    // fast-path to see `existing.is_ok()` and skip the full Steam fetch entirely.
    let steam_metadata_job_uuid: Option<uuid::Uuid> = if !steam_tasks.is_empty() {
        let id = match job_manager
            .spawn("Downloading Steam Metadata", steam_tasks, None)
            .await
        {
            Ok(id) => id,
            Err(JobError::JobAlreadyRunning(_)) => {
                return Err("Steam metadata job is already running".to_string())
            }
            _ => return Err("Failed to spawn Steam metadata job".to_string()),
        };
        Some(id)
    } else {
        None
    };
    let steam_metadata_job_id = steam_metadata_job_uuid.map(|id| id.to_string());

    // Game (IGDB) tasks wait on both the platform job and the Steam job so they always
    // see Steam-written rows before checking `existing`, preserving Steam data for
    // Steam-linked games when overwrite=false.
    let mut game_wait_list = vec![platform_metadata_job_id];
    if let Some(steam_uuid) = steam_metadata_job_uuid {
        game_wait_list.push(steam_uuid);
    }
    let game_job_opts = JobOptions {
        wait_on_jobs: Some(game_wait_list),
        max_concurrency: None,
    };

    let game_metadata_job_id = match job_manager
        .spawn("Downloading Game Metadata", game_tasks, Some(game_job_opts))
        .await
    {
        Ok(id) => id,
        Err(JobError::JobAlreadyRunning(_)) => {
            return Err("Game metadata job is already running".to_string())
        }
        _ => return Err("Failed to spawn game metadata job".to_string()),
    };

    let extra_metadata_job_opts = JobOptions {
        wait_on_jobs: Some(vec![game_metadata_job_id]),
        max_concurrency: None,
    };

    let extra_metadata_job_id = match job_manager
        .spawn(
            "Downloading Extra Metadata",
            extra_metadata_tasks,
            Some(extra_metadata_job_opts),
        )
        .await
    {
        Ok(id) => id,
        Err(JobError::JobAlreadyRunning(_)) => {
            return Err("Extra metadata job is already running".to_string())
        }
        _ => return Err("Failed to spawn extra metadata job".to_string()),
    };

    // Compress any already-downloaded theme audio files. Music downloads are now explicit
    // (per-game via the "Re-download theme audio" checkbox), so this pass only re-encodes
    // files that exist on disk — no YouTube search or yt-dlp invocation here.
    let compress_tasks: Vec<_> = non_third_party_game_ids
        .into_iter()
        .map(|game_id| {
            let db_pool = db_pool.clone();
            async move {
                let mut conn = match db_pool.get().await {
                    Ok(c) => c,
                    Err(_) => return Ok::<(), ()>(()),
                };

                let meta_row: retrom::GameMetadata = match schema::game_metadata::table
                    .filter(schema::game_metadata::game_id.eq(game_id))
                    .first::<retrom::GameMetadata>(&mut conn)
                    .await
                {
                    Ok(m) => m,
                    Err(_) => return Ok(()),
                };
                drop(conn);

                let cache_dir = meta_row.get_cache_dir().unwrap_or_else(|| {
                    RetromDirs::new()
                        .media_dir()
                        .join("games")
                        .join(game_id.to_string())
                });

                if let Some(theme_file) = find_theme_audio_file(&cache_dir) {
                    // This pass only (re)compresses the already-extracted primary
                    // track and has no source video id to probe a title from; the
                    // title is captured by the extraction paths (download /
                    // per-game update / auto-download) and resolved on read from
                    // the embedded tag.
                    compress_theme_audio(&theme_file, &cache_dir, "theme", None).await;
                }

                Ok(())
            }
        })
        .collect();

    let compress_job_id = if !compress_tasks.is_empty() {
        let mut compress_wait = vec![extra_metadata_job_id];
        if let Some(steam_uuid) = steam_metadata_job_uuid {
            compress_wait.push(steam_uuid);
        }
        let compress_opts = JobOptions {
            wait_on_jobs: Some(compress_wait),
            max_concurrency: Some(4),
        };
        match job_manager
            .spawn(
                "Compressing Game Audio",
                compress_tasks,
                Some(compress_opts),
            )
            .await
        {
            Ok(uuid) => Some(uuid.to_string()),
            Err(_) => None,
        }
    } else {
        None
    };

    Ok(UpdateLibraryMetadataResponse {
        platform_metadata_job_id: platform_metadata_job_id.to_string(),
        game_metadata_job_id: game_metadata_job_id.to_string(),
        extra_metadata_job_id: extra_metadata_job_id.to_string(),
        steam_metadata_job_id,
        theme_audio_job_id: compress_job_id,
    })
}
