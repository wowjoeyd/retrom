use std::{collections::HashMap, str::FromStr, sync::Arc, time::Duration};

use chrono::{DateTime, NaiveDate};
use retrom_codegen::{
    retrom::{self},
    timestamp::Timestamp,
};
use tokio::sync::{mpsc, oneshot};
use tower::{Service, ServiceExt};
use tracing::{instrument, Instrument};

use crate::{
    config::ServerConfigManager,
    metadata_providers::{steam::models, RetryAttempts},
};

type SteamSenderMsg = (
    reqwest::Request,
    oneshot::Sender<Result<reqwest::Response, reqwest::StatusCode>>,
);

pub struct SteamWebApiProvider {
    base_url: String,
    store_base_url: String,
    request_tx: mpsc::Sender<SteamSenderMsg>,
    config_manager: Arc<ServerConfigManager>,
}

impl SteamWebApiProvider {
    pub fn new(config_manager: Arc<ServerConfigManager>) -> Self {
        let base_url = "https://api.steampowered.com".into();
        let store_base_url = "https://store.steampowered.com/api".into();

        // Send browser-like headers so Steam's Store API doesn't treat us as a bot
        // and return `null` instead of the app details JSON.
        let mut default_headers = reqwest::header::HeaderMap::new();
        default_headers.insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
                 AppleWebKit/537.36 (KHTML, like Gecko) \
                 Chrome/124.0.0.0 Safari/537.36",
            ),
        );
        default_headers.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("application/json, text/javascript, */*"),
        );
        default_headers.insert(
            reqwest::header::ACCEPT_LANGUAGE,
            reqwest::header::HeaderValue::from_static("en-US,en;q=0.9"),
        );

        let http_client = reqwest::Client::builder()
            .default_headers(default_headers)
            .build()
            .expect("Failed to build Steam HTTP client");

        let (tx, mut rx) = mpsc::channel::<SteamSenderMsg>(100);

        let retries = RetryAttempts::new(5);

        let svc = tower::ServiceBuilder::new()
            .buffer(100)
            .concurrency_limit(2)
            // 1 request per second — stays well under Steam's undocumented rate limit
            // without the burst that rate_limit(300, 5min) would allow.
            .rate_limit(1, Duration::from_secs(1))
            .retry(retries)
            .service_fn(move |req| http_client.execute(req));

        tokio::spawn(
            async move {
                let mut svc = svc.clone();
                while let Some((req, resp_tx)) = rx.recv().await {
                    let res = match svc.ready().await {
                        Ok(svc) => match svc.call(req).await {
                            Ok(res) => Ok(res),
                            Err(e) => {
                                tracing::error!("Failed to make Steam request: {:?}", e);
                                Err(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
                            }
                        },
                        Err(e) => {
                            tracing::error!("Failed to make Steam request: {:?}", e);
                            Err(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
                        }
                    };

                    match resp_tx.send(res) {
                        Ok(_) => {}
                        Err(e) => tracing::error!("Failed to send response: {:?}", e),
                    }
                }
            }
            .instrument(tracing::info_span!("SteamProviderService")),
        );

        Self {
            request_tx: tx,
            config_manager,
            base_url,
            store_base_url,
        }
    }

    pub fn app_details_to_game_metadata(
        &self,
        app: models::Game,
        app_details: models::AppDetails,
    ) -> retrom::NewGameMetadata {
        let video_urls: Vec<String> = app_details
            .movies
            .map(|movies| {
                movies
                    .into_iter()
                    .filter_map(|movie| {
                        movie
                            .webm
                            .map(|quality| quality.max.clone())
                            .or(movie.mp4.map(|quality| quality.max.clone()))
                            .flatten()
                    })
                    .collect()
            })
            .unwrap_or_default();

        let screenshot_urls: Vec<String> = app_details
            .screenshots
            .map(|screenshots| {
                screenshots
                    .into_iter()
                    .map(|screenshot| screenshot.path_full)
                    .collect()
            })
            .unwrap_or_default();

        let mut artwork_urls: Vec<String> = vec![];

        if let Some(ref header_url) = app_details.header_image {
            artwork_urls.push(header_url.clone());
        }

        if let Some(ref background_url) = app_details.background_raw {
            artwork_urls.push(background_url.clone());
        }

        let cover_url = app_details.steam_appid.map(|id| {
            format!("https://steamcdn-a.akamaihd.net/steam/apps/{id}/library_600x900_2x.jpg")
        });

        let icon_url = app.img_icon_url.map(|icon_id| {
            format!(
                "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/apps/{}/{}.jpg",
                app.appid, icon_id
            )
        });

        let background_url = Some(format!(
            "https://steamcdn-a.akamaihd.net/steam/apps/{}/library_hero.jpg",
            app.appid
        ));

        let last_played = if app.rtime_last_played > 0 {
            let dt = DateTime::from_timestamp(app.rtime_last_played, 0);

            dt.map(|dt| Timestamp {
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

        let release_date = app_details.release_date.and_then(|rd| {
            if rd.coming_soon {
                return None;
            }
            parse_steam_release_date(&rd.date?)
        });

        retrom::NewGameMetadata {
            description: app_details.short_description,
            name: app_details.name,
            cover_url,
            background_url,
            links: app_details
                .website
                .map(|website| vec![website])
                .unwrap_or_default(),
            icon_url,
            artwork_urls,
            screenshot_urls,
            video_urls,
            last_played,
            minutes_played,
            release_date,
            ..Default::default()
        }
    }

    #[instrument(skip(self))]
    pub async fn get_app_details(
        &self,
        app_id: u32,
    ) -> Result<models::AppDetails, reqwest::StatusCode> {
        let path = self.store_base_url.to_string() + "/appdetails";

        let mut url = reqwest::Url::from_str(&path).expect("Invalid Base URL");

        url.query_pairs_mut()
            .append_pair("appids", &app_id.to_string())
            .append_pair("cc", "us")
            .append_pair("l", "english");

        tracing::debug!("Requesting App Details for App ID: {}", app_id);

        let req = reqwest::Request::new(reqwest::Method::GET, url);

        // Steam sometimes returns JSON `null` (instead of a proper object) when it
        // rate-limits a headless client or when the game isn't in the store DB.
        // Deserialise to Option<_> so we can handle that gracefully instead of a 500.
        let response_opt = self
            .make_request(req)
            .await?
            .json::<Option<models::AppDetailsResponse>>()
            .await
            .map_err(|e| {
                e.status()
                    .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
            })?;

        let mut res = match response_opt {
            Some(r) => r,
            None => {
                tracing::warn!(
                    "Steam returned null for app {} (rate-limited or not in store DB)",
                    app_id
                );
                return Err(reqwest::StatusCode::NOT_FOUND);
            }
        };

        let app_details = match res.remove(&app_id.to_string()) {
            Some(details) => match details.data {
                Some(data) => data,
                None => return Err(reqwest::StatusCode::NOT_FOUND),
            },
            None => return Err(reqwest::StatusCode::NOT_FOUND),
        };

        Ok(app_details)
    }

    #[instrument(skip(self))]
    pub async fn get_owned_games(
        &self,
    ) -> Result<models::GetOwnedGamesResponse, reqwest::StatusCode> {
        let path = self.base_url.to_string() + "/IPlayerService/GetOwnedGames/v1/";
        let mut url = reqwest::Url::from_str(&path).expect("Invalid Base URL");
        let config = self.config_manager.get_config().await;

        let user = match config.steam {
            Some(steam) => steam,
            None => return Err(reqwest::StatusCode::UNAUTHORIZED),
        };

        url.query_pairs_mut().append_pair("key", &user.api_key);
        url.query_pairs_mut().append_pair("steamid", &user.user_id);
        url.query_pairs_mut()
            .append_pair("include_appinfo", "true")
            .append_pair("include_played_free_games", "true");

        let req = reqwest::Request::new(reqwest::Method::GET, url);
        let res = self.make_request(req).await?;

        res.json::<models::GetOwnedGamesResponse>()
            .await
            .map_err(|e| {
                e.status()
                    .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
            })
    }

    /// Achievement definitions (display name, description, badge URLs) for an
    /// app. Returns an empty vec for games that simply have no achievement set
    /// (Steam returns `game: {}` with no `availableGameStats`).
    #[instrument(skip(self, api_key))]
    pub async fn get_schema_achievements(
        &self,
        app_id: u32,
        api_key: &str,
    ) -> Result<Vec<models::SchemaAchievement>, reqwest::StatusCode> {
        let path = self.base_url.to_string() + "/ISteamUserStats/GetSchemaForGame/v2/";
        let mut url = reqwest::Url::from_str(&path).expect("Invalid Base URL");
        url.query_pairs_mut()
            .append_pair("key", api_key)
            .append_pair("appid", &app_id.to_string())
            .append_pair("l", "english");

        let req = reqwest::Request::new(reqwest::Method::GET, url);
        let res = self.make_request(req).await?;

        let parsed = res
            .json::<models::GetSchemaForGameResponse>()
            .await
            .map_err(|e| {
                e.status()
                    .unwrap_or(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
            })?;

        Ok(parsed
            .game
            .and_then(|g| g.available_game_stats)
            .map(|s| s.achievements)
            .unwrap_or_default())
    }

    /// The user's per-achievement unlock state for an app. The returned
    /// `PlayerStats` carries `success`/`error` so callers can distinguish a
    /// private profile (needs attention) from a game with no stats (empty).
    #[instrument(skip(self, api_key))]
    pub async fn get_player_achievements(
        &self,
        app_id: u32,
        api_key: &str,
        steam_id: &str,
    ) -> Result<models::PlayerStats, reqwest::StatusCode> {
        let path = self.base_url.to_string() + "/ISteamUserStats/GetPlayerAchievements/v1/";
        let mut url = reqwest::Url::from_str(&path).expect("Invalid Base URL");
        url.query_pairs_mut()
            .append_pair("key", api_key)
            .append_pair("steamid", steam_id)
            .append_pair("appid", &app_id.to_string())
            .append_pair("l", "english");

        let req = reqwest::Request::new(reqwest::Method::GET, url);
        let res = self.make_request(req).await?;
        let status = res.status();

        // A private profile (or no-stats app) comes back either as a non-2xx
        // status or a 200 with `success: false` + an `error` string. Synthesise
        // the former into the latter so the caller has a single shape to read.
        Ok(res
            .json::<models::GetPlayerAchievementsResponse>()
            .await
            .map(|r| r.playerstats)
            .unwrap_or_else(|_| models::PlayerStats {
                success: false,
                error: Some(format!("Steam returned status {status}")),
                achievements: None,
            }))
    }

    /// Global unlock percentages (rarity) for an app, keyed by achievement api
    /// name. Best-effort: no API key required, and any failure yields an empty
    /// map rather than failing the whole fetch.
    #[instrument(skip(self))]
    pub async fn get_global_achievement_percentages(&self, app_id: u32) -> HashMap<String, f64> {
        let path = self.base_url.to_string()
            + "/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/";
        let mut url = reqwest::Url::from_str(&path).expect("Invalid Base URL");
        url.query_pairs_mut()
            .append_pair("gameid", &app_id.to_string())
            .append_pair("format", "json");

        let req = reqwest::Request::new(reqwest::Method::GET, url);
        let res = match self.make_request(req).await {
            Ok(res) => res,
            Err(why) => {
                tracing::debug!("Global achievement percentages request failed: {why}");
                return HashMap::new();
            }
        };

        match res
            .json::<models::GetGlobalAchievementPercentagesResponse>()
            .await
        {
            Ok(parsed) => parsed
                .achievement_percentages
                .map(|p| {
                    p.achievements
                        .into_iter()
                        .map(|a| (a.name, a.percent))
                        .collect()
                })
                .unwrap_or_default(),
            Err(why) => {
                tracing::debug!("Failed to parse global achievement percentages: {why}");
                HashMap::new()
            }
        }
    }

    async fn make_request(
        &self,
        req: reqwest::Request,
    ) -> Result<reqwest::Response, reqwest::StatusCode> {
        let (tx, rx) = oneshot::channel();

        match self.request_tx.clone().send((req, tx)).await {
            Ok(_) => {}
            Err(e) => {
                tracing::error!("Failed to send request: {:?}", e);
                return Err(reqwest::StatusCode::INTERNAL_SERVER_ERROR);
            }
        }

        match rx.await.expect("Failed to receive response") {
            Ok(res) => Ok(res),
            Err(e) => {
                tracing::error!("Failed to make Steam request: {:?}", e);
                Err(reqwest::StatusCode::INTERNAL_SERVER_ERROR)
            }
        }
    }
}

/// Parse the free-form `release_date.date` string from Steam's Store API
/// (requested with `l=english`) into a `Timestamp` at midnight UTC.
///
/// Steam does not return a structured date, and the rendered string varies by
/// title. We try the known English shapes in order and fall back to `None` for
/// anything we can't pin to a real calendar day ("Q1 2024", "To be announced",
/// a bare "2024" with no month, etc.). A missing day is treated as the 1st of
/// the month, and a year-only date is intentionally rejected rather than guessed.
fn parse_steam_release_date(raw: &str) -> Option<Timestamp> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }

    // Full day-precision formats, most common first.
    //   "21 Aug, 2012"  (day month, year — Steam's usual English form)
    //   "Aug 21, 2012"  (month day, year — occasionally returned)
    let naive = NaiveDate::parse_from_str(s, "%e %b, %Y")
        .or_else(|_| NaiveDate::parse_from_str(s, "%b %e, %Y"))
        // Month + year only ("Aug 2012" / "August 2012") — assume the 1st.
        .or_else(|_| NaiveDate::parse_from_str(&format!("1 {s}"), "%e %b %Y"))
        .or_else(|_| NaiveDate::parse_from_str(&format!("1 {s}"), "%e %B %Y"))
        .ok()?;

    let seconds = naive.and_hms_opt(0, 0, 0)?.and_utc().timestamp();
    Some(Timestamp { seconds, nanos: 0 })
}

#[cfg(test)]
mod tests {
    use super::parse_steam_release_date;

    fn date_parts(raw: &str) -> Option<(i32, u32, u32)> {
        use chrono::{DateTime, Datelike};
        let ts = parse_steam_release_date(raw)?;
        let dt = DateTime::from_timestamp(ts.seconds, 0)?;
        Some((dt.year(), dt.month(), dt.day()))
    }

    #[test]
    fn parses_day_month_year() {
        assert_eq!(date_parts("21 Aug, 2012"), Some((2012, 8, 21)));
        assert_eq!(date_parts("1 Nov, 2000"), Some((2000, 11, 1)));
    }

    #[test]
    fn parses_month_day_year() {
        assert_eq!(date_parts("Aug 21, 2012"), Some((2012, 8, 21)));
    }

    #[test]
    fn parses_month_year_only_as_first_of_month() {
        assert_eq!(date_parts("Aug 2012"), Some((2012, 8, 1)));
        assert_eq!(date_parts("August 2012"), Some((2012, 8, 1)));
    }

    #[test]
    fn rejects_unparseable_strings() {
        assert_eq!(date_parts("Q1 2024"), None);
        assert_eq!(date_parts("To be announced"), None);
        assert_eq!(date_parts("Coming soon"), None);
        assert_eq!(date_parts("2024"), None);
        assert_eq!(date_parts(""), None);
    }
}
