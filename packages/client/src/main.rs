// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use retrom_plugin_config::ConfigExt;
use std::fs::OpenOptions;
use tauri::Manager;
use tracing_opentelemetry::{MetricsLayer, OpenTelemetryLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, Layer};

/// Bring Retrom's window to the OS foreground, like a game launching into
/// fullscreen. On Windows a background process can't simply call
/// SetForegroundWindow (the OS foreground lock ignores it and at most flashes
/// the taskbar). Temporarily attaching our input thread to the current
/// foreground window's thread lifts that restriction long enough to legitimately
/// take focus — the same approach used by launchers and window managers. This
/// does NOT pin the window always-on-top, so other windows can still be brought
/// forward normally afterwards.
#[cfg(windows)]
#[tauri::command]
fn request_foreground(window: tauri::WebviewWindow) {
    use std::ptr;
    use windows_sys::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, IsIconic,
        SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let hwnd = match window.hwnd() {
        Ok(handle) => handle.0,
        Err(why) => {
            tracing::warn!("request_foreground: failed to get window handle: {why}");
            return;
        }
    };

    unsafe {
        let foreground = GetForegroundWindow();
        if foreground == hwnd {
            return;
        }

        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }

        let current_thread = GetCurrentThreadId();
        let foreground_thread = GetWindowThreadProcessId(foreground, ptr::null_mut());

        let attached = foreground_thread != 0
            && foreground_thread != current_thread
            && AttachThreadInput(current_thread, foreground_thread, 1) != 0;

        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);

        if attached {
            AttachThreadInput(current_thread, foreground_thread, 0);
        }
    }
}

/// macOS/Linux don't impose Windows' foreground-stealing restriction, so a plain
/// focus request is enough to raise the window.
#[cfg(not(windows))]
#[tauri::command]
fn request_foreground(window: tauri::WebviewWindow) {
    if let Err(why) = window.set_focus() {
        tracing::warn!("request_foreground: failed to focus window: {why}");
    }
}

#[tokio::main]
pub async fn main() {
    dotenvy::dotenv().ok();

    tauri::async_runtime::set(tokio::runtime::Handle::current());

    tauri::Builder::default()
        .plugin(retrom_plugin_config::init())
        .setup(|app| {
            let mut layers = vec![];

            let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,".into())
                .add_directive("app=info".parse().unwrap())
                // Silence noisy OpenTelemetry/axum-otel internals (e.g. "BatchSpanProcessor
                // .ExportError" when no collector is reachable, and "SpanDisabled" warnings).
                .add_directive("opentelemetry=off".parse().unwrap())
                .add_directive("opentelemetry_sdk=off".parse().unwrap())
                .add_directive("axum_tracing_opentelemetry=off".parse().unwrap());

            let fmt_layer = tracing_subscriber::fmt::layer()
                .pretty()
                .without_time()
                .with_target(false)
                .with_ansi(true)
                .boxed();

            layers.push(fmt_layer);

            let config = app.config_manager().get_config_blocking();

            if config.telemetry.is_some_and(|t| t.enabled) {
                use opentelemetry::trace::TracerProvider;

                let tracer_provider = retrom_telemetry::get_tracer_provider();
                let meter_provider = retrom_telemetry::init_meter_provider();

                let tracer = tracer_provider.tracer("main");

                let metrics_layer = MetricsLayer::new(meter_provider).boxed();
                let telemetry_layer = OpenTelemetryLayer::new(tracer).boxed();

                layers.push(metrics_layer);
                layers.push(telemetry_layer);
            }

            let registry = tracing_subscriber::registry().with(layers).with(env_filter);

            let log_dir = app.path().app_log_dir().expect("failed to get log dir");

            if !log_dir.exists() {
                std::fs::create_dir_all(&log_dir).unwrap();
            }

            let log_file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(log_dir.join("retrom.log"))
                .expect("failed to open log file");

            let file_layer = tracing_subscriber::fmt::layer()
                .json()
                .with_writer(log_file);

            registry.with(file_layer).init();

            if config.telemetry.is_some_and(|t| t.enabled) {
                tracing::info!("Telemetry enabled");
            } else {
                tracing::info!("Telemetry disabled");
            }

            if let Err(why) = app
                .handle()
                .plugin(tauri_plugin_window_state::Builder::default().build())
            {
                tracing::error!("Failed to initialize window state plugin: {}", why);
            }

            let app_handle = app.handle().clone();
            tokio::spawn(async move {
                tokio::signal::ctrl_c()
                    .await
                    .expect("Failed to listen for ctrl-c");

                app_handle.exit(0);
            });

            Ok(())
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(retrom_plugin_standalone::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if !cfg!(dev) {
                app.webview_windows()
                    .values()
                    .next()
                    .expect("no window found")
                    .set_focus()
                    .expect("failed to set focus");
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_system_info::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(retrom_plugin_service_client::init())
        .plugin(retrom_plugin_steam::init())
        .plugin(retrom_plugin_installer::init())
        .plugin(retrom_plugin_emulator_sync::init())
        .plugin(retrom_plugin_launcher::init().await)
        .plugin(retrom_plugin_webdav_client::init())
        .plugin(retrom_plugin_save_manager::init())
        .invoke_handler(tauri::generate_handler![request_foreground])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
