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
import { useEffect, useState } from "react";
import { useHotkeys } from "@/providers/hotkeys";
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

export const PANEL_CONTENT_CLASS =
  "z-[110] gap-0 border-r border-border/60 bg-background/95 backdrop-blur-md p-0 sm:min-w-[30rem] sm:max-w-[34rem]";

export function MenuSheet(props: JSX.IntrinsicElements["button"]) {
  const [open, setOpen] = useState(false);

  useHotkeys({
    handlers: {
      MENU: { handler: () => setOpen(true), zone: "menuBar" },
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
    <Sheet open={open} onOpenChange={setOpen}>
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
