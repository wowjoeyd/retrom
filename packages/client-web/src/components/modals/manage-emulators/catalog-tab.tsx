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
import { Input } from "@retrom/ui/components/input";
import { Label } from "@retrom/ui/components/label";
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
import { ScrollArea } from "@retrom/ui/components/scroll-area";
import {
  EmulatorCatalogEntry,
  EmulatorPackage,
  EmulatorPackageStatus,
} from "@retrom/codegen/retrom/models/emulator-packages_pb";
import { useEmulatorCatalog } from "@/queries/useEmulatorCatalog";
import { useEmulatorPackages } from "@/queries/useEmulatorPackages";
import { usePlatforms } from "@/queries/usePlatforms";
import { useServerConfig } from "@/queries/useServerConfig";
import { useConfig } from "@/providers/config";
import { useCheckEmulatorPackageDirectoryWritable } from "@/mutations/useCheckEmulatorPackageDirectoryWritable";
import { useInstallCatalogPackage } from "@/mutations/useInstallCatalogPackage";
import { AlertTriangleIcon, LoaderCircleIcon } from "lucide-react";
import { operatingSystemDisplayMap } from "./utils";
import { platformFolderBasename } from "./platform-folder-utils";

export function CatalogTab() {
  const [selectedEntry, setSelectedEntry] =
    useState<EmulatorCatalogEntry | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: catalog, status: catalogStatus } = useEmulatorCatalog({
    selectFn: (data) => data.entries,
  });

  const { data: installedByCatalogId } = useEmulatorPackages({
    selectFn: (data) => {
      const map = new Map<string, EmulatorPackage>();

      for (const pkg of data.packages) {
        if (!pkg.catalogId) {
          continue;
        }

        if (pkg.status === EmulatorPackageStatus.MISSING) {
          continue;
        }

        const latestId = data.latestPackageIdBySlug[pkg.packageSlug];
        const current = map.get(pkg.catalogId);

        if (!current || pkg.id === latestId) {
          map.set(pkg.catalogId, pkg);
        }
      }

      return map;
    },
  });

  const { data: platformFolderNames } = usePlatforms({
    selectFn: (data) =>
      data.platforms
        .filter((platform) => !platform.thirdParty)
        .map((platform) => platformFolderBasename(platform.path)),
  });

  const pending = catalogStatus === "pending";
  const error = catalogStatus === "error";

  const filteredCatalog = useMemo(() => {
    const list = catalog ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((entry) => {
      const hay = [
        entry.displayName,
        entry.description ?? "",
        entry.catalogId,
        ...entry.supportedPlatformFolderNames,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [catalog, search]);

  return (
    <div className="flex flex-col gap-4 h-full">
      <p className="text-sm text-muted-foreground max-w-[65ch] shrink-0">
        Browse built-in emulator catalog entries and install packages to your
        NAS. Platform folder names must match subfolders under your configured
        library roots (e.g. <code className="font-mono text-xs">switch</code>,{" "}
        <code className="font-mono text-xs">ps3</code>). Detected on this
        server:{" "}
        {platformFolderNames?.length ? (
          <span className="font-mono text-xs">
            {platformFolderNames.join(", ")}
          </span>
        ) : (
          "none yet — add library roots and scan your library"
        )}
        .
      </p>

      <Input
        placeholder="Search catalog by name, platform, keyword or ID..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm shrink-0"
      />

      {pending ? (
        <LoaderCircleIcon className="animate-spin h-8 w-8 mx-auto" />
      ) : error ? (
        <p className="text-red-500 text-sm">
          Failed to load catalog. Is emulator package support enabled on the
          server?
        </p>
      ) : (
        <ScrollArea className="flex-1 min-h-0 rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Platforms</TableHead>
                <TableHead>NAS install</TableHead>
                <TableHead className="text-end">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCatalog.map((entry) => {
                const installed = installedByCatalogId?.get(entry.catalogId);

                return (
                  <TableRow key={entry.catalogId}>
                    <TableCell>
                      <div className="flex flex-col gap-1 min-h-[2.25rem]">
                        <span className="font-medium line-clamp-1">
                          {entry.displayName}
                        </span>
                        <span className="text-xs text-muted-foreground line-clamp-1">
                          {entry.description || "\u00A0"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm font-mono">
                      {(() => {
                        const plats = entry.supportedPlatformFolderNames;
                        const display =
                          plats.length > 5
                            ? `${plats.slice(0, 4).join(", ")} +${plats.length - 4} more`
                            : plats.join(", ");
                        return (
                          <span
                            className="block truncate max-w-[14ch] lg:max-w-[20ch]"
                            title={plats.join(", ")}
                          >
                            {display}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-h-[2.25rem] overflow-hidden">
                        {installed ? (
                          <Badge variant="default">
                            Installed v{installed.version}
                          </Badge>
                        ) : (
                          <Badge variant="outline">Not installed</Badge>
                        )}
                        {entry.deprecated ? (
                          <Badge variant="destructive">Deprecated</Badge>
                        ) : null}
                        {!entry.installable ? (
                          <Badge variant="secondary">Not installable</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-end">
                      <Button
                        size="sm"
                        disabled={!entry.installable || !!installed}
                        onClick={() => {
                          setSelectedEntry(entry);
                          setInstallOpen(true);
                        }}
                      >
                        {installed ? "Installed" : "Install to NAS"}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {filteredCatalog.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="text-center text-sm text-muted-foreground py-8"
                  >
                    No matching catalog entries.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      )}

      {selectedEntry ? (
        <InstallCatalogDialog
          entry={selectedEntry}
          open={installOpen}
          onOpenChange={(open) => {
            setInstallOpen(open);
            if (!open) {
              setSelectedEntry(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function InstallCatalogDialog(props: {
  entry: EmulatorCatalogEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { entry, open, onOpenChange } = props;
  const clientId = useConfig((s) => s.config?.clientInfo?.id);
  const { data: serverConfig } = useServerConfig({
    selectFn: (data) => data.config,
  });

  const roots = useMemo(
    () => serverConfig?.emulatorPackageDirectories ?? [],
    [serverConfig],
  );
  const [directoryIndex, setDirectoryIndex] = useState(0);
  const [subpath, setSubpath] = useState(entry.catalogId);
  const [writeTestResult, setWriteTestResult] = useState<{
    writable: boolean;
    errorMessage?: string;
  } | null>(null);

  const { mutateAsync: checkWritable, isPending: checkingWritable } =
    useCheckEmulatorPackageDirectoryWritable();
  const { mutateAsync: install, isPending: installing } =
    useInstallCatalogPackage();

  const rootOptions = useMemo(
    () =>
      roots.map((root, index) => ({
        index,
        label: root.path,
      })),
    [roots],
  );

  const runWriteTest = useCallback(async () => {
    setWriteTestResult(null);
    const res = await checkWritable({ directoryIndex });
    setWriteTestResult({
      writable: res.writable,
      errorMessage: res.errorMessage,
    });
  }, [checkWritable, directoryIndex]);

  const handleInstall = useCallback(async () => {
    if (!clientId) {
      return;
    }

    if (!writeTestResult?.writable) {
      await runWriteTest();
      return;
    }

    await install({
      catalogId: entry.catalogId,
      directoryIndex,
      subpath: subpath || entry.catalogId,
      clientId,
      targetOperatingSystem: entry.recommendedOperatingSystem,
    });

    onOpenChange(false);
  }, [
    clientId,
    directoryIndex,
    entry,
    install,
    onOpenChange,
    runWriteTest,
    subpath,
    writeTestResult?.writable,
  ]);

  const noRoots = roots.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install {entry.displayName} to NAS</DialogTitle>
          <DialogDescription>
            Downloads upstream release assets to your configured emulator
            package root. A write test runs before install.
          </DialogDescription>
        </DialogHeader>

        {entry.deprecated ? (
          <div className="flex gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangleIcon className="h-5 w-5 shrink-0 text-amber-600" />
            <p>
              <strong className="font-medium">Deprecated emulator.</strong> This
              entry is unmaintained or superseded. Install and use at your own
              risk — consider Eden or another supported Switch emulator instead.
            </p>
          </div>
        ) : null}

        {entry.legalNotice ? (
          <p className="text-sm text-muted-foreground border rounded-md p-3">
            {entry.legalNotice}
          </p>
        ) : null}

        {noRoots ? (
          <p className="text-sm text-amber-600">
            No emulator package roots configured. Add one in Server
            Configuration → Emulator Roots.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Target root</Label>
              <Select
                value={String(directoryIndex)}
                onValueChange={(value) => {
                  setDirectoryIndex(Number(value));
                  setWriteTestResult(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select root" />
                </SelectTrigger>
                <SelectContent>
                  {rootOptions.map((root) => (
                    <SelectItem key={root.index} value={String(root.index)}>
                      {root.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Subpath (optional)</Label>
              <Input
                value={subpath}
                onChange={(e) => setSubpath(e.target.value)}
                placeholder={entry.catalogId}
              />
              <p className="text-xs text-muted-foreground">
                Installed under{" "}
                <code className="font-mono">
                  {"{root}/"}
                  {subpath || entry.catalogId}
                  {"{/{version}"}
                </code>
              </p>
            </div>

            {entry.recommendedOperatingSystem !== undefined ? (
              <p className="text-sm text-muted-foreground">
                Target OS:{" "}
                {operatingSystemDisplayMap[entry.recommendedOperatingSystem]}
              </p>
            ) : null}

            {writeTestResult ? (
              <p
                className={
                  writeTestResult.writable
                    ? "text-sm text-green-600"
                    : "text-sm text-red-500"
                }
              >
                {writeTestResult.writable
                  ? "Write test passed."
                  : (writeTestResult.errorMessage ??
                    "Target directory is not writable.")}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={noRoots || checkingWritable}
            onClick={() => void runWriteTest()}
          >
            {checkingWritable ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : null}
            Test write access
          </Button>
          <Button
            disabled={noRoots || installing || !clientId}
            onClick={() => void handleInstall()}
          >
            {installing ? <LoaderCircleIcon className="animate-spin" /> : null}
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
