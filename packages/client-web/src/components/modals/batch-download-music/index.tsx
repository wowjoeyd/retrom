import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { Button } from "@retrom/ui/components/button";
import { LoaderCircleIcon, MusicIcon, CheckCircleIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Route as RootRoute } from "@/routes/__root";
import { useCallback, useMemo } from "react";
import { useGames } from "@/queries/useGames";
import { useGameMetadata } from "@/queries/useGameMetadata";
import { useAutoDownloadGameSoundtrack } from "@/mutations/useAutoDownloadGameSoundtrack";

export function BatchDownloadMusicModal() {
  const navigate = useNavigate();
  const { batchDownloadMusicModal } = RootRoute.useSearch();

  const close = useCallback(() => {
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, batchDownloadMusicModal: undefined }),
    });
  }, [navigate]);

  const { data: gamesData, status: gamesStatus } = useGames();
  const { data: metaData, status: metaStatus } = useGameMetadata({
    enabled: !!gamesData?.games?.length,
  });

  const { mutate: autoDownload, status: downloadStatus } =
    useAutoDownloadGameSoundtrack();

  const isLoading =
    gamesStatus === "pending" || metaStatus === "pending";
  const isDownloading = downloadStatus === "pending";

  const { missingIds, totalGames } = useMemo(() => {
    const games = gamesData?.games ?? [];
    const totalGames = games.length;

    if (!metaData) return { missingIds: [], totalGames };

    // mediaPaths is a map<int32, MediaPaths> — access as plain object
    const mediaPaths = metaData.mediaPaths as Record<
      string,
      { themeAudioUrl?: string }
    >;

    const missingIds = games
      .filter((g) => {
        const paths = mediaPaths[String(g.id)];
        return !paths?.themeAudioUrl;
      })
      .map((g) => g.id);

    return { missingIds, totalGames };
  }, [gamesData, metaData]);

  const hasThemeCount = totalGames - missingIds.length;

  const handleDownloadAll = () => {
    if (!missingIds.length) return;
    autoDownload(missingIds);
    close();
  };

  return (
    <Dialog
      open={!!batchDownloadMusicModal?.open}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Batch Download Music</DialogTitle>
          <DialogDescription>
            Auto-search YouTube and download theme audio for all games that
            don&apos;t already have one. Downloads run in the background with a
            2-at-a-time limit.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
            <LoaderCircleIcon className="animate-spin" size={20} />
            <span className="text-sm">Loading library…</span>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 py-4">
                <CheckCircleIcon
                  size={22}
                  className="text-green-500 dark:text-green-400"
                />
                <span className="text-2xl font-semibold">{hasThemeCount}</span>
                <span className="text-xs text-muted-foreground">
                  Have theme audio
                </span>
              </div>
              <div className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 py-4">
                <MusicIcon
                  size={22}
                  className="text-muted-foreground opacity-60"
                />
                <span className="text-2xl font-semibold">
                  {missingIds.length}
                </span>
                <span className="text-xs text-muted-foreground">
                  Missing theme audio
                </span>
              </div>
            </div>

            {missingIds.length === 0 ? (
              <p className="text-sm text-center text-muted-foreground py-2">
                All games already have theme audio.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Clicking <strong>Download Missing</strong> will queue
                auto-searches for the {missingIds.length} game
                {missingIds.length !== 1 ? "s" : ""} listed above. Games where
                no YouTube match is found will be silently skipped.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button type="button" variant="secondary" disabled={isDownloading}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={isLoading || isDownloading || missingIds.length === 0}
            onClick={handleDownloadAll}
          >
            {isDownloading ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <>
                <MusicIcon size={14} className="mr-1.5" />
                Download Missing
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Re-export so _layout.tsx can import from the folder
export { BatchDownloadMusicModal as default };
