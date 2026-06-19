import { GameWithMetadata } from "@/components/game-list";
import { InterfaceConfig_GameListEntryImageJson } from "@retrom/codegen/retrom/client/client-config_pb";
import { getFileStub } from "@/lib/utils";
import { useConfig } from "@/providers/config";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  setFocus,
  getCurrentFocusKey,
} from "@noriginmedia/norigin-spatial-navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRetromClient } from "@/providers/retrom-client";
import { FocusContainer, useFocusable } from "../focus-container";
import { create } from "zustand";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { Group, useGroupContext } from "@/providers/fullscreen/group-context";
import { Separator } from "@retrom/ui/components/separator";
import { cn } from "@retrom/ui/lib/utils";
import { useGameMetadata } from "@/queries/useGameMetadata";
import { createUrl, usePublicUrl } from "@/utils/urls";
import { Skeleton } from "@retrom/ui/components/skeleton";
import { notifyCardFocus } from "../alphabet-scroll-overlay";
import { HotkeyIcon } from "../hotkey-button";

// =====================================================
// Global background music player for fullscreen game themes / soundtracks.
// Supports native audio (from yt-dlp extracted "theme.*" or direct audio in videoUrls)
// and YouTube (via iframe API) with robust fallback for webview autoplay / embed restrictions.
// Fades, state polling for webview issues, candidate fallback, gesture activation.
// =====================================================

type GameMusicSourceType = "youtube" | "audio";

type GameMusicStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "blocked"
  | "error"
  | "missing";

type GameMusicState = {
  visible: boolean;
  status: GameMusicStatus;
  title?: string;
  url?: string;
  sourceType?: GameMusicSourceType;
  message?: string;
  gameId?: number;
  updatedAt: number;
  setStatus: (
    state: Omit<Partial<GameMusicState>, "setStatus" | "hide">,
  ) => void;
  hide: () => void;
};

interface YTPlayer {
  playVideo(): void;
  stopVideo(): void;
  destroy(): void;
  pauseVideo(): void;
  unMute(): void;
  mute(): void;
  setVolume(volume: number): void;
  getVolume(): number;
  getPlayerState(): number;
}

declare global {
  interface Window {
    YT:
      | {
          Player: new (id: string | HTMLElement, opts: object) => YTPlayer;
          PlayerState: {
            UNSTARTED: number;
            BUFFERING: number;
            CUED: number;
            PLAYING: number;
            PAUSED: number;
            ENDED: number;
          };
        }
      | undefined;
    onYouTubeIframeAPIReady: (() => void) | undefined;
  }
}

