import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@retrom/ui/lib/utils";
import { useConfig } from "@/providers/config";

type Rect = { x: number; y: number; w: number; h: number };

// Per-axis tolerance (px) below which a rect is treated as unchanged (so an idle
// focus never triggers a React re-render).
const RECT_EPSILON = 0.5;
// Outset of the brackets past the focused element's edges.
const OUTSET = 6;
// Bracket box size (keep in sync with `.fs-reticle > i` in globals.css).
const SIZE = 16;

/**
 * The focus reticle for the whole fullscreen UI: four corner brackets that frame
 * whatever element currently holds spatial focus — grid cards, the guide/Actions
 * panels, the game context menu, the detail page, and the media viewer. It is
 * purely additive: each focusable keeps its own ring highlight, and the reticle
 * frames it on the OUTSIDE.
 *
 * Why a body-portal overlay (and not pure CSS like the rings): the brackets must
 * sit *outside* the element, but cards/buttons sit inside `overflow:hidden`
 * ancestors that would clip an attached pseudo-element. A fixed-position overlay
 * in the body is never clipped.
 *
 * Tracking is dead simple and robust, mirroring how the CSS rings "just work":
 * while mounted, a single rAF loop reads the focused element's box every frame
 * and pins the brackets to it. There is intentionally NO stop/settle logic and
 * NO dependency on focus/scroll/resize events — those were the source of the
 * brackets freezing or vanishing. Re-measuring every frame also means the
 * brackets follow things that emit no event: an ancestor `transform: scale()`
 * (grid cards grow via `focus-within`) and late layout reflow (hero content
 * mounting). We only re-render React when the box actually moves, so an idle
 * focus costs about one getBoundingClientRect per frame; the browser throttles
 * rAF when the window is hidden, and the component only exists in fullscreen.
 *
 * Mounted once at the fullscreen layout level, so the windowed UI is unaffected.
 */
export function FullscreenReticle() {
  // Which focus cue(s) to show, shared by both settings menus (default BOTH).
  const indicator =
    useConfig((s) => s.config?.interface?.focusIndicator) ?? "BOTH";
  const showReticle = indicator !== "RINGS_ONLY";
  const ringsHidden = indicator === "RETICLE_ONLY";

  const [rect, setRect] = useState<Rect | null>(null);
  const [danger, setDanger] = useState(false);
  const rafRef = useRef(0);
  const lastRectRef = useRef<Rect | null>(null);
  const lastDangerRef = useRef(false);

  // Reticle-only mode: hide the per-element ring highlight by zeroing its width.
  // Scoped to <body> only while this component is mounted (i.e. in fullscreen),
  // so the windowed UI always keeps its rings.
  useEffect(() => {
    if (!ringsHidden) return;
    document.body.classList.add("fs-rings-hidden");
    return () => document.body.classList.remove("fs-rings-hidden");
  }, [ringsHidden]);

  useEffect(() => {
    if (!showReticle) return;

    // The element to frame is whatever norigin currently marks as focused
    // (`data-focused="true"`, set on the leaf focusable it commits to), falling
    // back to document.activeElement. This is the same element the CSS ring
    // highlights via :focus / :focus-within, so the reticle always agrees with
    // the highlight.
    const getTarget = (): HTMLElement | null => {
      const focused =
        document.querySelector<HTMLElement>('[data-focused="true"]');
      if (focused?.isConnected) return focused;
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && active.isConnected) {
        return active;
      }
      return null;
    };

    const sameRect = (a: Rect | null, b: Rect | null) => {
      if (!a || !b) return a === b;
      return (
        Math.abs(a.x - b.x) < RECT_EPSILON &&
        Math.abs(a.y - b.y) < RECT_EPSILON &&
        Math.abs(a.w - b.w) < RECT_EPSILON &&
        Math.abs(a.h - b.h) < RECT_EPSILON
      );
    };

    const measure = () => {
      const el = getTarget();
      const r = el?.getBoundingClientRect();
      // No frameable target, or a zero-box (display:none / not yet laid out):
      // hide the brackets.
      if (!el || !r || (r.width === 0 && r.height === 0)) {
        if (lastRectRef.current !== null) {
          lastRectRef.current = null;
          setRect(null);
        }
        return;
      }

      const nextDanger = !!el.closest('[data-reticle-variant="danger"]');
      if (nextDanger !== lastDangerRef.current) {
        lastDangerRef.current = nextDanger;
        setDanger(nextDanger);
      }

      const next = { x: r.left, y: r.top, w: r.width, h: r.height };
      if (!sameRect(lastRectRef.current, next)) {
        lastRectRef.current = next;
        setRect(next);
      }
    };

    const loop = () => {
      measure();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
    };
  }, [showReticle]);

  if (!showReticle) return null;

  const visible = !!rect;
  const x = rect?.x ?? 0;
  const y = rect?.y ?? 0;
  const w = rect?.w ?? 0;
  const h = rect?.h ?? 0;

  const left = x - OUTSET;
  const top = y - OUTSET;
  const right = x + w + OUTSET - SIZE;
  const bottom = y + h + OUTSET - SIZE;

  const corner = (cx: number, cy: number) => ({
    transform: `translate(${cx}px, ${cy}px)`,
  });

  return createPortal(
    <div
      className={cn("fs-reticle")}
      data-visible={visible}
      data-variant={danger ? "danger" : undefined}
      aria-hidden
    >
      <i style={corner(left, top)} />
      <i style={corner(right, top)} />
      <i style={corner(left, bottom)} />
      <i style={corner(right, bottom)} />
    </div>,
    document.body,
  );
}
