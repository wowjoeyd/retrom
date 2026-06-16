import { ActionButton as ActionButtonImpl } from "@/components/action-button";
import {
  FocusContainer,
  useFocusable,
} from "@/components/fullscreen/focus-container";
import { GameActions } from "@/components/fullscreen/game-actions";
import { Scene } from "@/components/fullscreen/scene";
import { getFileStub, Image } from "@/lib/utils";
import { GameDetailProvider, useGameDetail } from "@/providers/game-details";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { buttonVariants } from "@retrom/ui/components/button";
import { ScrollArea } from "@retrom/ui/components/scroll-area";
import { cn } from "@retrom/ui/lib/utils";
import {
  CatchBoundary,
  createLazyFileRoute,
  useNavigate,
} from "@tanstack/react-router";
import { Background } from "./-components/background";
import { StatsStrip } from "./-components/stats-strip";
import { MusicPanel } from "./-components/music-panel";
import {
  DetailTabs,
  DETAIL_TAB_KEYS,
  type TabKey,
} from "./-components/detail-tabs";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { useGameMetadata } from "@/queries/useGameMetadata";
import { Suspense, useEffect, useRef, useState } from "react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useInputDeviceContext } from "@/providers/input-device";
import { createUrl, usePublicUrl } from "@/utils/urls";
import {
  gameMusicPlayer,
  isAudioUrl,
  useGameMusic,
} from "@/components/fullscreen/grid-game-list";
import { useHotkeys } from "@/providers/hotkeys";
import { useActionBar } from "@/providers/fullscreen/action-bar-context";
import { ActionBar } from "@/components/fullscreen/action-bar";

export const Route = createLazyFileRoute(
  "/_fullscreenLayout/fullscreen/games/$gameId",
)({
  component: GameComponent,
});

