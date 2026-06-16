import { create } from "zustand";
import { useEffect, useMemo } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import {
  GamepadAxisActiveEvent,
  GamepadAxisInactiveEvent,
  GamepadButtonDownEvent,
  GamepadButtonUpEvent,
} from "@/providers/gamepad/event";
import { useGroupContext } from "@/providers/fullscreen/group-context";
import { cn } from "@retrom/ui/lib/utils";
import { KeyboardEvent as ReactKeyboardEvent } from "react";

// Steam Big Picture-style alphabet quick-scroll scrubber.
//
// Behavior: a *single tap* of up/down moves card-to-card as normal. Holding
// up/down for a sustained, intentional duration switches into section-jump
// mode: instead of creeping card-by-card, focus jumps to the FIRST card of the
// next/previous section (letter or date bucket) and smoothly scrolls there,
// while a centered letter overlay is shown over a dimmed/blurred grid. When the
// user releases, focus is already resting on the first card of the current
// section — never mid-section.
//
// The navigation handlers live in the root layout (above the group context), so
// this module exposes an imperative controller (like the game music player) that
// a hook inside the group context registers section data into.

// How long up/down must be held before card nav switches to section jumping.
// Below this, ordinary repeat navigation (card-by-card) is left untouched.
const HOLD_THRESHOLD_MS = 450;
// Minimum time between section jumps while held, so letters advance at a
// readable pace rather than blasting through the whole alphabet instantly.
const JUMP_INTERVAL_MS = 200;
// Keep the overlay up briefly after release, then fade out.
const RELEASE_HIDE_MS = 350;

// D-pad up / down button indices, and the left-stick vertical axis.
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const VERTICAL_AXIS = 1;

type Direction = "UP" | "DOWN";

type NavEvent =
  | KeyboardEvent
  | ReactKeyboardEvent
  | GamepadButtonDownEvent
  | GamepadAxisActiveEvent
  | undefined;

type Section = { key: string; firstFocusKey: string };

type QuickScrollContext = {
  getSections: () => Section[];
};

// Invoked once when a held scrub transitions into section-jump mode. Registered
// from the library view so this module avoids importing the music player
// directly (which would create an import cycle with the grid). Used to stop any
// in-flight soundtrack and dismiss the now-playing banner while scrubbing.
let onActivate: (() => void) | null = null;

export function setQuickScrollActivateHandler(handler: (() => void) | null) {
  onActivate = handler;
}

// Reactive slice consumed by the overlay component only.
type AlphabetScrollState = {
  letter?: string;
  visible: boolean;
};

export const useAlphabetScroll = create<AlphabetScrollState>(() => ({
  letter: undefined,
  visible: false,
}));

function isRepeat(event: NavEvent): boolean {
  if (!event) return false;
  if (
    event instanceof GamepadButtonDownEvent ||
    event instanceof GamepadAxisActiveEvent
  ) {
    return event.detail.repeat === true;
  }
  return "repeat" in event && event.repeat === true;
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const quickScroll = {
  ctx: null as QuickScrollContext | null,
  currentSectionKey: undefined as string | undefined,
  pressDir: null as Direction | null,
  pressAt: 0,
  lastJumpAt: 0,
  active: false,
  paused: false,
  hideTimer: null as ReturnType<typeof setTimeout> | null,

  setContext(ctx: QuickScrollContext | null) {
    this.ctx = ctx;
  },

  // Keeps track of which section the focused card belongs to, so that when a
  // sustained hold begins we know where to jump from. Cheap, non-reactive.
  notifyCardFocus(sectionKey: string) {
    this.currentSectionKey = sectionKey;
  },

  // Called by the root layout's UP/DOWN handlers. Returns true when this module
  // has consumed the event (section-jump mode) and ordinary card navigation
  // should be suppressed.
  onNav(direction: Direction, event: NavEvent): boolean {
    if (this.paused) {
      return false;
    }

    const t = now();

    // A fresh press (or a direction change) restarts the hold timer and lets
    // normal single-step navigation run.
    if (!isRepeat(event) || direction !== this.pressDir) {
      this.pressDir = direction;
      this.pressAt = t;
      this.active = false;
      return false;
    }

    if (t - this.pressAt < HOLD_THRESHOLD_MS) {
      return false;
    }

    const sections = this.ctx?.getSections() ?? [];
    if (sections.length < 2) {
      return false;
    }

    if (!this.active) {
      this.active = true;
      this.lastJumpAt = 0;
      onActivate?.();
    }

    if (t - this.lastJumpAt >= JUMP_INTERVAL_MS) {
      this.lastJumpAt = t;
      this.jump(direction, sections);
    }

    // Consume even while throttled so the grid never creeps card-by-card during
    // a held scrub.
    return true;
  },

  jump(direction: Direction, sections: Section[]) {
    let idx = sections.findIndex((s) => s.key === this.currentSectionKey);
    if (idx < 0) idx = 0;

    const nextIdx =
      direction === "DOWN"
        ? Math.min(sections.length - 1, idx + 1)
        : Math.max(0, idx - 1);

    const target = sections[nextIdx];
    if (!target) return;

    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }

    this.currentSectionKey = target.key;
    useAlphabetScroll.setState({ visible: true, letter: target.key });
    setFocus(target.firstFocusKey);
  },

  release() {
    this.pressDir = null;
    this.active = false;
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      useAlphabetScroll.setState({ visible: false });
    }, RELEASE_HIDE_MS);
  },
};

