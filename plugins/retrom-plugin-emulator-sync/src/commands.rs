use crate::EmulatorSyncExt;
use prost::Message;
use retrom_codegen::retrom::client::emulator_sync::{
    EnsureEmulatorSyncedPayload, GetEmulatorSyncStatusPayload, GetEmulatorSyncStatusResponse,
    PushEmulatorPreservePayload, PushEmulatorPreserveResponse,
};
use tauri::{ipc::Channel, AppHandle, Runtime};
use tauri_plugin_opener::OpenerExt;
use tracing::{debug, instrument};

#[instrument(skip_all)]
#[tauri::command]
pub async fn ensure_emulator_synced<R: Runtime>(
    app_handle: AppHandle<R>,
    payload: Vec<u8>,
) -> crate::Result<String> {
    let payload = EnsureEmulatorSyncedPayload::decode(payload.as_slice())?;
    let manager = app_handle.emulator_sync();

    let executable = manager.ensure_emulator_synced(payload.emulator_id).await?;

    Ok(executable.to_string_lossy().to_string())
}

#[instrument(skip_all)]
#[tauri::command]
pub async fn get_emulator_sync_status<R: Runtime>(
    app_handle: AppHandle<R>,
    payload: Vec<u8>,
) -> crate::Result<Vec<u8>> {
    let payload = GetEmulatorSyncStatusPayload::decode(payload.as_slice())?;
    let manager = app_handle.emulator_sync();

    let status = manager
        .get_emulator_sync_status(payload.emulator_id)
        .await?;

    Ok(GetEmulatorSyncStatusResponse {
        emulator_id: payload.emulator_id,
        status: status as i32,
    }
    .encode_to_vec())
}

#[instrument(skip_all)]
#[tauri::command]
pub async fn get_emulator_sync_index<R: Runtime>(
    app_handle: AppHandle<R>,
) -> crate::Result<Vec<u8>> {
    let manager = app_handle.emulator_sync();
    let index = manager.get_emulator_sync_index().await?;
    Ok(index.encode_to_vec())
}

#[instrument(skip(app_handle, channel))]
#[tauri::command]
pub async fn subscribe_to_emulator_sync_updates<R: Runtime>(
    app_handle: AppHandle<R>,
    channel: Channel<&'static [u8]>,
) -> crate::Result<()> {
    let manager = app_handle.emulator_sync();
    debug!("Subscribing to emulator sync updates");
    manager.add_update_subscription(channel).await
}

#[instrument(skip(app_handle))]
#[tauri::command]
pub async fn unsubscribe_from_emulator_sync_updates<R: Runtime>(
    app_handle: AppHandle<R>,
    channel_id: u32,
) -> crate::Result<()> {
    let manager = app_handle.emulator_sync();
    debug!("Unsubscribing from emulator sync updates: {channel_id}");
    manager.remove_update_subscription(channel_id).await;
    Ok(())
}

#[instrument(skip(app_handle))]
#[tauri::command]
pub async fn abort_emulator_sync<R: Runtime>(
    app_handle: AppHandle<R>,
    emulator_id: i32,
) -> crate::Result<()> {
    app_handle
        .emulator_sync()
        .abort_emulator_sync(emulator_id)
        .await
}

#[instrument(skip(app))]
#[tauri::command]
pub async fn open_emulator_cache_dir<R: Runtime>(app: AppHandle<R>) -> crate::Result<()> {
    let path = app.emulator_sync().open_emulator_cache_dir().await?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)?;
    Ok(())
}

#[instrument(skip_all)]
#[tauri::command]
pub async fn push_emulator_preserve_data<R: Runtime>(
    app_handle: AppHandle<R>,
    payload: Vec<u8>,
) -> crate::Result<Vec<u8>> {
    let payload = PushEmulatorPreservePayload::decode(payload.as_slice())?;
    let manager = app_handle.emulator_sync();

    let result = manager
        .push_preserve_data(payload.emulator_id)
        .await?;

    Ok(PushEmulatorPreserveResponse {
        emulator_id: payload.emulator_id,
        files_uploaded: result.files_uploaded,
        bytes_uploaded: result.bytes_uploaded,
    }
    .encode_to_vec())
}

#[instrument(skip_all)]
#[tauri::command]
pub async fn pull_emulator_user_data<R: Runtime>(
    app_handle: AppHandle<R>,
    payload: Vec<u8>,
) -> crate::Result<Vec<u8>> {
    let payload = PushEmulatorPreservePayload::decode(payload.as_slice())?;
    let manager = app_handle.emulator_sync();

    let result = manager.pull_user_data(payload.emulator_id).await?;

    Ok(PushEmulatorPreserveResponse {
        emulator_id: payload.emulator_id,
        files_uploaded: result.files_uploaded,
        bytes_uploaded: result.bytes_uploaded,
    }
    .encode_to_vec())
}