function GameComponent() {
  const { gameId } = Route.useParams();

  const gameIdNumber = gameId ? parseInt(gameId, 10) : 0;

  const { enabled, volume, fade } = useGameMusic(
    Number.isFinite(gameIdNumber) ? gameIdNumber : 0,
  );
  const { data: meta } = useGameMetadata({
    request: { gameIds: [gameIdNumber] },
    selectFn: (d) => ({
      metadata: d.metadata.at(0),
      mediaPaths: d.mediaPaths,
    }),
  });
  const metaData = meta?.metadata;
  const allVideoUrls = metaData?.videoUrls ?? [];
  const mp = meta?.mediaPaths;
  // mediaPaths is typed as { [key: number]: GetGameMetadataResponse_MediaPaths } (protobuf-es plain object)
  const mediaPathEntry = mp?.[gameIdNumber];
  const themeAudioRel = mediaPathEntry?.themeAudioUrl;
  const publicUrl = usePublicUrl();
  let resolvedThemeAudio =
    themeAudioRel && publicUrl
      ? createUrl({ path: themeAudioRel, base: publicUrl })?.href
      : undefined;
  if (!resolvedThemeAudio && publicUrl) {
    // Robust fallback using magic base "theme" (no ext). See grid list.
    const possiblePath = `media/games/${gameIdNumber}/theme`;
    resolvedThemeAudio = createUrl({
      path: possiblePath,
      base: publicUrl,
    })?.href;
  }
  // Strictly prefer native audio (theme from yt-dlp extraction in metadata jobs,
  // with substantial chunks for good loops, or direct audio files). No YT fallback.
  const audioFromList = allVideoUrls.find(isAudioUrl);
  const musicSourceUrl = resolvedThemeAudio ?? audioFromList;

  if (import.meta.env.DEV) {
    console.log(
      "[fullscreen music detail] game",
      gameIdNumber,
      "enabled (from hook below)",
      "musicSource=",
      musicSourceUrl,
      "has themeAudio=",
      !!resolvedThemeAudio,
      "rawThemeRel=",
      themeAudioRel,
      "hasPublicUrl=",
      !!publicUrl,
      "videoUrls.len=",
      allVideoUrls.length,
      "firstVideoUrl=",
      allVideoUrls[0],
    );
  }

  useEffect(() => {
    if (enabled && metaData) {
      // Pass only audio candidates -- no YT for previews.
      const audioCandidates = allVideoUrls.filter(isAudioUrl);
      void gameMusicPlayer.playForGame(
        musicSourceUrl,
        volume,
        fade,
        metaData.name,
        audioCandidates,
      );
    }
    return () => {
      if (enabled) gameMusicPlayer.stop(fade, musicSourceUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    gameIdNumber,
    enabled,
    volume,
    fade,
    metaData,
    musicSourceUrl,
    allVideoUrls.length,
  ]);

  return (
    <GameDetailProvider
      gameId={gameIdNumber}
      errorRedirectUrl="/fullscreen"
      loadingComponent={<LoadingDetail />}
      deferEmulatorData
    >
      <Inner />
    </GameDetailProvider>
  );
}

function LoadingDetail() {
  const navigate = useNavigate();

  const backHandler = () =>
    navigate({ to: "/fullscreen", search: (prev) => prev, resetScroll: false });

  useHotkeys({ handlers: { BACK: { handler: backHandler } } });

  return (
    <HotkeyLayer
      id="game-page-loading"
      handlers={{ BACK: { handler: backHandler } }}
    >
      <div className="h-full flex flex-col">
        <ScrollArea className="flex-1 min-h-0 w-full">
          <div className="flex-grow flex justify-center items-center w-full pb-32">
            <div className="flex flex-col w-full h-full relative">
              <div
                className={cn(
                  "relative min-h-full w-full",
                  "grid grid-rows-[1fr_auto_auto_auto]",
                  "*:col-start-1 *:col-end-1",
                )}
              >
                <div className="relative h-[75dvh] row-start-1 row-end-3 -z-[1] overflow-hidden bg-background">
                  <div className="absolute inset-0 bg-gradient-to-t from-background to-20% to-background/0" />
                </div>

                <div className="row-start-2 row-end-4 flex justify-center gap-1">
                  <div className="h-20 w-52 bg-secondary/30 animate-pulse" />
                  <div className="h-20 w-12 bg-secondary/30 animate-pulse" />
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
        <ActionBar />
      </div>
    </HotkeyLayer>
  );
}

const buttonStyles = cn(
  buttonVariants({ variant: "secondary", size: "lg" }),
  "font-bold w-auto text-2xl uppercase px-8 h-16 rounded-md",
  "ring-ring focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-offset-0",
  "opacity-90 focus-hover:opacity-100 transition-all",
  '[&_div[role="progressbar"]]:w-[6ch] [&_div[role="progressbar"]]:bg-primary-foreground',
  '[&_div[role="progressbar"]_>_*]:bg-accent',
);

function Inner() {
  const { gameMetadata, game, extraMetadata } = useGameDetail();
  const navigate = useNavigate();
  const publicUrl = usePublicUrl();
  const scrollWrapRef = useRef<HTMLDivElement>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("info");

  const goBack = () =>
    navigate({ to: "/fullscreen", search: (prev) => prev, resetScroll: false });

  // LB/RB (and D-pad on the tab row) cycle tabs from anywhere on the page.
  // Registered on the page HotkeyLayer so an open sheet/dialog (portaled, with
  // focus trapped inside it) never receives these — its own handlers win.
  const cycleTab = (dir: 1 | -1) => {
    setActiveTab((current) => {
      const i = DETAIL_TAB_KEYS.indexOf(current);
      const nextKey =
        DETAIL_TAB_KEYS[
          (i + dir + DETAIL_TAB_KEYS.length) % DETAIL_TAB_KEYS.length
        ];
      requestAnimationFrame(() => setFocus(`detail-tab-${nextKey}`));
      return nextKey;
    });
  };

  // LB/RB tab hints now live inline with the tab rail (see DetailTabs), so the
  // bottom bar carries only the global/detail actions.
  useActionBar([
    { hotkey: "MENU", label: "Menu" },
    { hotkey: "ACCEPT", label: "Select" },
    { hotkey: "BACK", label: "Back" },
  ]);

  // Document-level BACK listener so the handler fires even before any DOM
  // element inside this page has native focus (e.g. during lazy-load or before
  // the initialFocus useEffect commits native focus to ActionButton).
  // The HotkeyLayer below still handles BACK when an inner element is focused
  // and stops propagation first; this is the safety-net path.
  useHotkeys({ handlers: { BACK: { handler: goBack } } });

  // Controller scroll: when focus lands on a control below the fold, reveal it
  // within the ScrollArea viewport. block:"nearest" + behavior:"instant" is a
  // no-op when the control is already visible, so the initial Play focus never
  // scrolls (preserves the no-flash entry) and there are no smooth-scroll jumps.
  useEffect(() => {
    const viewport = scrollWrapRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]",
    );
    if (!viewport) return;

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || !viewport.contains(target)) return;
      target.scrollIntoView({ block: "nearest", behavior: "instant" });
    };

    viewport.addEventListener("focusin", onFocusIn);
    return () => viewport.removeEventListener("focusin", onFocusIn);
  }, []);

  const name = gameMetadata?.name || getFileStub(game.path);

  const coverUrl = (() => {
    const local = extraMetadata?.mediaPaths?.coverUrl;
    if (local && publicUrl) {
      return createUrl({ path: local, base: publicUrl })?.href;
    }
    return gameMetadata?.coverUrl;
  })();

  return (
    <HotkeyLayer
      id="game-page"
      handlers={{
        BACK: { handler: goBack },
        PAGE_LEFT: { handler: () => cycleTab(-1) },
        PAGE_RIGHT: { handler: () => cycleTab(1) },
      }}
    >
      <div ref={scrollWrapRef} className="flex h-full flex-col">
        <ScrollArea className="min-h-0 w-full flex-1">
          <FocusContainer
            opts={{ focusKey: "game-details", forceFocus: true }}
            className="relative block w-full"
          >
            {/* Cinematic hero backdrop — animated art that fades into the page.
                Absolutely positioned so the content deck can tuck into its lower
                gradient without a giant title pushing everything down. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[66dvh] overflow-hidden">
              <CatchBoundary
                getResetKey={() => "resetBg"}
                onCatch={(error) => console.error(error)}
                errorComponent={() =>
                  coverUrl ? (
                    <div className="absolute inset-0">
                      <img
                        src={coverUrl}
                        className="h-full w-full object-cover opacity-60"
                      />
                    </div>
                  ) : null
                }
              >
                <Scene>
                  <CatchBoundary
                    getResetKey={() => `background-${game.id}`}
                    onCatch={(error) => console.error(error)}
                    errorComponent={() => null}
                  >
                    <Suspense fallback={null}>
                      <Background />
                    </Suspense>
                  </CatchBoundary>
                </Scene>
              </CatchBoundary>

              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/70 to-background/0" />
              <div className="absolute inset-0 bg-gradient-to-r from-background/70 via-transparent to-transparent" />
            </div>

            {/* Content column — a glass control deck tucked into the lower hero,
                followed by the centered tab chrome. One consistent max-width keeps
                the deck, tab rail, and content visually aligned. */}
            <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 pb-28 pt-[24dvh]">
              {/* Control deck — title, cover, primary actions, metadata chips, and
                  the soundtrack module gathered into one cohesive Retrom-purple
                  glass panel instead of separate floating pieces. */}
              <section className="relative overflow-hidden rounded-2xl border border-border/60 bg-background/40 p-6 shadow-2xl backdrop-blur-xl sm:p-8">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent"
                />
                <div
                  aria-hidden
                  className="pointer-events-none absolute -left-20 -top-20 h-52 w-52 rounded-full bg-accent/10 blur-3xl"
                />

                <div className="relative flex flex-col gap-6">
                  <div className="flex items-end gap-6">
                    {coverUrl && (
                      <div className="hidden h-52 w-36 shrink-0 overflow-hidden rounded-xl border border-border/60 bg-muted shadow-2xl sm:block">
                        <Image
                          src={coverUrl}
                          alt={name}
                          className="h-full w-full object-cover"
                        />
                      </div>
                    )}

                    <div className="flex min-w-0 flex-1 flex-col gap-5">
                      <h1 className="line-clamp-2 text-balance text-5xl font-black uppercase leading-[0.95] tracking-tight text-foreground drop-shadow-[0_2px_16px_rgba(0,0,0,0.7)] lg:text-6xl">
                        {name}
                      </h1>

                      <div className="flex items-stretch gap-3">
                        <div className="w-min">
                          <ActionButton />
                        </div>
                        <GameActions />
                      </div>

                      <StatsStrip />
                    </div>
                  </div>

                  <MusicPanel />
                </div>
              </section>

              <DetailTabs active={activeTab} onChange={setActiveTab} />
            </div>
          </FocusContainer>
        </ScrollArea>
        <ActionBar />
      </div>
    </HotkeyLayer>
  );
}

