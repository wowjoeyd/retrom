import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  getCurrentFocusKey,
  setFocus,
} from "@noriginmedia/norigin-spatial-navigation";
import {
  DownloadIcon,
  Info,
  LoaderCircle,
  Music2,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { useHotkeys } from "@/providers/hotkeys";
import { useHotkeyMapping } from "@/providers/hotkeys/mapping";
import { GamepadButtonDownEvent } from "@/providers/gamepad/event";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer, useFocusable } from "../focus-container";
import { HotkeyIcon } from "../hotkey-button";
import { ActionButton } from "@/components/action-button";
import { GameDetailProvider, useGameDetail } from "@/providers/game-details";
import { useGroupContext } from "@/providers/fullscreen/group-context";
import { getFileStub, Image } from "@/lib/utils";
import { checkIsDesktop } from "@/lib/env";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { useInstallGame } from "@/mutations/useInstallGame";
import { useUninstallGame } from "@/mutations/useUninstallGame";
import { useRefreshGameMetadata } from "@/mutations/useRefreshGameMetadata";
import { useSearchGameSoundtrack } from "@/queries/useSearchGameSoundtrack";
import { useDownloadGameSoundtrack } from "@/mutations/useDownloadGameSoundtrack";
import { useDeleteGameSoundtrackTrack } from "@/mutations/useDeleteGameSoundtrackTrack";
import { setQuickScrollPaused } from "../alphabet-scroll-overlay";
import {
  gameMusicPlayer,
  pollForDownloadedTheme,
  setGridAutoFocusSuppressed,
} from "../grid-game-list";
import { useQueryClient } from "@tanstack/react-query";

declare global {
  export interface HotkeyZones {
    gameContextMenu: boolean;
  }
}

// Card focus keys are `game-list-{groupId}-{gameId}`; pull the game id back out
// so OPTION on a focused card knows which game to act on (and ignores OPTION
// pressed anywhere that isn't a game card).
const CARD_FOCUS_KEY = /^game-list-(-?\d+)-(\d+)$/;

