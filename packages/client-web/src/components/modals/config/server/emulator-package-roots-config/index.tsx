import { Button } from "@retrom/ui/components/button";
import { DialogFooter } from "@retrom/ui/components/dialog";
import { Form, FormField } from "@retrom/ui/components/form";
import { Input } from "@retrom/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@retrom/ui/components/table";
import { TabsContent } from "@retrom/ui/components/tabs";
import {
  EmulatorPackageDirectorySchema,
  ServerConfig,
} from "@retrom/codegen/retrom/server/config_pb";
import { useUpdateServerConfig } from "@/mutations/useUpdateServerConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Trash, Undo } from "lucide-react";
import { useCallback } from "react";
import { useFieldArray, useForm } from "@retrom/ui/components/form";
import { z } from "zod";
import { BrowseButton } from "../libraries-config/browse";
import { IgnorePatternsTooltip } from "../libraries-config/ignore-patterns";
import { create } from "@bufbuild/protobuf";
import { cn } from "@retrom/ui/lib/utils";

export const emulatorPackageDirectorySchema = z.object({
  path: z.string().min(1),
  customPackageLayout: z.object({
    definition: z.string(),
  }),
  newly: z.enum(["added", "removed"]).optional(),
  ignorePatterns: z.object({
    patterns: z.string().array(),
  }),
});

const rootsSchema = z.object({
  emulatorPackageDirectories: z.array(emulatorPackageDirectorySchema),
});

export type EmulatorPackageRootsSchema = z.infer<typeof rootsSchema>;

export function EmulatorPackageRootsConfig(props: {
  currentConfig: NonNullable<ServerConfig>;
}) {
  const navigate = useNavigate();
  const { mutateAsync: save, status } = useUpdateServerConfig();

  const form = useForm<EmulatorPackageRootsSchema>({
    resolver: zodResolver(rootsSchema),
    defaultValues: {
      emulatorPackageDirectories: (
        props.currentConfig.emulatorPackageDirectories ?? []
      ).map((dir) => ({
        path: dir.path,
        ignorePatterns: dir.ignorePatterns ?? { patterns: [] },
        customPackageLayout: dir.customPackageLayout ?? { definition: "" },
      })),
    },
    mode: "all",
    reValidateMode: "onChange",
  });

  const { append, remove, update } = useFieldArray({
    control: form.control,
    name: "emulatorPackageDirectories",
  });

  const handleSubmit = useCallback(
    async (values: EmulatorPackageRootsSchema) => {
      const emulatorPackageDirectories =
        values.emulatorPackageDirectories.filter(
          (dir) => dir.newly !== "removed",
        );

      try {
        const next = {
          ...props.currentConfig,
          emulatorPackageDirectories: emulatorPackageDirectories.map((dir) =>
            create(EmulatorPackageDirectorySchema, dir),
          ),
        };

        const res = await save({ config: next });
        form.reset({
          emulatorPackageDirectories: (
            res.configUpdated?.emulatorPackageDirectories ?? []
          ).map((dir) => ({
            path: dir.path,
            ignorePatterns: dir.ignorePatterns ?? { patterns: [] },
            customPackageLayout: dir.customPackageLayout ?? { definition: "" },
          })),
        });
      } catch (error) {
        console.error(error);
        form.reset();
      }
    },
    [form, props.currentConfig, save],
  );

  const isDirty = form.formState.isDirty;
  const isValid = form.formState.isValid;
  const canSubmit = isDirty && isValid && status !== "pending";
  const directories = form.watch("emulatorPackageDirectories");

  const action = useCallback(
    (directory: (typeof directories)[number], index: number) => {
      if (directory.newly === "added") {
        remove(index);
      } else if (directory.newly === "removed") {
        const { newly: _, ...value } = directory;
        update(index, value);
      } else {
        update(index, { ...directory, newly: "removed" });
      }
    },
    [remove, update],
  );

  return (
    <TabsContent value="emulatorPackageDirectories">
      <div className="my-4 max-w-[65ch]">
        <p className="text-sm text-muted-foreground">
          NAS paths where emulator package trees are stored. Default layout is{" "}
          <code className="font-mono text-xs">
            {"{root}/{packageSlug}/{version}/**"}
          </code>
          . Optional custom layout tokens:{" "}
          <code className="font-mono text-xs">
            {"{root}"}, {"{packageSlug}"}, {"{version}"}, {"{os}"}, {"{file}"}
          </code>
          .
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(handleSubmit)}>
          <Table>
            <TableHeader>
              <TableRow className="hidden sm:table-row">
                <TableHead>Path</TableHead>
                <TableHead>
                  Ignore Patterns <IgnorePatternsTooltip />
                </TableHead>
                <TableHead>Custom layout</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>

            <TableBody>
              {directories.map((directory, index) => (
                <TableRow
                  key={index}
                  className={cn(
                    "*:py-1 flex flex-col sm:table-row pb-6 sm:pb-0",
                    "sm:*:px-4 *:px-0",
                  )}
                >
                  <TableCell>
                    <FormField
                      disabled={directory.newly === "removed"}
                      control={form.control}
                      name={`emulatorPackageDirectories.${index}.path` as const}
                      render={BrowseButton}
                    />
                  </TableCell>
                  <TableCell className="sm:w-[150px]">
                    <FormField
                      disabled={directory.newly === "removed"}
                      control={form.control}
                      name={`emulatorPackageDirectories.${index}.ignorePatterns.patterns`}
                      render={({ field }) => (
                        <Input
                          {...field}
                          value={field.value?.join(", ") ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value
                                .split(",")
                                .map((p) => p.trim())
                                .filter(Boolean),
                            )
                          }
                          placeholder="regex, patterns"
                          className="text-xs font-mono"
                        />
                      )}
                    />
                  </TableCell>
                  <TableCell>
                    <FormField
                      disabled={directory.newly === "removed"}
                      control={form.control}
                      name={`emulatorPackageDirectories.${index}.customPackageLayout.definition`}
                      render={({ field }) => (
                        <Input
                          {...field}
                          placeholder="{root}/{packageSlug}/{version}/**"
                          className="font-mono text-xs"
                        />
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-end">
                    <Button
                      type="button"
                      size="icon"
                      onClick={() => action(directory, index)}
                      variant={directory.newly ? "secondary" : "destructive"}
                      className="min-h-0 h-min w-min p-2"
                    >
                      {directory.newly ? (
                        <Undo className="h-[1rem] w-[1rem]" />
                      ) : (
                        <Trash className="h-[1rem] w-[1rem]" />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}

              <TableRow className="*:py-2 border-b-0 sm:*:px-4 *:px-0">
                <TableCell colSpan={4} className="text-end">
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="min-h-0 h-min w-min p-2"
                    onClick={() =>
                      append({
                        newly: "added",
                        path: "",
                        ignorePatterns: { patterns: [] },
                        customPackageLayout: { definition: "" },
                      })
                    }
                  >
                    <Plus className="h-[1rem] w-[1rem]" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </form>
      </Form>

      <DialogFooter className="gap-2">
        <Button
          onClick={() =>
            navigate({
              to: ".",
              search: (prev) => ({ ...prev, configModal: undefined }),
            })
          }
          variant="secondary"
        >
          Close
        </Button>

        <Button onClick={form.handleSubmit(handleSubmit)} disabled={!canSubmit}>
          Save
        </Button>
      </DialogFooter>
    </TabsContent>
  );
}
