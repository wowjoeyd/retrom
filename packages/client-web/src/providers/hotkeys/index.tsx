import {
  KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
} from "react";
import { HotkeyZone, useHotkeyLayerContext } from "./layers";
import {
  GamepadAxisActiveEvent,
  GamepadButtonDownEvent,
} from "../gamepad/event";
import { useInputDeviceContext } from "../input-device";
import { useHotkeyMapping } from "./mapping";
import { gamepadAxisToHotkey } from "./gamepad-axis";
import { isGamepadUiSuppressed } from "../gamepad/capture-suppression";

export type Hotkey = (typeof Hotkey)[number];
export const Hotkey = [
  "ACCEPT",
  "BACK",
  "MENU",
  "OPTION",
  "SORT",
  "FILTER",
  "LEFT",
  "RIGHT",
  "UP",
  "DOWN",
  "PAGE_LEFT",
  "PAGE_RIGHT",
] as const;

export type HotkeyHandler = (
  event?:
    | KeyboardEvent
    | ReactKeyboardEvent
    | GamepadButtonDownEvent
    | GamepadAxisActiveEvent,
) => unknown;

export type HotkeyHandlerInfo = {
  handler?: HotkeyHandler | undefined;
  zone?: HotkeyZone;
  actionBar?: {
    label?: string;
    position?: "left" | "right";
  };
};

export type HotkeyHandlers = Partial<Record<Hotkey, HotkeyHandlerInfo>>;

export function useHotkeys(opts: {
  handlers: HotkeyHandlers;
  enabled?: boolean;
}) {
  const { handlers, enabled = true } = opts;
  const layerContext = useHotkeyLayerContext();
  const { keyboardToHotkey, gamepadToHotkey } = useHotkeyMapping();
  const [_, setInputDevice] = useInputDeviceContext();

  const handleHotkey = useCallback(
    (
      hotkey: Hotkey | undefined,
      event?:
        | KeyboardEvent
        | ReactKeyboardEvent
        | GamepadButtonDownEvent
        | GamepadAxisActiveEvent,
    ) => {
      if (!hotkey) {
        return;
      }

      const handlerInfo = handlers[hotkey];
      if (!handlerInfo) {
        return;
      }

      const { handler, zone } = handlerInfo;

      const zoneActive = layerContext?.isZoneActive(zone) ?? true;
      if (!zoneActive || !handler) {
        return;
      }

      if (
        event instanceof GamepadButtonDownEvent ||
        event instanceof GamepadAxisActiveEvent
      ) {
        setInputDevice("gamepad");
      } else {
        setInputDevice("hotkeys");
      }

      handler(event);
    },
    [handlers, layerContext, setInputDevice],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) {
        return;
      }

      // While the quit-combo capture is recording, swallow keyboard hotkeys too.
      // The gamepad paths are already suppressed at their source, but controllers
      // that present as a keyboard (common on Windows handhelds / emulation
      // setups) arrive here — and would navigate/close the menu mid-capture
      // instead of being recorded. Blocking them keeps capture exclusive.
      if (isGamepadUiSuppressed()) {
        return;
      }

      const pressed = event.key;
      const hotkey = keyboardToHotkey[pressed];

      handleHotkey(hotkey, event);
    },
    [enabled, handleHotkey, keyboardToHotkey],
  );

  const onGamepadButton = useCallback(
    (event: GamepadButtonDownEvent) => {
      const button = event.detail.button;
      const pressed = event.detail.gamepad.buttons.at(button)?.pressed;

      if (!enabled || !pressed) {
        return;
      }

      const hotkey = gamepadToHotkey[button];
      handleHotkey(hotkey, event);
    },
    [enabled, handleHotkey, gamepadToHotkey],
  );

  const onGamepadAxis = useCallback(
    (event: GamepadAxisActiveEvent) => {
      if (!enabled) {
        return;
      }

      const hotkey = gamepadAxisToHotkey(event);
      handleHotkey(hotkey, event);
    },
    [enabled, handleHotkey],
  );

  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener(
      GamepadButtonDownEvent.EVENT_NAME,
      onGamepadButton,
    );
    document.addEventListener(GamepadAxisActiveEvent.EVENT_NAME, onGamepadAxis);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener(
        GamepadButtonDownEvent.EVENT_NAME,
        onGamepadButton,
      );
      document.removeEventListener(
        GamepadAxisActiveEvent.EVENT_NAME,
        onGamepadAxis,
      );
    };
  }, [onKeyDown, onGamepadButton, onGamepadAxis]);
}