// On open, spatial-nav focus can lose a race with Radix's FocusScope and land on
// the dialog container (a <div>) instead of the first action button. setFocus
// only updates spatial-nav's *internal* key, so checking getCurrentFocusKey()
// isn't enough — Radix can steal *DOM* focus back to the container afterwards
// while the key still reads as the button (leaving the white container focus
// ring, and BACK broken because events then bubble away from the in-tree
// HotkeyLayer). Retry across frames until a real <button> actually holds DOM
// focus — the container is a div, every action/Play row is a <button> — and keep
// re-asserting setFocus until then. Stops immediately once any button is focused
// (so D-pad navigation away is never yanked back). Returns a cleanup that cancels
// the pending frame (for use directly as a useEffect callback).
function focusFirstAction(focusKey: string, maxMs = 600) {
  const start = performance.now();
  let raf = 0;
  const tick = () => {
    const landed = document.activeElement instanceof HTMLButtonElement;
    if (!landed) setFocus(focusKey);
    if (!landed && performance.now() - start < maxMs) {
      raf = requestAnimationFrame(tick);
    }
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

type View = "menu" | "music" | "confirm";

// What the shared confirm view is asking the user to confirm. Uninstall returns
// to the action list; a track delete returns to the (multi-track) music view.
type ConfirmTarget =
  | { kind: "uninstall" }
  | { kind: "track"; filename: string; title: string };

export function GridGameContextMenu() {
  const [open, setOpen] = useState(false);
  const [gameId, setGameId] = useState<number | null>(null);
  const [view, setView] = useState<View>("menu");
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(
    null,
  );
  const savedFocusKey = useRef<string | undefined>(undefined);
  const contentRef = useRef<HTMLDivElement>(null);
  const { activeGroup } = useGroupContext();
  const { keyboardToHotkey, gamepadToHotkey } = useHotkeyMapping();

  useHotkeys({
    enabled: !open,
    handlers: {
      OPTION: {
        handler: () => {
          const key = getCurrentFocusKey();
          const match = key?.match(CARD_FOCUS_KEY);
          if (!key || !match) return;
          savedFocusKey.current = key;
          setGameId(Number(match[2]));
          setConfirmTarget(null);
          setView("menu");
          setOpen(true);
        },
      },
    },
  });

  // While the menu owns focus, pause quick-scroll and stop grid cards from
  // grabbing focus (same guard the filter sheet uses).
  useEffect(() => {
    setQuickScrollPaused(open);
    setGridAutoFocusSuppressed(open);
    return () => {
      setQuickScrollPaused(false);
      setGridAutoFocusSuppressed(false);
    };
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setView("menu");
    setConfirmTarget(null);
    const key = savedFocusKey.current;
    if (key) requestAnimationFrame(() => setFocus(key));
  }, []);

  const openMusic = useCallback(() => {
    setConfirmTarget(null);
    setView("music");
  }, []);

  const requestUninstall = useCallback(() => {
    setConfirmTarget({ kind: "uninstall" });
    setView("confirm");
  }, []);

  const requestDeleteTrack = useCallback(
    (track: { filename: string; title: string }) => {
      setConfirmTarget({ kind: "track", ...track });
      setView("confirm");
    },
    [],
  );

  // BACK steps sub-views back before closing the menu. A track-delete confirm
  // returns to the (multi-track) music view so the playlist stays in context;
  // everything else returns to the action list.
  const handleBack = useCallback(() => {
    if (view === "music") {
      setView("menu");
      requestAnimationFrame(() => setFocus("game-context-music"));
      return;
    }
    if (view === "confirm") {
      const wasTrack = confirmTarget?.kind === "track";
      setConfirmTarget(null);
      setView(wasTrack ? "music" : "menu");
      if (!wasTrack) {
        requestAnimationFrame(() => setFocus("game-context-uninstall"));
      }
      return;
    }
    close();
  }, [view, confirmTarget, close]);

  // Defensive BACK: while the first action is still settling into focus, Radix's
  // FocusScope can briefly park DOM focus on the dialog container (a <div>). The
  // in-tree HotkeyLayer is a *descendant* of that container, so a keydown/gamepad
  // event dispatched on the focused container bubbles *up* and never reaches the
  // layer — leaving BACK dead until the user nudged focus onto a button. Listen
  // on the container itself and act only while it actually holds focus, so a BACK
  // the HotkeyLayer already handled (focus on a button) is never double-fired.
  useEffect(() => {
    if (!open) return;
    const node = contentRef.current;
    if (!node) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement !== node) return;
      if (keyboardToHotkey[e.key] === "BACK") {
        e.preventDefault();
        e.stopPropagation();
        handleBack();
      }
    };

    const onGamepadButton = (e: GamepadButtonDownEvent) => {
      if (document.activeElement !== node) return;
      if (gamepadToHotkey[e.detail.button] === "BACK") {
        e.stopPropagation();
        handleBack();
      }
    };

    node.addEventListener("keydown", onKeyDown);
    node.addEventListener(GamepadButtonDownEvent.EVENT_NAME, onGamepadButton);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener(
        GamepadButtonDownEvent.EVENT_NAME,
        onGamepadButton,
      );
    };
  }, [open, handleBack, keyboardToHotkey, gamepadToHotkey]);

  // Title/cover come straight from the already-loaded grid data so the header
  // renders instantly (and the Dialog stays accessible) while the detail
  // provider resolves the full record the actions need.
  const focusedGame = activeGroup?.allGames.find((g) => g.id === gameId);
  const title =
    focusedGame?.metadata?.name ?? getFileStub(focusedGame?.path ?? "");
  const coverUrl = focusedGame?.metadata?.coverUrl;

  const footer =
    view === "music"
      ? { accept: "Select", back: "Back" }
      : view === "confirm"
        ? { accept: "Confirm", back: "Cancel" }
        : { accept: "Select", back: "Close" };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true);
        else close();
      }}
    >
      <DialogContent
        ref={contentRef}
        centered
        userCanClose={false}
        overlayClassName="bg-background/70 backdrop-blur-sm"
        className="w-[23rem] max-w-[92vw] gap-0 overflow-hidden border-border/80 outline-none focus:outline-none focus-visible:outline-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <HotkeyLayer
          id="game-context-menu"
          allowBubbling="never"
          handlers={{
            BACK: { handler: handleBack, zone: "gameContextMenu" },
            MENU: { handler: () => {}, zone: "gameContextMenu" },
            SORT: { handler: () => {}, zone: "gameContextMenu" },
            FILTER: { handler: () => {}, zone: "gameContextMenu" },
          }}
        >
          <div className="flex shrink-0 items-center gap-3 border-b bg-muted/20 px-5 py-4">
            <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-muted/40 shadow-sm">
              {coverUrl && (
                <Image
                  src={coverUrl}
                  width={48}
                  height={64}
                  alt={title}
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <DialogHeader className="mb-0 min-w-0 space-y-0.5 text-left">
              <DialogTitle className="truncate text-lg leading-tight">
                {title || "Game"}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {view === "music"
                  ? "Manage this game's theme tracks."
                  : view === "confirm"
                    ? confirmTarget?.kind === "track"
                      ? "This permanently deletes the track file."
                      : "This removes the locally installed files."
                    : "Choose an action for this game."}
              </DialogDescription>
            </DialogHeader>
          </div>

          {gameId != null && (
            <GameDetailProvider
              gameId={gameId}
              deferEmulatorData
              loadingComponent={<MenuLoading />}
            >
              {view === "menu" && (
                <MenuView
                  onClose={close}
                  onOpenMusic={openMusic}
                  onConfirmUninstall={requestUninstall}
                />
              )}
              {view === "music" && (
                <MusicView
                  onDownloaded={close}
                  onRequestDelete={requestDeleteTrack}
                />
              )}
              {view === "confirm" && confirmTarget && (
                <ConfirmView
                  target={confirmTarget}
                  onUninstalled={close}
                  onTrackDeleted={() => {
                    setConfirmTarget(null);
                    setView("music");
                  }}
                  onCancel={handleBack}
                />
              )}
            </GameDetailProvider>
          )}

          <div className="flex shrink-0 items-center justify-end gap-4 border-t bg-muted/10 px-5 py-2.5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <HotkeyIcon hotkey="ACCEPT" />
              {footer.accept}
            </span>
            <span className="flex items-center gap-1.5">
              <HotkeyIcon hotkey="BACK" />
              {footer.back}
            </span>
          </div>
        </HotkeyLayer>
      </DialogContent>
    </Dialog>
  );
}

