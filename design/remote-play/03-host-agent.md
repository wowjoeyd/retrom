# Remote Play — Host agent `run-pending-session` (Phase 3)

How a Sunshine-launched command drives the already-running Retrom client to start
the brokered game, reusing the existing launcher. **Stated approach first, per the
phase brief.**

> In `design/` (not `docs/`) because `docs/` is the wiki submodule — same as the
> earlier phases.

## Does the client run single-instance? Yes.

`packages/client/src/main.rs` registers **`tauri-plugin-single-instance`**
(`main.rs:129`). When a second copy of the client launches, the plugin forwards
that invocation's `argv`/`cwd` to the **already-running** instance (via its
callback) and the second process exits. There is **no** deep-link/`onOpenUrl`
plugin. So single-instance is the cleanest existing signaling channel — no new
IPC, no new plugin, and no second heavy client left running.

## Chosen approach

**Signal the running client via single-instance; do the work in-process.**

1. **`retrom-host-agent` is a thin binary** (a second `[[bin]]` in the client
   crate). Sunshine runs `retrom-host-agent run-pending-session`. The agent does
   essentially nothing itself: it locates the installed Retrom client executable
   (next to its own exe) and spawns it with a `run-pending-session` argument, then
   exits. It never launches a game and never talks to the server.

2. **The launched client copy is intercepted by single-instance:** its `argv`
   (containing `run-pending-session`) is forwarded to the running client and the
   copy exits immediately. So no second client stays alive.

3. **The running client runs the flow in-process.** The single-instance callback
   detects the `run-pending-session` arg and spawns the host-agent flow, which has
   full access to the existing `LaunchAdapter dispatch()`, the gRPC service
   client, and config. This is the key reuse: the host does not reimplement
   launching — it drives the same `dispatch()` the Play button uses.

Why not a separate long-lived agent process: it could not reach the running app's
`AppHandle`/plugin state (launcher, service client, config), so it would have to
reimplement launching — exactly what we must not do. Personal Host Mode means the
client is already running in the user's session, so forwarding to it is correct.

## The flow (`run_pending_session`, in the launcher plugin)

Lives in `plugins/retrom-plugin-launcher` because that crate owns `dispatch()` and
the play lifecycle. Structured around two mockable boundaries so the logic is
unit-testable without a real game or server:

- `SessionBroker` — wraps the two RemotePlay RPCs (`GetPendingSessionForHost`,
  `UpdateSessionState`). Production impl uses the new `get_remote_play_client`.
- `SessionLaunch` — wraps "is this game a stream target?" and "launch it for this
  session". Production impl resolves the game's default emulator/profile/file via
  the existing service RPCs and calls `dispatch()`.

Orchestration (generic over those traits, so tests inject mocks):

1. `GetPendingSessionForHost(client_id)` → if `None`, stop (nothing to do).
2. If the game is **not a stream target** (wasm/EmulatorJS-only — see below),
   `UpdateSessionState(FAILED)` with a clear error and stop. Never launch
   in-webview for a remote session.
3. `UpdateSessionState(PREPARING)`.
4. Launch via the existing `dispatch()`, threading the session id (below). If the
   launch can't start, `UpdateSessionState(FAILED)`.
5. `PREPARING → RUNNING` is reported from inside the adapter once the game process
   is actually up (after `mark_game_as_running`), because `dispatch()` for native
   games blocks until exit.

`is_stream_target(emulator)` is the same condition the `WasmAdapter` matches on
(`libretro_name` set + `OperatingSystem::Wasm`), negated: a wasm-only core has no
host OS window for Sunshine to capture, so it is rejected, not launched.

## Session-aware exit (do not touch the local path)

The normal lifecycle ends by foregrounding the host's own Retrom UI
(`Launcher::foreground_main_window`, called from the native/steam adapters). For a
remote-play launch we must NOT foreground the host UI — the host is headless to
the player; instead we end the session.

- Thread `remote_play_session_id: Option<i32>` through `LaunchContext` (internal,
  no proto change). The normal play path leaves it `None`; the host-agent flow
  sets it.
- A pure decision keyed on it:
  `exit_action(Option<session_id>) -> { ForegroundLocalUi, EndSession(id) }`.
  `None` ⇒ `ForegroundLocalUi` (today's behavior, untouched). `Some(id)` ⇒
  `EndSession(id)`: skip foregrounding and `UpdateSessionState(RUNNING→ENDED)`.
- This is a single, well-isolated branch at the existing teardown site; the
  local-play return path is unchanged.

## Tests (no real game/server)

- `is_stream_target` — true for a native emulator, false for a wasm-only core.
- `exit_action` — `None ⇒ ForegroundLocalUi`, `Some(id) ⇒ EndSession(id)`.
- `run_pending_session` orchestration with a mock `SessionBroker` + mock
  `SessionLaunch`: no pending ⇒ no state change; wasm-only ⇒ `FAILED`, never
  launched; native ⇒ `PREPARING` then launched; launch error ⇒ `FAILED`.

## Touch list

- `retrom-plugin-service-client`: add `get_remote_play_client`.
- `retrom-plugin-launcher`: new `remote_play` module (flow + traits + pure
  decisions + tests); thread `remote_play_session_id` through `LaunchContext`;
  branch the native (and steam) teardown via `exit_action`; report `RUNNING`.
- `packages/client`: detect `run-pending-session` (single-instance + first-run
  argv) and spawn the flow; add the `retrom-host-agent` `[[bin]]`.
- `retrom-plugin-remote-play`: point the managed Sunshine app's `cmd` at the real
  `retrom-host-agent run-pending-session`.
