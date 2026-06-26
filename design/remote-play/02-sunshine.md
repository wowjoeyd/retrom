# Remote Play — Sunshine local API (Phase 2, step 0)

Verified against the current Sunshine (LizardByte) docs and source (June 2026).
This is the host-side surface the `retrom-plugin-remote-play` Sunshine adapter
talks to. **Please sanity-check this before relying on the real `HttpSunshineClient`.**

> Placed under `design/remote-play/` (not `docs/remote-play/`) because `docs/` is
> the wiki git submodule and can't hold tracked files on this branch — same call
> we made in Phase 0.

## Endpoint, transport, auth

- **Base URL:** `https://localhost:47990/api` (default `PORT_HTTPS` = **47990**).
- **TLS:** HTTPS with a **self-signed** certificate. A localhost client must
  accept the self-signed cert (we use `reqwest` with
  `danger_accept_invalid_certs(true)`, scoped to the local Sunshine endpoint).
- **Auth:** HTTP **Basic auth** with the Sunshine web-UI **admin username +
  password**.
- **CSRF:** state-changing endpoints require a CSRF token _for browser requests_;
  non-browser clients (like ours) are exempt.

## App management endpoints

| Method & path              | Purpose                     | Notes                                                                                                                                                 |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/apps`            | List all apps               | Response includes an `apps` array of app objects                                                                                                      |
| `POST /api/apps`           | Create **or** update an app | The `index` field selects create vs. update: **`-1` creates** a new app; the app's **current index** (its position in `GET /api/apps`) **updates** it |
| `DELETE /api/apps/{index}` | Delete the app at `index`   |                                                                                                                                                       |
| `POST /api/apps/close`     | Close the running app       |                                                                                                                                                       |
| `POST /api/restart`        | Restart Sunshine            | Connection may drop as it restarts (expected)                                                                                                         |

### App object fields (POST /api/apps body)

`index`, `name`, `cmd`, `output`, `image-path`, `working-dir`,
`exclude-global-prep-cmd` (bool), `elevated` (bool), `auto-detach` (bool),
`wait-all` (bool). `index` is **`-1` to create** a new app or the app's
**current index to update** one (it is required, not omitted). Field names are
literal JSON keys (note the kebab-case ones like `image-path`).

We only need a tiny subset: `name` (to detect our managed app), `cmd` (the
host-agent invocation), and `index` (`-1` to create, or the managed app's
current index to update). On create/update we also set sensible booleans
(`auto-detach`, `wait-all`).

## Credentials: where they live, and why we don't read them from Sunshine

Sunshine stores the web-UI admin **username** and a **salted hash** of the
password in its state file (`sunshine_state.json`, overridable via the
`credentials_file` config key) — confirmed in `src/config.cpp` (a "Password
Salt" is part of the credential storage). The plaintext password is therefore
**not recoverable** from Sunshine's own files.

**Consequence:** Retrom cannot scrape the admin password from Sunshine. The host
must _give_ Retrom the credentials. For Phase 2 the `HttpSunshineClient` reads
them from a config value (environment variables, no hardcoding, nothing extra
stored):

- `RETROM_SUNSHINE_BASE_URL` (optional; default `https://localhost:47990`)
- `RETROM_SUNSHINE_USERNAME`
- `RETROM_SUNSHINE_PASSWORD`

If username/password aren't set, the client reports "not configured" and host
readiness comes back not-ready — we never guess or hardcode secrets. A later
phase can promote this to a typed Retrom config field; the env-var source is the
minimal, secret-safe choice for now.

## How Retrom uses this (the single managed app)

Retrom creates **exactly one** Sunshine app, **"Retrom Remote Play"**, whose
`cmd` is the host-agent invocation `retrom-host-agent run-pending-session`
(Phase 2 uses this as a **placeholder constant**; Phase 3 resolves the real
binary path). It is **never** a per-game app: the host agent reuses the existing
launcher to start whichever game the brokered session names, so one Sunshine app
covers all titles.

`ensure_retrom_app` is **idempotent**: it `GET /api/apps`, then either creates the
managed app (`POST` with `index: -1`) when it's missing, updates it in place
(`POST` with its current index) when its command is stale, or does nothing when
it's already correct. It never duplicates and never creates per-game apps. The
create-vs-update index choice is a shared default so the real client and the test
mock exercise identical logic.

## Trait surface (what the adapter exposes)

```
trait SunshineClient {
    async fn is_available(&self) -> bool;                          // reachable + authorized
    async fn list_apps(&self) -> Result<Vec<SunshineApp>>;         // GET /api/apps (index = position)
    async fn save_app(&self, app: &SunshineApp, index: i32) -> Result<()>; // POST /api/apps (-1 = create)
    async fn restart_if_needed(&self) -> Result<()>;               // POST /api/restart when a change was made
    // ensure_retrom_app(host_agent_cmd) is a shared DEFAULT method built on the
    // above: create (index -1) / update (current index) / no-op. Returns
    // EnsureOutcome { Created, Updated, AlreadyPresent }.
}
```

- `HttpSunshineClient` — the real implementation against the endpoints above.
- `MockSunshineClient` — in-memory test double; tests assert `ensure_retrom_app`
  creates exactly one app and is idempotent on a second call.

## Sources

- API reference — Sunshine docs: <https://docs.lizardbyte.dev/projects/sunshine/latest/md_docs_2api.html>
- API reference — source: <https://github.com/LizardByte/Sunshine/blob/master/docs/api.md>
- Credential storage — `src/config.cpp`: <https://github.com/LizardByte/Sunshine/blob/master/src/config.cpp>