function MenuLoading() {
  return (
    <div className="flex items-center justify-center gap-2 px-5 py-12 text-muted-foreground">
      <LoaderCircle className="animate-spin" size={20} />
      <span className="text-sm">Loading…</span>
    </div>
  );
}

function MenuView(props: {
  onClose: () => void;
  onOpenMusic: () => void;
  onConfirmUninstall: () => void;
}) {
  const { onClose, onOpenMusic, onConfirmUninstall } = props;
  const { game, gameMetadata, platformMetadata } = useGameDetail();
  const navigate = useNavigate();

  const { mutate: refreshMetadata } = useRefreshGameMetadata();

  const installationStatus = useInstallationStatus(game.id);
  const isInstalled = installationStatus === InstallationStatus.INSTALLED;
  const isInstalling =
    installationStatus === InstallationStatus.INSTALLING ||
    installationStatus === InstallationStatus.PAUSED;
  const canInstall =
    checkIsDesktop() && !game.thirdParty && !isInstalled && !isInstalling;

  const { mutate: install } = useInstallGame(game.id);

  // Land focus on the primary (Play) action once the rows have mounted. Retries
  // across frames so it never gets stuck on the dialog container (see bug).
  useEffect(() => focusFirstAction("game-context-play"), []);

  const viewDetails = () => {
    // Navigating unmounts the grid route (and this menu); restoreGridFocus lets
    // Back from the detail page return to this same card.
    void navigate({
      to: "/fullscreen/games/$gameId",
      params: { gameId: game.id.toString() },
      search: (prev) => ({ ...prev, restoreGridFocus: true }),
    });
  };

  return (
    <FocusContainer
      opts={{
        focusKey: "game-context-menu-list",
        isFocusBoundary: true,
        forceFocus: true,
      }}
      className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3"
    >
      <PlayRow onLaunch={onClose} />

      {canInstall && (
        <ContextRow
          id="game-context-install"
          icon={<DownloadIcon size={18} />}
          onSelect={() => {
            install(undefined);
            onClose();
          }}
        >
          Install
        </ContextRow>
      )}

      {isInstalled && (
        <ContextRow
          id="game-context-uninstall"
          icon={<Trash2 size={18} />}
          destructive
          onSelect={onConfirmUninstall}
        >
          Uninstall
        </ContextRow>
      )}

      <ContextRow
        id="game-context-view-details"
        icon={<Info size={18} />}
        onSelect={viewDetails}
      >
        View Details
      </ContextRow>

      <ContextRow
        id="game-context-music"
        icon={<Music2 size={18} />}
        onSelect={onOpenMusic}
      >
        Theme Music
      </ContextRow>

      <ContextRow
        id="game-context-refresh-metadata"
        icon={<RefreshCw size={18} />}
        onSelect={() => {
          refreshMetadata({ game, gameMetadata, platformMetadata });
          onClose();
        }}
      >
        Refresh Metadata
      </ContextRow>

      <ContextRow
        id="game-context-cancel"
        icon={<X size={18} />}
        onSelect={onClose}
      >
        Cancel
      </ContextRow>
    </FocusContainer>
  );
}

