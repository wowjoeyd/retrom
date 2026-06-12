import {
  PushEmulatorPreserveResponse,
} from "@retrom/codegen/retrom/client/emulator-sync_pb";
import {
  pullEmulatorUserData,
  pushEmulatorPreserveData,
} from "@retrom/plugin-emulator-sync";
import {
  useMutation,
  UseMutationOptions,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "@retrom/ui/hooks/use-toast";

export type UserDataSyncDirection = "push" | "pull";

export interface SyncEmulatorUserDataPayload {
  emulatorId: number;
  direction: UserDataSyncDirection;
}

export function useSyncEmulatorUserData(
  opts?: Omit<
    UseMutationOptions<
      PushEmulatorPreserveResponse,
      Error,
      SyncEmulatorUserDataPayload
    >,
    "mutationFn"
  >,
) {
  const queryClient = useQueryClient();

  return useMutation({
    ...opts,
    onMutate: (payload) => {
      toast({
        title:
          payload.direction === "push"
            ? "Pushing emulator user data"
            : "Pulling emulator user data",
      });
      return opts?.onMutate?.(payload);
    },
    mutationFn: async (payload: SyncEmulatorUserDataPayload) => {
      const arg = { emulatorId: payload.emulatorId };
      if (payload.direction === "push") {
        return pushEmulatorPreserveData(arg);
      } else {
        return pullEmulatorUserData(arg);
      }
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        predicate: (query) =>
          ["emulator-sync-status", "emulator-packages", "local-emulator-configs"].some((key) =>
            query.queryKey.includes(key),
          ),
      }),
    onSuccess: (data, variables, context) => {
      toast({
        title:
          variables.direction === "push"
            ? "Emulator user data pushed"
            : "Emulator user data pulled",
        description:
          data.filesUploaded > 0
            ? `${data.filesUploaded} file(s), ${data.bytesUploaded} bytes`
            : "No changes found",
      });
      opts?.onSuccess?.(data, variables, context);
    },
    onError: (error, variables, context) => {
      toast({
        title:
          variables.direction === "push"
            ? "Emulator user data push failed"
            : "Emulator user data pull failed",
        description: error.message,
        variant: "destructive",
      });
      opts?.onError?.(error, variables, context);
    },
  });
}
