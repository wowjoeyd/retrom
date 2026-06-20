import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetOverlay,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menu-entry-button";
import { ComponentProps, useCallback, useState } from "react";
import {
  Form,
  FormField,
  FormItem,
  FormMessage,
  useForm,
  useFormContext,
} from "@retrom/ui/components/form";
import {
  InterfaceConfig_GameListEntryImage,
  RetromClientConfig_ConfigJson,
} from "@retrom/codegen/retrom/client/client-config_pb";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useConfig, useConfigStore } from "@/providers/config";
import { ConfigInput } from "../config-inputs/input";
import { HotkeyButton } from "../../hotkey-button";
import { ScrollArea } from "@retrom/ui/components/scroll-area";
import { ConfigSelect, ConfigSelectItem } from "../config-inputs/select";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { FocusContainer } from "../../focus-container";
import { ConfigCheckbox } from "../config-inputs/checkbox";
import { Settings } from "lucide-react";
import { PanelHeader, PanelSection } from "../panel-chrome";
import { PANEL_CONTENT_CLASS } from "../menu-sheet";
import { QuitHotkeyRebind } from "./quit-hotkey-rebind";

type FormSchema = z.infer<typeof formSchema>;
const formSchema = z.object({
  interface: z.object({
    fullscreenByDefault: z.boolean(),
    // Which focus cue(s) to show. Shared with the standard settings menu; lives
    // at the interface level so both menus bind to the same value.
    focusIndicator: z.enum(["BOTH", "RETICLE_ONLY", "RINGS_ONLY"]),
    // Shared with the standard settings menu (see general-config.tsx); lives at
    // the interface level, not under fullscreenConfig, so both menus bind to it.
    quitToLibraryHotkeyEnabled: z.boolean().optional(),
    // The rebindable quit-to-library combo (standard-gamepad button indices),
    // also shared with the standard menu. Empty = use the default combo.
    quitToLibraryHotkeyButtons: z.array(z.number()).optional(),
    fullscreenConfig: z.object({
      startupMovieEnabled: z.boolean().optional(),
      doubleTapGuideOpensFullscreen: z.boolean().optional(),
      gridList: z.object({
        columns: z.coerce.number().min(1).max(10),
        gap: z.coerce.number().min(10).max(250),
        imageType: z.enum(["COVER", "BACKGROUND"]),
      }),
      gameMusic: z
        .object({
          enabled: z.boolean().optional(),
          volume: z.coerce.number().min(0).max(1),
          fadeDurationMs: z.coerce.number().min(100).max(5000),
        })
        .optional(),
    }),
  }),
}) satisfies z.ZodSchema<RetromClientConfig_ConfigJson, z.ZodTypeDef, unknown>;

