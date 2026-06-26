# Remote Play — Flatpak build for Steam Deck (Phase 5 / dogfood)

The self-built AppImage white-screens on SteamOS (WebKitGTK `EGL_BAD_PARAMETER`)
because it bundles a graphics stack that doesn't match SteamOS. Flatpak fixes this
by using the GNOME runtime's WebKitGTK plus the host GPU drivers (`--device=dri`).

> In `design/` (not `docs/`) because `docs/` is the wiki submodule.

## 1. How upstream builds + publishes the Flatpak

Two pieces in this repo:

- **Manifest** `io.github.jmberesford.Retrom.yml` (repo root): GNOME Platform 49
  runtime + `org.gnome.Sdk` with the `rust-stable` and `node22` SDK extensions.
  It does **not** build from a working tree — it pulls **prebuilt artifacts** from
  a JMBeresford release tag:

  - the web client (`desktop-frontend-dist_*.tar.gz`),
  - vendored cargo deps (`cargo-vendor_*.tar.gz`),

  then builds fully **offline**: `cargo fetch --offline` against the vendored dir,
  `cargo install` the vendored tauri-cli, and
  `cargo tauri build --no-bundle --features flatpak` (offline, vendored sources).
  Finally it installs `target/release/Retrom`, the `.desktop`, `.metainfo.xml`, and
  icons into `/app`.

- **Workflow** `.github/workflows/publish-flatpak-manifest.yml` (manual / called on
  release): builds the web client and uploads its tarball to the release; vendors
  cargo deps and uploads that tarball; runs `pnpm nx template:flatpak` to fill the
  manifest's tag + tarball SHAs; then opens a PR against the Flathub repo
  `flathub/io.github.jmberesford.Retrom`. So upstream's Flatpak is **Flathub-published
  from release artifacts**, not built locally.

That offline/prebuilt design is great for Flathub reproducibility but awkward for
a fork dogfood (it needs artifacts uploaded to a release first). So for the fork we
use a second manifest that builds the branch from source in-sandbox.

## 2. The fork manifest

`io.github.wowjoeyd.RetromDevel.yml` (repo root). Same runtime/SDK/extensions
and finish-args, but:

- **Source** is the local clone's `feat-remote-play-integration` branch
  (`type: git, path: ., branch: …` → a clean checkout, no `node_modules`/`target`).
- **Builds from source in-sandbox** with network allowed
  (`build-options.build-args: [--share=network]`), so the SteamOS host needs no
  rust/node toolchain — the `rust-stable` + `node22` SDK extensions provide it:

  - `corepack pnpm install` → `corepack pnpm nx run retrom-client-web:build:desktop`
    (on-demand pnpm — no `corepack enable` shim into the read-only SDK; writes
    `packages/client-web/dist`),
  - `cargo build --release -p retrom-client --features "flatpak,custom-protocol"`.

  All tool caches/stores are pointed at the writable build dir (`/run/build/retrom`)
  via `build-options.env`, since the SDK prefix and `$HOME` are read-only.

  `custom-protocol` is required here because we call `cargo` directly rather than
  `cargo tauri build` (which would add it automatically); without it the app serves
  from the dev server and white-screens.

It uses a **distinct app id** (`io.github.wowjoeyd.RetromDevel`) with its own
`io.github.wowjoeyd.RetromDevel.desktop` / `.metainfo.xml` and icon ids, so it
installs **side-by-side** and never clobbers an installed upstream
`io.github.jmberesford.Retrom`. The binary is still `Retrom`; only the Flatpak /
desktop / metainfo / icon ids differ.

## 3. finish-args (what streaming needs)

| arg                                                        | why                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `--device=dri`                                             | host GPU for WebKitGTK — **the white-screen fix**                             |
| `--socket=wayland`, `--socket=fallback-x11`, `--share=ipc` | Retrom's own window                                                           |
| `--device=input`                                           | gamepad / Deck controls                                                       |
| `--socket=pulseaudio`                                      | local-play emulator audio                                                     |
| `--share=network`                                          | Retrom server + metadata + (host reachability)                                |
| `--filesystem=host-os`                                     | game library + host emulator executables                                      |
| `--talk-name=org.freedesktop.Flatpak`                      | `flatpak-spawn --host` to launch host emulators **and the Moonlight Flatpak** |

Note: the actual stream (video/audio/input decode) is handled by **Moonlight's own
Flatpak**, which runs as a separate host process with its own permissions — Retrom
only needs to _launch_ it. So Retrom's finish-args don't need video-decode perms.

## 4. Launching Moonlight from inside the sandbox (implemented)

