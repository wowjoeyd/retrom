import { ReactNode } from "react";
import { cn } from "@retrom/ui/lib/utils";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@retrom/ui/components/sheet";
import { Hotkey } from "@/providers/hotkeys";
import { HotkeyIcon } from "../hotkey-button";

// Shared chrome for the fullscreen slide-out panels so the global menu, library,
// config, and game-actions sheets read consistently: an icon-led header with a
// title + subtitle, and a pinned footer of controller hint glyphs (mirrors the
// already-polished Sort/Filter sheets).

export function PanelHeader(props: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
}) {
  const { icon, title, subtitle, className } = props;

  return (
    <SheetHeader
      className={cn(
        "flex-row items-center gap-3 border-b border-border/60 bg-muted/20 px-5 py-4",
        className,
      )}
    >
      {icon && (
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent-text">
          {icon}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <SheetTitle className="text-lg leading-tight">{title}</SheetTitle>
        {subtitle && (
          <SheetDescription className="text-xs leading-snug">
            {subtitle}
          </SheetDescription>
        )}
      </div>
    </SheetHeader>
  );
}

export function PanelHints(props: {
  hints: { hotkey: Hotkey; label: string; muted?: boolean }[];
  className?: string;
}) {
  const { hints, className } = props;

  return (
    <div
      className={cn(
        "flex items-center justify-end gap-4 border-t border-border/60 bg-muted/10 px-5 py-2.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {hints.map(({ hotkey, label, muted }) => (
        <span
          key={`${hotkey}-${label}`}
          className={cn("flex items-center gap-1.5", muted && "opacity-50")}
        >
          <HotkeyIcon hotkey={hotkey} />
          {label}
        </span>
      ))}
    </div>
  );
}

// A grouped section of related setting/action rows, with an uppercase label.
export function PanelSection(props: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { title, children, className } = props;

  return (
    <section className={cn("flex flex-col gap-1.5", className)}>
      {title && (
        <h3 className="px-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">
          {title}
        </h3>
      )}
      <div className="flex flex-col gap-1 overflow-hidden rounded-lg border border-border/50 bg-muted/10 p-1">
        {children}
      </div>
    </section>
  );
}
