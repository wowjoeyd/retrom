use futures::TryStreamExt;
use reqwest::header::HeaderMap;
use std::path::Path;
use thiserror::Error;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
    #[error("download returned HTTP {0}")]
    BadStatus(reqwest::StatusCode),
    #[error("download cancelled")]
    Cancelled,
}

/// Controls whether streaming should proceed, wait, stop successfully, or abort.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamControl {
    Continue,
    Wait,
    Stop,
    Abort,
}

/// Stream an HTTP resource to a local file, reporting progress per chunk.
pub async fn stream_to_file<F, S>(
    client: &reqwest::Client,
    uri: &str,
    dest: &Path,
    headers: Option<&HeaderMap>,
    mut on_progress: F,
    mut should_continue: S,
) -> Result<u64, DownloadError>
where
    F: FnMut(usize),
    S: FnMut() -> StreamControl,
{
    let mut request = client.get(uri);
    if let Some(headers) = headers {
        request = request.headers(headers.clone());
    }

    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(DownloadError::BadStatus(response.status()));
    }

    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }

    // Buffer writes (256 KiB) so many small stream chunks coalesce into fewer, larger
    // write syscalls — meaningfully faster for large downloads.
    let mut outfile = tokio::io::BufWriter::with_capacity(
        256 * 1024,
        tokio::fs::File::create(dest).await?,
    );
    let mut stream = response.bytes_stream();
    let mut total: u64 = 0;

    loop {
        match should_continue() {
            StreamControl::Continue => {}
            StreamControl::Wait => {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            StreamControl::Stop => break,
            StreamControl::Abort => return Err(DownloadError::Cancelled),
        }

        let chunk = match stream.try_next().await? {
            Some(bytes) => bytes,
            None => break,
        };

        if chunk.is_empty() {
            break;
        }

        outfile.write_all(&chunk).await?;
        let len = chunk.len();
        total += len as u64;
        on_progress(len);
    }

    outfile.flush().await?;
    Ok(total)
}
