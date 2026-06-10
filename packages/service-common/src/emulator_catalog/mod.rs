mod platform_resolve;

use retrom_codegen::retrom::{
    emulator::OperatingSystem, EmulatorCatalogDefaultProfile, EmulatorCatalogEntry,
    EmulatorCatalogInstall, EmulatorCatalogUpstream,
};
use std::{
    collections::HashMap,
    path::Path,
};
use tracing::warn;

pub use platform_resolve::resolve_platform_ids_for_catalog_entry;

const BUILTIN_CATALOG: &[(&str, &str)] = &[
    ("rpcs3-windows-x64", include_str!("entries/rpcs3-windows-x64.json")),
    (
        "pcsx2-windows-x64",
        include_str!("entries/pcsx2-windows-x64.json"),
    ),
    (
        "duckstation-windows-x64",
        include_str!("entries/duckstation-windows-x64.json"),
    ),
    (
        "eden-windows-x64",
        include_str!("entries/eden-windows-x64.json"),
    ),
    (
        "citron-windows-x64",
        include_str!("entries/citron-windows-x64.json"),
    ),
    (
        "ryubing-windows-x64",
        include_str!("entries/ryubing-windows-x64.json"),
    ),
];

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct CatalogEntryFile {
    catalog_id: String,
    display_name: String,
    description: Option<String>,
    supported_platform_folder_names: Vec<String>,
    operating_systems: Vec<String>,
    installable: bool,
    deprecated: bool,
    legal_notice: Option<String>,
    default_profile: Option<CatalogDefaultProfileFile>,
    upstream: CatalogUpstreamFile,
    install: CatalogInstallFile,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct CatalogDefaultProfileFile {
    name: String,
    supported_extensions: Vec<String>,
    custom_args: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct CatalogUpstreamFile {
    #[serde(rename = "type")]
    upstream_type: String,
    repo: Option<String>,
    asset_pattern: Option<String>,
    manifest_version_from: Option<String>,
    url: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct CatalogInstallFile {
    archive_type: String,
    strip_components: u32,
    executable_relative_path: Option<String>,
    executable_glob: Option<String>,
    #[serde(default)]
    preserve_paths: Vec<String>,
}

pub fn load_catalog(custom_catalog_dir: Option<&str>) -> Vec<EmulatorCatalogEntry> {
    let mut entries = HashMap::new();

    for (catalog_id, json) in BUILTIN_CATALOG {
        match parse_catalog_entry(json) {
            Ok(entry) => {
                entries.insert(catalog_id.to_string(), entry);
            }
            Err(why) => warn!("Failed to parse built-in catalog entry {catalog_id}: {why}"),
        }
    }

    if let Some(dir) = custom_catalog_dir {
        merge_custom_catalog_dir(&mut entries, Path::new(dir));
    }

    let mut merged: Vec<_> = entries.into_values().collect();
    merged.sort_by(|left, right| left.catalog_id.cmp(&right.catalog_id));
    merged
}

fn merge_custom_catalog_dir(entries: &mut HashMap<String, EmulatorCatalogEntry>, dir: &Path) {
    let read_dir = match std::fs::read_dir(dir) {
        Ok(read_dir) => read_dir,
        Err(why) => {
            warn!("Could not read custom_catalog_dir {:?}: {why}", dir);
            return;
        }
    };

    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let contents = match std::fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(why) => {
                warn!("Could not read catalog overlay {:?}: {why}", path);
                continue;
            }
        };

        match parse_catalog_entry(&contents) {
            Ok(parsed) => {
                entries.insert(parsed.catalog_id.clone(), parsed);
            }
            Err(why) => warn!("Failed to parse catalog overlay {:?}: {why}", path),
        }
    }
}

fn parse_catalog_entry(json: &str) -> Result<EmulatorCatalogEntry, serde_json::Error> {
    let file: CatalogEntryFile = serde_json::from_str(json)?;
    Ok(file.into())
}

impl From<CatalogEntryFile> for EmulatorCatalogEntry {
    fn from(file: CatalogEntryFile) -> Self {
        Self {
            catalog_id: file.catalog_id,
            display_name: file.display_name,
            description: file.description,
            supported_platform_folder_names: file.supported_platform_folder_names,
            operating_systems: file
                .operating_systems
                .iter()
                .filter_map(|os| parse_operating_system(os).map(i32::from))
                .collect(),
            installable: file.installable,
            deprecated: file.deprecated,
            legal_notice: file.legal_notice,
            default_profile: file.default_profile.map(Into::into),
            upstream: Some(file.upstream.into()),
            install: Some(file.install.into()),
        }
    }
}

impl From<CatalogDefaultProfileFile> for EmulatorCatalogDefaultProfile {
    fn from(profile: CatalogDefaultProfileFile) -> Self {
        Self {
            name: profile.name,
            supported_extensions: profile.supported_extensions,
            custom_args: profile.custom_args,
        }
    }
}

impl From<CatalogUpstreamFile> for EmulatorCatalogUpstream {
    fn from(upstream: CatalogUpstreamFile) -> Self {
        Self {
            r#type: upstream.upstream_type,
            repo: upstream.repo,
            asset_pattern: upstream.asset_pattern,
            manifest_version_from: upstream.manifest_version_from,
            url: upstream.url,
        }
    }
}

impl From<CatalogInstallFile> for EmulatorCatalogInstall {
    fn from(install: CatalogInstallFile) -> Self {
        Self {
            archive_type: install.archive_type,
            strip_components: install.strip_components,
            executable_relative_path: install.executable_relative_path,
            executable_glob: install.executable_glob,
            preserve_paths: install.preserve_paths,
        }
    }
}

fn parse_operating_system(value: &str) -> Option<OperatingSystem> {
    match value.to_ascii_uppercase().as_str() {
        "WINDOWS" => Some(OperatingSystem::Windows),
        "MACOS" => Some(OperatingSystem::Macos),
        "LINUX" | "LINUX_X86_64" => Some(OperatingSystem::LinuxX8664),
        "WASM" => Some(OperatingSystem::Wasm),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::load_catalog;
    use std::path::PathBuf;

    #[test]
    fn loads_builtin_switch_catalog_entries() {
        let entries = load_catalog(None);
        let switch_entries: Vec<_> = entries
            .iter()
            .filter(|entry| {
                entry
                    .supported_platform_folder_names
                    .contains(&"switch".to_string())
            })
            .collect();

        assert_eq!(switch_entries.len(), 3);
        assert!(switch_entries.iter().all(|entry| entry.installable));
        assert!(switch_entries.iter().all(|entry| !entry.deprecated));
    }

    #[test]
    fn custom_catalog_overlay_replaces_builtin_entry() {
        let dir = tempfile::tempdir().expect("temp catalog dir");
        let overlay_path: PathBuf = dir.path().join("custom-rpcs3.json");
        std::fs::write(
            &overlay_path,
            r#"{
              "catalog_id": "rpcs3-windows-x64",
              "display_name": "RPCS3 Custom",
              "supported_platform_folder_names": ["ps3"],
              "operating_systems": ["WINDOWS"],
              "installable": false,
              "deprecated": true,
              "upstream": {
                "type": "github_release",
                "repo": "RPCS3/rpcs3-binaries-win",
                "asset_pattern": "rpcs3-.*-win64.*\\.7z",
                "manifest_version_from": "tag"
              },
              "install": {
                "archive_type": "7z",
                "strip_components": 0,
                "executable_relative_path": "rpcs3.exe",
                "preserve_paths": ["config/"]
              }
            }"#,
        )
        .expect("overlay json");

        let entries = load_catalog(dir.path().to_str());
        let rpcs3 = entries
            .iter()
            .find(|entry| entry.catalog_id == "rpcs3-windows-x64")
            .expect("rpcs3 entry");

        assert_eq!(rpcs3.display_name, "RPCS3 Custom");
        assert!(!rpcs3.installable);
        assert!(rpcs3.deprecated);
    }
}