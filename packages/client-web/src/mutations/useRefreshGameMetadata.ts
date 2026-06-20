import { useToast } from "@retrom/ui/hooks/use-toast";
import {
  GetIgdbGameSearchResultsRequestSchema,
  SyncSteamMetadataRequestSchema,
  SyncSteamMetadataRequest_SelectorSchema,
  UpdateGameMetadataRequestSchema,
} from "@retrom/codegen/retrom/services/metadata-service_pb";
import { UpdatedGameMetadataSchema } from "@retrom/codegen/retrom/models/metadata_pb";
import { Game } from "@retrom/codegen/retrom/models/games_pb";
import {
  GameMetadata,
  PlatformMetadata,
} from "@retrom/codegen/retrom/models/metadata_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";
import { getFileStub } from "@/lib/utils";

// Re-scrape / re-apply metadata for a single game using the existing backend
// commands, with no text entry — so the controller-driven fullscreen surfaces
// (the grid card menu + the detail Actions panel) can offer a one-press refresh:
//
//   * Steam / third-party games -> SyncSteamMetadata(forceRefresh) re-fetches
//     name, description, images, etc. from the Steam store.
//   * Everything else -> re-query IGDB (by the existing match id when known,
//     else by name) and apply the result via UpdateGameMetadata, which also
//     re-caches media and re-extracts theme audio.
export function useRefreshGameMetadata() {
  const retromClient = useRetromClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationKey: ["refreshGameMetadata"],
    mutationFn: async ({
      game,
      gameMetadata,
      platformMetadata,
    }: {
      game: Game;
      gameMetadata?: GameMetadata;
      platformMetadata?: PlatformMetadata;
    }) => {
      if (game.thirdParty) {
        await retromClient.metadataClient.syncSteamMetadata(
          create(SyncSteamMetadataRequestSchema, {
            selectors: [
              create(SyncSteamMetadataRequest_SelectorSchema, {
                gameId: game.id,
              }),
            ],
            forceRefresh: true,
          }),
        );
        return;
      }

      const search = await retromClient.metadataClient.getIgdbGameSearchResults(
        create(GetIgdbGameSearchResultsRequestSchema, {
          query: {
            gameId: game.id,
            search: { value: gameMetadata?.name ?? getFileStub(game.path) },
            fields: {
              // Prefer the existing IGDB match so a refresh stays on the same
              // game; the backend falls back to the search term when unset.
              id: gameMetadata?.igdbId,
              platform: platformMetadata?.igdbId,
            },
          },
        }),
      );

      const match = search.metadata.at(0);
      if (!match) {
        throw new Error("No IGDB match found to refresh from.");
      }

      const { $typeName: _, ...rest } = match;
      await retromClient.metadataClient.updateGameMetadata(
        create(UpdateGameMetadataRequestSchema, {
          metadata: [
            create(UpdatedGameMetadataSchema, { ...rest, gameId: game.id }),
          ],
        }),
      );
    },
    onSuccess: () => {
      toast({ title: "Metadata refresh started" });
      return queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey.includes("games") ||
          query.queryKey.includes("game-metadata"),
      });
    },
    onError: (error) => {
      console.error(error);
      toast({
        title: "Failed to refresh metadata",
        description: "Check the console for details",
        variant: "destructive",
      });
    },
  });
}
