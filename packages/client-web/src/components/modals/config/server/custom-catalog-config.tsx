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
import { TabsContent } from "@retrom/ui/components/tabs";
import { ServerConfig } from "@retrom/codegen/retrom/server/config_pb";
import { useUpdateServerConfig } from "@/mutations/useUpdateServerConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";
import { useCallback } from "react";
import { useForm } from "@retrom/ui/components/form";
import { z } from "zod";
import { BrowseButton } from "./libraries-config/browse";

const customCatalogSchema = z.object({
  customCatalogDir: z.string().default(""),
});

export function CustomCatalogConfig(props: {
  currentConfig: NonNullable<ServerConfig>;
}) {
  const navigate = useNavigate();
  const { mutate: update, status } = useUpdateServerConfig();

  const form = useForm<z.infer<typeof customCatalogSchema>>({
    resolver: zodResolver(customCatalogSchema),
    defaultValues: {
      customCatalogDir: props.currentConfig.customCatalogDir ?? "",
    },
  });

  const handleSubmit = useCallback(
    (values: z.infer<typeof customCatalogSchema>) => {
      try {
        update({
          config: {
            ...props.currentConfig,
            customCatalogDir: values.customCatalogDir || undefined,
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
    <TabsContent value="customCatalogDir">
      <div className="my-4 max-w-[55ch]">
        <p className="text-sm text-muted-foreground">
          Optional directory of additional catalog JSON overlays merged with the
          built-in emulator catalog.
        </p>
      </div>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex flex-col gap-4"
        >
          <FormField
            control={form.control}
            name="customCatalogDir"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Custom catalog directory</FormLabel>
                <FormControl>
                  <BrowseButton
                    field={field}
                    fieldState={form.getFieldState("customCatalogDir")}
                  />
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
