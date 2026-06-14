import { useNavigate } from "@tanstack/react-router";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@retrom/ui/components/tabs";
import { IgdbTab } from "./igdb-tab";
import { ManualTab } from "./manual-tab";
import { MusicTab } from "./music-tab";
import { SteamTab } from "./steam-tab";
import { Route } from "@/routes/(windowed)/_layout/games/$gameId";
import { useGameDetail } from "@/providers/game-details";

export function UpdateMetadataModal() {
  const { updateMetadataModal } = Route.useSearch();
  const navigate = useNavigate();
  const { game } = useGameDetail();

  return (
    <Dialog
      modal
      open={!!updateMetadataModal?.open}
      onOpenChange={(open) => {
        if (!open) {
          void navigate({
            to: ".",
            search: (prev) => ({ ...prev, updateMetadataModal: undefined }),
          });
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Metadata</DialogTitle>
          <DialogDescription>
            Update the metadata entries for this game, either by searching IGDB
            or manually.
          </DialogDescription>
        </DialogHeader>

        {game.thirdParty ? (
          // Steam / third-party games: show Steam refresh tab + music tab + manual edit tab.
          // IGDB search is not applicable since there's no ROM path to match on.
          <Tabs defaultValue={updateMetadataModal?.tab ?? "steam"}>
            <TabsList className="w-full *:w-full">
              <TabsTrigger value="steam">Steam Refresh</TabsTrigger>
              <TabsTrigger value="music">Music</TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>
            <TabsContent value="steam">
              <SteamTab />
            </TabsContent>
            <TabsContent value="music">
              <MusicTab />
            </TabsContent>
            <TabsContent value="manual">
              <ManualTab />
            </TabsContent>
          </Tabs>
        ) : (
          // Regular games: IGDB search + music tab + manual edit.
          <Tabs defaultValue={updateMetadataModal?.tab ?? "igdb"}>
            <TabsList className="w-full *:w-full">
              <TabsTrigger value="igdb">Search IGDB</TabsTrigger>
              <TabsTrigger value="music">Music</TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>
            <TabsContent value="igdb">
              <IgdbTab />
            </TabsContent>
            <TabsContent value="music">
              <MusicTab />
            </TabsContent>
            <TabsContent value="manual">
              <ManualTab />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
