import {
  GridGameList,
  gameMusicPlayer,
  cancelPendingFocusMusic,
} from "@/components/fullscreen/grid-game-list";
import { createLazyFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ScrollArea, ScrollBar } from "@retrom/ui/components/scroll-area";
import { GroupMenu } from "@/components/fullscreen/group-menu";
import { ActionBar } from "@/components/fullscreen/action-bar";
import {
  AlphabetScrollOverlay,
  useAlphabetQuickScroll,
  setQuickScrollActivateHandler,
} from "@/components/fullscreen/alphabet-scroll-overlay";
import { SortSheet } from "@/components/fullscreen/sort-sheet";
import { FilterSheet } from "@/components/fullscreen/filter-sheet";
import { GridGameContextMenu } from "@/components/fullscreen/game-context-menu";
import { useActionBar } from "@/providers/fullscreen/action-bar-context";

export const Route = createLazyFileRoute("/_fullscreenLayout/fullscreen/")({
  component: FullscreenComponent,
});

function FullscreenComponent() {
  useAlphabetQuickScroll();

  // When a held scrub enters section-jump mode, silence any playing soundtrack
  // and dismiss the now-playing banner; music resumes once focus settles on a
  // card after release.
  useEffect(() => {
    setQuickScrollActivateHandler(() => {
      cancelPendingFocusMusic();
      gameMusicPlayer.stop(200);
    });
    return () => setQuickScrollActivateHandler(null);
  }, []);

  useActionBar([
    { hotkey: "BACK", label: "Back" },
    { hotkey: "ACCEPT", label: "Open" },
    { hotkey: "OPTION", label: "Options" },
    { hotkey: "FILTER", label: "Filter" },
    { hotkey: "SORT", label: "Sort By" },
    { hotkey: "PAGE_LEFT", label: "Prev" },
    { hotkey: "PAGE_RIGHT", label: "Next" },
    { hotkey: "MENU", label: "Menu" },
  ]);

  return (
    <div className="h-full grid grid-flow-row grid-rows-[auto_1fr_auto]">
      {/* Steam Big Picture-style category tabs near the top. */}
      <GroupMenu className="w-full border-b bg-background/60" />

      <div className="relative flex w-full overflow-hidden">
        <ScrollArea className="max-h-full grow">
          <GridGameList />

          <ScrollBar orientation="vertical" className="z-[100]" />
        </ScrollArea>

        <AlphabetScrollOverlay />
      </div>

      <SortSheet />
      <FilterSheet />
      <GridGameContextMenu />

      {/* Bottom bar is controller/keyboard hints only. */}
      <ActionBar className="w-full overflow-hidden max-w-screen" />
    </div>
  );
}
