import { Button } from "@retrom/ui/components/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useForm,
} from "@retrom/ui/components/form";
import { Input } from "@retrom/ui/components/input";
import { TabsContent } from "@retrom/ui/components/tabs";
import { RetroAchievementsConfigSchema } from "@retrom/codegen/retrom/server/config_pb";
import { useServerConfig } from "@/queries/useServerConfig";
import { useUpdateServerConfig } from "@/mutations/useUpdateServerConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { create } from "@bufbuild/protobuf";
import { LoaderCircleIcon } from "lucide-react";
import { useCallback } from "react";
import { z } from "zod";

const achievementsSchema = z.object({
  retroAchievements: z.object({
    username: z.string(),
    apiKey: z.string(),
  }),
});

type AchievementsSchema = z.infer<typeof achievementsSchema>;

/**
 * "Achievements" settings, bound to the server config. Steam achievements reuse
 * the Steam tab's credentials, so this surface only covers RetroAchievements
 * (username + web API key) — the one account the Steam tab doesn't already hold.
 */
export function AchievementsAccountsFields() {
  const { data, status } = useServerConfig();
  const { mutate: update, status: updateStatus } = useUpdateServerConfig();

  const config = data?.config;

  const form = useForm<AchievementsSchema>({
    resolver: zodResolver(achievementsSchema),
    mode: "onBlur",
    values: {
      retroAchievements: {
        username: config?.retroAchievements?.username ?? "",
        apiKey: config?.retroAchievements?.apiKey ?? "",
      },
    },
  });

  const handleSubmit = useCallback(
    (values: AchievementsSchema) => {
      if (!config) return;
      update({
        config: {
          ...config,
          retroAchievements: create(
            RetroAchievementsConfigSchema,
            values.retroAchievements,
          ),
        },
      });
      form.reset(values);
    },
    [config, form, update],
  );

  if (status === "pending") {
    return (
      <div className="grid place-items-center py-8">
        <LoaderCircleIcon className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === "error" || !config) {
    return (
      <p className="py-8 text-center text-muted-foreground">
        😔 Error loading server config
      </p>
    );
  }

  const canSubmit = form.formState.isDirty && updateStatus !== "pending";

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="flex flex-col gap-5"
      >
        <p className="max-w-[60ch] text-sm text-muted-foreground">
          Connect your RetroAchievements account to track achievements for
          emulated games. Steam achievements use the credentials from the Steam
          tab — no need to re-enter them here.
        </p>

        <FormField
          control={form.control}
          name="retroAchievements.username"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="retroAchievements.apiKey"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center justify-between">
                <FormLabel>Web API Key</FormLabel>
                <a
                  href="https://retroachievements.org/settings"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs underline text-accent-text"
                >
                  Get a key
                </a>
              </div>
              <FormControl>
                <Input type="password" {...field} />
              </FormControl>
              <FormDescription>
                Found under your RetroAchievements profile → Settings → Keys.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end">
          <Button type="submit" disabled={!canSubmit}>
            {updateStatus === "pending" ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}

/** Standard-settings wrapper: the Achievements form as a config tab. */
export function AchievementsConfig() {
  return (
    <TabsContent value="retroAchievements" className="mt-4">
      <AchievementsAccountsFields />
    </TabsContent>
  );
}
