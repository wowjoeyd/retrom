use retrom_codegen::retrom::Platform;
use std::path::Path;

/// Match catalog folder names to platform rows; return platform IDs for
/// `Emulator.supported_platforms`. Does not embed IDs in catalog JSON.
pub fn resolve_platform_ids_for_catalog_entry(
    folder_names: &[String],
    platforms: &[Platform],
) -> Vec<i32> {
    folder_names
        .iter()
        .filter_map(|name| {
            let name_lower = name.to_lowercase();
            platforms.iter().find(|platform| {
                Path::new(&platform.path)
                    .file_name()
                    .and_then(|segment| segment.to_str())
                    .map(|segment| segment.to_lowercase() == name_lower)
                    .unwrap_or(false)
            })
        })
        .map(|platform| platform.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::resolve_platform_ids_for_catalog_entry;
    use retrom_codegen::retrom::Platform;

    fn platform_with_path(id: i32, path: &std::path::Path) -> Platform {
        Platform {
            id,
            path: path
                .canonicalize()
                .expect("platform path should exist")
                .to_string_lossy()
                .to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn matches_platform_folder_basenames_case_insensitively() {
        let library = tempfile::tempdir().expect("temp library dir");
        let ps3_dir = library.path().join("ps3");
        let switch_dir = library.path().join("switch");
        std::fs::create_dir_all(&ps3_dir).expect("ps3 dir");
        std::fs::create_dir_all(&switch_dir).expect("switch dir");

        let platforms = vec![
            platform_with_path(10, &ps3_dir),
            platform_with_path(20, &switch_dir),
        ];

        let resolved =
            resolve_platform_ids_for_catalog_entry(&["PS3".into(), "switch".into()], &platforms);

        assert_eq!(resolved, vec![10, 20]);
    }

    #[test]
    fn skips_unmatched_folder_names() {
        let library = tempfile::tempdir().expect("temp library dir");
        let ps3_dir = library.path().join("ps3");
        std::fs::create_dir_all(&ps3_dir).expect("ps3 dir");

        let platforms = vec![platform_with_path(10, &ps3_dir)];

        let resolved = resolve_platform_ids_for_catalog_entry(
            &["ps3".into(), "PlayStation 3".into()],
            &platforms,
        );

        assert_eq!(resolved, vec![10]);
    }
}
