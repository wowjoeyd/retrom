import { EmulatorSyncStatus } from "@retrom/codegen/retrom/client/emulator-sync_pb";
import { Badge } from "@retrom/ui/components/badge";
import { useEmulatorSyncStatus } from "@/queries/useEmulatorSyncStatus";
import { match } from "ts-pattern";

const statusLabels: Record<EmulatorSyncStatus, string> = {
  [EmulatorSyncStatus.UNSPECIFIED]: "Unknown",
  [EmulatorSyncStatus.SYNCED]: "Synced",
  [EmulatorSyncStatus.SYNCING]: "Syncing",
  [EmulatorSyncStatus.OUT_OF_DATE]: "Out of date",
  [EmulatorSyncStatus.NOT_CACHED]: "Not cached",
  [EmulatorSyncStatus.FAILED]: "Failed",
};

export function SyncStatusBadge(props: { emulatorId: number }) {
  const { data: status } = useEmulatorSyncStatus(props.emulatorId);

  if (status === undefined) {
    return null;
  }

  const variant = match(status)
    .with(EmulatorSyncStatus.SYNCED, () => "default" as const)
    .with(EmulatorSyncStatus.SYNCING, () => "secondary" as const)
    .with(EmulatorSyncStatus.OUT_OF_DATE, () => "outline" as const)
    .with(EmulatorSyncStatus.NOT_CACHED, () => "outline" as const)
    .with(EmulatorSyncStatus.FAILED, () => "destructive" as const)
    .otherwise(() => "secondary" as const);

  return <Badge variant={variant}>{statusLabels[status]}</Badge>;
}