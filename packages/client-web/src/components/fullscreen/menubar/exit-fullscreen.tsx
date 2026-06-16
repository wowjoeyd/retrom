import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { ComponentProps, useCallback, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { HotkeyHandlers } from "@/providers/hotkeys";
import { MenuEntryButton } from "./menu-entry-button";
import { HotkeyButton } from "../hotkey-button";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer } from "../focus-container";
import { gameMusicPlayer } from "../grid-game-list";
import { Minimize2 } from "lucide-react";
import { PanelHeader } from "./panel-chrome";
import { PANEL_CONTENT_CLASS } from "./menu-sheet";

declare global {
  export interface HotkeyZones {
    exitFullscreen: boolean;
  }
}

export function ExitFullscreen(props: ComponentProps<typeof SheetTrigger>) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const exit = useCallback(() => {
    // Explicitly stop any playing theme music when the user chooses to exit fullscreen.
    // This covers the case of being in a game detail page (where music was started
    // by the detail effect) so it doesn't leak into the windowed UI.
    gameMusicPlayer.stop(300);
    return navigate({ to: "/home" });
  }, [navigate]);

  const handlers = useMemo(
    () =>
      ({
        BACK: {
          handler: () => setOpen(false),
          zone: "exitFullscreen",
        },
        MENU: {
          handler: exit,
          zone: "exitFullscreen",
        },
      }) satisfies HotkeyHandlers,
    [exit],
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="exit-fullscreen-menu-open"
          icon={<Minimize2 size={18} />}
          label="Return to the desktop layout"
          {...props}
        >
          Exit Fullscreen
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent className={PANEL_CONTENT_CLASS}>
        <HotkeyLayer id="exit-fullscreen-menu" handlers={handlers}>
          <PanelHeader
            icon={<Minimize2 size={20} />}
            title="Exit Fullscreen"
            subtitle="Return to the desktop interface"
          />

          <FocusContainer
            opts={{
              focusKey: "exit-fullscreen-menu",
              isFocusBoundary: true,
              initialFocus: true,
            }}
            className="flex w-full flex-1 flex-col"
          >
            <p className="px-5 py-6 text-sm text-muted-foreground">
              Retrom will switch back to the windowed desktop interface. Any
              playing theme music will stop.
            </p>

            <SheetFooter className="mt-auto justify-between gap-3 px-5 py-3">
              <SheetClose asChild>
                <HotkeyButton
                  className="flex-1 justify-center"
                  focusOpts={{ focusKey: "exit-fullscreen-menu-close" }}
                  hotkey="BACK"
                >
                  Back
                </HotkeyButton>
              </SheetClose>

              <HotkeyButton
                focusOpts={{
                  focusKey: "exit-fullscreen-menu-confirm",
                  initialFocus: true,
                }}
                className="flex-1 justify-center"
                type="submit"
                hotkey="MENU"
                onClick={exit}
              >
                Exit
              </HotkeyButton>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
