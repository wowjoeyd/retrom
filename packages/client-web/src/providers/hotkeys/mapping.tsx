import { Hotkey } from ".";
import { create } from "zustand";
import { persist } from "zustand/middleware";

const DefaultHotkeyToKeyboardHotkey: Record<Hotkey, KeyboardEvent["key"]> = {
  ACCEPT: "f",
  BACK: "b",
  MENU: "m",
  OPTION: "t",
  SORT: "y",
  FILTER: "x",
  UP: "k",
  LEFT: "h",
  DOWN: "j",
  RIGHT: "l",
  PAGE_LEFT: "q",
  PAGE_RIGHT: "e",
} as const;

/**
 * Follows the standard mapping defined in the Gamepad API spec
 * @see https://w3c.github.io/gamepad/#dfn-standard-gamepad
 **/
const DefaultHotkeyToGamepadButton: Record<Hotkey, number> = {
  ACCEPT: 0,
  BACK: 1,
  MENU: 16,
  // Standard Gamepad index 9 = Xbox "Menu" (☰) / DualShock "Options" / Switch
  // "+" — the Start-style button used to open per-game options.
  OPTION: 9,
  // Standard Gamepad index 3 = Xbox "Y" / DualShock "△" / Switch top-left face.
  SORT: 3,
  // Standard Gamepad index 2 = Xbox "X" / DualShock "□" / Switch west face.
  FILTER: 2,
  UP: 12,
  DOWN: 13,
  LEFT: 14,
  RIGHT: 15,
  PAGE_LEFT: 4,
  PAGE_RIGHT: 5,
} as const;

function reverseObject<K extends string | number, V extends string | number>(
  obj: Record<K, V>,
): Record<V, K> {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [v, k]),
  ) as Record<V, K>;
}

export type HotkeyMappingState = {
  /**
   * Gamepad button to {@link Hotkey} mapping.
   */
  gamepadToHotkey: Record<number, Hotkey>;

  /**
   * Keyboard event key to {@link Hotkey} mapping.
   */
  keyboardToHotkey: Record<string, Hotkey>;

  hotkeyToKeyboard: Record<Hotkey, string>;
  hotkeyToGamepadButton: Record<Hotkey, number>;

  setKeyboardMap: (
    cb: (map: Record<Hotkey, string>) => Record<Hotkey, string>,
  ) => void;
  setGamepadMap: (
    cb: (map: Record<Hotkey, number>) => Record<Hotkey, number>,
  ) => void;
};

export const useHotkeyMapping = create<HotkeyMappingState>()(
  persist(
    (set, get) => ({
      keyboardToHotkey: reverseObject(DefaultHotkeyToKeyboardHotkey),
      gamepadToHotkey: reverseObject(DefaultHotkeyToGamepadButton),

      hotkeyToKeyboard: DefaultHotkeyToKeyboardHotkey,
      hotkeyToGamepadButton: DefaultHotkeyToGamepadButton,

      setKeyboardMap: (cb) => {
        const next = cb(get().hotkeyToKeyboard);

        return set({
          hotkeyToKeyboard: next,
          keyboardToHotkey: reverseObject(next),
        });
      },
      setGamepadMap: (cb) => {
        const next = cb(get().hotkeyToGamepadButton);

        return set({
          hotkeyToGamepadButton: next,
          gamepadToHotkey: reverseObject(next),
        });
      },
    }),
    {
      name: "retrom-hotkey-mapping",
      version: 4,
      // Existing persisted maps predate the SORT (v2) and FILTER (v3) hotkeys
      // and bound OPTION to the View button (v4 moves it to Start); patch each
      // forward without resetting a user's other custom bindings.
      migrate: (persisted, version) => {
        const state = persisted as HotkeyMappingState;

        if (version < 2) {
          state.hotkeyToKeyboard = {
            ...state.hotkeyToKeyboard,
            SORT: state.hotkeyToKeyboard?.SORT ?? "y",
          };
          state.hotkeyToGamepadButton = {
            ...state.hotkeyToGamepadButton,
            SORT: state.hotkeyToGamepadButton?.SORT ?? 3,
          };
        }

        if (version < 3) {
          state.hotkeyToKeyboard = {
            ...state.hotkeyToKeyboard,
            FILTER: state.hotkeyToKeyboard?.FILTER ?? "x",
          };
          state.hotkeyToGamepadButton = {
            ...state.hotkeyToGamepadButton,
            FILTER: state.hotkeyToGamepadButton?.FILTER ?? 2,
          };
        }

        if (version < 4) {
          // Move OPTION from the View button (8) to the Start button (9). Only
          // rewrite the old default so a user's custom binding is preserved.
          if (state.hotkeyToGamepadButton?.OPTION === 8) {
            state.hotkeyToGamepadButton = {
              ...state.hotkeyToGamepadButton,
              OPTION: 9,
            };
          }
        }

        state.keyboardToHotkey = reverseObject(state.hotkeyToKeyboard);
        state.gamepadToHotkey = reverseObject(state.hotkeyToGamepadButton);

        return state;
      },
    },
  ),
);