const gameMusic = {
  player: null as YTPlayer | null,
  audio: null as HTMLMediaElement | null,
  sourceType: null as GameMusicSourceType | null,
  currentVideoId: null as string | null,
  fadeInterval: null as ReturnType<typeof setInterval> | null,
  outgoingFadeInterval: null as ReturnType<typeof setInterval> | null,
  loadingTimeout: null as ReturnType<typeof setTimeout> | null,
  stopTimeout: null as ReturnType<typeof setTimeout> | null,
  apiPromise: null as Promise<void> | null,
  activeStatus: null as {
    title?: string;
    url: string;
    sourceType: GameMusicSourceType;
    targetVolume: number;
    fadeMs: number;
  } | null,
  apiReady: false,
  // Poller gives us a reliable way to detect PLAYING (and nudge playback) even when
  // YT's postMessage event callbacks are blocked by tracking prevention / storage
  // restrictions inside Tauri WebView2 or strict COI dev servers.
  statePoller: null as ReturnType<typeof setInterval> | null,
  // Per-URL (per-ROM video) short term cache of outcome. Prevents re-creating players,
  // re-hitting YT, and 10s timers on every hover when the browser has already blocked
  // storage/autoplay for that embed. Fast graceful path to fallback UI.
  recentResults: new Map<
    string,
    { outcome: "playing" | "blocked" | "error"; ts: number }
  >(),
  // Support for multiple candidate videoUrls per game (soundtrack first, then other YT videos from metadata).
  // Allows automatic fallback when a video returns embed-restricted errors (101/150).
  lastCandidates: [] as readonly string[],
  currentCandidateIndex: 0,
  // Tracks which game "owns" the currently loaded/playing theme so that transitioning
  // from grid hover into the detail view (or back) for the exact same game continues
  // playback seamlessly even if the computed source URL string differs (e.g. the
  // bare magic `.../theme` vs the exact `.../theme.webm` from mediaPaths).
  currentGameId: null as number | null,
  // Web Audio graph for the live theme visualizer. The shared <audio> element is
  // routed source -> analyser -> destination so the soundtrack mini-player can
  // read real frequency data. createMediaElementSource may run at most once per
  // element, so the nodes are created lazily and cached. Routing through Web
  // Audio means we MUST connect to destination (else the theme goes silent), and
  // the element must be CORS-clean (crossOrigin set at creation) or the source
  // is "tainted" and outputs silence — see ensureAnalyser.
  audioContext: null as AudioContext | null,
  mediaSource: null as MediaElementAudioSourceNode | null,
  analyser: null as AnalyserNode | null,
  // True while the user has explicitly paused the theme from the mini-player, so
  // a same-game continuation (e.g. a re-fired detail effect) doesn't auto-resume.
  userPaused: false,

  ensureApi(): Promise<void> {
    if (this.apiReady && window.YT?.Player) {
      this.apiReady = true;
      return Promise.resolve();
    }

    if (this.apiPromise) {
      return this.apiPromise;
    }

    this.apiPromise = new Promise((resolve, reject) => {
      if (window.YT?.Player) {
        this.apiReady = true;
        resolve();
        return;
      }

      const previousReady = window.onYouTubeIframeAPIReady;
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        this.apiReady = true;
        resolve();
      };
      tag.onerror = () =>
        reject(new Error("Failed to load YouTube player API"));
      document.body.appendChild(tag);
    });

    return this.apiPromise;
  },

  _setStatus(state: Omit<Partial<GameMusicState>, "setStatus" | "hide">) {
    useGameMusicStatus.getState().setStatus(state);
  },

  _finishStatus(state: Omit<Partial<GameMusicState>, "setStatus" | "hide">) {
    this._stopStatePoller?.();
    if (this.loadingTimeout) {
      clearTimeout(this.loadingTimeout);
      this.loadingTimeout = null;
    }

    if (
      state.status === "playing" ||
      state.status === "blocked" ||
      state.status === "error"
    ) {
      if (state.url && state.status)
        this._recordOutcome(state.url, state.status);
    }

    // Stamp the owning game id onto every terminal status so the focused card's
    // audio tray can tell whether the currently playing/loaded theme is *its*
    // theme (vs. the previously focused card's, during the brief settle window).
    this._setStatus({ gameId: this.currentGameId ?? undefined, ...state });
  },

  _recordOutcome(url: string, status: GameMusicState["status"]) {
    this.recentResults.set(url, {
      outcome:
        status === "playing"
          ? "playing"
          : status === "error"
            ? "error"
            : "blocked",
      ts: Date.now(),
    });
    // also expose last for any debug consumers
    (gameMusicPlayer as unknown as Record<string, unknown>).lastResult = {
      url,
      status,
    };
  },

  _fadeTo(target: number, durationMs: number) {
    if (this.fadeInterval) clearInterval(this.fadeInterval);

    const p = this.player;
    const a = this.audio;
    if (!p && !a) return;

    const start = Date.now();
    const getVol = () => {
      if (this.sourceType === "youtube" && p?.getVolume)
        return p.getVolume() / 100;
      if (a) return a.volume;
      return 0;
    };
    const setVol = (v: number) => {
      const clamped = Math.max(0, Math.min(1, v));
      if (this.sourceType === "youtube" && p?.setVolume)
        p.setVolume(Math.round(clamped * 100));
      if (a) a.volume = clamped;
    };

    const startVol = getVol();

    this.fadeInterval = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const vol = startVol + (target - startVol) * t;
      setVol(vol);
      if (t >= 1) {
        if (this.fadeInterval) clearInterval(this.fadeInterval);
        this.fadeInterval = null;
      }
    }, 50);
  },

  _stopStatePoller() {
    if (this.statePoller) {
      clearInterval(this.statePoller);
      this.statePoller = null;
    }
  },

  _startStatePoller() {
    this._stopStatePoller();
    this.statePoller = setInterval(() => {
      try {
        const player = this.player;
        const active = this.activeStatus;
        if (!player || !active || active.sourceType !== "youtube") {
          this._stopStatePoller();
          return;
        }

        const state =
          typeof player.getPlayerState === "function"
            ? player.getPlayerState()
            : null;
        const YT = window.YT;
        const PlayerState = YT?.PlayerState;

        if (state === PlayerState?.PLAYING) {
          try {
            player.unMute?.();
            this._fadeTo(active.targetVolume, active.fadeMs);
            this._finishStatus({
              status: "playing",
              title: active.title,
              url: active.url,
              sourceType: "youtube",
            });
          } catch {}
          this._stopStatePoller();
        } else if (
          state === PlayerState?.BUFFERING ||
          state === PlayerState?.CUED ||
          state === PlayerState?.UNSTARTED
        ) {
          // Nudge in case the initial playVideo was ignored due to environment restrictions.
          if (typeof player.playVideo === "function") {
            try {
              player.playVideo();
            } catch {}
          }
        }
      } catch (e) {
        if (import.meta.env.DEV)
          console.debug("[gameMusic] statePoller error", e);
      }
    }, 280);
  },

  _clearAllFades() {
    if (this.fadeInterval) {
      clearInterval(this.fadeInterval);
      this.fadeInterval = null;
    }
    if (this.outgoingFadeInterval) {
      clearInterval(this.outgoingFadeInterval);
      this.outgoingFadeInterval = null;
    }
  },

  async playForGame(
    videoUrl: string | undefined,
    targetVolume: number,
    fadeMs: number,
    title?: string,
    candidates: readonly string[] = [],
    gameId?: number,
  ) {
    // Strong same-game continuation: if this call is for the exact same gameId that we are
    // currently tracking as playing (set by a prior hover or detail play for that game),
    // treat it as a continuation request. Do NOT run the hard reset, do NOT change .src,
    // do NOT call play() again, do NOT reset playback position. This ensures that
    // "hover game 21 (starts song) → click into detail for game 21" continues the
    // exact same audio element/loop without audible restart.
    // Only calls with a *different* gameId (or no gameId + different url) will switch.
    // This is placed *first* so it wins even if videoUrl is temporarily falsy during
    // query loading in the detail, or if sourceType was cleared, etc.
    if (gameId != null && this.currentGameId === gameId) {
      if (gameId != null) {
        this.currentGameId = gameId;
      }
      // Respect an explicit user pause: a re-fired continuation (e.g. the detail
      // effect re-running) must not silently resume playback the user stopped.
      if (this.userPaused) {
        if (videoUrl && this.activeStatus) {
          this.activeStatus = {
            ...this.activeStatus,
            title,
            targetVolume,
            fadeMs,
            url: videoUrl || this.activeStatus.url,
          };
        }
        return;
      }
      if (videoUrl && this.activeStatus) {
        this.activeStatus = {
          ...this.activeStatus,
          title,
          targetVolume,
          fadeMs,
          url: videoUrl || this.activeStatus.url,
        };
      } else if (videoUrl) {
        this.activeStatus = {
          title,
          url: videoUrl,
          sourceType: "audio",
          targetVolume,
          fadeMs,
        };
        this.sourceType = "audio";
      }
      const a = this.audio;
      if (a && this.sourceType === "audio" && videoUrl) {
        // Was this game's theme *genuinely* already playing (the real seamless-
        // continuation case: grid hover → detail, or re-focusing the same card)?
        // Capture it *before* touching play(), because audio.play() flips
        // `paused` to false synchronously even when the source 404s. Reading
        // `!paused` *after* play() is exactly what made a no-theme game (whose
        // magic theme URL 404s) falsely report "playing" when its card was
        // re-focused — e.g. after the context menu closed and restored focus to
        // that same card (currentGameId still === this game → continuation path).
        const wasPlaying = !a.paused && !a.error && a.readyState >= 2;
        this._fadeTo(targetVolume, Math.max(50, Math.min(fadeMs || 150, 150)));

        if (wasPlaying) {
          this._finishStatus({
            status: "playing",
            url: videoUrl,
            title,
            sourceType: "audio",
          });
        } else {
          // Paused / never-started / previously-errored: actually attempt the
          // resume and let the *real* outcome decide the status. A no-theme game
          // resolves to "missing" (404), never a phantom "playing". The status is
          // only written if this game still owns playback when the promise settles.
          //
          // Crucially, reload the element when the source URL actually changed
          // (e.g. a theme was just downloaded: the old magic/404 URL → the new
          // exact theme.opus). Without this the continuation path would resume
          // the stale (failed) src and the freshly downloaded track would never
          // play — and its duration would never populate.
          if (videoUrl && a.src !== videoUrl) {
            a.src = videoUrl;
            a.load();
          }
          void a
            .play()
            .then(() => {
              if (this.currentGameId !== gameId) return;
              this._fadeTo(
                targetVolume,
                Math.max(50, Math.min(fadeMs || 150, 150)),
              );
              this._finishStatus({
                status: "playing",
                url: videoUrl,
                title,
                sourceType: "audio",
              });
            })
            .catch((e: unknown) => {
              if (e instanceof Error && e.name === "AbortError") return;
              if (this.currentGameId !== gameId) return;
              const isMissing =
                (e instanceof Error && e.name === "NotSupportedError") ||
                a.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
              this._finishStatus({
                status: isMissing ? "missing" : "blocked",
                url: videoUrl,
                title,
                sourceType: "audio",
                message: String(e),
              });
            });
        }
      } else if (videoUrl) {
        // Non-audio (e.g. youtube) continuation keeps the prior optimistic report.
        this._finishStatus({
          status: this.sourceType ? "playing" : "blocked",
          url: videoUrl,
          title,
          sourceType: this.sourceType || "audio",
        });
      }
      return;
    }

    if (!videoUrl) {
      this._finishStatus({
        status: "blocked",
        url: "",
        title,
        sourceType: "audio",
      });
      return;
    }

    // Strict enforcement for the *music* (bg theme) player only: never allow YT/watch URLs here.
    // Local yt-dlp extracted theme.* (or audio files) via the mediaPaths + magic "theme" base
    // is the supported path (embeds are fragile under COI/tracking prevention in the webview).
    // The Videos tab and other embed paths are unaffected and continue to work.
    // (This guard was part of the prior switching/robustness fixes.)
    if (videoUrl && isYoutubeWatchUrl(videoUrl)) {
      this._finishStatus({
        status: "blocked",
        url: videoUrl,
        title,
        sourceType: "audio",
        message:
          "YouTube URLs are not used for game theme music (use Download Metadata for local theme.*)",
      });
      return;
    }

    // Check recent result cache for fast path (only short-circuit terminal failures)
    const recent = this.recentResults.get(videoUrl);
    if (recent && Date.now() - recent.ts < 15000) {
      if (recent.outcome === "blocked" || recent.outcome === "error") {
        const looksAudio = isAudioUrl(videoUrl) || videoUrl.includes("/theme");
        this._finishStatus({
          status: recent.outcome,
          url: videoUrl,
          title,
          sourceType: looksAudio ? "audio" : "youtube",
        });
        return;
      }
    }

    // Fallback same-URL continuation (for calls that don't pass gameId, or legacy paths).
    // The primary same-gameId logic is handled at the very top of the function.
    const isSameUrl = this.activeStatus?.url === videoUrl;
    if (isSameUrl && this.sourceType) {
      if (this.activeStatus) {
        this.activeStatus = {
          ...this.activeStatus,
          title,
          targetVolume,
          fadeMs,
          url: videoUrl || this.activeStatus.url,
        };
      }
      if (this.audio && this.sourceType === "audio") {
        this._fadeTo(targetVolume, Math.max(50, Math.min(fadeMs, 150)));
      } else if (this.player && this.sourceType === "youtube") {
        this._fadeTo(targetVolume, Math.max(50, Math.min(fadeMs, 150)));
      }
      this._finishStatus({
        status: "playing",
        url: videoUrl,
        title,
        sourceType: this.sourceType,
      });
      return;
    }

    // Real switch to a different game's theme (or first play after stop).
    // Now it is safe to abort prior work without disrupting an "in use" track.
    // On rapid hover/focus changes between games (or grid <-> detail), we must
    // synchronously abort any pending volume fades (the ones scheduled inside
    // stop() for "nice" tail-off) and any in-flight audio.load()/play() from a
    // previous game's theme. Otherwise the old outgoing fade's setInterval keeps
    // mutating .volume and eventually does .src = "" on the *shared* Audio
    // element, causing crackles, abrupt stops, and the new track never stabilizing.
    this._clearAllFades();

    // Hard reset the audio element (and pause any YT) to abort fetches/decodes/plays.
    // This must happen *before* we assign a new activeStatus or new src.
    try {
      if (this.audio) {
        this.audio.onerror = null;
        this.audio.oncanplay = null;
        this.audio.pause();
        this.audio.src = "";
        this.audio.load(); // aborts any pending network request for prior theme
      }
      if (this.player && typeof this.player.pauseVideo === "function") {
        this.player.pauseVideo();
      }
    } catch {}

    // Note: we intentionally do *not* call this.stop(fadeMs, ...) on the switch path.
    // stop() (with its fade) is reserved for terminal stops (music disabled, leaving
    // fullscreen area, etc.). Using it here for inter-game switches was the source of
    // the uncoordinated async fade clobbering the next play.

    if (gameId != null) {
      this.currentGameId = gameId;
    }
    // A real switch starts fresh playback, so any prior user-pause is cleared.
    this.userPaused = false;
    this.activeStatus = {
      title,
      url: videoUrl,
      sourceType: "audio",
      targetVolume,
      fadeMs,
    };
    this.lastCandidates = candidates.length ? candidates : [videoUrl];
    this.currentCandidateIndex = this.lastCandidates.indexOf(videoUrl);
    if (this.currentCandidateIndex < 0) this.currentCandidateIndex = 0;

    const isAudio =
      /\.(mp3|wav|ogg|opus|m4a|flac|webm|aac)$/i.test(
        videoUrl.split("?")[0] || videoUrl,
      ) || videoUrl.includes("theme"); // magic theme or direct audio

    if (isAudio) {
      this.sourceType = "audio";

      // (Re)use a single audio element for all game themes. We already hard-reset
      // above so prior game state/handlers/loads cannot interfere.
      if (!this.audio) {
        this.audio = new Audio();
        this.audio.loop = true;
        this.audio.preload = "auto";
        // CORS-clean the element so the Web Audio analyser (visualizer) can read
        // it without tainting/silencing it. The theme media is served with
        // permissive CORS, so anonymous mode loads fine. Set before any src so
        // the very first load is a clean CORS request.
        this.audio.crossOrigin = "anonymous";
      }
      this.audio.volume = 0;

      // Always use the provided videoUrl directly as the audio src.
      // - If the GetGameMetadata response included an exact themeAudioUrl (with .ext),
      //   we use that (preferred, no server lookup needed).
      // - If falling back to our constructed magic bare ".../media/games/{id}/theme",
      //   the server public handler (see public.rs) will on-demand call
      //   find_theme_audio_file for the game and serve the actual extracted file's
      //   bytes with the correct Content-Type. This makes the fallback work even
      //   when the metadata response didn't populate themeAudioUrl, and eliminates
      //   client-side ext probing + associated 404 spam.
      // The same bare/exact logic is used in the non-fullscreen Theme tab.
      this.audio.src = videoUrl;
      this.audio.load();
      try {
        await this.audio.play();
        // Re-validate after the await: a rapid subsequent hover may have already
        // hard-reset the element and installed a newer activeStatus/url.
        if (
          this.activeStatus?.url !== videoUrl ||
          this.sourceType !== "audio"
        ) {
          return;
        }
        this._fadeTo(targetVolume, fadeMs);
        this._finishStatus({
          status: "playing",
          url: videoUrl,
          title,
          sourceType: "audio",
        });
      } catch (e: unknown) {
        if (e instanceof Error && e.name === "AbortError") return;
        if (this.activeStatus?.url !== videoUrl) return;
        // NotSupportedError or MEDIA_ERR_SRC_NOT_SUPPORTED typically means the file
        // doesn't exist on the server (404 / no theme downloaded yet).
        const isMissing =
          (e instanceof Error && e.name === "NotSupportedError") ||
          this.audio?.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
        if (isMissing) {
          this._finishStatus({
            status: "missing",
            url: videoUrl,
            title,
            sourceType: "audio",
            message: "No theme audio downloaded",
            gameId: this.currentGameId ?? undefined,
          });
        } else {
          this._finishStatus({
            status: "blocked",
            url: videoUrl,
            title,
            sourceType: "audio",
            message: String(e),
          });
        }
      }
      return;
    }

    // YouTube path
    if (gameId != null) {
      this.currentGameId = gameId;
    }
    this.sourceType = "youtube";
    await this.ensureApi();

    // Extract id
    let videoId = "";
    try {
      const u = new URL(videoUrl);
      if (u.hostname.includes("youtu.be")) videoId = u.pathname.slice(1);
      else videoId = u.searchParams.get("v") || "";
    } catch {}

    if (!videoId) {
      this._finishStatus({
        status: "error",
        url: videoUrl,
        title,
        sourceType: "youtube",
        message: "bad url",
      });
      return;
    }

    this.currentVideoId = videoId;
    this.activeStatus = {
      title,
      url: videoUrl,
      sourceType: "youtube",
      targetVolume,
      fadeMs,
    };

    // Create hidden player
    const _container =
      document.getElementById("retrom-game-music") ||
      (() => {
        const c = document.createElement("div");
        c.id = "retrom-game-music";
        c.style.position = "absolute";
        c.style.left = "-9999px";
        c.style.top = "-9999px";
        c.style.width = "1px";
        c.style.height = "1px";
        document.body.appendChild(c);
        return c;
      })();

    // (re)create player — ensureApi() guarantees window.YT is defined here
    try {
      this.player = new window.YT!.Player("retrom-game-music", {
        height: "1",
        width: "1",
        videoId,
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          fs: 0,
          modestbranding: 1,
          mute: 1,
          playsinline: 1,
          rel: 0,
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            const active = this.activeStatus;
            if (!active || active.sourceType !== "youtube") return;

            try {
              e.target.mute?.();
              e.target.setVolume(0);
              e.target.playVideo();
              this.sourceType = "youtube";
              this._startStatePoller?.();
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              this._finishStatus({
                status: "error",
                title: this.activeStatus?.title,
                url: this.activeStatus?.url,
                sourceType: "youtube",
                message,
              });
            }
          },
          onStateChange: (e: { data: number; target: YTPlayer }) => {
            if (e.data !== window.YT?.PlayerState?.PLAYING) {
              return;
            }

            const active = this.activeStatus;
            if (!active || active.sourceType !== "youtube") return;

            e.target.unMute?.();
            this._fadeTo(active.targetVolume, active.fadeMs);
            this._finishStatus({
              status: "playing",
              title: active.title,
              url: active.url,
              sourceType: "youtube",
            });
            this._stopStatePoller?.();
          },
          onError: (e: { data?: number }) => {
            const active = this.activeStatus;
            this._stopStatePoller?.();

            const code = Number(e.data);
            const isEmbedRestricted =
              code === 101 || code === 150 || code === 100;

            if (isEmbedRestricted && this._tryNextCandidate?.()) {
              return;
            }

            this._finishStatus({
              status: "error",
              title: active?.title,
              url: active?.url,
              sourceType: "youtube",
              message:
                `YouTube player error ${String(e.data ?? "")} (often caused by tracking prevention, COI headers, or the video disallowing embeds)`.trim(),
            });
          },
        },
      });
    } catch (e) {
      this._finishStatus({
        status: "error",
        url: videoUrl,
        title,
        sourceType: "youtube",
        message: String(e),
      });
    }
  },

  _tryNextCandidate() {
    if (this.currentCandidateIndex + 1 >= this.lastCandidates.length)
      return false;
    this.currentCandidateIndex++;
    const next = this.lastCandidates[this.currentCandidateIndex];
    if (!next) return false;
    // restart play with next (fire and forget)
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.playForGame(
      next,
      this.activeStatus?.targetVolume ?? 0.3,
      this.activeStatus?.fadeMs ?? 700,
      this.activeStatus?.title,
      this.lastCandidates,
      this.currentGameId ?? undefined,
    );
    return true;
  },

  stop(fadeMs = 300, forUrl?: string, forGameId?: number) {
    if (forUrl && this.activeStatus?.url !== forUrl) {
      if (forGameId == null || this.currentGameId !== forGameId) return;
    }

    this._clearAllFades();

    const p = this.player;
    const a = this.audio;

    if (p) {
      try {
        p.stopVideo?.();
        p.destroy?.();
      } catch {}
      this.player = null;
    }

    if (a) {
      try {
        if (fadeMs > 0) {
          const startVol = a.volume;
          const start = Date.now();
          this.outgoingFadeInterval = setInterval(() => {
            const t = Math.min(1, (Date.now() - start) / fadeMs);
            a.volume = startVol * (1 - t);
            if (t >= 1) {
              if (this.outgoingFadeInterval) {
                clearInterval(this.outgoingFadeInterval);
                this.outgoingFadeInterval = null;
              }
              // Guard: if a newer playForGame has already taken over (new activeStatus),
              // do not blank the src of the current track. This can happen on rapid
              // hover switches where an in-flight stop-fade's final tick fires late.
              if (this.activeStatus) {
                return;
              }
              a.pause();
              a.src = "";
            }
          }, 50);
        } else {
          a.pause();
          a.src = "";
        }
      } catch {}
    }

    this._stopStatePoller();
    this.currentGameId = null;
    this.activeStatus = null;
    this.sourceType = null;
    this.userPaused = false;
    useGameMusicStatus.getState().hide();
  },

  // allow the focus container etc to force a user-gesture playback start (needed for YT in some webviews)
  userActivatePlayback() {
    this._stopStatePoller?.();
    this._clearAllFades?.();
    const p = this.player;
    if (p && typeof p.playVideo === "function") {
      try {
        p.playVideo();
      } catch {}
    }
    const a = this.audio;
    if (a) {
      try {
        void a.play().catch((e: unknown) => {
          if (e instanceof Error && e.name !== "AbortError")
            console.warn("userActivate play error", e);
        });
      } catch {}
    }
  },

  // Lazily build (and cache) the Web Audio analyser wired to the shared theme
  // <audio> element for the live visualizer. Returns null when no element exists
  // yet or Web Audio is unavailable. createMediaElementSource is called at most
  // once per element; the source is connected through to destination so audio is
  // never silenced. Resumes the context (autoplay policy) on creation.
  ensureAnalyser(): AnalyserNode | null {
    const a = this.audio;
    if (!a) return null;
    if (this.analyser) return this.analyser;

    try {
      const Ctx: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) return null;

      const ctx = this.audioContext ?? new Ctx();
      this.audioContext = ctx;

      const source = this.mediaSource ?? ctx.createMediaElementSource(a);
      this.mediaSource = source;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.75;

      // Route THROUGH to destination — a media element source that isn't
      // connected to the destination plays no audio.
      source.connect(analyser);
      analyser.connect(ctx.destination);

      this.analyser = analyser;
      void ctx.resume?.().catch(() => {});
      return analyser;
    } catch (e) {
      if (import.meta.env.DEV)
        console.warn("[gameMusic] analyser setup failed", e);
      return null;
    }
  },

  resumeAudioContext() {
    void this.audioContext?.resume?.().catch(() => {});
  },

  // Play a specific playlist track for a game, forcing a real (re)load even when
  // it's the same game — so the soundtrack mini-player's prev/next actually
  // switches tracks instead of taking the seamless same-game continuation path.
  playThemeTrack(url: string, title: string | undefined, gameId: number) {
    const vol = this.activeStatus?.targetVolume ?? 0.3;
    this.userPaused = false;
    this.currentGameId = null;
    void this.playForGame(url, vol, 250, title, [url], gameId);
  },

  // Pause/resume the actual theme playback for the currently-owned game and
  // reflect the real state in the shared store (so the mini-player stays honest).
  pauseTheme() {
    this.userPaused = true;
    this._clearAllFades();
    try {
      this.audio?.pause();
    } catch {}
    try {
      this.player?.pauseVideo?.();
    } catch {}
    const active = this.activeStatus;
    this._finishStatus({
      status: "paused",
      url: active?.url ?? "",
      title: active?.title,
      sourceType: this.sourceType ?? "audio",
    });
  },

  resumeTheme() {
    this.userPaused = false;
    this.resumeAudioContext();
    const active = this.activeStatus;
    const a = this.audio;
    if (a && this.sourceType === "audio") {
      void a
        .play()
        .then(() => {
          this._fadeTo(active?.targetVolume ?? 0.3, 150);
          this._finishStatus({
            status: "playing",
            url: active?.url ?? "",
            title: active?.title,
            sourceType: "audio",
          });
        })
        .catch((e: unknown) => {
          if (e instanceof Error && e.name === "AbortError") return;
        });
    } else if (this.player && this.sourceType === "youtube") {
      try {
        this.player.playVideo();
      } catch {}
      this._finishStatus({
        status: "playing",
        url: active?.url ?? "",
        title: active?.title,
        sourceType: "youtube",
      });
    }
  },
};

