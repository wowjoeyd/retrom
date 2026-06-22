import { GamePlayStatusUpdate } from "@retrom/codegen/retrom/client/client-utils_pb";
import { checkIsDesktop } from "@/lib/env";
import { useRetromClient } from "@/providers/retrom-client";
import { useQueryClient } from "@tanstack/react-query";
import { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";

/**
 * When a game exits, re-poll its achievements once (bypassing the server TTL) so
 * unlocks earned during the session — Steam records them while you play, and an
 * RA-enabled emulator reports them to RA in real time — show up immediately.
 *
 * Uses `force_refresh` so the server actually re-fetches the provider (a plain
 * invalidation would just re-serve the cached set), and writes the result
 * straight into the query cache so the tab/chip update with no loading flash.
 * Desktop only — `game-stopped` comes from the native/Steam launch adapters.
 */
export function useRefreshAchievementsOnExit(gameId: number) {
  const retromClient = useRetromClient();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!checkIsDesktop()) return;

    const window = getCurrentWebviewWindow();
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    void window
      .listen("game-stopped", (event: { payload: GamePlayStatusUpdate }) => {
        if (event.payload.gameId !== gameId) return;

        void (async () => {
          try {
            const fresh = await retromClient.metadataClient.getGameAchievements(
              {
                gameId,
                forceRefresh: true,
              },
            );
            queryClient.setQueryData(["game-achievements", gameId], fresh);
          } catch (error) {
            console.error("Failed to refresh achievements on game exit", error);
          }
        })();
      })
      .then((fn) => {
        // The component may have unmounted before listen() resolved.
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [gameId, retromClient, queryClient]);
}
