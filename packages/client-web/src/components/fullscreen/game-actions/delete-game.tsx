import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menubar/menu-entry-button";
import { HotkeyButton } from "../hotkey-button";
import { useCallback, useState } from "react";
import { ConfigCheckbox } from "../menubar/config-inputs/checkbox";
import { useDeleteGames } from "@/mutations/useDeleteGames";
import { useGameDetail } from "@/providers/game-details";
import { useNavigate } from "@tanstack/react-router";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer } from "../focus-container";
import { Info, Trash2 } from "lucide-react";
import { ScrollArea } from "@retrom/ui/components/scroll-area";
import { CheckedState } from "@retrom/ui/components/checkbox";
import { PanelHeader } from "../menubar/panel-chrome";
import { PANEL_CONTENT_CLASS_RIGHT } from "../menubar/menu-sheet";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";

declare global {
  export interface HotkeyZones {
    deleteGameAction: boolean;
  }
}

export function DeleteGameAction() {
  const { game } = useGameDetail();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [fromDisk, setFromDisk] = useState<CheckedState>(false);
  const [blacklistEntries, setBlacklistEntries] = useState<CheckedState>(false);

  const { mutate: deleteGame } = useDeleteGames();

  const handleDelete = useCallback(() => {
    deleteGame({
      ids: [game.id],
      deleteFromDisk: fromDisk === true,
      blacklistEntries: blacklistEntries === true,
    });

    return navigate({
      to: "/fullscreen",
    });
  }, [game, fromDisk, deleteGame, blacklistEntries, navigate]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="delete-game-action-open"
          icon={<Trash2 size={18} />}
          label="Remove this game from your library"
          destructive
        >
          Delete Game
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent
        side="right"
        className={PANEL_CONTENT_CLASS_RIGHT}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Return focus to the trigger in the Actions menu so the reticle and
          // BACK routing land back there (not on <body>, which would let the
          // next BACK escape to the grid).
          requestAnimationFrame(() => setFocus("delete-game-action-open"));
        }}
      >
        <HotkeyLayer
          zones={{ gameActions: false }}
          handlers={{
            BACK: { handler: () => setOpen(false), zone: "deleteGameAction" },
            MENU: { handler: handleDelete, zone: "deleteGameAction" },
          }}
        >
          <FocusContainer
            className="flex h-full flex-col"
            opts={{ focusKey: "delete-game-action", initialFocus: true }}
          >
            <PanelHeader
              icon={<Trash2 size={20} />}
              title="Delete Game"
              subtitle="Remove this game from your library"
            />

            <ScrollArea className="h-full w-full">
              <div className="flex h-full flex-col gap-5 p-3">
                <div className="flex gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-3 text-sm">
                  <Info
                    className="mt-0.5 h-4 w-4 min-w-[1rem] text-accent-text"
                    size={36}
                  />

                  <div className="flex flex-col gap-2 text-muted-foreground">
                    <p>
                      You can either delete the entry from the database or
                      delete the game from the disk.
                    </p>

                    <p>
                      Deleting only the entry will leave your file system as is,
                      but Retrom will ignore the game&apos;s directory moving
                      forward.
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-1 overflow-hidden rounded-lg border border-border/50 bg-muted/10 p-1">
                  <ConfigCheckbox
                    label="Delete from disk"
                    checked={fromDisk}
                    onCheckedChange={setFromDisk}
                  >
                    <p className="text-sm text-muted-foreground">
                      This will alter the filesystem
                    </p>
                  </ConfigCheckbox>

                  <ConfigCheckbox
                    label="Blacklist Entries"
                    checked={blacklistEntries}
                    onCheckedChange={setBlacklistEntries}
                  >
                    <p className="text-sm text-muted-foreground">
                      Enabling this will prevent the game and its files from
                      being re-imported in any future library scans
                    </p>
                  </ConfigCheckbox>
                </div>
              </div>
            </ScrollArea>

            <SheetFooter className="mt-auto justify-between gap-3 px-5 py-3">
              <SheetClose asChild>
                <HotkeyButton className="flex-1 justify-center" hotkey="BACK">
                  Cancel
                </HotkeyButton>
              </SheetClose>

              <HotkeyButton
                className="flex-1 justify-center"
                hotkey="MENU"
                onClick={handleDelete}
              >
                Delete
              </HotkeyButton>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
