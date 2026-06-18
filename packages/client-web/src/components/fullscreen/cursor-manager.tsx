import { useEffect, useState } from "react";
import { useInputDeviceContext } from "@/providers/input-device";

/**
 * In fullscreen, hide the mouse cursor while the controller is the active input
 * and reveal it again the moment the mouse is physically moved — the way a game
 * or media player behaves. Mounted only inside the fullscreen layout, so it
 * never affects the windowed desktop UI and the cursor is restored on exit.
 */
export function FullscreenCursorManager() {
  const [inputDevice] = useInputDeviceContext();
  // Start hidden if we entered fullscreen via the controller (e.g. the
  // double-tap guide shortcut), so the cursor doesn't briefly flash.
  const [hidden, setHidden] = useState(inputDevice === "gamepad");

  useEffect(() => {
    // Any controller input hides the cursor.
    const hide = () => setHidden(true);
    document.addEventListener("gamepad-button-down", hide);
    document.addEventListener("gamepad-axes", hide);

    // Physical mouse movement reveals it. The browser also fires mousemove when
    // content scrolls under a stationary pointer (e.g. controller-driven grid
    // scrolling); those carry movementX/Y === 0, so we ignore them and only
    // react to real movement.
    const onMouseMove = (e: MouseEvent) => {
      if (e.movementX === 0 && e.movementY === 0) return;
      setHidden(false);
    };
    window.addEventListener("mousemove", onMouseMove, { passive: true });

    return () => {
      document.removeEventListener("gamepad-button-down", hide);
      document.removeEventListener("gamepad-axes", hide);
      window.removeEventListener("mousemove", onMouseMove);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("fs-cursor-hidden", hidden);
    return () => document.body.classList.remove("fs-cursor-hidden");
  }, [hidden]);

  return null;
}
