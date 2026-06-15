import { useGroupContext } from "@/providers/fullscreen/group-context";
import {
  GridGameList,
  useLastFocusedGroupKey,
} from "@/components/fullscreen/grid-game-list";
import { createLazyFileRoute, useSearch } from "@tanstack/react-router";
import { ScrollArea, ScrollBar } from "@retrom/ui/components/scroll-area";
import { GroupMenu } from "@/components/fullscreen/group-menu";
import { ActionBar } from "@/components/fullscreen/action-bar";
import {
  FocusContainer,
  useFocusable,
} from "@/components/fullscreen/focus-container";
import { cn } from "@retrom/ui/lib/utils";
import { Button } from "@retrom/ui/components/button";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useMemo } from "react";
import { useActionBar } from "@/providers/fullscreen/action-bar-context";

export const Route = createLazyFileRoute("/_fullscreenLayout/fullscreen/")({
  component: FullscreenComponent,
});

function FullscreenComponent() {
  useActionBar([
    { hotkey: "BACK", label: "Back" },
    { hotkey: "ACCEPT", label: "Open" },
    { hotkey: "PAGE_LEFT", label: "Prev" },
    { hotkey: "PAGE_RIGHT", label: "Next" },
    { hotkey: "MENU", label: "Menu" },
  ]);

  return (
    <div className="h-full grid grid-flow-row grid-rows-[1fr_auto]">
      <div className="relative flex gap-4 w-full overflow-hidden">
        <PartitionList />

        <ScrollArea className="max-h-full grow">
          <GridGameList />

          <ScrollBar orientation="vertical" className="z-[100]" />
        </ScrollArea>
      </div>

      <ActionBar className="w-full overflow-hidden max-w-screen">
        <GroupMenu className="w-full" />
      </ActionBar>
    </div>
  );
}

function PartitionList() {
  const { activeGroup, allGroups } = useGroupContext();
  const { restoreGridFocus } = useSearch({ from: "/_fullscreenLayout" });
  const savedGroupFocusKey = useLastFocusedGroupKey(activeGroup?.id);
  const savedFocusKey =
    restoreGridFocus === true ? savedGroupFocusKey : undefined;
  const isRestoring =
    savedFocusKey && activeGroup
      ? activeGroup.allGames.some(
          (g) => `game-list-${activeGroup.id}-${g.id}` === savedFocusKey,
        )
      : false;

  return allGroups.map((group) =>
    group.id === activeGroup?.id ? (
      <ScrollArea
        key={group.id}
        className={cn("max-h-full flex w-fit flex-col pr-2")}
      >
        <FocusContainer
          opts={{
            focusKey: `group-${group.id}-partition-list`,
          }}
          className="flex flex-col gap-3 py-10 px-2 w-full"
        >
          {activeGroup?.partitionedGames?.map(([key], idx) => (
            <span
              key={key}
              style={
                isRestoring ? undefined : { animationDelay: `${idx * 50}ms` }
              }
              className={
                isRestoring
                  ? undefined
                  : "animate-in ease-out fade-in fill-mode-both"
              }
            >
              <PartitionItem partitionKey={key} />
            </span>
          ))}
        </FocusContainer>

        <ScrollBar orientation="vertical" className="opacity-0" />
      </ScrollArea>
    ) : null,
  );
}

function PartitionItem(props: { partitionKey: string }) {
  const { activeGroup } = useGroupContext();
  const { partitionKey } = props;
  const games = useMemo(() => {
    const group = activeGroup?.partitionedGames?.find(
      ([k]) => k === partitionKey,
    );

    return group ? group[1] : [];
  }, [activeGroup?.partitionedGames, partitionKey]);

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: `char-list-${activeGroup?.id}-${partitionKey}`,
    focusable: games.length > 0,

    onFocus: ({ node }) => {
      node.focus();
      node.scrollIntoView({ block: "center" });
    },
  });

  return (
    <HotkeyLayer
      handlers={{
        ACCEPT: {
          handler: () => ref.current?.click(),
        },
      }}
    >
      <Button
        ref={ref}
        variant="inline"
        disabled={!games.length}
        onClick={() => {
          document
            .getElementById(`game-list-header-${partitionKey}`)
            ?.scrollIntoView({ block: "start" });
        }}
        className={cn(
          "w-full h-min flex items-center justify-center",
          "text-foreground font-bold opacity-50",
          "transition-all ease-in-out duration-200 p-2.5",
          "focus-hover:opacity-100 focus-hover:bg-foreground/10",
          "disabled:opacity-15 leading-none",
        )}
      >
        {partitionKey}
      </Button>
    </HotkeyLayer>
  );
}
