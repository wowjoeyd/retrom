import { Button } from "@retrom/ui/components/button";
import { Checkbox } from "@retrom/ui/components/checkbox";
import { DialogFooter } from "@retrom/ui/components/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@retrom/ui/components/form";
import { Input } from "@retrom/ui/components/input";
import { TabsContent } from "@retrom/ui/components/tabs";
import { useToast } from "@retrom/ui/hooks/use-toast";
import {
  checkIsDesktop,
  isEmulatorPackageSyncEnabled,
  isEnhancedEmulatorUserDataEnabled,
} from "@/lib/env";
import { InferSchema } from "@/lib/utils";
import { cn } from "@retrom/ui/lib/utils";
import { useConfigStore } from "@/providers/config";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpenIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "@retrom/ui/components/form";
import { migrateInstallationDir } from "@retrom/plugin-installer";
import { z } from "zod";
import { RetromClientConfig } from "@retrom/codegen/retrom/client/client-config_pb";
import { RawMessage } from "@/utils/protos";
import {
  emulatorUserDataAutoSyncEnabled,
  setEmulatorUserDataAutoSyncEnabled,
} from "@/components/emulator-user-data-auto-sync";
import { QuitHotkeyRebind } from "./quit-hotkey-rebind";

type ConfigSchema = z.infer<typeof configSchema>;
const configSchema = z.object({
  config: z.object({
    interface: z.object({
      fullscreenByDefault: z.boolean(),
      // Shared with the fullscreen settings menu (see menubar/config); lives at
      // the interface level so both menus bind to the same value.
      quitToLibraryHotkeyEnabled: z.boolean().optional(),
      // The rebindable quit-to-library combo (standard-gamepad button indices),
      // also shared with the fullscreen menu. Empty = use the default combo.
      // Non-optional (proto3 repeated has no presence) — defaults to [].
      quitToLibraryHotkeyButtons: z.array(z.number()),
      fullscreenConfig: z.object({
        windowedFullscreenMode: z.boolean().optional(),
        startupMovieEnabled: z.boolean().optional(),
        doubleTapGuideOpensFullscreen: z.boolean().optional(),
        gameMusic: z
          .object({
            enabled: z.boolean().optional(),
            volume: z.number().optional(),
            fadeDurationMs: z.number().optional(),
          })
          .optional(),
      }),
    }),
    installationDir: z.string().optional(),
    emulatorCacheDir: z.string().optional(),
  }),
  telemetry: z.object({
    enabled: z.boolean(),
  }),
}) satisfies InferSchema<
  Pick<RawMessage<RetromClientConfig>, "config" | "telemetry">
>;

