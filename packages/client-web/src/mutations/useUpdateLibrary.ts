import { useToast } from "@retrom/ui/hooks/use-toast";
import { JobStatus } from "@retrom/codegen/retrom/jobs_pb";
import { GetJobSubscriptionResponse } from "@retrom/codegen/retrom/services/job-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateSteamInstallations } from "@retrom/plugin-installer";
import { checkIsDesktop } from "@/lib/env";
import { create } from "@bufbuild/protobuf";
import { AutoDownloadGameSoundtrackRequestSchema } from "@retrom/codegen/retrom/services/metadata-service_pb";

export function useUpdateLibrary() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    onError: (err) => {
      toast({
        title: "Error updating library",
        variant: "destructive",
        description: err.message,
      });
    },
    onSuccess: ({ jobIds }) => {
      toast({
        title: "Library update started!",
      });

      const subscriptions = jobIds.map((jobId) =>
        retromClient.jobClient.getJobSubscription({
          jobId,
        }),
      );

      async function invalidate() {
        return queryClient
          .invalidateQueries({
            predicate: (query) =>
              [
                "library",
                "games",
                "platforms",
                "game-metadata",
                "platform-metadata",
                "installation-index",
              ].some((key) => query.queryKey.includes(key)),
          })
          .catch(console.error);
      }

      async function pollSub(
        subscription: AsyncIterable<GetJobSubscriptionResponse>,
      ) {
        for await (const progress of subscription) {
          if (progress.job?.status === JobStatus.Success) {
            await invalidate();

            toast({
              title: `Job complete: ${progress.job?.name}!`,
            });
          }
        }
      }

      const promises = subscriptions.map(
        (subscription) =>
          new Promise<void>((resolve, reject) => {
            if (subscription !== undefined) {
              pollSub(subscription)
                .then(() => resolve())
                .catch(reject);
            } else {
              resolve();
            }
          }),
      );

      Promise.all(promises)
        .then(async () => {
          if (checkIsDesktop()) {
            await updateSteamInstallations();
          }

          // Automatically download metadata (name, artwork, etc.) for newly discovered
          // games/platforms by matching cleaned filenames/folder names against IGDB.
          // Non-overwrite (respects prior manual edits). Requires IGDB credentials in
          // Server Config; otherwise silently produces no metadata. This makes adding
          // ROMs name themselves automatically without a separate "Download Metadata" step.
          try {
            const metaResp =
              await retromClient.libraryClient.updateLibraryMetadata({
                overwrite: false,
              });

            // Light poll of the spawned metadata jobs so that metadata-related queries
            // refresh once the IGDB lookups complete.
            const metaJobIds = [
              metaResp.gameMetadataJobId,
              metaResp.platformMetadataJobId,
              metaResp.extraMetadataJobId,
              metaResp.steamMetadataJobId,
              metaResp.themeAudioJobId,
            ].filter(Boolean) as string[];

            metaJobIds.forEach((jobId) => {
              const sub = retromClient.jobClient.getJobSubscription({ jobId });
              void (async () => {
                for await (const progress of sub) {
                  if (progress.job?.status === JobStatus.Success) {
                    await queryClient
                      .invalidateQueries({
                        predicate: (q) =>
                          [
                            "game-metadata",
                            "platform-metadata",
                            "games",
                            "platforms",
                          ].some((k) => q.queryKey.includes(k)),
                      })
                      .catch(console.error);
                  }
                }
              })();
            });
          } catch (e) {
            // Non-fatal (e.g. IGDB not configured, or another metadata job running).
            // Jobs indicator will surface activity if any.
            console.debug(
              "Auto metadata fetch after library scan did not start:",
              e,
            );
          }

          // Auto-download theme audio for new games if the setting is enabled.
          try {
            const configResp = await retromClient.serverClient.getServerConfig(
              {},
            );
            if (configResp.config?.metadata?.autoDownloadMusic) {
              const gamesResp = await retromClient.gameClient.getGames({});
              const gameIds = gamesResp.games.map((g) => g.id);
              if (gameIds.length > 0) {
                await retromClient.metadataClient.autoDownloadGameSoundtrack(
                  create(AutoDownloadGameSoundtrackRequestSchema, { gameIds }),
                );
              }
            }
          } catch (e) {
            console.debug("Auto music download after library scan failed:", e);
          }

          return invalidate();
        })
        .catch(console.error);
    },
    mutationFn: () => retromClient.libraryClient.updateLibrary({}),
  });
}
