import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { useSearchGameSoundtrack } from "@/queries/useSearchGameSoundtrack";
import { useDownloadGameSoundtrack } from "@/mutations/useDownloadGameSoundtrack";
import { setQuickScrollPaused } from "../alphabet-scroll-overlay";
import {
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

type View = "menu" | "music" | "confirm" | "song-details";

export function GridGameContextMenu() {
  const [open, setOpen] = useState(false);
  const [gameId, setGameId] = useState<number | null>(null);
  const [view, setView] = useState<View>("menu");
  // Whether the music (track search) view was reached via "Download Theme Music"
  // from the main menu, or via "Replace Theme Music" from Song Details. BACK
  // returns to wherever it was opened from.
  const musicFrom = useRef<"menu" | "song-details">("menu");
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
    const key = savedFocusKey.current;
    if (key) requestAnimationFrame(() => setFocus(key));
  }, []);

  const openMusic = (from: "menu" | "song-details") => {
    musicFrom.current = from;
    setView("music");
  };

  // BACK steps sub-views back to the action list before closing the menu.
  const handleBack = useCallback(() => {
    if (view === "music") {
      if (musicFrom.current === "song-details") {
        setView("song-details");
        requestAnimationFrame(() => setFocus("game-context-song-replace"));
      } else {
        setView("menu");
        requestAnimationFrame(() => setFocus("game-context-music"));
      }
      return;
    }
    if (view === "song-details") {
      setView("menu");
      requestAnimationFrame(() => setFocus("game-context-music"));
      return;
    }
    if (view === "confirm") {
      setView("menu");
      requestAnimationFrame(() => setFocus("game-context-uninstall"));
      return;
    }
    close();
  }, [view, close]);

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
      ? { accept: "Download", back: "Back" }
      : view === "confirm"
        ? { accept: "Confirm", back: "Cancel" }
        : view === "song-details"
          ? { accept: "Select", back: "Back" }
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
                  ? "Pick a track to use as theme audio."
                  : view === "confirm"
                    ? "This removes the locally installed files."
                    : view === "song-details"
                      ? "Theme music for this game."
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
                  onOpenMusic={() => openMusic("menu")}
                  onOpenSongDetails={() => setView("song-details")}
                  onConfirmUninstall={() => setView("confirm")}
                />
              )}
              {view === "music" && <MusicView onPicked={close} />}
              {view === "song-details" && (
                <SongDetailsView onReplace={() => openMusic("song-details")} />
              )}
              {view === "confirm" && (
                <ConfirmUninstallView onClose={close} onCancel={handleBack} />
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
  onOpenSongDetails: () => void;
  onConfirmUninstall: () => void;
}) {
  const { onClose, onOpenMusic, onOpenSongDetails, onConfirmUninstall } = props;
  const { game, extraMetadata } = useGameDetail();
  const navigate = useNavigate();

  // A downloaded theme persists only its file path (theme_audio_url); its title
  // / source / duration are never saved. Presence of that path is what lets us
  // offer "Song Details" instead of the first-time "Download Theme Music".
  const hasTheme = !!extraMetadata?.mediaPaths?.themeAudioUrl;

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

      {hasTheme ? (
        <ContextRow
          id="game-context-music"
          icon={<Music2 size={18} />}
          onSelect={onOpenSongDetails}
        >
          Song Details
        </ContextRow>
      ) : (
        <ContextRow
          id="game-context-music"
          icon={<Music2 size={18} />}
          onSelect={onOpenMusic}
        >
          Download Theme Music
        </ContextRow>
      )}

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

function ConfirmUninstallView(props: {
  onClose: () => void;
  onCancel: () => void;
}) {
  const { onClose, onCancel } = props;
  const { game, name } = useGameDetail();
  const { mutate: uninstall } = useUninstallGame(game);

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      setFocus("game-context-uninstall-confirm"),
    );
    return () => cancelAnimationFrame(raf);
  }, []);

  const confirm = () => {
    uninstall();
    onClose();
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
        Uninstall <span className="font-semibold text-foreground">{name}</span>?
        You can reinstall it from your library at any time.
      </p>

      <div className="flex flex-col gap-2">
        <ContextRow
          id="game-context-uninstall-confirm"
          icon={<Trash2 size={18} />}
          destructive
          onSelect={confirm}
        >
          Uninstall
        </ContextRow>
        <ContextRow
          id="game-context-uninstall-cancel"
          icon={<X size={18} />}
          onSelect={onCancel}
        >
          Keep Installed
        </ContextRow>
      </div>
    </FocusContainer>
  );
}

function MusicView(props: { onPicked: () => void }) {
  const { onPicked } = props;
  const { game } = useGameDetail();
  const queryClient = useQueryClient();

  const { data, status } = useSearchGameSoundtrack(game.id, { enabled: true });
  const { mutate: download, status: downloadStatus } =
    useDownloadGameSoundtrack();

  const candidates = data?.candidates ?? [];
  const isSearching = status === "pending";
  const isDownloading = downloadStatus === "pending";

  // Focus the first candidate once results arrive (they load async, after the
  // FocusContainer has already mounted).
  useEffect(() => {
    if (candidates.length === 0) return;
    const raf = requestAnimationFrame(() => setFocus("game-context-track-0"));
    return () => cancelAnimationFrame(raf);
  }, [candidates.length]);

  const select = (videoId: string) => {
    if (isDownloading) return;
    download({ gameId: game.id, videoId });
    // The download RPC returns when the job is spawned, not when the file lands.
    // Poll this game's metadata until the new themeAudioUrl appears so the
    // focused grid card picks it up and starts playing without an app refresh.
    // (Also clears the player's stale "missing" cache for this game.)
    pollForDownloadedTheme(queryClient, game.id);
    onPicked();
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
            focusKey={`game-context-track-${idx}`}
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

// Inline detail view for a game that already has a downloaded theme. Only the
// local theme file path is persisted server-side (title / source / duration /
// thumbnail from the original search are never saved), so this honestly shows
// what is known — status + filename — and never fabricates the rest. Replace
// routes into the same inline track-search flow; Remove is intentionally absent
// (no safe per-game removal RPC exists — see report).
function SongDetailsView(props: { onReplace: () => void }) {
  const { onReplace } = props;
  const { name, extraMetadata } = useGameDetail();

  const themeAudioUrl = extraMetadata?.mediaPaths?.themeAudioUrl;
  const fileName = themeAudioUrl
    ? themeAudioUrl
        .split(/[\\/?#]/)
        .filter(Boolean)
        .pop()
    : undefined;

  useEffect(() => {
    const raf = requestAnimationFrame(() =>
      setFocus("game-context-song-replace"),
    );
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <FocusContainer
      opts={{
        focusKey: "game-context-song-details",
        isFocusBoundary: true,
        forceFocus: true,
      }}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
    >
      <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/10 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Music2 size={16} className="text-accent" />
          <span className="truncate">{name}</span>
        </div>

        <dl className="flex flex-col gap-1.5 text-xs">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-medium text-accent-text">Downloaded</dd>
          </div>
          {fileName && (
            <div className="flex items-center justify-between gap-3">
              <dt className="shrink-0 text-muted-foreground">File</dt>
              <dd className="truncate font-mono text-[0.7rem] text-foreground/80">
                {fileName}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className="flex flex-col gap-1">
        <ContextRow
          id="game-context-song-replace"
          icon={<DownloadIcon size={18} />}
          onSelect={onReplace}
        >
          Replace Theme Music
        </ContextRow>
      </div>
    </FocusContainer>
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
          "ring-ring focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-offset-0",
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
