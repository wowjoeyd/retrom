import { Game } from "@retrom/codegen/retrom/models/games_pb";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { playGame as invokePlayGame } from "@retrom/plugin-launcher";
import { PlayGamePayload } from "@retrom/codegen/retrom/client/client-utils_pb";
import { RawMessage } from "@/utils/protos";
import { toast } from "@retrom/ui/hooks/use-toast";
import { Spinner } from "@retrom/ui/components/spinner";
import { useModalAction } from "@/providers/modal-action";
import { useSyncEmulatorSaves } from "@/mutations/useSyncEmulatorSaves";
import { useSyncEmulatorSaveStates } from "@/mutations/useSyncEmulatorSaveStates";
import {
  SaveSyncStatus,
  SyncBehavior,
  SyncEmulatorSavesResponse,
  SyncEmulatorSaveStatesResponse,
} from "@retrom/codegen/retrom/client/saves_pb";
import { Emulator } from "@retrom/codegen/retrom/models/emulators_pb";
import { useLocalEmulatorConfigs } from "@/queries/useLocalEmulatorConfigs";
import { useConfig } from "@/providers/config";
import { useDefaultEmulator } from "@/queries/useDefaultEmulator";
import { checkIsDesktop, isEmulatorPackageSyncEnabled } from "@/lib/env";
import {
  ensureEmulatorSynced,
  subscribeToEmulatorSyncUpdates,
  unsubscribeFromEmulatorSyncUpdates,
} from "@retrom/plugin-emulator-sync";
import { match } from "ts-pattern";

export function usePlayGame(game?: RawMessage<Game>) {
  const queryClient = useQueryClient();

  const clientId = useConfig((store) => store.config?.clientInfo?.id);
  const { data: emulatorData } = useDefaultEmulator(game);
  const { emulator: defaultEmulatorForQuery } = emulatorData ?? {};
  const { data: localConfig } = useLocalEmulatorConfigs({
    request: { emulatorIds: defaultEmulatorForQuery ? [defaultEmulatorForQuery.id] : [], clientId },
    enabled: !!defaultEmulatorForQuery && clientId !== undefined,
    selectFn: (data) =>
      data.configs.find((config) => config.emulatorId === defaultEmulatorForQuery?.id),
  });

  const { mutateAsync: syncEmulatorSaves } = useSyncEmulatorSaves();
  const { mutateAsync: syncEmulatorSaveStates } = useSyncEmulatorSaveStates();
  const resolveSaveConflictModal = useModalAction("resolveCloudSaveConflict");

  const resolveConflict = async (
    emulatorId: number,
    response: SyncEmulatorSavesResponse | SyncEmulatorSaveStatesResponse,
    saveKind: "saves" | "saveStates",
  ) => {
    const sync = saveKind === "saves" ? syncEmulatorSaves : syncEmulatorSaveStates;

    return await new Promise((resolve, reject) => {
      resolveSaveConflictModal.openModal({
        status: response,
        saveKind,
        onClose: () => {
          reject(new Error("Save conflict not resolved"));
        },
        onResolved: (choice) =>
          match(choice)
            .with("local", () =>
              sync({
                emulatorId,
                behavior: SyncBehavior.FORCE_LOCAL,
              })
                .then((res) => resolve(res))
                .catch(reject),
            )
            .with("cloud", () =>
              sync({
                emulatorId,
                behavior: SyncBehavior.FORCE_CLOUD,
              })
                .then((res) => resolve(res))
                .catch(reject),
            )
            .with("skip", () => {
              resolve(null);
            })
            .exhaustive(),
      });
    });
  };

  return useMutation({
    mutationKey: ["play", game?.id],
    mutationFn: async (payload: RawMessage<PlayGamePayload>) => {
      const { emulator: payloadEmulator, game: payloadGame } = payload as any;

      if (checkIsDesktop() && payloadEmulator) {
        try {
          // Saves sync with toast (mirrors previous PlayGameButton logic)
          const syncToast = toast({
            title: `Syncing Saves: ${payloadEmulator.name}`,
            duration: Infinity,
            dismissible: false,
            icon: <Spinner className="text-primary" />,
          });

          const response = await syncEmulatorSaves({
            emulatorId: payloadEmulator.id,
          });

          if (
            response.status === SaveSyncStatus.LOCAL_ERROR &&
            response.conflictReport
          ) {
            await resolveConflict(payloadEmulator.id, response, "saves");
          }

          syncToast.update({
            title: `Saves synced: ${payloadEmulator.name}`,
            dismissible: true,
            duration: 5000,
          });

          // Save states sync with toast
          const statesSyncToast = toast({
            title: `Syncing Save States: ${payloadEmulator.name}`,
            duration: Infinity,
            dismissible: false,
            icon: <Spinner className="text-primary" />,
          });

          const statesResponse = await syncEmulatorSaveStates({
            emulatorId: payloadEmulator.id,
          });

          if (
            statesResponse.status === SaveSyncStatus.LOCAL_ERROR &&
            statesResponse.conflictReport
          ) {
            await resolveConflict(payloadEmulator.id, statesResponse, "saveStates");
          }

          statesSyncToast.update({
            title: `Save states synced: ${payloadEmulator.name}`,
            dismissible: true,
            duration: 5000,
          });

          // Emulator package sync (if managed) - non-fatal on error to avoid blocking launch
          if (localConfig?.managedPaths && isEmulatorPackageSyncEnabled()) {
            const pkgToast = toast({
              title: `Syncing Emulator: ${payloadEmulator.name}`,
              duration: Infinity,
              dismissible: false,
              icon: <Spinner className="text-primary" />,
            });

            let channel: any = null;
            try {
              channel = await subscribeToEmulatorSyncUpdates((update) => {
                if (update.emulatorId !== payloadEmulator.id) return;
                pkgToast.update({
                  description: `${update.metrics?.percentComplete ?? 0}%`,
                });
              });

              await ensureEmulatorSynced({ emulatorId: payloadEmulator.id });
              pkgToast.update({
                title: `Emulator synced: ${payloadEmulator.name}`,
                dismissible: true,
                duration: 5000,
              });
            } catch (pkgError) {
              const pkgMsg =
                pkgError instanceof Error ? pkgError.message : "An unknown error occurred.";
              pkgToast.update({
                title: `Emulator sync issue: ${payloadEmulator.name}`,
                description: pkgMsg + " Continuing launch.",
                dismissible: true,
                duration: 5000,
              });
            } finally {
              if (channel) {
                await unsubscribeFromEmulatorSyncUpdates(channel);
              }
              toast.dismiss(pkgToast.id);
            }
          }
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : "An unknown error occurred.";
          toast({
            title: "Pre-launch sync issue",
            description: errorMsg + " Launching anyway.",
          });
          // fall through to launch - do not block
        }
      }

      toast({
        title: (payloadGame?.thirdParty ?? game?.thirdParty) ? "Launching External Game" : "Launching Game",
        description: "Launching the game, this may take a few seconds.",
        duration: 3000,
      });

      return invokePlayGame(payload);
    },
    onError: console.error,
    onSuccess: () => {
      return queryClient.invalidateQueries({
        queryKey: ["play-status", game?.id],
      });
    },
  });
}
