-- Package identity now includes the operating system, so a single emulator
-- version can have one stored build per OS (windows/macos/linux) side by side.
ALTER TABLE emulator_packages
    DROP CONSTRAINT IF EXISTS emulator_packages_package_slug_version_key;

ALTER TABLE emulator_packages
    ADD CONSTRAINT emulator_packages_package_slug_version_os_key
    UNIQUE (package_slug, version, os);
