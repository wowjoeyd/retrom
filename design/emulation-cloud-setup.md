# Emulation Cloud Setup Guide

This guide covers deploying and using **Emulator Package Sync** on a personal emulation cloud: ROMs and emulator packages on a NAS (or shared mount), Retrom server for indexing and catalog installs, and a Windows desktop client that caches emulator binaries locally before launch.

For architecture and API details, see [`emulation-cloud.md`](emulation-cloud.md).

---

## Overview

| Layer | Role |
|-------|------|
| **NAS / share** | Source of truth for ROM trees (`content_directories`) and emulator package trees (`emulator_package_directories`) |
| **Retrom server** | Indexes packages, serves files over REST, runs catalog install jobs, optional scheduled rescans |
| **Desktop client** | Installs ROMs to `installation_dir`, syncs emulator packages to `emulator_cache_dir`, launches from local cache |

Emulators are **never** executed directly from UNC/SMB paths. The client copies the full package tree to a local cache and updates `executable_path` after sync.

---

## Prerequisites

### Server

- Retrom server built from the `feat/emulation-cloud` branch (or your fork after merging it).
- PostgreSQL (embedded or external).
- Read/write mount to your emulator storage (SMB, NFS, or local path in Docker).
- Outbound HTTPS for catalog installs (GitHub releases, etc.).

### Desktop client (Windows)

- Retrom **desktop** client (Tauri), not the web-only client.
- Network access to the Retrom server gRPC/REST endpoints.
- Enough local disk for emulator caches (typically 0.5–2 GB for a few emulators).

### Library layout

- ROM platforms scanned under `content_directories` (run **Update Library** first).
- Platform folder **basenames** must match catalog entries (e.g. `ps3`, `switch`). Catalog matching is case-insensitive on the folder basename.

---

## Server configuration

Edit server config (`RETROM_CONFIG`, default `{data_dir}/config.json`) via **Settings → Server Configuration** or directly on disk.

### Minimal example (NAS mount)

```json
{
  "content_directories": [
    { "path": "/mnt/retrom/roms", "storage_type": "MULTI_FILE_GAME" }
  ],
  "emulator_package_directories": [
    { "path": "/mnt/retrom/emulators" }
  ],
  "emulator_packages": {
    "rescan_interval_hours": 24
  }
}
```

| Field | Purpose |
|-------|---------|
| `emulator_package_directories[].path` | Root(s) where package trees live. Default on-disk layout: `{root}/{packageSlug}/{version}/**` |
| `emulator_packages.rescan_interval_hours` | Automatic NAS rescan interval. `0` disables the scheduler. Default: `24` |
| `custom_catalog_dir` | Optional directory of extra catalog JSON overlays |

### On-disk package layout

After catalog install or manual placement:

```
/mnt/retrom/emulators/
  rpcs3/
    0.0.34-17089/
      retrom-emulator-package.json
      rpcs3.exe
      ...
```

### Server environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `RETROM_EMULATOR_PACKAGES_ENABLED` | enabled (`true`) | Set to `false` to disable `EmulatorPackageService`, REST `/rest/emulator-package-file`, and the rescan scheduler |

When disabled, existing `local_emulator_configs` with manual `executable_path` values are unchanged.

---

## Client configuration

Open **Settings → Client Configuration** on the desktop app.

| Setting | Purpose |
|---------|---------|
| **Installation directory** | Local ROM cache (`installation_dir/{gameId}/`) |
| **Emulator cache directory** | Local emulator package cache (default: `{app_data}/emulator-cache/`) |
| **Server hostname / port** | Must reach gRPC-web and REST on the Retrom server |

