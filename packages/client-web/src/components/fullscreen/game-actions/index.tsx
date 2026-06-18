import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { UninstallGameAction } from "./uninstall-game";
import { InstallGameAction } from "./install-game";
import { DeleteGameAction } from "./delete-game";
import { DownloadMusicAction } from "./download-music";
import { useMemo, useState } from "react";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { FocusContainer, useFocusable } from "../focus-container";
import { Button } from "@retrom/ui/components/button";
import { cn } from "@retrom/ui/lib/utils";
import { Gamepad2 } from "lucide-react";
import { DesktopOnly } from "@/lib/env";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useGameDetail } from "@/providers/game-details";
import { PanelHints } from "../menubar/panel-chrome";
import { HotkeyIcon } from "../hotkey-button";
import { Image } from "@/lib/utils";
import { createUrl, usePublicUrl } from "@/utils/urls";

declare global {
  export interface HotkeyZones {
    gameActionsOpen: boolean;
    gameActions: boolean;
  }
}

// Right-side slide-out panel. `open`/`onOpenChange` are optional so the page can
// drive it from a global hotkey (Ⓨ) while the trigger still opens on ACCEPT.
export function GameActions(props?: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = props?.open ?? internalOpen;
  const setOpen = props?.onOpenChange ?? setInternalOpen;

  const { name, gameMetadata, extraMetadata } = useGameDetail();
  const publicUrl = usePublicUrl();

  const coverUrl = useMemo(() => {
    const local = extraMetadata?.mediaPaths?.coverUrl;
    if (local && publicUrl) {
      return createUrl({ path: local, base: publicUrl })?.href;
    }
    return gameMetadata?.coverUrl;
  }, [extraMetadata?.mediaPaths?.coverUrl, gameMetadata?.coverUrl, publicUrl]);

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: "game-actions-open",
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
              "flex h-16 items-center gap-2.5 rounded-md px-6 text-xl font-bold uppercase tracking-wide",
              "border border-border/60 bg-background/50 backdrop-blur-md",
              "ring-ring focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-offset-0",
              "opacity-90 transition-all focus-hover:bg-accent focus-hover:opacity-100",
            )}
          >
            <HotkeyIcon hotkey="SORT" className="size-6" />
            Actions
          </Button>
        </SheetTrigger>
      </HotkeyLayer>

      <SheetPortal>
        {/* Page behind blurs + darkens (never a hard opaque cut). */}
        <SheetOverlay className="z-[100] bg-background/55 backdrop-blur-sm" />
        <SheetContent
          side="right"
          className="z-[100] flex flex-col gap-0 border-l border-border/60 bg-background/95 p-0 backdrop-blur-md sm:min-w-[26rem] sm:max-w-[30rem]"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // BACK returns focus to the Actions button, not the Play button.
            setFocus("game-actions-open");
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
            <SheetHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/60 bg-muted/20 px-5 py-4">
              <div className="size-12 shrink-0 overflow-hidden rounded-lg border border-border/60 bg-muted">
                {coverUrl ? (
                  <Image
                    src={coverUrl}
                    alt={name}
                    className="size-full object-cover"
                  />
                ) : (
                  <div className="grid size-full place-items-center text-muted-foreground">
                    <Gamepad2 size={20} />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <SheetDescription className="text-[0.6rem] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  Game Actions
                </SheetDescription>
                <SheetTitle className="truncate text-lg leading-tight">
                  {name}
                </SheetTitle>
              </div>
            </SheetHeader>

            <FocusContainer
              className="flex h-full flex-col"
              opts={{
                initialFocus: true,
                focusKey: "game-actions",
                isFocusBoundary: true,
                forceFocus: true,
              }}
            >
              <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
                <DesktopOnly>
                  <InstallGameAction />
                  <UninstallGameAction />
                </DesktopOnly>

                <DownloadMusicAction />

                {/* Destructive action separated below a divider. */}
                <div className="my-2 h-px bg-border/60" />
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
      </SheetPortal>
    </Sheet>
  );
}
