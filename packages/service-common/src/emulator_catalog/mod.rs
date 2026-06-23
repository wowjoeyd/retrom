mod platform_resolve;

use retrom_codegen::retrom::{
    emulator::OperatingSystem, EmulatorCatalogDefaultProfile, EmulatorCatalogEntry,
    EmulatorCatalogInstall, EmulatorCatalogTarget, EmulatorCatalogUpstream,
};
use std::{collections::HashMap, path::Path};
use tracing::warn;

pub use platform_resolve::resolve_platform_ids_for_catalog_entry;

const BUILTIN_CATALOG: &[(&str, &str)] = &[
    ("ares", include_str!("entries/ares-windows-x64.json")),
    ("azahar", include_str!("entries/azahar-windows-x64.json")),
    ("bizhawk", include_str!("entries/bizhawk-windows-x64.json")),
    ("cemu", include_str!("entries/cemu-windows-x64.json")),
    ("rpcs3", include_str!("entries/rpcs3-windows-x64.json")),
    ("pcsx2", include_str!("entries/pcsx2-windows-x64.json")),
    (
        "duckstation",
        include_str!("entries/duckstation-windows-x64.json"),
    ),
    ("eden", include_str!("entries/eden-windows-x64.json")),
    ("citron", include_str!("entries/citron-windows-x64.json")),
    ("flycast", include_str!("entries/flycast-windows-x64.json")),
    ("melonds", include_str!("entries/melonds-windows-x64.json")),
    ("mesen", include_str!("entries/mesen-windows-x64.json")),
    ("mgba", include_str!("entries/mgba-windows-x64.json")),
    ("ppsspp", include_str!("entries/ppsspp-windows-x64.json")),
    ("rmg", include_str!("entries/rmg-windows-x64.json")),
    ("ryubing", include_str!("entries/ryubing-windows-x64.json")),
    ("snes9x", include_str!("entries/snes9x-windows-x64.json")),
    ("vita3k", include_str!("entries/vita3k-windows-x64.json")),
    ("xemu", include_str!("entries/xemu-windows-x64.json")),
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
    #[serde(default)]
    upstream: Option<CatalogUpstreamFile>,
    #[serde(default)]
    install: Option<CatalogInstallFile>,
    #[serde(default)]
    targets: Vec<CatalogTargetFile>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
struct CatalogTargetFile {
    operating_system: String,
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
    #[serde(default)]
    internal_install_supported: bool,
}

/// Detect the operating system the Retrom server is running on.
pub fn host_operating_system() -> OperatingSystem {
    #[cfg(target_os = "windows")]
    {
        return OperatingSystem::Windows;
    }
    #[cfg(target_os = "macos")]
    {
        return OperatingSystem::Macos;
    }
    #[cfg(target_os = "linux")]
    {
        return OperatingSystem::LinuxX8664;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        OperatingSystem::Windows
    }
}

pub fn load_catalog(custom_catalog_dir: Option<&str>) -> Vec<EmulatorCatalogEntry> {
    let host_os = host_operating_system();
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

    let mut merged: Vec<_> = entries
        .into_values()
        .map(|entry| enrich_catalog_entry(entry, host_os))
        .collect();
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

fn enrich_catalog_entry(
    mut entry: EmulatorCatalogEntry,
    host_os: OperatingSystem,
) -> EmulatorCatalogEntry {
    entry.recommended_operating_system = Some(recommend_target_os(&entry, host_os) as i32);
    entry
}

/// All OSes the entry can actually be installed for (i.e. for which a concrete
/// upstream + install target resolves). WASM is excluded — it is not a NAS
/// package. Order is stable: Windows, macOS, Linux.
pub fn available_install_oses(entry: &EmulatorCatalogEntry) -> Vec<OperatingSystem> {
    [
        OperatingSystem::Windows,
        OperatingSystem::Macos,
        OperatingSystem::LinuxX8664,
    ]
    .into_iter()
    .filter(|os| resolve_target_for_os(entry, *os).is_some())
    .collect()
}

/// Pick the best install target for the given host OS.
pub fn recommend_target_os(
    entry: &EmulatorCatalogEntry,
    host_os: OperatingSystem,
) -> OperatingSystem {
    if resolve_target_for_os(entry, host_os).is_some() {
        return host_os;
    }

    if let Some(first) = entry.targets.first() {
        return OperatingSystem::try_from(first.operating_system).unwrap_or(host_os);
    }

    entry
        .operating_systems
        .first()
        .and_then(|os| OperatingSystem::try_from(*os).ok())
        .unwrap_or(host_os)
}

/// Resolve per-OS upstream/install for a catalog entry.
pub fn resolve_target_for_os(
    entry: &EmulatorCatalogEntry,
    os: OperatingSystem,
) -> Option<ResolvedCatalogTarget<'_>> {
    let os_i32 = os as i32;

    if let Some(target) = entry
        .targets
        .iter()
        .find(|target| target.operating_system == os_i32)
    {
        return Some(ResolvedCatalogTarget {
            operating_system: os,
            upstream: target.upstream.as_ref()?,
            install: target.install.as_ref()?,
        });
    }

    if entry.operating_systems.contains(&os_i32) {
        return Some(ResolvedCatalogTarget {
            operating_system: os,
            upstream: entry.upstream.as_ref()?,
            install: entry.install.as_ref()?,
        });
    }

    None
}

pub struct ResolvedCatalogTarget<'a> {
    pub operating_system: OperatingSystem,
    pub upstream: &'a EmulatorCatalogUpstream,
    pub install: &'a EmulatorCatalogInstall,
}

