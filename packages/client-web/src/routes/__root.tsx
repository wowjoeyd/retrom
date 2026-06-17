import { createRootRoute, Outlet } from "@tanstack/react-router";
import { zodValidator } from "@tanstack/zod-adapter";
import { ConfigProvider } from "../providers/config";
import { RetromClientProvider } from "../providers/retrom-client";
import { QueryClientProvider } from "../providers/query-client";
import { Prompts } from "../components/prompts";
import { GuideButtonShortcut } from "../components/guide-button-shortcut";
import { z } from "zod";
import { InputDeviceProvider } from "@/providers/input-device";
import { serverConfigTabSchema } from "@/components/modals/config/server";
import { clientConfigTabSchema } from "@/components/modals/config/client";
import { InstallationIndexProvider } from "@/providers/installation-index";
import { InstallationProgressProvider } from "@/providers/installation-progress";
import { useEffect } from "react";

const modalsSearchSchema = z
  .object({
    configModal: z.object({
      open: z.boolean().default(false),
      tab: z.enum(["server", "client"]).default("server"),
      clientTab: clientConfigTabSchema,
      serverTab: serverConfigTabSchema,
    }),
    updateLibraryModal: z.object({
      open: z.boolean().default(false),
    }),
    cleanLibraryModal: z.object({
      open: z.boolean().default(false),
    }),
    matchPlatformsModal: z.object({
      open: z.boolean().default(false),
    }),
    defaultProfilesModal: z.object({
      open: z.boolean().default(false),
    }),
    downloadMetadataModal: z.object({
      open: z.boolean().default(false),
    }),
    deleteLibraryModal: z.object({
      open: z.boolean().default(false),
    }),
    manageEmulatorsModal: z.object({
      open: z.boolean().default(false),
    }),
    manageEmulatorProfilesModal: z.object({
      open: z.boolean().default(false),
    }),
    setupModal: z.object({
      open: z.boolean().default(false),
    }),
    checkForUpdateModal: z.object({
      open: z.boolean().default(false),
    }),
    versionInfoModal: z.object({
      open: z.boolean().default(false),
    }),
    serverFileExplorerModal: z.object({
      open: z.boolean().default(false),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
    confirmModal: z.object({
      open: z.boolean().default(false),
      title: z.string().optional(),
      description: z.string().optional(),
    }),
    deletePlatformModal: z.object({
      open: z.boolean().default(false),
      title: z.string().optional(),
      description: z.string().optional(),
      platform: z.object({
        id: z.number(),
        name: z.string(),
        thirdParty: z.boolean(),
      }),
    }),
    mobileSidebar: z.object({
      open: z.boolean(),
    }),
    mobileMenu: z.object({
      open: z.boolean(),
    }),
    exitModal: z.object({ open: z.boolean() }),
    updatePlatformMetadataModal: z.object({
      open: z.boolean(),
      id: z.number(),
    }),
    batchDownloadMusicModal: z.object({
      open: z.boolean().default(false),
    }),
  })
  .partial();

export const Route = createRootRoute({
  validateSearch: zodValidator(modalsSearchSchema),
  component: RootComponent,
  errorComponent: (opts) => <div>Error: {String(opts.error)}</div>,
});

function RootComponent() {
  // Detect Steam OpenID callback before initialising any Tauri-dependent
  // providers. The WebviewWindow that Steam redirects back to runs this check
  // synchronously; if it matches, we render a minimal component that broadcasts
  // the SteamID64 and closes the window — no plugin calls, no capability errors.
  const params = new URLSearchParams(window.location.search);
  if (params.get("openid.mode") === "id_res") {
    return <SteamOpenIdCallback params={params} />;
  }

  return (
    <InputDeviceProvider>
      <ConfigProvider>
        <RetromClientProvider>
          <QueryClientProvider>
            <InstallationIndexProvider>
              <InstallationProgressProvider>
                <Outlet />

                <GuideButtonShortcut />
                <Prompts />
                {/* <TanStackRouterDevtools /> */}
              </InstallationProgressProvider>
            </InstallationIndexProvider>
          </QueryClientProvider>
        </RetromClientProvider>
      </ConfigProvider>
    </InputDeviceProvider>
  );
}

function SteamOpenIdCallback({ params }: { params: URLSearchParams }) {
  useEffect(() => {
    const claimedId = params.get("openid.claimed_id") ?? "";
    const m = claimedId.match(/\/(\d{17})$/);
    if (m) {
      const channel = new BroadcastChannel("retrom-steam-openid");
      channel.postMessage({ steamId64: m[1] });
      channel.close();
    }
    // Works for browser script-opened popups; in Tauri the parent closes the
    // WebviewWindow via its stored ref after receiving the broadcast.
    window.close();
  }, [params]);

  return (
    <div className="h-screen w-screen grid place-items-center bg-background text-muted-foreground text-sm">
      Signing in with Steam…
    </div>
  );
}
