import { Trophy } from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { useFocusable } from "@/components/fullscreen/focus-container";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useGameDetail } from "@/providers/game-details";
import { useGameAchievements } from "./achievements-data";

// Hero mastery chip. Data-driven: only renders when there is a real
// RetroAchievements set for this game. With no RA integration the hook reports
// "not-connected" and the chip hides gracefully — no "0/0".
export function AchievementsChip(props: { onActivate: () => void }) {
  const { onActivate } = props;
  const { game } = useGameDetail();
  const data = useGameAchievements(game.id);

  const { ref } = useFocusable<HTMLButtonElement>({
    focusKey: "detail-achievements-chip",
    focusable: data.status === "ready",
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  if (data.status !== "ready") {
    return null;
  }

  const { unlocked, total } = data.summary;
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;

  return (
    <HotkeyLayer
      handlers={{
        ACCEPT: { handler: onActivate, actionBar: { label: "View" } },
      }}
    >
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onActivate}
        className={cn(
          "group flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3.5 py-2.5 text-left outline-none backdrop-blur-md",
          "scale-[0.98] transition-all duration-200 focus-hover:scale-100 focus-hover:border-accent/60",
        )}
      >
        <Trophy className="size-5 shrink-0 text-amber-400" aria-hidden />
        <div className="flex flex-col gap-1">
          <span className="text-[0.6rem] font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Achievements
          </span>
          <span className="text-sm font-semibold leading-none text-foreground">
            {unlocked} / {total}
          </span>
          <span className="mt-0.5 h-1 w-24 overflow-hidden rounded-full bg-muted/50">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-500"
              style={{ width: `${pct}%` }}
            />
          </span>
        </div>
      </button>
    </HotkeyLayer>
  );
}
