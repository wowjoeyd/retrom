import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
  SheetTrigger,
} from "@retrom/ui/components/sheet";
import { MenuEntryButton } from "../menu-entry-button";
import { ComponentProps, useCallback, useState } from "react";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
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
import { Separator } from "@retrom/ui/components/separator";

type FormSchema = z.infer<typeof formSchema>;
const formSchema = z.object({
  interface: z.object({
    fullscreenByDefault: z.boolean(),
    fullscreenConfig: z.object({
      gridList: z.object({
        columns: z.coerce.number().min(1).max(10),
        gap: z.coerce.number().min(10).max(250),
        imageType: z.enum(["COVER", "BACKGROUND"]),
      }),
      gameMusic: z.object({
        enabled: z.boolean().optional(),
        volume: z.coerce.number().min(0).max(1),
        fadeDurationMs: z.coerce.number().min(100).max(5000),
      }).optional(),
    }),
  }),
}) satisfies z.ZodSchema<RetromClientConfig_ConfigJson, z.ZodTypeDef, unknown>;

export function Config(props: ComponentProps<typeof SheetTrigger>) {
  const configStore = useConfigStore();
  const config = useConfig((s) => s.config);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const fullscreenConfig = config?.interface?.fullscreenConfig as any;

  const form = useForm<FormSchema>({
    resolver: zodResolver(formSchema),
    mode: "all",
    reValidateMode: "onChange",
    defaultValues: {
      interface: {
        fullscreenByDefault: config?.interface?.fullscreenByDefault ?? false,
        fullscreenConfig: {
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
            volume: (fullscreenConfig?.gameMusic?.volume ?? 0.3) as number,
            fadeDurationMs: (fullscreenConfig?.gameMusic?.fadeDurationMs ?? 700) as number,
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
              fullscreenByDefault: config?.interface?.fullscreenByDefault ?? false,
              fullscreenConfig: {
                gridList: {
                  columns:
                    config?.interface?.fullscreenConfig?.gridList?.columns ?? 4,
                  gap: config?.interface?.fullscreenConfig?.gridList?.gap ?? 20,
                  imageType:
                    config?.interface?.fullscreenConfig?.gridList?.imageType ??
                    "COVER",
                },
                gameMusic: {
                  enabled:
                    fullscreenConfig?.gameMusic?.enabled ?? true,
                  volume: (fullscreenConfig?.gameMusic?.volume ?? 0.3) as number,
                  fadeDurationMs: (fullscreenConfig?.gameMusic?.fadeDurationMs ?? 700) as number,
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
        <MenuEntryButton id="config-menu-open" {...props}>
          Config
        </MenuEntryButton>
      </SheetTrigger>

      <SheetOverlay />
      <SheetContent>
        <HotkeyLayer
          id="config-menu"
          handlers={{
            BACK: { handler: () => setOpen(false) },
            MENU: { handler: () => form.handleSubmit(handleSubmit)() },
          }}
        >
          <SheetHeader>
            <SheetTitle>Configuration</SheetTitle>
            <SheetDescription>Retrom fullscreen options</SheetDescription>
          </SheetHeader>

          <Separator className="w-[90%] mx-auto" />

          <FocusContainer
            className="flex flex-col h-full"
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
                  className="flex flex-col justify-between h-full"
                >
                  <ConfigForm />
                </form>
              </Form>
            </ScrollArea>
          </FocusContainer>

          <SheetFooter className="px-2 flex justify-between">
            <SheetClose asChild>
              <HotkeyButton hotkey="BACK">back</HotkeyButton>
            </SheetClose>

            <HotkeyButton
              disabled={disabled}
              onClick={form.handleSubmit(handleSubmit)}
              hotkey="MENU"
            >
              confirm
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
    <div className="flex flex-col">
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

      <h2 className="text-lg font-semibold px-4 pb-2 mt-4">Game List</h2>
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

      {/* Game music / theme song controls for fullscreen hover/click playback */}
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
              Play main theme / song while hovering or selecting a game (fades in/out)
            </ConfigCheckbox>
          </FormItem>
        )}
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="interface.fullscreenConfig.gameMusic.volume"
          render={({ field }) => (
            <FormItem>
              <FormLabel htmlFor="config-menu-game-music-volume" className="text-xs">
                Music volume
              </FormLabel>
              <ConfigInput
                id="config-menu-game-music-volume"
                type="number"
                step="0.05"
                min="0"
                max="1"
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
              <FormLabel htmlFor="config-menu-game-music-fade" className="text-xs">
                Fade duration (ms)
              </FormLabel>
              <ConfigInput
                id="config-menu-game-music-fade"
                type="number"
                step="50"
                min="100"
                max="5000"
                {...field}
              />
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
}
