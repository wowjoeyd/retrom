import { ScrollArea, ScrollBar } from "@retrom/ui/components/scroll-area";
import { cn } from "@retrom/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { Group, useGroupContext } from "@/providers/fullscreen/group-context";
import { useEffect, useMemo, useRef } from "react";
import { HotkeyButton } from "../hotkey-button";
import { HotkeyHandlers, useHotkeys } from "@/providers/hotkeys";
import { ChevronLeft, ChevronRight } from "lucide-react";

declare global {
  export interface HotkeyZones {
    groupMenu: boolean;
  }
}

export function GroupMenu(
  props: Omit<JSX.IntrinsicElements["div"], "children">,
) {
  const { previousGroup, nextGroup, allGroups } = useGroupContext();
  const navigate = useNavigate();
  const { className, ...rest } = props;

  const handlers = useMemo(
    () =>
      ({
        PAGE_LEFT: {
          handler: () =>
            navigate({
              to: ".",
              search: (prev) => ({
                ...prev,
                activeGroupId: previousGroup?.id,
                restoreGridFocus: undefined,
              }),
            }),
          zone: "groupMenu",
        },
        PAGE_RIGHT: {
          handler: () =>
            navigate({
              to: ".",
              search: (prev) => ({
                ...prev,
                activeGroupId: nextGroup?.id,
                restoreGridFocus: undefined,
              }),
            }),
          zone: "groupMenu",
        },
      }) satisfies HotkeyHandlers,
    [navigate, previousGroup, nextGroup],
  );

  useHotkeys({ handlers });

  return (
    <div className={cn("animate-in fade-in", className)} {...rest}>
      <div className="flex items-center gap-1 px-2 py-1.5 pointer-events-auto touch-auto">
        <HotkeyButton
          hotkey="PAGE_LEFT"
          className="shrink-0 px-2"
          disabled={previousGroup?.id === undefined}
          onClick={handlers.PAGE_LEFT.handler}
        >
          <ChevronLeft size={18} />
        </HotkeyButton>

        <ScrollArea
          className={cn(
            // min-w-0 lets this flex item shrink below its tab content's
            // intrinsic width so the tabs scroll within the ScrollArea instead
            // of forcing the whole header (and page) wider.
            "relative w-full grow min-w-0",
            "before:absolute before:inset-y-0 before:left-0 before:w-12 before:z-10",
            "after:absolute after:inset-y-0 after:right-0 after:w-12 after:z-10",
            "before:bg-gradient-to-l before:from-transparent before:to-background",
            "after:bg-gradient-to-r after:from-transparent after:to-background",
            "after:pointer-events-none before:pointer-events-none",
            "after:touch-none before:touch-none",
          )}
        >
          <div className="flex items-center gap-2 w-max m-auto px-4 py-0.5">
            {allGroups?.map((group) => (
              <GroupEntry key={group.id} group={group} />
            ))}
          </div>

          <ScrollBar orientation="horizontal" className="hidden" />
        </ScrollArea>

        <HotkeyButton
          variant="ghost"
          hotkey="PAGE_RIGHT"
          className="shrink-0 flex-row-reverse px-2"
          disabled={nextGroup?.id === undefined}
          onClick={handlers.PAGE_RIGHT.handler}
        >
          <ChevronRight size={18} />
        </HotkeyButton>
      </div>
    </div>
  );
}

function GroupEntry(props: { group: Group }) {
  const { group } = props;
  const ref = useRef<HTMLAnchorElement>(null!);
  const { activeGroup } = useGroupContext();

  const active = activeGroup?.id === group.id;

  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({
        behavior: "smooth",
        inline: "center",
        block: "nearest",
      });
    }
  }, [active, group]);

  return (
    <Link
      ref={ref}
      className={cn(
        "shrink-0 rounded-full px-5 py-2 uppercase tracking-wide",
        "text-lg font-semibold flex items-center gap-2 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        active
          ? "bg-accent/90 text-accent-foreground"
          : "text-muted-foreground/70 hover:text-foreground hover:bg-foreground/10",
      )}
      to="."
      search={{ activeGroupId: group.id, restoreGridFocus: undefined }}
    >
      {group.name}
      <span
        className={cn(
          "text-sm font-medium tabular-nums",
          active ? "text-accent-foreground/70" : "text-muted-foreground/50",
        )}
      >
        {group.allGames.length}
      </span>
    </Link>
  );
}
