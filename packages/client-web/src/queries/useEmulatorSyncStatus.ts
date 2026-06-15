import { EmulatorSyncStatus } from "@retrom/codegen/retrom/client/emulator-sync_pb";
import { getEmulatorSyncStatus } from "@retrom/plugin-emulator-sync";
import { checkIsDesktop } from "@/lib/env";
import { useQuery } from "@tanstack/react-query";

export function useEmulatorSyncStatus(emulatorId: number | undefined) {
  return useQuery({
    queryKey: ["emulator-sync-status", emulatorId],
    enabled: checkIsDesktop() && emulatorId !== undefined,
    queryFn: () =>
      getEmulatorSyncStatus({ emulatorId: emulatorId! }).then(
        (res) => res.status,
      ),
    refetchInterval: (query) =>
      query.state.data === EmulatorSyncStatus.SYNCING ? 1000 : false,
  });
}
