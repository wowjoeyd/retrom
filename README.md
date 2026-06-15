<div align='center'>
  
  ![Banner][banner-link]
  
### A centralized game library/collection management service with a focus on emulation. Configure once, play anywhere

---

> **⚠️ Experimental Downstream Fork**
>
> This is an **unofficial, experimental fork** of [Retrom](https://github.com/JMBeresford/retrom) by [JMBeresford](https://github.com/JMBeresford).
> It is **not affiliated with or endorsed by the upstream maintainer.**
> The goal of this fork is to explore emulator-cloud, sync, media, metadata, launcher, and fullscreen/theater-mode ideas that may or may not align with upstream's direction.
>
> For the original project, visit → **[github.com/JMBeresford/retrom](https://github.com/JMBeresford/retrom)**

</div>

<h2>Table of Contents</h2>

<!--toc:start-->

- [Fork Status](#fork-status)
- [Relationship to Upstream](#relationship-to-upstream)
- [Overview](#overview)
- [Core Features (Upstream)](#core-features-upstream)
- [Current Additions (This Fork)](#current-additions-this-fork)
- [Where This Fork Is Going](#where-this-fork-is-going)
- [User-Managed Theme Media / yt-dlp](#user-managed-theme-media--yt-dlp)
- [Screenshots](#screenshots)
- [Upstream Resources](#upstream-resources)
- [Development Notes](#development-notes)
- [License](#license)

<!--toc:end-->

---

## Fork Status

This fork is **experimental and actively evolving.** It is not a stable product release, and it may diverge significantly from upstream Retrom over time.

- Features added here are exploratory — they may change, be redesigned, or be removed.
- This fork is not intended as a replacement for upstream Retrom.
- No fixed release schedule or product roadmap commitment exists here.
- Use at your own risk; things may break between updates.

If you are looking for a stable, well-supported experience, use the [upstream Retrom project](https://github.com/JMBeresford/retrom).

---

## Relationship to Upstream

This fork is based on [Retrom](https://github.com/JMBeresford/retrom), an excellent self-hosted game library management service. The upstream project is the original and authoritative version. This fork exists to pursue an additional, feature-heavy emulator-cloud direction without making assumptions about what upstream wants to accept.

- Upstream Retrom remains the original project and is not responsible for changes made here.
- Some changes developed in this fork may eventually be proposed upstream as pull requests, if they become stable and align with upstream's direction. Until then, they should be treated as experimental and fork-specific.
- Credit and appreciation go to [JMBeresford](https://github.com/JMBeresford) and all upstream contributors.

---

## Overview

Retrom is a centralized game library management service that allows you to host your games on a single device, and connect
clients on any amount of other devices to (un)install/download and play them when and where you want to. Think of it as a
sort of _self-hosted Steam_ for your DRM-free game library.

This fork builds on that foundation with an additional focus on emulator-cloud sync, media/theme management, and fullscreen/theater-mode workflows.

---

## Core Features (Upstream)

These features come from the upstream Retrom project:

- Host your own cloud game library service
- Scan your filesystem for games/platforms and automatically add them to your library
- Install/uninstall and play games from the service on any amount of desktop clients
  - **Support for Windows, MacOS, and Linux**
- Access your library from anywhere with the web client
- Unify your emulation library with third-party libraries (Steam, GoG, native PC/Linux/Mac)
- Manage emulator profiles on a per-client basis, stored on the server for easy sharing between devices
- Launch all your games across any amount of emulators or platforms via pre-configured profiles
- Automatically download game metadata and artwork from supported providers

---

## Current Additions (This Fork)

The following features have been added in this fork and do not exist in upstream Retrom:

- **Managed emulator package catalog** — browse a built-in catalog of emulators, install/update/delete packages directly from the server, with support for multi-OS install targets and custom catalog overlays
- **Emulator install-on-play** — automatically prompt to install or link a managed emulator package before launching a game when no suitable profile is available
- **Emulator user-data sync** — sync emulator saves, states, configuration, NAND, and firmware between client and server, with semantic path inference, preserve-path overrides, per-emulator startup auto-sync, and conflict-resolution UI
- **User-managed game theme music** — search for, import, assign, and locally store theme music per game; play back in fullscreen/theater mode with batch and missing-music workflows
- **Steam sign-in and metadata sync** — sign into a Steam account, resolve vanity URLs, and sync Steam metadata (playtime, screenshots, achievements) into the library
- **Game theme playback in fullscreen/theater mode** — themes play automatically when browsing games in fullscreen
- **Game theme playback in a dedicated theme tab** — themes are accessible in the standard client UI through a theme tab
- **User-added custom game metadata** — users can attach custom artwork, videos, music, and related media to games
- **Improved fullscreen music and input handling** — fullscreen grid and game page music controls, improved controller and touch input robustness
- **General bug fixes** — various bugs discovered during active daily use have been corrected

---

## Where This Fork Is Going

The following describes areas currently being explored or likely future work in this fork. **This is not a roadmap or a commitment** — priorities may shift, features may be redesigned, and this list will change as the fork evolves.

- **Theater/fullscreen mode redesign** — deeper fullscreen/theater behavior: emulator launches that preserve windowing state, richer now-playing overlays, and more fullscreen-native navigation
- **Achievement tracking / library features** — tracking achievements for non-Steam games
- **Native client-side ROM adding** — adding ROMs directly from the client, including automatic server folder creation and moving game data into place
- **Additional emulator-cloud, metadata, media, launcher, sync, and library-management features** — as they become useful during active use

This may change substantially as the fork evolves.

---

## User-Managed Theme Media / yt-dlp

This fork supports user-managed game theme media: searching for, importing, assigning, and locally storing theme music and video for individual games. The client provides search workflows backed by [yt-dlp](https://github.com/yt-dlp/yt-dlp) for locating and downloading theme audio and video from supported sources.

**Users are solely responsible for how they use this feature.** This includes:

- Respecting the terms of service of any platform or service you download from
- Complying with applicable copyright law and the rights of content owners
- Obtaining any necessary permissions from rights holders before downloading or using media

This feature is intended for use with **user-authorized media, personal media, public-domain content, Creative Commons-licensed content, or other sources where you have appropriate permission.** The presence of this feature in the software does not constitute legal advice or a claim that any particular use is permitted.

---

## Screenshots

Screenshots below are from the upstream Retrom project and reflect the base UI. This fork's additions (theme playback, sync UI, custom metadata, etc.) are not yet separately documented.

### Home Screen

<div align='center'>
  <img src="https://github.com/user-attachments/assets/bb7015d1-823a-4247-8c7c-b0e6e0450018" />
  <span>
    <img width='49%' src="https://github.com/user-attachments/assets/653ef3fa-94d4-42cb-a319-d53673893601" />
    <img width='49%' src="https://github.com/user-attachments/assets/d7afce18-e2b2-47fa-bd0d-0d89b30fff8a" />
  </span>
  <span>
    <img width='49%' src="https://github.com/user-attachments/assets/9acd572a-7c56-479b-a359-84c4167009d3" />
    <img width='49%' src="https://github.com/user-attachments/assets/bf7d59bc-008f-4d36-9b63-dd20f67b18fa" />
  </span>
</div>

### Game Details

<div align='center'>
  <img src="https://github.com/user-attachments/assets/1518d684-e40e-4927-9065-cbe05f96c7c9" />
  <span>
    <img width="49%" src="https://github.com/user-attachments/assets/0330afa4-0798-4582-a334-70e9a0acf689" />
    <img width="49%" src="https://github.com/user-attachments/assets/19d8cf30-9eaf-4d69-a012-85837b58e1c2" />
  </span>
  <span>
    <img width="49%" src="https://github.com/user-attachments/assets/6d397e90-8868-4e7d-b677-cccdb9923768" />
    <img width="49%" src="https://github.com/user-attachments/assets/14582db8-cd18-4f3b-ad76-4ccfb23b2d3c" />
  </span>
</div>

### In Game

<div align='center'>
  <img src="https://github.com/user-attachments/assets/a19be565-098e-4335-b67b-ec2c87051e6e" />
  <span>
    <img width="49%" src="https://github.com/user-attachments/assets/d3ffa9b2-420b-4677-b930-dd7a1c0f272c" />
    <img width="49%" src="https://github.com/user-attachments/assets/0c47e301-af72-492b-b753-7b4d034a9f72" />
  </span>
  <span>
    <img width="49%" src="https://github.com/user-attachments/assets/9e254ea3-9ccb-453c-819c-49c26d40a57b" />
    <img width="49%" src="https://github.com/user-attachments/assets/a0b7f048-0206-47c5-8126-b7b03ffba896" />
  </span>
</div>

---

## Upstream Resources

The following links point to the **upstream Retrom project** by JMBeresford, not this fork:

- [Quick Start Guide (upstream)](https://github.com/JMBeresford/retrom/wiki/Quick-Start)
- [Full Wiki (upstream)](https://github.com/JMBeresford/retrom/wiki)
- [Download Latest Client (upstream)](https://github.com/JMBeresford/retrom/releases/latest)
- [Upstream Roadmap](https://github.com/users/JMBeresford/projects/7)
- [Discord Server](https://discord.gg/r6KNHPkKS4) (upstream community)

This fork does not have its own separate documentation site or release binaries at this time.

---

## Development Notes

**Issues and pull requests related to this fork's direction are welcome.**

If you encounter a bug or want to contribute a feature that fits the exploratory direction described above, feel free to open an issue or PR in this repository.

**For issues in upstream Retrom** (features or bugs unrelated to this fork's additions), please report them at the [upstream issue tracker](https://github.com/JMBeresford/retrom/issues) rather than here.

This fork is not yet seeking broad adoption or a contributor community — it is primarily an experimental personal development branch. That may change as things stabilize.

---

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**, the same license as the upstream Retrom project.

See [LICENSE](./LICENSE) for the full license text.

Upstream Retrom is copyright © [JMBeresford](https://github.com/JMBeresford) and contributors.

---

[discord-badge]: https://invidget.switchblade.xyz/tM7VgWXCdZ
[discord-link]: https://discord.gg/r6KNHPkKS4
[banner-link]: https://github.com/user-attachments/assets/f4af6a79-ce07-4605-8876-5dd2a9f94ed0

<!--
GITHUB ABOUT / TOPICS (copy these manually into the repository's About section on GitHub)

Description:
Experimental downstream fork of Retrom — exploring emulator-cloud sync, game theme media, custom metadata, and fullscreen/theater-mode features. Not affiliated with or endorsed by the upstream project.

Topics:
retrom, emulation, emulator, game-library, self-hosted, cloud-sync, rom-manager, steam, metadata, media-management, yt-dlp, gplv3
-->
