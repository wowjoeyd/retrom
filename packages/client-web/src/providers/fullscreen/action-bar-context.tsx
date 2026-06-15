import { Hotkey } from "@/providers/hotkeys";
import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

export type ActionBarHint = {
  hotkey: Hotkey;
  label: string;
};

type ActionBarContextValue = {
  hints: ActionBarHint[];
  registerHints: (id: string, hints: ActionBarHint[]) => void;
  unregisterHints: (id: string) => void;
};

const ActionBarContext = createContext<ActionBarContextValue | null>(null);

export function ActionBarProvider({ children }: PropsWithChildren) {
  const [hintRegistry, setHintRegistry] = useState<
    Map<string, ActionBarHint[]>
  >(new Map());

  const registerHints = useCallback((id: string, hints: ActionBarHint[]) => {
    setHintRegistry((prev) => new Map(prev).set(id, hints));
  }, []);

  const unregisterHints = useCallback((id: string) => {
    setHintRegistry((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Last-registered wins for any given hotkey (most specific route overrides).
  const hints = useMemo<ActionBarHint[]>(() => {
    const seen = new Set<Hotkey>();
    const out: ActionBarHint[] = [];
    for (const group of [...hintRegistry.values()].reverse()) {
      for (const h of group) {
        if (!seen.has(h.hotkey)) {
          seen.add(h.hotkey);
          out.unshift(h);
        }
      }
    }
    return out;
  }, [hintRegistry]);

  const value = useMemo(
    () => ({ hints, registerHints, unregisterHints }),
    [hints, registerHints, unregisterHints],
  );

  return (
    <ActionBarContext.Provider value={value}>
      {children}
    </ActionBarContext.Provider>
  );
}

export function useActionBarContext(): ActionBarContextValue {
  return (
    useContext(ActionBarContext) ?? {
      hints: [],
      registerHints: () => {},
      unregisterHints: () => {},
    }
  );
}

/**
 * Register contextual action bar hints for the lifetime of the calling
 * component. Hints are unregistered automatically on unmount.
 * Pass a stable array literal — hints are captured once on mount.
 */
export function useActionBar(hints: ActionBarHint[]) {
  const id = useId();
  const { registerHints, unregisterHints } = useActionBarContext();
  const hintsRef = useRef(hints);

  useEffect(() => {
    registerHints(id, hintsRef.current);
    return () => unregisterHints(id);
  }, [id, registerHints, unregisterHints]);
}
