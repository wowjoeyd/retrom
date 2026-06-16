import {
  Sheet,
  SheetContent,
  SheetOverlay,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menu-entry-button";
import { useState } from "react";
import { UpdateLibrary } from "./update-library";
import { DownloadMetadata } from "./download-metadata";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer } from "../../focus-container";
import { ScrollArea } from "@retrom/ui/components/scroll-area";
import { Library as LibraryIcon } from "lucide-react";
import { PanelHeader, PanelHints } from "../panel-chrome";
import { PANEL_CONTENT_CLASS } from "../menu-sheet";

export function Library(props: JSX.IntrinsicElements["button"]) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <MenuEntryButton
          id="library-menu-open"
          icon={<LibraryIcon size={18} />}
          label="Update library and metadata"
          {...props}
        >
          Library
        </MenuEntryButton>
      </SheetTrigger>

      <SheetOverlay className="bg-background/60 backdrop-blur-sm" />
      <SheetContent className={PANEL_CONTENT_CLASS}>
        <HotkeyLayer
          id="library-menu"
          zones={{ menuRoot: false }}
          handlers={{
            BACK: {
              handler: () => setOpen(false),
            },
          }}
        >
          <PanelHeader
            icon={<LibraryIcon size={20} />}
            title="Library"
            subtitle="Scan and refresh your game library"
          />

          <ScrollArea className="h-full w-full">
            <FocusContainer
              opts={{
                focusKey: "library-menu",
                isFocusBoundary: true,
                initialFocus: true,
              }}
              className="flex flex-col gap-1 p-3"
            >
              <UpdateLibrary />
              <DownloadMetadata />
            </FocusContainer>
          </ScrollArea>

          <PanelHints
            hints={[
              { hotkey: "ACCEPT", label: "Select" },
              { hotkey: "BACK", label: "Back" },
            ]}
          />
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
