import { useCallback, useMemo, useState } from "react";
import { Badge } from "@retrom/ui/components/badge";
import { Button } from "@retrom/ui/components/button";
import { Checkbox } from "@retrom/ui/components/checkbox";
import { Input } from "@retrom/ui/components/input";
import { Label } from "@retrom/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@retrom/ui/components/select";
import { usePlatforms } from "@/queries/usePlatforms";
import { useServerConfig } from "@/queries/useServerConfig";
import { useConfig } from "@/providers/config";
import { useCheckEmulatorPackageDirectoryWritable } from "@/mutations/useCheckEmulatorPackageDirectoryWritable";
import { useInstallCustomCatalogPackage } from "@/mutations/useInstallCustomCatalogPackage";
import { ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import { platformFolderBasename } from "./platform-folder-utils";
import {
  ARCHIVE_TYPES,
  ArchiveType,
  archiveTypeLabel,
  inferArchiveTypeFromUrl,
} from "./infer-archive-type";
import { cn } from "@retrom/ui/lib/utils";

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function CustomEmulatorTab() {
  const clientId = useConfig((s) => s.config?.clientInfo?.id);
  const { data: serverConfig } = useServerConfig({
    selectFn: (data) => data.config,
  });

  const { data: platforms } = usePlatforms({
    selectFn: (data) =>
      data.platforms
        .filter((platform) => !platform.thirdParty)
        .map((platform) => ({
          id: platform.id,
          folderName: platformFolderBasename(platform.path),
          path: platform.path,
        })),
  });

  const roots = serverConfig?.emulatorPackageDirectories ?? [];
  const customCatalogDir = serverConfig?.customCatalogDir;

  const [displayName, setDisplayName] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [executablePath, setExecutablePath] = useState("");
  const [extensions, setExtensions] = useState("");
  const [customArgs, setCustomArgs] = useState("{file}");
  const [archiveType, setArchiveType] = useState<ArchiveType>("zip");
  const [archiveTypeTouched, setArchiveTypeTouched] = useState(false);
  const [selectedPlatformFolders, setSelectedPlatformFolders] = useState<
    string[]
  >([]);
  const [customPlatformFolder, setCustomPlatformFolder] = useState("");
  const [directoryIndex, setDirectoryIndex] = useState(0);
  const [subpath, setSubpath] = useState("");
  const [subpathTouched, setSubpathTouched] = useState(false);
  const [catalogIdOverride, setCatalogIdOverride] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saveToCatalog, setSaveToCatalog] = useState(true);
  const [writeTestResult, setWriteTestResult] = useState<{
    writable: boolean;
    errorMessage?: string;
  } | null>(null);

  const { mutateAsync: checkWritable, isPending: checkingWritable } =
    useCheckEmulatorPackageDirectoryWritable();
  const { mutateAsync: install, isPending: installing } =
    useInstallCustomCatalogPackage();

  const autoCatalogId = useMemo(() => slugFromName(displayName), [displayName]);

  const inferredArchiveType = useMemo(
    () => inferArchiveTypeFromUrl(downloadUrl),
    [downloadUrl],
  );

  const effectiveArchiveType = archiveTypeTouched
    ? archiveType
    : (inferredArchiveType ?? archiveType);

  const platformFolderNames = useMemo(() => {
    const names = new Set(selectedPlatformFolders);
    const custom = customPlatformFolder.trim().toLowerCase();
    if (custom) {
      names.add(custom);
    }
    return Array.from(names);
  }, [customPlatformFolder, selectedPlatformFolders]);

  const togglePlatformFolder = useCallback((folderName: string) => {
    setSelectedPlatformFolders((current) =>
      current.includes(folderName)
        ? current.filter((name) => name !== folderName)
        : [...current, folderName],
    );
  }, []);

  const handleDownloadUrlChange = useCallback((url: string) => {
    setDownloadUrl(url);
    const inferred = inferArchiveTypeFromUrl(url);
    if (inferred) {
      setArchiveType(inferred);
      setArchiveTypeTouched(false);
    }
  }, []);

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

    const resolvedCatalogId = (catalogIdOverride || autoCatalogId).trim();
    const resolvedSubpath = (
      subpathTouched ? subpath : resolvedCatalogId
    ).trim();

    if (!resolvedCatalogId || !displayName.trim() || !downloadUrl.trim()) {
      return;
    }

    if (!executablePath.trim() || platformFolderNames.length === 0) {
      return;
    }

    if (!writeTestResult?.writable) {
      await runWriteTest();
      return;
    }

    await install({
      catalogId: resolvedCatalogId,
      displayName: displayName.trim(),
      downloadUrl: downloadUrl.trim(),
      supportedPlatformFolderNames: platformFolderNames,
      executableRelativePath: executablePath.trim(),
      supportedExtensions: extensions
        .split(",")
        .map((ext) => ext.trim())
        .filter(Boolean),
      archiveType: effectiveArchiveType,
      directoryIndex,
      subpath: resolvedSubpath,
      clientId,
      saveToCustomCatalog: saveToCatalog,
      customArgs: customArgs
        .split(",")
        .map((arg) => arg.trim())
        .filter(Boolean),
    });
  }, [
    autoCatalogId,
    catalogIdOverride,
    clientId,
    customArgs,
    displayName,
    directoryIndex,
    downloadUrl,
    effectiveArchiveType,
    executablePath,
    extensions,
    install,
    platformFolderNames,
    runWriteTest,
    saveToCatalog,
    subpath,
    subpathTouched,
    writeTestResult?.writable,
  ]);

  const noRoots = roots.length === 0;
  const canSubmit =
    !!clientId &&
    !noRoots &&
    displayName.trim() &&
    downloadUrl.trim() &&
    executablePath.trim() &&
    platformFolderNames.length > 0;

  return (
    <div className="flex flex-col gap-4 min-w-0 max-w-2xl">
      <p className="text-sm text-muted-foreground">
        Paste a direct download link to an emulator archive (ZIP, 7z, etc.).
        Retrom downloads it to your NAS, extracts it, and wires up play for the
        platform folders you select below.
      </p>

      {!customCatalogDir ? (
        <p className="text-sm text-amber-600 border rounded-md p-3">
          Set a <strong>Custom Catalog Directory</strong> in Server
          Configuration to save this entry for reuse. Install still works
          without it if you uncheck &quot;Save for reuse&quot; below.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground font-mono break-all">
          Custom catalog: {customCatalogDir}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label>Emulator name</Label>
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Dolphin"
          />
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label>Download URL</Label>
          <Input
            value={downloadUrl}
            onChange={(e) => handleDownloadUrlChange(e.target.value)}
            placeholder="https://example.com/emulator.zip"
          />
          {inferredArchiveType ? (
            <p className="text-xs text-muted-foreground">
              Detected format: {archiveTypeLabel(inferredArchiveType)}
            </p>
          ) : downloadUrl.trim() ? (
            <p className="text-xs text-amber-600">
              Could not detect archive type from the URL — set it under
              Advanced.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:col-span-2">
          <Label>Main executable (inside the archive)</Label>
          <Input
            value={executablePath}
            onChange={(e) => setExecutablePath(e.target.value)}
            placeholder="eden.exe"
          />
          <p className="text-xs text-muted-foreground">
            Path to the .exe inside the downloaded archive, e.g.{" "}
            <code className="font-mono">PPSSPPWindows64.exe</code> or{" "}
            <code className="font-mono">flycast.exe</code>. Open the zip in
            Explorer first if you are unsure.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>ROM file extensions</Label>
          <Input
            value={extensions}
            onChange={(e) => setExtensions(e.target.value)}
            placeholder="iso, cso, elf"
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated, without dots.
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label>Launch arguments</Label>
          <Input
            value={customArgs}
            onChange={(e) => setCustomArgs(e.target.value)}
            placeholder="{file}"
          />
          <p className="text-xs text-muted-foreground">
            Use <code className="font-mono">{"{file}"}</code> where the ROM path
            goes. Comma-separate multiple args.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Which ROM folders does this emulator play?</Label>
        {platforms?.length ? (
          <div className="flex flex-wrap gap-2">
            {platforms.map((platform) => (
              <label
                key={platform.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={selectedPlatformFolders.includes(
                    platform.folderName,
                  )}
                  onCheckedChange={() =>
                    togglePlatformFolder(platform.folderName)
                  }
                />
                <span className="font-mono">{platform.folderName}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            No platforms detected yet. Scan your library or add a folder name
            below.
          </p>
        )}

        <div className="flex flex-col gap-2 mt-2">
          <Label>Other folder name</Label>
          <Input
            value={customPlatformFolder}
            onChange={(e) => setCustomPlatformFolder(e.target.value)}
            placeholder="psp"
          />
          <p className="text-xs text-muted-foreground">
            Must match the folder under your ROM root, e.g.{" "}
            <code className="font-mono">E:\ROMS\psp\</code>
          </p>
        </div>

        {platformFolderNames.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {platformFolderNames.map((name) => (
              <Badge key={name} variant="secondary" className="font-mono">
                {name}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      {noRoots ? (
        <p className="text-sm text-amber-600">
          Configure emulator package roots in Server Configuration first.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Label>Install location</Label>
          <Select
            value={String(directoryIndex)}
            onValueChange={(value) => {
              setDirectoryIndex(Number(value));
              setWriteTestResult(null);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roots.map((root, index) => (
                <SelectItem key={index} value={String(index)}>
                  {root.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {autoCatalogId ? (
            <p className="text-xs text-muted-foreground">
              Files will be installed to{" "}
              <code className="font-mono break-all">
                {roots[directoryIndex]?.path}\
                {subpathTouched ? subpath : autoCatalogId}
              </code>
            </p>
          ) : null}
        </div>
      )}

      <button
        type="button"
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setShowAdvanced((open) => !open)}
      >
        <ChevronDownIcon
          className={cn(
            "size-4 transition-transform",
            showAdvanced && "rotate-180",
          )}
        />
        Advanced options
      </button>

      {showAdvanced ? (
        <div className="grid gap-4 sm:grid-cols-2 rounded-lg border p-4 bg-card/40">
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label>Catalog ID</Label>
            <Input
              value={catalogIdOverride}
              onChange={(e) => setCatalogIdOverride(e.target.value)}
              placeholder={autoCatalogId || "my-emulator"}
            />
            <p className="text-xs text-muted-foreground">
              Internal identifier and default NAS subfolder. Auto-generated from
              the name ({autoCatalogId || "—"}). Only change this if you need a
              specific id or already have a folder with that name on the NAS.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>Archive type</Label>
            <Select
              value={effectiveArchiveType}
              onValueChange={(value) => {
                setArchiveType(value as ArchiveType);
                setArchiveTypeTouched(true);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ARCHIVE_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {archiveTypeLabel(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              How Retrom unpacks the download. Usually detected from the URL
              extension.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>NAS subpath</Label>
            <Input
              value={subpathTouched ? subpath : autoCatalogId}
              onChange={(e) => {
                setSubpath(e.target.value);
                setSubpathTouched(true);
              }}
              placeholder={autoCatalogId || "my-emulator"}
            />
            <p className="text-xs text-muted-foreground">
              Folder name under the install root. Defaults to the catalog ID.
            </p>
          </div>
        </div>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={saveToCatalog}
          onCheckedChange={(checked) => setSaveToCatalog(checked === true)}
        />
        Save for reuse in custom catalog
      </label>

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

      <div className="flex flex-wrap gap-2">
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
          disabled={!canSubmit || installing}
          onClick={() => void handleInstall()}
        >
          {installing ? <LoaderCircleIcon className="animate-spin" /> : null}
          Install custom emulator
        </Button>
      </div>
    </div>
  );
}
