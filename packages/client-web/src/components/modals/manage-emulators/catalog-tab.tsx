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
import { EmulatorCatalogEntry } from "@retrom/codegen/retrom/models/emulator-packages_pb";
import { useEmulatorCatalog } from "@/queries/useEmulatorCatalog";
import { useServerConfig } from "@/queries/useServerConfig";
import { useConfig } from "@/providers/config";
import { useCheckEmulatorPackageDirectoryWritable } from "@/mutations/useCheckEmulatorPackageDirectoryWritable";
import { useInstallCatalogPackage } from "@/mutations/useInstallCatalogPackage";
import { LoaderCircleIcon } from "lucide-react";
import { operatingSystemDisplayMap } from "./utils";

export function CatalogTab() {
  const [selectedEntry, setSelectedEntry] =
    useState<EmulatorCatalogEntry | null>(null);
  const [installOpen, setInstallOpen] = useState(false);

  const { data: catalog, status: catalogStatus } = useEmulatorCatalog({
    selectFn: (data) => data.entries,
  });

  const pending = catalogStatus === "pending";
  const error = catalogStatus === "error";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground max-w-[65ch]">
        Browse built-in emulator catalog entries and install packages to your
        NAS. Configure emulator package roots in Server Configuration first.
      </p>

      {pending ? (
        <LoaderCircleIcon className="animate-spin h-8 w-8 mx-auto" />
      ) : error ? (
        <p className="text-red-500 text-sm">
          Failed to load catalog. Is emulator package support enabled on the
          server?
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Platforms</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-end">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {catalog?.map((entry) => (
              <TableRow key={entry.catalogId}>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{entry.displayName}</span>
                    {entry.description ? (
                      <span className="text-xs text-muted-foreground">
                        {entry.description}
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-sm">
                  {entry.supportedPlatformFolderNames.join(", ")}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {entry.deprecated ? (
                      <Badge variant="outline">Deprecated</Badge>
                    ) : null}
                    {!entry.installable ? (
                      <Badge variant="secondary">Not installable</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-end">
                  <Button
                    size="sm"
                    disabled={!entry.installable}
                    onClick={() => {
                      setSelectedEntry(entry);
                      setInstallOpen(true);
                    }}
                  >
                    Install to NAS
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

  const roots = serverConfig?.emulatorPackageDirectories ?? [];
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

        {entry.legalNotice ? (
          <p className="text-sm text-muted-foreground border rounded-md p-3">
            {entry.legalNotice}
          </p>
        ) : null}

        {noRoots ? (
          <p className="text-sm text-amber-600">
            No emulator package roots configured. Add one in Server Configuration
            → Emulator Roots.
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
            {installing ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : null}
            Install
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}