A sandboxed Retrom can't run `flatpak run com.moonlight_stream.Moonlight ...` or
`flatpak info ...` directly — there's no `flatpak` binary in the sandbox, and you
can't `flatpak run` from within one. The fix is the Flatpak host portal: prefix
with **`flatpak-spawn --host`**, which `--talk-name=org.freedesktop.Flatpak`
(in the manifest) grants:

```
flatpak-spawn --host flatpak run com.moonlight_stream.Moonlight stream <host> "Retrom Remote Play"
flatpak-spawn --host flatpak info com.moonlight_stream.Moonlight
```

**This is now implemented**, mirroring how the launcher runs host emulators
(`flatpak-spawn --host` under `cfg!(feature = "flatpak")`,
`plugins/retrom-plugin-launcher/src/desktop.rs:331`):

- `retrom-plugin-remote-play` gained a `flatpak` feature, enabled by the client's
  existing `flatpak` feature (the one the build above uses).
- `moonlight.rs` has a spawn-site `host_command` helper that, **only under the
  `flatpak` feature**, wraps a command in `flatpak-spawn --host`. Both the Moonlight
  `launch_stream` command and the `is_available` `flatpak info` check go through it.
  `build_moonlight_command` still produces the logical command unchanged, so its
  existing unit tests are untouched; a new feature-gated test asserts the wrapped
  form (`flatpak-spawn --host flatpak run … stream … "Retrom Remote Play"`).
- `run_foregrounding_process` already waits on the spawned child, and
  `flatpak-spawn --host` forwards the host process's exit code, so return to Retrom
  fullscreen still works when Moonlight closes.

So Start Streaming launches the host Moonlight from inside the sandbox.

## 5. Build + install on the Steam Deck (Desktop Mode)

```bash
# One-time: flatpak-builder + Flathub remote (Flathub is preinstalled on SteamOS).
flatpak install -y flathub org.flatpak.Builder
flatpak install -y flathub com.moonlight_stream.Moonlight   # the viewer

# Pair Moonlight with your host's Sunshine ONCE (manual; auto-pairing is later):
flatpak run com.moonlight_stream.Moonlight        # add host, enter the PIN in Sunshine

# Get the fork branch:
git clone https://github.com/wowjoeyd/retrom
cd retrom
git checkout feat-remote-play-integration

# Build + install (user-level). --install-deps-from auto-pulls the runtime + SDK
# extensions; first build is SLOW on a Deck (full Rust workspace compile).
flatpak run org.flatpak.Builder --force-clean --user --install \
  --install-deps-from=flathub \
  build-dir io.github.wowjoeyd.RetromDevel.yml

# Run it:
flatpak run io.github.wowjoeyd.RetromDevel
```

### Or produce a redistributable bundle (.flatpak)

```bash
flatpak run org.flatpak.Builder --force-clean --user --install-deps-from=flathub \
  --repo=repo build-dir io.github.wowjoeyd.RetromDevel.yml
flatpak build-bundle repo io.github.wowjoeyd.RetromDevel.flatpak io.github.wowjoeyd.RetromDevel
flatpak install --user io.github.wowjoeyd.RetromDevel.flatpak
```

### Configure Remote Play (env, no hardcoded secrets)

The client reads these from the environment (Flatpak: set via
`flatpak override --user --env=…` or a wrapper):

```bash
flatpak override --user io.github.wowjoeyd.RetromDevel \
  --env=RETROM_REMOTE_PLAY_HOST=<host-ip-or-name> \
  --env=RETROM_REMOTE_PLAY_HOST_ID=<host client id> \
  --env=RETROM_MOONLIGHT_FLATPAK=1
```

## Notes / things to watch on first build

- Read-only sandbox: the SDK prefix (`/usr/lib/sdk`) and `$HOME` are read-only, so
  `build-options.env` points every cache/store/registry at the writable build dir
  (`/run/build/retrom/...`), and pnpm runs on-demand via `corepack pnpm` rather than
  `corepack enable` (which fails trying to symlink a shim into the SDK bin). If you
  rename the module from `retrom`, update those `/run/build/<name>` paths.
- Node version: `node22` SDK extension is Node 22, but the repo declares
  `engines: node>=24`. `engine-strict` is off (so it's only a warning, and we set
  `npm_config_engine_strict=false` to be sure); if a web step ever hard-requires
  Node 24, switch to a `node24` SDK extension.
- The cargo step uses `--features "flatpak,custom-protocol"`: `flatpak` matches what
  upstream builds; `custom-protocol` is the production/embedded-assets feature that
  `cargo-tauri` adds automatically (we call `cargo` directly, so we add it). It was
  validated to compile on this fork; `pq-sys`/`openssl-sys` build from source in the
  sandbox, same as upstream, so the GNOME SDK has the needed C toolchain.
- If `appstream` validation of the metainfo fails the build, drop the metainfo
  install line — it's not required to run.
