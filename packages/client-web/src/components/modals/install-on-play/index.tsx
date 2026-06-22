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
import { useMatch } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { FocusContainer } from "@/components/fullscreen/focus-container";
import { HotkeyButton } from "@/components/fullscreen/hotkey-button";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useInputDeviceContext } from "@/providers/input-device";

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
    const timeout = window.setTimeout(
      () => {
        if (channelId !== undefined) {
          unsubscribeFromInstallationIndex(channelId).catch(console.error);
        }
        reject(new Error("Installation timed out"));
      },
      30 * 60 * 1000,
    );

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
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

export function InstallOnPlayModal() {
  const { modalState, closeModal } = useModalAction("installOnPlay");
  const { game, gameName, onInstalled, onClose, open } = modalState ?? {};
  const [showPostStep, setShowPostStep] = useState(false);

  // The fullscreen (Big Picture) instance of this modal is mounted under the
  // fullscreen layout, which provides the spatial-navigation + hotkey providers.
  // The windowed instance is not, and norigin is destroyed there — so the
  // controller-focusable footer must only render in the fullscreen instance.
  const isFullscreen = !!useMatch({
    from: "/_fullscreenLayout",
    shouldThrow: false,
  });

  const { mutateAsync: installAndWait, status } = useMutation({
    mutationFn: async () => {
      if (!game) {
        throw new Error("No game selected for installation");
      }

      await installGameCommand({ gameId: game.id });
      await waitForGameInstalled(game.id);
      setShowPostStep(true);
    },
  });

  const progress = useInstallationProgress(game?.id ?? -1);
  const isInstalling = status === "pending";

  const handleClose = useCallback(() => {
    onClose?.();
    closeModal();
  }, [closeModal, onClose]);

  const startInstall = useCallback(() => {
    installAndWait().catch(console.error);
  }, [installAndWait]);

  const launchInternalInstall = useCallback(() => {
    Promise.resolve(onInstalled?.()).then(handleClose).catch(console.error);
  }, [onInstalled, handleClose]);

  const displayName = gameName ?? (game ? getFileStub(game.path) : "this game");

  const footerProps: InstallFooterProps = {
    game,
    isInstalling,
    showPostStep,
    onStartInstall: startInstall,
    onLaunchInternalInstall: launchInternalInstall,
    onClose: handleClose,
  };

  return (
    <Dialog
      open={!!open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !isInstalling) {
          handleClose();
        }
      }}
    >
      <DialogContent
        className="sm:min-w-[400px]"
        onOpenAutoFocus={(e) => {
          // Let the focus effect below drive spatial focus on a controller
          // instead of Radix focusing the close button.
          if (isFullscreen) e.preventDefault();
        }}
      >
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
        ) : showPostStep ? (
          <p className="max-w-[45ch] text-sm text-muted-foreground">
            Raw files installed. For curated emulators like RPCS3 or Switch forks
            that require an &ldquo;internal install&rdquo; (e.g. PKG/NSP into the
            emulator&apos;s virtual FS), launch the emulator now to complete it
            inside the app. The installed state will be captured in the emulator
            package and synced to other PCs.
          </p>
        ) : (
          <p className="max-w-[45ch] text-sm text-muted-foreground">
            Files will be copied from your library to this device. You can play as
            soon as installation finishes.
          </p>
        )}

        {isFullscreen ? (
          <FullscreenInstallFooter {...footerProps} />
        ) : (
          <WindowedInstallFooter {...footerProps} />
        )}
      </DialogContent>
    </Dialog>
  );
}

type InstallFooterProps = {
  game?: Game;
  isInstalling: boolean;
  showPostStep: boolean;
  onStartInstall: () => void;
  onLaunchInternalInstall: () => void;
  onClose: () => void;
};

function WindowedInstallFooter(props: InstallFooterProps) {
  const { game, isInstalling, showPostStep, onStartInstall } = props;

  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button variant="secondary" disabled={isInstalling || showPostStep}>
          Cancel
        </Button>
      </DialogClose>

      {showPostStep ? (
        <Button onClick={props.onLaunchInternalInstall}>
          Launch emulator to complete internal install
        </Button>
      ) : (
        <Button
          className="relative"
          disabled={isInstalling || !game}
          onClick={onStartInstall}
        >
          {isInstalling ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            "Install and Play"
          )}
        </Button>
      )}
    </DialogFooter>
  );
}

// Fullscreen (Big Picture) footer: spatial-navigation focusable so a controller
// can select an option, with BACK closing the dialog and the focus reticle
// framing the active button. Mounted only under the fullscreen layout.
function FullscreenInstallFooter(props: InstallFooterProps) {
  const {
    game,
    isInstalling,
    showPostStep,
    onStartInstall,
    onLaunchInternalInstall,
    onClose,
  } = props;
  const [inputDevice] = useInputDeviceContext();

  // Move spatial focus onto the primary action when the dialog opens and again
  // when it advances to the post-install step (the previous focus target
  // unmounts). Without this the reticle stays on the Play button behind the
  // dialog and the controller can't select anything.
  useEffect(() => {
    if (inputDevice !== "gamepad" && inputDevice !== "hotkeys") return;
    if (isInstalling) return;
    const focusKey = showPostStep
      ? "install-on-play-launch"
      : "install-on-play-confirm";
    const raf = requestAnimationFrame(() => setFocus(focusKey));
    return () => cancelAnimationFrame(raf);
  }, [showPostStep, isInstalling, inputDevice]);

  return (
    <HotkeyLayer
      allowBubbling="never"
      handlers={{
        BACK: {
          handler: () => {
            if (!isInstalling && !showPostStep) onClose();
          },
        },
      }}
    >
      <FocusContainer
        opts={{ focusKey: "install-on-play-actions", isFocusBoundary: true }}
      >
        <DialogFooter>
          {showPostStep ? (
            <HotkeyButton
              hotkey="ACCEPT"
              onClick={onLaunchInternalInstall}
              focusOpts={{
                focusable: true,
                focusKey: "install-on-play-launch",
              }}
            >
              Launch Emulator
            </HotkeyButton>
          ) : (
            <>
              <HotkeyButton
                hotkey="BACK"
                disabled={isInstalling}
                onClick={onClose}
                focusOpts={{
                  focusable: !isInstalling,
                  focusKey: "install-on-play-cancel",
                }}
              >
                Cancel
              </HotkeyButton>
              <HotkeyButton
                hotkey="ACCEPT"
                disabled={isInstalling || !game}
                onClick={onStartInstall}
                focusOpts={{
                  focusable: !isInstalling && !!game,
                  focusKey: "install-on-play-confirm",
                }}
              >
                {isInstalling ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  "Install and Play"
                )}
              </HotkeyButton>
            </>
          )}
        </DialogFooter>
      </FocusContainer>
    </HotkeyLayer>
  );
}
