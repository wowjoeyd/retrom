use futures::StreamExt;
use regex::Regex;
use retrom_codegen::retrom::EmulatorCatalogUpstream;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DownloadError {
    #[error("http error: {0}")]
    Http(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("no matching release asset for pattern")]
    NoMatchingAsset,
    #[error("unsupported upstream type: {0}")]
    UnsupportedUpstream(String),
    #[error("upstream configuration incomplete")]
    IncompleteUpstream,
}

#[derive(Debug, Clone)]
pub struct DownloadedAsset {
    pub path: PathBuf,
    pub version: String,
}

pub async fn download_upstream_asset(
    upstream: &EmulatorCatalogUpstream,
    temp_dir: &Path,
) -> Result<DownloadedAsset, DownloadError> {
    match upstream.r#type.as_str() {
        "github_release" => download_github_release(upstream, temp_dir).await,
        "forge_release" => download_forge_release(upstream, temp_dir).await,
        "direct_url" => download_direct_url(upstream, temp_dir).await,
        other => Err(DownloadError::UnsupportedUpstream(other.to_string())),
    }
}

async fn download_github_release(
    upstream: &EmulatorCatalogUpstream,
    temp_dir: &Path,
) -> Result<DownloadedAsset, DownloadError> {
    let repo = upstream
        .repo
        .as_ref()
        .ok_or(DownloadError::IncompleteUpstream)?;
    let api_url = format!("https://api.github.com/repos/{repo}/releases/latest");
    download_release_api(&api_url, upstream, temp_dir).await
}

async fn download_forge_release(
    upstream: &EmulatorCatalogUpstream,
    temp_dir: &Path,
) -> Result<DownloadedAsset, DownloadError> {
    let api_url = upstream
        .url
        .as_ref()
        .ok_or(DownloadError::IncompleteUpstream)?;
    download_release_api(api_url, upstream, temp_dir).await
}

#[derive(serde::Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(serde::Deserialize)]
struct ReleaseResponse {
    tag_name: String,
    assets: Vec<ReleaseAsset>,
}

async fn download_release_api(
    api_url: &str,
    upstream: &EmulatorCatalogUpstream,
    temp_dir: &Path,
) -> Result<DownloadedAsset, DownloadError> {
    let client = reqwest::Client::new();
    let response = client
        .get(api_url)
        .header("User-Agent", "retrom-emulator-catalog")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|why| DownloadError::Http(why.to_string()))?;

    if !response.status().is_success() {
        return Err(DownloadError::Http(format!(
            "release API returned {}",
            response.status()
        )));
    }

    let release: ReleaseResponse = response
        .json()
        .await
        .map_err(|why| DownloadError::Http(why.to_string()))?;
    let pattern = upstream
        .asset_pattern
        .as_ref()
        .ok_or(DownloadError::IncompleteUpstream)?;
    let regex = Regex::new(pattern).map_err(|why| DownloadError::Http(why.to_string()))?;

    let asset = release
        .assets
        .iter()
        .find(|asset| regex.is_match(&asset.name))
        .ok_or(DownloadError::NoMatchingAsset)?;

    let version = normalize_version(&release.tag_name);
    let dest = temp_dir.join(&asset.name);
    stream_url_to_file(&asset.browser_download_url, &dest).await?;

    Ok(DownloadedAsset {
        path: dest,
        version,
    })
}

async fn download_direct_url(
    upstream: &EmulatorCatalogUpstream,
    temp_dir: &Path,
) -> Result<DownloadedAsset, DownloadError> {
    let url = upstream
        .url
        .as_ref()
        .ok_or(DownloadError::IncompleteUpstream)?;

    let file_name = url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download.bin")
        .to_string();

    let dest = temp_dir.join(&file_name);
    stream_url_to_file(url, &dest).await?;

    let version = extract_version_from_filename(&file_name).unwrap_or_else(|| "latest".to_string());

    Ok(DownloadedAsset {
        path: dest,
        version,
    })
}

async fn stream_url_to_file(url: &str, dest: &Path) -> Result<(), DownloadError> {
    tokio::fs::create_dir_all(
        dest.parent()
            .ok_or_else(|| DownloadError::Http("invalid dest path".into()))?,
    )
    .await?;

    let response = reqwest::get(url)
        .await
        .map_err(|why| DownloadError::Http(why.to_string()))?;

    if !response.status().is_success() {
        return Err(DownloadError::Http(format!(
            "download returned {}",
            response.status()
        )));
    }

    let mut file = tokio::fs::File::create(dest).await?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|why| DownloadError::Http(why.to_string()))?;
        tokio::io::copy(&mut chunk.as_ref(), &mut file)
            .await
            .map_err(|why| DownloadError::Http(why.to_string()))?;
    }

    Ok(())
}

fn normalize_version(tag: &str) -> String {
    tag.trim_start_matches('v').to_string()
}

fn extract_version_from_filename(file_name: &str) -> Option<String> {
    let version_regex = Regex::new(r"v?(\d+\.\d+(?:\.\d+)?(?:[-.][\w.]+)?)").ok()?;
    version_regex
        .captures(file_name)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim_start_matches('v').to_string())
}
