// Module-level switch the quit-hotkey combo-capture control flips while it is
// recording a new binding. When on, the GamepadProvider stops dispatching
// Gamepad-API input into the UI (the same way it already does while a game is
// running), so pressing the combo to capture it doesn't ALSO navigate menus or
// close the settings sheet (e.g. B = BACK).
//
// It's a plain module singleton rather than React context on purpose: the
// standard settings modal renders outside any GamepadProvider, and the capture
// hook needs to flip this regardless of where it's mounted.
let suppressed = false;

export function setGamepadUiSuppressed(value: boolean): void {
  suppressed = value;
}

export function isGamepadUiSuppressed(): boolean {
  return suppressed;
}
