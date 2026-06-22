# Fork Notice

This repository is an **unofficial, modified downstream fork** of
[Retrom](https://github.com/JMBeresford/retrom).

## Upstream attribution

Retrom was created by [JMBeresford](https://github.com/JMBeresford) and is
maintained by JMBeresford and the upstream Retrom contributors. All credit for
the original project — its design, architecture, and core functionality —
belongs to them.

- Original (upstream) repository: <https://github.com/JMBeresford/retrom>

## What this fork is

This is a modified downstream fork of Retrom. Substantial fork-specific
modifications began in 2026 and continue in this repository. The fork explores
an emulator-cloud, sync, media/metadata, launcher, and fullscreen/theater-mode
direction that may or may not align with upstream's plans.

## Major changed areas in this fork

At a high level, this fork adds or significantly changes the following areas
relative to upstream Retrom:

- **Managed emulator packages** — a built-in emulator catalog with
  install/update/delete and multi-OS install targets, plus install-on-play.
- **Emulator user-data sync** — syncing emulator saves, states, configuration,
  NAND, and firmware between client and server.
- **Game theme media** — user-managed theme music and video search, import,
  assignment, and local storage, with a multi-track soundtrack player.
- **Fullscreen / "Big Picture" / theater mode** — a controller-first fullscreen
  experience with a redesigned library, detail, and media-viewer UI, plus a game
  launch lifecycle and quit-to-library flow.
- **Steam integration** — Steam sign-in and metadata sync (playtime,
  screenshots, achievements).
- **Unified achievements** — a source-agnostic achievements display backed by
  Steam and RetroAchievements providers.
- **Custom game metadata** — user-added artwork, video, music, and related media
  for games.

For a more detailed and current feature list, see the [README](./README.md).

## License

This fork remains licensed under the **GNU General Public License v3.0
(GPL-3.0)**, the same license as upstream Retrom. See [LICENSE](./LICENSE) for
the full license text. Upstream Retrom is copyright &copy; JMBeresford and
contributors.

## No affiliation

This fork is **not affiliated with, endorsed by, or maintained by** the upstream
Retrom project or its maintainers. Please direct upstream bug reports and feature
requests to the
[upstream issue tracker](https://github.com/JMBeresford/retrom/issues), not to
this repository.