export function GeneralConfig() {
  const navigate = useNavigate();
  const configStore = useConfigStore();
  const { config, telemetry } = configStore();
  const { toast } = useToast();
  const [autoSyncUserData, setAutoSyncUserData] = useState(false);
  const fullscreenConfig = config?.interface?.fullscreenConfig as
    | {
        gameMusic?: {
          enabled?: boolean;
          volume?: number;
          fadeDurationMs?: number;
        };
      }
    | undefined;
  const showEmulatorUserDataAutoSync =
    checkIsDesktop() &&
    isEmulatorPackageSyncEnabled() &&
    isEnhancedEmulatorUserDataEnabled();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAutoSyncUserData(emulatorUserDataAutoSyncEnabled());
  }, []);

  const form = useForm<ConfigSchema>({
    resolver: zodResolver(configSchema),
    defaultValues: {
      config: {
        interface: {
          fullscreenByDefault: config?.interface?.fullscreenByDefault ?? false,
          quitToLibraryHotkeyEnabled:
            config?.interface?.quitToLibraryHotkeyEnabled ?? true,
          quitToLibraryHotkeyButtons:
            config?.interface?.quitToLibraryHotkeyButtons ?? [],
          fullscreenConfig: {
            ...config?.interface?.fullscreenConfig,
            windowedFullscreenMode:
              config?.interface?.fullscreenConfig?.windowedFullscreenMode ??
              !checkIsDesktop(),
            startupMovieEnabled:
              config?.interface?.fullscreenConfig?.startupMovieEnabled ?? true,
            doubleTapGuideOpensFullscreen:
              config?.interface?.fullscreenConfig
                ?.doubleTapGuideOpensFullscreen ?? false,
            gameMusic: {
              enabled: fullscreenConfig?.gameMusic?.enabled ?? true,
              volume: fullscreenConfig?.gameMusic?.volume ?? 0.3,
              fadeDurationMs:
                fullscreenConfig?.gameMusic?.fadeDurationMs ?? 700,
            },
          },
        },
        installationDir: config?.installationDir ?? "",
        emulatorCacheDir: config?.emulatorCacheDir ?? "",
      },
      telemetry: {
        enabled: telemetry?.enabled ?? false,
      },
    },
  });

  const handleSubmit = useCallback(
    async (values: ConfigSchema) => {
      if (
        checkIsDesktop() &&
        values.config.installationDir &&
        values.config.installationDir !== config?.installationDir
      ) {
        try {
          await migrateInstallationDir(values.config.installationDir);
        } catch (e) {
          toast({
            title: "Failed to migrate installation directory",
            description:
              "An error occurred while migrating the installation directory. " +
              "Please check both the old and new directories to ensure your installations are not lost",
            variant: "destructive",
          });

          toast({
            title: "Failed to update config",
            description: String(e),
            variant: "destructive",
          });

          form.reset();
          return;
        }
      }

      configStore.setState((s) => {
        s.config = {
          ...s.config,
          interface: {
            ...s.config?.interface,
            ...values.config.interface,
          },
          installationDir: values.config.installationDir,
          emulatorCacheDir: values.config.emulatorCacheDir?.trim()
            ? values.config.emulatorCacheDir.trim()
            : undefined,
        };

        s.telemetry = {
          ...s.telemetry,
          enabled: values.telemetry.enabled,
        };

        return s;
      });

      form.reset(values);
    },
    [configStore, form, config, toast],
  );

  const dirty = form.formState.isDirty;

  return (
    <TabsContent value="general" className="mt-4">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex flex-col gap-6"
        >
          <FormField
            control={form.control}
            disabled={!checkIsDesktop()}
            name="config.installationDir"
            render={({ field, fieldState: { isDirty } }) => (
              <FormItem className={cn(!checkIsDesktop() && "hidden")}>
                <FormLabel>Installation Directory</FormLabel>

                <div className={cn("flex items-center gap-2")}>
                  <Button
                    size="icon"
                    variant="secondary"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();

                      open({
                        title: "Select Installation Directory",
                        multiple: false,
                        directory: true,
                        defaultPath: field.value,
                      })
                        .then((result) => {
                          if (result) {
                            field.onChange(result);
                          }
                        })
                        .catch((e) => {
                          console.error(e);
                        });
                    }}
                  >
                    <FolderOpenIcon className="w-[1rem] h-[1rem]" />
                  </Button>
                  <FormControl>
                    <Input
                      type="text"
                      {...field}
                      className={cn(!isDirty && "text-muted-foreground")}
                    />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            disabled={!checkIsDesktop()}
            name="config.emulatorCacheDir"
            render={({ field, fieldState: { isDirty } }) => (
              <FormItem className={cn(!checkIsDesktop() && "hidden")}>
                <FormLabel>Emulator Cache Directory</FormLabel>

                <div className={cn("flex items-center gap-2")}>
                  <Button
                    size="icon"
                    variant="secondary"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();

                      open({
                        title: "Select Emulator Cache Directory",
                        multiple: false,
                        directory: true,
                        defaultPath: field.value,
                      })
                        .then((result) => {
                          if (result) {
                            field.onChange(result);
                          }
                        })
                        .catch((e) => {
                          console.error(e);
                        });
                    }}
                  >
                    <FolderOpenIcon className="w-[1rem] h-[1rem]" />
                  </Button>
                  <FormControl>
                    <Input
                      type="text"
                      {...field}
                      placeholder="Defaults to app data / emulator-cache"
                      className={cn(!isDirty && "text-muted-foreground")}
                    />
                  </FormControl>
                </div>

                <p className="text-sm text-muted-foreground max-w-[45ch]">
                  Local copy of managed emulator packages synced from your
                  server before launch. Leave empty to use the default location.
                </p>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="config.interface.fullscreenByDefault"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <div className="flex items-top gap-2">
                    <Checkbox
                      id="fullscreen-by-default"
                      checked={field.value}
                      onCheckedChange={(val) => field.onChange(val)}
                    />
                    <div className={cn("grid gap-1 leading-none")}>
                      <label htmlFor="fullscreen-by-default">
                        Fullscreen by default
                      </label>

                      <p className="text-sm text-muted-foreground">
                        Enabling this will make Retrom launch in fullscreen mode
                        by default
                      </p>
                    </div>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          {showEmulatorUserDataAutoSync ? (
            <FormItem>
              <FormControl>
                <div className="flex items-top gap-2">
                  <Checkbox
                    id="emulator-user-data-auto-sync"
                    checked={autoSyncUserData}
                    onCheckedChange={(val) => {
                      const enabled = val === true;
                      setAutoSyncUserData(enabled);
                      setEmulatorUserDataAutoSyncEnabled(enabled);
                    }}
                  />
                  <div className={cn("grid gap-1 leading-none")}>
                    <label htmlFor="emulator-user-data-auto-sync">
                      Sync emulator user data on app start
                    </label>

                    <p className="text-sm text-muted-foreground max-w-[45ch]">
                      Low-frequency background push for managed emulator
                      firmware, keys, RAPs, and installed emulator-side content.
                    </p>
                  </div>
                </div>
              </FormControl>
            </FormItem>
          ) : null}

          <FormField
            control={form.control}
            name="config.interface.fullscreenConfig.windowedFullscreenMode"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <div className="flex items-top gap-2">
                    <Checkbox
                      id="windowed-fullscreen-mode"
                      checked={field.value}
                      onCheckedChange={(val) => field.onChange(val)}
                    />
                    <div className={cn("grid gap-1 leading-none")}>
                      <label htmlFor="windowed-fullscreen-mode">
                        Windowed fullscreen mode
                      </label>

                      <p className="text-sm text-muted-foreground max-w-[45ch]">
                        Enabling this will keep the application in a
                        non-fullscreen window even when using Fullscreen Mode
                      </p>
                    </div>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="config.interface.fullscreenConfig.startupMovieEnabled"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <div className="flex items-top gap-2">
                    <Checkbox
                      id="startup-movie-enabled"
                      checked={field.value ?? true}
                      onCheckedChange={(val) => field.onChange(val)}
                    />
                    <div className={cn("grid gap-1 leading-none")}>
                      <label htmlFor="startup-movie-enabled">
                        Play startup video
                      </label>

                      <p className="text-sm text-muted-foreground max-w-[45ch]">
                        Play the cinematic intro when entering fullscreen mode.
                        Skipped automatically on systems that can&apos;t decode
                        it.
                      </p>
                    </div>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="config.interface.fullscreenConfig.doubleTapGuideOpensFullscreen"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <div className="flex items-top gap-2">
                    <Checkbox
                      id="double-tap-guide-fullscreen"
                      checked={field.value ?? false}
                      onCheckedChange={(val) => field.onChange(val)}
                    />
                    <div className={cn("grid gap-1 leading-none")}>
                      <label htmlFor="double-tap-guide-fullscreen">
                        Double-tap guide opens fullscreen
                      </label>

                      <p className="text-sm text-muted-foreground max-w-[45ch]">
                        Steam Big Picture style: double-tap your
                        controller&apos;s guide/home button anywhere to jump
                        into fullscreen mode.
                      </p>
                    </div>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="config.interface.quitToLibraryHotkeyEnabled"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <div className="flex items-top gap-2">
                    <Checkbox
                      id="quit-to-library-hotkey"
                      checked={field.value ?? true}
                      onCheckedChange={(val) => field.onChange(val)}
                    />
                    <div className={cn("grid gap-1 leading-none")}>
                      <label htmlFor="quit-to-library-hotkey">
                        Quit to library hotkey
                      </label>

                      <p className="text-sm text-muted-foreground max-w-[45ch]">
                        While a game is running, hold the combo below for ~1.5
                        seconds to close it and return to Retrom. Useful for
                        emulators with no in-game quit.
                      </p>
                    </div>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="config.interface.quitToLibraryHotkeyButtons"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <QuitHotkeyRebind
                    value={field.value ?? []}
                    onChange={field.onChange}
                  />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="telemetry.enabled"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <div className="flex items-top gap-2">
                    <Checkbox
                      id="telemetry-enabled"
                      checked={field.value}
                      onCheckedChange={(val) => field.onChange(val)}
                    />
                    <div className={cn("grid gap-1 leading-none")}>
                      <label htmlFor="telemetry-enabled">
                        Enable Telemetry
                        <span className="text-xs text-muted-foreground ml-1">
                          (requires restart)
                        </span>
                      </label>

                      <p className="text-sm text-muted-foreground max-w-[45ch]">
                        Send anonymous usage data such as performance metrics
                        and errors to help improve Retrom
                      </p>
                    </div>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          {/* Fullscreen game theme / soundtrack music options (tied to yt-dlp extraction and grid hover/click + detail playback) */}
          <FormField
            control={form.control}
            name="config.interface.fullscreenConfig.gameMusic.enabled"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <div className="flex items-top gap-2">
                    <Checkbox
                      id="fullscreen-game-music-enabled"
                      checked={field.value}
                      onCheckedChange={(val) => field.onChange(val)}
                    />
                    <div className={cn("grid gap-1 leading-none")}>
                      <label htmlFor="fullscreen-game-music-enabled">
                        Play game music on focus/hover
                      </label>

                      <p className="text-sm text-muted-foreground">
                        Play a game&apos;s main theme when selecting or hovering
                        it in fullscreen (loops the extracted soundtrack or
                        uploaded audio).
                      </p>
                    </div>
                  </div>
                </FormControl>
              </FormItem>
            )}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="config.interface.fullscreenConfig.gameMusic.volume"
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="fullscreen-game-music-volume">
                    Music volume (0-1)
                  </FormLabel>
                  <FormControl>
                    <Input
                      id="fullscreen-game-music-volume"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      {...field}
                      onChange={(e) =>
                        field.onChange(parseFloat(e.target.value))
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="config.interface.fullscreenConfig.gameMusic.fadeDurationMs"
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor="fullscreen-game-music-fade">
                    Fade in/out duration (ms)
                  </FormLabel>
                  <FormControl>
                    <Input
                      id="fullscreen-game-music-fade"
                      type="number"
                      step="50"
                      min="100"
                      max="5000"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button
              onClick={() =>
                navigate({
                  to: ".",
                  search: (prev) => ({ ...prev, configModal: undefined }),
                }).catch(console.error)
              }
              variant="secondary"
            >
              Close
            </Button>

            <Button onClick={form.handleSubmit(handleSubmit)} disabled={!dirty}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </TabsContent>
  );
}
