import { GameWithMetadata } from "@/components/game-list";
import { InterfaceConfig_GameListEntryImageJson } from "@retrom/codegen/retrom/client/client-config_pb";
import { getFileStub } from "@/lib/utils";
import { useConfig } from "@/providers/config";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { FocusContainer, useFocusable } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { Group, useGroupContext } from "@/providers/fullscreen/group-context";
import { Separator } from "@retrom/ui/components/separator";
import { cn } from "@retrom/ui/lib/utils";
import { useGameMetadata } from "@/queries/useGameMetadata";
import { createUrl, usePublicUrl } from "@/utils/urls";
import { Skeleton } from "@retrom/ui/components/skeleton";

// =====================================================
// Global background music player for fullscreen game themes / soundtracks.
// Supports native audio (from yt-dlp extracted "theme.*" or direct audio in videoUrls)
// and YouTube (via iframe API) with robust fallback for webview autoplay / embed restrictions.
// Fades, state polling for webview issues, candidate fallback, gesture activation.
// =====================================================

type GameMusicSourceType = "youtube" | "audio";

type GameMusicState = {
  status: "loading" | "playing" | "blocked" | "error";
  url: string;
  title?: string;
  sourceType?: GameMusicSourceType;
  message?: string;
  setStatus?: (s: any) => void;
  hide?: () => void;
};

