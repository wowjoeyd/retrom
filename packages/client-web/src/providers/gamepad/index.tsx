import { useToast } from "@retrom/ui/hooks/use-toast";
import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GamepadButtonUpEvent,
  GamepadButtonDownEvent,
  GamepadAxisActiveEvent,
  GamepadAxisInactiveEvent,
} from "./event";
import { getControllerMapping } from "./controller-ids";
import { ControllerMapping } from "./maps";
import { axisValueToAxisState, GamepadAxisState } from "./utils";

const DPAD_BUTTONS = new Set([12, 13, 14, 15]);
const LEFT_STICK_NAVIGATION_AXES = new Set([0, 1]);
const LEFT_STICK_NAVIGATION_THRESHOLD = 0.5;
const REPEAT_START_DELAY_MS = 300;
const REPEAT_START_INTERVAL_MS = 190;
const REPEAT_MIN_INTERVAL_MS = 60;
const REPEAT_ACCELERATION_MS = 18;

type RepeatInputState = {
  startedAt: number;
  lastFiredAt: number;
  repeatCount: number;
};

function getRepeatInterval(repeatCount: number) {
  return Math.max(
    REPEAT_MIN_INTERVAL_MS,
    REPEAT_START_INTERVAL_MS - repeatCount * REPEAT_ACCELERATION_MS,
  );
}

function getAxisState(axis: number, value: number) {
  return axisValueToAxisState(
    value,
    LEFT_STICK_NAVIGATION_AXES.has(axis)
      ? LEFT_STICK_NAVIGATION_THRESHOLD
      : undefined,
  );
}

function getButtonRepeatKey(gamepadIndex: number, button: number) {
  return `${gamepadIndex}:button:${button}`;
}

function getAxisRepeatKey(
  gamepadIndex: number,
  axis: number,
  state: GamepadAxisState,
) {
  return `${gamepadIndex}:axis:${axis}:${state}`;
}

function isActiveAxisState(state: GamepadAxisState) {
  return state !== GamepadAxisState.Neutral;
}

export interface RetromGamepad {
  gamepad: Gamepad;
  controllerType: ControllerMapping;
}

export type GamepadContext = {
  gamepads: RetromGamepad[] | undefined;
};

type GamepadInputCache = {
  /** Map of gamepad index to button states */
  buttons: Map<number, boolean[]>;

  /** Map of gamepad index to axes states */
  axes: Map<number, number[]>;
};

const context = createContext<GamepadContext | undefined>(undefined);