// Public API used by grid cards + detail page + now playing
export const gameMusicPlayer = {
  playForGame: (
    url: string | undefined,
    vol: number,
    fade: number,
    title?: string,
    cands?: readonly string[],
    gameId?: number,
  ) => gameMusic.playForGame(url, vol, fade, title, cands, gameId),
  stop: (fade?: number, url?: string, gameId?: number) =>
    gameMusic.stop(fade, url, gameId),
  userActivatePlayback: () => gameMusic.userActivatePlayback?.(),
  ensureAnalyser: () => gameMusic.ensureAnalyser(),
  resumeAudioContext: () => gameMusic.resumeAudioContext(),
  pauseTheme: () => gameMusic.pauseTheme(),
  resumeTheme: () => gameMusic.resumeTheme(),
  playThemeTrack: (url: string, title: string | undefined, gameId: number) =>
    gameMusic.playThemeTrack(url, title, gameId),
  // The shared <audio> element backing native theme playback, for reading live
  // progress (currentTime/duration). Null when no theme has played yet.
  getThemeMedia: (): HTMLMediaElement | null => gameMusic.audio,
  clearCacheForGame: (gameId: number) => {
    for (const [url] of gameMusic.recentResults) {
      if (
        url.includes(`/games/${gameId}/`) ||
        url.includes(`games/${gameId}`)
      ) {
        gameMusic.recentResults.delete(url);
      }
    }
    if (gameMusic.currentGameId === gameId) {
      gameMusic.stop(0);
    }
  },
};