function ActionButton() {
  const { game } = useGameDetail();
  const installationStatus = useInstallationStatus(game.id);
  const [inputDevice] = useInputDeviceContext();
  // hasFocused: prevents re-running the initial-focus setup after it succeeds.
  const hasFocused = useRef(false);
  // isFirstFocus: skips scrollIntoView on the very first norigin onFocus so
  // the query-resolution scroll (which fires ~200 ms after mount) isn't visible
  // as a "page refresh". Subsequent navigation-triggered focuses still scroll.
  const isFirstFocus = useRef(true);

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: "fullscreen-action-button",
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      if (!isFirstFocus.current) {
        node.scrollIntoView({ block: "end" });
      }
      isFirstFocus.current = false;
    },
  });

  // The play button may mount as disabled (play-status query pending). Browsers
  // silently drop .focus() on disabled elements, so we watch for the disabled
  // attribute to clear and then set norigin focus once the node is interactive.
  // We defer via requestAnimationFrame so the call lands after React has fully
  // committed its current batch and norigin has re-registered any focusables.
  useEffect(() => {
    if (hasFocused.current) return;
    if (!["gamepad", "hotkeys"].includes(inputDevice)) return;

    const node = ref.current;
    if (!node) return;

    let rafId: number;

    const doFocus = () => {
      if (hasFocused.current) return;
      hasFocused.current = true;
      setFocus("fullscreen-action-button");
    };

    if (!node.disabled) {
      rafId = requestAnimationFrame(doFocus);
      return () => cancelAnimationFrame(rafId);
    }

    const observer = new MutationObserver(() => {
      if (!node.disabled) {
        observer.disconnect();
        rafId = requestAnimationFrame(doFocus);
      }
    });
    observer.observe(node, { attributes: true, attributeFilter: ["disabled"] });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
    };
    // ref is stable (norigin ref object); omitted from deps intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputDevice]);

  return (
    <HotkeyLayer
      id="fullscreen-action-button"
      handlers={{ ACCEPT: { handler: () => ref.current?.click() } }}
    >
      <ActionButtonImpl
        ref={ref}
        game={game}
        className={cn(
          buttonStyles,
          installationStatus !== InstallationStatus.INSTALLING &&
            "focus:bg-accent",
        )}
      />
    </HotkeyLayer>
  );
}
