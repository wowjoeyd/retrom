import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { useCallback, useState } from "react";
import { MenuEntryButton } from "../menu-entry-button";
import { useUpdateLibrary } from "@/mutations/useUpdateLibrary";
import { HotkeyButton } from "../../hotkey-button";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer } from "../../focus-container";
import { RefreshCw } from "lucide-react";
import { PanelHeader } from "../panel-chrome";
import { PANEL_CONTENT_CLASS } from "../menu-sheet";

export function UpdateLibrary() {
  const { mutateAsync: updateLibrary } = useUpdateLibrary();
  const [open, setOpen] = useState(false);

  const handleUpdate = useCallback(async () => {
    await updateLibrary();
    setOpen(false);
  }, [updateLibrary, setOpen]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="update-library-open"
          icon={<RefreshCw size={18} />}
          label="Scan configured libraries for new or changed games"
        >
          Update Library
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent className={PANEL_CONTENT_CLASS}>
        <HotkeyLayer
          id="update-library"
          handlers={{
            BACK: {
              handler: () => setOpen(false),
            },
            MENU: {
              handler: handleUpdate,
            },
          }}
        >
          <PanelHeader
            icon={<RefreshCw size={20} />}
            title="Update Library"
            subtitle="Scan configured libraries for new or changed games"
          />

          <FocusContainer
            opts={{
              focusKey: "update-library-menu",
              initialFocus: true,
              isFocusBoundary: true,
            }}
            className="flex flex-1 flex-col"
          >
            <p className="px-5 py-6 text-sm text-muted-foreground">
              Retrom will re-scan every configured library directory and import
              any new or changed games. This won&apos;t remove existing entries.
            </p>

            <SheetFooter className="mt-auto justify-between gap-3 px-5 py-3">
              <SheetClose asChild>
                <HotkeyButton
                  className="flex-1 justify-center"
                  focusOpts={{ focusKey: "update-library-menu-close" }}
                  hotkey="BACK"
                >
                  Back
                </HotkeyButton>
              </SheetClose>

              <HotkeyButton
                className="flex-1 justify-center"
                focusOpts={{
                  focusKey: "update-library-menu-confirm",
                  initialFocus: true,
                }}
                hotkey="MENU"
                onClick={handleUpdate}
              >
                Update
              </HotkeyButton>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
