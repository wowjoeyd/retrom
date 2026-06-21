import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
} from "@retrom/ui/components/sheet";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  getCurrentFocusKey,
  setFocus,
} from "@noriginmedia/norigin-spatial-navigation";
import { Check } from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { useHotkeys } from "@/providers/hotkeys";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer, useFocusable } from "../focus-container";
import { HotkeyIcon } from "../hotkey-button";
import {
  FILTER_OPTIONS,
  FilterKey,
  FilterSection,
  useGroupContext,
} from "@/providers/fullscreen/group-context";
import { setQuickScrollPaused } from "../alphabet-scroll-overlay";
import { setGridAutoFocusSuppressed } from "../grid-game-list";

declare global {
  export interface HotkeyZones {
    filterSheet: boolean;
  }
}

// Section render order. Each section's rows are OR'd; sections are AND'd.
const SECTIONS: FilterSection[] = ["Availability", "Source"];

export function FilterSheet() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { filters } = useSearch({ from: "/_fullscreenLayout" });
  const { activeGroup } = useGroupContext();

  const activeFilters = filters ?? [];
  const activeCount = activeFilters.length;

  // The grid card focused when the sheet opened, so close can restore it.
  const savedFocusKey = useRef<string | undefined>(undefined);

  useHotkeys({
    enabled: !open,
    handlers: {
      FILTER: {
        handler: () => {
          savedFocusKey.current = getCurrentFocusKey();
          setOpen(true);
        },
      },
    },
  });

  // While the sheet owns focus: pause the alphabet quick-scroll controller (so a
  // held up/down navigates filter rows, not grid sections) and stop grid cards
  // from grabbing focus when a filter toggle re-renders the grid behind us.
  useEffect(() => {
    setQuickScrollPaused(open);
    setGridAutoFocusSuppressed(open);
    return () => {
      setQuickScrollPaused(false);
      setGridAutoFocusSuppressed(false);
    };
  }, [open]);

  // Land focus on the first active filter (or the first row) once the sheet
  // tree has registered.
  useEffect(() => {
    if (!open) return;
    const target = activeFilters[0] ?? FILTER_OPTIONS[0]?.key;
    const raf = requestAnimationFrame(() =>
      setFocus(`filter-option-${target}`),
    );
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Restore grid focus when the sheet closes: the previously focused card if it
  // still exists under the current filters, otherwise the first visible card.
  const restoreGridFocus = () => {
    const savedKey = savedFocusKey.current;
    if (savedKey && document.getElementById(savedKey)) {
      requestAnimationFrame(() => setFocus(savedKey));
      return;
    }

    const firstGame = activeGroup?.partitionedGames.find(
      ([, games]) => games.length,
    )?.[1][0];

    if (activeGroup && firstGame) {
      const firstKey = `game-list-${activeGroup.id}-${firstGame.id}`;
      requestAnimationFrame(() => setFocus(firstKey));
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      return;
    }

    setOpen(false);
    restoreGridFocus();
  };

  const toggle = (key: FilterKey) => {
    const set = new Set(activeFilters);
    if (set.has(key)) {
      set.delete(key);
    } else {
      set.add(key);
    }
    const next = Array.from(set);

    void navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        filters: next.length ? next : undefined,
        restoreGridFocus: undefined,
      }),
    });
  };

  const clearFilters = () => {
    if (activeCount === 0) return;
    void navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        filters: undefined,
        restoreGridFocus: undefined,
      }),
    });
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetPortal>
        <SheetOverlay className="z-[105] bg-background/50 backdrop-blur-sm" />
        <SheetContent
          side="right"
          className="z-[110] sm:min-w-[28rem]"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <HotkeyLayer
            id="filter-sheet"
            allowBubbling="never"
            handlers={{
              BACK: {
                handler: () => handleOpenChange(false),
                zone: "filterSheet",
              },
              MENU: { handler: () => {}, zone: "filterSheet" },
              OPTION: {
                handler: () => clearFilters(),
                zone: "filterSheet",
              },
            }}
          >
            <SheetHeader>
              <SheetTitle>Library Filters</SheetTitle>
              <SheetDescription>
                Narrow the games shown in every tab.
                {activeCount > 0 ? ` ${activeCount} active.` : " None active."}
              </SheetDescription>
            </SheetHeader>

            <FocusContainer
              opts={{
                focusKey: "filter-sheet-list",
                isFocusBoundary: true,
                forceFocus: true,
              }}
              className="flex grow flex-col gap-5 overflow-y-auto px-3 py-3"
            >
              {SECTIONS.map((section) => {
                const options = FILTER_OPTIONS.filter(
                  (o) => o.section === section,
                );
                if (!options.length) return null;

                return (
                  <div key={section} className="flex flex-col gap-2">
                    <h3 className="px-1 text-xs font-bold uppercase tracking-widest text-muted-foreground">
                      {section}
                    </h3>
                    {options.map((option) => (
                      <FilterOption
                        key={option.key}
                        label={option.label}
                        active={activeFilters.includes(option.key)}
                        focusKey={`filter-option-${option.key}`}
                        onToggle={() => toggle(option.key)}
                      />
                    ))}
                  </div>
                );
              })}
            </FocusContainer>

            <SheetFooter className="items-center gap-4 px-4 py-3 text-xs text-muted-foreground">
              <button
                type="button"
                disabled={activeCount === 0}
                onClick={clearFilters}
                className={cn(
                  "mr-auto flex items-center gap-1.5 transition-colors",
                  activeCount === 0
                    ? "opacity-40"
                    : "hover:text-foreground pointer-events-auto",
                )}
              >
                <HotkeyIcon hotkey="OPTION" />
                Clear Filters
              </button>
              <span className="flex items-center gap-1.5">
                <HotkeyIcon hotkey="ACCEPT" />
                Toggle
              </span>
              <span className="flex items-center gap-1.5">
                <HotkeyIcon hotkey="BACK" />
                Close
              </span>
            </SheetFooter>
          </HotkeyLayer>
        </SheetContent>
      </SheetPortal>
    </Sheet>
  );
}

function FilterOption(props: {
  label: string;
  active: boolean;
  focusKey: string;
  onToggle: () => void;
}) {
  const { label, active, focusKey, onToggle } = props;

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: onToggle } }}>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onToggle}
        className={cn(
          "flex items-center justify-between gap-3 rounded-lg border px-4 py-4 text-left outline-none transition-colors",
          "focus-hover:border-accent focus-hover:bg-accent/10",
          active ? "border-accent/60 bg-accent/5" : "border-border",
        )}
      >
        <span className="text-lg font-semibold uppercase tracking-wide">
          {label}
        </span>
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded border transition-colors",
            active
              ? "border-accent bg-accent/15 text-accent"
              : "border-muted-foreground/40 text-transparent",
          )}
        >
          <Check size={16} />
        </span>
      </button>
    </HotkeyLayer>
  );
}
