ALTER TABLE local_emulator_configs
    DROP COLUMN IF EXISTS user_data_paths_override,
    DROP COLUMN IF EXISTS preserve_paths_override;
