import { GamepadAxisActiveEvent } from "../gamepad/event";
import type { Hotkey } from ".";

const LEFT_STICK_HORIZONTAL_AXIS = 0;
const LEFT_STICK_VERTICAL_AXIS = 1;
const LEFT_STICK_NAVIGATION_THRESHOLD = 0.5;

export function gamepadAxisToHotkey(
  event: GamepadAxisActiveEvent,
): Hotkey | undefined {
  const { axis, value } = event.detail;

  if (Math.abs(value) < LEFT_STICK_NAVIGATION_THRESHOLD) {
    return undefined;
  }

  if (axis === LEFT_STICK_HORIZONTAL_AXIS) {
    return value < 0 ? "LEFT" : "RIGHT";
  }

  if (axis === LEFT_STICK_VERTICAL_AXIS) {
    return value < 0 ? "UP" : "DOWN";
  }

  return undefined;
}