export function GamepadProvider(props: PropsWithChildren) {
  const [gamepads, setGamepads] = useState<RetromGamepad[]>([]);
  const [inputCache, setInputCache] = useState<GamepadInputCache>({
    buttons: new Map(),
    axes: new Map(),
  });
  const repeatInputs = useRef(new Map<string, RepeatInputState>());

  const { toast } = useToast();

  const beginRepeatInput = useCallback((key: string, now: number) => {
    repeatInputs.current.set(key, {
      startedAt: now,
      lastFiredAt: now,
      repeatCount: 0,
    });
  }, []);

  const stopRepeatInput = useCallback((key: string) => {
    repeatInputs.current.delete(key);
  }, []);

  const maybeDispatchRepeatInput = useCallback(
    (key: string, now: number, dispatch: () => void) => {
      const input = repeatInputs.current.get(key);

      if (!input || now - input.startedAt < REPEAT_START_DELAY_MS) {
        return;
      }

      if (now - input.lastFiredAt < getRepeatInterval(input.repeatCount)) {
        return;
      }

      dispatch();
      input.lastFiredAt = now;
      input.repeatCount += 1;
    },
    [],
  );

  const onDisconnect = useCallback(
    (e: GamepadEvent) => {
      if (gamepads.some(({ gamepad }) => gamepad.id === e.gamepad.id)) {
        setGamepads((prev) =>
          prev.filter(({ gamepad }) => gamepad.id !== e.gamepad.id),
        );

        const mapping = getControllerMapping(e.gamepad);

        toast({
          title: "Gamepad disconnected",
          description: `Your ${mapping} controller has been disconnected`,
        });
      }
    },
    [gamepads, toast],
  );

  const pollGamepad = useCallback(() => {
    const node = document.activeElement;
    const now = performance.now();

    for (const connectedPad of gamepads) {
      const pad = navigator.getGamepads().at(connectedPad.gamepad.index);

      if (pad) {
        const { buttons, index } = pad;
        const currentButtonInputs = inputCache.buttons.get(index);
        let changed = false;

        for (let i = 0; i < buttons.length; i++) {
          const currentlyPressed = buttons.at(i)?.pressed;
          const previouslyPressed = currentButtonInputs?.at(i);
          const repeatKey = getButtonRepeatKey(index, i);

          if (
            currentlyPressed !== previouslyPressed &&
            currentlyPressed !== undefined
          ) {
            changed = true;

            if (currentlyPressed) {
              node?.dispatchEvent(
                new GamepadButtonDownEvent({
                  gamepad: pad,
                  button: i,
                }),
              );

              if (DPAD_BUTTONS.has(i)) {
                beginRepeatInput(repeatKey, now);
              }
            } else {
              stopRepeatInput(repeatKey);
              node?.dispatchEvent(
                new GamepadButtonUpEvent({
                  gamepad: pad,
                  button: i,
                }),
              );
            }
          } else if (currentlyPressed && DPAD_BUTTONS.has(i)) {
            maybeDispatchRepeatInput(repeatKey, now, () => {
              node?.dispatchEvent(
                new GamepadButtonDownEvent({
                  gamepad: pad,
                  button: i,
                  repeat: true,
                }),
              );
            });
          }
        }

        for (let i = 0; i < pad.axes.length; i++) {
          const value = pad.axes.at(i) ?? 0;
          const cachedValue = inputCache.axes.get(index)?.at(i) ?? 0;

          const currentState = getAxisState(i, value);
          const previousState = getAxisState(i, cachedValue);
          const currentRepeatKey = getAxisRepeatKey(index, i, currentState);
          const previousRepeatKey = getAxisRepeatKey(index, i, previousState);

          if (currentState !== previousState) {
            changed = true;

            if (
              LEFT_STICK_NAVIGATION_AXES.has(i) &&
              isActiveAxisState(previousState)
            ) {
              stopRepeatInput(previousRepeatKey);
            }

            if (currentState !== GamepadAxisState.Neutral) {
              node?.dispatchEvent(
                new GamepadAxisActiveEvent({
                  gamepad: pad,
                  axis: i,
                  value,
                }),
              );

              if (LEFT_STICK_NAVIGATION_AXES.has(i)) {
                beginRepeatInput(currentRepeatKey, now);
              }
            } else {
              node?.dispatchEvent(
                new GamepadAxisInactiveEvent({
                  gamepad: pad,
                  axis: i,
                  value,
                }),
              );
            }
          } else if (
            LEFT_STICK_NAVIGATION_AXES.has(i) &&
            isActiveAxisState(currentState)
          ) {
            maybeDispatchRepeatInput(currentRepeatKey, now, () => {
              node?.dispatchEvent(
                new GamepadAxisActiveEvent({
                  gamepad: pad,
                  axis: i,
                  value,
                  repeat: true,
                }),
              );
            });
          }
        }

        if (changed) {
          const buttonInputs = buttons.map((b) => b.pressed);
          const axesInputs = pad.axes.map((a) => a);
          setInputCache((cache) => {
            cache.buttons.set(index, buttonInputs);
            cache.axes.set(index, axesInputs);

            return { ...cache };
          });
        }
      }
    }
  }, [
    beginRepeatInput,
    inputCache,
    gamepads,
    maybeDispatchRepeatInput,
    stopRepeatInput,
  ]);

  const onConnect = useCallback(
    (e: GamepadEvent) => {
      const mapping = getControllerMapping(e.gamepad);
      const pad: RetromGamepad = {
        gamepad: e.gamepad,
        controllerType: mapping,
      };

      // Dedup by index: a pad may already be tracked from the mount-time seed
      // (see below) or a duplicate connect event.
      setGamepads((prev) =>
        prev.some((p) => p.gamepad.index === e.gamepad.index)
          ? prev
          : [...prev, pad],
      );
      pollGamepad();

      console.log(`Gamepad connected: ${e.gamepad.id}`);

      toast({
        title: "Gamepad connected",
        description: `Now using your ${mapping} controller`,
      });
    },
    [toast, pollGamepad],
  );

  // Seed from already-connected pads on mount. `gamepadconnected` only fires
  // once per pad for the document, so if a controller was connected before this
  // provider mounted (e.g. it was used in the windowed UI, or was already on at
  // launch) the event has come and gone and onConnect would never run — leaving
  // the controller dead until it's power-cycled. Polling navigator.getGamepads()
  // here picks those pads up regardless of when they connected.
  useEffect(() => {
    const present = navigator.getGamepads?.() ?? [];
    const seeded = present.filter((p): p is Gamepad => !!p);
    if (seeded.length === 0) return;

    setGamepads((prev) => {
      const next = [...prev];
      for (const gp of seeded) {
        if (!next.some((p) => p.gamepad.index === gp.index)) {
          next.push({ gamepad: gp, controllerType: getControllerMapping(gp) });
        }
      }
      return next;
    });
    // Run once on mount.
  }, []);

  useEffect(() => {
    let frame: number;

    const loop = () => {
      pollGamepad();
      frame = requestAnimationFrame(loop);
    };

    frame = requestAnimationFrame(loop);

    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);

    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
      cancelAnimationFrame(frame);
    };
  }, [onDisconnect, onConnect, pollGamepad]);

  return (
    <context.Provider
      value={useMemo(() => ({ gamepads }), [gamepads])}
      {...props}
    />
  );
}

export function useGamepadContext() {
  const ctx = useContext(context);

  if (!ctx) {
    throw new Error("useGamepad must be used within a GamepadProvider");
  }

  return ctx;
}
