import { useToast } from "@retrom/ui/hooks/use-toast";
import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * Manually map a game to a RetroAchievements game id (the "not identified"
 * fallback). On success the game's achievements query is invalidated so the tab
 * re-renders with the resolved set. Pass 0 to clear the override.
 */
export function useSetAchievementsManualMatch(gameId: number) {
  const retromClient = useRetromClient();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationKey: ["set-achievements-manual-match", gameId],
    mutationFn: (retroachievementsGameId: number) =>
      retromClient.metadataClient.setGameAchievementsManualMatch({
        gameId,
        retroachievementsGameId,
      }),
    onError: (error) => {
      console.error(error);
      toast({
        title: "Couldn't map this game",
        description: "Check the RetroAchievements game ID and try again.",
        variant: "destructive",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["game-achievements", gameId],
      }),
  });
}
