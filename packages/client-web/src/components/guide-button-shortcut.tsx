import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useConfig } from "@/providers/config";
import { useHotkeyMapping } from "@/providers/hotkeys/mapping";

// How close together two guide-button presses must land to count as a
// double-tap, mirroring the feel of Steam Big Picture's shortcut.
const DOUBLE_TAP_WINDOW_MS = 400;

// Standard Gamepad index 16 = the guide/home button (Xbox ☒, PS button, etc.).
const DEFAULT_GUIDE_BUTTON = 16;

/**
 * Steam Big Picture style global shortcut: double-tapping the controller's
 * guide/home button opens fullscreen mode from anywhere (when enabled in
 * config).
 *
 * The fullscreen GamepadProvider only runs inside the fullscreen layout and only
 * polls pads it captured via a `gamepadconnected` event, so it can't drive this
 * from the windowed UI. Here we keep a permanent, always-on poll of the Gamepad
 * API at the app root — independent of the feature toggle — so the browser keeps
 * delivering controller state and the guide button is detected the instant it's
 * pressed in either layout. The toggle/route are checked when a press lands, not
 * to gate the poll itself. It's a no-op while already in fullscreen (there the
 * guide button toggles the menu).
 */
export function GuideButtonShortcut() {
  const navigate = useNavigate();
  const enabled = useConfig(
    (s) =>
      !!s.config?.interface?.fullscreenConfig?.doubleTapGuideOpensFullscreen,
  );
  const isFullscreen = useRouterState({
    select: (s) => s.location.pathname.startsWith("/fullscreen"),
  });

  // Mirror fast-changing values into refs so the permanent poll never needs to
  // re-subscribe (and so we don't touch refs during render).
  const enabledRef = useRef(enabled);
  const isFullscreenRef = useRef(isFullscreen);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  useEffect(() => {
    isFullscreenRef.current = isFullscreen;
  }, [isFullscreen]);

  useEffect(() => {
    // Some Chromium builds only start delivering gamepad state once a
    // gamepad listener is registered; register no-op listeners alongside the
    // polling loop so input flows in the windowed UI too.
    const noop = () => {};
    window.addEventListener("gamepadconnected", noop);
    window.addEventListener("gamepaddisconnected", noop);

    let frame = 0;
    let wasPressed = false;
    let lastTapAt = 0;
    let loggedSeen = false;

    const loop = () => {
      const guideButton =
        useHotkeyMapping.getState().hotkeyToGamepadButton.MENU ??
        DEFAULT_GUIDE_BUTTON;

      const pads = navigator.getGamepads?.() ?? [];
      let pressed = false;
      for (const pad of pads) {
        if (!pad) continue;
        if (import.meta.env.DEV && !loggedSeen) {
          loggedSeen = true;
          console.log(
            "[guide-shortcut] gamepad active:",
            pad.id,
            "buttons:",
            pad.buttons.length,
          );
        }
        if (pad.buttons.at(guideButton)?.pressed) {
          pressed = true;
          break;
        }
      }

      // Rising edge only — one tap per physical press.
      if (pressed && !wasPressed) {
        const now = performance.now();
        if (import.meta.env.DEV) {
          console.log(
            "[guide-shortcut] guide press — enabled:",
            enabledRef.current,
            "fullscreen:",
            isFullscreenRef.current,
            "since-last:",
            Math.round(now - lastTapAt),
          );
        }
        if (enabledRef.current && !isFullscreenRef.current) {
          if (now - lastTapAt <= DOUBLE_TAP_WINDOW_MS) {
            lastTapAt = 0;
            void navigate({ to: "/fullscreen" });
          } else {
            lastTapAt = now;
          }
        }
      }
      wasPressed = pressed;

      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("gamepadconnected", noop);
      window.removeEventListener("gamepaddisconnected", noop);
    };
  }, [navigate]);

  return null;
}
