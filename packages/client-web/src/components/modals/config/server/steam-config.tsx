import { Button } from "@retrom/ui/components/button";
import { DialogFooter } from "@retrom/ui/components/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@retrom/ui/components/form";
import { Input } from "@retrom/ui/components/input";
import { TabsContent } from "@retrom/ui/components/tabs";
import {
  ServerConfig,
  SteamConfigSchema,
} from "@retrom/codegen/retrom/server/config_pb";
import { useUpdateServerConfig } from "@/mutations/useUpdateServerConfig";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "@retrom/ui/components/form";
import { z } from "zod";
import { RawMessage } from "@/utils/protos";
import { create } from "@bufbuild/protobuf";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { checkIsDesktop } from "@/lib/env";

// ── Regex constants ────────────────────────────────────────────────────────────
const STEAMID64_RE = /^7656119\d{10}$/;
const API_KEY_RE = /^[0-9A-Fa-f]{32}$/;
const PROFILES_URL_RE = /\/profiles\/(\d{17})/i;
const VANITY_URL_RE = /\/id\/([^/?#\s]+)/i;

// ── Steam OpenID helpers ───────────────────────────────────────────────────────

function buildSteamOpenIdUrl(): string {
  const returnTo = window.location.origin + "/";
  const params = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": window.location.origin,
    "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select",
    "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select",
  });
  return `https://steamcommunity.com/openid/login?${params.toString()}`;
}

// ── Input parsing ──────────────────────────────────────────────────────────────

type ParsedInput =
  | { kind: "id64"; value: string }
  | { kind: "profiles-url"; value: string }
  | { kind: "vanity-url"; name: string }
  | { kind: "plain"; value: string };

function parseUserIdInput(raw: string): ParsedInput {
  const t = raw.trim();
  if (/^\d{17}$/.test(t)) return { kind: "id64", value: t };
  const profileMatch = t.match(PROFILES_URL_RE);
  if (profileMatch) return { kind: "profiles-url", value: profileMatch[1] };
  const vanityMatch = t.match(VANITY_URL_RE);
  if (vanityMatch) return { kind: "vanity-url", name: vanityMatch[1] };
  return { kind: "plain", value: t };
}

// ── Steam icon (Simple Icons path, MIT) ───────────────────────────────────────

function SteamIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.718L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.297-.249-1.905-.042l1.523.63c.956.4 1.409 1.498 1.009 2.455-.397.957-1.497 1.41-2.454 1.013H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.252 0-2.265-1.014-2.265-2.265z" />
    </svg>
  );
}

// ── Zod schema ─────────────────────────────────────────────────────────────────

type SteamConfigShape = Record<
  keyof NonNullable<RawMessage<ServerConfig>["steam"]>,
  z.ZodTypeAny
>;
const steamSchema = z.object({
  userId: z.string().refine((v) => v === "" || STEAMID64_RE.test(v), {
    message: "Enter a valid 17-digit SteamID64.",
  }),
  apiKey: z.string().refine((v) => v === "" || API_KEY_RE.test(v), {
    message: "Enter a valid 32-character Steam Web API key.",
  }),
}) satisfies z.ZodObject<SteamConfigShape>;

// ── Component ──────────────────────────────────────────────────────────────────

