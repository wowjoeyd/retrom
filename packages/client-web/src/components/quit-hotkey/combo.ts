// Shared model for the quit-to-library controller combo, used by both the
// fullscreen and standard settings menus (which bind the same config value:
// interface.quitToLibraryHotkeyButtons) and by the rebind capture hook.
//
// Button indices follow the W3C "standard gamepad" mapping, exactly as the
// native gamepad reader reports them (see retrom-plugin-launcher's gamepad.rs).

import xboxA from "@/assets/controller-icons/xbox/xbox_button_a.svg";
import xboxB from "@/assets/controller-icons/xbox/xbox_button_b.svg";
import xboxX from "@/assets/controller-icons/xbox/xbox_button_x.svg";
import xboxY from "@/assets/controller-icons/xbox/xbox_button_y.svg";
import xboxBack from "@/assets/controller-icons/xbox/xbox_button_back.svg";
import xboxMenu from "@/assets/controller-icons/xbox/xbox_button_menu.svg";
import xboxGuide from "@/assets/controller-icons/xbox/xbox_guide.svg";
import xboxLb from "@/assets/controller-icons/xbox/xbox_lb.svg";
import xboxRb from "@/assets/controller-icons/xbox/xbox_rb.svg";
import xboxDpadUp from "@/assets/controller-icons/xbox/xbox_dpad_up.svg";
import xboxDpadDown from "@/assets/controller-icons/xbox/xbox_dpad_down.svg";
import xboxDpadLeft from "@/assets/controller-icons/xbox/xbox_dpad_left.svg";
import xboxDpadRight from "@/assets/controller-icons/xbox/xbox_dpad_right.svg";

/** Default combo (LB + RB + Menu) — mirrors COMBO in the native reader. Used
 *  when the user hasn't rebound the hotkey. */
export const DEFAULT_QUIT_COMBO = [4, 5, 9];

/** Buttons that can't be bound. Index 16 = Guide/home: Windows' Game Bar
 *  masks/claims it, so it's unreliable as a hotkey (it's also deliberately
 *  excluded from the default combo). */
export const RESERVED_QUIT_BUTTONS = new Set<number>([16]);

/** Fewest buttons a custom combo may have, kept in sync with the native
 *  MIN_COMBO_BUTTONS, so a single press can never quit a game. The held-duration
 *  requirement is the other half of that accident resistance. */
export const MIN_QUIT_COMBO_BUTTONS = 2;

type Glyph = { src?: string; label: string };

// The combo is XInput/Xbox-specific (the native reader only reads XInput pads),
// so Xbox glyphs are always correct here — matching the quit indicator overlay.
// Buttons without dedicated art (triggers, sticks) fall back to a text label.
const GLYPHS: Record<number, Glyph> = {
  0: { src: xboxA, label: "A" },
  1: { src: xboxB, label: "B" },
  2: { src: xboxX, label: "X" },
  3: { src: xboxY, label: "Y" },
  4: { src: xboxLb, label: "LB" },
  5: { src: xboxRb, label: "RB" },
  6: { label: "LT" },
  7: { label: "RT" },
  8: { src: xboxBack, label: "View" },
  9: { src: xboxMenu, label: "Menu" },
  10: { label: "LS" },
  11: { label: "RS" },
  12: { src: xboxDpadUp, label: "Up" },
  13: { src: xboxDpadDown, label: "Down" },
  14: { src: xboxDpadLeft, label: "Left" },
  15: { src: xboxDpadRight, label: "Right" },
  16: { src: xboxGuide, label: "Guide" },
};

export function quitButtonGlyph(index: number): Glyph {
  return GLYPHS[index] ?? { label: `#${index}` };
}

/** Human-readable combo, e.g. "LB + RB + Menu". */
export function quitComboLabel(buttons: readonly number[]): string {
  if (!buttons.length) return "None";
  return buttons.map((b) => quitButtonGlyph(b).label).join(" + ");
}

/** The bound combo, falling back to the default when unset/empty. */
export function resolveQuitCombo(
  buttons: readonly number[] | undefined,
): number[] {
  return buttons && buttons.length > 0 ? [...buttons] : [...DEFAULT_QUIT_COMBO];
}
