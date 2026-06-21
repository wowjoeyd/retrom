import { Fragment } from "react";
import { cn } from "@retrom/ui/lib/utils";
import { quitButtonGlyph } from "./combo";

/**
 * Renders a controller combo (standard-gamepad button indices) as a row of Xbox
 * glyphs joined by "+", e.g. LB + RB + Menu. Buttons without dedicated art show
 * a small text chip instead. Shared by both settings menus to display the
 * current quit-to-library binding.
 */
export function ComboGlyphs(props: {
  buttons: readonly number[];
  size?: number;
  className?: string;
}) {
  const { buttons, size = 22, className } = props;

  if (!buttons.length) {
    return <span className="text-sm text-muted-foreground">Not set</span>;
  }

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      {buttons.map((button, i) => {
        const glyph = quitButtonGlyph(button);
        return (
          <Fragment key={`${button}-${i}`}>
            {i > 0 && (
              <span className="text-sm font-semibold opacity-50">+</span>
            )}
            {glyph.src ? (
              <img
                src={glyph.src}
                alt={glyph.label}
                title={glyph.label}
                style={{ width: size, height: size }}
                className="object-contain"
              />
            ) : (
              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-semibold uppercase">
                {glyph.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </span>
  );
}
