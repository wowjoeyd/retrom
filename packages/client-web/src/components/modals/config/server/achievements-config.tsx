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
import {
  SteamConfigSchema,
  RetroAchievementsConfigSchema,
} from "@retrom/codegen/retrom/server/config_pb";
import { useServerConfig } from "@/queries/useServerConfig";
import { useUpdateServerConfig } from "@/mutations/useUpdateServerConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { create } from "@bufbuild/protobuf";
import { LoaderCircleIcon } from "lucide-react";
import { useCallback } from "react";
import { z } from "zod";

// Steam validation mirrors the Steam tab so the two surfaces agree on what a
// valid SteamID64 / Web API key looks like.
const STEAMID64_RE = /^7656119\d{10}$/;
const STEAM_API_KEY_RE = /^[0-9A-Fa-f]{32}$/;

const achievementsSchema = z.object({
  steam: z.object({
    userId: z.string().refine((v) => v === "" || STEAMID64_RE.test(v), {
      message: "Enter a valid 17-digit SteamID64.",
    }),
    apiKey: z.string().refine((v) => v === "" || STEAM_API_KEY_RE.test(v), {
      message: "Enter a valid 32-character Steam Web API key.",
    }),
  }),
  retroAchievements: z.object({
    username: z.string(),
    apiKey: z.string(),
  }),
});

type AchievementsSchema = z.infer<typeof achievementsSchema>;

/**
 * Shared "Achievements accounts" form, bound to the server config. Edits the
 * Steam Web API key + SteamID (reused from library import) and the
 * RetroAchievements username + web API key. Rendered as a tab in the standard
 * settings and as a section in the fullscreen settings — both write the same
 * server config, so the values stay in sync.
 */
export function AchievementsAccountsFields() {
  const { data, status } = useServerConfig();
  const { mutate: update, status: updateStatus } = useUpdateServerConfig();

  const config = data?.config;

  const form = useForm<AchievementsSchema>({
    resolver: zodResolver(achievementsSchema),
    mode: "onBlur",
    values: {
      steam: {
        userId: config?.steam?.userId ?? "",
        apiKey: config?.steam?.apiKey ?? "",
      },
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
          steam: create(SteamConfigSchema, values.steam),
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
          Connect your accounts to track achievements per game. Steam
          achievements reuse your library&apos;s Steam credentials;
          RetroAchievements covers emulated games.
        </p>

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-bold uppercase tracking-wide text-foreground/80">
            Steam
          </h4>

          <FormField
            control={form.control}
            name="steam.userId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>SteamID64</FormLabel>
                <FormControl>
                  <Input placeholder="76561198000000000" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="steam.apiKey"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <FormLabel>Steam Web API Key</FormLabel>
                  <a
                    href="https://steamcommunity.com/dev/apikey"
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
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex flex-col gap-3">
          <h4 className="text-sm font-bold uppercase tracking-wide text-foreground/80">
            RetroAchievements
          </h4>

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
        </div>

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

/** Standard-settings wrapper: the Achievements accounts form as a config tab. */
export function AchievementsConfig() {
  return (
    <TabsContent value="retroAchievements" className="mt-4">
      <AchievementsAccountsFields />
    </TabsContent>
  );
}
