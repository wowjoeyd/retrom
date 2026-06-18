import { useMemo } from "react";
import { Music2 } from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import { useGameMusicStatus } from "@/components/fullscreen/grid-game-list";
import { DownloadMusicAction } from "@/components/fullscreen/game-actions/download-music";

// Seeded, transform-only EQ. Heights are static; only scaleY animates (via the
// shared .fs-eq-bar keyframes), so the visualizer never triggers layout.
const EQ_BARS = [42, 64, 30, 76, 48, 88, 36, 60];
const EQ_DELAYS = [0, 130, 260, 90, 210, 60, 300, 170];

type SoundtrackStatus = "playing" | "available" | "none";

// Compact "now playing" faceplate for the right hero cluster — not a panel, not
// a metadata row. Reads the same shared music store + persisted theme presence
// as the focused-card tray. "Now Playing" derives ONLY from real playback
// ownership and theme presence ONLY from the persisted themeAudioUrl, so a
// transient/loading state never promotes a no-theme game (the no-theme →
// now-playing regression guard).
export function SoundtrackConsole() {
  const { game, name, extraMetadata } = useGameDetail();

  const hasDownloadedTheme = !!extraMetadata?.mediaPaths?.themeAudioUrl;

  const { status, title, ownerId } = useGameMusicStatus((s) => ({
    status: s.status,
    title: s.title,
    ownerId: s.gameId,
  }));

  const isPlaying = ownerId === game.id && status === "playing";
  const hasTheme = isPlaying || hasDownloadedTheme;
  const state: SoundtrackStatus = isPlaying
    ? "playing"
    : hasTheme
      ? "available"
      : "none";

  const fileName = useMemo(() => {
    const url = extraMetadata?.mediaPaths?.themeAudioUrl;
    if (!url) return undefined;
    return url
      .split(/[\\/?#]/)
      .filter(Boolean)
      .pop();
  }, [extraMetadata?.mediaPaths?.themeAudioUrl]);

  const statusLabel =
    state === "playing"
      ? "Now Playing"
      : state === "available"
        ? "Theme Available"
        : "No Theme";

  const songLine =
    state === "playing"
      ? title || name
      : state === "available"
        ? fileName
        : undefined;

  return (
    <section
      className={cn(
        "relative w-64 overflow-hidden rounded-xl border px-4 py-3 backdrop-blur-md transition-colors",
        state === "playing"
          ? "border-accent/50 bg-background/50 shadow-[0_0_24px_-8px_var(--color-accent)]"
          : "border-border/60 bg-background/40",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6rem] font-bold uppercase tracking-[0.22em] text-muted-foreground">
          Soundtrack
        </span>
        <span className="flex items-center gap-1.5">
          <StatusLed state={state} />
          <span
            className={cn(
              "text-[0.6rem] font-semibold uppercase tracking-wider",
              state === "playing"
                ? "text-accent-text"
                : state === "available"
                  ? "text-foreground/70"
                  : "text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        </span>
      </div>

      <Equalizer state={state} />

      <p
        className={cn(
          "mt-1 truncate text-xs",
          songLine ? "text-foreground/80" : "text-muted-foreground/70",
        )}
      >
        {songLine ?? "Give this game its own theme song."}
      </p>

      <div className="mt-3">
        <DownloadMusicAction
          idPrefix="detail-soundtrack"
          restoreFocusKey="detail-soundtrack-open"
          icon={<Music2 size={16} />}
          label={hasTheme ? "Swap the current theme" : "Find a theme track"}
        >
          {hasTheme ? "Replace Theme Music" : "Download Theme Music"}
        </DownloadMusicAction>
      </div>
    </section>
  );
}

function StatusLed(props: { state: SoundtrackStatus }) {
  const { state } = props;
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 rounded-full",
        state === "playing"
          ? "animate-pulse bg-emerald-400 shadow-[0_0_6px_#34d399]"
          : state === "available"
            ? "bg-accent"
            : "bg-muted-foreground/40",
      )}
    />
  );
}

function Equalizer(props: { state: SoundtrackStatus }) {
  const { state } = props;
  const playing = state === "playing";

  return (
    <div className="mt-2 flex h-7 items-end gap-[3px]" aria-hidden>
      {EQ_BARS.map((h, i) => (
        <span
          key={i}
          className={cn(
            "block w-[3px] rounded-full",
            playing
              ? "fs-eq-bar bg-gradient-to-t from-accent/60 to-accent shadow-[0_0_6px_var(--color-accent)]"
              : state === "available"
                ? "bg-muted-foreground/45"
                : "bg-muted-foreground/20",
          )}
          style={{
            // Each bar keeps a seeded silhouette height; playing bars animate via
            // scaleY (the shared keyframe), an available-but-paused theme sits low
            // + dim, and no theme flatlines.
            height: playing
              ? `${h}%`
              : state === "available"
                ? `${Math.round(h * 0.35)}%`
                : "10%",
            animationDelay: playing ? `${EQ_DELAYS[i]}ms` : undefined,
          }}
        />
      ))}
    </div>
  );
}
