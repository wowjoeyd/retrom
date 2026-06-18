import { cn } from "@retrom/ui/lib/utils";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { FocusContainer } from "@/components/fullscreen/focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { HotkeyIcon } from "@/components/fullscreen/hotkey-button";
import { useGameDetail } from "@/providers/game-details";
import { ExtraInfo } from "./extra-info";
import { Description } from "./description";
import { SimilarGames } from "./similar-games";
import { MediaTab } from "./media-tab";
import { AchievementsTab } from "./achievements-tab";

export const DETAIL_TABS = [
  { key: "info", label: "Game Info" },
  { key: "media", label: "Media" },
  { key: "achievements", label: "Achievements" },
  { key: "similar", label: "Similar Games" },
] as const;

export type TabKey = (typeof DETAIL_TABS)[number]["key"];
export const DETAIL_TAB_KEYS: TabKey[] = DETAIL_TABS.map((t) => t.key);

// The tab headers are NOT part of spatial navigation — they're driven purely by
// the LB/RB bumpers (the page-level cycleTab handler) and act as visual
// indicators (still clickable by mouse). Keeping them out of the focus tree is
// what makes the D-pad / thumbstick skip straight from the hero into the active
// tab's content (e.g. Down on the hero → the first media thumbnail), instead of
// landing on a tab header. BACK from content returns to the hero.
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

        <div className="flex gap-1">
          {DETAIL_TABS.map((tab) => (
            <TabButton
              key={tab.key}
              label={tab.label}
              active={active === tab.key}
              onActivate={() => onChange(tab.key)}
            />
          ))}
        </div>

        <BumperHint hotkey="PAGE_RIGHT" />
      </div>

      <HotkeyLayer
        id="detail-tab-content"
        handlers={{
          BACK: { handler: () => setFocus("fullscreen-action-button") },
        }}
      >
        {/* Wide content deck — a card that mirrors the control deck above so the
            active tab content sits in a deliberate, aligned surface rather than
            floating in dead space. The region id lets the page's bumper handler
            tell whether focus is currently inside the content. */}
        <FocusContainer
          id="detail-tab-content-region"
          opts={{ focusKey: "detail-tab-content" }}
          className="min-h-[16rem] rounded-2xl border border-border/60 bg-background/30 p-6 backdrop-blur-sm sm:p-8"
        >
          {active === "info" && <InfoTab />}
          {active === "media" && <MediaTab />}
          {active === "achievements" && <AchievementsTab />}
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

// Visual-only tab header. Not spatially focusable (controller switches tabs with
// LB/RB); still mouse-clickable.
function TabButton(props: {
  label: string;
  active: boolean;
  onActivate: () => void;
}) {
  const { label, active, onActivate } = props;

  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={onActivate}
      className={cn(
        "relative px-5 py-3 text-lg font-bold uppercase tracking-wide outline-none transition-colors",
        active ? "text-accent-text" : "text-muted-foreground",
        "hover:text-foreground",
        "after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-full after:transition-all",
        active ? "after:bg-accent" : "after:bg-transparent",
      )}
    >
      {label}
    </button>
  );
}

function InfoTab() {
  const { gameMetadata, extraMetadata } = useGameDetail();
  const description = gameMetadata?.description || "";
  const genres = extraMetadata?.genres?.value ?? [];

  return (
    <div className="flex flex-col gap-8">
      <ExtraInfo />

      {/* About block: structured ingested metadata grouped above the
          description. Only genres are currently ingested into the queryable
          model; other IGDB/Steam facets (developer, publisher, modes, rating)
          aren't stored, so they're omitted rather than invented. */}
      {genres.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[0.65rem] font-bold uppercase tracking-[0.15em] text-muted-foreground">
            Genres
          </span>
          <div className="flex flex-wrap gap-2">
            {genres.map((genre) => (
              <span
                key={genre.id || genre.slug || genre.name}
                className="rounded-full border border-border/60 bg-muted/30 px-3 py-1 text-sm font-semibold text-foreground/85"
              >
                {genre.name}
              </span>
            ))}
          </div>
        </div>
      )}

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
