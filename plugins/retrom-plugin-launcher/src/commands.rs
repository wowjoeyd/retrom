use crate::{
    launch::{dispatch, LaunchContext},
    LauncherExt, Result,
};
use prost::Message;
use retrom_codegen::retrom::{
    GamePlayStatusUpdate, GetGamePlayStatusPayload, PlayGamePayload, PlayStatus, StopGamePayload,
};
use retrom_plugin_config::ConfigExt;
use tauri::{command, AppHandle, Runtime};
use tracing::instrument;

#[command]
#[instrument(skip_all)]
pub(crate) async fn play_game<R: Runtime>(app: AppHandle<R>, payload: Vec<u8>) -> Result<()> {
    let payload = PlayGamePayload::decode(payload.as_slice())?;

    let standalone = app
        .config_manager()
        .get_config()
        .await
        .server
        .and_then(|s| s.standalone)
        .unwrap_or(false);

    let game = match payload.game {
        Some(game) => game,
        None => return Err(crate::Error::GameNotFound(None)),
    };

    let ctx = LaunchContext {
        app,
        game,
        emulator: payload.emulator,
        profile: payload.emulator_profile,
        file: payload.file,
        standalone,
    };

    dispatch(ctx).await
}

#[command]
#[instrument(skip_all)]
pub(crate) async fn stop_game<R: Runtime>(app: AppHandle<R>, payload: Vec<u8>) -> Result<()> {
    let payload = StopGamePayload::decode(payload.as_slice())?;
    let launcher = app.launcher();
    let game = payload.game;

    let game_id = match game {
        Some(game) => game.id,
        None => return Err(crate::Error::GameNotFound(None)),
    };

    launcher.stop_game(game_id).await?;

    Ok(())
}

/// Toggle quit-to-library combo capture. While active, the native gamepad reader
/// broadcasts held buttons on `quit-rebind:buttons` so the settings UI can record
/// a new combo (see the config menus). No-op on platforms without the reader.
#[command]
#[instrument(skip_all)]
pub(crate) async fn set_quit_rebind_active<R: Runtime>(
    app: AppHandle<R>,
    active: bool,
) -> Result<()> {
    app.launcher().set_rebind_active(active);
    Ok(())
}

#[command]
#[instrument(skip_all)]
pub(crate) async fn get_game_play_status<R: Runtime>(
    app: AppHandle<R>,
    payload: Vec<u8>,
) -> Result<Vec<u8>> {
    let launcher = app.launcher();
    let payload = GetGamePlayStatusPayload::decode(payload.as_slice())?;
    let game = payload.game;

    let game_id = match &game {
        Some(game) => game.id,
        None => return Err(crate::Error::GameNotFound(None)),
    };

    let res = if launcher.is_game_running(game_id).await {
        GamePlayStatusUpdate {
            game_id,
            play_status: PlayStatus::Playing.into(),
        }
    } else {
        GamePlayStatusUpdate {
            game_id,
            play_status: PlayStatus::NotPlaying.into(),
        }
    };

    Ok(res.encode_to_vec())
}
