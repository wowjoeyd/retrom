import { Button } from "@retrom/ui/components/button";
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
import {
  EmulatorPackagesConfigSchema,
  ServerConfig,
} from "@retrom/codegen/retrom/server/config_pb";
import { useUpdateServerConfig } from "@/mutations/useUpdateServerConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";
import { useCallback } from "react";
import { useForm } from "@retrom/ui/components/form";
import { z } from "zod";
import { create } from "@bufbuild/protobuf";

const emulatorPackagesSchema = z.object({
  rescanIntervalHours: z.coerce.number().min(0).default(24),
});

export function EmulatorPackagesConfig(props: {
  currentConfig: NonNullable<ServerConfig>;
}) {
  const navigate = useNavigate();
  const { mutate: update, status } = useUpdateServerConfig();

  const form = useForm<z.infer<typeof emulatorPackagesSchema>>({
    resolver: zodResolver(emulatorPackagesSchema),
    defaultValues: {
      rescanIntervalHours:
        props.currentConfig.emulatorPackages?.rescanIntervalHours ?? 24,
    },
  });

  const handleSubmit = useCallback(
    (values: z.infer<typeof emulatorPackagesSchema>) => {
      try {
        update({
          config: {
            ...props.currentConfig,
            emulatorPackages: create(EmulatorPackagesConfigSchema, values),
          },
        });
        form.reset(values);
      } catch (error) {
        console.error(error);
        form.reset();
      }
    },
    [form, props.currentConfig, update],
  );

  const dirty = form.formState.isDirty;
  const canSubmit = dirty && status !== "pending";

  return (
    <TabsContent value="emulatorPackages">
      <div className="my-4 max-w-[55ch]">
        <p className="text-sm text-muted-foreground">
          Automatic NAS package re-scan interval. Set to 0 to disable scheduled
          rescans.
        </p>
      </div>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex flex-col gap-4"
        >
          <FormField
            control={form.control}
            name="rescanIntervalHours"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Rescan interval (hours)</FormLabel>
                <FormControl>
                  <Input type="number" min={0} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <DialogFooter className="gap-2">
            <Button
              type="button"
              onClick={() =>
                void navigate({
                  to: ".",
                  search: (prev) => ({ ...prev, configModal: undefined }),
                })
              }
              variant="secondary"
            >
              Close
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {status === "pending" ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </TabsContent>
  );
}
