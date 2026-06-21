import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { checkIsDesktop } from "@/lib/env";
import { setQuitRebindActive } from "@retrom/plugin-launcher";
import { setGamepadUiSuppressed } from "@/providers/gamepad/capture-suppression";
import {
  MIN_QUIT_COMBO_BUTTONS,
  RESERVED_QUIT_BUTTONS,
  quitButtonGlyph,
} from "./combo";

/** How long a stable set of buttons must be held before it's captured. Long
 *  enough to be deliberate (and to assemble a chord), shorter than the 1.5s
 *  runtime hold so capture feels responsive. */
const HOLD_TO_CAPTURE_MS = 800;

/** Auto-cancel capture after this long with no buttons held. Acts as the escape
 *  hatch for controller users: while capturing, gamepad input is suppressed (so
 *  it can't close the menu), so "let go and wait" is how you back out. */
const IDLE_CANCEL_MS = 6000;

type RebindButtons = { buttons: number[] };

export type ComboCapturePhase = "idle" | "capturing";

export type ComboCapture = {
  phase: ComboCapturePhase;
  /** Buttons currently held, for a live preview while capturing. */
  held: number[];
  /** Progress (0–1) toward locking in the currently-held set. */
  progress: number;
  start: () => void;
  cancel: () => void;
};

/**
 * Captures a new quit-to-library combo from the controller. Press and hold the
 * desired buttons; once the held set is stable for {@link HOLD_TO_CAPTURE_MS} it
 * is validated and handed to `onCapture` (sorted, de-duped). Reserved buttons
 * (Guide) and too-short combos are rejected with a toast.
 *
 * Input source is the native gamepad reader's `quit-rebind:buttons` event (so
 * the Guide button — invisible to the WebView2 Gamepad API — can be detected and
 * rejected), unioned with the Gamepad API as a cross-platform fallback. While
 * capturing, normal gamepad→UI input is suppressed so the presses don't navigate
 * or close the settings menu.
 */
export function useComboCapture(
  onCapture: (buttons: number[]) => void,
): ComboCapture {
  const { toast } = useToast();
  const [phase, setPhase] = useState<ComboCapturePhase>("idle");
  const [held, setHeld] = useState<number[]>([]);
  const [progress, setProgress] = useState(0);

  // Latest native-reported held set; read by the rAF driver each frame.
  const nativeHeldRef = useRef<number[]>([]);
  const onCaptureRef = useRef(onCapture);
  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  const teardown = useCallback(() => {
    nativeHeldRef.current = [];
    setHeld([]);
    setProgress(0);
    setGamepadUiSuppressed(false);
    if (checkIsDesktop())
      void setQuitRebindActive(false).catch(() => undefined);
  }, []);

  const cancel = useCallback(() => {
    setPhase("idle");
    teardown();
  }, [teardown]);

  const commit = useCallback(
    (buttons: number[]) => {
      const sorted = [...new Set(buttons)].sort((a, b) => a - b);

      const reserved = sorted.filter((b) => RESERVED_QUIT_BUTTONS.has(b));
      if (reserved.length > 0) {
        toast({
          title: "That button can't be used",
          description: `The ${reserved
            .map((b) => quitButtonGlyph(b).label)
            .join(
              ", ",
            )} button is reserved by the system. Pick a different combo.`,
          variant: "destructive",
        });
        setPhase("idle");
        teardown();
        return;
      }

      if (sorted.length < MIN_QUIT_COMBO_BUTTONS) {
        toast({
          title: "Use at least two buttons",
          description:
            "Hold two or more buttons together so the combo isn't triggered by accident.",
          variant: "destructive",
        });
        setPhase("idle");
        teardown();
        return;
      }

      onCaptureRef.current(sorted);
      toast({
        title: "Hotkey combo captured",
        description: "Save your settings to apply the new combo.",
      });
      setPhase("idle");
      teardown();
    },
    [toast, teardown],
  );

  const start = useCallback(() => {
    nativeHeldRef.current = [];
    setHeld([]);
    setProgress(0);
    setGamepadUiSuppressed(true);
    if (checkIsDesktop()) void setQuitRebindActive(true).catch(() => undefined);
    setPhase("capturing");
  }, []);

  // Native button stream (desktop) — the only source that sees the Guide button.
  useEffect(() => {
    if (!checkIsDesktop()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<RebindButtons>("quit-rebind:buttons", ({ payload }) => {
      nativeHeldRef.current = payload?.buttons ?? [];
    }).then((fn) => (disposed ? fn() : (unlisten = fn)));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // rAF driver: unions the native set with the Gamepad API and runs the
  // press-and-hold timer. A change to the held set restarts the timer, so the
  // user has to settle on a stable chord (and releasing won't capture a subset).
  useEffect(() => {
    if (phase !== "capturing") return;

    let frame = 0;
    let candidate: number[] = [];
    let candidateSince = 0;
    let idleSince = performance.now();

    const equal = (a: number[], b: number[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);

    const loop = () => {
      const now = performance.now();

      const union = new Set<number>(nativeHeldRef.current);
      for (const pad of navigator.getGamepads?.() ?? []) {
        if (!pad) continue;
        pad.buttons.forEach((btn, i) => {
          if (btn.pressed) union.add(i);
        });
      }
      const buttons = [...union].sort((a, b) => a - b);

      setHeld((prev) => (equal(prev, buttons) ? prev : buttons));

      if (buttons.length > 0) {
        idleSince = now;
      } else if (now - idleSince >= IDLE_CANCEL_MS) {
        cancel();
        return; // cancel() flips phase to idle; stop the loop.
      }

      if (buttons.length === 0) {
        candidate = [];
        candidateSince = 0;
        setProgress((p) => (p === 0 ? p : 0));
      } else if (!equal(buttons, candidate)) {
        candidate = buttons;
        candidateSince = now;
        setProgress((p) => (p === 0 ? p : 0));
      } else {
        const elapsed = now - candidateSince;
        if (elapsed >= HOLD_TO_CAPTURE_MS) {
          commit(candidate);
          return; // commit() flips phase to idle; stop the loop.
        }
        const next = Math.min(1, elapsed / HOLD_TO_CAPTURE_MS);
        setProgress((p) => (Math.abs(p - next) > 0.02 ? next : p));
      }

      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [phase, commit, cancel]);

  // Failsafe: if the component unmounts mid-capture, drop suppression and the
  // native rebind flag so they don't get stuck on.
  useEffect(() => {
    return () => {
      setGamepadUiSuppressed(false);
      if (checkIsDesktop())
        void setQuitRebindActive(false).catch(() => undefined);
    };
  }, []);

  return { phase, held, progress, start, cancel };
}
