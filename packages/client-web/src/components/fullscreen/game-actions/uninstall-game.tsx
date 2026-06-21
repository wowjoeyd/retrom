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
import { useEffect, useState } from "react";
import { FocusContainer } from "../focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { PanelHeader } from "../menubar/panel-chrome";
import { PANEL_CONTENT_CLASS_RIGHT } from "../menubar/menu-sheet";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useInputDeviceContext } from "@/providers/input-device";

export function UninstallGameAction() {
  const [open, setOpen] = useState(false);
  const { game } = useGameDetail();
  const [inputDevice] = useInputDeviceContext();

  const installationStatus = useInstallationStatus(game.id);
  const { mutate: uninstall, status } = useUninstallGame(game);
  const openDisabled = installationStatus !== InstallationStatus.INSTALLED;

  const disabled =
    status === "pending" || installationStatus !== InstallationStatus.INSTALLED;

  // Move spatial focus INTO this sheet when it opens. Its only controls are
  // hotkey-hint buttons (HotkeyButton is `focusable: false` by default), so
  // without this norigin focus stays on the Actions menu behind — the reticle
  // frames that menu, and BACK dispatches on it (or <body>), bubbling past this
  // sheet's BACK layer to the detail page's back-to-grid handler.
  useEffect(() => {
    if (!open) return;
    if (inputDevice !== "gamepad" && inputDevice !== "hotkeys") return;
    const raf = requestAnimationFrame(() =>
      setFocus("uninstall-game-action-back"),
    );
    return () => cancelAnimationFrame(raf);
  }, [open, inputDevice]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="uninstall-game-action-open"
          icon={<PackageX size={18} />}
          label={
            openDisabled
              ? "Not installed"
              : "Remove the locally installed files"
          }
          destructive
          focusOpts={{ focusable: !openDisabled }}
          disabled={openDisabled}
        >
          Uninstall Game
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
          requestAnimationFrame(() => setFocus("uninstall-game-action-open"));
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
                <HotkeyButton
                  className="flex-1 justify-center"
                  hotkey="BACK"
                  focusOpts={{
                    focusable: true,
                    focusKey: "uninstall-game-action-back",
                  }}
                >
                  Back
                </HotkeyButton>
              </SheetClose>

              <HotkeyButton
                className="flex-1 justify-center"
                disabled={disabled}
                hotkey="MENU"
                onClick={() => uninstall()}
                focusOpts={{
                  focusable: !disabled,
                  focusKey: "uninstall-game-action-confirm",
                }}
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
