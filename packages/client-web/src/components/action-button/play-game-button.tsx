import { Button } from "@retrom/ui/components/button";
import { usePlayGame } from "@/mutations/usePlayGame";
import { usePlayStatusQuery } from "@/queries/usePlayStatus";
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
import { useModalAction } from "@/providers/modal-action";
import { Game } from "@retrom/codegen/retrom/models/games_pb";
import { useDefaultEmulator } from "@/queries/useDefaultEmulator";
import { useGameFiles } from "@/queries/useGameFiles";
import { checkIsDesktop } from "@/lib/env";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { Emulator_OperatingSystem } from "@retrom/codegen/retrom/models/emulators_pb";
import { RawMessage } from "@/utils/protos";
import { Spinner } from "@retrom/ui/components/spinner";

type PlayGameButtonProps = { game: Game } & ComponentProps<typeof Button>;

export const PlayGameButton = forwardRef(
  (
    props: PlayGameButtonProps,
    forwardedRef: ForwardedRef<HTMLButtonElement>,
  ) => {
    const { game } = props;
    const installOnPlayModal = useModalAction("installOnPlay");
    const { data: emulatorData } = useDefaultEmulator(game);
    const installationState = useInstallationStatus(game.id);
    const { data: gameFiles } = useGameFiles({
      request: { gameIds: [game.id] },
      selectFn: (data) => data.gameFiles.filter((f) => f.gameId === game.id),
    });

    const { mutate: playGame, isPending: playPending } = usePlayGame(game);
    const { mutate: stopAction } = useStopGame(game);
    const navigate = useNavigate();
    const fullscreenMatch = useMatch({
      from: "/_fullscreenLayout",
      shouldThrow: false,
    });

    const { data: playStatusUpdate, status: queryStatus } =
      usePlayStatusQuery(game);

    const { emulator, defaultProfile } = emulatorData ?? {};

    const isWasmEmulator =
      !!emulator?.libretroName &&
      emulator.operatingSystems.includes(Emulator_OperatingSystem.WASM);

    const needsInstallBeforePlay =
      checkIsDesktop() &&
      !game.thirdParty &&
      !isWasmEmulator &&
      installationState !== InstallationStatus.INSTALLED;

    const file = useMemo(
      () => gameFiles?.find((file) => file.id === game.defaultFileId),
      [game.defaultFileId, gameFiles],
    );

    const disabled = queryStatus !== "success" || playPending;

    const shouldAddEmulator = !emulator && !fullscreenMatch && !game.thirdParty;

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
        {playPending || queryStatus === "pending" ? (
          <>
            <Spinner className="h-[1.2rem] w-[1.2rem]" />
            Syncing...
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
