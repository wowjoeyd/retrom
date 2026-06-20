import { cn } from "@retrom/ui/lib/utils";
import { ComboGlyphs } from "./combo-glyphs";

/**
 * Live feedback shown while capturing a new combo: the buttons currently held
 * and a bar filling toward the hold-to-confirm threshold. Shared by both
 * settings menus.
 */
export function ComboCapturePreview(props: {
  held: readonly number[];
  progress: number;
  className?: string;
}) {
  const { held, progress, className } = props;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex min-h-[24px] items-center gap-2">
        {held.length > 0 ? (
          <ComboGlyphs buttons={held} />
        ) : (
          <span className="text-sm text-muted-foreground">
            Press &amp; hold the buttons you want…
          </span>
        )}
      </div>
      <div className="h-1 w-40 overflow-hidden rounded bg-primary/15">
        <div
          className="h-full bg-accent transition-[width] duration-75"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </div>
  );
}
