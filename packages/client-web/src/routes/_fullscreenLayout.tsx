import {
  CatchBoundary,
  createFileRoute,
  Outlet,
  useMatch,
} from "@tanstack/react-router";
import { useRef, useEffect } from "react";
import { FullscreenMenubar } from "../components/fullscreen/menubar";
import { cn } from "@retrom/ui/lib/utils";
import { z } from "zod";
import { GroupContextProvider } from "@/providers/fullscreen/group-context";
import { GamepadProvider } from "@/providers/gamepad";
import {
  init,
  navigateByDirection,
  setKeyMap,
} from "@noriginmedia/norigin-spatial-navigation";
import { useHotkeys } from "@/providers/hotkeys";
import { checkIsDesktop } from "@/lib/env";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { zodValidator } from "@tanstack/zod-adapter";
import { FocusedHotkeyLayerProvider } from "@/providers/hotkeys/layers";
import { configStore } from "@/providers/config";
import { ModalActionProvider } from "@/providers/modal-action";
import { ResolveCloudSaveConflictModal } from "@/components/modals/resolve-cloud-save-conflict";
import { InstallOnPlayModal } from "@/components/modals/install-on-play";
import {
  gameMusicPlayer,
  cancelPendingFocusMusic,
} from "../components/fullscreen/grid-game-list";
import { consumeQuickScrollNav } from "../components/fullscreen/alphabet-scroll-overlay";
import { Background, Scene } from "../components/fullscreen/scene";
import { ActionBarProvider } from "@/providers/fullscreen/action-bar-context";
import { StartupMovie } from "../components/fullscreen/startup-movie";

declare global {
  export interface HotkeyZones {
    "root-navigation": boolean;
  }
}

const searchSchema = z.object({
  activeGroupId: z.number().catch(-1),
  restoreGridFocus: z.boolean().optional().catch(undefined),
  sortBy: z
    .enum([
      "name",
      "lastPlayed",
      "dateAdded",
      "playTime",
      "releaseDate",
      "platform",
    ])
    .catch("name"),
  filters: z
    .array(z.enum(["installed", "notInstalled", "steam", "nonSteam"]))
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/_fullscreenLayout")({
  component: FullscreenLayout,
  validateSearch: zodValidator(searchSchema),
  loader: async () => {
    const { windowedFullscreenMode } =
      configStore.getState()?.config?.interface?.fullscreenConfig ?? {};

    /**
     * On desktop, default to fullscreen window mode unless configured otherwise.
     * On web, default to windowed mode unless explicitly set to fullscreen.
     */
    if (checkIsDesktop()) {
      const win = getCurrentWindow();

      // Make sure the window is visible and un-minimized BEFORE sizing it.
      // unminimize() issues ShowWindow(SW_RESTORE), which would otherwise undo
      // the fullscreen geometry if called afterwards (the window ends up a
      // restored size offset on screen).
      try {
        await win.unminimize();
        await win.show();
      } catch (e) {
        console.error(e);
      }

      if (windowedFullscreenMode !== true) {
        await win.setFullscreen(true);
      }

      // Bring Retrom to the foreground like a launched game — WITHOUT pinning it
      // always-on-top, so other windows can still be brought in front normally.
      // Windows blocks a background process from stealing focus via
      // SetForegroundWindow, so this goes through a native command that uses the
      // AttachThreadInput trick to legitimately take the foreground.
      await invoke("request_foreground").catch(console.error);
    } else if (windowedFullscreenMode === false) {
      await window.document.documentElement
        .requestFullscreen()
        .catch(console.error);
    }

    init({
      // debug: import.meta.env.DEV,
      shouldUseNativeEvents: true,
      distanceCalculationMethod: "center",
      useGetBoundingClientRect: true,
      // visualDebug: true,
    });

    // ununsed, setting to invalid keycode to keep vanilla arrow key behavior
    setKeyMap({
      up: 1000,
      down: 1000,
      left: 1000,
      right: 1000,
      enter: 1000,
    });
  },
});

function FullscreenLayout() {
  const container = useRef<HTMLDivElement>(null);
  const isDetailPage = useMatch({
    from: "/_fullscreenLayout/fullscreen/games/$gameId",
    shouldThrow: false,
  });

  useHotkeys({
    handlers: {
      UP: {
        handler: (e) => {
          if (consumeQuickScrollNav("UP", e)) return;
          navigateByDirection("up", {});
        },
        zone: "root-navigation",
      },
      DOWN: {
        handler: (e) => {
          if (consumeQuickScrollNav("DOWN", e)) return;
          navigateByDirection("down", {});
        },
        zone: "root-navigation",
      },
      LEFT: {
        handler: () => navigateByDirection("left", {}),
        zone: "root-navigation",
      },
      RIGHT: {
        handler: () => navigateByDirection("right", {}),
        zone: "root-navigation",
      },
    },
  });

  // Stop any background music when leaving the entire fullscreen layout
  // (e.g. via Exit fullscreen from game details or anywhere). This ensures
  // theme music from details/hover does not continue into windowed mode.
  useEffect(() => {
    return () => {
      cancelPendingFocusMusic();
      gameMusicPlayer.stop(300);
    };
  }, []);

  return (
    <ModalActionProvider>
      <FocusedHotkeyLayerProvider>
        <GamepadProvider>
          <GroupContextProvider>
            <ActionBarProvider>
              <div
                ref={container}
                className={cn("h-[100dvh] w-screen relative", "flex flex-col")}
              >
                {/* Persistent animated background — lives at layout level so the
                    WebGL canvas never unmounts across grid/detail route transitions,
                    eliminating the shader startup delay on Back to grid.
                    Hidden (but kept alive) on the detail page since it has its own scene. */}
                <div
                  className={cn(
                    "absolute inset-0 -z-[1] pointer-events-none",
                    isDetailPage && "opacity-0",
                  )}
                >
                  <CatchBoundary
                    getResetKey={() => "resetSceneLayout"}
                    onCatch={(error) =>
                      console.warn("Layout background scene error:", error)
                    }
                    errorComponent={() => null}
                  >
                    <Scene>
                      <Background />
                    </Scene>
                  </CatchBoundary>
                </div>

                <FullscreenMenubar className="w-full border-b z-[50] bg-background" />

                <div className="flex flex-col h-full max-h-full overflow-hidden w-full *:overflow-y-auto">
                  <Outlet />
                </div>
              </div>

              <ResolveCloudSaveConflictModal />
              <InstallOnPlayModal />
              <StartupMovie />
            </ActionBarProvider>
          </GroupContextProvider>
        </GamepadProvider>
      </FocusedHotkeyLayerProvider>
    </ModalActionProvider>
  );
}