export function isAudioUrl(url: string): boolean {
  return (
    /\.(mp3|wav|ogg|opus|m4a|flac|webm|aac)$/i.test(
      (url || "").split("?")[0],
    ) || (url || "").includes("/theme")
  );
}

export function isYoutubeWatchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) &&
      !u.pathname.includes("/embed")
    );
  } catch {
    return false;
  }
}

export const useGameMusicStatus = create<GameMusicState>()((set) => ({
  visible: false,
  status: "idle",
  updatedAt: 0,
  setStatus: (state) =>
    set({
      ...state,
      visible: state.status !== "idle",
      updatedAt: Date.now(),
    }),
  hide: () => set({ visible: false, gameId: undefined }),
}));

const useLastFocusedGame = create<{
  lastFocusKeyByGroup: Record<number, string>;
  setLastFocusKey: (groupId: number, focusKey: string) => void;
}>()((set) => ({
  lastFocusKeyByGroup: {},
  setLastFocusKey: (groupId, focusKey) =>
    set((s) => ({
      lastFocusKeyByGroup: { ...s.lastFocusKeyByGroup, [groupId]: focusKey },
    })),
}));

export function useLastFocusedGroupKey(
  groupId: number | undefined,
): string | undefined {
  return useLastFocusedGame((s) =>
    groupId !== undefined ? s.lastFocusKeyByGroup[groupId] : undefined,
  );
}

