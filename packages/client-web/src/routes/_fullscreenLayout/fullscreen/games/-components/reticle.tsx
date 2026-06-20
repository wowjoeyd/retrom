import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@retrom/ui/lib/utils";

type Rect = { x: number; y: number; w: number; h: number };

// How long to keep re-measuring after a focus/scroll/resize so the brackets
// track slide-in panels, scrollIntoView, and tab re-layout without a permanent
// rAF loop.
const FOLLOW_MS = 420;
// Outset of the brackets past the focused element's edges.
const OUTSET = 6;
// Bracket box size (keep in sync with `.fs-reticle > i` in globals.css).
const SIZE = 16;

/**
 * The signature focus visual for the fullscreen detail page: four animated
 * corner brackets that snap/glide to whatever element actually holds focus.
 *
 * It is driven entirely by the EXISTING controller spatial-focus system, not by
 * the mouse: norigin commits focus by calling `node.focus()` in every
 * focusable's `onFocus`, so `document.activeElement` always reflects the real
 * spatial focus and `focusin` fires on every focus change. We never listen for
 * `mouseenter`/hover.
 *
 * Mounted (via a body portal) only while the detail page is alive. Because it
 * reads viewport coordinates it also frames focus inside the portaled Actions
 * panel and media viewer. While mounted it adds `fs-reticle-active` to <body>,
 * which zeroes the per-element focus ring so the reticle is the sole focus cue.
 */
export function DetailReticle() {
  const [rect, setRect] = useState<Rect | null>(null);
  const [danger, setDanger] = useState(false);
  const rafRef = useRef(0);
  const followUntilRef = useRef(0);

  useEffect(() => {
    document.body.classList.add("fs-reticle-active");
    return () => {
      document.body.classList.remove("fs-reticle-active");
    };
  }, []);

  useEffect(() => {
    const measure = () => {
      const el = document.activeElement as HTMLElement | null;
      if (
        !el ||
        el === document.body ||
        !el.isConnected ||
        typeof el.getBoundingClientRect !== "function"
      ) {
        setRect(null);
        return;
      }

      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        setRect(null);
        return;
      }

      setRect({ x: r.left, y: r.top, w: r.width, h: r.height });
      setDanger(!!el.closest('[data-reticle-variant="danger"]'));
    };

    const startFollow = () => {
      followUntilRef.current = performance.now() + FOLLOW_MS;
      if (rafRef.current) return;
      const loop = () => {
        measure();
        if (performance.now() < followUntilRef.current) {
          rafRef.current = requestAnimationFrame(loop);
        } else {
          rafRef.current = 0;
        }
      };
      rafRef.current = requestAnimationFrame(loop);
    };

    // focusin bubbles from the actually-focused element (incl. portaled panels);
    // scroll (capture) catches controller scroll inside the ScrollArea; resize
    // catches window/overscan changes.
    //
    // On focus change, measure synchronously first so the brackets snap to the
    // new element in the SAME frame focus lands -- not one rAF later. That async
    // gap is what made a tab switch (e.g. away from a focused screenshot) read as
    // laggy: the content swapped instantly but the focus indicator only caught up
    // a frame after. startFollow then keeps tracking scrollIntoView/panel slides.
    const onFocusIn = () => {
      measure();
      startFollow();
    };
    const onScroll = () => startFollow();
    const onResize = () => startFollow();

    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);

    startFollow();

    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

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
