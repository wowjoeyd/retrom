//! Launches WASM cores (EmulatorJS) inside an embedded Retrom webview window.

use std::sync::Arc;

use async_trait::async_trait;
use retrom_codegen::retrom::emulator::OperatingSystem;
use tauri::{http::HeaderValue, Manager, Runtime, WebviewUrl, WebviewWindow, WindowEvent};
use tokio::sync::Mutex;
use tracing::{error, warn};

use crate::{desktop::GameProcess, LauncherExt};

use super::{LaunchAdapter, LaunchContext};

pub(crate) struct WasmAdapter;

#[async_trait]
impl<R: Runtime> LaunchAdapter<R> for WasmAdapter {
    fn name(&self) -> &'static str {
        "wasm"
    }

    fn matches(&self, ctx: &LaunchContext<R>) -> bool {
        ctx.emulator.as_ref().is_some_and(|emulator| {
            emulator.libretro_name.is_some()
                && emulator
                    .operating_systems
                    .contains(&(OperatingSystem::Wasm as i32))
        })
    }

    async fn launch(&self, ctx: LaunchContext<R>) -> crate::Result<()> {
        let LaunchContext {
            app,
            game,
            emulator,
            ..
        } = ctx;

        let emulator = emulator.expect("WasmAdapter launched without an emulator");
        let game_id = game.id;
        let launcher = app.launcher();

        let (send, mut recv) = tokio::sync::mpsc::channel(1);
        let send = Arc::new(Mutex::new(send));

        launcher
            .mark_game_as_running(
                game_id,
                GameProcess {
                    send: send.clone(),
                    start_time: std::time::SystemTime::now(),
                },
            )
            .await?;

        let app_inner = app.clone();
        let send_for_build = send.clone();
        app.run_on_main_thread(move || {
            tokio::spawn(async move {
                let web_view = match WebviewWindow::builder(
                    &app_inner,
                    "emulator-js",
                    WebviewUrl::App(
                        format!(
                            "/play/{}/frame?coreName={}",
                            game.id,
                            emulator.libretro_name()
                        )
                        .into(),
                    ),
                )
                .title(emulator.name)
                .focused(true)
                .on_web_resource_request(|req, res| {
                    if req.uri().path().ends_with("/frame") {
                        let headers = res.headers_mut();

                        headers.insert(
                            "Cross-Origin-Opener-Policy",
                            HeaderValue::from_static("same-origin"),
                        );
                        headers.insert(
                            "Cross-Origin-Embedder-Policy",
                            HeaderValue::from_static("credentialless"),
                        );
                    }
                })
                .build()
                {
                    Ok(web_view) => web_view,
                    Err(why) => {
                        error!("Failed to build EmulatorJS webview window: {why}");
                        // Signal stop so the session can't get stuck "running" when
                        // the window never actually opened.
                        let _ = send_for_build.lock().await.send(()).await;
                        return;
                    }
                };

                web_view.on_window_event(move |event| {
                    let send = send.clone();
                    if let WindowEvent::CloseRequested { .. } = event {
                        tokio::spawn(async move {
                            let _ = send.lock().await.send(()).await;
                        });
                    }
                });
            });
        })?;

        tokio::spawn(async move {
            recv.recv().await;
            // Close the embedded webview if it's still open — e.g. when the stop
            // came from the quit-to-library hotkey rather than the window's own
            // close button. Closing an already-closing window is a harmless no-op.
            if let Some(win) = app.get_webview_window("emulator-js") {
                let _ = win.close();
            }
            app.launcher().foreground_main_window();
            if let Err(why) = app.launcher().mark_game_as_stopped(game_id).await {
                warn!("Failed to mark game {game_id} as stopped: {why}");
            }
        });

        Ok(())
    }
}
