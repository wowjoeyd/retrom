import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menubar/menu-entry-button";
import { HotkeyButton } from "../hotkey-button";
import { useInstallGame } from "@/mutations/useInstallGame";
import { useGameDetail } from "@/providers/game-details";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { FocusContainer } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";

export function InstallGameAction() {
  const [open, setOpen] = useState(false);
  const { game } = useGameDetail();

  const installationStatus = useInstallationStatus(game.id);
  const { mutate: install, status } = useInstallGame(game.id);
  const openDisabled = installationStatus === InstallationStatus.INSTALLED;

  const disabled =
    status === "pending" ||
    installationStatus === InstallationStatus.INSTALLED ||
    installationStatus === InstallationStatus.INSTALLING;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="install-game-action-open"
          focusOpts={{ focusable: !openDisabled }}
          disabled={openDisabled}
        >
          Install Game
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <HotkeyLayer
          allowBubbling="never"
          handlers={{
            BACK: { handler: () => setOpen(false) },
            MENU: {
              handler: () => install(undefined),
            },
          }}
        >
          <FocusContainer
            opts={{ focusKey: "install-game-action", isFocusBoundary: true }}
          >
            <SheetHeader>
              <SheetTitle>Install Game</SheetTitle>
              <SheetDescription>
                Install this game to your local device so you can play it.
              </SheetDescription>
            </SheetHeader>

            <SheetFooter>
              <SheetClose asChild>
                <HotkeyButton hotkey="BACK">Back</HotkeyButton>
              </SheetClose>

              <HotkeyButton
                disabled={disabled}
                hotkey="MENU"
                onClick={() => install(undefined)}
              >
                {status === "pending" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  "Confirm"
                )}
              </HotkeyButton>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}