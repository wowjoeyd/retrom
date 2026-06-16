import { Sheet, SheetContent, SheetTrigger } from "@retrom/ui/components/sheet";
import { UninstallGameAction } from "./uninstall-game";
import { InstallGameAction } from "./install-game";
import { DeleteGameAction } from "./delete-game";
import { DownloadMusicAction } from "./download-music";
import { useState } from "react";
import { useHotkeys } from "@/providers/hotkeys";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer, useFocusable } from "../focus-container";
import { Button } from "@retrom/ui/components/button";
import { cn } from "@retrom/ui/lib/utils";
import { EllipsisVerticalIcon, Gamepad2 } from "lucide-react";
import { DesktopOnly } from "@/lib/env";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useGameDetail } from "@/providers/game-details";
import { PanelHeader, PanelHints } from "../menubar/panel-chrome";
import { PANEL_CONTENT_CLASS } from "../menubar/menu-sheet";

declare global {
  export interface HotkeyZones {
    gameActionsOpen: boolean;
    gameActions: boolean;
  }
}

export function GameActions() {
  const [open, setOpen] = useState(false);
  const { name } = useGameDetail();
  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: "game-actions-open",
  });

  useHotkeys({
    handlers: {
      PAGE_LEFT: {
        handler: () => setOpen(true),
        zone: "gameActionsOpen",
      },
    },
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <HotkeyLayer
        id="game-actions"
        handlers={{ ACCEPT: { handler: () => setOpen(true) } }}
      >
        <SheetTrigger asChild>
          <Button
            ref={ref}
            variant="secondary"
            className={cn(
              "h-full rounded-none px-2 ring-ring focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-offset-0",
              "opacity-80 focus-hover:opacity-100 transition-all",
            )}
          >
            <EllipsisVerticalIcon size={28} />
          </Button>
        </SheetTrigger>
      </HotkeyLayer>

      <SheetContent
        className={PANEL_CONTENT_CLASS}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFocus("fullscreen-action-button");
        }}
      >
        <HotkeyLayer
          id="game-actions"
          allowBubbling="never"
          handlers={{
            BACK: {
              handler: () => setOpen(false),
              zone: "gameActions",
            },
          }}
        >
          <FocusContainer
            className="flex h-full flex-col"
            opts={{
              initialFocus: true,
              focusKey: "game-actions",
              isFocusBoundary: true,
              forceFocus: true,
            }}
          >
            <PanelHeader
              icon={<Gamepad2 size={20} />}
              title="Game Actions"
              subtitle={name}
            />

            <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
              <DesktopOnly>
                <InstallGameAction />
                <UninstallGameAction />
              </DesktopOnly>

              <DownloadMusicAction />
              <DeleteGameAction />
            </div>

            <PanelHints
              hints={[
                { hotkey: "ACCEPT", label: "Select" },
                { hotkey: "BACK", label: "Close" },
              ]}
            />
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
