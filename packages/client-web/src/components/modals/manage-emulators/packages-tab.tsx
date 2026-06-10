import { useCallback, useMemo } from "react";
import { Badge } from "@retrom/ui/components/badge";
import { Button } from "@retrom/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@retrom/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@retrom/ui/components/table";
import {
  Emulator,
  LocalEmulatorConfig,
} from "@retrom/codegen/retrom/models/emulators_pb";
import {
  EmulatorPackage,
  EmulatorPackageStatus,
} from "@retrom/codegen/retrom/models/emulator-packages_pb";
import { useEmulatorPackages } from "@/queries/useEmulatorPackages";
import { useLinkEmulatorToPackage } from "@/mutations/useLinkEmulatorToPackage";
import { useUpdateEmulatorPackages } from "@/mutations/useUpdateEmulatorPackages";
import { useUpdateLocalEmulatorConfig } from "@/mutations/useUpdateLocalEmulatorConfigs";
import { useConfig } from "@/providers/config";
import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { match } from "ts-pattern";

const packageStatusLabels: Record<EmulatorPackageStatus, string> = {
  [EmulatorPackageStatus.UNSPECIFIED]: "Unknown",
  [EmulatorPackageStatus.HEALTHY]: "Healthy",
  [EmulatorPackageStatus.DEGRADED]: "Degraded",
  [EmulatorPackageStatus.MISSING]: "Missing",
};

export function PackagesTab(props: {
  emulators: Emulator[];
  configs: LocalEmulatorConfig[];
}) {
  const clientId = useConfig((s) => s.config?.clientInfo?.id);
  const { data, status } = useEmulatorPackages();
  const { mutateAsync: scanPackages, isPending: scanning } =
    useUpdateEmulatorPackages();
  const { mutateAsync: linkToPackage, isPending: linking } =
    useLinkEmulatorToPackage();
  const { mutateAsync: updateConfig, isPending: updating } =
    useUpdateLocalEmulatorConfig();

  const packages = data?.packages ?? [];
  const latestBySlug = data?.latestPackageIdBySlug ?? {};

  const linkedByPackageId = useMemo(() => {
    const map = new Map<number, LocalEmulatorConfig[]>();
    for (const config of props.configs) {
      if (!config.linkedPackageId || !config.managedPaths) {
        continue;
      }
      const existing = map.get(config.linkedPackageId) ?? [];
      existing.push(config);
      map.set(config.linkedPackageId, existing);
    }
    return map;
  }, [props.configs]);

  const desktopEmulators = useMemo(
    () => props.emulators.filter((e) => !e.builtIn),
    [props.emulators],
  );

  const handleLink = useCallback(
    async (packageId: number, emulatorId: string) => {
      if (!clientId) {
        return;
      }

      await linkToPackage({
        emulatorId: Number(emulatorId),
        packageId,
        clientId,
        managedPaths: true,
      });
    },
    [clientId, linkToPackage],
  );

  const handleUnlink = useCallback(
    async (config: LocalEmulatorConfig) => {
      await updateConfig({
        configs: [
          {
            id: config.id,
            clientId: config.clientId,
            emulatorId: config.emulatorId,
            managedPaths: false,
          },
        ],
      });
    },
    [updateConfig],
  );

  const handleUpdateToLatest = useCallback(
    async (pkg: EmulatorPackage, config: LocalEmulatorConfig) => {
      if (!clientId) {
        return;
      }

      const latestId = latestBySlug[pkg.packageSlug];
      if (!latestId || latestId === config.linkedPackageId) {
        return;
      }

      await linkToPackage({
        emulatorId: config.emulatorId,
        packageId: latestId,
        clientId,
        managedPaths: true,
      });
    },
    [clientId, latestBySlug, linkToPackage],
  );

  const pending = status === "pending";
  const error = status === "error";
  const actionPending = linking || updating;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground max-w-[65ch]">
          Server-indexed emulator packages on your NAS. Link packages to
          emulators for managed local cache sync.
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={scanning}
          onClick={() => void scanPackages()}
        >
          {scanning ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <RefreshCwIcon />
          )}
          Scan packages
        </Button>
      </div>

      {pending ? (
        <LoaderCircleIcon className="animate-spin h-8 w-8 mx-auto" />
      ) : error ? (
        <p className="text-red-500 text-sm">
          Failed to load emulator packages. Is emulator package support enabled
          on the server?
        </p>
      ) : packages.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          No packages indexed yet. Install from the Catalog tab or scan existing
          NAS trees.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Package</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Linked</TableHead>
              <TableHead className="text-end">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {packages.map((pkg) => {
              const linkedConfigs = linkedByPackageId.get(pkg.id) ?? [];
              const latestId = latestBySlug[pkg.packageSlug];
              const isLatest = latestId === pkg.id;

              return (
                <TableRow key={pkg.id}>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{pkg.displayName}</span>
                      <span className="text-xs text-muted-foreground font-mono">
                        {pkg.packageSlug}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span>{pkg.version}</span>
                      {isLatest ? (
                        <Badge variant="secondary">Latest</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PackageStatusBadge status={pkg.status} />
                  </TableCell>
                  <TableCell className="text-sm">
                    {linkedConfigs.length > 0
                      ? linkedConfigs
                          .map((c) => {
                            const emulator = props.emulators.find(
                              (e) => e.id === c.emulatorId,
                            );
                            return emulator?.name ?? `Emulator #${c.emulatorId}`;
                          })
                          .join(", ")
                      : "—"}
                  </TableCell>
                  <TableCell className="text-end">
                    <div className="flex flex-col sm:flex-row gap-2 justify-end items-end">
                      <Select
                        disabled={actionPending || !clientId}
                        onValueChange={(emulatorId) =>
                          void handleLink(pkg.id, emulatorId)
                        }
                      >
                        <SelectTrigger className="w-[180px]">
                          <SelectValue placeholder="Link emulator" />
                        </SelectTrigger>
                        <SelectContent>
                          {desktopEmulators.map((emulator) => (
                            <SelectItem
                              key={emulator.id}
                              value={String(emulator.id)}
                            >
                              {emulator.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {linkedConfigs.map((config) => (
                        <div key={config.id} className="flex gap-2">
                          {!isLatest ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={actionPending}
                              onClick={() =>
                                void handleUpdateToLatest(pkg, config)
                              }
                            >
                              Update to latest
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={actionPending}
                            onClick={() => void handleUnlink(config)}
                          >
                            Unlink
                          </Button>
                        </div>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function PackageStatusBadge(props: { status: EmulatorPackageStatus }) {
  const variant = match(props.status)
    .with(EmulatorPackageStatus.HEALTHY, () => "default" as const)
    .with(EmulatorPackageStatus.DEGRADED, () => "outline" as const)
    .with(EmulatorPackageStatus.MISSING, () => "destructive" as const)
    .otherwise(() => "secondary" as const);

  return (
    <Badge variant={variant}>{packageStatusLabels[props.status]}</Badge>
  );
}