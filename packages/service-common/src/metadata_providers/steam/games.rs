use crate::metadata_providers::{soundtrack::find_soundtrack_url, GameMetadataProvider};

use super::{models, provider::SteamWebApiProvider};

impl GameMetadataProvider<models::Game> for SteamWebApiProvider {
    async fn get_game_metadata(
        &self,
        game: retrom_codegen::retrom::Game,
        query: Option<models::Game>,
    ) -> Option<retrom_codegen::retrom::NewGameMetadata> {
        let app = match query {
            Some(app) => app,
            None => return None,
        };

        let app_details = match self.get_app_details(app.appid).await {
            Ok(details) => details,
            Err(e) => {
                tracing::warn!(
                    "Failed to get app details for app {:?}: Status {:?}",
                    app.appid,
                    e
                );
                return None;
            }
        };

        let app_name = app.name.clone();
        let mut metadata = self.app_details_to_game_metadata(app, app_details);

        let soundtrack_query_name = metadata.name.clone().unwrap_or(app_name);
        if let Some(soundtrack_url) = find_soundtrack_url(&soundtrack_query_name).await {
            if !metadata.video_urls.iter().any(|url| url == &soundtrack_url) {
                metadata.video_urls.insert(0, soundtrack_url);
            }
        }

        metadata.game_id = Some(game.id);

        Some(metadata)
    }

    async fn search_game_metadata(
        &self,
        _query: models::Game,
    ) -> Vec<retrom_codegen::retrom::NewGameMetadata> {
        vec![]
    }
}
