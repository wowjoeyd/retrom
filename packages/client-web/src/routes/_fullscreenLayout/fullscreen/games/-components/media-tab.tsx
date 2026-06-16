import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@retrom/ui/components/dialog";
import { cn } from "@retrom/ui/lib/utils";
import {
  FocusableElement,
  FocusContainer,
  useFocusable,
} from "@/components/fullscreen/focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { Hotkey } from "@/providers/hotkeys";
import { useHotkeyMapping } from "@/providers/hotkeys/mapping";
import { GamepadButtonDownEvent } from "@/providers/gamepad/event";
import { HotkeyIcon } from "@/components/fullscreen/hotkey-button";
import { Image } from "@/lib/utils";
import { useGameDetail } from "@/providers/game-details";

// Screenshots first, then artwork — both are still images, so they share the
// same gallery + viewer. Capped so a pathological metadata blob can't render
// thousands of focusables into the page.
const MAX_MEDIA = 40;

export function MediaTab() {
  const { gameMetadata } = useGameDetail();

  const media = [
    ...(gameMetadata?.screenshotUrls ?? []),
    ...(gameMetadata?.artworkUrls ?? []),
  ]
    .filter(Boolean)
    .slice(0, MAX_MEDIA);

  // The originating thumbnail index: drives both which image the viewer opens
  // on and where focus is restored to on close. null = viewer closed.
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (media.length === 0) {
    return (
      <FocusableElement
        opts={{
          focusKey: "detail-media-empty",
          onFocus: ({ node }) => node?.focus({ preventScroll: true }),
        }}
        render={(ref: RefObject<HTMLDivElement>) => (
          <div
            ref={ref}
            tabIndex={-1}
            className={cn(
              "flex flex-col items-center justify-center gap-3 rounded-xl py-16 text-center outline-none",
              "border border-dashed border-border/60 bg-muted/10 text-muted-foreground",
              "transition-colors focus-hover:border-accent/60",
            )}
          >
            <ImageOff size={40} className="opacity-40" />
            <div className="flex flex-col gap-1">
              <p className="text-base font-semibold text-foreground/80">
                No media yet
              </p>
              <p className="text-sm">
                Screenshots and artwork will appear here once available.
              </p>
            </div>
          </div>
        )}
      />
    );
  }

  return (
    <>
      <FocusContainer
        opts={{ focusKey: "detail-media" }}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        {media.map((url, idx) => (
          <MediaThumb
            key={`${url}-${idx}`}
            url={url}
            idx={idx}
            onOpen={() => setOpenIndex(idx)}
          />
        ))}
      </FocusContainer>

      {openIndex !== null && (
        <MediaViewer
          media={media}
          initialIndex={openIndex}
          onClose={() => {
            const restore = openIndex;
            setOpenIndex(null);
            requestAnimationFrame(() => setFocus(`detail-media-${restore}`));
          }}
        />
      )}
    </>
  );
}

function MediaThumb(props: { url: string; idx: number; onOpen: () => void }) {
  const { url, idx, onOpen } = props;
  const [failed, setFailed] = useState(false);

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: `detail-media-${idx}`,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  return (
    <HotkeyLayer
      handlers={{
        ACCEPT: { handler: onOpen, actionBar: { label: "View" } },
      }}
    >
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onOpen}
        className={cn(
          "group relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-muted outline-none",
          "scale-[0.98] transition-all duration-200 focus-hover:scale-100",
          "focus:ring-[length:var(--fs-focus-ring-width)] focus:ring-ring focus:ring-offset-0",
          "focus-hover:border-accent/70 focus-hover:shadow-[0_0_28px_-6px_var(--color-accent)]",
        )}
      >
        {failed ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <ImageOff size={24} className="opacity-50" />
            <span className="text-xs">Unavailable</span>
          </div>
        ) : (
          <Image
            src={url}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        )}

        {/* Index badge for couch orientation against the fullscreen viewer. */}
        <span className="absolute bottom-1.5 left-1.5 rounded-md bg-background/75 px-1.5 py-0.5 text-[0.65rem] font-bold tabular-nums text-foreground/90 backdrop-blur-sm">
          {idx + 1}
        </span>
      </button>
    </HotkeyLayer>
  );
}

