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
    ...opts,
  });
}