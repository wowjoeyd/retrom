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
  DEFAULT_SORT_KEY,
  SORT_OPTIONS,
  SortKey,
} from "@/providers/fullscreen/group-context";
import { setQuickScrollPaused } from "../alphabet-scroll-overlay";

declare global {
  export interface HotkeyZones {
    sortSheet: boolean;
  }
}

export function SortSheet() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { sortBy = DEFAULT_SORT_KEY } = useSearch({
    from: "/_fullscreenLayout",
  });

  // The grid card that was focused when the sheet opened, so BACK can restore it.
  const savedFocusKey = useRef<string | undefined>(undefined);
  // Set when a sort is chosen so close does not fight the first-card refocus.
  const justSelected = useRef(false);

  const currentLabel = SORT_OPTIONS.find((o) => o.key === sortBy)?.label;

  useHotkeys({
    enabled: !open,
    handlers: {
      SORT: {
        handler: () => {
          savedFocusKey.current = getCurrentFocusKey();
          setOpen(true);
        },
      },
    },
  });

  // Pause the alphabet quick-scroll controller while the sheet owns focus so a
  // held up/down navigates options instead of jumping grid sections.
  useEffect(() => {
    setQuickScrollPaused(open);
    return () => setQuickScrollPaused(false);
  }, [open]);

  // Land focus on the current sort once the sheet tree has registered.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setFocus(`sort-option-${sortBy}`));
    return () => cancelAnimationFrame(raf);
  }, [open, sortBy]);

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setOpen(true);
      return;
    }

    setOpen(false);

    if (justSelected.current) {
      justSelected.current = false;
      return;
    }

    const key = savedFocusKey.current;
    if (key) {
      requestAnimationFrame(() => setFocus(key));
    }
  };

  const select = (key: SortKey) => {
    justSelected.current = true;
    void navigate({
      to: ".",
      search: (prev) => ({ ...prev, sortBy: key, restoreGridFocus: undefined }),
    });
    setOpen(false);
  };

  // Reset to the default library order (clears the sortBy search param).
  const clearSort = () => {
    justSelected.current = true;
    void navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        sortBy: undefined,
        restoreGridFocus: undefined,
      }),
    });
    setOpen(false);
  };

  const isDefaultSort = sortBy === DEFAULT_SORT_KEY;

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
            id="sort-sheet"
            allowBubbling="never"
            handlers={{
              BACK: {
                handler: () => handleOpenChange(false),
                zone: "sortSheet",
              },
              MENU: { handler: () => {}, zone: "sortSheet" },
              OPTION: {
                handler: () => !isDefaultSort && clearSort(),
                zone: "sortSheet",
              },
            }}
          >
            <SheetHeader>
              <SheetTitle>Sort Library</SheetTitle>
              <SheetDescription>
                Choose how games are ordered across every tab.
                {currentLabel ? ` Currently: ${currentLabel}.` : ""}
              </SheetDescription>
            </SheetHeader>

            <FocusContainer
              opts={{
                focusKey: "sort-sheet-list",
                isFocusBoundary: true,
                forceFocus: true,
              }}
              className="flex grow flex-col gap-2 overflow-y-auto px-3 py-3"
            >
              {SORT_OPTIONS.map((option) => (
                <SortOption
                  key={option.key}
                  label={option.label}
                  selected={option.key === sortBy}
                  initialFocus={option.key === sortBy}
                  focusKey={`sort-option-${option.key}`}
                  onSelect={() => select(option.key)}
                />
              ))}
            </FocusContainer>

            <SheetFooter className="items-center gap-4 px-4 py-3 text-xs text-muted-foreground">
              <button
                type="button"
                disabled={isDefaultSort}
                onClick={clearSort}
                className={cn(
                  "mr-auto flex items-center gap-1.5 transition-colors",
                  isDefaultSort
                    ? "opacity-40"
                    : "hover:text-foreground pointer-events-auto",
                )}
              >
                <HotkeyIcon hotkey="OPTION" />
                Clear Sort
              </button>
              <span className="flex items-center gap-1.5">
                <HotkeyIcon hotkey="ACCEPT" />
                Select
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

function SortOption(props: {
  label: string;
  selected: boolean;
  initialFocus: boolean;
  focusKey: string;
  onSelect: () => void;
}) {
  const { label, selected, initialFocus, focusKey, onSelect } = props;

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey,
    initialFocus,
    forceFocus: true,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: onSelect } }}>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onSelect}
        className={cn(
          "flex items-center justify-between gap-3 rounded-lg border px-4 py-4 text-left outline-none transition-colors",
          "focus-hover:border-accent focus-hover:bg-accent/10",
          selected ? "border-accent/60 bg-accent/5" : "border-border",
        )}
      >
        <span className="text-lg font-semibold uppercase tracking-wide">
          {label}
        </span>
        {selected && <Check size={20} className="shrink-0 text-accent" />}
      </button>
    </HotkeyLayer>
  );
}