export function useGameMusic(_gameId: number) {
  const { rawEnabled, rawVolume, rawFade } = useConfig((s) => {
    const fullscreenConfig = s.config?.interface?.fullscreenConfig as
      | {
          gameMusic?: {
            enabled?: boolean;
            volume?: number;
            fadeDurationMs?: number;
          };
        }
      | undefined;

    return {
      rawEnabled: fullscreenConfig?.gameMusic?.enabled ?? true,
      rawVolume: fullscreenConfig?.gameMusic?.volume ?? 0.3,
      rawFade: fullscreenConfig?.gameMusic?.fadeDurationMs ?? 700,
    };
  });

  const enabled = !!rawEnabled;
  const volume = Math.max(0, Math.min(1, Number(rawVolume) || 0.3));
  const fade = Math.max(100, Math.min(5000, Number(rawFade) || 700));

  return { enabled, volume, fade };
}

// CSS-only equalizer. Bars animate (scaleY transform — no reflow) only while a
// theme is actually playing; otherwise they sit static and dimmed. Respects
// prefers-reduced-motion via the .fs-eq-bar rule in globals.css.
const EQ_BAR_DELAYS = [0, 160, 320, 110, 240];

function MusicVisualizer(props: { active: boolean }) {
  const { active } = props;

  return (
    <div className="flex h-3 items-end gap-[2px]" aria-hidden="true">
      {EQ_BAR_DELAYS.map((delay, i) => (
        <span
          key={i}
          className={cn(
            "block w-[2px] rounded-full bg-gradient-to-t from-accent/50 to-accent",
            active
              ? "fs-eq-bar shadow-[0_0_4px_var(--color-accent)]"
              : "opacity-40",
          )}
          style={
            active
              ? { height: "100%", animationDelay: `${delay}ms` }
              : { height: "45%" }
          }
        />
      ))}
    </div>
  );
}

// Focused-card audio tray — an integrated footer that lives *inside* the focused
// game card's title/gradient area (see GameImage). It is NOT a dock, toast, or
// full-width strip: it never leaves the card's bounds, never covers neighbors,
// registers no hotkeys (so it can't steal focus or intercept controller input),
// and is absolutely positioned over the cover so it causes no grid layout shift.
//
// Only the focused card mounts this component, so it is the sole subscriber to
// the music store — music-state changes re-render just the one focused card,
// keeping rapid D-pad navigation cheap.
function CardAudioTray(props: {
  gameId: number;
  gameName: string;
  // True when this game is known to already have a downloaded theme (its
  // themeAudioUrl is present in metadata). Lets the tray show an honest,
  // non-flickering state during the ~300ms before playback settles.
  hasThemeHint: boolean;
}) {
  const { gameId, gameName, hasThemeHint } = props;

  const { status, title, ownerId } = useGameMusicStatus((state) => ({
    status: state.status,
    title: state.title,
    ownerId: state.gameId,
  }));

  // Theme presence is decided ONLY by authoritative signals: this game's theme
  // is actively playing, or metadata records a persisted themeAudioUrl. Transient
  // player states (blocked / error / loading / missing) are deliberately ignored
  // so a card with no theme can never flash a stale "Theme Music" + visualizer.
  const isPlaying = ownerId === gameId && status === "playing";
  const hasTheme = isPlaying || hasThemeHint;

  const label = isPlaying
    ? "Now Playing"
    : hasTheme
      ? "Theme Music"
      : "No Theme Music";

  const hint = hasTheme ? "Song Details" : "Download Theme Music";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none mt-2 flex flex-col gap-1.5",
        "border-t border-accent/25 pt-2",
        "animate-in fade-in slide-in-from-bottom-2 duration-200",
        isPlaying && "drop-shadow-[0_0_8px_var(--color-accent)]",
      )}
    >
      <div className="flex items-center gap-2.5">
        {/* Visualizer animates only while truly playing; sits static & dimmed
            when a theme exists but isn't playing yet, and is absent entirely
            when there's no theme. Transform-only + reduced-motion safe. */}
        {hasTheme && <MusicVisualizer active={isPlaying} />}

        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className={cn(
              "text-[0.6rem] font-bold uppercase leading-none tracking-[0.15em]",
              isPlaying ? "text-accent-text" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {hasTheme && (
            <span className="truncate text-sm font-semibold leading-tight text-foreground/90">
              {(isPlaying && title) || gameName}
            </span>
          )}
        </div>
      </div>

      {/* Quiet pointer to where theme music is managed. Purely visual — registers
          no hotkey, so Start/OPTION still only opens the game context menu. */}
      <span className="flex items-center gap-1.5 text-[0.65rem] font-medium text-muted-foreground">
        <HotkeyIcon hotkey="OPTION" className="size-4" />
        Options › {hint}
      </span>
    </div>
  );
}

function getFirstGameId(group: Group) {
  const firstPartitionWithGames = group.partitionedGames.find(
    ([_, games]) => !!games.length,
  );

  return firstPartitionWithGames?.[1][0].id;
}

function clampScroll(value: number, max: number) {
  return Math.max(0, Math.min(max, value));
}

const rapidScrollAnimations = new WeakMap<HTMLElement, { frameId: number }>();

// The app's global smooth-scroll rule makes focus restoration visibly animate
// from the top; grid focus movement uses a cancellable fast animation instead.
function runWithoutSmoothScroll(viewport: HTMLElement, scroll: () => void) {
  const previousScrollBehavior = viewport.style.scrollBehavior;

  viewport.style.scrollBehavior = "auto";

  try {
    scroll();
  } finally {
    viewport.style.scrollBehavior = previousScrollBehavior;
  }
}

function setViewportScrollTop(viewport: HTMLElement, top: number) {
  runWithoutSmoothScroll(viewport, () => {
    viewport.scrollTop = top;
  });
}

function stopRapidScroll(viewport: HTMLElement) {
  const animation = rapidScrollAnimations.get(viewport);

  if (!animation) return;

  cancelAnimationFrame(animation.frameId);
  rapidScrollAnimations.delete(viewport);
}

function getRapidScrollDuration(distance: number) {
  return clampScroll(70 + Math.abs(distance) / 12, 130);
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}

function animateViewportScrollTop(viewport: HTMLElement, targetTop: number) {
  stopRapidScroll(viewport);

  const startTop = viewport.scrollTop;
  const distance = targetTop - startTop;

  if (Math.abs(distance) < 1) {
    setViewportScrollTop(viewport, targetTop);
    return;
  }

  const duration = getRapidScrollDuration(distance);
  const startedAt = performance.now();
  const animation = { frameId: 0 };

  const tick = (now: number) => {
    if (rapidScrollAnimations.get(viewport) !== animation) return;

    const progress = Math.min((now - startedAt) / duration, 1);
    const nextTop = startTop + distance * easeOutCubic(progress);

    setViewportScrollTop(viewport, nextTop);

    if (progress < 1) {
      animation.frameId = requestAnimationFrame(tick);
      return;
    }

    setViewportScrollTop(viewport, targetTop);
    rapidScrollAnimations.delete(viewport);
  };

  rapidScrollAnimations.set(viewport, animation);
  animation.frameId = requestAnimationFrame(tick);
}

