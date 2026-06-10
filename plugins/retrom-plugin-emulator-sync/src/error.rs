use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    DecodeError(#[from] prost::DecodeError),
    #[error(transparent)]
    ConfigError(#[from] retrom_plugin_config::Error),
    #[error(transparent)]
    Download(#[from] retrom_download::DownloadError),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    OpenPath(#[from] tauri_plugin_opener::Error),
    #[error("Tonic Error: {0}")]
    Tonic(tonic::Code),
    #[error("Emulator {0} has no linked package")]
    EmulatorPackageNotLinked(i32),
    #[error("Emulator package sync is disabled")]
    SyncDisabled,
    #[error("Emulator sync aborted")]
    SyncAborted,
    #[error("Emulator {0} is not using managed paths")]
    NotManaged(i32),
    #[error("Internal Error: {0}")]
    Internal(String),
}

impl From<tonic::Status> for Error {
    fn from(status: tonic::Status) -> Self {
        Error::Tonic(status.code())
    }
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}