function MediaViewer(props: {
  media: string[];
  initialIndex: number;
  onClose: () => void;
}) {
  const { media, initialIndex, onClose } = props;

  // The viewer owns its own index so flipping never round-trips through a
  // parent re-render (and never fights focus restoration on close).
  const [index, setIndex] = useState(initialIndex);
  const [failed, setFailed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const { keyboardToHotkey, gamepadToHotkey } = useHotkeyMapping();

  const go = useCallback(
    (delta: 1 | -1) => {
      setFailed(false);
      setIndex((i) => (i + delta + media.length) % media.length);
    },
    [media.length],
  );
  const prev = useCallback(() => go(-1), [go]);
  const next = useCallback(() => go(1), [go]);

  // The focusable stage is a real <button> so DOM focus reliably lands inside
  // the portaled dialog; controller/key events dispatched on it then bubble
  // through the HotkeyLayer below. The surrounding FocusContainer is a focus
  // boundary so norigin's directional navigation (LEFT/RIGHT/UP/DOWN still
  // bubble to the layout's navigateByDirection) can't escape onto the page
  // behind the dialog — the user only navigates what's in this view.
  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: "media-viewer-stage",
    initialFocus: true,
    forceFocus: true,
    onFocus: ({ node }) => node?.focus({ preventScroll: true }),
  });

  // Radix's FocusScope can lose the race and leave DOM focus on the dialog
  // container (or on the thumbnail behind it) across frames. If focus is not on
  // the stage, gamepad/key events never reach the HotkeyLayer and the viewer
  // appears to ignore input. Re-assert focus every frame until the stage truly
  // holds DOM focus. (Mirrors focusFirstAction in the grid context menu.)
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const node = ref.current;
      if (node && document.activeElement !== node) {
        setFocus("media-viewer-stage");
      }
      const landed = !!node && document.activeElement === node;
      if (!landed && performance.now() - start < 1000) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // ref is a stable norigin ref object; intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Defensive capture for the focus-race window: while DOM focus is still
  // settling and sits on the dialog container itself, the HotkeyLayer (a
  // descendant) never sees the event. Handle flip/close from the container too
  // so input is never dropped. Skips when the stage button holds focus — the
  // HotkeyLayer owns that path then, so this never double-fires.
  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;

    const act = (hotkey: Hotkey | undefined) => {
      switch (hotkey) {
        case "BACK":
          onClose();
          return true;
        case "LEFT":
        case "PAGE_LEFT":
          prev();
          return true;
        case "RIGHT":
        case "PAGE_RIGHT":
          next();
          return true;
        default:
          return false;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement !== node) return;
      if (act(keyboardToHotkey[e.key])) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onGamepad = (e: GamepadButtonDownEvent) => {
      if (document.activeElement !== node) return;
      if (act(gamepadToHotkey[e.detail.button])) e.stopPropagation();
    };

    node.addEventListener("keydown", onKeyDown);
    node.addEventListener(GamepadButtonDownEvent.EVENT_NAME, onGamepad);
    return () => {
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener(GamepadButtonDownEvent.EVENT_NAME, onGamepad);
    };
  }, [keyboardToHotkey, gamepadToHotkey, prev, next, onClose]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        ref={contentRef}
        centered
        userCanClose={false}
        overlayClassName="bg-background/90 backdrop-blur-md"
        className="w-[94vw] max-w-6xl gap-0 border-border/70 bg-background/95 p-0 outline-none focus:outline-none focus-visible:outline-none"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Media viewer</DialogTitle>
        <DialogDescription className="sr-only">
          Use left and right to flip through media; back to close.
        </DialogDescription>

        {/* allowBubbling "on-misses": BACK and the flip keys are handled (and
            so swallowed, never reaching the page behind), but MENU has no
            handler here so it bubbles to the global menubar — the user can
            still open the menu from the viewer. */}
        <HotkeyLayer
          id="media-viewer"
          handlers={{
            BACK: { handler: onClose },
            ACCEPT: { handler: next },
            LEFT: { handler: prev },
            RIGHT: { handler: next },
            PAGE_LEFT: { handler: prev },
            PAGE_RIGHT: { handler: next },
          }}
        >
          <FocusContainer
            opts={{
              focusKey: "media-viewer",
              isFocusBoundary: true,
            }}
            className="flex flex-col"
          >
            <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-t-lg bg-black">
              <button
                ref={ref}
                type="button"
                tabIndex={-1}
                onClick={next}
                aria-label="Next media"
                className="absolute inset-0 flex items-center justify-center outline-none"
              >
                {failed ? (
                  <span className="flex flex-col items-center gap-2 text-muted-foreground">
                    <ImageOff size={48} className="opacity-50" />
                    <span className="text-sm">
                      This media can’t be displayed.
                    </span>
                  </span>
                ) : (
                  <Image
                    key={media[index]}
                    src={media[index]}
                    alt=""
                    onError={() => setFailed(true)}
                    className="max-h-[80vh] max-w-full object-contain"
                  />
                )}
              </button>

              {/* Mouse affordance only; siblings of the stage button (not
                  norigin focusables) so D-pad LEFT/RIGHT stays a flip. */}
              {media.length > 1 && (
                <>
                  <ChevronZone side="left" onClick={prev} />
                  <ChevronZone side="right" onClick={next} />
                </>
              )}

              <span className="pointer-events-none absolute bottom-3 right-4 rounded-md bg-background/80 px-2.5 py-1 text-sm font-semibold tabular-nums text-foreground/90 backdrop-blur-sm">
                {index + 1} / {media.length}
              </span>
            </div>

            <div className="flex items-center justify-center gap-6 border-t border-border/60 bg-muted/10 px-5 py-2.5 text-xs text-muted-foreground">
              {media.length > 1 && (
                <span className="flex items-center gap-2">
                  <span className="flex items-center gap-1">
                    <HotkeyIcon hotkey="LEFT" className="size-6" />
                    <HotkeyIcon hotkey="RIGHT" className="size-6" />
                  </span>
                  <span className="uppercase tracking-wide">Flip</span>
                </span>
              )}
              <span className="flex items-center gap-2">
                <HotkeyIcon hotkey="BACK" className="size-6" />
                <span className="uppercase tracking-wide">Close</span>
              </span>
            </div>
          </FocusContainer>
        </HotkeyLayer>
      </DialogContent>
    </Dialog>
  );
}

function ChevronZone(props: { side: "left" | "right"; onClick: () => void }) {
  const { side, onClick } = props;

  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={side === "left" ? "Previous" : "Next"}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "absolute inset-y-0 z-10 flex w-16 items-center justify-center text-3xl text-foreground/0 outline-none transition-colors",
        "hover:text-foreground/70 hover:bg-background/20",
        side === "left"
          ? "left-0 justify-start pl-3"
          : "right-0 justify-end pr-3",
      )}
    >
      {side === "left" ? "‹" : "›"}
    </button>
  );
}