export function SteamConfig(props: {
  currentConfig: NonNullable<ServerConfig>;
}) {
  const navigate = useNavigate();
  const { mutate: update, status } = useUpdateServerConfig();
  const { toast } = useToast();

  const [signingIn, setSigningIn] = useState(false);
  const [vanityStatus, setVanityStatus] = useState<{
    message: string;
    variant: "info" | "error";
  } | null>(null);

  // Holds a function that closes the Steam auth window (popup or WebviewWindow).
  const closePendingWindowRef = useRef<(() => void) | null>(null);

  const form = useForm<z.infer<typeof steamSchema>>({
    resolver: zodResolver(steamSchema),
    defaultValues: props.currentConfig.steam,
    mode: "onBlur",
  });

  // Close any open auth window on unmount.
  useEffect(() => {
    return () => {
      closePendingWindowRef.current?.();
    };
  }, []);

  // Listen for the SteamID64 broadcast from the auth popup/window.
  useEffect(() => {
    if (!signingIn) return;
    const channel = new BroadcastChannel("retrom-steam-openid");
    channel.onmessage = (e: MessageEvent<{ steamId64: string }>) => {
      form.setValue("userId", e.data.steamId64, {
        shouldDirty: true,
        shouldValidate: true,
      });
      setVanityStatus(null);
      // Close the auth window from the parent (important for Tauri WebviewWindow).
      closePendingWindowRef.current?.();
      closePendingWindowRef.current = null;
      setSigningIn(false);
    };
    return () => channel.close();
  }, [signingIn, form]);

  // ── Sign-in handlers ───────────────────────────────────────────────────────

  const cancelSignIn = useCallback(() => {
    closePendingWindowRef.current?.();
    closePendingWindowRef.current = null;
    setSigningIn(false);
  }, []);

  const handleSteamSignIn = useCallback(() => {
    const steamUrl = buildSteamOpenIdUrl();

    if (checkIsDesktop()) {
      // Tauri: open a native WebviewWindow so the auth page loads inside the app.
      void import("@tauri-apps/api/webviewWindow")
        .then(({ WebviewWindow }) => {
          const win = new WebviewWindow("steam-login", {
            url: steamUrl,
            width: 600,
            height: 700,
            title: "Sign in with Steam",
            center: true,
          });
          // Store a close handle; the BroadcastChannel handler calls this on success.
          closePendingWindowRef.current = () => void win.close();
          setSigningIn(true);
        })
        .catch(console.error);
    } else {
      // Browser: standard popup. window.open() is synchronous from a click
      // handler so popup blockers should not trigger.
      const popup = window.open(
        steamUrl,
        "steam-signin",
        "width=600,height=700,toolbar=no,location=yes,scrollbars=yes",
      );
      if (!popup) {
        toast({
          title: "Popup blocked",
          description:
            "Allow popups for this site, then try Sign in with Steam again.",
          variant: "destructive",
        });
        return;
      }
      closePendingWindowRef.current = () => {
        if (!popup.closed) popup.close();
      };
      setSigningIn(true);
    }
  }, [toast]);

  // ── SteamID64 field change handler ────────────────────────────────────────

  const resolveVanityUrl = useCallback(
    async (vanityName: string, raw: string) => {
      const apiKey = form.getValues("apiKey");
      if (!apiKey || !API_KEY_RE.test(apiKey)) {
        setVanityStatus({
          variant: "info",
          message:
            "Enter your Steam Web API key first, then Retrom can resolve this custom Steam profile URL.",
        });
        return;
      }

      setVanityStatus({ variant: "info", message: "Resolving…" });
      try {
        const url =
          `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/` +
          `?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(vanityName)}`;
        const res = await fetch(url);
        const json = (await res.json()) as {
          response?: { success?: number; steamid?: string; message?: string };
        };
        const inner = json.response;
        if (inner?.success === 1 && inner.steamid) {
          form.setValue("userId", inner.steamid, {
            shouldDirty: true,
            shouldValidate: true,
          });
          setVanityStatus(null);
        } else {
          setVanityStatus({
            variant: "error",
            message:
              inner?.message ??
              "Could not resolve this Steam profile URL. Check the name and try again.",
          });
        }
      } catch {
        setVanityStatus({
          variant: "error",
          message:
            "Could not resolve this Steam profile URL. If you are using the web client, this may be a browser CORS restriction — try the desktop app.",
        });
        form.setValue("userId", raw, { shouldDirty: true });
      }
    },
    [form],
  );

  const handleUserIdChange = useCallback(
    (raw: string) => {
      setVanityStatus(null);
      const parsed = parseUserIdInput(raw);

      if (parsed.kind === "profiles-url") {
        form.setValue("userId", parsed.value, {
          shouldDirty: true,
          shouldValidate: true,
        });
        return;
      }

      if (parsed.kind === "vanity-url") {
        form.setValue("userId", raw, { shouldDirty: true });
        void resolveVanityUrl(parsed.name, raw);
        return;
      }

      form.setValue("userId", parsed.kind === "id64" ? parsed.value : raw, {
        shouldDirty: true,
        shouldValidate: parsed.kind === "id64",
      });
    },
    [form, resolveVanityUrl],
  );

  // ── Form submit ────────────────────────────────────────────────────────────

  const handleSubmit = useCallback(
    (values: z.infer<typeof steamSchema>) => {
      try {
        update({
          config: {
            ...props.currentConfig,
            steam: create(SteamConfigSchema, values),
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
    <TabsContent value="steam">
      <div className="my-4 max-w-[55ch]">
        <p className="text-muted-foreground text-sm">
          Retrom can import your full Steam library using your SteamID64 and
          Steam Web API key. Your Steam password is never shared with Retrom.{" "}
          <a
            href="https://github.com/JMBeresford/retrom#steam"
            target="_blank"
            className="underline text-accent-text"
            rel="noreferrer"
          >
            learn more
          </a>
        </p>
      </div>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(handleSubmit)}
          className="flex flex-col gap-2"
        >
          {/* ── SteamID64 field ─────────────────────────────────────────── */}
          <FormField
            control={form.control}
            name="userId"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center justify-between">
                  <FormLabel>SteamID64</FormLabel>
                  {signingIn ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <LoaderCircleIcon className="animate-spin h-3 w-3" />
                      Signing in…
                      <button
                        type="button"
                        onClick={cancelSignIn}
                        className="underline cursor-pointer"
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSteamSignIn}
                      className="flex items-center gap-1 text-xs underline text-accent-text cursor-pointer"
                    >
                      <SteamIcon className="h-3 w-3" />
                      Sign in with Steam
                    </button>
                  )}
                </div>

                <FormControl>
                  <Input
                    {...field}
                    placeholder="76561198000000000"
                    onChange={(e) => {
                      handleUserIdChange(e.target.value);
                    }}
                  />
                </FormControl>

                {vanityStatus ? (
                  <p
                    className={
                      vanityStatus.variant === "error"
                        ? "text-sm text-destructive"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {vanityStatus.message}
                  </p>
                ) : (
                  <FormDescription>
                    Sign in with Steam above to auto-fill, or paste a SteamID64
                    or a Steam profile URL (
                    <code className="text-xs">/profiles/&lt;id&gt;</code> or{" "}
                    <code className="text-xs">/id/&lt;name&gt;</code>
                    ).
                  </FormDescription>
                )}

                <FormMessage />
              </FormItem>
            )}
          />

          {/* ── Steam API Key field ──────────────────────────────────────── */}
          <FormField
            control={form.control}
            name="apiKey"
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
                    Open Steam API Key page
                  </a>
                </div>
                <FormControl>
                  <Input type="password" {...field} />
                </FormControl>
                <FormDescription>
                  Create or view your Steam Web API key on Steam, then paste it
                  here.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <DialogFooter className="gap-2">
            <Button
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
