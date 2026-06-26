# Remote Play — Phase 0 Investigation

Status: investigation only, no feature code. This document maps the parts of the
Retrom codebase that the Remote Play feature will touch and proposes where the
new pieces should live. Every claim below is grounded in a real file; paths are
relative to the repo root.

## 0. Goal recap & non-negotiable invariants

Remote Play lets a user start a game on their **host PC** (where the library and
emulators live) and stream it to a **client** Retrom instance elsewhere, using
**Sunshine** on the host and **Moonlight** on the client for the actual A/V/input
transport.

Confirmed invariants for this work (restating the architecture rules so they live
next to the code, not just in chat):

- **The server is a session broker only.** It coordinates "who wants to play
  what, on which host" and hands each side the info it needs to connect. It
  **never** relays or proxies game video, audio, or input. The media stream goes
  **Sunshine (host) → Moonlight (client) directly**, peer-to-peer on the LAN.
- **v1 is "Personal Host Mode" only.** The stream runs inside the user's normal,
  already-logged-in Windows session. No dedicated streaming account, no
  auto-login, no session-switching.
- **No Wake-on-LAN yet.** The host must already be powered on and running Retrom.
- **EmulatorJS / WASM titles are NOT stream targets.** They run _in-webview_ on
  whatever machine the user is sitting at (see the WASM adapter below); there is
  no host-owned OS window to capture, so Sunshine has nothing to stream. Remote
  Play applies to native and Steam launches only.

---

## 1. Repo map (the areas Remote Play touches)

### 1.1 Tauri client app — `packages/client`

- Entry point: `packages/client/src/main.rs`. A thin binary: sets up tracing/logging
  and registers every Tauri plugin via `tauri::Builder` (`packages/client/src/main.rs:128-151`).
  Plugins are added in order; the launcher is `retrom_plugin_launcher::init().await`
  (`packages/client/src/main.rs:149`). **This is where a new `retrom-plugin-remote-play`
  would be registered.**
- Config files: `tauri.conf.json`, `tauri.dev.conf.json`, `tauri.local.conf.json`.
- Capabilities/permissions: `packages/client/capabilities/migrated.json`.

### 1.2 Web UI — `packages/client-web`

- The frontend is a TanStack-Router React app. The play button lives at
  `packages/client-web/src/components/action-button/play-game-button.tsx`.
- The launch flow: on click (`play-game-button.tsx:309-340`) it optionally runs
  pre-launch save/state/package sync (`:271-297`) then calls `playAction(args)`
  (`:305`), where `playAction` comes from `usePlayGame` →
  `packages/client-web/src/mutations/usePlayGame.ts`, which calls `playGame()` from
  the launcher plugin's JS binding.
- Other launcher-driven hooks: `mutations/useStopGame.ts`, `queries/usePlayStatus.ts`.
- **This is where a "Remote Play" affordance (e.g. an alternate action on the play
  button, or a host picker) would attach.** The existing `playGame` payload
  construction at `play-game-button.tsx:324-330` is the shape a remote launch
  would mirror.

### 1.3 Launcher plugin — `plugins/retrom-plugin-launcher` ← the core reuse target

- JS bindings: `plugins/retrom-plugin-launcher/guest-js/index.ts` exposes
  `playGame`, `stopGame`, `getGamePlayStatus`, `setQuitRebindActive`, each a
  `invoke("plugin:launcher|…")` wrapper around protobuf-encoded payloads.
- Plugin wiring: `plugins/retrom-plugin-launcher/src/lib.rs`. `init()` registers the
  `Launcher` state and the command handlers `play_game`, `stop_game`,
  `get_game_play_status`, `set_quit_rebind_active` (`lib.rs:58-63`).
- Commands: `plugins/retrom-plugin-launcher/src/commands.rs`. `play_game` decodes a
  `PlayGamePayload`, builds a `LaunchContext`, and calls `dispatch(ctx)`
  (`commands.rs:15-41`).
- **The `LaunchAdapter` trait + dispatch:** `plugins/retrom-plugin-launcher/src/launch/mod.rs`.
  - `LaunchContext<R>` (`mod.rs:28-35`) carries `app`, `game`, `emulator`,
    `profile`, `file`, `standalone`.
  - `trait LaunchAdapter<R>` (`mod.rs:37-47`): `name()`, `matches(&ctx) -> bool`,
    `async launch(ctx) -> Result<()>`.
  - `dispatch()` (`mod.rs:51-73`) iterates a fixed array `[SteamAdapter, WasmAdapter,
NativeAdapter]` and runs the first whose `matches()` is true. `NativeAdapter` is
    the catch-all (its `matches` is always `true`) and **must remain last**.
