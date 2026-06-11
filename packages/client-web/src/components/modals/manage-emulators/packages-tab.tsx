import { useCallback, useMemo, useState } from "react";
import { Badge } from "@retrom/ui/components/badge";
import { Button } from "@retrom/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { Checkbox } from "@retrom/ui/components/checkbox";
import { Label } from "@retrom/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@retrom/ui/components/select";
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
import { useDeleteEmulatorPackages } from "@/mutations/useDeleteEmulatorPackages";
import { useConfig } from "@/providers/config";
import { LoaderCircleIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { match } from "ts-pattern";
import { ScrollArea } from "@retrom/ui/components/scroll-area";

const packageStatusLabels: Record<EmulatorPackageStatus, string> = {
  [EmulatorPackageStatus.UNSPECIFIED]: "Unknown",
  [EmulatorPackageStatus.HEALTHY]: "Healthy",
  [EmulatorPackageStatus.DEGRADED]: "Degraded",
  [EmulatorPackageStatus.MISSING]: "Missing",
};

function shortenPath(path: string): string {
  const normalized = path.replace(/^\\\\\?\\/, "");
  if (normalized.length <= 48) {
    return normalized;
  }
  return `…${normalized.slice(-45)}`;
}

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
  const { mutateAsync: deletePackages, isPending: deleting } =
    useDeleteEmulatorPackages();

  const [deleteTarget, setDeleteTarget] = useState<EmulatorPackage | null>(
    null,
  );
  const [deleteFiles, setDeleteFiles] = useState(true);

  const packages = data?.packages ?? [];
  const latestBySlug = useMemo(
    () => data?.latestPackageIdBySlug ?? {},
    [data?.latestPackageIdBySlug],
  );

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
  const actionPending = linking || updating || deleting;

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) {
      return;
    }

    await deletePackages({
      packageIds: [deleteTarget.id],
      deleteFiles,
    });
    setDeleteTarget(null);
  }, [deleteFiles, deletePackages, deleteTarget]);

  return (
    <div className="flex flex-col gap-4 min-w-0 h-full">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 shrink-0">
        <p className="text-sm text-muted-foreground max-w-[65ch]">
          Emulator binaries stored on your NAS. Catalog installs auto-link the
          matching emulator definition. Use &quot;Change link&quot; only if you
          created a separate emulator entry or need to fix a broken link.
        </p>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
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
        <ScrollArea className="flex-1 min-h-0 rounded-md border p-1">
          <div className="flex flex-col gap-3 min-w-0">
            {packages.map((pkg) => {
              const linkedConfigs = linkedByPackageId.get(pkg.id) ?? [];
              const latestId = latestBySlug[pkg.packageSlug];
              const isLatest = latestId === pkg.id;
              const linkedNames = linkedConfigs.map((c) => {
                const emulator = props.emulators.find(
                  (e) => e.id === c.emulatorId,
                );
                return emulator?.name ?? `Emulator #${c.emulatorId}`;
              });

              return (
                <div
                  key={pkg.id}
                  className="rounded-lg border bg-card/40 p-4 flex flex-col gap-3 min-w-0"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-medium">{pkg.displayName}</h4>
                        <span className="text-xs text-muted-foreground font-mono">
                          {pkg.packageSlug}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 mt-1 text-sm">
                        <span>v{pkg.version}</span>
                        {isLatest ? (
                          <Badge variant="secondary">Latest</Badge>
                        ) : null}
                        <PackageStatusBadge status={pkg.status} />
                      </div>
                    </div>

                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={actionPending}
                      onClick={() => {
                        setDeleteFiles(true);
                        setDeleteTarget(pkg);
                      }}
                    >
                      <Trash2Icon />
                      Remove
                    </Button>
                  </div>

                  <p
                    className="text-xs font-mono text-muted-foreground break-all"
                    title={pkg.rootPath}
                  >
                    {shortenPath(pkg.rootPath)}
                  </p>

                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <p className="text-sm shrink-0">
                      <span className="text-muted-foreground">Linked: </span>
                      {linkedNames.length > 0 ? linkedNames.join(", ") : "None"}
                    </p>

                    <div className="flex flex-wrap gap-2 sm:ml-auto">
                      <Select
                        disabled={actionPending || !clientId}
                        onValueChange={(emulatorId) =>
                          void handleLink(pkg.id, emulatorId)
                        }
                      >
                        <SelectTrigger className="w-full sm:w-[200px]">
                          <SelectValue placeholder="Change link…" />
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
                        <div key={config.id} className="flex flex-wrap gap-2">
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
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove emulator package</DialogTitle>
            <DialogDescription>
              Removes{" "}
              <strong>
                {deleteTarget?.displayName} v{deleteTarget?.version}
              </strong>{" "}
              from Retrom and unlinks any clients using it.
            </DialogDescription>
          </DialogHeader>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={deleteFiles}
              onCheckedChange={(checked) => setDeleteFiles(checked === true)}
            />
            <div className="flex flex-col gap-1">
              <Label>Also delete files from NAS</Label>
              <p className="text-xs text-muted-foreground break-all font-mono">
                {deleteTarget?.rootPath}
              </p>
            </div>
          </label>

          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? <LoaderCircleIcon className="animate-spin" /> : null}
              Remove package
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PackageStatusBadge(props: { status: EmulatorPackageStatus }) {
  const variant = match(props.status)
    .with(EmulatorPackageStatus.HEALTHY, () => "default" as const)
    .with(EmulatorPackageStatus.DEGRADED, () => "outline" as const)
    .with(EmulatorPackageStatus.MISSING, () => "destructive" as const)
    .otherwise(() => "secondary" as const);

  return <Badge variant={variant}>{packageStatusLabels[props.status]}</Badge>;
}