// Shared confirm view for the menu's two destructive actions: uninstalling the
// game (returns to the action list) and deleting one theme track (returns to the
// music view). Both back out via onCancel.
function ConfirmView(props: {
  target: ConfirmTarget;
  onUninstalled: () => void;
  onTrackDeleted: () => void;
  onCancel: () => void;
}) {
  const { target, onUninstalled, onTrackDeleted, onCancel } = props;
  const { game, name } = useGameDetail();
  const queryClient = useQueryClient();
  const { mutate: uninstall } = useUninstallGame(game);
  const { mutate: deleteTrack } = useDeleteGameSoundtrackTrack();

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      setFocus("game-context-confirm-accept"),
    );
    return () => cancelAnimationFrame(raf);
  }, []);

  const isTrack = target.kind === "track";

  const confirm = () => {
    if (target.kind === "track") {
      // Clear the player's "missing" cache so it re-resolves after the playlist
      // shrinks, and poll until the change lands (mirrors the Actions panel).
      gameMusicPlayer.clearCacheForGame(game.id);
      deleteTrack({ gameId: game.id, filename: target.filename });
      pollForDownloadedTheme(queryClient, game.id);
      onTrackDeleted();
    } else {
      uninstall();
      onUninstalled();
    }
  };

  return (
    <FocusContainer
      opts={{
        focusKey: "game-context-confirm",
        isFocusBoundary: true,
        forceFocus: true,
      }}
      className="flex min-h-0 flex-1 flex-col gap-4 p-5"
    >
      <p className="text-sm text-muted-foreground">
        {isTrack ? (
          <>
            Delete{" "}
            <span className="font-semibold text-foreground">
              “{target.title}”
            </span>
            ? This removes the track file and can&apos;t be undone.
          </>
        ) : (
          <>
            Uninstall{" "}
            <span className="font-semibold text-foreground">{name}</span>? You
            can reinstall it from your library at any time.
          </>
        )}
      </p>

      <div className="flex flex-col gap-2">
        <ContextRow
          id="game-context-confirm-accept"
          icon={<Trash2 size={18} />}
          destructive
          onSelect={confirm}
        >
          {isTrack ? "Delete track" : "Uninstall"}
        </ContextRow>
        <ContextRow
          id="game-context-confirm-cancel"
          icon={<X size={18} />}
          onSelect={onCancel}
        >
          {isTrack ? "Keep track" : "Keep Installed"}
        </ContextRow>
      </div>
    </FocusContainer>
  );
}

// Multi-track theme manager: lists the game's existing tracks (each row deletes,
// via a confirm) and lets the user append more by searching YouTube. Downloading
// APPENDS a track (the server picks the next playlist slot), so a game can hold a
// multi-track soundtrack — the same flow the detail-page Actions panel uses, so
// both surfaces stay consistent.
function MusicView(props: {
  onDownloaded: () => void;
  onRequestDelete: (track: { filename: string; title: string }) => void;
}) {
  const { onDownloaded, onRequestDelete } = props;
  const { game, extraMetadata } = useGameDetail();
  const queryClient = useQueryClient();

  const { data, status } = useSearchGameSoundtrack(game.id, { enabled: true });
  const { mutate: download, status: downloadStatus } =
    useDownloadGameSoundtrack();

  // The game's current playlist (parallel URL/title arrays from the server, with
  // a fallback to the legacy single-track field).
  const tracks = useMemo(() => {
    const mp = extraMetadata?.mediaPaths;
    const urls = mp?.themeAudioUrls?.length
      ? mp.themeAudioUrls
      : mp?.themeAudioUrl
        ? [mp.themeAudioUrl]
        : [];
    const titles = mp?.themeAudioTitles ?? [];
    return urls.map((rel, i) => ({
      filename: trackFilename(rel),
      title: titles[i]?.trim() || "Theme",
    }));
  }, [extraMetadata?.mediaPaths]);

  const candidates = data?.candidates ?? [];
  const isSearching = status === "pending";
  const isDownloading = downloadStatus === "pending";

  // Focus the first existing track if any, else the first search candidate once
  // results arrive (they load async, after the FocusContainer has mounted).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (tracks.length > 0) {
        setFocus("game-context-track-existing-0");
      } else if (candidates.length > 0) {
        setFocus("game-context-candidate-0");
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [tracks.length, candidates.length]);

  const select = (videoId: string) => {
    if (isDownloading) return;
    // Clear the player's stale "missing" cache for this game, then start the
    // download. The RPC returns when the job is spawned, not when the file lands,
    // so poll this game's metadata until the new track appears and the focused
    // grid card picks it up without an app refresh.
    gameMusicPlayer.clearCacheForGame(game.id);
    download({ gameId: game.id, videoId });
    pollForDownloadedTheme(queryClient, game.id);
    onDownloaded();
  };

  return (
    <FocusContainer
      opts={{
        focusKey: "game-context-music-list",
        isFocusBoundary: true,
        forceFocus: true,
      }}
      className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-3"
    >
      {tracks.length > 0 && (
        <>
          <p className="px-2 pb-1 pt-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Your tracks
          </p>
          {tracks.map((track, idx) => (
            <ContextRow
              key={track.filename}
              id={`game-context-track-existing-${idx}`}
              icon={<Trash2 size={18} />}
              destructive
              onSelect={() => onRequestDelete(track)}
            >
              {track.title}
            </ContextRow>
          ))}
          <div className="my-1.5 h-px bg-border/60" />
        </>
      )}

      <p className="px-2 pb-1 pt-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
        Add a track
      </p>

      {isSearching && (
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <LoaderCircle className="animate-spin" size={18} />
          <span className="text-sm">Searching YouTube…</span>
        </div>
      )}

      {!isSearching && candidates.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
          <Music2 size={28} className="opacity-40" />
          <p className="text-sm">No tracks found.</p>
        </div>
      )}

      {!isSearching &&
        candidates.map((c, idx) => (
          <TrackRow
            key={c.videoId}
            focusKey={`game-context-candidate-${idx}`}
            title={c.title || "Untitled"}
            thumbnailUrl={c.thumbnailUrl}
            duration={formatDuration(c.durationSecs)}
            disabled={isDownloading}
            onSelect={() => select(c.videoId)}
          />
        ))}
    </FocusContainer>
  );
}