### Client environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `EMULATOR_PACKAGE_SYNC` | enabled | Set to `false` to skip emulator sync in Play flow and launcher managed-path guard |
| `VITE_RETROM_EMULATOR_PACKAGES_ENABLED` | enabled | Build-time flag; set to `false` to hide Catalog/Packages UI |
| `VITE_EMULATOR_PACKAGE_SYNC` | enabled | Build-time mirror of `EMULATOR_PACKAGE_SYNC` for the web bundle |
| `EMULATOR_USER_DATA_ENHANCED` | disabled | Enables advanced user-data helpers such as analyzer UI and app-start background push setting |
| `VITE_EMULATOR_USER_DATA_ENHANCED` | disabled | Build-time mirror for the desktop/web UI bundle |
| `EMULATOR_USER_DATA_MAX_WALK_FILES` | `20000` | Safety cap for one user-data push walk |
| `EMULATOR_USER_DATA_LARGE_WARNING_BYTES` | `26843545600` | Log warning threshold for very large emulator user-data trees |

---

## End-to-end workflow

### 1. Scan ROM library

**Library → Update Library** so platform rows exist (required for catalog install to link `supported_platforms`).

### 2. Configure emulator roots (server)

**Settings → Server Configuration → Emulator Roots**

- Add the NAS path (e.g. `/mnt/retrom/emulators`).
- Optional: ignore patterns, custom layout (`{root}`, `{packageSlug}`, `{version}`, `{os}`, `{file}`).

### 3. Install an emulator to the NAS (catalog)

**Manage Emulators → Catalog**

1. Pick an entry (RPCS3, PCSX2, DuckStation, Eden, Citron, Ryubing, …).
2. **Install to NAS** → choose target root, optional subpath, run **Test write access**, then **Install**.
3. Wait for the server job to finish (download, extract, manifest, index).

### 4. Link package to an emulator

**Manage Emulators → Packages**

- **Scan packages** if you added trees manually on the NAS.
- Use **Link emulator** on a package row, or enable **Managed by package sync** under **Local Paths**.

### 5. Play a game

1. Primary action is always **Play** (desktop).
2. If the ROM is not installed → install-on-play modal.
3. Before launch: cloud saves → save states → **emulator package sync** (toast with progress).
4. Launcher runs the cached executable.

Secondary **Install Game** is available in the game detail menu and fullscreen actions when the ROM is not installed.

### 5.1 User data sync

Managed emulators can also sync declared `user_data_paths` such as firmware,
keys, RAPs, and emulator-internal installed content. Curated catalog entries
ship good defaults; custom emulators can use path overrides in **Manage
Emulators → Local Paths**.

- **Push local to NAS** promotes this PC's declared user-data paths as the cloud
  source of truth.
- **Pull from NAS** resets local declared user data from the server index.
- Empty `user_data_paths` means automatic upstream push is skipped; explicit
  buttons remain available for configured paths.
- With `EMULATOR_USER_DATA_ENHANCED=true`, the analyzer suggests custom paths and
  the client can opt into low-frequency app-start background push.
- Directly launching an emulator outside Retrom is allowed, but upstream sync
  waits until the next Retrom Play, explicit Push, or enabled background sync.

For internal game installs, use Retrom Play on a raw package/media file. Curated
emulators that set `internal_install_supported` show a guide step to launch the
emulator and complete its own install flow. The resulting virtual filesystem
changes are captured by the next user-data push.

### 6. Updates

When a newer package version is indexed on the NAS:

- **Packages** tab shows **Update to latest** for linked emulators.
- Sync status badge may show **Out of date** until the pin is bumped and sync runs.

---

## Built-in catalog (Windows)

| Catalog ID | Emulator | Platform folder |
|------------|----------|-----------------|
| `rpcs3` | RPCS3 | `ps3` |
| `pcsx2` | PCSX2 | (see catalog entry) |
| `duckstation` | DuckStation | (see catalog entry) |
| `eden` | Eden | `switch` |
| `citron` | Citron | `switch` |
| `ryubing` | Ryubing | `switch` |

Catalog contains metadata and upstream URLs only; binaries are downloaded to **your** NAS on install.

---

## Docker example

See `docker/docker-compose.yml`. Mount emulator storage alongside ROM libs:

```yaml
volumes:
  - ${CONTENT_DIR1:-./mock_content/}:/lib1
  - ${EMULATOR_DIR:-./mock_emulators}:/emulators
```