- Adapters:
  - `src/launch/native.rs` — spawns/monitors a native emulator child process.
  - `src/launch/steam.rs` — launches via `steam://`, watches Steam's registry keys
    for start/stop (Windows-only exit detection).
  - `src/launch/wasm.rs` — opens EmulatorJS in an embedded Tauri webview window
    (the in-webview path; **not** a stream target).
- Shared lifecycle state: `src/desktop.rs` — `Launcher<R>` holds
  `child_processes: RwLock<HashMap<GameId, GameProcess>>`, a `game_active` flag,
  and exposes `mark_game_as_running`, `mark_game_as_stopped`, `stop_game`,
  `is_game_running`, `foreground_main_window`. Playtime is reported on stop via the
  metadata service (`desktop.rs:220-239`).
- Windows-only support modules: `gamepad.rs`, `quit.rs`, `window.rs`, `foreground.rs`.

### 1.4 Save sync — `plugins/retrom-plugin-save-manager` & `plugins/retrom-plugin-emulator-sync`

- `retrom-plugin-save-manager` (`src/lib.rs`, `desktop.rs`, `snapshot.rs`): exposes
  `SaveManagerExt::save_manager()` and `SaveKind` (Saves / SaveStates). The native
  adapter calls `check_save_sync_status` + `upload_local_save_files` after a game
  exits (`launch/native.rs:222-283`).
- `retrom-plugin-emulator-sync` (`src/lib.rs`, `desktop.rs`, `sync_state.rs`):
  exposes `EmulatorSyncExt::emulator_sync()`; commands like `ensure_emulator_synced`,
  `push_emulator_preserve_data`, `pull_emulator_user_data`. The UI runs these as
  pre-launch sync (`play-game-button.tsx:271-275`).
- **Relevance to Remote Play:** saves live with the _emulator_, which runs on the
  **host**. Because the game runs host-side, host-side save sync already "just
  works" through the existing native-adapter teardown — the client doesn't need to
  sync saves for a remote session. Worth confirming, not re-implementing.

### 1.5 Client / device model — `packages/codegen/protos/retrom/models/clients.proto`

- Today the model is minimal (`clients.proto`): `Client { id, name, created_at,
updated_at }`, plus `NewClient` / `UpdatedClient`. There is **no** host/endpoint
  or "this client is streamable" concept yet.
- Backed by the `clients` table (Diesel model registered in
  `packages/codegen/build.rs:79` and the gRPC `ClientService`).
- **Relevance:** a Remote Play "host" is conceptually a `Client` that has
  announced it can host streams. v1 can keep this lightweight (see proposal); we do
  **not** need to overload the `Client` message immediately.

### 1.6 Proto + buf codegen pipeline — `packages/codegen`

Two generators run off the same `.proto` files under `packages/codegen/protos/`:

- **Rust** (build-time): `packages/codegen/build.rs` uses `tonic_prost_build` to
  compile _every_ `.proto` under `./protos` (`build.rs:50-56, 348-350`) into
  `OUT_DIR`, plus a file-descriptor set `retrom_descriptor.bin`. The generated code
  is surfaced through `packages/codegen/src/lib.rs` via `tonic::include_proto!`
  modules (`src/lib.rs:9-41`) and `descriptors::retrom::FILE_DESCRIPTOR_SET`
  (`src/lib.rs:47-52`). **This recompiles automatically on `cargo build`.**
  - `build.rs` also attaches Diesel derives to model messages via three tables
    `queryable_models` / `insertable_models` / `updatable_models`
    (`build.rs:58-240`) — so any proto message that maps to a DB row must be added
    to those lists here.
- **TypeScript**: `packages/codegen/buf.gen.yaml` runs `protoc-gen-es` into
  `packages/codegen/generated/…_pb.ts`. Invoked by the nx target `generate`
  (`packages/codegen/project.json`: `"command": "pnpm buf generate"`), i.e.
  `pnpm nx run retrom-codegen:generate`. `generated/` is gitignored.
