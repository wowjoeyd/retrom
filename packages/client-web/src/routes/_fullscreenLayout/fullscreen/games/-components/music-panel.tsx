import { useMemo } from "react";
import { Music2, Music4 } from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import { useGameMusicStatus } from "@/components/fullscreen/grid-game-list";
import { DownloadMusicAction } from "@/components/fullscreen/game-actions/download-music";
import { Image } from "@/lib/utils";
import { createUrl, usePublicUrl } from "@/utils/urls";

const EQ_BAR_DELAYS = [0, 160, 320, 110, 240, 80, 200];

// Retrom-native "soundtrack module": a compact audio card that reads the same
// shared music store + persisted theme presence as the focused-card tray, shown
// statically on the detail page (no floating banner, no OPTION action). Song
// management routes to the same Download/Replace Theme Music flow used by the
// game-actions sheet.
export function MusicPanel() {
  const { game, name, gameMetadata, extraMetadata } = useGameDetail();
  const publicUrl = usePublicUrl();

  const hasDownloadedTheme = !!extraMetadata?.mediaPaths?.themeAudioUrl;

  const { status, title, ownerId } = useGameMusicStatus((s) => ({
    status: s.status,
    title: s.title,
    ownerId: s.gameId,
  }));

  // "Now Playing" derives ONLY from real playback ownership; theme presence from
  // the persisted themeAudioUrl. Transient states never promote a no-theme game
  // (mirrors the focused-card tray fix).
  const isPlaying = ownerId === game.id && status === "playing";
  const hasTheme = isPlaying || hasDownloadedTheme;

  const artUrl = useMemo(() => {
    const localCover = extraMetadata?.mediaPaths?.coverUrl;
    if (localCover && publicUrl) {
      return createUrl({ path: localCover, base: publicUrl })?.href;
    }
    return gameMetadata?.coverUrl;
  }, [extraMetadata?.mediaPaths?.coverUrl, gameMetadata?.coverUrl, publicUrl]);

  const fileName = useMemo(() => {
    const url = extraMetadata?.mediaPaths?.themeAudioUrl;
    if (!url) return undefined;
    return url
      .split(/[\\/?#]/)
      .filter(Boolean)
      .pop();
  }, [extraMetadata?.mediaPaths?.themeAudioUrl]);

  const statusLabel = isPlaying
    ? "Now Playing"
    : hasTheme
      ? "Theme Available"
      : "No Theme Music";

  const detail = isPlaying
    ? title || name
    : hasTheme
      ? fileName || "Theme audio ready to play"
      : "Give this game its own theme song.";

  return (
    <section
      className={cn(
        "relative overflow-hidden rounded-xl border bg-gradient-to-br from-muted/20 to-background p-4",
        isPlaying
          ? "border-accent/50 shadow-[0_0_24px_-6px_var(--color-accent)]"
          : "border-border/60",
      )}
    >
      {/* Soft accent glow wash */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full blur-3xl transition-opacity",
          isPlaying ? "bg-accent/30 opacity-100" : "bg-accent/10 opacity-60",
        )}
      />

      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          {/* Game art with an overlaid play/visualizer badge */}
          <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted">
            {artUrl ? (
              <Image
                src={artUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-muted-foreground">
                <Music4 size={22} />
              </div>
            )}
            <div
              className={cn(
                "absolute inset-0 grid place-items-center transition-colors",
                isPlaying ? "bg-background/40" : "bg-transparent",
              )}
            >
              {isPlaying && <Visualizer />}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <span
              className={cn(
                "w-fit rounded-full px-2.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-[0.18em]",
                isPlaying
                  ? "bg-accent/20 text-accent-text"
                  : hasTheme
                    ? "bg-muted/60 text-foreground/80"
                    : "bg-muted/40 text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
            <span className="truncate text-base font-semibold text-foreground/90">
              {detail}
            </span>
          </div>
        </div>

        <div className="shrink-0 sm:w-60">
          <DownloadMusicAction
            idPrefix="detail-music"
            restoreFocusKey="detail-music-open"
            icon={<Music2 size={18} />}
            label={
              hasTheme
                ? "Choose a different theme track"
                : "Pick a track to use as theme audio"
            }
          >
            {hasTheme ? "Replace Theme Music" : "Download Theme Music"}
          </DownloadMusicAction>
        </div>
      </div>
    </section>
  );
}

function Visualizer() {
  return (
    <div className="flex h-5 items-end gap-[2px]" aria-hidden="true">
      {EQ_BAR_DELAYS.map((delay, i) => (
        <span
          key={i}
          className="fs-eq-bar block w-[2px] rounded-full bg-gradient-to-t from-accent/60 to-accent shadow-[0_0_6px_var(--color-accent)]"
          style={{ height: "100%", animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  );
}