export function Config(props: ComponentProps<typeof SheetTrigger>) {
  const configStore = useConfigStore();
  const config = useConfig((s) => s.config);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const fullscreenConfig = config?.interface?.fullscreenConfig as
    | {
        gameMusic?: {
          enabled?: boolean;
          volume?: number;
          fadeDurationMs?: number;
        };
      }
    | undefined;

  const form = useForm<FormSchema>({
    resolver: zodResolver(formSchema),
    mode: "all",
    reValidateMode: "onChange",
    defaultValues: {
      interface: {
        fullscreenByDefault: config?.interface?.fullscreenByDefault ?? false,
        focusIndicator: config?.interface?.focusIndicator ?? "BOTH",
        quitToLibraryHotkeyEnabled:
          config?.interface?.quitToLibraryHotkeyEnabled ?? true,
        quitToLibraryHotkeyButtons:
          config?.interface?.quitToLibraryHotkeyButtons ?? [],
        fullscreenConfig: {
          startupMovieEnabled:
            config?.interface?.fullscreenConfig?.startupMovieEnabled ?? true,
          doubleTapGuideOpensFullscreen:
            config?.interface?.fullscreenConfig
              ?.doubleTapGuideOpensFullscreen ?? false,
          gridList: {
            columns:
              config?.interface?.fullscreenConfig?.gridList?.columns ?? 4,
            gap: config?.interface?.fullscreenConfig?.gridList?.gap ?? 20,
            imageType:
              config?.interface?.fullscreenConfig?.gridList?.imageType ??
              "COVER",
          },
          gameMusic: {
            enabled: fullscreenConfig?.gameMusic?.enabled ?? true,
            volume: fullscreenConfig?.gameMusic?.volume ?? 0.3,
            fadeDurationMs: fullscreenConfig?.gameMusic?.fadeDurationMs ?? 700,
          },
        },
      },
    },
  });

  const formState = form.formState;
  const { isDirty, isSubmitting } = formState;

  const handleSubmit = useCallback(
    (data: FormSchema) => {
      configStore.setState((state) => ({
        ...state,
        config: {
          ...state.config,
          interface: {
            ...state.config?.interface,
            ...data.interface,
          },
        },
      }));

      toast({
        title: "Configuration updated",
      });

      form.reset(data);
      setOpen(false);
    },
    [configStore, toast, setOpen, form],
  );

  const disabled = isSubmitting || !isDirty;

  return (
    <Sheet
      open={open}
      onOpenChange={(val) => {
        if (val) {
          // Re-initialize form with latest values from the store on every open.
          // This ensures the two config UIs (fullscreen menubar + general config)
          // always see each other's saved changes for the shared gameMusic settings
          // (and other fullscreenConfig values).
          form.reset({
            interface: {
              fullscreenByDefault:
                config?.interface?.fullscreenByDefault ?? false,
              focusIndicator: config?.interface?.focusIndicator ?? "BOTH",
              quitToLibraryHotkeyEnabled:
                config?.interface?.quitToLibraryHotkeyEnabled ?? true,
              quitToLibraryHotkeyButtons:
                config?.interface?.quitToLibraryHotkeyButtons ?? [],
              fullscreenConfig: {
                startupMovieEnabled:
                  config?.interface?.fullscreenConfig?.startupMovieEnabled ??
                  true,
                doubleTapGuideOpensFullscreen:
                  config?.interface?.fullscreenConfig
                    ?.doubleTapGuideOpensFullscreen ?? false,
                gridList: {
                  columns:
                    config?.interface?.fullscreenConfig?.gridList?.columns ?? 4,
                  gap: config?.interface?.fullscreenConfig?.gridList?.gap ?? 20,
                  imageType:
                    config?.interface?.fullscreenConfig?.gridList?.imageType ??
                    "COVER",
                },
                gameMusic: {
                  enabled: fullscreenConfig?.gameMusic?.enabled ?? true,
                  volume: fullscreenConfig?.gameMusic?.volume ?? 0.3,
                  fadeDurationMs:
                    fullscreenConfig?.gameMusic?.fadeDurationMs ?? 700,
                },
              },
            },
          });
        } else {
          form.reset();
        }
        setOpen(val);
      }}
    >
      <SheetTrigger asChild>
        <MenuEntryButton
          id="config-menu-open"
          icon={<Settings size={18} />}
          label="Fullscreen and library display options"
          {...props}
        >
          Configuration
        </MenuEntryButton>
      </SheetTrigger>

      <SheetOverlay className="bg-background/60 backdrop-blur-sm" />
      <SheetContent className={PANEL_CONTENT_CLASS}>
        <HotkeyLayer
          id="config-menu"
          handlers={{
            BACK: { handler: () => setOpen(false) },
            FILTER: { handler: () => form.handleSubmit(handleSubmit)() },
          }}
        >
          <PanelHeader
            icon={<Settings size={20} />}
            title="Configuration"
            subtitle="Fullscreen and library display options"
          />

          <FocusContainer
            className="flex h-full flex-col"
            opts={{
              initialFocus: true,
              focusKey: "config-menu",
              isFocusBoundary: true,
            }}
          >
            <ScrollArea className="h-full w-full">
              <Form {...form}>
                <form
                  onSubmit={form.handleSubmit(handleSubmit)}
                  className="flex h-full flex-col justify-between"
                >
                  <ConfigForm />
                </form>
              </Form>
            </ScrollArea>
          </FocusContainer>

          <SheetFooter className="justify-between gap-3 px-5 py-3">
            <SheetClose asChild>
              <HotkeyButton className="flex-1 justify-center" hotkey="BACK">
                Close
              </HotkeyButton>
            </SheetClose>

            <HotkeyButton
              className="flex-1 justify-center"
              disabled={disabled}
              onClick={form.handleSubmit(handleSubmit)}
              hotkey="FILTER"
            >
              Save
            </HotkeyButton>
          </SheetFooter>
        </HotkeyLayer>
      </SheetContent>
    </Sheet>
  );
}

