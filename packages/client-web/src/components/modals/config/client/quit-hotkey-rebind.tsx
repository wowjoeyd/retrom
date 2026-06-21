import { Button } from "@retrom/ui/components/button";
import { ComboGlyphs } from "@/components/quit-hotkey/combo-glyphs";
import { ComboCapturePreview } from "@/components/quit-hotkey/combo-capture-preview";
import { useComboCapture } from "@/components/quit-hotkey/use-combo-capture";
import { resolveQuitCombo } from "@/components/quit-hotkey/combo";

/**
 * Standard (windowed) settings control for rebinding the quit-to-library combo.
 * Binds `interface.quitToLibraryHotkeyButtons` — the same value the fullscreen
 * menu writes — so a rebind in either place shows up in both. An empty array
 * means "use the default combo".
 */
export function QuitHotkeyRebind(props: {
  value: number[];
  onChange: (combo: number[]) => void;
}) {
  const { value, onChange } = props;
  const capture = useComboCapture(onChange);
  const capturing = capture.phase === "capturing";
  const resolved = resolveQuitCombo(value);

  return (
    <div className="flex flex-col gap-2">
      <span className="leading-none">Quit to library combo</span>
      <p className="max-w-[45ch] text-sm text-muted-foreground">
        The combo to hold while a game is running. Press Rebind, then press and
        hold the buttons you want on your controller.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {capturing ? (
          <ComboCapturePreview
            held={capture.held}
            progress={capture.progress}
          />
        ) : (
          <ComboGlyphs buttons={resolved} />
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => (capturing ? capture.cancel() : capture.start())}
          >
            {capturing ? "Cancel" : "Rebind"}
          </Button>

          {!capturing && value.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange([])}
            >
              Reset to default
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