Point `emulator_package_directories` in server config at `/emulators` inside the container.

Optional rollback:

```yaml
environment:
  RETROM_EMULATOR_PACKAGES_ENABLED: "false"
```

---

## NixOS example

See `nix/nixos/service.nix`. Example `services.retrom.settings`:

```nix
services.retrom.settings = {
  content_directories = [
    { path = "/var/lib/retrom/roms"; storage_type = "MULTI_FILE_GAME"; }
  ];
  emulator_package_directories = [
    { path = "/var/lib/retrom/emulators"; }
  ];
  emulator_packages = {
    rescan_interval_hours = 24;
  };
};
```

---

## Testing checklist

Use this list to verify the emulation cloud stack after setup.

### Server

- [ ] `emulator_package_directories` configured and writable from the server process
- [ ] **Manage Emulators → Catalog** loads (service registered)
- [ ] Catalog **Install to NAS** completes; job shows success in job UI
- [ ] **Packages → Scan packages** indexes installed trees
- [ ] `GET /rest/emulator-package-file/{id}` returns file bytes for an indexed file

### Client (desktop)

- [ ] **Settings → Client** shows emulator cache directory
- [ ] **Manage Emulators** shows Catalog and Packages tabs
- [ ] Linking a package sets **Managed by package sync** on Local Paths
- [ ] Play on an installed ROM shows emulator sync toast, then launches
- [ ] Play on a non-installed ROM opens install-on-play modal
- [ ] Package **Out of date** / **Update to latest** works when a newer NAS version exists

### Feature-flag rollback

- [ ] `RETROM_EMULATOR_PACKAGES_ENABLED=false` → Catalog/Packages tabs hidden; manual emulator paths still work
- [ ] `EMULATOR_PACKAGE_SYNC=false` → Play skips emulator sync; launcher does not require cache exe for managed paths
- [ ] `EMULATOR_USER_DATA_ENHANCED=false` → Analyzer/app-start user-data helpers are hidden; existing package sync and manual Push/Pull still work

---

## Troubleshooting

| Symptom | Things to check |
|---------|-----------------|
| Catalog/Packages tabs missing | Server flag off or `GetEmulatorCatalog` unavailable; check `RETROM_EMULATOR_PACKAGES_ENABLED` |
| Install to NAS write test fails | SMB mount read-only, permissions, or wrong path index in Emulator Roots |
| Catalog install: zero platforms linked | Run **Update Library**; platform folder basename must match catalog (e.g. `switch`) |
| Play: "Executable not in cache" | Use **Play** (not raw launcher); ensure `EMULATOR_PACKAGE_SYNC` is not `false` |
| Sync stuck / failed | Server reachable; REST file endpoint enabled; disk space in emulator cache dir |
| Scheduler not running | `RETROM_EMULATOR_PACKAGES_ENABLED=false`, or `rescan_interval_hours: 0` |
| Firmware/RAPs missing on another PC | Confirm the paths are in `user_data_paths` or local overrides, Push from the working PC, then Pull/Play on the other PC |
| Push takes too long | Check `sync_state.json`, lower path scope, or raise `EMULATOR_USER_DATA_MAX_WALK_FILES` after confirming the paths are correct |

---

## Development

Build and run from the repo root on the `feat/emulation-cloud` branch:

```bash
pnpm install
pnpm nx sync
```

**Web + server (development):**

```bash
pnpm nx dev retrom-client-web
```

**Desktop client (development):**

```bash
pnpm nx dev retrom-client
```

**Production desktop build:**

```bash
pnpm nx build retrom-client
```

**Typecheck client-web:**

```bash
pnpm nx run retrom-client-web:tsc:typecheck
```

Requires Node.js, pnpm, Rust, PostgreSQL, Perl, and `protoc` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

---

## Related documentation

- [Design document](emulation-cloud.md) — full architecture, schema, PR history
- [CONTRIBUTING.md](../CONTRIBUTING.md) — dev environment and monorepo commands