function ConfigForm() {
  const form = useFormContext<FormSchema>();

  return (
    <div className="flex flex-col gap-5 p-3">
      <PanelSection title="Startup">
        <FormField
          control={form.control}
          name="interface.fullscreenByDefault"
          render={({ field }) => {
            return (
              <FormItem>
                <ConfigCheckbox
                  id="config-menu-fullscreen-default"
                  label="Fullscreen by default"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                >
                  Start Retrom in fullscreen mode
                </ConfigCheckbox>
              </FormItem>
            );
          }}
        />

        <FormField
          control={form.control}
          name="interface.fullscreenConfig.startupMovieEnabled"
          render={({ field }) => (
            <FormItem>
              <ConfigCheckbox
                id="config-menu-startup-movie"
                label="Play startup video"
                checked={field.value ?? true}
                onCheckedChange={field.onChange}
              >
                Play the cinematic intro when entering fullscreen (skipped
                automatically if your system can&apos;t decode it)
              </ConfigCheckbox>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="interface.fullscreenConfig.doubleTapGuideOpensFullscreen"
          render={({ field }) => (
            <FormItem>
              <ConfigCheckbox
                id="config-menu-guide-shortcut"
                label="Double-tap guide opens fullscreen"
                checked={field.value ?? false}
                onCheckedChange={field.onChange}
              >
                Steam Big Picture style: double-tap your controller&apos;s
                guide/home button anywhere to jump into fullscreen
              </ConfigCheckbox>
            </FormItem>
          )}
        />
      </PanelSection>

      <PanelSection title="Controller">
        <FormField
          control={form.control}
          name="interface.quitToLibraryHotkeyEnabled"
          render={({ field }) => (
            <FormItem>
              <ConfigCheckbox
                id="config-menu-quit-hotkey"
                label="Quit to library hotkey"
                checked={field.value ?? true}
                onCheckedChange={field.onChange}
              >
                While a game is running, hold the combo below for ~1.5s to close
                it and return to Retrom (handy for emulators with no in-game
                quit)
              </ConfigCheckbox>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="interface.quitToLibraryHotkeyButtons"
          render={({ field }) => (
            <FormItem>
              <QuitHotkeyRebind
                id="config-menu-quit-combo"
                value={field.value ?? []}
                onChange={field.onChange}
              />
            </FormItem>
          )}
        />
      </PanelSection>

      <PanelSection title="Game List">
        <FormField
          control={form.control}
          name="interface.fullscreenConfig.gridList.columns"
          render={({ field }) => (
            <FormItem>
              <ConfigInput
                id="config-menu-columns"
                {...field}
                type="number"
                label="Columns"
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="interface.fullscreenConfig.gridList.gap"
          render={({ field }) => (
            <FormItem>
              <ConfigInput
                id="config-menu-gap"
                {...field}
                type="number"
                label="Gap"
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="interface.fullscreenConfig.gridList.imageType"
          render={({ field }) => (
            <FormItem>
              <ConfigSelect
                onValueChange={(value) => field.onChange(value)}
                defaultValue={field.value.toString()}
                triggerProps={{
                  label: "Image Type",
                  id: "config-image-type",
                }}
              >
                <ConfigSelectItem
                  id={`config-image-type-${InterfaceConfig_GameListEntryImage.COVER}`}
                  value={"COVER"}
                >
                  Cover
                </ConfigSelectItem>
                <ConfigSelectItem
                  id={`config-image-type-${InterfaceConfig_GameListEntryImage.BACKGROUND}`}
                  value={"BACKGROUND"}
                >
                  Background
                </ConfigSelectItem>
              </ConfigSelect>

              <FormMessage />
            </FormItem>
          )}
        />
      </PanelSection>

      <PanelSection title="Focus Indicator">
        <FormField
          control={form.control}
          name="interface.focusIndicator"
          render={({ field }) => (
            <FormItem>
              <ConfigSelect
                onValueChange={(value) => field.onChange(value)}
                defaultValue={field.value}
                triggerProps={{
                  label: "Focus indicator",
                  id: "config-focus-indicator",
                }}
              >
                <ConfigSelectItem
                  id="config-focus-indicator-BOTH"
                  value="BOTH"
                >
                  Reticle + Rings
                </ConfigSelectItem>
                <ConfigSelectItem
                  id="config-focus-indicator-RETICLE_ONLY"
                  value="RETICLE_ONLY"
                >
                  Reticle only
                </ConfigSelectItem>
                <ConfigSelectItem
                  id="config-focus-indicator-RINGS_ONLY"
                  value="RINGS_ONLY"
                >
                  Rings only
                </ConfigSelectItem>
              </ConfigSelect>

              <FormMessage />
            </FormItem>
          )}
        />
      </PanelSection>

      {/* Game music / theme song controls for fullscreen hover/click playback */}
      <PanelSection title="Theme Music">
        <FormField
          control={form.control}
          name="interface.fullscreenConfig.gameMusic.enabled"
          render={({ field }) => (
            <FormItem>
              <ConfigCheckbox
                checked={field.value}
                onCheckedChange={field.onChange}
                label="Play game music on focus/hover"
              >
                Play main theme / song while hovering or selecting a game (fades
                in/out)
              </ConfigCheckbox>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="interface.fullscreenConfig.gameMusic.volume"
          render={({ field }) => (
            <FormItem>
              <ConfigInput
                id="config-menu-game-music-volume"
                type="number"
                step="0.05"
                min="0"
                max="1"
                label="Music volume"
                {...field}
                onChange={(e) => field.onChange(parseFloat(e.target.value))}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="interface.fullscreenConfig.gameMusic.fadeDurationMs"
          render={({ field }) => (
            <FormItem>
              <ConfigInput
                id="config-menu-game-music-fade"
                type="number"
                step="50"
                min="100"
                max="5000"
                label="Fade duration (ms)"
                {...field}
              />
              <FormMessage />
            </FormItem>
          )}
        />
      </PanelSection>
    </div>
  );
}
