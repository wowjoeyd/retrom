import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DownloadGameSoundtrackRequestSchema,
} from "@retrom/codegen/retrom/services/metadata-service_pb";
import { create } from "@bufbuild/protobuf";
import { useToast } from "@retrom/ui/hooks/use-toast";

export function useDownloadGameSoundtrack() {
  const retromClient = useRetromClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationKey: ["downloadGameSoundtrack"],
    mutationFn: async ({
      gameId,
      videoId,
    }: {
      gameId: number;
      videoId: string;
    }) =>
      retromClient.metadataClient.downloadGameSoundtrack(
        create(DownloadGameSoundtrackRequestSchema, { gameId, videoId }),
      ),
    onSuccess: (_, { gameId }) => {
      toast({ title: "Soundtrack download started" });
      return queryClient.invalidateQueries({
        predicate: (q) =>
          q.queryKey.includes("game-metadata") ||
          q.queryKey.includes("games"),
      });
    },
    onError: (error) => {
      console.error(error);
      toast({
        title: "Failed to start soundtrack download",
        description: "Check the console for details",
        variant: "destructive",
      });
    },
  });
}
