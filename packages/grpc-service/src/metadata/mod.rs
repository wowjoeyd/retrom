use crate::jobs::job_manager::JobError;
use chrono::DateTime;
use diesel::prelude::*;
use diesel_async::{scoped_futures::ScopedFutureExt, AsyncConnection, RunQueryDsl};
use futures::future::join_all;
use retrom_codegen::{
    retrom::{
        self,
        get_game_metadata_response::{GameGenres, MediaPaths, SimilarGames},
        get_igdb_search_request::IgdbSearchType,
        get_igdb_search_response::SearchResults,
        metadata_service_server::MetadataService,
        AutoDownloadGameSoundtrackRequest, AutoDownloadGameSoundtrackResponse,
        DeleteGameSoundtrackTrackRequest, DeleteGameSoundtrackTrackResponse,
        DeleteLocalMetadataRequest, DeleteLocalMetadataResponse, DownloadGameSoundtrackRequest,
        DownloadGameSoundtrackResponse, Game, GameAchievement, GameAchievementSet,
        GameAchievementsStatus, GameFile, GameGenre, GameGenreMap, GetGameAchievementsRequest,
        GetGameAchievementsResponse, GetGameMetadataRequest, GetGameMetadataResponse,
        GetIgdbGameSearchResultsRequest, GetIgdbGameSearchResultsResponse,
        GetIgdbPlatformSearchResultsRequest, GetIgdbPlatformSearchResultsResponse,
        GetIgdbSearchRequest, GetIgdbSearchResponse, GetLocalMetadataStatusRequest,
        GetLocalMetadataStatusResponse, GetPlatformMetadataRequest, GetPlatformMetadataResponse,
        IgdbSearchGameResponse, IgdbSearchPlatformResponse, SearchGameSoundtrackRequest,
        SearchGameSoundtrackResponse, SetGameAchievementsManualMatchRequest,
        SetGameAchievementsManualMatchResponse, SimilarGameMap,
        SoundtrackCandidate as SoundtrackCandidateProto, SyncSteamMetadataRequest,
        SyncSteamMetadataResponse, UpdateGameMetadataRequest, UpdateGameMetadataResponse,
        UpdateGamePlaytimeRequest, UpdateGamePlaytimeResponse, UpdatePlatformMetadataRequest,
        UpdatePlatformMetadataResponse, UpdatedGameMetadata,
    },
    timestamp::Timestamp,
};
use retrom_db::{schema, Pool};
use retrom_service_common::{
    achievements::{
        AchievementsService, AchievementsStatus, ProviderAchievement, ProviderAchievementSet,
    },
    media_cache::{cacheable_media::CacheableMetadata, get_public_url, MediaCache},
    metadata_providers::{
        igdb::provider::{IGDBProvider, IgdbSearchData},
        soundtrack::{
            compress_theme_audio, extract_video_id_from_url, find_soundtrack_url,
            find_theme_audio_file, find_theme_audio_files, next_theme_basename,
            normalize_track_title, probe_video_title, read_opus_title,
            search_soundtrack_candidates, set_youtube_cookies_path, try_extract_theme_audio,
        },
        steam::provider::SteamWebApiProvider,
        GameMetadataProvider, MetadataProvider, PlatformMetadataProvider,
    },
    retroachievements::override_store::RaOverrideStore,
    retrom_dirs::RetromDirs,
};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::RwLock;
use tonic::{Request, Response, Status};
use tracing::{error, Instrument, Level};
use walkdir::WalkDir;

use super::jobs::job_manager::{JobManager, JobOptions};
use crate::library::metadata_handlers::enrich_game_igdb_genres;

/// Remove stale cached images for a game's metadata while PRESERVING its
/// extracted theme audio tracks.
///
/// `GameMetadata::clean_cache()` deletes the entire `media/games/<id>` directory,
/// which also wipes the `theme.*` playlist files — so a metadata refresh would
/// re-extract the theme from YouTube on every run (slow + glitchy, and the theme
/// briefly vanishes). Theme audio is server-generated soundtrack data, independent
/// of the scraped IGDB/Steam image fields, so a refresh must leave it untouched —
/// the same reasoning behind the narrow `update_game_playtime` RPC, which avoids
/// this cache path entirely. Changed images still refresh on their own:
/// `cache_media_file` overwrites a cached file whenever its remote URL changes.
async fn clean_image_cache_preserving_theme(cache_dir: &std::path::Path) {
    if !cache_dir.exists() {
        return;
    }

    let preserve: std::collections::HashSet<std::path::PathBuf> =
        find_theme_audio_files(cache_dir).into_iter().collect();

    let mut entries = match tokio::fs::read_dir(cache_dir).await {
        Ok(entries) => entries,
        Err(why) => {
            error!("Failed to read cache dir {cache_dir:?} to clean: {why}");
            return;
        }
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        if preserve.contains(&path) {
            continue;
        }

        let removed = if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            tokio::fs::remove_dir_all(&path).await
        } else {
            tokio::fs::remove_file(&path).await
        };

        if let Err(why) = removed {
            tracing::warn!("Failed to remove stale cached media {path:?}: {why}");
        }
    }
}

/// Map the internal achievement set (with relative media badge paths) to the
/// wire type. `unlocked_at` is stored internally as unix seconds.
fn proto_achievement_set(set: ProviderAchievementSet) -> GameAchievementSet {
    GameAchievementSet {
        provider: set.provider,
        unlocked: set.unlocked,
        total: set.total,
        points_earned: set.points_earned,
        points_total: set.points_total,
        achievements: set
            .achievements
            .into_iter()
            .map(proto_achievement)
            .collect(),
    }
}

fn proto_achievement(a: ProviderAchievement) -> GameAchievement {
    GameAchievement {
        id: a.id,
        name: a.name,
        description: a.description,
        unlocked: a.unlocked,
        points: a.points,
        rarity_percent: a.rarity_percent,
        icon_url: a.icon_url,
        unlocked_at: a.unlocked_at.map(|seconds| Timestamp { seconds, nanos: 0 }),
    }
}

/// Map the orchestrator's resolved result onto the wire response. Shared by the
/// get + manual-match RPCs.
fn achievements_result_to_proto(
    result: retrom_service_common::achievements::AchievementsResult,
) -> GetGameAchievementsResponse {
    let status = match result.status {
        AchievementsStatus::NotSupported => GameAchievementsStatus::NotSupported,
        AchievementsStatus::NotConfigured => GameAchievementsStatus::NotConfigured,
        AchievementsStatus::NotIdentified => GameAchievementsStatus::NotIdentified,
        AchievementsStatus::NeedsAttention => GameAchievementsStatus::NeedsAttention,
        AchievementsStatus::Empty => GameAchievementsStatus::Empty,
        AchievementsStatus::Populated => GameAchievementsStatus::Populated,
    };

    GetGameAchievementsResponse {
        status: status as i32,
        set: result.set.map(proto_achievement_set),
        message: result.message,
    }
}

