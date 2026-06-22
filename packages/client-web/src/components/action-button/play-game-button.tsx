import { Button } from "@retrom/ui/components/button";
import { usePlayGame } from "@/mutations/usePlayGame";
import { usePlayStatusQuery } from "@/queries/usePlayStatus";
import { useRefreshAchievementsOnExit } from "@/queries/useRefreshAchievementsOnExit";
import {
  PlayGamePayload,
  PlayStatus,
} from "@retrom/codegen/retrom/client/client-utils_pb";
import { useStopGame } from "@/mutations/useStopGame";
import {
  ComponentProps,
  ForwardedRef,
  forwardRef,
  useCallback,
  useMemo,
} from "react";
import { PlayIcon, PlusIcon, Square } from "lucide-react";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { toast } from "@retrom/ui/hooks/use-toast";
import { Game } from "@retrom/codegen/retrom/models/games_pb";
import { useDefaultEmulator } from "@/queries/useDefaultEmulator";
import { useGameFiles } from "@/queries/useGameFiles";
import { useMutation } from "@tanstack/react-query";
import { checkIsDesktop, isEmulatorPackageSyncEnabled } from "@/lib/env";
import { match } from "ts-pattern";
import {
  SaveSyncStatus,
  SyncBehavior,
  SyncEmulatorSavesResponse,
  SyncEmulatorSaveStatesResponse,
} from "@retrom/codegen/retrom/client/saves_pb";
import { useModalAction } from "@/providers/modal-action";
import { useSyncEmulatorSaves } from "@/mutations/useSyncEmulatorSaves";
import { Emulator } from "@retrom/codegen/retrom/models/emulators_pb";
import { Spinner } from "@retrom/ui/components/spinner";
import { RawMessage } from "@/utils/protos";
import { useSyncEmulatorSaveStates } from "@/mutations/useSyncEmulatorSaveStates";
import { useLocalEmulatorConfigs } from "@/queries/useLocalEmulatorConfigs";
import { useConfig } from "@/providers/config";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { Emulator_OperatingSystem } from "@retrom/codegen/retrom/models/emulators_pb";
import {
  ensureEmulatorSynced,
  subscribeToEmulatorSyncUpdates,
  unsubscribeFromEmulatorSyncUpdates,
} from "@retrom/plugin-emulator-sync";

type PlayGameButtonProps = { game: Game } & ComponentProps<typeof Button>;

