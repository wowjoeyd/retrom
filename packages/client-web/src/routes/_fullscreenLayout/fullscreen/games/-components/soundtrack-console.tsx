import { useEffect, useMemo, useRef, useState } from "react";
import {
  type LucideIcon,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import {
  gameMusicPlayer,
  useGameMusicStatus,
} from "@/components/fullscreen/grid-game-list";
import { useFocusable } from "@/components/fullscreen/focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { createUrl, usePublicUrl } from "@/utils/urls";

type SoundtrackStatus = "playing" | "paused" | "available" | "none";

// A modest bar count keeps the visualizer cheap (transform-only, throttled).
const BAR_COUNT = 12;
// One frequency bin per bar, spread low→high across the analyser's 64 bins
// (fftSize 128). Weighted toward the low/mid range where theme energy lives.
const BAR_BINS = [1, 2, 3, 4, 6, 8, 11, 14, 18, 23, 29, 37];
// Seeded silhouette so static/dim states still read as an equalizer.
const BAR_BASELINE = [
  0.35, 0.6, 0.45, 0.8, 0.5, 0.95, 0.55, 0.75, 0.4, 0.65, 0.5, 0.3,
];

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = () => setReduced(mq.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  return reduced;
}

// Compact "now playing" faceplate for the right hero cluster — a dedicated mini
// player: status, a live visualizer, the (scrolling) track name, a progress
// bar, and transport controls. "Now Playing" derives ONLY from real playback
// ownership and theme presence ONLY from the persisted themeAudioUrl, so a
// transient/loading state never promotes a no-theme game (the no-theme → now-
// playing regression guard). The Download/Replace flow lives in the Actions
// panel, not here.
export function SoundtrackConsole() {
  const { game, gameMetadata, extraMetadata } = useGameDetail();
  const publicUrl = usePublicUrl();
  const mediaPaths = extraMetadata?.mediaPaths;

  const hasDownloadedTheme = !!mediaPaths?.themeAudioUrl;

  // Resolve the theme playlist to absolute track URLs + titles. Falls back to the
  // singular primary track for older server responses.
  const { trackUrls, trackTitles } = useMemo(() => {
    const rels = mediaPaths?.themeAudioUrls?.length
      ? mediaPaths.themeAudioUrls
      : mediaPaths?.themeAudioUrl
        ? [mediaPaths.themeAudioUrl]
        : [];
    const urls = publicUrl
      ? rels
          .map((r) => createUrl({ path: r, base: publicUrl })?.href)
          .filter((u): u is string => !!u)
      : [];
    return { trackUrls: urls, trackTitles: mediaPaths?.themeAudioTitles ?? [] };
  }, [
    mediaPaths?.themeAudioUrls,
    mediaPaths?.themeAudioUrl,
    mediaPaths?.themeAudioTitles,
    publicUrl,
  ]);

  const [trackIndex, setTrackIndex] = useState(0);
  // Clamp if the playlist shrank (a track was deleted).
  const safeIndex = trackUrls.length
    ? Math.min(trackIndex, trackUrls.length - 1)
    : 0;

  const { status, ownerId } = useGameMusicStatus((s) => ({
    status: s.status,
    ownerId: s.gameId,
  }));

  const owned = ownerId === game.id;
  const isPlaying = owned && status === "playing";
  const isPaused = owned && status === "paused";
  const hasTheme =
    isPlaying || isPaused || hasDownloadedTheme || trackUrls.length > 0;
  const state: SoundtrackStatus = isPlaying
    ? "playing"
    : isPaused
      ? "paused"
      : hasTheme
        ? "available"
        : "none";

  // Track name: the current playlist track's title (resolved server-side from
  // the embedded Opus TITLE tag), then the stored primary title, else "Theme".
  // Never shows the raw "theme.opus" filename.
  const trackName = useMemo(() => {
    if (!hasTheme) return undefined;
    return (
      trackTitles[safeIndex]?.trim() ||
      gameMetadata?.themeAudioTitle?.trim() ||
      "Theme"
    );
  }, [hasTheme, trackTitles, safeIndex, gameMetadata?.themeAudioTitle]);

  const canSkip = trackUrls.length > 1;
  const goToTrack = (delta: 1 | -1) => {
    if (trackUrls.length < 2) return;
    const next = (safeIndex + delta + trackUrls.length) % trackUrls.length;
    setTrackIndex(next);
    gameMusicPlayer.playThemeTrack(
      trackUrls[next],
      trackTitles[next]?.trim() || gameMetadata?.themeAudioTitle || "Theme",
      game.id,
    );
  };

  const statusLabel =
    state === "playing"
      ? "Now Playing"
      : state === "paused"
        ? "Paused"
        : state === "available"
          ? "Theme Available"
          : "No Theme";

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
                : state === "available" || state === "paused"
                  ? "text-foreground/70"
                  : "text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        </span>
      </div>

      <LiveVisualizer state={state} />

      {trackName ? (
        <Marquee
          text={trackName}
          className="mt-1.5 text-xs text-foreground/85"
        />
      ) : (
        <p className="mt-1.5 truncate text-xs text-muted-foreground/70">
          No theme song for this game yet.
        </p>
      )}

      {/* Progress + transport only render when a theme exists — a no-theme game
          shows the flat/dim visualizer and nothing else (regression guard). */}
      {hasTheme && (
        <>
          <ProgressBar active={isPlaying || isPaused} />
          <Transport
            state={state}
            canSkip={canSkip}
            onPrev={() => goToTrack(-1)}
            onNext={() => goToTrack(1)}
          />
        </>
      )}
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
          : state === "available" || state === "paused"
            ? "bg-accent"
            : "bg-muted-foreground/40",
      )}
    />
  );
}

