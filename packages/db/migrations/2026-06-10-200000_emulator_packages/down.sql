DROP INDEX IF EXISTS idx_local_emulator_configs_linked_package_id;
DROP INDEX IF EXISTS idx_emulator_package_files_package_id_is_deleted;

ALTER TABLE local_emulator_configs
    DROP COLUMN IF EXISTS managed_paths,
    DROP COLUMN IF EXISTS linked_package_id;

DROP TABLE IF EXISTS emulator_package_files;
DROP TABLE IF EXISTS emulator_packages;