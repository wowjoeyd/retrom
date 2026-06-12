ALTER TABLE local_emulator_configs
    ADD COLUMN IF NOT EXISTS user_data_paths_override TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS preserve_paths_override TEXT[] NOT NULL DEFAULT '{}';