function centerCardInScrollViewport(
  node: HTMLElement,
  opts: { immediate?: boolean } = {},
) {
  const viewport = node.closest<HTMLElement>(
    "[data-radix-scroll-area-viewport]",
  );

  if (!viewport) {
    node.scrollIntoView({
      behavior: "instant",
      block: "center",
      inline: "nearest",
    });
    return;
  }

  const viewportRect = viewport.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const top = clampScroll(
    viewport.scrollTop +
      nodeRect.top -
      viewportRect.top -
      (viewportRect.height - nodeRect.height) / 2,
    viewport.scrollHeight - viewport.clientHeight,
  );

  if (opts.immediate) {
    stopRapidScroll(viewport);
    setViewportScrollTop(viewport, top);
    return;
  }

  animateViewportScrollTop(viewport, top);
}

// Soundtrack playback + detail prefetch are deferred briefly after a card gains
// focus, so that holding a direction (alphabet quick-scroll) or rapidly moving
// across cards never starts/stops theme music or pops the now-playing banner
// mid-scrub. Each new focus cancels the previous pending action, so it only runs
// once focus settles on a card. A single shared timer is enough because only one
// card holds focus at a time.
const FOCUS_SETTLE_MS = 300;
let focusSettleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFocusSettle(action: () => void) {
  if (focusSettleTimer) clearTimeout(focusSettleTimer);
  focusSettleTimer = setTimeout(() => {
    focusSettleTimer = null;
    action();
  }, FOCUS_SETTLE_MS);
}

/** Cancel any pending post-focus music/prefetch (e.g. on leaving fullscreen). */
export function cancelPendingFocusMusic() {
  if (focusSettleTimer) {
    clearTimeout(focusSettleTimer);
    focusSettleTimer = null;
  }
}

/**
 * Re-fire spatial focus on whichever card currently holds focus so that theme
 * music starts after a suppression window ends (e.g. the startup movie). Cards
 * don't receive a natural onFocus again unless focus actually changes, so this
 * nudge is needed to kick off the settle timer and start the track.
 */
export function resumeFocusedCardMusic() {
  const key = getCurrentFocusKey();
  if (key) setFocus(key);
}

// A soundtrack download RPC returns as soon as the background job is *spawned*,
// not when the file lands. Until the grid card's metadata refetches, it still
// shows no theme. Poll-invalidate just this game's metadata until the new
// themeAudioUrl appears (or we time out), so the focused card's source flips and
// its replay effect starts the track — no full app refresh needed.
const themeAvailabilityPolls = new Map<
  number,
  ReturnType<typeof setInterval>
>();

// mediaPaths is a protobuf map (a JS Map under @bufbuild or a plain keyed object
// depending on shape), so read defensively. Isolated here so the unavoidable
// `any` access doesn't leak eslint-disables across the poller logic.
function readThemeAudioUrl(data: unknown, gameId: number): string | undefined {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
  const mp: any = (data as any)?.mediaPaths;
  if (!mp) return undefined;
  const entry: any =
    typeof mp.get === "function"
      ? (mp.get(gameId) ?? mp.get(String(gameId)))
      : (mp[gameId] ?? mp[String(gameId)]);
  return entry?.themeAudioUrl;
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
}

function gameMetadataQueryMatches(key: readonly unknown[], gameId: number) {
  if (!key.includes("game-metadata")) return false;
  // useGameMetadata keys are ["game-metadata", "metadata", queryClient, request]
  // where request carries the gameIds we asked for.
  const req = key.find(
    (k): k is { gameIds?: number[] } =>
      typeof k === "object" && k !== null && "gameIds" in k,
  );
  if (req?.gameIds?.includes(gameId)) return true;
  // GameDetailProvider keys the metadata query as
  // ["game", "games", "game-metadata", "games-metadata", gameId] — the id is a
  // bare element, not a {gameIds} request. The SoundtrackConsole + detail title
  // read from THIS query, so it must be invalidated too or the detail page shows
  // a stale "no theme" / missing title / missing duration after a download.
  return key.includes(gameId);
}

export function pollForDownloadedTheme(
  queryClient: QueryClient,
  gameId: number,
) {
  const existing = themeAvailabilityPolls.get(gameId);
  if (existing) clearInterval(existing);

  // Drop any cached "missing"/"blocked" outcome so the player retries the theme
  // once metadata refetches and the focused card re-triggers playback.
  gameMusicPlayer.clearCacheForGame(gameId);

  const themeReady = () =>
    queryClient
      .getQueriesData({
        predicate: (q) => gameMetadataQueryMatches(q.queryKey, gameId),
      })
      .some(([, data]) => !!readThemeAudioUrl(data, gameId));

  const refetch = () =>
    void queryClient.invalidateQueries({
      predicate: (q) => gameMetadataQueryMatches(q.queryKey, gameId),
    });

  const stop = () => {
    const id = themeAvailabilityPolls.get(gameId);
    if (id) clearInterval(id);
    themeAvailabilityPolls.delete(gameId);
  };

  const start = Date.now();
  const interval = setInterval(() => {
    if (themeReady() || Date.now() - start > 120_000) {
      stop();
      return;
    }
    refetch();
  }, 4000);
  themeAvailabilityPolls.set(gameId, interval);

  // Kick an immediate refetch so we don't sit idle for the first interval.
  refetch();
}

