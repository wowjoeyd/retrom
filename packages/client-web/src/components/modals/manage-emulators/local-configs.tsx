import { Button } from "@retrom/ui/components/button";
import { Checkbox } from "@retrom/ui/components/checkbox";
import { DialogClose, DialogFooter } from "@retrom/ui/components/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@retrom/ui/components/form";
import {
  InputGroup,
  InputGroupInput,
  InputGroupButton,
  InputGroupAddon,
} from "@retrom/ui/components/input-group";
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
  LocalEmulatorConfigJson,
} from "@retrom/codegen/retrom/models/emulators_pb";
import { cn } from "@retrom/ui/lib/utils";
import { useCreateLocalEmulatorConfigs } from "@/mutations/useCreateLocalEmulatorConfig";
import { useUpdateLocalEmulatorConfig } from "@/mutations/useUpdateLocalEmulatorConfigs";
import { useLinkEmulatorToPackage } from "@/mutations/useLinkEmulatorToPackage";
import { useSyncEmulatorUserData } from "@/mutations/useSyncEmulatorUserData";
import { analyzeEmulatorUserData } from "@retrom/plugin-emulator-sync";
import { useEmulatorPackages } from "@/queries/useEmulatorPackages";
import { useModalAction } from "@/providers/modal-action";
import { useConfigStore } from "@/providers/config";
import { toast } from "@retrom/ui/hooks/use-toast";
import { zodResolver } from "@hookform/resolvers/zod";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpenIcon,
  LoaderCircleIcon,
  SaveIcon,
  UploadIcon,
  DownloadIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useForm } from "@retrom/ui/components/form";
import { z } from "zod";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@retrom/ui/components/accordion";
import { SyncStatusBadge } from "./sync-status-badge";
import { getLastEmulatorUserDataSync } from "@/components/emulator-user-data-auto-sync";
import { isEnhancedEmulatorUserDataEnabled } from "@/lib/env";

const baseConfigSchema = z.object({
  executablePath: z.string(),
  saveDataPath: z.string().optional(),
  saveStatesPath: z.string().optional(),
  linkedPackageId: z.number().optional(),
  managedPaths: z.boolean().default(false),
  // Overrides for the package manifest paths. Non-empty values take precedence
  // for auto upstream (user_data) and local protection (preserve) during sync.
  // Allows the system to support any emulator by user customization.
  userDataPathsOverride: z.array(z.string()).default([]),
  preservePathsOverride: z.array(z.string()).default([]),
}) satisfies z.ZodObject<
  Record<
    keyof Omit<
      LocalEmulatorConfigJson,
      "createdAt" | "updatedAt" | "id" | "emulatorId" | "clientId" | "nickname"
    >,
    z.ZodType
  >
>;

const configSchema = baseConfigSchema
  .refine(
    (data) => data.managedPaths || (data.executablePath?.length ?? 0) > 0,
    {
      message: "Executable path is required when not managed",
      path: ["executablePath"],
    },
  )
  .refine((data) => !data.managedPaths || data.linkedPackageId !== undefined, {
    message: "Select a package when using managed paths",
    path: ["linkedPackageId"],
  });

type ConfigSchema = z.infer<typeof configSchema>;

export function LocalConfigs(props: {
  emulators: Emulator[];
  configs: LocalEmulatorConfig[];
}) {
  return (
    <>
      <Accordion type="single" collapsible>
        {props.emulators
          .filter((e) => !e.builtIn)
          .map((emulator) => {
            const config = props.configs.find(
              (c) => c.emulatorId === emulator.id,
            );

            return (
              <LocalConfigRow
                key={emulator.id}
                emulator={emulator}
                config={config}
              />
            );
          })}
      </Accordion>

      <DialogFooter className="border-none mt-8">
        <div className="flex justify-end col-span-4 gap-4">
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </div>
      </DialogFooter>
    </>
  );
}

