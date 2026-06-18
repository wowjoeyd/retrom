import { ActionButton as ActionButtonImpl } from "@/components/action-button";
import {
  FocusContainer,
  useFocusable,
} from "@/components/fullscreen/focus-container";
import { GameActions } from "@/components/fullscreen/game-actions";
import { Scene } from "@/components/fullscreen/scene";
import { getFileStub } from "@/lib/utils";
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
import { SoundtrackConsole } from "./-components/soundtrack-console";
import { AchievementsChip } from "./-components/achievements-chip";
import { DetailReticle } from "./-components/reticle";
import { HotkeyIcon } from "@/components/fullscreen/hotkey-button";
import {
  DetailTabs,
  DETAIL_TAB_KEYS,
  type TabKey,
} from "./-components/detail-tabs";
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

// Primary action: a bold purple-gradient PLAY/INSTALL — the brightest element
// on screen. The bound ACCEPT glyph is overlaid by the ActionButton wrapper.
const buttonStyles = cn(
  buttonVariants({ variant: "accent", size: "lg" }),
  "relative h-16 w-auto rounded-xl pl-7 pr-14 text-2xl font-black uppercase tracking-wide text-white",
  "bg-[linear-gradient(135deg,var(--color-accent-text),var(--color-accent))]",
  "shadow-[0_0_34px_-6px_var(--color-accent)]",
  "ring-ring focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-offset-0",
  "transition-all focus-hover:-translate-y-0.5 focus-hover:brightness-110 focus-hover:shadow-[0_0_44px_-4px_var(--color-accent)]",
  '[&_div[role="progressbar"]]:w-[6ch] [&_div[role="progressbar"]]:bg-primary-foreground',
  '[&_div[role="progressbar"]_>_*]:bg-accent',
);

function Inner() {
  const { gameMetadata, game, extraMetadata } = useGameDetail();
  const navigate = useNavigate();
  const publicUrl = usePublicUrl();
  const scrollWrapRef = useRef<HTMLDivElement>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("info");
  // Actions panel open state is lifted so the page-level Ⓨ (SORT) hotkey can
  // open it from anywhere, while the trigger button still opens it on ACCEPT.
  const [actionsOpen, setActionsOpen] = useState(false);

  const goBack = () =>
    navigate({ to: "/fullscreen", search: (prev) => prev, resetScroll: false });

  const goToAchievements = () => {
    setActiveTab("achievements");
    requestAnimationFrame(() => setFocus("detail-tab-achievements"));
  };

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
    { hotkey: "SORT", label: "Actions" },
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
        SORT: { handler: () => setActionsOpen(true) },
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
            {/* Full-bleed cinematic hero art. Stays art-forward — no contained
                panel — with a graceful blurred-cover fallback beneath the scene
                for games that have no dedicated background art. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[72dvh] overflow-hidden">
              {coverUrl && (
                <img
                  src={coverUrl}
                  aria-hidden
                  className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
                />
              )}
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

              {/* Bottom-up scrim guarantees the title/controls stay legible on
                  any art, bright or dark. */}
              <div className="absolute inset-0 bg-gradient-to-t from-background via-background/85 to-background/10" />
              <div className="absolute inset-0 bg-gradient-to-r from-background/80 via-background/20 to-transparent" />
            </div>

            <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-10 px-[max(2rem,4vw)] pb-28 pt-[34dvh]">
              {/* Hero lower band: left cluster (title + actions) and the right
                  cluster (soundtrack + achievements) reflow and never overlap. */}
              <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-8">
                <div className="flex min-w-0 max-w-3xl flex-1 flex-col gap-6">
                  <h1
                    className={cn(
                      "-ml-1 line-clamp-2 text-balance font-black uppercase tracking-tight text-white",
                      "text-[clamp(2.75rem,7vw,5.5rem)] leading-[0.92]",
                      "drop-shadow-[0_3px_24px_rgba(0,0,0,0.85)]",
                    )}
                  >
                    {name}
                  </h1>

                  <div className="flex flex-wrap items-center gap-3">
                    <ActionButton />
                    <GameActions
                      open={actionsOpen}
                      onOpenChange={setActionsOpen}
                    />
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-4">
                  <SoundtrackConsole />
                  <AchievementsChip onActivate={goToAchievements} />
                </div>
              </div>

              <DetailTabs active={activeTab} onChange={setActiveTab} />
            </div>
          </FocusContainer>
        </ScrollArea>
        <ActionBar />
      </div>

      {/* Signature focus reticle — tracks the real spatial focus across the
          hero, tabs, content, actions panel, and media viewer. */}
      <DetailReticle />
    </HotkeyLayer>
  );
}

function ActionButton() {
  const { game } = useGameDetail();
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
      {/* The bound ACCEPT glyph is baked into the primary action (right inset,
          with pr-14 reserved in buttonStyles). pointer-events-none so it never
          intercepts the click. */}
      <div className="relative w-min">
        <ActionButtonImpl ref={ref} game={game} className={buttonStyles} />
        <span
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
        >
          <HotkeyIcon hotkey="ACCEPT" className="size-7" />
        </span>
      </div>
    </HotkeyLayer>
  );
}
