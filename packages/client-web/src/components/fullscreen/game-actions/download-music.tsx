import { Sheet, SheetContent, SheetTrigger } from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menubar/menu-entry-button";
import { useGameDetail } from "@/providers/game-details";
import { LoaderCircle, Music2, Plus, Trash2, X } from "lucide-react";
import { ReactNode, useEffect, useMemo, useState } from "react";
import { FocusContainer } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useSearchGameSoundtrack } from "@/queries/useSearchGameSoundtrack";
import { useDownloadGameSoundtrack } from "@/mutations/useDownloadGameSoundtrack";
import { useDeleteGameSoundtrackTrack } from "@/mutations/useDeleteGameSoundtrackTrack";
import { cn } from "@retrom/ui/lib/utils";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useInputDeviceContext } from "@/providers/input-device";
import { gameMusicPlayer, pollForDownloadedTheme } from "../grid-game-list";
import { PanelHeader, PanelHints } from "../menubar/panel-chrome";
import { PANEL_CONTENT_CLASS } from "../menubar/menu-sheet";
import { useQueryClient } from "@tanstack/react-query";

function formatDuration(secs: number): string {
  if (secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function trackFilename(rel: string): string {
  return (
    rel
      .split(/[\\/?#]/)
      .filter(Boolean)
      .pop() ?? rel
  );
}

// Theme music management: lists the game's existing tracks (with delete +
// confirmation) and lets the user add more by searching YouTube. Downloading
// APPENDS a new track (the server picks the next playlist slot), so a game can
// have a multi-track soundtrack. Surfaced from the game-actions sheet.
//
// `idPrefix` keeps the spatial-nav focus keys unique; `restoreFocusKey` returns
// controller focus to the originating button when the sheet closes.
export function DownloadMusicAction(props?: {
  idPrefix?: string;
  icon?: ReactNode;
  label?: string;
  children?: ReactNode;
  restoreFocusKey?: string;
}) {
  const {
    idPrefix = "download-music-action",
    icon = <Music2 size={18} />,
    label = "Manage this game's theme tracks",
    children = "Theme Music",
    restoreFocusKey,
  } = props ?? {};

  const openId = `${idPrefix}-open`;
  const candidateKey = (idx: number) => `${idPrefix}-candidate-${idx}`;
  const trackKey = (idx: number) => `${idPrefix}-track-${idx}`;

  const [open, setOpen] = useState(false);
  const { game, extraMetadata } = useGameDetail();
  const queryClient = useQueryClient();

  const { data, status: searchStatus } = useSearchGameSoundtrack(game.id, {
    enabled: open,
  });
  const { mutate: download, status: downloadStatus } =
    useDownloadGameSoundtrack();
  const { mutate: deleteTrack } = useDeleteGameSoundtrackTrack();
  const [inputDevice] = useInputDeviceContext();

  // The game's current playlist (parallel URL/title arrays from the server).
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
  const isSearching = searchStatus === "pending" && open;
  const isDownloading = downloadStatus === "pending";

  // Track pending a delete confirmation (null = no confirmation showing).
  const [confirming, setConfirming] = useState<{
    filename: string;
    title: string;
  } | null>(null);

  // Focus management: confirmation → focus the destructive confirm button;
  // otherwise focus the first track (if any) or the first candidate once loaded.
  useEffect(() => {
    if (!open) return;
    if (inputDevice !== "gamepad" && inputDevice !== "hotkeys") return;
    const raf = requestAnimationFrame(() => {
      if (confirming) {
        setFocus(`${idPrefix}-confirm-delete`);
      } else if (tracks.length > 0) {
        setFocus(trackKey(0));
      } else if (candidates.length > 0) {
        setFocus(candidateKey(0));
      }
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, confirming, tracks.length, candidates.length, inputDevice]);

  const handleSelect = (videoId: string) => {
    if (isDownloading) return;
    // Clear the "missing" result cache so the player retries the theme URL
    // after the download completes and metadata refetches.
    gameMusicPlayer.clearCacheForGame(game.id);
    download({ gameId: game.id, videoId });
    // The download RPC returns when the job is spawned, not when the file lands.
    // Poll this game's metadata until the new track appears so the soundtrack
    // module + grid card pick it up without an app refresh.
    pollForDownloadedTheme(queryClient, game.id);
    setOpen(false);
  };

  const handleConfirmDelete = () => {
    if (!confirming) return;
    deleteTrack({ gameId: game.id, filename: confirming.filename });
    pollForDownloadedTheme(queryClient, game.id);
    setConfirming(null);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton id={openId} icon={icon} label={label}>
          {children}
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent
        className={PANEL_CONTENT_CLASS}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (restoreFocusKey) {
            requestAnimationFrame(() => setFocus(restoreFocusKey));
          }
        }}
      >
        <HotkeyLayer
          allowBubbling="never"
          handlers={{
            BACK: {
              handler: () =>
                confirming ? setConfirming(null) : setOpen(false),
            },
          }}
        >
          <FocusContainer
            opts={{
              focusKey: idPrefix,
              isFocusBoundary: true,
              initialFocus: true,
            }}
            className="flex h-full flex-col"
          >
            <PanelHeader
              icon={<Music2 size={20} />}
              title="Theme Music"
              subtitle="Manage this game's theme tracks"
            />

            <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
              {confirming ? (
                <div className="flex flex-col gap-3 p-2">
                  <p className="text-sm text-foreground/90">
                    Delete{" "}
                    <span className="font-semibold">“{confirming.title}”</span>?
                    This removes the track file and can&apos;t be undone.
                  </p>
                  <MenuEntryButton
                    id={`${idPrefix}-confirm-delete`}
                    icon={<Trash2 size={18} />}
                    destructive
                    onClick={handleConfirmDelete}
                    handlers={{
                      ACCEPT: {
                        handler: handleConfirmDelete,
                        actionBar: { label: "Delete", position: "right" },
                      },
                    }}
                  >
                    Delete track
                  </MenuEntryButton>
                  <MenuEntryButton
                    id={`${idPrefix}-cancel-delete`}
                    icon={<X size={18} />}
                    onClick={() => setConfirming(null)}
                    handlers={{
                      ACCEPT: { handler: () => setConfirming(null) },
                    }}
                  >
                    Cancel
                  </MenuEntryButton>
                </div>
              ) : (
                <>
                  {tracks.length > 0 && (
                    <>
                      <p className="px-2 pb-1 pt-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                        Your tracks
                      </p>
                      {tracks.map((track, idx) => (
                        <MenuEntryButton
                          key={track.filename}
                          id={trackKey(idx)}
                          icon={<Trash2 size={18} />}
                          label="Remove this track"
                          onClick={() => setConfirming(track)}
                          handlers={{
                            ACCEPT: {
                              handler: () => setConfirming(track),
                              actionBar: { label: "Delete", position: "right" },
                            },
                          }}
                        >
                          {track.title}
                        </MenuEntryButton>
                      ))}
                      <div className="my-2 h-px bg-border/60" />
                    </>
                  )}

                  <p className="px-2 pb-1 pt-1 text-[0.65rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                    Add a track
                  </p>

                  {isSearching && (
                    <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
                      <LoaderCircle className="animate-spin" size={20} />
                      <span className="text-sm">Searching YouTube…</span>
                    </div>
                  )}

                  {!isSearching && candidates.length === 0 && open && (
                    <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                      <Music2 size={32} className="opacity-40" />
                      <p className="text-sm">No candidates found.</p>
                    </div>
                  )}

                  {!isSearching &&
                    candidates.map((c, idx) => (
                      <MenuEntryButton
                        key={c.videoId}
                        id={candidateKey(idx)}
                        icon={<Plus size={18} />}
                        label={formatDuration(c.durationSecs) || undefined}
                        disabled={isDownloading}
                        className={cn(isDownloading && "opacity-50")}
                        onClick={() => handleSelect(c.videoId)}
                        handlers={{
                          ACCEPT: {
                            handler: () => handleSelect(c.videoId),
                            actionBar: {
                              label: "Download",
                              position: "right",
                            },
                          },
                        }}
                      >
                        {c.title || "Untitled"}
                      </MenuEntryButton>
                    ))}
                </>
              )}
            </div>

            <PanelHints
              hints={[
                ...(confirming
                  ? [{ hotkey: "ACCEPT" as const, label: "Confirm" }]
                  : candidates.length > 0
                    ? [{ hotkey: "ACCEPT" as const, label: "Select" }]
                    : []),
                { hotkey: "BACK" as const, label: "Back" },
              ]}
            />
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
