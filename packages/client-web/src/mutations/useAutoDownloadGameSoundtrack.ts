import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { AutoDownloadGameSoundtrackRequestSchema } from "@retrom/codegen/retrom/services/metadata-service_pb";
import { create } from "@bufbuild/protobuf";

export function useAutoDownloadGameSoundtrack() {
  const retromClient = useRetromClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationKey: ["autoDownloadGameSoundtrack"],
    mutationFn: async (gameIds: number[]) => {
      return retromClient.metadataClient.autoDownloadGameSoundtrack(
        create(AutoDownloadGameSoundtrackRequestSchema, { gameIds }),
      );
    },
    onSuccess: (_, gameIds) => {
      if (gameIds.length === 1) {
        toast({ title: "Soundtrack download started" });
      } else {
        toast({
          title: "Batch soundtrack download started",
          description: `Queued downloads for up to ${gameIds.length} games.`,
        });
      }
      void queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
          queryKey.includes("game-metadata") || queryKey.includes("games"),
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Soundtrack download failed",
        variant: "destructive",
        description: err.message,
      });
    },
  });
}
