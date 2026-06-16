import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menubar/menu-entry-button";
import { HotkeyButton } from "../hotkey-button";
import { useUninstallGame } from "@/mutations/useUninstallGame";
import { useGameDetail } from "@/providers/game-details";
import { LoaderCircle, PackageX } from "lucide-react";
import { useState } from "react";
import { FocusContainer } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { PanelHeader } from "../menubar/panel-chrome";
import { PANEL_CONTENT_CLASS } from "../menubar/menu-sheet";

export function UninstallGameAction() {
  const [open, setOpen] = useState(false);
  const { game } = useGameDetail();

  const installationStatus = useInstallationStatus(game.id);
  const { mutate: uninstall, status } = useUninstallGame(game);
  const openDisabled = installationStatus !== InstallationStatus.INSTALLED;

  const disabled =
    status === "pending" || installationStatus !== InstallationStatus.INSTALLED;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="uninstall-game-action-open"
          icon={<PackageX size={18} />}
          label="Remove the locally installed files"
          destructive
          focusOpts={{ focusable: !openDisabled }}
          disabled={openDisabled}
        >
          Uninstall Game
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent
        className={PANEL_CONTENT_CLASS}
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
              handler: () => uninstall(),
            },
          }}
        >
          <FocusContainer
            className="flex h-full flex-col"
            opts={{ focusKey: "uninstall-game-action", isFocusBoundary: true }}
          >
            <PanelHeader
              icon={<PackageX size={20} />}
              title="Uninstall Game"
              subtitle="Remove the locally installed files"
            />

            <p className="px-5 py-6 text-sm text-muted-foreground">
              This removes the locally installed files. You can reinstall this
              game from your library at any time.
            </p>

            <SheetFooter className="mt-auto justify-between gap-3 px-5 py-3">
              <SheetClose asChild>
                <HotkeyButton className="flex-1 justify-center" hotkey="BACK">
                  Back
                </HotkeyButton>
              </SheetClose>

              <HotkeyButton
                className="flex-1 justify-center"
                disabled={disabled}
                hotkey="MENU"
                onClick={() => uninstall()}
              >
                {status === "pending" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  "Uninstall"
                )}
              </HotkeyButton>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