// Pull the track file's name out of its (possibly URL-encoded) path so it can be
// handed back to the per-track delete RPC.
function trackFilename(rel: string): string {
  return (
    rel
      .split(/[\\/?#]/)
      .filter(Boolean)
      .pop() ?? rel
  );
}

function TrackRow(props: {
  focusKey: string;
  title: string;
  thumbnailUrl?: string;
  duration: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const { focusKey, title, thumbnailUrl, duration, disabled, onSelect } = props;

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: onSelect } }}>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        disabled={disabled}
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-3 rounded-md border border-transparent p-1.5 text-left outline-none transition-colors",
          "focus-hover:border-accent/60 focus-hover:bg-accent/10",
          disabled && "opacity-50",
        )}
      >
        <div className="h-12 w-[5.25rem] shrink-0 overflow-hidden rounded bg-muted">
          {thumbnailUrl && (
            <Image
              src={thumbnailUrl}
              alt={title}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug">
            {title}
          </p>
          {duration && (
            <p className="mt-0.5 text-xs text-muted-foreground">{duration}</p>
          )}
        </div>
      </button>
    </HotkeyLayer>
  );
}

// A uniform, controller-friendly action row. Mirrors MenuEntryButton focus
// behaviour but lets us add a leading icon and destructive styling.
function ContextRow(props: {
  id: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  const { id, icon, children, onSelect, destructive } = props;

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: id,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: onSelect } }}>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onSelect}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-4 py-2.5 text-left text-base font-semibold outline-none transition-colors",
          "text-foreground focus-hover:bg-secondary/40",
          destructive
            ? "text-destructive focus-hover:bg-destructive/10 focus-hover:text-destructive"
            : "focus-hover:text-accent-text",
        )}
      >
        {icon}
        {children}
      </button>
    </HotkeyLayer>
  );
}

// The Play row reuses the shared ActionButton (full launch behaviour: install-
// on-play, emulator resolution, Steam launch, stop-if-running). We wrap it so a
// controller ACCEPT clicks it and then closes the menu.
function PlayRow(props: { onLaunch: () => void }) {
  const { onLaunch } = props;
  const { game } = useGameDetail();

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: "game-context-play",
    initialFocus: true,
    forceFocus: true,
    onFocus: ({ node }) => node?.focus({ preventScroll: true }),
  });

  const activate = () => {
    ref.current?.click();
    onLaunch();
  };

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: activate } }}>
      <ActionButton
        ref={ref}
        game={game}
        className={cn(
          "mb-1 h-max w-full justify-start rounded-md px-4 py-3 text-base font-semibold",
          "focus-hover:shadow-[var(--fs-focus-glow)]",
        )}
      />
    </HotkeyLayer>
  );
}

function formatDuration(secs: number): string {
  if (secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