- **Adding a message/service:** drop a `.proto` under `protos/retrom/{models,services}/`,
  then (a) Rust picks it up on next `cargo build`, but the new module must be
  exposed in `src/lib.rs` if it's in a new proto _package_; (b) run the TS `generate`
  target for the web bindings; (c) if it maps to a DB table, register it in
  `build.rs`'s model lists.

### 1.7 gRPC services — `packages/grpc-service` (server) + `packages/service` (binary)

- `packages/grpc-service/src/lib.rs` is where all services are constructed and added
  to the tonic router (`grpc_service()` at `lib.rs:77`; `routes_builder.add_service(…)`
  at `lib.rs:221-249`). Reflection + gRPC-web + CORS layers wrap the router
  (`lib.rs:251-268`).
- Each service is a module under `packages/grpc-service/src/` with a `…Handlers`
  struct implementing the generated `…Service` trait. The simplest end-to-end
  example to copy is **clients**: proto at
  `packages/codegen/protos/retrom/services/client-service.proto`, handler at
  `packages/grpc-service/src/clients/mod.rs` (`ClientServiceHandlers` implementing
  `ClientService`, `clients/mod.rs:21-170`), registered at `grpc-service/src/lib.rs:192-193, 243`.
- The runnable server is `packages/service` (`src/main.rs`, `src/lib.rs`).

### 1.8 Diesel migration pattern — `packages/db/migrations`

- Config: `packages/db/diesel.toml` — schema printed to `src/schema.rs`, patched by
  `src/schema.patch`; migrations dir is `migrations/`.
- Each migration is a timestamped dir `YYYY-MM-DD-HHMMSS_name/` with `up.sql` +
  `down.sql`. Newest examples:
  `2026-06-18-000000_add-theme-audio-title`,
  `2026-06-12-000000_add_emulator_config_overrides`. A representative pair is
  `2024-11-24-040401_third-party-games/{up,down}.sql` (adds columns + a reserved
  platform row).
- Migrations are embedded at compile time via `embed_migrations!()` in
  `packages/db/src/lib.rs:40` and applied through `run_migrations()`
  (`db/src/lib.rs:42-48`) on server startup.
- **Adding a migration:** create a new timestamped dir with `up.sql`/`down.sql`,
  then regenerate `src/schema.rs` (diesel `print_schema`, honoring `schema.patch`).
  New tables that back a proto model also need the Diesel derive registration in
  `packages/codegen/build.rs` (§1.6).

---

## 2. How a game is launched today (end to end)

Tracing one native launch from click to return-to-library:

1. **UI click.** `play-game-button.tsx` `onClick` (`:309`) → builds the payload
   `{ game, emulatorProfile, emulator, file }` and calls `playGame(...)`
   (`:324-330`), after optional pre-launch save/state/package sync (`:271-296`).
2. **JS → Rust.** `mutations/usePlayGame.ts` → `playGame()` in
   `plugins/retrom-plugin-launcher/guest-js/index.ts:32-41`, which protobuf-encodes a
   `PlayGamePayload` and `invoke("plugin:launcher|play_game", { payload })`.
3. **Command handler.** `plugins/retrom-plugin-launcher/src/commands.rs:15` `play_game`
   decodes the payload, reads `standalone` from config, assembles a `LaunchContext`,
   and calls `dispatch(ctx)` (`commands.rs:40`).
4. **Adapter dispatch.** `launch/mod.rs:51` `dispatch()` tries `SteamAdapter`,
   `WasmAdapter`, then `NativeAdapter`, picking the first whose `matches()` is true.
5. **Native launch** (`launch/native.rs:43`):
   - Verifies install status (`:68-81`), resolves the ROM file and the emulator
     executable (incl. managed-package cache check, `:155-166`).
   - Builds the command + args (custom args with `{file}`/`{install_dir}`
     substitution, `:168-196`) and `cmd.spawn()` (`:199`).
   - Registers the session: `launcher.mark_game_as_running(game_id, GameProcess{…})`
     (`:204-212`) — inserts into `child_processes`, sets `game_active`, emits
     `game-running`.
   - On Windows, foregrounds the new game window (`:217-220`).
   - **Waits** on `tokio::select!` between a stop signal (`recv`) and the child
     exiting (`process.wait()`) (`:286-315`). An explicit stop kills the whole
     captured process tree (`:298-310`).
   - **Teardown** (`:325-338`): reclaim the foreground for the main window
     (`foreground_main_window`), then `mark_game_as_stopped(game_id)` (clears
     `game_active`, emits `game-stopped`, reports playtime via the metadata RPC at
     `desktop.rs:220-239`), then sync saves last.