// Real-audio equalizer. While the theme is actually playing (and reduced-motion
// is off) the bars are driven by Web Audio frequency data read in a rAF loop and
// applied as scaleY transforms (no layout). Otherwise the bars sit at a static,
// dimmed silhouette — including the reduced-motion case and when Web Audio /
// analysis isn't available (we never fake the FFT).
function LiveVisualizer(props: { state: SoundtrackStatus }) {
  const { state } = props;
  const playing = state === "playing";
  const reduceMotion = usePrefersReducedMotion();
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const setBar = (i: number, scale: number) => {
      const el = barsRef.current[i];
      if (el) el.style.transform = `scaleY(${scale.toFixed(3)})`;
    };

    const staticScale = (i: number) => {
      const base = BAR_BASELINE[i];
      if (state === "none") return 0.08;
      if (reduceMotion) return base; // reduced motion: static (no animation)
      if (state === "paused") return base * 0.3;
      if (state === "available") return base * 0.4;
      return base; // playing baseline before the first analysed frame
    };

    if (!playing || reduceMotion) {
      for (let i = 0; i < BAR_COUNT; i++) setBar(i, staticScale(i));
      return;
    }

    const analyser = gameMusicPlayer.ensureAnalyser();
    if (!analyser) {
      // No Web Audio analysis available — show the static silhouette rather than
      // a fabricated animation.
      for (let i = 0; i < BAR_COUNT; i++) setBar(i, BAR_BASELINE[i]);
      return;
    }

    gameMusicPlayer.resumeAudioContext();
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      for (let i = 0; i < BAR_COUNT; i++) {
        const bin = Math.min(BAR_BINS[i], data.length - 1);
        const v = data[bin] / 255; // 0..1
        setBar(i, 0.08 + v * 0.92);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, reduceMotion, state]);

  return (
    <div className="mt-2 flex h-7 items-end gap-[3px]" aria-hidden>
      {Array.from({ length: BAR_COUNT }).map((_, i) => (
        <span
          key={i}
          ref={(el) => {
            barsRef.current[i] = el;
          }}
          className={cn(
            "block h-full flex-1 origin-bottom rounded-[2px] transition-[background-color]",
            playing
              ? "bg-gradient-to-t from-accent/70 to-accent shadow-[0_0_6px_var(--color-accent)]"
              : state === "available" || state === "paused"
                ? "bg-muted-foreground/45"
                : "bg-muted-foreground/20",
          )}
          style={{ transform: `scaleY(${BAR_BASELINE[i]})` }}
        />
      ))}
    </div>
  );
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Live progress for the owned theme, read directly off the shared <audio>
// element. Polled with rAF only while it's the active track.
function ProgressBar(props: { active: boolean }) {
  const { active } = props;
  const [{ current, duration }, setProgress] = useState({
    current: 0,
    duration: 0,
  });

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const media = gameMusicPlayer.getThemeMedia();
      if (media) {
        setProgress((prev) => {
          const current = media.currentTime || 0;
          const duration = Number.isFinite(media.duration) ? media.duration : 0;
          if (
            Math.abs(prev.current - current) < 0.2 &&
            prev.duration === duration
          ) {
            return prev;
          }
          return { current, duration };
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  const pct =
    duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;

  return (
    <div className="mt-2.5">
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted-foreground/25">
        <div
          className="h-full rounded-full bg-gradient-to-r from-accent-text to-accent transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[0.6rem] font-medium tabular-nums text-muted-foreground">
        <span>{formatTime(current)}</span>
        <span>{duration > 0 ? formatTime(duration) : "--:--"}</span>
      </div>
    </div>
  );
}

// Horizontally scrolls the track name when it overflows, then loops back to the
// start. Uses the Web Animations API so no global keyframes are needed. Respects
// reduced motion (truncates instead).
function Marquee(props: { text: string; className?: string }) {
  const { text, className } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const reduceMotion = usePrefersReducedMotion();

  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    inner.style.transform = "translateX(0)";
    if (reduceMotion) return;

    const overflow = inner.scrollWidth - container.clientWidth;
    if (overflow <= 4) return; // fits — no scroll needed

    const distance = overflow + 8;
    // ~36px/sec scroll speed, with a minimum so short overflows still read.
    const scrollMs = Math.max(2600, (distance / 36) * 1000);
    const duration = scrollMs + 2400; // + start/end dwell

    const startHold = 1200 / duration;
    const endHold = 1 - 1000 / duration;

    const anim = inner.animate(
      [
        { transform: "translateX(0)", offset: 0 },
        { transform: "translateX(0)", offset: startHold },
        { transform: `translateX(${-distance}px)`, offset: endHold },
        { transform: `translateX(${-distance}px)`, offset: 1 },
      ],
      { duration, iterations: Infinity, easing: "linear" },
    );

    return () => anim.cancel();
  }, [text, reduceMotion]);

  return (
    <div ref={containerRef} className={cn("overflow-hidden", className)}>
      <span ref={innerRef} className="inline-block whitespace-nowrap">
        {text}
      </span>
    </div>
  );
}

// Previous / play-pause / next. play-pause controls real playback and reflects
// real state. prev/next switch playlist tracks; they're disabled/dimmed when the
// game has only a single theme track.
function Transport(props: {
  state: SoundtrackStatus;
  canSkip: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { state, canSkip, onPrev, onNext } = props;
  const playing = state === "playing";

  const onToggle = () => {
    gameMusicPlayer.resumeAudioContext();
    if (playing) {
      gameMusicPlayer.pauseTheme();
    } else {
      gameMusicPlayer.resumeTheme();
    }
  };

  return (
    <div className="mt-3 flex items-center justify-center gap-3">
      <SkipButton
        side="prev"
        onActivate={onPrev}
        disabled={!canSkip}
        label="Previous track"
      />
      <PlayPauseButton playing={playing} onActivate={onToggle} />
      <SkipButton
        side="next"
        onActivate={onNext}
        disabled={!canSkip}
        label="Next track"
      />
    </div>
  );
}

const TRANSPORT_BOX = cn(
  "grid size-11 place-items-center rounded-lg border outline-none transition-all",
  "ring-ring focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-offset-0",
);

function PlayPauseButton(props: { playing: boolean; onActivate: () => void }) {
  const { playing, onActivate } = props;

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: "detail-soundtrack-playpause",
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  return (
    <HotkeyLayer
      handlers={{
        ACCEPT: {
          handler: onActivate,
          actionBar: { label: playing ? "Pause" : "Play" },
        },
      }}
    >
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onActivate}
        aria-label={playing ? "Pause theme" : "Play theme"}
        className={cn(
          TRANSPORT_BOX,
          "border-accent/60 bg-accent/15 text-accent-text",
          "focus-hover:bg-accent focus-hover:text-accent-foreground focus-hover:shadow-[0_0_18px_-4px_var(--color-accent)]",
        )}
      >
        {playing ? (
          <Pause size={18} className="fill-current" />
        ) : (
          <Play size={18} className="translate-x-[1px] fill-current" />
        )}
      </button>
    </HotkeyLayer>
  );
}

function SkipButton(props: {
  side: "prev" | "next";
  onActivate: () => void;
  disabled: boolean;
  label: string;
}) {
  const { side, onActivate, disabled, label } = props;
  const Icon = side === "prev" ? SkipBack : SkipForward;

  // Disabled skip controls are non-focusable decorations (no controller stop).
  if (disabled) {
    return (
      <span
        aria-hidden
        className={cn(
          TRANSPORT_BOX,
          "border-border/40 text-muted-foreground/30",
        )}
      >
        <Icon size={16} />
      </span>
    );
  }

  return (
    <FocusableSkip
      side={side}
      onActivate={onActivate}
      label={label}
      Icon={Icon}
    />
  );
}

function FocusableSkip(props: {
  side: "prev" | "next";
  onActivate: () => void;
  label: string;
  Icon: LucideIcon;
}) {
  const { side, onActivate, label, Icon } = props;
  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: `detail-soundtrack-skip-${side}`,
    onFocus: ({ node }) => node?.focus({ preventScroll: true }),
  });

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: onActivate } }}>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onActivate}
        aria-label={label}
        className={cn(
          TRANSPORT_BOX,
          "border-border/60 bg-background/40 text-foreground/70",
          "focus-hover:bg-muted/60 focus-hover:text-foreground",
        )}
      >
        <Icon size={16} />
      </button>
    </HotkeyLayer>
  );
}
