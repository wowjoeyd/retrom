import {
  createContext,
  Dispatch,
  SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type RetromInputDevice = (typeof RetromInputDevice)[number];
const RetromInputDevice = ["gamepad", "hotkeys", "touch"] as const;

type InputDeviceContext = Readonly<
  [RetromInputDevice, Dispatch<SetStateAction<RetromInputDevice>>]
>;

const context = createContext<InputDeviceContext | undefined>(undefined);

export function InputDeviceProvider(props: { children: React.ReactNode }) {
  const [inputDevice, setInputDevice] = useState<RetromInputDevice>("hotkeys");

  useEffect(() => {
    function onTouch() {
      setInputDevice("touch");
    }
    window.addEventListener("touchstart", onTouch, { passive: true });
    return () => window.removeEventListener("touchstart", onTouch);
  }, []);

  useEffect(() => {
    // Switch to gamepad mode on any button press, regardless of which element
    // is focused or whether a HotkeyLayer span is in the bubble path.
    // GamepadProvider dispatches on document.activeElement; if that element is
    // outside all HotkeyLayer spans (body, portal, dialog overlay, etc.) the
    // event never reaches a layer and setInputDevice("gamepad") is never called.
    function onGamepadButton() {
      setInputDevice("gamepad");
    }
    document.addEventListener("gamepad-button-down", onGamepadButton);
    return () => document.removeEventListener("gamepad-button-down", onGamepadButton);
  }, []);

  const value = useMemo(
    () => [inputDevice, setInputDevice] as const,
    [inputDevice, setInputDevice],
  );

  return <context.Provider value={value}>{props.children}</context.Provider>;
}

export function useInputDeviceContext() {
  const ctx = useContext(context);

  if (!ctx) {
    throw new Error(
      "useInputDeviceContext must be used within a InputDeviceProvider",
    );
  }

  return ctx;
}
