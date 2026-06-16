import { cn } from "@retrom/ui/lib/utils";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import {
  FocusContainer,
  useFocusable,
} from "@/components/fullscreen/focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { HotkeyIcon } from "@/components/fullscreen/hotkey-button";
import { useGameDetail } from "@/providers/game-details";
import { ExtraInfo } from "./extra-info";
import { Description } from "./description";
import { SimilarGames } from "./similar-games";
import { MediaTab } from "./media-tab";

export const DETAIL_TABS = [
  { key: "info", label: "Game Info" },
  { key: "media", label: "Media" },
  { key: "similar", label: "Similar Games" },
] as const;

export type TabKey = (typeof DETAIL_TABS)[number]["key"];
export const DETAIL_TAB_KEYS: TabKey[] = DETAIL_TABS.map((t) => t.key);

// Controller-focusable horizontal tabs. Left/Right moves between tab headers
// (focusing a header also selects it, Steam-style) and LB/RB switch from
// anywhere via the page-level bumper handler. Down enters the content; BACK from
// content returns to the active header; BACK from the header row bubbles to the
// page handler (→ grid).
export function DetailTabs(props: {
  active: TabKey;
  onChange: (key: TabKey) => void;
}) {
  const { active, onChange } = props;

  return (
    <div className="flex flex-col gap-6">
      {/* Centered tab rail flanked by LB/RB bumper hints so tab navigation reads
          inline with the tabs instead of only in the bottom action bar. */}
      <div className="flex items-center justify-center gap-3 border-b border-border/60 sm:gap-5">
        <BumperHint hotkey="PAGE_LEFT" />

        <FocusContainer
          opts={{ focusKey: "detail-tabs" }}
          className="flex gap-1"
        >
          {DETAIL_TABS.map((tab) => (
            <TabButton
              key={tab.key}
              tabKey={tab.key}
              label={tab.label}
              active={active === tab.key}
              onActivate={() => onChange(tab.key)}
            />
          ))}
        </FocusContainer>

        <BumperHint hotkey="PAGE_RIGHT" />
      </div>

      <HotkeyLayer
        id="detail-tab-content"
        handlers={{
          BACK: { handler: () => setFocus(`detail-tab-${active}`) },
        }}
      >
        {/* Wide content deck — a card that mirrors the control deck above so the
            active tab content sits in a deliberate, aligned surface rather than
            floating in dead space. */}
        <FocusContainer
          opts={{ focusKey: "detail-tab-content" }}
          className="min-h-[16rem] rounded-2xl border border-border/60 bg-background/30 p-6 backdrop-blur-sm sm:p-8"
        >
          {active === "info" && <InfoTab />}
          {active === "media" && <MediaTab />}
          {active === "similar" && <SimilarGames />}
        </FocusContainer>
      </HotkeyLayer>
    </div>
  );
}

// Non-focusable bumper glyph shown beside the tab rail. Purely a visual hint —
// the actual tab cycling is handled by the page-level PAGE_LEFT/PAGE_RIGHT
// handlers and D-pad focus movement within the tab FocusContainer.
function BumperHint(props: { hotkey: "PAGE_LEFT" | "PAGE_RIGHT" }) {
  return (
    <HotkeyIcon
      hotkey={props.hotkey}
      aria-hidden
      className="shrink-0 opacity-70"
    />
  );
}

function TabButton(props: {
  tabKey: TabKey;
  label: string;
  active: boolean;
  onActivate: () => void;
}) {
  const { tabKey, label, active, onActivate } = props;

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: `detail-tab-${tabKey}`,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
      onActivate();
    },
  });

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: onActivate } }}>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onActivate}
        className={cn(
          "relative px-5 py-3 text-lg font-bold uppercase tracking-wide outline-none transition-colors",
          active ? "text-accent-text" : "text-muted-foreground",
          "focus-hover:text-foreground",
          "after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-full after:transition-all",
          active ? "after:bg-accent" : "after:bg-transparent",
          "focus-hover:after:bg-accent/60",
        )}
      >
        {label}
      </button>
    </HotkeyLayer>
  );
}

function InfoTab() {
  const { gameMetadata } = useGameDetail();
  const description = gameMetadata?.description || "";

  return (
    <div className="flex flex-col gap-8">
      <ExtraInfo />
      {description ? (
        <Description description={description} />
      ) : (
        <p className="text-muted-foreground">
          No description available for this game.
        </p>
      )}
    </div>
  );
}
