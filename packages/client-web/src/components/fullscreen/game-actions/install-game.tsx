import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menubar/menu-entry-button";
import { HotkeyButton } from "../hotkey-button";
import { useInstallGame } from "@/mutations/useInstallGame";
import { useGameDetail } from "@/providers/game-details";
import { Download, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { FocusContainer } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { PanelHeader } from "../menubar/panel-chrome";
import { PANEL_CONTENT_CLASS_RIGHT } from "../menubar/menu-sheet";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useInputDeviceContext } from "@/providers/input-device";

export function InstallGameAction() {
  const [open, setOpen] = useState(false);
  const { game } = useGameDetail();
  const [inputDevice] = useInputDeviceContext();

  const installationStatus = useInstallationStatus(game.id);
  const { mutate: install, status } = useInstallGame(game.id);
  const openDisabled = installationStatus === InstallationStatus.INSTALLED;

  const disabled =
    status === "pending" ||
    installationStatus === InstallationStatus.INSTALLED ||
    installationStatus === InstallationStatus.INSTALLING;

  // Move spatial focus INTO this sheet when it opens (see UninstallGameAction):
  // otherwise norigin focus stays on the Actions menu behind, so the reticle
  // frames that menu and BACK escapes past this sheet to the back-to-grid handler.
  useEffect(() => {
    if (!open) return;
    if (inputDevice !== "gamepad" && inputDevice !== "hotkeys") return;
    const raf = requestAnimationFrame(() =>
      setFocus("install-game-action-back"),
    );
    return () => cancelAnimationFrame(raf);
  }, [open, inputDevice]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="install-game-action-open"
          icon={<Download size={18} />}
          label={
            openDisabled
              ? "Already installed"
              : "Download and install to this device"
          }
          focusOpts={{ focusable: !openDisabled }}
          disabled={openDisabled}
        >
          Install Game
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent
        side="right"
        className={PANEL_CONTENT_CLASS_RIGHT}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // Return focus to the trigger in the Actions menu (see UninstallGameAction).
          requestAnimationFrame(() => setFocus("install-game-action-open"));
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
            className="flex h-full flex-col"
            opts={{ focusKey: "install-game-action", isFocusBoundary: true }}
          >
            <PanelHeader
              icon={<Download size={20} />}
              title="Install Game"
              subtitle="Download and install to this device"
            />

            <p className="px-5 py-6 text-sm text-muted-foreground">
              Install this game to your local device so you can play it.
            </p>

            <SheetFooter className="mt-auto justify-between gap-3 px-5 py-3">
              <SheetClose asChild>
                <HotkeyButton
                  className="flex-1 justify-center"
                  hotkey="BACK"
                  focusOpts={{
                    focusable: true,
                    focusKey: "install-game-action-back",
                  }}
                >
                  Back
                </HotkeyButton>
              </SheetClose>

              <HotkeyButton
                className="flex-1 justify-center"
                disabled={disabled}
                hotkey="MENU"
                onClick={() => install(undefined)}
                focusOpts={{
                  focusable: !disabled,
                  focusKey: "install-game-action-confirm",
                }}
              >
                {status === "pending" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  "Install"
                )}
              </HotkeyButton>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
