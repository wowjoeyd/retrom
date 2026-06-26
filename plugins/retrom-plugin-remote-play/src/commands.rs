use crate::sunshine::{EnsureOutcome, HostReadiness};
use crate::RemotePlayExt;
use crate::Result;
use tauri::{command, AppHandle, Runtime};
use tracing::instrument;

/// Whether this host is ready for Remote Play: Sunshine installed/running and the
/// managed "Retrom Remote Play" app present.
#[command]
#[instrument(skip(app))]
pub(crate) async fn remote_play_host_readiness<R: Runtime>(
    app: AppHandle<R>,
) -> Result<HostReadiness> {
    Ok(app.remote_play().host_readiness().await)
}

/// Setup flow: idempotently ensure the managed "Retrom Remote Play" Sunshine app
/// exists, returning whether it was created, updated, or already present.
#[command]
#[instrument(skip(app))]
pub(crate) async fn remote_play_ensure_host_app<R: Runtime>(
    app: AppHandle<R>,
) -> Result<EnsureOutcome> {
    app.remote_play().ensure_host_app().await
}

/// Viewer flow: start streaming the given game from the configured host (create a
/// session and launch Moonlight). Resolves when streaming ends.
#[command]
#[instrument(skip(app))]
pub(crate) async fn start_remote_play<R: Runtime>(app: AppHandle<R>, game_id: i32) -> Result<()> {
    app.remote_play().start_remote_play(game_id).await?;
    Ok(())
}