export function GridGameList() {
  const { activeGroup, allGroups } = useGroupContext();
  const lastFocusKeyByGroup = useLastFocusedGame((s) => s.lastFocusKeyByGroup);
  const { restoreGridFocus } = useSearch({ from: "/_fullscreenLayout" });

  const { columns = 4, gap = 20 } =
    useConfig((s) => s.config?.interface?.fullscreenConfig?.gridList) ?? {};

  const getDelay = useCallback(
    (idx: number) => {
      const col = idx % columns;

      return col * 150;
    },
    [columns],
  );

  // Determine if we are restoring a previous position (returning from detail).
  // Must be computed at the top level so hooks can read it.
  const shouldRestoreFocus = restoreGridFocus === true;
  const activeSavedFocusKey =
    shouldRestoreFocus && activeGroup
      ? lastFocusKeyByGroup[activeGroup.id]
      : undefined;
  const isRestoring = activeSavedFocusKey
    ? activeGroup!.allGames.some(
        (g) => `game-list-${activeGroup!.id}-${g.id}` === activeSavedFocusKey,
      )
    : false;

  // The entrance stagger should play when loading a group fresh (including
  // switching category tabs) but NOT when returning from the detail page (that
  // re-fade looks like a reload). Capture, once at mount, which group we're
  // restoring into; only that group's cards skip the animation. Any tab the
  // user switches to afterwards mounts fresh and animates normally.
  const [restoredGroupId] = useState(() =>
    isRestoring ? activeGroup?.id : undefined,
  );

  // Scroll to the previously focused card before the first paint so the
  // grid never flashes at scroll-position 0 when returning from the detail page.
  // useLayoutEffect fires after DOM commit but before the browser paints.
  useLayoutEffect(() => {
    if (!isRestoring || !activeSavedFocusKey) return;
    const node = document.getElementById(activeSavedFocusKey);
    if (node) centerCardInScrollViewport(node, { immediate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return allGroups.map((group) => {
    if (group.id !== activeGroup?.id) return null;

    const savedFocusKey = shouldRestoreFocus
      ? lastFocusKeyByGroup[group.id]
      : undefined;
    const savedGameExists = savedFocusKey
      ? group.allGames.some(
          (g) => `game-list-${group.id}-${g.id}` === savedFocusKey,
        )
      : false;

    // Skip the entrance stagger only for the group we restored into on a
    // Back-from-detail mount; every other (tab-switched) group animates.
    const suppressEntrance = group.id === restoredGroupId;

    return (
      <FocusContainer
        key={group.id}
        opts={{
          focusKey: `game-list-${group.id}`,
          saveLastFocusedChild: false,
        }}
        style={{ "--game-cols": columns, "--game-gap": `${gap}px` }}
        className={cn(
          "flex flex-col gap-4 w-full mx-auto pt-8 pb-[20dvh] px-4",
        )}
      >
        {group.allGames.length === 0 && (
          <div className="flex flex-col gap-4 items-center justify-center">
            <h2 className="text-foreground/80 font-black text-2xl">
              No games found 😔
            </h2>
            <p className="text-foreground/50">
              Please add some games to your library.
            </p>
          </div>
        )}
        {activeGroup?.partitionedGames
          ?.filter(([_, games]) => !!games.length)
          .map(([key, games]) => (
            <FocusContainer
              opts={{
                focusKey: `game-list-${activeGroup.id}-${key}-container`,
                focusable: !!games.length,
                saveLastFocusedChild: false,
              }}
              key={key}
              className={cn(!games.length ? "hidden" : "block")}
            >
              <div
                className={cn(
                  "grid gap-4 place-items-center mb-4 px-4",
                  "grid-cols-[1fr,auto,1fr]",
                )}
              >
                <Separator className="bg-foreground/30" />

                <h3
                  id={`game-list-header-${key}`}
                  className="uppercase font-black text-xl text-foreground/80 scroll-mt-16"
                >
                  {key}
                </h3>

                <Separator className="bg-foreground/30" />
              </div>

              <div
                className={cn(
                  "grid w-full gap-[var(--game-gap)]",
                  "grid-cols-[repeat(var(--game-cols),minmax(0,1fr))]",
                )}
              >
                {games.map((game) => {
                  const focusKey = `game-list-${group.id}-${game.id}`;
                  const initialFocus = savedGameExists
                    ? focusKey === savedFocusKey
                    : game.id === getFirstGameId(group);
                  return (
                    <div
                      key={game.id}
                      style={
                        suppressEntrance
                          ? undefined
                          : {
                              animationDelay: `${getDelay(group.allGames.findIndex(({ id }) => id === game.id))}ms`,
                            }
                      }
                      className={
                        suppressEntrance
                          ? undefined
                          : cn("animate-in fade-in fill-mode-both duration-500")
                      }
                    >
                      <GameListItem
                        game={game}
                        id={focusKey}
                        groupId={group.id}
                        partitionKey={key}
                        initialFocus={initialFocus}
                      />
                    </div>
                  );
                })}
              </div>
            </FocusContainer>
          ))}
      </FocusContainer>
    );
  });
}

// While a fullscreen sheet (Sort By / Filters) owns focus, grid cards must not
// claim focus via forceFocus/initialFocus. A re-render behind the open sheet
// (e.g. toggling a filter) would otherwise let the new first card grab focus,
// yanking it out of the sheet and leaving the user unable to close it. Set by
// the sheets while open; read at card render time (the same render the steal
// would happen on), so a plain module flag is sufficient — no reactivity needed.
let gridAutoFocusSuppressed = false;
export function setGridAutoFocusSuppressed(suppressed: boolean) {
  gridAutoFocusSuppressed = suppressed;
}

// Set for one focus transition when a card's focus was initiated by the mouse
// (hover) rather than the controller, so onFocus can skip its scroll-centering.
// Read + cleared synchronously inside the very next onFocus it triggers.
let focusFromPointer = false;

function GameListItem(props: {
  game: GameWithMetadata;
  id: string;
  groupId: number;
  partitionKey: string;
  initialFocus?: boolean;
}) {
  const { game, id, groupId, partitionKey, initialFocus } = props;

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  // Warm the exact queries GameDetailProvider gates on (game+files, detail
  // metadata, platform) so the detail page renders immediately with no loading
  // skeleton ("refresh"). We already know platformId from the grid game, so all
  // three are fetched in parallel with no waterfall. Idempotent + cheap thanks
  // to staleTime; safe to call repeatedly from focus and hover.
  const prefetchDetail = useCallback(() => {
    const gameId = game.id;
    void queryClient
      .fetchQuery({
        queryKey: ["games", "game-metadata", "game-files", gameId],
        queryFn: async () => {
          const data = await retromClient.gameClient.getGames({
            withFiles: true,
            ids: [gameId],
          });
          return { game: data.games.at(0), gameFiles: data.gameFiles };
        },
        staleTime: 30_000,
      })
      .catch(() => {});

    void queryClient.prefetchQuery({
      queryKey: ["game", "games", "game-metadata", "games-metadata", gameId],
      queryFn: () =>
        retromClient.metadataClient.getGameMetadata({ gameIds: [gameId] }),
      staleTime: 30_000,
    });

    const platformId = game.platformId;
    if (platformId !== undefined) {
      void queryClient.prefetchQuery({
        queryKey: ["platforms", "platform-metadata", platformId],
        queryFn: async () => {
          const data = await retromClient.platformClient.getPlatforms({
            withMetadata: true,
            ids: [platformId],
          });
          return {
            platform: data.platforms.at(0),
            platformMetadata: data.metadata.at(0),
          };
        },
        staleTime: 30_000,
      });
    }
  }, [game.id, game.platformId, queryClient, retromClient]);

  // Don't let cards grab focus while a sheet is open (see flag comment above).
  const allowAutoFocus = !gridAutoFocusSuppressed;
  const { ref, focused } = useFocusable<HTMLDivElement>({
    focusKey: id,
    forceFocus: allowAutoFocus,
    initialFocus: initialFocus && allowAutoFocus,
    onFocus: ({ node }) => {
      // Pointer-driven focus (mouse hover) must not scroll the grid — the card
      // is already under the cursor, and centering it would yank the layout and
      // change which card is hovered. Controller/keyboard focus still centers.
      if (node && !focusFromPointer) {
        centerCardInScrollViewport(node, { immediate: initialFocus });
      }
      focusFromPointer = false;
      useLastFocusedGame.getState().setLastFocusKey(groupId, id);
      notifyCardFocus(partitionKey);
      // Defer music + prefetch until focus settles so quick-scroll / rapid
      // navigation doesn't thrash the soundtrack or flash the banner.
      scheduleFocusSettle(() => {
        startMusicForThisGame();
        prefetchDetail();
      });
    },
  });

  // Mouse hover moves spatial-navigation focus to this card so the mouse path
  // gets the exact same treatment as the controller: full accent ring, scale,
  // the focused-card audio tray, and theme music — none of which key off plain
  // CSS :hover. (focusFromPointer suppresses the scroll-centering in onFocus.)
  const handleMouseEnter = () => {
    // Don't let a stray hover steal focus out of an open sheet / context menu
    // (same guard as initialFocus/forceFocus above).
    if (gridAutoFocusSuppressed) return;
    if (getCurrentFocusKey() !== id) {
      focusFromPointer = true;
      setFocus(id);
    }
    prefetchDetail();
  };

  const { imageType = "COVER" } =
    useConfig((s) => s.config?.interface?.fullscreenConfig?.gridList) ?? {};

  // Respect the "Play game music on focus/hover" toggle from either config menu.
  // This makes the checkbox in both the fullscreen menubar config and the general config
  // actually turn the automatic theme music on/off for grid hover + detail pages.
  const {
    enabled,
    volume: musicVolume,
    fade: musicFade,
  } = useGameMusic(game.id);

  // Fetch per-game metadata so we can prefer its theme audio (yt-dlp) on hover/focus in the grid
  const { data: metaForMusic } = useGameMetadata({
    request: { gameIds: [game.id] },
    selectFn: (d) => d,
  });

  const publicUrlForMusic = usePublicUrl();

  const musicSourceForHover = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mp: any = metaForMusic?.mediaPaths as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entry: any;
    if (mp) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (typeof mp.get === "function")
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        entry = mp.get(game.id) ?? mp.get(String(game.id));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      else entry = mp[game.id] ?? mp[String(game.id)];
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const themeRel: string | undefined = entry?.themeAudioUrl;
    if (themeRel && publicUrlForMusic) {
      // Always pass a fully resolved absolute public URL (with the correct game id) to the player.
      // This guarantees that hovering/focusing a different game produces a distinct source string
      // (e.g. .../media/games/21/theme or .../media/games/21/theme.m4a), so playForGame + stop will
      // actually switch the underlying audio resource instead of sticking on one game's song.
      // Matches the construction used in the detail view and in GameImage below.
      return createUrl({ path: themeRel, base: publicUrlForMusic })?.href;
    }
    if (!themeRel && publicUrlForMusic) {
      // Robust magic base fallback for yt-dlp "theme.*" (any ext) exactly like the prior fixes and
      // the non-fullscreen Theme tab. The player will try theme.m4a, theme.webm, etc.
      const magic = createUrl({
        path: `media/games/${game.id}/theme`,
        base: publicUrlForMusic,
      })?.href;
      if (magic) return magic;
    }
    const firstAudio = (metaForMusic?.metadata.at(0)?.videoUrls || []).find(
      isAudioUrl,
    );
    // If the audio url from videoUrls is itself a relative local path, resolve it too for consistency.
    if (firstAudio && publicUrlForMusic && !/^https?:/i.test(firstAudio)) {
      return (
        createUrl({ path: firstAudio, base: publicUrlForMusic })?.href ||
        firstAudio
      );
    }
    return firstAudio;
  }, [metaForMusic, game.id, publicUrlForMusic]);

  // Whether this game already has a *downloaded* theme (persisted themeAudioUrl).
  // Drives the focused-card tray's honest resting state and its hint
  // (Song Details vs. Download Theme Music) before playback settles.
  const hasThemeHint = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mp: any = metaForMusic?.mediaPaths as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entry: any;
    if (mp) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (typeof mp.get === "function")
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        entry = mp.get(game.id) ?? mp.get(String(game.id));
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
      else entry = mp[game.id] ?? mp[String(game.id)];
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return !!entry?.themeAudioUrl;
  }, [metaForMusic, game.id]);

  // When the toggle is turned off (from either config menu), stop any current music.
  // New hover/focus will simply not start it while disabled.
  useEffect(() => {
    if (!enabled) {
      gameMusicPlayer.stop(300);
    }
  }, [enabled]);

  const startMusicForThisGame = () => {
    if (!enabled) return;
    if (gridAutoFocusSuppressed) return;

    if (musicSourceForHover) {
      // Call playForGame with the configured volume/fade from the shared gameMusic config.
      // The checkbox in both menus controls this (and the detail page already respected it).
      // User gesture from focus/mouse should allow autoplay; the banner provides "Play preview" fallback if blocked.
      void gameMusicPlayer.playForGame(
        musicSourceForHover,
        musicVolume,
        musicFade,
        game.metadata?.name || getFileStub(game.path),
        [],
        game.id,
      );
    }
  };

  // When a freshly downloaded theme's metadata lands while this card is still
  // focused, musicSourceForHover flips (bare magic fallback → exact themeAudioUrl)
  // — replay so the new theme starts without leaving/refreshing fullscreen. We
  // only react to a source change that happens *while already focused*; focus
  // GAIN is handled by the debounced onFocus settle, so rapid navigation is
  // never affected.
  const wasFocusedRef = useRef(false);
  const prevSourceRef = useRef(musicSourceForHover);
  useEffect(() => {
    const sourceChanged = prevSourceRef.current !== musicSourceForHover;
    prevSourceRef.current = musicSourceForHover;
    if (
      focused &&
      wasFocusedRef.current &&
      sourceChanged &&
      enabled &&
      musicSourceForHover
    ) {
      startMusicForThisGame();
    }
    wasFocusedRef.current = focused;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, musicSourceForHover, enabled]);

  return (
    <div
      className={cn(
        "group scale-[0.94] focus-within:scale-100 hover:scale-100",
        "transition-transform duration-200 ease-out will-change-transform",
        "focus-within:z-10 hover:z-10",
        "shadow-lg shadow-background relative cursor-pointer",
        "rounded h-full w-full",
      )}
    >
      <HotkeyLayer
        handlers={{ ACCEPT: { handler: () => ref.current?.click() } }}
      >
        <div
          tabIndex={-1}
          id={id}
          ref={ref}
          className={cn("border-none outline-none")}
          onMouseEnter={handleMouseEnter}
          onClick={() =>
            void navigate({
              to: "/fullscreen/games/$gameId",
              params: { gameId: game.id.toString() },
              search: (prev) => ({ ...prev, restoreGridFocus: true }),
            })
          }
        >
          <GameImage
            game={game}
            kind={imageType}
            focused={focused}
            musicEnabled={enabled}
            hasThemeHint={hasThemeHint}
          />
        </div>
      </HotkeyLayer>
    </div>
  );
}

