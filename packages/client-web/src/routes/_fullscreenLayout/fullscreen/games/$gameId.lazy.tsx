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
import { Description } from "./-components/description";
import { ExtraInfo } from "./-components/extra-info";
import { Name } from "./-components/name";
import { SimilarGames } from "./-components/similar-games";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { useGameMetadata } from "@/queries/useGameMetadata";
import { Suspense, useEffect, useRef } from "react";
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
  "font-bold w-auto text-5xl uppercase px-8 py-4 h-full rounded-none",
  "ring-ring focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-offset-0",
  "opacity-80 focus-hover:opacity-100 transition-all",
  '[&_div[role="progressbar"]]:w-[6ch] [&_div[role="progressbar"]]:bg-primary-foreground',
  '[&_div[role="progressbar"]_>_*]:bg-accent',
);

function Inner() {
  const { gameMetadata, game } = useGameDetail();
  const navigate = useNavigate();

  useActionBar([
    { hotkey: "BACK", label: "Back" },
    { hotkey: "ACCEPT", label: "Play" },
    { hotkey: "PAGE_LEFT", label: "Actions" },
    { hotkey: "MENU", label: "Menu" },
  ]);

  // Document-level BACK listener so the handler fires even before any DOM
  // element inside this page has native focus (e.g. during lazy-load or before
  // the initialFocus useEffect commits native focus to ActionButton).
  // The HotkeyLayer below still handles BACK when an inner element is focused
  // and stops propagation first; this is the safety-net path.
  useHotkeys({
    handlers: {
      BACK: {
        handler: () =>
          navigate({
            to: "/fullscreen",
            search: (prev) => prev,
            resetScroll: false,
          }),
      },
    },
  });

  const name = gameMetadata?.name || getFileStub(game.path);
  const url = gameMetadata?.backgroundUrl || gameMetadata?.coverUrl;

  return (
    <HotkeyLayer
      id="game-page"
      handlers={{
        BACK: {
          handler: () =>
            navigate({
              to: "/fullscreen",
              search: (prev) => prev,
              resetScroll: false,
            }),
        },
      }}
    >
      <div className="h-full flex flex-col">
        <ScrollArea className="flex-1 min-h-0 w-full">
          <FocusContainer
            opts={{
              focusKey: "game-details",
              forceFocus: true,
            }}
            className="flex-grow flex justify-center items-center w-full pb-32"
          >
            <div className={cn("flex flex-col w-full h-full relative")}>
              <div
                className={cn(
                  "relative min-h-full w-full",
                  "grid grid-rows-[1fr_auto_auto_auto]",
                  "*:col-start-1 *:col-end-1",
                )}
              >
                <div className="relative h-[75dvh] row-start-1 row-end-3 -z-[1] overflow-hidden">
                  <CatchBoundary
                    getResetKey={() => "resetBg"}
                    onCatch={(error) => console.error(error)}
                    errorComponent={() => (
                      <div className="absolute inset-0 grid place-items-center">
                        <img src={url} className=""></img>
                      </div>
                    )}
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
                      <Name name={name} />
                    </Scene>
                  </CatchBoundary>

                  <div className="absolute inset-0 bg-gradient-to-t from-background to-20% to-background/0" />
                </div>

                <div className="row-start-2 row-end-4 flex justify-center gap-1">
                  <div className="w-min">
                    <ActionButton />
                  </div>

                  <GameActions />
                </div>

                <div className="row-start-4 my-8 flex flex-col gap-12 w-max max-w-[85ch] mx-auto items-stretch">
                  <ExtraInfo />
                  <Description description={gameMetadata?.description || ""} />
                  <SimilarGames />
                </div>
              </div>
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
