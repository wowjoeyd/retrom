import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DeleteGameSoundtrackTrackRequestSchema } from "@retrom/codegen/retrom/services/metadata-service_pb";
import { create } from "@bufbuild/protobuf";
import { useToast } from "@retrom/ui/hooks/use-toast";

export function useDeleteGameSoundtrackTrack() {
  const retromClient = useRetromClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationKey: ["deleteGameSoundtrackTrack"],
    mutationFn: async ({
      gameId,
      filename,
    }: {
      gameId: number;
      filename: string;
    }) =>
      retromClient.metadataClient.deleteGameSoundtrackTrack(
        create(DeleteGameSoundtrackTrackRequestSchema, { gameId, filename }),
      ),
    onSuccess: () => {
      toast({ title: "Track deleted" });
      return queryClient.invalidateQueries({
        predicate: (q) =>
          q.queryKey.includes("game-metadata") || q.queryKey.includes("games"),
      });
    },
    onError: (error) => {
      console.error(error);
      toast({
        title: "Failed to delete track",
        description: "Check the console for details",
        variant: "destructive",
      });
    },
  });
}
