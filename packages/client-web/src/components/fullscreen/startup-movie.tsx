import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@retrom/ui/lib/utils";
import { useConfig } from "@/providers/config";
import { GamepadButtonDownEvent } from "@/providers/gamepad/event";
import {
  cancelPendingFocusMusic,
  resumeFocusedCardMusic,
  setGridAutoFocusSuppressed,
} from "./grid-game-list";

import startupMovieUrl from "@/assets/videos/retrom_startup.mp4";

// The startup movie is encoded in HEVC/h265, which not every system can decode
// (Windows, for example, needs the HEVC Video Extension installed). Probe codec
// support up front so an unsupported system silently skips the movie instead of
// staring at a black screen. The <video> onError handler is the final backstop
// if a codec the browser *claims* to support fails to decode at runtime.
function canPlayHevc(): boolean {
  const probe = document.createElement("video");
  const candidates = [
    'video/mp4; codecs="hvc1.1.6.L93.B0"',
    'video/mp4; codecs="hev1.1.6.L93.B0"',
    'video/mp4; codecs="hvc1"',
    'video/mp4; codecs="hev1"',
  ];
  return candidates.some((type) => probe.canPlayType(type) !== "");
}

/**
 * Cinematic intro played once when entering fullscreen mode. It is optional
 * (disabled via the shared "Play startup video" config option) and is skipped
 * automatically on systems that can't decode its HEVC/h265 codec. Any input —
 * key, controller button, or click — skips it, and that input is swallowed so
 * it never leaks to the grid mounting underneath.
 */
export function StartupMovie() {
  const enabled = useConfig(
    (s) => s.config?.interface?.fullscreenConfig?.startupMovieEnabled,
  );

  // Decide exactly once, on mount: absent config counts as enabled. Held in
  // state so config edits mid-playback don't yank the movie away.
  const [show, setShow] = useState(() => enabled !== false && canPlayHevc());
  const [leaving, setLeaving] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const dismiss = useCallback(() => {
    setLeaving(true);
    // Let the fade-out finish before unmounting.
    window.setTimeout(() => setShow(false), 220);
  }, []);

  // Keep the grid from grabbing focus (and kicking off theme music) behind the
  // movie. Released as soon as the movie goes away.
  useEffect(() => {
    if (!show) return;
    setGridAutoFocusSuppressed(true);
    cancelPendingFocusMusic();
    return () => {
      setGridAutoFocusSuppressed(false);
      // Re-fire focus on the already-focused card so the settle timer starts
      // and theme music begins immediately when the movie ends/is skipped.
      // Without this, onFocus never fires again (focus didn't change) and the
      // card sits silent until the user navigates.
      resumeFocusedCardMusic();
    };
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const video = videoRef.current;
    if (!video) return;

    // Prefer playing with sound; if the platform blocks autoplay-with-audio,
    // fall back to muted playback rather than dropping the movie entirely.
    const start = async () => {
      try {
        await video.play();
      } catch {
        video.muted = true;
        try {
          await video.play();
        } catch {
          dismiss();
        }
      }
    };
    void start();

    // Swallow all input while the movie owns the screen so it never reaches the
    // grid underneath; key/button/click also skip the movie. Capture phase +
    // stopPropagation stops the event before any underlying handler runs.
    const skip = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    };
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener("keydown", skip, true);
    window.addEventListener(GamepadButtonDownEvent.EVENT_NAME, skip, true);
    window.addEventListener("wheel", swallow, {
      capture: true,
      passive: false,
    });
    return () => {
      window.removeEventListener("keydown", skip, true);
      window.removeEventListener(GamepadButtonDownEvent.EVENT_NAME, skip, true);
      window.removeEventListener("wheel", swallow, true);
    };
  }, [show, dismiss]);

  if (!show) return null;

  return (
    <div
      role="presentation"
      onClick={dismiss}
      className={cn(
        "fixed inset-0 z-[200] grid place-items-center bg-black transition-opacity duration-200",
        leaving ? "opacity-0" : "opacity-100",
      )}
    >
      <video
        ref={videoRef}
        src={startupMovieUrl}
        autoPlay
        playsInline
        onEnded={dismiss}
        onError={dismiss}
        className="h-full w-full object-contain"
      />

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
        }}
        className={cn(
          "absolute bottom-8 right-8 rounded-md border border-white/15 bg-white/10 px-4 py-2",
          "text-sm font-semibold uppercase tracking-wide text-white/80 backdrop-blur",
          "transition-colors hover:bg-white/20 hover:text-white",
        )}
      >
        Skip
      </button>
    </div>
  );
}
