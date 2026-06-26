//! Launch adapters.
//!
//! Every way Retrom can start a game — a native emulator process, EmulatorJS in
//! an embedded webview, a third-party (Steam) title — implements the same
//! [`LaunchAdapter`] contract: pick the launch that matches the game, then drive
//! its whole lifecycle (register the session, monitor for exit, sync, mark the
//! game stopped, and return the player to the library).
//!
//! Keeping this behind one trait means new platforms (Epic, GOG, …) plug into
//! the same overlay + return-to-library lifecycle without touching the dispatch
//! site.

use async_trait::async_trait;
use retrom_codegen::retrom::{Emulator, EmulatorProfile, Game, GameFile};
use tauri::{AppHandle, Runtime};
use tracing::info;

mod native;
mod steam;
mod wasm;

use native::NativeAdapter;
use steam::SteamAdapter;
use wasm::WasmAdapter;

/// Everything an adapter needs to launch a game, decoded from a `PlayGamePayload`
/// plus the resolved client config.
pub(crate) struct LaunchContext<R: Runtime> {
    pub app: AppHandle<R>,
    pub game: Game,
    pub emulator: Option<Emulator>,
    pub profile: Option<EmulatorProfile>,
    pub file: Option<GameFile>,
    pub standalone: bool,
    /// Set when this launch belongs to an active Remote Play session, so the
    /// adapter ends the session instead of foregrounding the host's local UI.
    /// `None` for normal local play.
    pub remote_play_session_id: Option<i32>,
}

#[async_trait]
pub(crate) trait LaunchAdapter<R: Runtime>: Send + Sync {
    /// Human-readable name, for logs.
    fn name(&self) -> &'static str;

    /// Whether this adapter should handle the given launch.
    fn matches(&self, ctx: &LaunchContext<R>) -> bool;

    /// Launch the game and drive its lifecycle to completion.
    async fn launch(&self, ctx: LaunchContext<R>) -> crate::Result<()>;
}

/// Pick the first adapter that matches the game and launch it. [`NativeAdapter`]
/// is the catch-all and must come last.
pub(crate) async fn dispatch<R: Runtime>(ctx: LaunchContext<R>) -> crate::Result<()> {
    let adapters: [Box<dyn LaunchAdapter<R>>; 3] = [
        Box::new(SteamAdapter),
        Box::new(WasmAdapter),
        Box::new(NativeAdapter),
    ];

    for adapter in adapters {
        if adapter.matches(&ctx) {
            info!(
                "Launching game {} via the {} adapter",
                ctx.game.id,
                adapter.name()
            );
            return adapter.launch(ctx).await;
        }
    }

    // Unreachable in practice: NativeAdapter::matches is always true.
    Err(crate::Error::InternalError(
        "No launch adapter matched the game".into(),
    ))
}
