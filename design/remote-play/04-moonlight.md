# Remote Play — Moonlight client launch (Phase 4)

How the viewer (client) side launches Moonlight straight into the host's managed
Sunshine app. Verified against the current Moonlight Qt source (June 2026).
**Sanity-check before relying on the real `MoonlightClient`.**

> In `design/` (not `docs/`) because `docs/` is the wiki submodule — same as the
> earlier phases.

## Moonlight Qt CLI

Moonlight Qt ships a CLI with actions `list`, `pair`, `stream`, `quit`. We use
**`stream`**, which launches directly into a named app:

```
moonlight stream <host> "<App Name>"
```

From `app/cli/commandlineparser.cpp` (positional args, both **required**, in this
order):

```
parser.addPositionalArgument("stream", "Start stream");
parser.addPositionalArgument("host", "Host computer name, UUID, or IP address", "<host>");
parser.addPositionalArgument("app", "App to stream", "\"<app>\"");
```

- `<host>` — host name, UUID, or IP.
- `"<App Name>"` — the Sunshine app name. Ours is **`Retrom Remote Play`** (it has
  a space, so it must be a single quoted argv element — which is automatic when we
  pass it as one arg to the process spawner, no shell quoting needed).
- Optional flags exist (`--1080`, `--fps`, `--display-mode fullscreen`, …); v4
  passes none and lets Moonlight use its configured defaults. A later phase can
  thread quality settings.

## How we invoke it

- **Linux / Steam Deck (Flatpak):** Moonlight is `com.moonlight_stream.Moonlight`.
  Command: `flatpak run com.moonlight_stream.Moonlight stream <host> "Retrom Remote Play"`.
- **Other / configurable path:** a `moonlight` (or `moonlight.exe`) executable on
  `PATH` or at a configured path. Command:
  `<moonlight> stream <host> "Retrom Remote Play"`.

Detection / config (env, no hardcoded secrets, mirrors the Sunshine config):

- `RETROM_MOONLIGHT_FLATPAK=1` (or default true on Linux) → use the Flatpak id.
- `RETROM_MOONLIGHT_PATH` → explicit path to a Moonlight executable (overrides).
- `RETROM_REMOTE_PLAY_HOST` → the host name/IP passed to `stream` (v4 has one
  configured host — no picker; that's Phase 5).
- `RETROM_REMOTE_PLAY_HOST_ID` → the host's Retrom client id, for `CreateSession`.

**Assumption (v4):** Moonlight is already **installed and paired** with the host's
Sunshine (a one-time manual `moonlight pair <host>`). Auto-pairing is a later
phase. If Moonlight isn't found we surface a clear "Moonlight not found" error.

## Client flow `start_remote_play(game_id)` — ordering is critical

1. `CreateSession` (host = configured host id, client = this client, app =
   `Retrom Remote Play`) → session is **PENDING**.
2. Launch Moonlight into the app **immediately** — do NOT wait for `RUNNING`.
   Moonlight connects → Sunshine runs `retrom-host-agent` → the agent **claims**
   the pending session and launches the game → only THEN does the session reach
   `RUNNING`. Waiting for `RUNNING` first would deadlock (nothing reaches RUNNING
   until Moonlight connects).
3. On Moonlight exit, return Retrom to fullscreen and finalize.

## Reuse, not fork

The Moonlight process is spawned and its exit handled by the launcher's existing
external-process machinery (`Launcher::run_foregrounding_process`): spawn → mark
the game running → wait for exit → reclaim the OS foreground → mark stopped. This
is the same path that returns the user to Retrom fullscreen after a native game
exits, so launching Moonlight and returning on its exit shares that code rather
than reimplementing it.

## Errors (minimal but readable)

- **Moonlight not found** — neither the Flatpak app nor a configured/`PATH`
  executable resolves.
- **Host not reachable / not configured** — `RETROM_REMOTE_PLAY_HOST` /
  `RETROM_REMOTE_PLAY_HOST_ID` missing (Moonlight itself reports connection
  failures in its own window).
- **CreateSession failed** — the broker RPC errored.

## Sources

- Moonlight CLI overview: <https://github.com/moonlight-stream/moonlight-qt/tree/master/app/cli>
- `stream` positional args: <https://github.com/moonlight-stream/moonlight-qt/blob/master/app/cli/commandlineparser.cpp>
- Flatpak id: <https://flathub.org/apps/com.moonlight_stream.Moonlight>
