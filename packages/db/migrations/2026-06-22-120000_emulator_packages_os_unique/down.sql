ALTER TABLE emulator_packages
    DROP CONSTRAINT IF EXISTS emulator_packages_package_slug_version_os_key;

ALTER TABLE emulator_packages
    ADD CONSTRAINT emulator_packages_package_slug_version_key
    UNIQUE (package_slug, version);