/** Update the tracked section from a focused grid card. */
export function notifyCardFocus(sectionKey: string) {
  quickScroll.notifyCardFocus(sectionKey);
}

/**
 * Suspend the quick-scroll controller (e.g. while a sheet has trapped focus),
 * so held up/down does not yank focus out of the open panel back to the grid.
 */
export function setQuickScrollPaused(paused: boolean) {
  quickScroll.paused = paused;
  if (paused) {
    quickScroll.release();
  }
}

/**
 * Called from the root layout's UP/DOWN navigation handlers. Returns true when
 * the held-scroll controller has handled the event and normal card navigation
 * should be skipped.
 */
export function consumeQuickScrollNav(
  direction: Direction,
  event: NavEvent,
): boolean {
  return quickScroll.onNav(direction, event);
}

/**
 * Registers the active group's section anchors with the controller and wires up
 * release detection. Must be mounted inside the group context (e.g. the library
 * grid view).
 */
export function useAlphabetQuickScroll() {
  const { activeGroup } = useGroupContext();

  const sections = useMemo<Section[]>(() => {
    if (!activeGroup) return [];
    return activeGroup.partitionedGames
      .filter(([, games]) => games.length > 0)
      .map(([key, games]) => ({
        key,
        firstFocusKey: `game-list-${activeGroup.id}-${games[0].id}`,
      }));
  }, [activeGroup]);

  useEffect(() => {
    quickScroll.setContext({ getSections: () => sections });
    return () => quickScroll.setContext(null);
  }, [sections]);

  useEffect(() => {
    const release = () => quickScroll.release();

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") release();
    };
    const onButtonUp = (e: GamepadButtonUpEvent) => {
      const button = e.detail.button;
      if (button === DPAD_UP || button === DPAD_DOWN) release();
    };
    const onAxisInactive = (e: GamepadAxisInactiveEvent) => {
      if (e.detail.axis === VERTICAL_AXIS) release();
    };

    document.addEventListener("keyup", onKeyUp);
    document.addEventListener(GamepadButtonUpEvent.EVENT_NAME, onButtonUp);
    document.addEventListener(
      GamepadAxisInactiveEvent.EVENT_NAME,
      onAxisInactive,
    );

    return () => {
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener(GamepadButtonUpEvent.EVENT_NAME, onButtonUp);
      document.removeEventListener(
        GamepadAxisInactiveEvent.EVENT_NAME,
        onAxisInactive,
      );
    };
  }, []);
}

export function AlphabetScrollOverlay() {
  const { activeGroup } = useGroupContext();
  const visible = useAlphabetScroll((s) => s.visible);
  const letter = useAlphabetScroll((s) => s.letter);

  const sectionKeys = useMemo(
    () =>
      (activeGroup?.partitionedGames ?? [])
        .filter(([, games]) => games.length > 0)
        .map(([key]) => key),
    [activeGroup],
  );

  const idx = letter ? sectionKeys.indexOf(letter) : -1;
  const prev = idx > 0 ? sectionKeys[idx - 1] : undefined;
  const next =
    idx >= 0 && idx < sectionKeys.length - 1 ? sectionKeys[idx + 1] : undefined;

  // Single-letter sections get a large square badge; longer keys (e.g. date
  // buckets like "APR 2026") size to their content on a single line instead of
  // wrapping inside a fixed square.
  const compact = (letter?.length ?? 0) > 2;

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-[80]",
        "flex items-center justify-center",
        "transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      {/* Blur is applied only while visible so backdrop-filter never runs during
          idle scrolling. */}
      <div
        className={cn(
          "absolute inset-0 bg-background/50",
          visible && "backdrop-blur-sm",
        )}
      />

      <div className="relative flex flex-col items-center gap-4 select-none">
        <span className="h-8 whitespace-nowrap text-2xl font-bold uppercase text-muted-foreground/40">
          {prev}
        </span>

        <span
          className={cn(
            "grid place-items-center rounded-2xl bg-accent/15 ring-2 ring-accent shadow-2xl shadow-background",
            "whitespace-nowrap text-center font-black uppercase leading-none text-foreground",
            compact ? "min-h-28 px-10 py-6 text-5xl" : "size-36 text-7xl",
          )}
        >
          {letter}
        </span>

        <span className="h-8 whitespace-nowrap text-2xl font-bold uppercase text-muted-foreground/40">
          {next}
        </span>
      </div>
    </div>
  );
}
