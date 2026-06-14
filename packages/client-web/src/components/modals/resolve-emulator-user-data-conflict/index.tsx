import { Button } from "@retrom/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemContent,
  ItemMedia,
  ItemDescription,
} from "@retrom/ui/components/item";
import { Spinner } from "@retrom/ui/components/spinner";
import { Checkbox } from "@retrom/ui/components/checkbox";
import { CloudIcon, ServerIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useModalAction, BaseModalActionProps } from "@/providers/modal-action";
import { useSyncEmulatorUserData } from "@/mutations/useSyncEmulatorUserData";

type Choice = "local" | "cloud" | "skip";
const preferenceKey = (emulatorId: number) =>
  `retrom-emulator-user-data-conflict-preference-${emulatorId}`;

declare global {
  namespace RetromModals {
    interface ModalActions {
      resolveEmulatorUserDataConflict: BaseModalActionProps & {
        emulatorId: number;
        onResolved?: (choice: Choice) => Promise<void> | void;
      };
    }
  }
}

export function ResolveEmulatorUserDataConflictModal() {
  const { modalState, closeModal } = useModalAction(
    "resolveEmulatorUserDataConflict",
  );
  const { onResolved, onClose, onOpen, emulatorId } = modalState ?? {};
  const [rememberChoice, setRememberChoice] = useState(false);

  const rememberedChoice = useMemo(() => {
    if (!emulatorId) return undefined;
    const value = localStorage.getItem(preferenceKey(emulatorId));
    return value === "local" || value === "cloud" ? value : undefined;
  }, [emulatorId]);

  const { mutateAsync: syncUserData, status: syncStatus } =
    useSyncEmulatorUserData();

  const close = useCallback(() => {
    onClose?.();
    closeModal();
  }, [closeModal, onClose]);

  const handleChoice = useCallback(
    async (choice: Choice) => {
      if (!emulatorId) return;

      if (choice === "local") {
        await syncUserData({ emulatorId, direction: "push" });
      } else if (choice === "cloud") {
        await syncUserData({ emulatorId, direction: "pull" });
      }

      if (rememberChoice && choice !== "skip") {
        localStorage.setItem(preferenceKey(emulatorId), choice);
      }

      await onResolved?.(choice);
      close();
    },
    [emulatorId, syncUserData, rememberChoice, onResolved, close],
  );

  const pending = syncStatus === "pending";

  return (
    <Dialog
      open={!!modalState?.open}
      onOpenChange={(open) => {
        if (!open) {
          close();
        } else {
          onOpen?.();
        }
      }}
    >
      <DialogContent userCanClose={false}>
        <DialogHeader>
          <DialogTitle>Emulator User Data Conflict</DialogTitle>
          <DialogDescription className="max-w-[45ch]">
            Your local user data (firmware, keys, installed games, RAPs etc.)
            conflicts with the cloud version. Choose which to keep as the source
            of truth.
            {rememberedChoice
              ? ` Last remembered preference: ${rememberedChoice}.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Item size="sm" variant="outline" className="max-w-[45ch]">
            <ItemMedia variant="icon">
              <CloudIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Cloud (NAS) Version</ItemTitle>
              <ItemDescription>
                Use the version currently on the server as truth (pull to
                local).
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                size="sm"
                disabled={pending}
                variant="accent"
                onClick={() => handleChoice("cloud")}
              >
                {pending ? (
                  <>
                    <Spinner /> Select
                  </>
                ) : (
                  "Select Cloud"
                )}
              </Button>
            </ItemActions>
          </Item>

          <Item size="sm" variant="outline" className="max-w-[45ch]">
            <ItemMedia variant="icon">
              <ServerIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Local Version</ItemTitle>
              <ItemDescription>
                Push this PC&apos;s local data as the new cloud truth.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                type="button"
                size="sm"
                disabled={pending}
                variant="accent"
                onClick={() => handleChoice("local")}
              >
                {pending ? (
                  <>
                    <Spinner /> Select
                  </>
                ) : (
                  "Select Local"
                )}
              </Button>
            </ItemActions>
          </Item>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="remember-emulator-user-data-conflict-choice"
            checked={rememberChoice}
            onCheckedChange={(value) => setRememberChoice(value === true)}
          />
          <label
            htmlFor="remember-emulator-user-data-conflict-choice"
            className="text-sm"
          >
            Remember this choice for this emulator
          </label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            disabled={pending}
            variant="ghost"
            onClick={() => handleChoice("skip")}
          >
            Skip for now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