6. **Return to library.** `game-stopped` reaches the web UI; the main window is
   already foregrounded, so the player lands back in the library.

Steam and WASM differ only in _how_ they detect start/stop (Steam watches registry
keys, `launch/steam.rs:122`; WASM watches the webview window's `CloseRequested`,
`launch/wasm.rs:101-124`) — both funnel through the same
`mark_game_as_running` / `mark_game_as_stopped` lifecycle and the same
return-to-library behavior. **This shared lifecycle is exactly what the host agent
should reuse rather than reinvent.**

---

## 3. How the client talks to the server

- **Transport:** the desktop client speaks **gRPC-web** to the server. The
  `retrom-plugin-service-client` plugin owns the connection: `get_grpc_web_client()`
  and `get_service_host()` (`plugins/retrom-plugin-service-client/src/desktop.rs:28,60`),
  and the `RetromPluginServiceClientExt` trait exposes typed stubs —
  `get_metadata_client`, `get_game_client`, `get_emulator_client`,
  `get_platform_client`, `get_emulator_saves_client`, etc.
  (`plugins/retrom-plugin-service-client/src/lib.rs:33-42`). The launcher already
  uses these (e.g. `get_emulator_client` in `launch/native.rs:143`, the playtime
  client in `desktop.rs:230`).
- **Server side:** all services are assembled and routed in
  `packages/grpc-service/src/lib.rs:77-269`.
- **Web UI side:** TypeScript stubs are generated from the same protos into
  `packages/codegen/generated/retrom/services/*_pb.ts`.

### Adding a new gRPC service (the recipe Remote Play will follow)

1. Write `packages/codegen/protos/retrom/services/remote-play-service.proto`
   (service + request/response messages), importing any model protos it needs.
2. Build: `cargo build` regenerates the Rust stubs; run
   `pnpm nx run retrom-codegen:generate` for the TS stubs. If the proto introduces a
   new package path, expose it in `packages/codegen/src/lib.rs`.
3. Implement a `RemotePlayServiceHandlers` in
   `packages/grpc-service/src/remote_play/mod.rs` (mirror `clients/mod.rs`).
4. Register it in `packages/grpc-service/src/lib.rs` (`use` the generated
   `..._server::RemotePlayServiceServer`, construct it, `routes_builder.add_service(…)`).
5. On the client, add a `get_remote_play_client()` accessor to
   `retrom-plugin-service-client` mirroring the existing ones.

---

## 4. Concrete proposal for Remote Play

> Proposal only — no code in Phase 0. Kept deliberately minimal and broker-only.

### 4.1 New plugin: `plugins/retrom-plugin-remote-play`

Create a new Tauri plugin alongside the others, structured like the launcher
(`Cargo.toml`, `guest-js/index.ts`, `permissions/`, `src/{lib.rs, commands.rs,
desktop.rs, error.rs}`). It is registered once in `packages/client/src/main.rs`
next to `retrom_plugin_launcher::init()`. The **same plugin runs on both host and
client**; behavior is selected by role at runtime (a Retrom instance can be both).

It contains two cooperating halves:

- **Host side** (`src/host/…`):
  - A **Sunshine adapter** behind a trait (e.g. `StreamHost`) so Sunshine is one
    implementation and tests use a mock — keeping platform/tool specifics behind an
    adapter, per the architecture rules. Responsibilities: detect Sunshine, ensure
    it's running, and create/teardown the app/PIN pairing for a session. It does
    **not** move any media itself.
  - A **run-pending-session** loop: poll/subscribe to the broker (§4.3) for a
    session targeted at this host, then **launch the game by reusing the launcher**
    (§4.2). The game runs in the user's normal session (Personal Host Mode);
    Sunshine captures that window and streams it.
- **Client side** (`src/client/…`):
  - A **Moonlight adapter** behind a trait (e.g. `StreamClient`): locate/launch
    Moonlight pointed at the host + app the broker handed back. Mock in tests.
  - A JS binding `startRemotePlay({ gameId, hostId })` mirroring `playGame`, wired
    from the web UI (§1.2).

Platform note: Windows is the v1 target (matching the launcher's Windows-centric
exit detection and foregrounding). Keep non-Windows behind `#[cfg]` no-ops like the
existing plugins do.

### 4.2 Host agent reuses the launcher (does NOT re-implement launching)