const gameMusic = {
  player: null as any,
  audio: null as HTMLMediaElement | null,
  sourceType: null as GameMusicSourceType | null,
  currentVideoId: null as string | null,
  fadeInterval: null as any,
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

  ensureApi(): Promise<void> {
    if (this.apiReady && (window as any).YT?.Player) {
      this.apiReady = true;
      return Promise.resolve();
    }

    if (this.apiPromise) {
      return this.apiPromise;
    }

    this.apiPromise = new Promise((resolve, reject) => {
      if ((window as any).YT?.Player) {
        this.apiReady = true;
        resolve();
        return;
      }

      const previousReady = (window as any).onYouTubeIframeAPIReady;
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      tag.async = true;
      (window as any).onYouTubeIframeAPIReady = () => {
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
    // In real impl this would update a zustand or context, but for the global we just keep in activeStatus
    // (the NowPlaying component and callers read from the exported player)
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._recordOutcome(state.url, state.status as any);
    }

    this._setStatus(state);
  },

  _recordOutcome(url: string, status: GameMusicState["status"]) {
    this.recentResults.set(url, {
      outcome: status === "playing" ? "playing" : status === "error" ? "error" : "blocked",
      ts: Date.now(),
    });
    // also expose last for any debug consumers
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gameMusicPlayer as any).lastResult = { url, status };
  },

  _fadeTo(target: number, durationMs: number) {
    if (this.fadeInterval) clearInterval(this.fadeInterval);

    const p = this.player;
    const a = this.audio;
    if (!p && !a) return;

    const start = Date.now();
    const getVol = () => {
      if (this.sourceType === "youtube" && p?.getVolume) return p.getVolume() / 100;
      if (a) return a.volume;
      return 0;
    };
    const setVol = (v: number) => {
      const clamped = Math.max(0, Math.min(1, v));
      if (this.sourceType === "youtube" && p?.setVolume) p.setVolume(Math.round(clamped * 100));
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        const YT = (window as any).YT;
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

  async playForGame(
    videoUrl: string | undefined,
    targetVolume: number,
    fadeMs: number,
    title?: string,
    candidates: readonly string[] = [],
  ) {
    // Stop any previous
    this.stop(fadeMs, this.activeStatus?.url);

    if (!videoUrl) {
      this._finishStatus({ status: "blocked", url: "", title, sourceType: "audio" });
      return;
    }

    // Check recent result cache for fast path
    const recent = this.recentResults.get(videoUrl);
    if (recent && Date.now() - recent.ts < 15000) {
      if (recent.outcome === "blocked" || recent.outcome === "error") {
        this._finishStatus({ status: recent.outcome as any, url: videoUrl, title, sourceType: "youtube" });
        return;
      }
    }

    this.activeStatus = { title, url: videoUrl, sourceType: "audio", targetVolume, fadeMs };
    this.lastCandidates = candidates.length ? candidates : [videoUrl];
    this.currentCandidateIndex = this.lastCandidates.indexOf(videoUrl);
    if (this.currentCandidateIndex < 0) this.currentCandidateIndex = 0;

    const isAudio = /\.(mp3|wav|ogg|opus|m4a|flac|webm|aac)$/i.test(videoUrl.split("?")[0] || videoUrl) ||
      videoUrl.includes("theme"); // magic theme or direct audio

    if (isAudio) {
      this.sourceType = "audio";
      // Create or reuse audio element
      if (!this.audio) {
        this.audio = new Audio();
        this.audio.loop = true;
        this.audio.preload = "auto";
      }
      this.audio.src = videoUrl;
      this.audio.volume = 0;
      try {
        await this.audio.play();
        this._fadeTo(targetVolume, fadeMs);
        this._finishStatus({ status: "playing", url: videoUrl, title, sourceType: "audio" });
      } catch (e) {
        this._finishStatus({ status: "blocked", url: videoUrl, title, sourceType: "audio", message: String(e) });
      }
      return;
    }

    // YouTube path
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
      this._finishStatus({ status: "error", url: videoUrl, title, sourceType: "youtube", message: "bad url" });
      return;
    }

    this.currentVideoId = videoId;
    this.activeStatus = { title, url: videoUrl, sourceType: "youtube", targetVolume, fadeMs };

    // Create hidden player
    const container = document.getElementById("retrom-game-music") || (() => {
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

    // (re)create player
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      this.player = new (window as any).YT.Player("retrom-game-music", {
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onReady: (e: any) => {
            const active = this.activeStatus;
            if (!active || active.sourceType !== "youtube") return;

            try {
              e.target.mute?.();
              e.target.setVolume(0);
              e.target.playVideo();
              this.sourceType = "youtube";
              this._startStatePoller?.();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              this._finishStatus({
                status: "error",
                title: this.activeStatus?.title,
                url: this.activeStatus?.url,
                sourceType: "youtube",
                message,
              });
            }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onStateChange: (e: any) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
            if (e.data !== (window as any).YT?.PlayerState?.PLAYING) {
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onError: (e: any) => {
            const active = this.activeStatus;
            this._stopStatePoller?.();

            const code = Number(e?.data);
            const isEmbedRestricted = code === 101 || code === 150 || code === 100;

            if (isEmbedRestricted && this._tryNextCandidate?.()) {
              return;
            }

            this._finishStatus({
              status: "error",
              title: active?.title,
              url: active?.url,
              sourceType: "youtube",
              message: `YouTube player error ${String(e?.data ?? "")} (often caused by tracking prevention, COI headers, or the video disallowing embeds)`.trim(),
            });
          },
        },
      });
    } catch (e) {
      this._finishStatus({ status: "error", url: videoUrl, title, sourceType: "youtube", message: String(e) });
    }
  },

  _tryNextCandidate() {
    if (this.currentCandidateIndex + 1 >= this.lastCandidates.length) return false;
    this.currentCandidateIndex++;
    const next = this.lastCandidates[this.currentCandidateIndex];
    if (!next) return false;
    // restart play with next (fire and forget)
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    this.playForGame(next, this.activeStatus?.targetVolume ?? 0.3, this.activeStatus?.fadeMs ?? 700, this.activeStatus?.title, this.lastCandidates);
    return true;
  },

  stop(fadeMs = 300, forUrl?: string) {
    if (forUrl && this.activeStatus?.url !== forUrl) return;

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
          const iv = setInterval(() => {
            const t = Math.min(1, (Date.now() - start) / fadeMs);
            a.volume = startVol * (1 - t);
            if (t >= 1) {
              clearInterval(iv);
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
    if (this.fadeInterval) {
      clearInterval(this.fadeInterval);
      this.fadeInterval = null;
    }
    this.activeStatus = null;
    this.sourceType = null;
  },

  // allow the focus container etc to force a user-gesture playback start (needed for YT in some webviews)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  userActivatePlayback() {
    this._stopStatePoller?.();
    const p = this.player;
    if (p && typeof p.playVideo === "function") {
      try { p.playVideo(); } catch {}
    }
    const a = this.audio;
    if (a) {
      try { a.play(); } catch {}
    }
  },
};

// Public API used by grid cards + detail page + now playing
export const gameMusicPlayer = {
  playForGame: (url: string | undefined, vol: number, fade: number, title?: string, cands?: readonly string[]) =>
    gameMusic.playForGame(url, vol, fade, title, cands),
  stop: (fade?: number, url?: string) => gameMusic.stop(fade, url),
  userActivatePlayback: () => gameMusic.userActivatePlayback?.(),
};

export function isAudioUrl(url: string): boolean {
  return /\.(mp3|wav|ogg|opus|m4a|flac|webm|aac)$/i.test((url || "").split("?")[0]) || (url || "").includes("/theme");
}

export function isYoutubeWatchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) && !u.pathname.includes("/embed");
  } catch {
    return false;
  }
}

export function useGameMusic(gameId: number) {
  const { rawEnabled, rawVolume, rawFade } = useConfig((s) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fullscreenConfig = s.config?.interface?.fullscreenConfig as any;

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

// Minimal NowPlaying stub (the real one may live in menubar or a separate component; expose for completeness)
export function GameMusicNowPlaying() {
  return null;
}

// =====================================================
// End of music player
// =====================================================

function getFirstGameId(group: Group) {
  const firstPartitionWithGames = group.partitionedGames.find(
    ([_, games]) => !!games.length,
  );

  return firstPartitionWithGames?.[1][0].id;
}

export function GridGameList() {
  const { activeGroup, allGroups } = useGroupContext();

  const { columns = 4, gap = 20 } =
    useConfig((s) => s.config?.interface?.fullscreenConfig?.gridList) ?? {};

  const getDelay = useCallback(
    (idx: number) => {
      const col = idx % columns;

      return col * 150;
    },
    [columns],
  );

  return allGroups.map((group) =>
    group.id === activeGroup?.id ? (
      <FocusContainer
        key={group.id}
        opts={{
          focusKey: `game-list-${group.id}`,
          saveLastFocusedChild: false,
        }}
        style={{ "--game-cols": columns, "--game-gap": `${gap}px` }}
        className={cn("flex flex-col gap-4 w-full mx-auto py-[20dvh] px-4")}
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
                {games.map((game) => (
                  <div
                    key={game.id}
                    style={{
                      animationDelay: `${getDelay(group.allGames.findIndex(({ id }) => id === game.id))}ms`,
                    }}
                    className={cn(
                      "animate-in fade-in fill-mode-both duration-500",
                    )}
                  >
                    <GameListItem
                      game={game}
                      id={`game-list-${group.id}-${game.id}`}
                      initialFocus={game.id === getFirstGameId(group)}
                    />
                  </div>
                ))}
              </div>
            </FocusContainer>
          ))}
      </FocusContainer>
    ) : null,
  );
}

function GameListItem(props: {
  game: GameWithMetadata;
  id: string;
  initialFocus?: boolean;
}) {
  const { game, id, initialFocus } = props;

  const navigate = useNavigate();
  const { ref } = useFocusable<HTMLDivElement>({
    focusKey: id,
    forceFocus: true,
    initialFocus,
    onFocus: ({ node }) => {
      node?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
      startMusicForThisGame();
    },
  });

  // Also kick music on hover for the card
  const handleMouseEnter = () => {
    startMusicForThisGame();
  };

  const { imageType = "COVER" } =
    useConfig((s) => s.config?.interface?.fullscreenConfig?.gridList) ?? {};

  // Fetch per-game metadata so we can prefer its theme audio (yt-dlp) on hover/focus in the grid
  const { data: metaForMusic } = useGameMetadata({
    request: { gameIds: [game.id] },
    selectFn: (d) => d,
  });

  const musicSourceForHover = useMemo(() => {
    const mp = metaForMusic?.mediaPaths as any;
    let entry: any;
    if (mp) {
      if (typeof mp.get === "function") entry = mp.get(game.id) ?? mp.get(String(game.id));
      else entry = mp[game.id] ?? mp[String(game.id)];
    }
    const themeRel = entry?.themeAudioUrl;
    if (themeRel) {
      // the global player will resolve the magic or use the url
      return themeRel; // relative is fine, player + detail use publicUrl but for simplicity pass full if possible
    }
    const firstAudio = (metaForMusic?.metadata?.videoUrls || []).find(isAudioUrl);
    return firstAudio;
  }, [metaForMusic, game.id]);

  const startMusicForThisGame = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (gameMusicPlayer as any).userActivatePlayback?.();
    if (musicSourceForHover) {
      // Call playForGame so the correct per-game theme / audio is used for this hover
      // (volume/fade will come from config inside the hook usage on detail; here we use defaults that the global player respects)
      gameMusicPlayer.playForGame(musicSourceForHover, 0.35, 600, game.metadata?.name || getFileStub(game.path));
    }
  };

  return (
    <div
      className={cn(
        "group scale-95 focus-within:scale-100 hover:scale-100 transition-all",
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
            })
          }
        >
          <GameImage game={game} kind={imageType} />
        </div>
      </HotkeyLayer>
    </div>
  );
}

function GameImage(props: {
  game: GameWithMetadata;
  kind: InterfaceConfig_GameListEntryImageJson;
}) {
  const { game } = props;
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
  const themeAudioForThisGame = useMemo(() => {
    const mp = data?.mediaPaths as any;
    let entry: any = undefined;
    if (mp) {
      if (typeof mp.get === "function") {
        entry = mp.get(game.id) ?? mp.get(String(game.id));
      } else {
        entry = mp[game.id] ?? mp[String(game.id)];
      }
    }
    const rel = entry?.themeAudioUrl;
    if (rel && publicUrl) {
      return createUrl({ path: rel, base: publicUrl })?.href;
    }
    if (publicUrl) {
      // magic fallback so the player tries theme.* exts
      return createUrl({ path: `media/games/${game.id}/theme`, base: publicUrl })?.href;
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
          "group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0",
          "absolute inset-0",
          "bg-gradient-to-t from-card",
          "ring-ring ring-inset group-focus-within:ring-4",
          props.kind === "BACKGROUND" ? "text-lg py-2 px-4" : "text-2xl p-4",
          "flex items-end font-black",
        )}
      >
        <p className="text-pretty">{gameName}</p>
      </div>
    </div>
  );
}
