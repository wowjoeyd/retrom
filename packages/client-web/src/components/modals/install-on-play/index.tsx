import { getFileStub } from "@/lib/utils";
import { useInstallationProgress } from "@/queries/useInstallationProgress";
import { BaseModalActionProps, useModalAction } from "@/providers/modal-action";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { Game } from "@retrom/codegen/retrom/models/games_pb";
import { Button } from "@retrom/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { Progress } from "@retrom/ui/components/progress";
import { Spinner } from "@retrom/ui/components/spinner";
import {
  installGame as installGameCommand,
  subscribeToInstallationIndex,
  unsubscribeFromInstallationIndex,
} from "@retrom/plugin-installer";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useCallback } from "react";

declare global {
  namespace RetromModals {
    interface ModalActions {
      installOnPlay: BaseModalActionProps & {
        game: Game;
        gameName?: string;
        onInstalled?: () => void | Promise<void>;
      };
    }
  }
}

async function waitForGameInstalled(gameId: number) {
  return new Promise<void>((resolve, reject) => {
    let channelId: number | undefined;
    const timeout = window.setTimeout(() => {
      if (channelId !== undefined) {
        unsubscribeFromInstallationIndex(channelId).catch(console.error);
      }
      reject(new Error("Installation timed out"));
    }, 30 * 60 * 1000);

    subscribeToInstallationIndex((index) => {
      const status = index.installations[gameId];

      if (status === InstallationStatus.INSTALLED) {
        window.clearTimeout(timeout);
        if (channelId !== undefined) {
          unsubscribeFromInstallationIndex(channelId).catch(console.error);
        }
        resolve();
      }
    })
      .then((channel) => {
        channelId = channel.id;
      })
      .catch((error) => {
        window.clearTimeout(timeout);
        reject(error);
      });
  });
}

export function InstallOnPlayModal() {
  const { modalState, closeModal } = useModalAction("installOnPlay");
  const { game, gameName, onInstalled, onClose, open } = modalState ?? {};

  const { mutateAsync: installAndWait, status } = useMutation({
    mutationFn: async () => {
      if (!game) {
        throw new Error("No game selected for installation");
      }

      await installGameCommand({ gameId: game.id });
      await waitForGameInstalled(game.id);
      await onInstalled?.();
    },
  });

  const progress = useInstallationProgress(game?.id ?? -1);
  const isInstalling = status === "pending";

  const handleClose = useCallback(() => {
    onClose?.();
    closeModal();
  }, [closeModal, onClose]);

  const displayName = gameName ?? (game ? getFileStub(game.path) : "this game");

  return (
    <Dialog
      open={!!open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isInstalling) {
          handleClose();
        }
      }}
    >
      <DialogContent className="sm:min-w-[400px]">
        <DialogHeader>
          <DialogTitle>Install before playing</DialogTitle>
          <DialogDescription>
            {displayName} is not installed locally. Install it now to continue?
          </DialogDescription>
        </DialogHeader>

        {isInstalling ? (
          <div className="flex flex-col gap-3 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="text-primary" />
              Installing… {Math.floor(progress.percentComplete)}%
            </div>
            <Progress value={progress.percentComplete} className="h-1" />
          </div>
        ) : (
          <p className="max-w-[45ch] text-sm text-muted-foreground">
            Files will be copied from your library to this device. You can play
            as soon as installation finishes.
          </p>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={isInstalling}>
              Cancel
            </Button>
          </DialogClose>

          <Button
            className="relative"
            disabled={isInstalling || !game}
            onClick={() => {
              installAndWait().then(handleClose).catch(console.error);
            }}
          >
            {isInstalling ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              "Install and Play"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}