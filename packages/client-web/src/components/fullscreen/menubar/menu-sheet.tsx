import {
  Sheet,
  SheetContent,
  SheetOverlay,
  SheetPortal,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { ExitFullscreen } from "./exit-fullscreen";
import { Config } from "./config";
import { HotkeyButton } from "../hotkey-button";
import { Library } from "./library";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useEffect, useRef, useState } from "react";
import { useHotkeys } from "@/providers/hotkeys";
import {
  getCurrentFocusKey,
  setFocus,
} from "@noriginmedia/norigin-spatial-navigation";
import { FocusContainer } from "../focus-container";
import { ScrollArea } from "@retrom/ui/components/scroll-area";
import { Menu } from "lucide-react";
import { PanelHeader, PanelHints } from "./panel-chrome";
import { setQuickScrollPaused } from "../alphabet-scroll-overlay";
import { setGridAutoFocusSuppressed } from "../grid-game-list";

declare global {
  export interface HotkeyZones {
    menuBar: boolean;
    menuRoot: boolean;
  }
}

// Shared visual treatment for the fullscreen slide-out panels. The global Menu
// (and its sub-sheets) is left-anchored and slides in from the left, so it keeps
// its right-edge border. The per-game Actions panel is right-anchored; the
// sub-sheets it opens must use PANEL_CONTENT_CLASS_RIGHT (side="right") so they
// slide in from the right edge — matching the panel they were opened from —
// instead of sweeping across from the left.
export const PANEL_CONTENT_CLASS =
  "z-[110] gap-0 border-r border-border/60 bg-background/95 backdrop-blur-md p-0 sm:min-w-[30rem] sm:max-w-[34rem]";

export const PANEL_CONTENT_CLASS_RIGHT =
  "z-[110] gap-0 border-l border-border/60 bg-background/95 backdrop-blur-md p-0 sm:min-w-[30rem] sm:max-w-[34rem]";

export function MenuSheet(props: JSX.IntrinsicElements["button"]) {
  const [open, setOpen] = useState(false);
  // The spatial-focus key that was focused before the menu opened (e.g. a grid
  // card or a detail control), so we can restore focus there on close instead
  // of orphaning it — which otherwise leaves the reticle floating at the menu's
  // last item. Captured at open time, before focus moves into the panel.
  const prevFocusKeyRef = useRef<string | null>(null);

  const changeOpen = (next: boolean) => {
    if (next && !open) prevFocusKeyRef.current = getCurrentFocusKey() ?? null;
    setOpen(next);
  };

  useHotkeys({
    handlers: {
      MENU: { handler: () => changeOpen(true), zone: "menuBar" },
    },
  });

  // While the menu (and any nested sub-sheet) owns focus, pause the alphabet
  // quick-scroll controller and stop grid cards from grabbing focus. Otherwise a
  // held stick/d-pad triggers a section jump whose raw setFocus() escapes the
  // menu's focus boundary and lands back on the grid (same guard the Sort/Filter
  // sheets use).
  useEffect(() => {
    setQuickScrollPaused(open);
    setGridAutoFocusSuppressed(open);
    return () => {
      setQuickScrollPaused(false);
      setGridAutoFocusSuppressed(false);
    };
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={changeOpen}>
      <SheetTrigger asChild>
        <HotkeyButton {...props} hotkey="MENU">
          menu
        </HotkeyButton>
      </SheetTrigger>

      <SheetPortal>
        <SheetOverlay className="bg-background/60 backdrop-blur-sm" />
        <SheetContent
          className={PANEL_CONTENT_CLASS}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Return spatial focus to wherever it was before the menu opened
            // (grid card, detail control, …) so the reticle follows it back
            // instead of floating at the closed menu's last item.
            const prev = prevFocusKeyRef.current;
            if (prev) setFocus(prev);
          }}
        >
          <HotkeyLayer
            id="menu-root"
            allowBubbling="never"
            handlers={{
              BACK: { handler: () => setOpen(false), zone: "menuRoot" },
              // Pressing the guide/MENU button again while the menu is open
              // closes it (toggle), matching Steam Big Picture.
              MENU: { handler: () => setOpen(false), zone: "menuRoot" },
            }}
          >
            <PanelHeader
              icon={<Menu size={20} />}
              title="Menu"
              subtitle="Manage your library and Retrom settings"
            />

            <ScrollArea className="h-full w-full outline-none">
              <FocusContainer
                opts={{
                  focusKey: "menu-root",
                  isFocusBoundary: true,
                  initialFocus: true,
                }}
                className="flex flex-col gap-1 p-3"
              >
                <Library />
                <Config />
                <ExitFullscreen />
              </FocusContainer>
            </ScrollArea>

            <PanelHints
              hints={[
                { hotkey: "ACCEPT", label: "Select" },
                { hotkey: "BACK", label: "Close" },
              ]}
            />
          </HotkeyLayer>
        </SheetContent>
      </SheetPortal>
    </Sheet>
  );
}
