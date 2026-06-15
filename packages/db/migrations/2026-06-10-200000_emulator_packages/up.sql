CREATE TABLE emulator_packages (
    id SERIAL PRIMARY KEY,
    package_slug TEXT NOT NULL,
    version TEXT NOT NULL,
    display_name TEXT NOT NULL,
    catalog_id TEXT,
    os INT NOT NULL,
    root_path TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    executable_rel TEXT NOT NULL,
    status INT NOT NULL DEFAULT 0,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    UNIQUE (package_slug, version)
);

CREATE TABLE emulator_package_files (
    id SERIAL PRIMARY KEY,
    package_id INT NOT NULL REFERENCES emulator_packages(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    byte_size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    file_modified_at TIMESTAMPTZ NOT NULL,
    optional BOOLEAN NOT NULL DEFAULT FALSE,
    is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    UNIQUE (package_id, relative_path)
);

ALTER TABLE local_emulator_configs
    ADD COLUMN IF NOT EXISTS linked_package_id INT REFERENCES emulator_packages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS managed_paths BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS user_data_paths_override TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS preserve_paths_override TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_emulator_package_files_package_id_is_deleted
    ON emulator_package_files (package_id, is_deleted);

CREATE INDEX idx_local_emulator_configs_linked_package_id
    ON local_emulator_configs (linked_package_id)
    WHERE linked_package_id IS NOT NULL;