The host agent must **not** spawn emulators or manage process lifecycle itself.
Instead it calls the existing launcher path so we inherit install checks, save
sync, playtime, foregrounding, and return-to-library for free:

- Build a `PlayGamePayload` (the exact shape the UI already builds at
  `play-game-button.tsx:324-330`) and drive the existing launcher — i.e. reuse
  `dispatch()` / the `LauncherExt` API rather than a parallel launch stack. This
  satisfies "reuse the existing `LaunchAdapter` dispatch; do not build a new
  launch-provider abstraction."
- Remote Play is therefore a thin **wrapper around** the launcher + a stream
  adapter, not a new launch mechanism. The launcher already knows how to start
  native and Steam titles and to tear them down; the host agent only adds "make
  sure Sunshine is streaming this session" around that call, and "tell the broker
  the session is live / ended."
- WASM/EmulatorJS is explicitly out of scope as a stream target (§0); the host
  agent should refuse/skip remote play for those (they have no host OS window).

### 4.3 Minimal `RemotePlaySession` data model + a SMALL state set

Keep v1 tiny. A session is brokered, not persisted as rich history.

Proposed message (new `remote-play-service.proto`):

```proto
message RemotePlaySession {
  string id = 1;            // broker-assigned session id
  int32 host_client_id = 2; // the Client acting as host
  int32 game_id = 3;        // game to launch on the host
  int32 viewer_client_id = 4; // the Client that will stream it
  RemotePlayState state = 5;
  google.protobuf.Timestamp created_at = 6;
  google.protobuf.Timestamp updated_at = 7;
}

enum RemotePlayState {
  REMOTE_PLAY_STATE_UNSPECIFIED = 0;
  PENDING   = 1; // requested; waiting for the host agent to pick it up
  STARTING  = 2; // host is launching the game + bringing up Sunshine
  STREAMING = 3; // game running, Moonlight connected
  ENDED     = 4; // game exited or stream torn down (terminal)
  FAILED    = 5; // could not start (no Sunshine/Moonlight, launch error) (terminal)
}
```

State transitions (small, linear, with two terminal states):

```
PENDING ─▶ STARTING ─▶ STREAMING ─▶ ENDED
   │           │            │
   └───────────┴────────────┴────────▶ FAILED
```

- The **server/broker** owns the `RemotePlaySession` record and the state field; it
  only ever _coordinates_ — it never sees a video frame.
- Whether the session row is persisted (a new `remote_play_sessions` table +
  migration per §1.8) or kept in-memory in the broker for v1 is an open decision
  for Phase 1; an ephemeral in-memory broker avoids a migration and matches
  "broker only." Persisting buys reconnection/history later. **Recommend
  in-memory for v1.**
- Host identity for v1 can reuse the existing `Client` (§1.5): a Retrom instance
  that has Sunshine and opts in registers as an available host. No `Client` schema
  change is strictly required for v1 if the broker tracks host capability in-memory.

---

## 5. Invariant confirmations (written)

- ✅ **Broker-only server.** No proposed component relays media. The server holds
  only the `RemotePlaySession` coordination record; Sunshine→Moonlight carry all
  A/V/input directly (§0, §4.3).
- ✅ **Personal Host Mode only.** The host agent launches into the user's existing
  logged-in session via the normal launcher path (§4.2). No dedicated account /
  auto-login (§0).
- ✅ **No Wake-on-LAN.** Host must be powered on and running Retrom; nothing in this
  plan wakes a machine (§0).
- ✅ **EmulatorJS/WASM are not stream targets.** They run in-webview
  (`launch/wasm.rs`); there is no host OS window for Sunshine to capture, so the
  host agent skips them (§0, §4.2).
- ✅ **Reuse, don't fork, the launcher.** Remote Play wraps the existing
  `LaunchAdapter` dispatch (`launch/mod.rs`) instead of introducing a new
  launch-provider abstraction (§4.2).

---

## 6. Suggested Phase 1 starting point

Smallest useful vertical slice: define the `remote-play-service.proto` (session +
state enum) and regenerate codegen, add an **in-memory** broker
`RemotePlayServiceHandlers` (create/get/update-state, mirroring `clients/mod.rs`)
registered in `grpc-service/src/lib.rs`, with unit tests on the state machine and
no host/client streaming code yet. That establishes the broker contract both halves
will build against, with zero risk to existing launch behavior.
