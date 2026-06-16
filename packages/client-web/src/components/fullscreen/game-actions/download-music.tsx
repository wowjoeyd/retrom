import { Sheet, SheetContent, SheetTrigger } from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menubar/menu-entry-button";
import { useGameDetail } from "@/providers/game-details";
import { LoaderCircle, Music2 } from "lucide-react";
import { ReactNode, useEffect, useState } from "react";
import { FocusContainer } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useSearchGameSoundtrack } from "@/queries/useSearchGameSoundtrack";
import { useDownloadGameSoundtrack } from "@/mutations/useDownloadGameSoundtrack";
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

// The same Download/Replace Theme Music flow is surfaced from two places: the
// game-actions sheet (default ids) and the detail page's theme music panel.
// `idPrefix` keeps the spatial-nav focus keys unique between the two mounted
// instances; `restoreFocusKey` returns controller focus to the originating
// button when the sheet closes (the panel needs this since it has no parent
// force-focus container to re-grab focus).
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
    label = "Pick a track to use as theme audio",
    children = "Download Theme Music",
    restoreFocusKey,
  } = props ?? {};

  const openId = `${idPrefix}-open`;
  const candidateKey = (idx: number) => `${idPrefix}-candidate-${idx}`;

  const [open, setOpen] = useState(false);
  const { game } = useGameDetail();
  const queryClient = useQueryClient();

  const { data, status: searchStatus } = useSearchGameSoundtrack(game.id, {
    enabled: open,
  });
  const { mutate: download, status: downloadStatus } =
    useDownloadGameSoundtrack();
  const [inputDevice] = useInputDeviceContext();

  const candidates = data?.candidates ?? [];
  const isSearching = searchStatus === "pending" && open;
  const isDownloading = downloadStatus === "pending";

  // RAF deferral: focus first candidate after the full norigin tree is settled.
  // Needed on first open because candidates arrive async — the FocusContainer
  // initialFocus fires before candidate MenuEntryButtons are registered.
  // Also guards against Radix's onOpenAutoFocus stealing native focus to the
  // Back button (blocked via onOpenAutoFocus={preventDefault} on SheetContent).
  useEffect(() => {
    if (!open || candidates.length === 0) return;
    if (inputDevice !== "gamepad" && inputDevice !== "hotkeys") return;
    const raf = requestAnimationFrame(() => {
      setFocus(candidateKey(0));
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, candidates.length, inputDevice]);

  const handleSelect = (videoId: string) => {
    if (isDownloading) return;
    // Clear the "missing" result cache so the player retries the theme URL
    // after the download completes and metadata refetches.
    gameMusicPlayer.clearCacheForGame(game.id);
    download({ gameId: game.id, videoId });
    // The download RPC returns when the job is spawned, not when the file lands.
    // Poll this game's metadata until the new themeAudioUrl appears so both the
    // detail music panel and the grid card pick it up without an app refresh.
    pollForDownloadedTheme(queryClient, game.id);
    setOpen(false);
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
            BACK: { handler: () => setOpen(false) },
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
              title="Download Theme Music"
              subtitle="Pick a track to use as theme audio"
            />

            <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
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
                    icon={<Music2 size={18} />}
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
            </div>

            <PanelHints
              hints={[
                ...(candidates.length > 0
                  ? [{ hotkey: "ACCEPT" as const, label: "Download" }]
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
