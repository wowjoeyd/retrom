import { useId } from "react";
import { cn } from "@retrom/ui/lib/utils";
import { Button } from "@retrom/ui/components/button";
import { FocusContainer, useFocusable } from "../../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { ComboGlyphs } from "@/components/quit-hotkey/combo-glyphs";
import { ComboCapturePreview } from "@/components/quit-hotkey/combo-capture-preview";
import { useComboCapture } from "@/components/quit-hotkey/use-combo-capture";
import { resolveQuitCombo } from "@/components/quit-hotkey/combo";

/**
 * Fullscreen (controller-driven) control for rebinding the quit-to-library
 * combo. Focusable like the other config rows: ACCEPT starts capture, then the
 * user holds the new combo on the pad (see {@link useComboCapture}). The bound
 * value is `interface.quitToLibraryHotkeyButtons`, shared with the standard
 * settings menu; an empty array means "use the default combo".
 */
export function QuitHotkeyRebind(props: {
  id?: string;
  value: number[];
  onChange: (combo: number[]) => void;
}) {
  const { id: _id, value, onChange } = props;
  const genId = useId();
  const id = `${_id ?? genId}-quit-rebind`;

  const { ref, focusSelf } = useFocusable<HTMLButtonElement>({ focusKey: id });
  const capture = useComboCapture(onChange);
  const capturing = capture.phase === "capturing";
  const resolved = resolveQuitCombo(value);

  return (
    <FocusContainer
      opts={{ focusKey: `${id}-container`, onFocus: () => focusSelf() }}
      className={cn(
        "relative flex flex-col gap-3 py-2 px-4 bg-transparent transition-colors",
        "before:absolute before:inset-y-0 before:left-0 before:w-0 before:bg-secondary before:transition-all",
        "focus-within:before:bg-accent focus-within:before:w-1 focus-within:bg-secondary/20",
        "hover:before:w-1 hover:bg-secondary/20 before:rounded-r hover:before:bg-accent",
      )}
    >
      <div className="flex flex-col gap-1">
        <span className="font-normal text-base leading-none">
          Quit to library combo
        </span>
        <span className="text-sm text-muted-foreground">
          {capturing
            ? "Hold the buttons you want, then keep holding to confirm"
            : "Hold this combo for ~1.5s while a game runs to quit back to Retrom"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        {capturing ? (
          <ComboCapturePreview held={capture.held} progress={capture.progress} />
        ) : (
          <ComboGlyphs buttons={resolved} />
        )}

        <div className="flex items-center gap-2">
          {!capturing && value.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange([])}
            >
              Reset
            </Button>
          )}

          <HotkeyLayer
            id={`${id}-hotkeys`}
            className="block"
            handlers={{
              ACCEPT: {
                handler: () => ref.current?.click(),
                actionBar: { label: capturing ? "Cancel" : "Rebind" },
              },
            }}
          >
            <Button
              ref={ref}
              type="button"
              variant="secondary"
              size="sm"
              className="focus-visible:ring-0"
              onClick={() => (capturing ? capture.cancel() : capture.start())}
            >
              {capturing ? "Cancel" : "Rebind"}
            </Button>
          </HotkeyLayer>
        </div>
      </div>
    </FocusContainer>
  );
}
