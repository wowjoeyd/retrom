import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menubar/menu-entry-button";
import { HotkeyButton } from "../hotkey-button";
import { useGameDetail } from "@/providers/game-details";
import { LoaderCircle, Music2 } from "lucide-react";
import { useState } from "react";
import { FocusContainer } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useSearchGameSoundtrack } from "@/queries/useSearchGameSoundtrack";
import { useDownloadGameSoundtrack } from "@/mutations/useDownloadGameSoundtrack";
import { cn } from "@retrom/ui/lib/utils";

function formatDuration(secs: number): string {
  if (secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function DownloadMusicAction() {
  const [open, setOpen] = useState(false);
  const { game } = useGameDetail();

  const { data, status: searchStatus } = useSearchGameSoundtrack(game.id, {
    enabled: open,
  });
  const { mutate: download, status: downloadStatus } =
    useDownloadGameSoundtrack();

  const candidates = data?.candidates ?? [];
  const isSearching = searchStatus === "pending" && open;
  const isDownloading = downloadStatus === "pending";

  const handleSelect = (videoId: string) => {
    if (isDownloading) return;
    download({ gameId: game.id, videoId });
    setOpen(false);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton id="download-music-action-open">
          Download Theme Music
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
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
              focusKey: "download-music-action",
              isFocusBoundary: true,
              initialFocus: true,
            }}
            className="flex flex-col h-full"
          >
            <SheetHeader>
              <SheetTitle>Download Theme Music</SheetTitle>
              <SheetDescription>
                Select a track to use as theme audio. Press{" "}
                <strong>Accept</strong> on a result to start the download.
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-col gap-1 flex-1 overflow-y-auto mt-4">
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
                    id={`music-candidate-${idx}`}
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

            <SheetFooter>
              <SheetClose asChild>
                <HotkeyButton hotkey="BACK">Back</HotkeyButton>
              </SheetClose>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