/// Pick the ROM file to content-hash for RetroAchievements. Prefer a disc index
/// (.cue/.m3u — gives rc_hash the full track layout), then the configured
/// default file, then the first available file.
fn pick_rom_file(files: &[GameFile], default_file_id: Option<i32>) -> Option<PathBuf> {
    if let Some(f) = files.iter().find(|f| {
        let p = f.path.to_ascii_lowercase();
        p.ends_with(".cue") || p.ends_with(".m3u")
    }) {
        return Some(PathBuf::from(&f.path));
    }

    if let Some(fid) = default_file_id {
        if let Some(f) = files.iter().find(|f| f.id == fid) {
            return Some(PathBuf::from(&f.path));
        }
    }

    files.first().map(|f| PathBuf::from(&f.path))
}

pub struct MetadataServiceHandlers {
    db_pool: Arc<Pool>,
    igdb_client: Arc<IGDBProvider>,
    steam_provider: Arc<SteamWebApiProvider>,
    media_cache: Arc<MediaCache>,
    job_manager: Arc<JobManager>,
    config_manager: Arc<retrom_service_common::config::ServerConfigManager>,
    achievements_service: Arc<AchievementsService>,
    ra_override_store: Arc<RaOverrideStore>,
}

impl MetadataServiceHandlers {
    #[allow(clippy::too_many_arguments)] // dependency-injection constructor
    pub fn new(
        db_pool: Arc<Pool>,
        igdb_client: Arc<IGDBProvider>,
        steam_provider: Arc<SteamWebApiProvider>,
        media_cache: Arc<MediaCache>,
        job_manager: Arc<JobManager>,
        config_manager: Arc<retrom_service_common::config::ServerConfigManager>,
        achievements_service: Arc<AchievementsService>,
        ra_override_store: Arc<RaOverrideStore>,
    ) -> Self {
        Self {
            db_pool,
            igdb_client,
            steam_provider,
            media_cache,
            job_manager,
            config_manager,
            achievements_service,
            ra_override_store,
        }
    }

    async fn load_game(&self, game_id: i32) -> Result<retrom::Game, Status> {
        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        schema::games::table
            .find(game_id)
            .first::<retrom::Game>(&mut conn)
            .await
            .map_err(|_| Status::not_found("game not found"))
    }

    /// Resolve the on-disk ROM path to hash for a game (None if it has no files).
    async fn resolve_rom_path(&self, game: &retrom::Game) -> Option<PathBuf> {
        let mut conn = self.db_pool.get().await.ok()?;

        let files: Vec<GameFile> = schema::game_files::table
            .filter(schema::game_files::game_id.eq(game.id))
            .filter(schema::game_files::is_deleted.eq(false))
            .load::<GameFile>(&mut conn)
            .await
            .ok()?;

        pick_rom_file(&files, game.default_file_id)
    }
}

