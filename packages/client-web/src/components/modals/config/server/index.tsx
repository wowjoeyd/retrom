import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@retrom/ui/components/tabs";
import { ServerConfigJson } from "@retrom/codegen/retrom/server/config_pb";
import { useServerConfig } from "@/queries/useServerConfig";
import { LoaderCircle } from "lucide-react";
import { IgdbConfig } from "./igdb-config";
import { SteamConfig } from "./steam-config";
import { AchievementsConfig } from "./achievements-config";
import { SavesConfig } from "./saves-config";
import { LibrariesConfig } from "./libraries-config";
import { EmulatorPackageRootsConfig } from "./emulator-package-roots-config";
import { CustomCatalogConfig } from "./custom-catalog-config";
import { EmulatorPackagesConfig } from "./emulator-packages-config";
import { TelemetryConfig } from "./telemetry-config";
import { z } from "zod";
import { Route as RootRoute } from "@/routes/__root";
import { MetadataConfig } from "./metadata-config";
import { useEmulatorPackagesAvailable } from "@/queries/useEmulatorPackagesAvailable";
import { isEmulatorPackagesEnabled } from "@/lib/env";

type ServerTabs = Exclude<keyof ServerConfigJson, "connection">;
export const serverConfigTabSchema = z
  .enum([
    "contentDirectories",
    "emulatorPackageDirectories",
    "customCatalogDir",
    "emulatorPackages",
    "igdb",
    "steam",
    "retroAchievements",
    "saves",
    "telemetry",
    "metadata",
  ] as const satisfies ServerTabs[])
  .default("contentDirectories");

const tabItems: Record<ServerTabs, { value: ServerTabs; name: string }> = {
  contentDirectories: {
    value: "contentDirectories",
    name: "Content Directories",
  },
  emulatorPackageDirectories: {
    value: "emulatorPackageDirectories",
    name: "Emulator Roots",
  },
  customCatalogDir: {
    value: "customCatalogDir",
    name: "Custom Catalog",
  },
  emulatorPackages: {
    value: "emulatorPackages",
    name: "Emulator Packages",
  },
  metadata: { value: "metadata", name: "Metadata" },
  igdb: { value: "igdb", name: "IGDB" },
  steam: { value: "steam", name: "Steam" },
  retroAchievements: { value: "retroAchievements", name: "Achievements" },
  saves: { value: "saves", name: "Cloud Saves" },
  telemetry: { value: "telemetry", name: "Telemetry" },
};

const emulatorPackageTabs: ServerTabs[] = [
  "emulatorPackageDirectories",
  "customCatalogDir",
  "emulatorPackages",
];

export function ServerConfigTab() {
  const { data, status } = useServerConfig();
  const tab = RootRoute.useSearch({ select: (s) => s.configModal?.serverTab });
  const { data: packagesAvailable } = useEmulatorPackagesAvailable();

  const showEmulatorPackageTabs =
    isEmulatorPackagesEnabled() && packagesAvailable === true;

  const visibleTabs = Object.values(tabItems).filter(
    ({ value }) =>
      showEmulatorPackageTabs || !emulatorPackageTabs.includes(value),
  );

  function LoadingState() {
    return (
      <div className="grid place-items-center py-8">
        <LoaderCircle className="w-auto h-[6rem] text-muted-foreground animate-spin stroke-1" />
      </div>
    );
  }

  function ErrorState() {
    return (
      <div className="grid place-items-center py-8 text-muted-foreground">
        <p>😔 Error loading server config </p>
      </div>
    );
  }

  return (
    <TabsContent
      value="server"
      className="flex flex-col gap-2 w-full sm:w-fit max-w-full mt-0"
    >
      <DialogHeader>
        <DialogTitle className="text-xl font-extrabold">
          Server Configuration
        </DialogTitle>

        <DialogDescription className="text-pretty max-w-[60ch]">
          This is where you can configure your Retrom server settings. Settings
          here are shared by all clients connected to your server.
        </DialogDescription>
      </DialogHeader>

      {status === "pending" ? (
        <LoadingState />
      ) : status === "error" || !data?.config ? (
        <ErrorState />
      ) : (
        <Tabs
          defaultValue={
            tab && visibleTabs.some((item) => item.value === tab)
              ? tab
              : "contentDirectories"
          }
          className="w-full"
        >
          <TabsList className="w-full">
            {visibleTabs.map(({ value, name }) => (
              <TabsTrigger key={value} value={value} className="w-full text-sm">
                {name}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* <Separator className="mt-4" /> */}

          <LibrariesConfig currentConfig={data.config} />
          {showEmulatorPackageTabs ? (
            <>
              <EmulatorPackageRootsConfig currentConfig={data.config} />
              <CustomCatalogConfig currentConfig={data.config} />
              <EmulatorPackagesConfig currentConfig={data.config} />
            </>
          ) : null}
          <MetadataConfig currentConfig={data.config} />
          <IgdbConfig currentConfig={data.config} />
          <SteamConfig currentConfig={data.config} />
          <AchievementsConfig />
          <SavesConfig currentConfig={data.config} />
          <TelemetryConfig />
        </Tabs>
      )}
    </TabsContent>
  );
}
