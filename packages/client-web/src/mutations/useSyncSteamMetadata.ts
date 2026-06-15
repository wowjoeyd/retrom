import { useToast } from "@retrom/ui/hooks/use-toast";
import {
  SyncSteamMetadataRequestSchema,
  SyncSteamMetadataRequest_SelectorSchema,
} from "@retrom/codegen/retrom/services/metadata-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { create } from "@bufbuild/protobuf";

export function useSyncSteamMetadata() {
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();
  const { toast } = useToast();

  return useMutation({
    mutationKey: ["syncSteamMetadata"],
    onError: (error) => {
      console.error(error);
      toast({
        title: "Error syncing Steam metadata",
        description: "Check the console for details",
        variant: "destructive",
      });
    },
    mutationFn: async ({
      gameIds,
      forceRefresh = false,
    }: {
      gameIds: number[];
      forceRefresh?: boolean;
    }) =>
      retromClient.metadataClient.syncSteamMetadata(
        create(SyncSteamMetadataRequestSchema, {
          selectors: gameIds.map((gameId) =>
            create(SyncSteamMetadataRequest_SelectorSchema, { gameId }),
          ),
          forceRefresh,
        }),
      ),
    onSuccess: () => {
      toast({ title: "Steam metadata synced" });
      return queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey.includes("games") ||
          query.queryKey.includes("game-metadata"),
      });
    },
  });
}