export const PlayGameButton = forwardRef(
  (
    props: PlayGameButtonProps,
    forwardedRef: ForwardedRef<HTMLButtonElement>,
  ) => {
    const { game } = props;
    const resolveSaveConflictModal = useModalAction("resolveCloudSaveConflict");
    const installOnPlayModal = useModalAction("installOnPlay");
    const clientId = useConfig((store) => store.config?.clientInfo?.id);
    const { mutateAsync: syncEmulatorSaves } = useSyncEmulatorSaves();
    const { mutateAsync: syncEmulatorSaveStates } = useSyncEmulatorSaveStates();
    const { data: emulatorData } = useDefaultEmulator(game);
    const installationState = useInstallationStatus(game.id);
    const { data: gameFiles } = useGameFiles({
      request: { gameIds: [game.id] },
      selectFn: (data) => data.gameFiles.filter((f) => f.gameId === game.id),
    });

    const resolveConflict = async (
      emulatorId: number,
      response: SyncEmulatorSavesResponse | SyncEmulatorSaveStatesResponse,
      saveKind: "saves" | "saveStates",
    ) => {
      const sync =
        saveKind === "saves" ? syncEmulatorSaves : syncEmulatorSaveStates;

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

    const { mutateAsync: maybeSyncEmulatorSaves, status: syncSavesStatus } =
      useMutation({
        mutationFn: async (emulator: RawMessage<Emulator>) => {
          const emulatorId = emulator.id;
          const syncToast = toast({
            title: `Syncing Saves: ${emulator.name}`,
            duration: Infinity,
            dismissible: false,
            icon: <Spinner className="text-primary" />,
          });

          const response = await syncEmulatorSaves({
            emulatorId,
          });

          if (
            response.status === SaveSyncStatus.LOCAL_ERROR &&
            response.conflictReport
          ) {
            await resolveConflict(emulatorId, response, "saves");
          }

          syncToast.update({
            title: `Saves synced: ${emulator.name}`,
            dismissible: true,
            duration: 5000,
          });

          return response;
        },
      });

    const {
      mutateAsync: maybeSyncEmulatorSaveStates,
      status: syncStatesStatus,
    } = useMutation({
      mutationFn: async (emulator: RawMessage<Emulator>) => {
        const emulatorId = emulator.id;
        const syncToast = toast({
          title: `Syncing Save States: ${emulator.name}`,
          duration: Infinity,
          dismissible: false,
          icon: <Spinner className="text-primary" />,
        });

        const response = await syncEmulatorSaveStates({
          emulatorId,
        });

        if (
          response.status === SaveSyncStatus.LOCAL_ERROR &&
          response.conflictReport
        ) {
          await resolveConflict(emulatorId, response, "saveStates");
        }

        syncToast.update({
          title: `Save states synced: ${emulator.name}`,
          dismissible: true,
          duration: 5000,
        });

        return response;
      },
    });

    const { mutate: playAction } = usePlayGame(game);
    const { mutate: stopAction } = useStopGame(game);
    const navigate = useNavigate();
    const fullscreenMatch = useMatch({
      from: "/_fullscreenLayout",
      shouldThrow: false,
    });

    const { data: playStatusUpdate, status: queryStatus } =
      usePlayStatusQuery(game);

    // Re-poll achievements when this game exits, picking up unlocks earned
    // during the session.
    useRefreshAchievementsOnExit(game.id);

    const { emulator, defaultProfile } = emulatorData ?? {};

    const { data: localConfig } = useLocalEmulatorConfigs({
      request: { emulatorIds: emulator ? [emulator.id] : [], clientId },
      enabled: !!emulator && clientId !== undefined,
      selectFn: (data) =>
        data.configs.find((config) => config.emulatorId === emulator?.id),
    });

    const isWasmEmulator =
      !!emulator?.libretroName &&
      emulator.operatingSystems.includes(Emulator_OperatingSystem.WASM);

    const needsInstallBeforePlay =
      checkIsDesktop() &&
      !game.thirdParty &&
      !isWasmEmulator &&
      installationState !== InstallationStatus.INSTALLED;

    const file = useMemo(
      () =>
        // Prefer the explicitly-set default file, but fall back to the first available
        // file when no default is set (or it doesn't match). Most games — especially
        // single-file ones like PS2 ISOs — never have a defaultFileId, and without this
        // fallback the launcher fails with "Cannot find appropriate file for game".
        gameFiles?.find((file) => file.id === game.defaultFileId) ??
        gameFiles?.[0],
      [game.defaultFileId, gameFiles],
    );

    const { mutateAsync: maybeSyncEmulatorPackage, status: syncPackageStatus } =
      useMutation({
        mutationFn: async (targetEmulator: RawMessage<Emulator>) => {
          if (!isEmulatorPackageSyncEnabled() || !localConfig?.managedPaths) {
            return;
          }

          const syncToast = toast({
            title: `Syncing Emulator: ${targetEmulator.name}`,
            duration: Infinity,
            dismissible: false,
            icon: <Spinner className="text-primary" />,
          });

          const channel = await subscribeToEmulatorSyncUpdates((update) => {
            if (update.emulatorId !== targetEmulator.id) {
              return;
            }

            syncToast.update({
              description: `${update.metrics?.percentComplete ?? 0}%`,
            });
          });

          try {
            await ensureEmulatorSynced({ emulatorId: targetEmulator.id });
            syncToast.update({
              title: `Emulator synced: ${targetEmulator.name}`,
              dismissible: true,
              duration: 5000,
            });
          } finally {
            await unsubscribeFromEmulatorSyncUpdates(channel);
            toast.dismiss(syncToast.id);
          }
        },
      });

    const disabled =
      queryStatus !== "success" ||
      syncSavesStatus === "pending" ||
      syncStatesStatus === "pending" ||
      syncPackageStatus === "pending";

    const shouldAddEmulator = !emulator && !fullscreenMatch && !game.thirdParty;

    const { mutate: playGame } = useMutation({
      mutationFn: async (args: RawMessage<PlayGamePayload>) => {
        const { emulator } = args;

        if (checkIsDesktop() && emulator) {
          try {
            await maybeSyncEmulatorSaves(emulator);
            await maybeSyncEmulatorSaveStates(emulator);
            await maybeSyncEmulatorPackage(emulator);
          } catch (error) {
            console.error(
              "Unable to launch game during pre-launch sync",
              error,
            );
            const errorMsg =
              error instanceof Error
                ? error.message
                : typeof error === "string"
                  ? error
                  : error
                    ? JSON.stringify(error)
                    : "An unknown error occurred.";

            toast({
              title: "Unable to Launch Game",
              description: errorMsg,
            });

            return;
          }
        }

        toast({
          title: game.thirdParty ? "Launching External Game" : "Launching Game",
          description: "Launching the game, this may take a few seconds.",
          duration: 3000,
        });

        playAction(args);
      },
    });

    const onClick = useCallback(() => {
      if (disabled) return;

      if (playStatusUpdate?.playStatus === PlayStatus.PLAYING) {
        stopAction({ game });
        return;
      }

      if (shouldAddEmulator) {
        return navigate({
          to: ".",
          search: { manageEmulatorsModal: { open: true } },
        });
      }

      const launch = () =>
        playGame({
          game,
          emulatorProfile: defaultProfile,
          emulator,
          file,
        });

      if (needsInstallBeforePlay) {
        installOnPlayModal.openModal({
          game,
          onInstalled: launch,
        });
        return;
      }

      launch();
    }, [
      navigate,
      disabled,
      defaultProfile,
      emulator,
      file,
      game,
      playGame,
      playStatusUpdate,
      stopAction,
      shouldAddEmulator,
      needsInstallBeforePlay,
      installOnPlayModal,
    ]);

    return (
      <Button
        ref={forwardedRef}
        {...props}
        disabled={disabled}
        onClick={onClick}
      >
        {syncSavesStatus === "pending" ||
        syncStatesStatus === "pending" ||
        syncPackageStatus === "pending" ? (
          <>
            <Spinner className="h-[1.2rem] w-[1.2rem]" />
            {syncPackageStatus === "pending"
              ? "Syncing Emulator"
              : "Syncing Cloud"}
          </>
        ) : queryStatus === "pending" ? (
          <>
            <Spinner className="h-[1.2rem] w-[1.2rem]" />
            Launching...
          </>
        ) : playStatusUpdate?.playStatus === PlayStatus.PLAYING ? (
          <>
            <Square className="h-[1.2rem] w-[1.2rem] fill-current" />
            Stop
          </>
        ) : shouldAddEmulator ? (
          <>
            <PlusIcon className="h-[1.2rem] w-[1.2rem] stroke-[3] stroke-current fill-current" />
            Add Emulator
          </>
        ) : (
          <div className="flex gap-2 items-center">
            <PlayIcon className="fill-current" />
            <p>{game.thirdParty ? "Launch In Steam" : "Play"}</p>
          </div>
        )}
      </Button>
    );
  },
);

PlayGameButton.displayName = "PlayGameButton";