/// Derive on-disk package slug from a catalog id (strips common OS suffixes).
pub fn package_slug_from_catalog_id(catalog_id: &str) -> String {
    const SUFFIXES: &[&str] = &[
        "-windows-x64",
        "-windows-arm64",
        "-linux-x86_64",
        "-linux-arm64",
        "-macos-x64",
        "-macos-arm64",
        "-macos-universal",
    ];

    for suffix in SUFFIXES {
        if let Some(stripped) = catalog_id.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }

    catalog_id.to_string()
}

impl From<CatalogEntryFile> for EmulatorCatalogEntry {
    fn from(file: CatalogEntryFile) -> Self {
        let targets: Vec<EmulatorCatalogTarget> = file
            .targets
            .into_iter()
            .filter_map(|target| {
                let os = parse_operating_system(&target.operating_system)?;
                Some(EmulatorCatalogTarget {
                    operating_system: os as i32,
                    upstream: Some(target.upstream.into()),
                    install: Some(target.install.into()),
                })
            })
            .collect();

        let operating_systems = if !targets.is_empty() {
            targets.iter().map(|t| t.operating_system).collect()
        } else {
            file.operating_systems
                .iter()
                .filter_map(|os| parse_operating_system(os).map(i32::from))
                .collect()
        };

        let (upstream, install) = if let Some(first) = targets.first() {
            (first.upstream.clone(), first.install.clone())
        } else {
            (file.upstream.map(Into::into), file.install.map(Into::into))
        };

        Self {
            catalog_id: file.catalog_id,
            display_name: file.display_name,
            description: file.description,
            supported_platform_folder_names: file.supported_platform_folder_names,
            operating_systems,
            installable: file.installable,
            deprecated: file.deprecated,
            legal_notice: file.legal_notice,
            default_profile: file.default_profile.map(Into::into),
            upstream,
            install,
            targets,
            recommended_operating_system: None,
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
            internal_install_supported: Some(install.internal_install_supported),
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
    use super::{
        host_operating_system, load_catalog, package_slug_from_catalog_id, recommend_target_os,
        resolve_target_for_os,
    };
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
        assert!(switch_entries.iter().any(|entry| entry.deprecated));
    }

    #[test]
    fn custom_catalog_overlay_replaces_builtin_entry() {
        let dir = tempfile::tempdir().expect("temp catalog dir");
        let overlay_path: PathBuf = dir.path().join("custom-rpcs3.json");
        std::fs::write(
            &overlay_path,
            r#"{
              "catalog_id": "rpcs3",
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
            .find(|entry| entry.catalog_id == "rpcs3")
            .expect("rpcs3 entry");

        assert_eq!(rpcs3.display_name, "RPCS3 Custom");
        assert!(!rpcs3.installable);
        assert!(rpcs3.deprecated);
    }

    #[test]
    fn resolves_multi_target_entry_for_host_os() {
        let entries = load_catalog(None);
        let pcsx2 = entries
            .iter()
            .find(|entry| entry.catalog_id == "pcsx2")
            .expect("pcsx2 entry");

        assert!(pcsx2.targets.len() >= 2);
        let host = host_operating_system();
        let recommended = recommend_target_os(pcsx2, host);
        assert_eq!(pcsx2.recommended_operating_system, Some(recommended as i32));
        assert!(resolve_target_for_os(pcsx2, recommended).is_some());
    }

    #[test]
    fn package_slug_strips_os_suffix() {
        assert_eq!(package_slug_from_catalog_id("pcsx2-windows-x64"), "pcsx2");
        assert_eq!(package_slug_from_catalog_id("eden"), "eden");
    }
}
