# Retrom Plugin: Remote Play

Host-side integration for Retrom Remote Play. Phase 2 adds the Sunshine adapter
(`sunshine.rs`) behind the `SunshineClient` trait, with a real HTTP client and an
in-memory mock for tests, plus the `remote_play_host_readiness` command.

The server remains a session broker only — the actual stream is Sunshine (host)
→ Moonlight (client) directly. See `design/remote-play/` for the design notes and
`design/remote-play/02-sunshine.md` for the documented Sunshine API.