function GameImage(props: {
  game: GameWithMetadata;
  kind: InterfaceConfig_GameListEntryImageJson;
  focused?: boolean;
  musicEnabled?: boolean;
  hasThemeHint?: boolean;
}) {
  const { game, focused, musicEnabled, hasThemeHint } = props;
  const publicUrl = usePublicUrl();

  const { data, status } = useGameMetadata({
    request: { gameIds: [game.id] },
    selectFn: (data) => ({
      metadata: data.metadata.at(0),
      mediaPaths:
        game.id in data.mediaPaths ? data.mediaPaths[game.id] : undefined,
    }),
  });

  const coverUrl = useMemo(() => {
    const localPath = data?.mediaPaths?.coverUrl;
    if (localPath && publicUrl) {
      return createUrl({ path: localPath, base: publicUrl })?.href;
    }

    return data?.metadata?.coverUrl;
  }, [publicUrl, data]);

  const backgroundUrl = useMemo(() => {
    const localPath = data?.mediaPaths?.backgroundUrl;
    if (localPath && publicUrl) {
      return createUrl({ path: localPath, base: publicUrl })?.href;
    }

    return data?.metadata?.backgroundUrl;
  }, [publicUrl, data]);

  // Per-game theme audio (from yt-dlp or direct) for grid hover/focus music
  const _themeAudioForThisGame = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mp: any = data?.mediaPaths as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entry: any = undefined;
    if (mp) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (typeof mp.get === "function") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        entry = mp.get(game.id) ?? mp.get(String(game.id));
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        entry = mp[game.id] ?? mp[String(game.id)];
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const rel: string | undefined = entry?.themeAudioUrl;
    if (rel && publicUrl) {
      return createUrl({ path: rel, base: publicUrl })?.href;
    }
    if (publicUrl) {
      // magic fallback so the player tries theme.* exts
      return createUrl({
        path: `media/games/${game.id}/theme`,
        base: publicUrl,
      })?.href;
    }
    return undefined;
  }, [data, publicUrl, game.id]);

  const imageSrc = props.kind === "BACKGROUND" ? backgroundUrl : coverUrl;
  const gameName = game.metadata?.name ?? getFileStub(game.path);

  return (
    <div
      key={game.id}
      className={cn(
        props.kind === "BACKGROUND" ? "aspect-video" : "aspect-[3/4]",
        "rounded overflow-hidden relative",
        "h-fit w-fit min-w-full min-h-full",
      )}
    >
      {status === "pending" ? (
        <Skeleton className="size-full" />
      ) : imageSrc ? (
        <img
          loading="lazy"
          src={imageSrc}
          className={cn("absolute object-cover min-w-full min-h-full")}
        />
      ) : null}

      <div
        className={cn(
          "absolute inset-0 rounded",
          "bg-gradient-to-t from-background/95 via-background/30 to-transparent",
          "ring-accent ring-inset group-focus-within:ring-[length:var(--fs-focus-ring-width)]",
          props.kind === "BACKGROUND" ? "text-lg py-2 px-4" : "text-2xl p-4",
          "flex flex-col justify-end font-black",
        )}
      >
        <p className="text-pretty drop-shadow-md line-clamp-3 opacity-80 group-focus-within:opacity-100 group-hover:opacity-100 transition-opacity">
          {gameName}
        </p>

        {/* Integrated audio tray — only the focused card mounts it, attached to
            the bottom of this card's own title/gradient area. */}
        {focused && musicEnabled && (
          <CardAudioTray
            gameId={game.id}
            gameName={gameName}
            hasThemeHint={!!hasThemeHint}
          />
        )}
      </div>
    </div>
  );
}