function LocalConfigRow(props: {
  emulator: Emulator;
  config?: LocalEmulatorConfig;
}) {
  const { emulator, config } = props;
  const clientId = useConfigStore().getState().config?.clientInfo?.id;

  if (!clientId) {
    throw new Error("Client ID not found");
  }

  const { data: packages } = useEmulatorPackages({
    selectFn: (data) => data.packages,
  });

  const form = useForm<ConfigSchema>({
    defaultValues: {
      executablePath: config?.executablePath || "",
      saveDataPath: config?.saveDataPath || "",
      saveStatesPath: config?.saveStatesPath || "",
      linkedPackageId: config?.linkedPackageId ?? undefined,
      managedPaths: config?.managedPaths ?? false,
      userDataPathsOverride: config?.userDataPathsOverride ?? [],
      preservePathsOverride: config?.preservePathsOverride ?? [],
    },
    resolver: zodResolver(configSchema),
    mode: "onSubmit",
    reValidateMode: "onChange",
  });

  const managedPaths = form.watch("managedPaths");

  const {
    mutateAsync: createConfig,
    isPending: creationPending,
    error: creationError,
  } = useCreateLocalEmulatorConfigs();

  const {
    mutateAsync: updateConfig,
    isPending: updatePending,
    error: updateError,
  } = useUpdateLocalEmulatorConfig();

  const {
    mutateAsync: linkToPackage,
    isPending: linkPending,
    error: linkError,
  } = useLinkEmulatorToPackage();

  const { mutateAsync: syncUserData, isPending: userDataSyncPending } =
    useSyncEmulatorUserData();

  const { openModal: openUserDataConflict } = useModalAction(
    "resolveEmulatorUserDataConflict",
  );

  const [suggestedUser, setSuggestedUser] = useState<string[]>([]);
  const [suggestedPreserve, setSuggestedPreserve] = useState<string[]>([]);

  const handleAnalyze = useCallback(async () => {
    try {
      const res = await analyzeEmulatorUserData({ emulatorId: emulator.id });
      const u = res.suggestedUserDataPaths || [];
      const p = res.suggestedPreservePaths || [];
      setSuggestedUser(u);
      setSuggestedPreserve(p);

      // Auto-apply to overrides if currently empty (non-destructive suggestion)
      if (
        (form.getValues("userDataPathsOverride") || []).length === 0 &&
        u.length > 0
      ) {
        form.setValue("userDataPathsOverride", u);
      }
      if (
        (form.getValues("preservePathsOverride") || []).length === 0 &&
        p.length > 0
      ) {
        form.setValue("preservePathsOverride", p);
      }
    } catch (e) {
      toast({
        title: "Analyze failed",
        description:
          (e as Error)?.message || "Could not analyze emulator cache",
      });
    }
  }, [emulator.id, form]);

  const handleSubmit = useCallback(
    async (values: ConfigSchema) => {
      if (values.managedPaths && values.linkedPackageId) {
        const shouldLink =
          !config ||
          !config.managedPaths ||
          config.linkedPackageId !== values.linkedPackageId;

        if (shouldLink) {
          const res = await linkToPackage({
            emulatorId: emulator.id,
            packageId: values.linkedPackageId,
            clientId,
            managedPaths: true,
          });

          form.reset({
            executablePath: res.localConfig?.executablePath ?? "",
            saveDataPath: values.saveDataPath,
            saveStatesPath: values.saveStatesPath,
            linkedPackageId: res.localConfig?.linkedPackageId ?? undefined,
            managedPaths: res.localConfig?.managedPaths ?? true,
          });
          return;
        }
      }

      if (config) {
        const res = await updateConfig({
          configs: [
            {
              ...values,
              id: config.id,
              clientId,
              emulatorId: emulator.id,
              executablePath: values.managedPaths
                ? config.executablePath
                : values.executablePath,
            },
          ],
        });

        form.reset(res.configsUpdated.at(0));
        return;
      }

      if (values.managedPaths) {
        return;
      }

      const res = await createConfig({
        configs: [{ ...values, clientId, emulatorId: emulator.id }],
      });

      form.reset(res.configsCreated.at(0));
    },
    [
      config,
      createConfig,
      updateConfig,
      linkToPackage,
      form,
      emulator,
      clientId,
    ],
  );

  const pending = creationPending || updatePending || linkPending;
  const error = creationError || updateError || linkError;
  const lastUserDataSync = getLastEmulatorUserDataSync(emulator.id);
  const enhancedUserDataEnabled = isEnhancedEmulatorUserDataEnabled();

  const { isDirty } = form.formState;

  return (
    <AccordionItem value={emulator.id.toString()}>
      <AccordionTrigger
        className={cn(
          "py-[0.35rem] px-1 hover:no-underline",
          "hover:bg-primary/15",
        )}
      >
        <span className="flex gap-2 items-baseline">
          <span>{emulator.name}</span>
          {config?.managedPaths ? (
            <SyncStatusBadge emulatorId={emulator.id} />
          ) : null}
          {isDirty ? (
            <span className="text-sm text-muted-foreground italic">
              (unsaved)
            </span>
          ) : null}
        </span>
      </AccordionTrigger>

      <AccordionContent className="[&_*]:ring-inset">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            name={emulator.id.toString()}
            className={cn("flex flex-col gap-4 pt-4 border-t")}
          >
            <FormField
              control={form.control}
              name="managedPaths"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center gap-3 space-y-0">
                  <FormControl>
                    <Checkbox
                      checked={field.value}
                      onCheckedChange={(checked) => {
                        field.onChange(checked === true);
                        if (!checked) {
                          form.setValue("linkedPackageId", undefined);
                        }
                      }}
                    />
                  </FormControl>
                  <FormLabel className="font-normal">
                    Managed by package sync
                  </FormLabel>
                </FormItem>
              )}
            />

            {managedPaths ? (
              <FormField
                control={form.control}
                name="linkedPackageId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Linked package</FormLabel>
                    <Select
                      value={
                        field.value !== undefined ? String(field.value) : ""
                      }
                      onValueChange={(value) => field.onChange(Number(value))}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select NAS package" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {packages?.map((pkg) => (
                          <SelectItem key={pkg.id} value={String(pkg.id)}>
                            {pkg.displayName} ({pkg.version})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}

            {managedPaths ? (
              <>
                <FormField
                  control={form.control}
                  name="userDataPathsOverride"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        User Data Paths Override (one per line)
                      </FormLabel>
                      <FormControl>
                        <textarea
                          className="w-full rounded border p-2 text-sm"
                          rows={3}
                          value={(field.value || []).join("\n")}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value
                                .split(/\n+/)
                                .map((s) => s.trim())
                                .filter(Boolean),
                            )
                          }
                          placeholder="e.g.&#10;dev_hdd0/&#10;games/&#10;keys/"
                        />
                      </FormControl>
                      <FormDescription>
                        If set, these override the package manifest for auto
                        upstream push of firmware, RAPs, installed titles etc.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="preservePathsOverride"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Preserve Paths Override (one per line)
                      </FormLabel>
                      <FormControl>
                        <textarea
                          className="w-full rounded border p-2 text-sm"
                          rows={3}
                          value={(field.value || []).join("\n")}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value
                                .split(/\n+/)
                                .map((s) => s.trim())
                                .filter(Boolean),
                            )
                          }
                          placeholder="e.g.&#10;config/&#10;dev_hdd0/"
                        />
                      </FormControl>
                      <FormDescription>
                        If set, these override for local protection during sync
                        (user mods not overwritten).
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {enhancedUserDataEnabled ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={handleAnalyze}
                    disabled={pending}
                  >
                    Analyze current cache for suggestions
                  </Button>
                ) : null}
                {enhancedUserDataEnabled &&
                  (suggestedUser.length > 0 ||
                    suggestedPreserve.length > 0) && (
                    <div className="text-xs text-muted-foreground">
                      Suggested: user_data=[{suggestedUser.join(", ")}]
                      preserve=[{suggestedPreserve.join(", ")}] (applied to
                      empty fields)
                    </div>
                  )}
              </>
            ) : null}

            {managedPaths ? (
              <div className="flex flex-col gap-2 rounded border p-3">
                <div className="text-sm font-medium">User Data Sync</div>
                {lastUserDataSync ? (
                  <div className="text-xs text-muted-foreground">
                    Last sync: {new Date(lastUserDataSync).toLocaleString()}
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Firmware, decryption keys, installed games/ROMs, RAP files
                  etc. (config/ is kept local and PC-specific). Use Push to
                  promote this PC&apos;s data as the cloud source of truth. Use
                  Pull to reset local from cloud.
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={userDataSyncPending || pending}
                    onClick={() => {
                      void syncUserData({
                        emulatorId: emulator.id,
                        direction: "push",
                      });
                    }}
                  >
                    <UploadIcon className="mr-1 h-4 w-4" />
                    Push local to NAS (set as truth)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={userDataSyncPending || pending}
                    onClick={() => {
                      void syncUserData({
                        emulatorId: emulator.id,
                        direction: "pull",
                      });
                    }}
                  >
                    <DownloadIcon className="mr-1 h-4 w-4" />
                    Pull from NAS (reset local)
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={userDataSyncPending || pending}
                    onClick={() =>
                      openUserDataConflict({ emulatorId: emulator.id })
                    }
                  >
                    Resolve conflicts / Smart sync…
                  </Button>
                </div>
              </div>
            ) : null}

            <FormField
              control={form.control}
              name="executablePath"
              render={({ field, fieldState: { isDirty } }) => (
                <FormItem className="flex flex-col items-start">
                  <div className="flex items-center gap-2">
                    <FormLabel>Executable Path</FormLabel>
                    {managedPaths ? (
                      <SyncStatusBadge emulatorId={emulator.id} />
                    ) : null}
                  </div>

                  <FormControl>
                    <InputGroup>
                      {!managedPaths ? (
                        <InputGroupAddon align="inline-start">
                          <InputGroupButton
                            variant="secondary"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();

                              open({
                                title: "Select Emulator Executable",
                                multiple: false,
                                directory: false,
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
                            <FolderOpenIcon />
                            Browse
                          </InputGroupButton>
                        </InputGroupAddon>
                      ) : null}

                      <InputGroupInput
                        {...field}
                        readOnly={managedPaths}
                        value={field.value || ""}
                        placeholder={
                          managedPaths
                            ? "Synced from NAS package"
                            : "Enter path to executable"
                        }
                        className={cn(!isDirty && "text-muted-foreground")}
                      />
                    </InputGroup>
                  </FormControl>

                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="saveDataPath"
              render={({ field, fieldState: { isDirty } }) => (
                <FormItem className="flex flex-col items-start">
                  <FormLabel>Save Data Path</FormLabel>

                  <FormControl>
                    <InputGroup>
                      <InputGroupAddon align="inline-start">
                        <InputGroupButton
                          variant="secondary"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();

                            open({
                              title: "Select Save Data Directory",
                              directory: true,
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
                          <FolderOpenIcon />
                          Browse
                        </InputGroupButton>
                      </InputGroupAddon>

                      <InputGroupInput
                        {...field}
                        value={field.value || ""}
                        placeholder="Enter path save data location"
                        className={cn(!isDirty && "text-muted-foreground")}
                      />
                    </InputGroup>
                  </FormControl>

                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="saveStatesPath"
              render={({ field, fieldState: { isDirty } }) => (
                <FormItem className="flex flex-col items-start">
                  <FormLabel>Save States Path</FormLabel>

                  <FormControl>
                    <InputGroup>
                      <InputGroupAddon align="inline-start">
                        <InputGroupButton
                          variant="secondary"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();

                            open({
                              title: "Select Save States Directory",
                              directory: true,
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
                          <FolderOpenIcon />
                          Browse
                        </InputGroupButton>
                      </InputGroupAddon>

                      <InputGroupInput
                        {...field}
                        value={field.value || ""}
                        placeholder="Enter path save states location"
                        className={cn(!isDirty && "text-muted-foreground")}
                      />
                    </InputGroup>
                  </FormControl>

                  <FormMessage />
                </FormItem>
              )}
            />

            {error ? (
              <FormMessage className="grid place-items-center">
                <span className="max-w-[60ch] text-center">
                  {error.message}
                </span>
              </FormMessage>
            ) : null}

            <Button
              disabled={pending || !isDirty}
              type="submit"
              className="ml-auto w-min"
            >
              {pending ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SaveIcon />
              )}
              Save
            </Button>
          </form>
        </Form>
      </AccordionContent>
    </AccordionItem>
  );
}
