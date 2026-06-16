import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { ComponentProps, useState } from "react";
import { MenuEntryButton } from "../menu-entry-button";
import { HotkeyButton } from "../../hotkey-button";
import { useUpdateLibraryMetadata } from "@/mutations/useUpdateLibraryMetadata";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer } from "../../focus-container";
import { DownloadCloud } from "lucide-react";
import { PanelHeader } from "../panel-chrome";
import { PANEL_CONTENT_CLASS } from "../menu-sheet";

export function DownloadMetadata(props: ComponentProps<typeof SheetTrigger>) {
  const { mutate: downloadMetadata } = useUpdateLibraryMetadata();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger {...props} asChild>
        <MenuEntryButton
          id="download-metadata-open"
          icon={<DownloadCloud size={18} />}
          label="Refresh artwork, descriptions, and release dates"
        >
          Download Metadata
        </MenuEntryButton>
      </SheetTrigger>

      <SheetContent className={PANEL_CONTENT_CLASS}>
        <HotkeyLayer
          id="download-metadata"
          handlers={{
            BACK: {
              handler: () => setOpen(false),
            },
            MENU: {
              handler: () => {
                downloadMetadata({});
                setOpen(false);
              },
            },
          }}
        >
          <PanelHeader
            icon={<DownloadCloud size={20} />}
            title="Download Metadata"
            subtitle="Refresh artwork, descriptions, release dates, and related metadata"
          />

          <FocusContainer
            opts={{
              focusKey: "download-metadata-menu",
              initialFocus: true,
              isFocusBoundary: true,
            }}
            className="flex flex-1 flex-col"
          >
            <p className="px-5 py-6 text-sm text-muted-foreground">
              Retrom will look up and refresh metadata for your library —
              artwork, descriptions, release dates, and related details.
            </p>

            <SheetFooter className="mt-auto justify-between gap-3 px-5 py-3">
              <SheetClose asChild>
                <HotkeyButton
                  className="flex-1 justify-center"
                  focusOpts={{ focusKey: "download-metadata-menu-close" }}
                  hotkey="BACK"
                >
                  Back
                </HotkeyButton>
              </SheetClose>

              <HotkeyButton
                className="flex-1 justify-center"
                hotkey="MENU"
                focusOpts={{
                  focusKey: "download-metadata-menu-confirm",
                  initialFocus: true,
                }}
                onClick={() => {
                  downloadMetadata({});
                  setOpen(false);
                }}
              >
                Download
              </HotkeyButton>
            </SheetFooter>
          </FocusContainer>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}
