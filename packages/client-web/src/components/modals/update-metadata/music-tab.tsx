import { useGameDetail } from "@/providers/game-details";
import { useSearchGameSoundtrack } from "@/queries/useSearchGameSoundtrack";
import { useDownloadGameSoundtrack } from "@/mutations/useDownloadGameSoundtrack";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@retrom/ui/components/button";
import { DialogClose, DialogFooter } from "@retrom/ui/components/dialog";
import { cn } from "@retrom/ui/lib/utils";
import {
  DownloadIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  MusicIcon,
} from "lucide-react";
import { useState } from "react";

function formatDuration(secs: number): string {
  if (secs <= 0) return "?:??";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0)
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function MusicTab() {
  const { game } = useGameDetail();
  const navigate = useNavigate();
  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);

  const { data, status } = useSearchGameSoundtrack(game.id);
  const { mutateAsync: download, status: downloadStatus } =
    useDownloadGameSoundtrack();

  const candidates = data?.candidates ?? [];
  const isSearching = status === "pending";
  const isDownloading = downloadStatus === "pending";
  const pending = isSearching || isDownloading;

  const handleDownload = async () => {
    if (!selectedVideoId) return;
    await download({ gameId: game.id, videoId: selectedVideoId });
    // Signal ThemePlayer to poll for the file: the server spawns a background
    // yt-dlp job and returns immediately, so the audio isn't ready yet.
    sessionStorage.setItem(`pendingTheme_${game.id}`, "1");
    await navigate({
      to: ".",
      search: (prev) => ({ ...prev, updateMetadataModal: undefined }),
    });
  };

  return (
    <div className="flex flex-col gap-4 mt-4">
      <p className="text-sm text-muted-foreground">
        Select a YouTube track to use as theme audio. The download runs in the
        background — you can close this dialog immediately after starting it.
      </p>

      {isSearching && (
        <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
          <LoaderCircleIcon className="animate-spin" size={18} />
          <span className="text-sm">Searching YouTube…</span>
        </div>
      )}

      {!isSearching && candidates.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
          <MusicIcon size={32} className="opacity-40" />
          <p className="text-sm">No candidates found for this game.</p>
        </div>
      )}

      {!isSearching && candidates.length > 0 && (
        <ul className="flex flex-col gap-2 max-h-[340px] overflow-y-auto pr-1">
          {candidates.map((c) => {
            const selected = selectedVideoId === c.videoId;
            return (
              <li
                key={c.videoId}
                onClick={() => !pending && setSelectedVideoId(c.videoId)}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-2 cursor-pointer transition-colors",
                  selected
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted/50",
                  pending && "pointer-events-none opacity-60",
                )}
              >
                <img
                  src={c.thumbnailUrl}
                  alt={c.title}
                  className="w-20 h-14 object-cover rounded shrink-0 bg-muted"
                  loading="lazy"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium line-clamp-2 leading-snug">
                    {c.title || "Untitled"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {c.durationSecs > 0 ? formatDuration(c.durationSecs) : ""}
                  </p>
                </div>
                <a
                  href={`https://www.youtube.com/watch?v=${c.videoId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                  title="Preview on YouTube"
                >
                  <ExternalLinkIcon size={14} />
                </a>
              </li>
            );
          })}
        </ul>
      )}

      <DialogFooter className="gap-2 mt-2">
        <DialogClose asChild>
          <Button type="button" variant="secondary" disabled={isDownloading}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="button"
          disabled={!selectedVideoId || pending}
          onClick={handleDownload}
        >
          {isDownloading ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <>
              <DownloadIcon size={14} className="mr-1.5" />
              Download
            </>
          )}
        </Button>
      </DialogFooter>
    </div>
  );
}