#[tonic::async_trait]
impl MetadataService for MetadataServiceHandlers {
    async fn get_game_metadata(
        &self,
        request: Request<GetGameMetadataRequest>,
    ) -> Result<Response<GetGameMetadataResponse>, Status> {
        let request = request.into_inner();
        let game_ids = request.game_ids;

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        let mut metadata = match retrom_db::schema::game_metadata::table
            .filter(retrom_db::schema::game_metadata::game_id.eq_any(&game_ids))
            .load::<retrom::GameMetadata>(&mut conn)
            .instrument(tracing::info_span!("load_game_metadata"))
            .await
        {
            Ok(rows) => rows,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        let (games1, games2) = diesel::alias!(schema::games as games1, schema::games as games2);

        let games: Vec<Game> = games1
            .filter(games1.field(schema::games::id).eq_any(game_ids))
            .load::<retrom::Game>(&mut conn)
            .instrument(tracing::info_span!("load_games"))
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        drop(conn);

        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        let genre_maps: Vec<(GameGenreMap, GameGenre)> = GameGenreMap::belonging_to(&games)
            .inner_join(schema::game_genres::table)
            .select((GameGenreMap::as_select(), GameGenre::as_select()))
            .load(&mut conn)
            .instrument(tracing::info_span!("load_genre_maps"))
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let genres: HashMap<i32, GameGenres> = genre_maps
            .grouped_by(&games)
            .into_iter()
            .zip(&games)
            .map(|(maps, game)| {
                let genres = maps
                    .into_iter()
                    .map(|map| map.1)
                    .collect::<Vec<GameGenre>>();

                (game.id, GameGenres { value: genres })
            })
            .collect();

        let similar_maps_flat: Vec<(SimilarGameMap, Game)> =
            SimilarGameMap::belonging_to(&games)
                .inner_join(games2.on(
                    schema::similar_game_maps::similar_game_id.eq(games2.field(schema::games::id)),
                ))
                .select((
                    SimilarGameMap::as_select(),
                    games2.fields(schema::games::all_columns),
                ))
                .load(&mut conn)
                .instrument(tracing::info_span!("load_similar_game_maps"))
                .await
                .map_err(|e| Status::internal(e.to_string()))?;

        let similar_games: HashMap<i32, SimilarGames> = similar_maps_flat
            .grouped_by(&games)
            .into_iter()
            .zip(games)
            .map(|(maps, game)| {
                let games: Vec<Game> = maps.into_iter().map(|map| map.1).collect();

                (game.id, SimilarGames { value: games })
            })
            .collect();

        let config = self.config_manager.get_config().await;
        let store_metadata = config
            .metadata
            .map(|m| m.store_metadata_locally)
            .unwrap_or(false);

        // Build media paths for each game from the local cache
        let media_futures = if store_metadata {
            metadata
                .iter()
                .map(|meta| {
                    async {
                        if meta.get_cache_dir().is_some() {
                            let mut paths = MediaPaths {
                                cover_url: None,
                                background_url: None,
                                icon_url: None,
                                video_urls: vec![],
                                screenshot_urls: vec![],
                                artwork_urls: vec![],
                                theme_audio_url: None,
                                theme_audio_urls: vec![],
                                theme_audio_titles: vec![],
                            };

                            let cache_opts = meta.get_cacheable_media_opts();
                            let meta_clone = meta.clone();
                            let mut cache_tasks = vec![];

                            for media_opts in cache_opts.into_iter() {
                                let cache_path = match media_opts.get_item_path().await {
                                    Ok(path) => path,
                                    _ => {
                                        tracing::warn!(
                                            "Failed to get cache path for media opts: {:?}",
                                            media_opts
                                        );
                                        continue;
                                    }
                                };

                                let cache_clone = self.media_cache.clone();
                                let needs_caching = !cache_clone
                                    .index_manager()
                                    .is_entry_valid(&media_opts)
                                    .await
                                    .unwrap_or(true);

                                if needs_caching {
                                    cache_tasks.push(async move {
                                        if let Err(e) =
                                            cache_clone.cache_media_file(&media_opts).await
                                        {
                                            tracing::warn!(
                                                "Failed to cache media for game {}: {}",
                                                meta_clone.game_id,
                                                e
                                            );

                                            Err(Status::internal(e.to_string()))
                                        } else {
                                            tracing::debug!(
                                                "Successfully cached media for game {}",
                                                meta_clone.game_id
                                            );
                                            Ok(())
                                        }
                                    });

                                    continue;
                                }

                                let public_url = match get_public_url(&cache_path) {
                                    Ok(url) => url,
                                    Err(why) => {
                                        tracing::warn!(
                                    "Failed to get public URL for cached media at path: {why:?}",
                                );

                                        continue;
                                    }
                                };

                                // Map based on file structure and naming using PathBuf methods
                                match media_opts.semantic_name.as_deref() {
                                    Some("cover") => paths.cover_url = Some(public_url.clone()),
                                    Some("background") => {
                                        paths.background_url = Some(public_url.clone())
                                    }
                                    Some("icon") => paths.icon_url = Some(public_url.clone()),
                                    _ => {}
                                };

                                let base_dir = media_opts.base_dir.as_ref().and_then(|p| {
                                    p.file_name().map(|s| s.to_string_lossy().to_string())
                                });

                                match base_dir.as_deref() {
                                    Some("artwork") => {
                                        paths.artwork_urls.push(public_url);
                                    }
                                    Some("screenshots") => {
                                        paths.screenshot_urls.push(public_url);
                                    }
                                    _ => {}
                                };
                            }

                            // Only include games that actually have cached media
                            if paths.cover_url.is_some()
                                || paths.background_url.is_some()
                                || paths.icon_url.is_some()
                                || !paths.artwork_urls.is_empty()
                                || !paths.screenshot_urls.is_empty()
                                || !paths.video_urls.is_empty()
                                || paths.theme_audio_url.is_some()
                            {
                                return Some((meta.game_id, paths));
                            }

                            let job_name =
                                format!("Cache Media Files For Game {}", meta_clone.game_id);

                            if !cache_tasks.is_empty() {
                                let job_manager = self.job_manager.clone();
                                match job_manager.spawn(&job_name, cache_tasks, None).await {
                                    Ok(job_id) => {
                                        tracing::debug!(
                                            "Spawned background job to cache media for game {}: {}",
                                            meta.game_id,
                                            job_id
                                        );
                                    }
                                    Err(JobError::JobAlreadyRunning(_)) => {}
                                    Err(why) => {
                                        tracing::error!("Failed to spawn cache job: {}", why);
                                    }
                                }
                            }
                        }

                        None
                    }
                    .instrument(tracing::info_span!(
                        "build_media_paths",
                        game_id = meta.game_id
                    ))
                })
                .collect::<Vec<_>>()
        } else {
            vec![]
        };

        let mut media_paths: HashMap<i32, MediaPaths> = join_all(media_futures)
            .await
            .into_iter()
            .flatten()
            .collect();

        // Always include theme_audio_url if an extracted theme audio file (theme.opus / theme.webm / etc)
        // exists for the game. The finder handles any container yt-dlp actually produced.
        // This ensures the native audio preview works even if store_metadata_locally is false
        // (the theme audio is server-generated short soundtrack metadata, not user media).
        // Primary population of these files now happens up-front in the library metadata jobs.
        for meta in &mut metadata {
            if let Some(cache_dir) = meta.get_cache_dir() {
                let theme_files = find_theme_audio_files(&cache_dir);
                if theme_files.is_empty() {
                    continue;
                }

                // Build the full playlist (parallel URL/title arrays). Each track's
                // title comes from its embedded Opus TITLE tag, falling back to
                // "Theme".
                let mut theme_urls: Vec<String> = Vec::new();
                let mut theme_titles: Vec<String> = Vec::new();
                for path in &theme_files {
                    if let Ok(public) = get_public_url(path) {
                        let title = read_opus_title(path).unwrap_or_else(|| "Theme".to_string());
                        theme_urls.push(public);
                        theme_titles.push(title);
                    }
                }

                if theme_urls.is_empty() {
                    continue;
                }

                // The primary track backs the singular fields (backward compat) and
                // the persisted DB title. Backfill the stored title from the primary
                // track's tag when absent, so the detail title isn't "Theme".
                if meta.theme_audio_title.is_none() {
                    let primary_title = theme_titles[0].clone();
                    if primary_title != "Theme" {
                        if let Err(why) = diesel::update(schema::game_metadata::table)
                            .filter(schema::game_metadata::game_id.eq(meta.game_id))
                            .set(schema::game_metadata::theme_audio_title.eq(Some(&primary_title)))
                            .execute(&mut conn)
                            .await
                        {
                            tracing::warn!(
                                "failed to backfill theme_audio_title for game {}: {}",
                                meta.game_id,
                                why
                            );
                        }
                        meta.theme_audio_title = Some(primary_title);
                    }
                }

                let primary = theme_urls[0].clone();
                let entry = media_paths
                    .entry(meta.game_id)
                    .or_insert_with(|| MediaPaths {
                        cover_url: None,
                        background_url: None,
                        icon_url: None,
                        video_urls: vec![],
                        screenshot_urls: vec![],
                        artwork_urls: vec![],
                        theme_audio_url: None,
                        theme_audio_urls: vec![],
                        theme_audio_titles: vec![],
                    });
                entry.theme_audio_url = Some(primary);
                entry.theme_audio_urls = theme_urls;
                entry.theme_audio_titles = theme_titles;
            }
        }

        Ok(Response::new(GetGameMetadataResponse {
            metadata,
            genres,
            similar_games,
            media_paths,
        }))
    }

    async fn update_game_metadata(
        &self,
        request: Request<UpdateGameMetadataRequest>,
    ) -> Result<Response<UpdateGameMetadataResponse>, Status> {
        let request = request.into_inner();
        let mut metadata_to_update = request.metadata;
        let overwrite_theme_audio = request.overwrite_theme_audio.unwrap_or(false);
        let config = self.config_manager.get_config().await;
        let meta_cfg = config.metadata.clone();
        let store_metadata = meta_cfg
            .as_ref()
            .map(|m| m.store_metadata_locally)
            .unwrap_or(false);

        // Keep the global cookies path in sync with the current server config.
        let cookies_path = meta_cfg
            .as_ref()
            .and_then(|m| m.youtube_cookies_path.as_ref())
            .map(std::path::PathBuf::from);
        set_youtube_cookies_path(cookies_path).await;

        // Pre-pass: entries that arrived WITHOUT a YouTube URL (the IGDB search-tab path,
        // since get_igdb_game_search_results does not run find_soundtrack_url) get one
        // resolved and persisted into video_urls so the YouTube theme shows in the Videos tab,
        // matching the bulk "Download Metadata" path.
        //
        // Crucially we FIRST try to reuse the soundtrack URL already stored in the DB for this
        // game. The IGDB-tab update overwrites the whole metadata row (its video_urls come from
        // IGDB and never include our soundtrack), so without this preservation every refresh
        // would re-search YouTube, pick a possibly DIFFERENT video, and churn the Videos tab /
        // re-trigger downloads. Only when the DB has no existing soundtrack URL do we search.
        let is_youtube = |url: &str| {
            let lower = url.to_ascii_lowercase();
            lower.contains("youtube.com/watch") || lower.contains("youtu.be/")
        };

        let soundtrack_lookups = metadata_to_update
            .iter()
            .enumerate()
            .filter_map(|(idx, m)| {
                if m.video_urls.iter().any(|u| is_youtube(u)) {
                    return None;
                }
                let name = m.name.clone()?;
                if name.trim().is_empty() {
                    return None;
                }
                let game_id = m.game_id;
                let cache_dir = m.get_cache_dir();
                let db_pool = self.db_pool.clone();
                Some(async move {
                    // 1. Preserve an existing soundtrack URL from the DB — but ONLY if a
                    //    theme.* file actually exists. A downloaded theme proves the stored
                    //    URL was valid and downloadable. If there is NO theme file, the stored
                    //    URL never worked (e.g. a stale >10min pick from older logic that
                    //    extraction refuses) — so we ignore it and re-search for a valid one.
                    let has_theme = cache_dir
                        .as_ref()
                        .is_some_and(|d| find_theme_audio_file(d).is_some());

                    if has_theme {
                        if let Ok(mut conn) = db_pool.get().await {
                            if let Ok(existing) = retrom_db::schema::game_metadata::table
                                .filter(retrom_db::schema::game_metadata::game_id.eq(game_id))
                                .first::<retrom::GameMetadata>(&mut conn)
                                .await
                            {
                                if let Some(url) =
                                    existing.video_urls.into_iter().find(|u| is_youtube(u))
                                {
                                    return (idx, Some(url));
                                }
                            }
                        }
                    }

                    // 2. No proven-good existing URL — search fresh (returns only
                    //    duration-validated [60s, 600s] candidates).
                    (idx, find_soundtrack_url(&name).await)
                })
            });

        for (idx, url) in join_all(soundtrack_lookups).await {
            if let (Some(url), Some(meta)) = (url, metadata_to_update.get_mut(idx)) {
                if !meta.video_urls.iter().any(|u| u == &url) {
                    tracing::info!(
                        "theme: persisting soundtrack url into video_urls for game {}: {}",
                        meta.game_id,
                        url
                    );
                    meta.video_urls.insert(0, url);
                }
            }
        }

        join_all(metadata_to_update.iter().map(|metadata| async {
            let job_manager = self.job_manager.clone();
            let cache = self.media_cache.clone();

            // Clear stale cached images so changed cover/background/screenshots
            // re-download, but PRESERVE the extracted theme audio — a blanket
            // clean_cache() nukes the whole game cache dir (theme.* included) and
            // forces a slow re-extraction on every refresh.
            if let Some(cache_dir) = metadata.get_cache_dir() {
                clean_image_cache_preserving_theme(&cache_dir).await;
            }

            let opts = metadata.get_cacheable_media_opts();

            let job_name = format!("Cache Media Files For Game {}", metadata.game_id);

            if store_metadata {
                let tasks = opts
                    .into_iter()
                    .map(|opt| {
                        let cache_clone = cache.clone();
                        async move { cache_clone.cache_media_file(&opt).await }
                    })
                    .collect();

                if let Err(why) = job_manager.spawn(&job_name, tasks, None).await {
                    error!("Failed to spawn job for caching media: {}", why);
                }
            };

            // Theme-audio extraction is intentionally NOT triggered by a metadata
            // scrape. Downloading/extracting soundtrack music is reserved for the
            // explicit per-game "download soundtrack" action and the batch
            // "download all" soundtrack path — a plain refresh must never kick off a
            // yt-dlp download. (Previously this also extracted whenever a game simply
            // had no theme file yet, so every scrape of an un-themed game silently
            // started a download.) We still honor an explicit re-download request via
            // `overwrite_theme_audio`; by this point the pre-pass above has resolved
            // any soundtrack URL into video_urls.
            if overwrite_theme_audio {
                let youtube_url = metadata.video_urls.iter().find(|url| {
                    let lower = url.to_ascii_lowercase();
                    lower.contains("youtube.com/watch") || lower.contains("youtu.be/")
                });

                if let Some(first) = youtube_url {
                    if let Some(vid) = extract_video_id_from_url(first) {
                        if let Some(cache_dir) = metadata.get_cache_dir() {
                            let game_id = metadata.game_id;
                            let job_name = format!("Extract Theme Audio For Game {}", game_id);
                            let cache_dir_clone = cache_dir.clone();
                            let extract_task = async move {
                                match try_extract_theme_audio(
                                    &vid,
                                    cache_dir_clone.clone(),
                                    "theme",
                                    overwrite_theme_audio,
                                    true,
                                )
                                .await
                                {
                                    Some(path) => {
                                        tracing::info!(
                                            "theme: extracted audio for game {} -> {:?}",
                                            game_id,
                                            path
                                        );
                                        let title = probe_video_title(&vid)
                                            .await
                                            .as_deref()
                                            .and_then(normalize_track_title);
                                        compress_theme_audio(
                                            &path,
                                            &cache_dir_clone,
                                            "theme",
                                            title.as_deref(),
                                        )
                                        .await;
                                    }
                                    None => tracing::warn!(
                                        "theme: extraction FAILED for game {} (video {})",
                                        game_id,
                                        vid
                                    ),
                                }
                                Ok::<(), ()>(())
                            };
                            let _ = job_manager.spawn(&job_name, vec![extract_task], None).await;
                        }
                    }
                }
            }
        }))
        .await;

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        let mut metadata_updated: Vec<retrom::GameMetadata> = vec![];

        for metadata_row in metadata_to_update {
            let updated_row = match diesel::insert_into(retrom_db::schema::game_metadata::table)
                .values(&metadata_row)
                .on_conflict(retrom_db::schema::game_metadata::game_id)
                .do_update()
                .set(&metadata_row)
                .get_result::<retrom::GameMetadata>(&mut conn)
                .await
            {
                Ok(row) => row,
                Err(why) => {
                    return Err(Status::internal(why.to_string()));
                }
            };

            metadata_updated.push(updated_row);
        }

        Ok(Response::new(UpdateGameMetadataResponse {
            metadata_updated,
        }))
    }

    async fn update_game_playtime(
        &self,
        request: Request<UpdateGamePlaytimeRequest>,
    ) -> Result<Response<UpdateGamePlaytimeResponse>, Status> {
        let request = request.into_inner();
        let game_id = request.game_id;

        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        // Add this session's minutes to the current total. A missing row just
        // means there's no prior playtime to add to.
        let current_minutes = schema::game_metadata::table
            .find(game_id)
            .first::<retrom::GameMetadata>(&mut conn)
            .await
            .ok()
            .and_then(|meta| meta.minutes_played)
            .unwrap_or(0);

        // Narrow update: ONLY playtime + last-played. Leaving every other field at
        // its default makes this an AsChangeset that skips those columns, so media
        // URLs and the like are preserved — and, unlike update_game_metadata, this
        // never touches the media cache or re-extracts theme audio.
        let updated_meta = UpdatedGameMetadata {
            minutes_played: Some(current_minutes + request.additional_minutes),
            last_played: Some(std::time::SystemTime::now().into()),
            ..Default::default()
        };

        if let Err(why) = diesel::update(schema::game_metadata::table)
            .filter(schema::game_metadata::game_id.eq(game_id))
            .set(&updated_meta)
            .execute(&mut conn)
            .await
        {
            return Err(Status::internal(why.to_string()));
        }

        Ok(Response::new(UpdateGamePlaytimeResponse {}))
    }

    async fn get_platform_metadata(
        &self,
        request: Request<GetPlatformMetadataRequest>,
    ) -> Result<Response<GetPlatformMetadataResponse>, Status> {
        let request = request.into_inner();
        let platform_ids = request.platform_ids;

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        let metadata = match retrom_db::schema::platform_metadata::table
            .filter(retrom_db::schema::platform_metadata::platform_id.eq_any(platform_ids))
            .load::<retrom::PlatformMetadata>(&mut conn)
            .await
        {
            Ok(rows) => rows,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        Ok(Response::new(GetPlatformMetadataResponse { metadata }))
    }

    async fn update_platform_metadata(
        &self,
        request: Request<UpdatePlatformMetadataRequest>,
    ) -> Result<Response<UpdatePlatformMetadataResponse>, Status> {
        let request = request.into_inner();
        let metadata_to_update = request.metadata;

        join_all(metadata_to_update.iter().map(|metadata| async move {
            if let Err(e) = metadata.clean_cache().await {
                error!("Failed to clean cache for platform metadata: {}", e);
                return;
            }

            let job_manager = self.job_manager.clone();
            let cache = self.media_cache.clone();

            let opts = metadata.get_cacheable_media_opts();

            let job_name = format!("Cache Media Files For Platform {}", metadata.platform_id);

            let tasks = opts
                .into_iter()
                .map(|opt| {
                    let cache_clone = cache.clone();
                    async move { cache_clone.cache_media_file(&opt).await }
                })
                .collect();

            if let Err(why) = job_manager.spawn(&job_name, tasks, None).await {
                error!("Failed to spawn job for caching platform media: {}", why);
            }
        }))
        .await;

        let mut conn = match self.db_pool.get().await {
            Ok(conn) => conn,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        conn.transaction(|mut conn| {
            async move {
                let mut metadata_updated: Vec<retrom::PlatformMetadata> = vec![];

                for metadata_row in metadata_to_update {
                    let updated_row =
                        diesel::insert_into(retrom_db::schema::platform_metadata::table)
                            .values(&metadata_row)
                            .on_conflict(retrom_db::schema::platform_metadata::platform_id)
                            .do_update()
                            .set(&metadata_row)
                            .get_result::<retrom::PlatformMetadata>(&mut conn)
                            .await?;

                    metadata_updated.push(updated_row);
                }

                diesel::result::QueryResult::Ok(Response::new(UpdatePlatformMetadataResponse {
                    metadata_updated,
                }))
            }
            .scope_boxed()
        })
        .await
        .map_err(|why| {
            error!("Failed to update platform metadata: {}", why);
            Status::internal(why.to_string())
        })
    }

    async fn get_igdb_game_search_results(
        &self,
        request: Request<GetIgdbGameSearchResultsRequest>,
    ) -> Result<Response<GetIgdbGameSearchResultsResponse>, Status> {
        let request = request.into_inner();
        let query = match request.query {
            Some(query) => query,
            None => {
                return Err(Status::invalid_argument("Query is required"));
            }
        };

        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        let game = match schema::games::table
            .find(query.game_id)
            .first::<retrom::Game>(&mut conn)
            .await
        {
            Ok(game) => game,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        let igdb_client = self.igdb_client.clone();
        let search_results = igdb_client.search_game_metadata(query).await;

        let metadata = search_results
            .into_iter()
            .map(|mut meta| {
                meta.game_id = Some(game.id);
                meta
            })
            .collect();

        Ok(Response::new(GetIgdbGameSearchResultsResponse { metadata }))
    }

    async fn get_igdb_platform_search_results(
        &self,
        request: Request<GetIgdbPlatformSearchResultsRequest>,
    ) -> Result<Response<GetIgdbPlatformSearchResultsResponse>, Status> {
        {
            let request = request.into_inner();
            let query = match request.query {
                Some(query) => query,
                None => {
                    return Err(Status::invalid_argument("Query is required"));
                }
            };

            let mut conn = self
                .db_pool
                .get()
                .await
                .map_err(|why| Status::internal(why.to_string()))?;

            let platform = match schema::platforms::table
                .find(query.platform_id)
                .first::<retrom::Platform>(&mut conn)
                .await
            {
                Ok(platform) => platform,
                Err(why) => {
                    return Err(Status::internal(why.to_string()));
                }
            };

            let igdb_provider = self.igdb_client.clone();

            let metadata = igdb_provider
                .search_platform_metadata(query)
                .await
                .into_iter()
                .map(|mut meta| {
                    meta.platform_id = Some(platform.id);
                    meta
                })
                .collect();

            Ok(Response::new(GetIgdbPlatformSearchResultsResponse {
                metadata,
            }))
        }
    }

    async fn get_igdb_search(
        &self,
        request: Request<GetIgdbSearchRequest>,
    ) -> Result<Response<GetIgdbSearchResponse>, Status> {
        let request = request.into_inner();
        let search_type = IgdbSearchType::try_from(request.search_type)
            .map_err(|_| Status::invalid_argument("Invalid search type provided"));

        let igdb_provider = self.igdb_client.clone();

        let data = igdb_provider.search_metadata(request).await;

        let search_results = match data {
            Some(IgdbSearchData::Game(matches)) => {
                let games = matches
                    .games
                    .into_iter()
                    .map(|game| igdb_provider.igdb_game_to_metadata(game))
                    .collect();

                SearchResults::GameMatches(IgdbSearchGameResponse { games })
            }
            Some(IgdbSearchData::Platform(matches)) => {
                let platforms = matches
                    .platforms
                    .into_iter()
                    .map(|platform| igdb_provider.igdb_platform_to_metadata(platform))
                    .collect();

                SearchResults::PlatformMatches(IgdbSearchPlatformResponse { platforms })
            }
            None => match search_type {
                Ok(IgdbSearchType::Game) => {
                    SearchResults::GameMatches(IgdbSearchGameResponse { games: vec![] })
                }
                Ok(IgdbSearchType::Platform) => {
                    SearchResults::PlatformMatches(IgdbSearchPlatformResponse { platforms: vec![] })
                }
                Err(why) => {
                    return Err(why);
                }
            },
        }
        .into();

        Ok(Response::new(GetIgdbSearchResponse { search_results }))
    }

    #[tracing::instrument(level = Level::DEBUG, skip_all)]
    async fn sync_steam_metadata(
        &self,
        request: Request<SyncSteamMetadataRequest>,
    ) -> Result<Response<SyncSteamMetadataResponse>, Status> {
        let request = request.into_inner();
        let selectors = request.selectors;
        let force_refresh = request.force_refresh.unwrap_or(false);

        let steam_provider = self.steam_provider.clone();
        let igdb_provider = self.igdb_client.clone();
        let pool = self.db_pool.clone();

        let game_ids = selectors.iter().map(|s| s.game_id).collect::<Vec<_>>();

        let mut conn = pool
            .get()
            .await
            .map_err(|why| Status::internal(why.to_string()))?;

        let games: Vec<retrom::Game> = match schema::games::table
            .filter(schema::games::id.eq_any(&game_ids))
            .filter(schema::games::steam_app_id.is_not_null())
            .load(&mut conn)
            .await
        {
            Ok(games) => games,
            Err(why) => {
                return Err(Status::internal(why.to_string()));
            }
        };

        drop(conn);

        let steam_games = Arc::new(RwLock::new(
            steam_provider
                .get_owned_games()
                .await
                .map_err(|why| {
                    error!("Failed to fetch owned games from Steam: {}", why);
                    Status::internal(why.to_string())
                })?
                .response
                .games,
        ));

        let tasks = games
            .into_iter()
            .map(|game| {
                let pool = pool.clone();
                let steam_games = steam_games.clone();
                let steam_provider = steam_provider.clone();
                let igdb_provider = igdb_provider.clone();

                async move {
                    let steam_game = steam_games
                        .read()
                        .await
                        .iter()
                        .find(|g| g.appid == game.steam_app_id() as u32)
                        .cloned();

                    let Some(steam_game) = steam_game else {
                        return Ok::<Option<()>, Status>(None);
                    };

                    if force_refresh {
                        // Full re-fetch from Steam (name, description, screenshots,
                        // videos, etc.) using the same provider used during bulk scans.
                        use retrom_service_common::metadata_providers::GameMetadataProvider;
                        let full_meta = steam_provider
                            .get_game_metadata(game.clone(), Some(steam_game))
                            .await;

                        if let Some(mut meta) = full_meta {
                            let mut conn = pool
                                .get()
                                .await
                                .map_err(|e| Status::internal(e.to_string()))?;

                            // Preserve any YouTube soundtrack URL stored by a prior music
                            // download. The full set() below overwrites video_urls with Steam
                            // CDN links, which would silently clear the user's chosen theme
                            // reference and break the Theme tab's "Watch on YouTube" link.
                            if let Ok(existing) = schema::game_metadata::table
                                .filter(schema::game_metadata::game_id.eq(game.id))
                                .first::<retrom::GameMetadata>(&mut conn)
                                .await
                            {
                                let yt_urls: Vec<String> = existing
                                    .video_urls
                                    .into_iter()
                                    .filter(|u| {
                                        let l = u.to_ascii_lowercase();
                                        l.contains("youtube.com/watch") || l.contains("youtu.be/")
                                    })
                                    .collect();
                                for yt in yt_urls.into_iter().rev() {
                                    meta.video_urls.insert(0, yt);
                                }
                            }

                            // Update existing row; fall back to insert for new games.
                            let rows = diesel::update(schema::game_metadata::table)
                                .filter(schema::game_metadata::game_id.eq(game.id))
                                .set(&meta)
                                .execute(&mut conn)
                                .await
                                .map_err(|e| Status::internal(e.to_string()))?;

                            if rows == 0 {
                                diesel::insert_into(schema::game_metadata::table)
                                    .values(&meta)
                                    .on_conflict_do_nothing()
                                    .execute(&mut conn)
                                    .await
                                    .map_err(|e| Status::internal(e.to_string()))?;
                            }
                        }

                        // The Steam store gives no genres in the library's IGDB
                        // taxonomy, so a forced refresh additionally runs the same
                        // IGDB enrichment the bulk library job uses — matching the
                        // game to IGDB by name and populating genres + similar
                        // games. Without this, refreshing a single Steam game left
                        // it with zero genres and the Similar Games tab could only
                        // fall back to "same platform".
                        if let Err(why) =
                            enrich_game_igdb_genres(&igdb_provider, &pool, game.id).await
                        {
                            tracing::warn!(
                                "Failed to enrich IGDB genres for Steam game {}: {}",
                                game.id,
                                why
                            );
                        }
                    } else {
                        // Lightweight sync: playtime + last_played only.
                        let last_played = if steam_game.rtime_last_played > 0 {
                            let dt = DateTime::from_timestamp(steam_game.rtime_last_played, 0);
                            dt.map(|dt| Timestamp {
                                seconds: dt.timestamp(),
                                nanos: 0,
                            })
                        } else {
                            None
                        };

                        let minutes_played = if steam_game.playtime_forever > 0 {
                            Some(steam_game.playtime_forever)
                        } else {
                            None
                        };

                        let updated_meta = UpdatedGameMetadata {
                            last_played,
                            minutes_played,
                            ..Default::default()
                        };

                        let mut conn = pool
                            .get()
                            .await
                            .map_err(|e| Status::internal(e.to_string()))?;

                        diesel::update(schema::game_metadata::table)
                            .filter(schema::game_metadata::game_id.eq(game.id))
                            .set(&updated_meta)
                            .execute(&mut conn)
                            .await
                            .map_err(|e| Status::internal(e.to_string()))?;
                    }

                    Ok(Some(()))
                }
                .instrument(tracing::info_span!("steam_sync_thread"))
            })
            .collect::<Vec<_>>();

        let res = join_all(tasks).await.into_iter().collect::<Vec<_>>();

        res.iter().for_each(|result| {
            if let Err(e) = result {
                tracing::warn!("Failed to update game metadata: {:?}", e);
            }
        });

        Ok(Response::new(SyncSteamMetadataResponse {}))
    }

    async fn get_game_achievements(
        &self,
        request: Request<GetGameAchievementsRequest>,
    ) -> Result<Response<GetGameAchievementsResponse>, Status> {
        let request = request.into_inner();
        let force_refresh = request.force_refresh.unwrap_or(false);

        let game = self.load_game(request.game_id).await?;
        let rom_path = self.resolve_rom_path(&game).await;

        let result = self
            .achievements_service
            .get(&game, rom_path.as_deref(), force_refresh)
            .await;

        Ok(Response::new(achievements_result_to_proto(result)))
    }

    async fn set_game_achievements_manual_match(
        &self,
        request: Request<SetGameAchievementsManualMatchRequest>,
    ) -> Result<Response<SetGameAchievementsManualMatchResponse>, Status> {
        let request = request.into_inner();

        // Persist (or, with 0, clear) the override, then re-resolve bypassing the
        // cache so the override (or its removal) takes effect immediately.
        self.ra_override_store
            .set(request.game_id, request.retroachievements_game_id as i64)
            .await
            .map_err(|why| Status::internal(format!("failed to store manual match: {why}")))?;

        let game = self.load_game(request.game_id).await?;
        let rom_path = self.resolve_rom_path(&game).await;

        let result = self
            .achievements_service
            .get(&game, rom_path.as_deref(), true)
            .await;

        Ok(Response::new(SetGameAchievementsManualMatchResponse {
            achievements: Some(achievements_result_to_proto(result)),
        }))
    }

    async fn get_local_metadata_status(
        &self,
        _request: Request<GetLocalMetadataStatusRequest>,
    ) -> Result<Response<GetLocalMetadataStatusResponse>, Status> {
        let response = tokio::task::spawn_blocking(|| {
            let media_dir = RetromDirs::new().media_dir();

            let mut total_byte_size = 0i64;
            let mut total_files = 0;

            for entry in WalkDir::new(media_dir)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file())
            {
                let size = i64::try_from(entry.metadata().map(|m| m.len()).unwrap_or(0))
                    .unwrap_or(i64::MAX);

                total_files += 1;
                total_byte_size = total_byte_size.saturating_add(size);
            }

            GetLocalMetadataStatusResponse {
                total_byte_size,
                total_files,
            }
        })
        .await
        .map_err(|e| Status::internal(format!("Failed to compute local metadata status: {}", e)))?;

        Ok(Response::new(response))
    }

    async fn delete_local_metadata(
        &self,
        _request: Request<DeleteLocalMetadataRequest>,
    ) -> Result<Response<DeleteLocalMetadataResponse>, Status> {
        let media_dir = RetromDirs::new().media_dir();

        if media_dir.exists() {
            tokio::fs::remove_dir_all(&media_dir)
                .await
                .map_err(|e| Status::internal(format!("Failed to delete local metadata: {}", e)))?;
        }

        Ok(Response::new(DeleteLocalMetadataResponse {}))
    }

    async fn search_game_soundtrack(
        &self,
        request: Request<SearchGameSoundtrackRequest>,
    ) -> Result<Response<SearchGameSoundtrackResponse>, Status> {
        let game_id = request.into_inner().game_id;

        let mut conn = match self.db_pool.get().await {
            Ok(c) => c,
            Err(e) => return Err(Status::internal(e.to_string())),
        };

        let meta: retrom::GameMetadata = schema::game_metadata::table
            .filter(schema::game_metadata::game_id.eq(game_id))
            .first::<retrom::GameMetadata>(&mut conn)
            .await
            .map_err(|_| Status::not_found("game metadata not found"))?;

        drop(conn);

        let game_name = meta.name.unwrap_or_default();
        if game_name.trim().is_empty() {
            return Ok(Response::new(SearchGameSoundtrackResponse {
                candidates: vec![],
            }));
        }

        // Sync cookies from config before searching.
        {
            let cfg = self.config_manager.get_config().await;
            let cookies_path = cfg
                .metadata
                .as_ref()
                .and_then(|m| m.youtube_cookies_path.as_ref())
                .map(std::path::PathBuf::from);
            set_youtube_cookies_path(cookies_path).await;
        }

        let results = search_soundtrack_candidates(&game_name).await;

        let candidates = results
            .into_iter()
            .map(|c| SoundtrackCandidateProto {
                video_id: c.video_id,
                title: c.title,
                duration_secs: c.duration_secs.map(|d| d as i32).unwrap_or(0),
                thumbnail_url: c.thumbnail_url,
            })
            .collect();

        Ok(Response::new(SearchGameSoundtrackResponse { candidates }))
    }

    async fn download_game_soundtrack(
        &self,
        request: Request<DownloadGameSoundtrackRequest>,
    ) -> Result<Response<DownloadGameSoundtrackResponse>, Status> {
        let req = request.into_inner();
        let game_id = req.game_id;
        let video_id = req.video_id;

        if video_id.is_empty() {
            return Err(Status::invalid_argument("video_id must not be empty"));
        }

        let mut conn = match self.db_pool.get().await {
            Ok(c) => c,
            Err(e) => return Err(Status::internal(e.to_string())),
        };

        let meta: retrom::GameMetadata = schema::game_metadata::table
            .filter(schema::game_metadata::game_id.eq(game_id))
            .first::<retrom::GameMetadata>(&mut conn)
            .await
            .map_err(|_| Status::not_found("game metadata not found"))?;

        // Resolve cache dir before consuming meta.video_urls.
        let cache_dir = meta.get_cache_dir().unwrap_or_else(|| {
            RetromDirs::new()
                .media_dir()
                .join("games")
                .join(game_id.to_string())
        });

        // Place the chosen YouTube URL at position 0, removing any existing YT URLs so
        // the Videos tab and theme player always reflect the user's explicit selection.
        let yt_url = format!("https://www.youtube.com/watch?v={}", video_id);
        let mut new_video_urls: Vec<String> = meta
            .video_urls
            .into_iter()
            .filter(|u| {
                let lower = u.to_ascii_lowercase();
                !lower.contains("youtube.com/watch") && !lower.contains("youtu.be/")
            })
            .collect();
        new_video_urls.insert(0, yt_url);

        diesel::update(schema::game_metadata::table)
            .filter(schema::game_metadata::game_id.eq(game_id))
            .set(schema::game_metadata::video_urls.eq(&new_video_urls))
            .execute(&mut conn)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        drop(conn);

        let job_manager = self.job_manager.clone();
        let job_name = format!("Download Soundtrack For Game {}", game_id);
        let task = async move {
            // Append to the next free playlist slot so downloading a soundtrack
            // ADDS a track rather than replacing the existing one (multi-track).
            let basename = next_theme_basename(&cache_dir);
            match try_extract_theme_audio(&video_id, cache_dir.clone(), &basename, false, false)
                .await
            {
                Some(path) => {
                    let title = probe_video_title(&video_id)
                        .await
                        .as_deref()
                        .and_then(normalize_track_title);
                    compress_theme_audio(&path, &cache_dir, &basename, title.as_deref()).await;
                }
                None => {
                    tracing::warn!(
                        "soundtrack download: extraction failed for game {} video {}",
                        game_id,
                        video_id
                    );
                }
            }
            Ok::<(), ()>(())
        };

        let job_id = match job_manager.spawn(&job_name, vec![task], None).await {
            Ok(id) => id.to_string(),
            Err(e) => {
                return Err(Status::internal(format!(
                    "failed to spawn download job: {}",
                    e
                )))
            }
        };

        Ok(Response::new(DownloadGameSoundtrackResponse { job_id }))
    }

    async fn delete_game_soundtrack_track(
        &self,
        request: Request<DeleteGameSoundtrackTrackRequest>,
    ) -> Result<Response<DeleteGameSoundtrackTrackResponse>, Status> {
        let req = request.into_inner();
        let game_id = req.game_id;
        let filename = req.filename;

        // Guard against path traversal — the client only ever sends a bare track
        // file name.
        if filename.is_empty()
            || filename.contains('/')
            || filename.contains('\\')
            || filename.contains("..")
        {
            return Err(Status::invalid_argument("invalid track filename"));
        }

        let mut conn = self
            .db_pool
            .get()
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        let meta: retrom::GameMetadata = schema::game_metadata::table
            .filter(schema::game_metadata::game_id.eq(game_id))
            .first::<retrom::GameMetadata>(&mut conn)
            .await
            .map_err(|_| Status::not_found("game metadata not found"))?;

        let cache_dir = meta.get_cache_dir().unwrap_or_else(|| {
            RetromDirs::new()
                .media_dir()
                .join("games")
                .join(game_id.to_string())
        });

        // Only allow deleting a file that is actually a known theme track for this
        // game (also rejects anything outside the playlist).
        let tracks = find_theme_audio_files(&cache_dir);
        let target = cache_dir.join(&filename);
        let is_primary = !tracks.is_empty() && tracks[0] == target;
        if !tracks.iter().any(|p| p == &target) {
            return Err(Status::not_found("theme track not found"));
        }

        if let Err(e) = tokio::fs::remove_file(&target).await {
            return Err(Status::internal(format!(
                "failed to delete theme track: {e}"
            )));
        }

        // If the primary track was removed, clear the stored title so the read
        // path re-derives it from the new primary track's embedded tag.
        if is_primary {
            let _ = diesel::update(schema::game_metadata::table)
                .filter(schema::game_metadata::game_id.eq(game_id))
                .set(schema::game_metadata::theme_audio_title.eq(None::<String>))
                .execute(&mut conn)
                .await;
        }

        tracing::info!("deleted theme track {:?} for game {}", target, game_id);
        Ok(Response::new(DeleteGameSoundtrackTrackResponse {}))
    }

    async fn auto_download_game_soundtrack(
        &self,
        request: Request<AutoDownloadGameSoundtrackRequest>,
    ) -> Result<Response<AutoDownloadGameSoundtrackResponse>, Status> {
        let req = request.into_inner();
        let game_ids = req.game_ids;

        if game_ids.is_empty() {
            return Err(Status::invalid_argument("game_ids must not be empty"));
        }

        let mut conn = match self.db_pool.get().await {
            Ok(c) => c,
            Err(e) => return Err(Status::internal(e.to_string())),
        };

        // Load existing metadata rows — name and cache_dir both come from GameMetadata.
        let all_meta: Vec<retrom::GameMetadata> = schema::game_metadata::table
            .filter(schema::game_metadata::game_id.eq_any(&game_ids))
            .load::<retrom::GameMetadata>(&mut conn)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;

        drop(conn);

        let db_pool = self.db_pool.clone();

        // Build per-game tasks, skipping games that already have a theme file.
        let tasks: Vec<_> = all_meta
            .into_iter()
            .filter_map(|meta| {
                let game_id = meta.game_id;
                let cache_dir = meta.get_cache_dir().unwrap_or_else(|| {
                    RetromDirs::new()
                        .media_dir()
                        .join("games")
                        .join(game_id.to_string())
                });

                // Skip if a theme file already exists.
                if find_theme_audio_file(&cache_dir).is_some() {
                    return None;
                }

                let game_name = meta.name.clone().unwrap_or_default();
                if game_name.trim().is_empty() {
                    return None;
                }

                let current_video_urls = meta.video_urls.clone();
                let pool = db_pool.clone();

                Some(async move {
                    // Search YouTube for the best candidate.
                    let url = match find_soundtrack_url(&game_name).await {
                        Some(u) => u,
                        None => {
                            tracing::warn!(
                                "auto_download: no soundtrack URL found for game {} ({})",
                                game_id,
                                game_name
                            );
                            return Ok::<(), ()>(());
                        }
                    };

                    let video_id = match extract_video_id_from_url(&url) {
                        Some(id) => id,
                        None => {
                            tracing::warn!(
                                "auto_download: could not extract video_id from URL {} for game {}",
                                url,
                                game_id
                            );
                            return Ok::<(), ()>(());
                        }
                    };

                    // Update video_urls in DB: remove old YT URLs, prepend new one.
                    let yt_url = format!("https://www.youtube.com/watch?v={}", video_id);
                    let mut new_video_urls: Vec<String> = current_video_urls
                        .into_iter()
                        .filter(|u| {
                            let lower = u.to_ascii_lowercase();
                            !lower.contains("youtube.com/watch") && !lower.contains("youtu.be/")
                        })
                        .collect();
                    new_video_urls.insert(0, yt_url);

                    if let Ok(mut conn) = pool.get().await {
                        let _ = diesel::update(schema::game_metadata::table)
                            .filter(schema::game_metadata::game_id.eq(game_id))
                            .set(schema::game_metadata::video_urls.eq(&new_video_urls))
                            .execute(&mut conn)
                            .await;
                    }

                    // Download and compress theme audio (auto = the primary track).
                    match try_extract_theme_audio(
                        &video_id,
                        cache_dir.clone(),
                        "theme",
                        true,
                        false,
                    )
                    .await
                    {
                        Some(path) => {
                            let title = probe_video_title(&video_id)
                                .await
                                .as_deref()
                                .and_then(normalize_track_title);
                            compress_theme_audio(&path, &cache_dir, "theme", title.as_deref())
                                .await;
                        }
                        None => {
                            tracing::warn!(
                                "auto_download: extraction failed for game {} video {}",
                                game_id,
                                video_id
                            );
                        }
                    }

                    Ok::<(), ()>(())
                })
            })
            .collect();

        if tasks.is_empty() {
            // All games already have themes — nothing to do. Return a synthetic no-op job id.
            return Ok(Response::new(AutoDownloadGameSoundtrackResponse {
                job_id: String::new(),
            }));
        }

        let job_manager = self.job_manager.clone();
        let job_id = match job_manager
            .spawn(
                "Auto-Download Game Soundtracks",
                tasks,
                Some(JobOptions {
                    wait_on_jobs: None,
                    max_concurrency: Some(2),
                }),
            )
            .await
        {
            Ok(id) => id.to_string(),
            Err(e) => {
                return Err(Status::internal(format!(
                    "failed to spawn auto-download job: {}",
                    e
                )))
            }
        };

        Ok(Response::new(AutoDownloadGameSoundtrackResponse { job_id }))
    }
}
