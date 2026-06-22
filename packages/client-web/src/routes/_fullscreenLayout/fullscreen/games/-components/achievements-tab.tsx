import { ReactNode, RefObject, useState } from "react";
import { AlertCircle, Check, LoaderCircle, Lock, Trophy } from "lucide-react";
import { cn } from "@retrom/ui/lib/utils";
import { Button } from "@retrom/ui/components/button";
import { Input } from "@retrom/ui/components/input";
import {
  FocusableElement,
  FocusContainer,
  useFocusable,
} from "@/components/fullscreen/focus-container";
import { useGameDetail } from "@/providers/game-details";
import { useSetAchievementsManualMatch } from "@/mutations/useSetAchievementsManualMatch";
import {
  Achievement,
  AchievementSummary,
  useGameAchievements,
} from "./achievements-data";

export function AchievementsTab() {
  const { game } = useGameDetail();
  const data = useGameAchievements(game.id);

  if (data.status === "loading") {
    return (
      <CenteredState focusKey="detail-achievements-loading">
        <LoaderCircle size={32} className="animate-spin opacity-60" />
        <p className="text-sm text-muted-foreground">Loading achievements…</p>
      </CenteredState>
    );
  }

  if (data.status === "needs-attention") {
    return (
      <CenteredState focusKey="detail-achievements-attention">
        <AlertCircle size={32} className="text-destructive-text opacity-80" />
        <div className="flex flex-col gap-1">
          <p className="text-base font-semibold text-foreground/80">
            Achievements need attention
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            {data.message}
          </p>
        </div>
      </CenteredState>
    );
  }

  if (data.status === "not-configured") {
    return (
      <CenteredState focusKey="detail-achievements-not-configured">
        <Trophy size={36} className="opacity-30" />
        <div className="flex flex-col gap-1">
          <p className="text-base font-semibold text-foreground/80">
            Achievements account not connected
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            Add your account credentials under Settings → Achievements to track
            unlocks, points, and rarity for this game.
          </p>
        </div>
      </CenteredState>
    );
  }

  if (data.status === "not-identified") {
    return (
      <CenteredState focusKey="detail-achievements-not-identified">
        <Trophy size={36} className="opacity-30" />
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-base font-semibold text-foreground/80">
              Game not identified
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              Retrom couldn&apos;t match this game to RetroAchievements from its
              file. Enter its RetroAchievements game ID below to map it
              manually.
            </p>
          </div>
          <ManualMatchForm gameId={game.id} />
        </div>
      </CenteredState>
    );
  }

  if (data.status === "not-supported") {
    return (
      <CenteredState focusKey="detail-achievements-not-supported">
        <Trophy size={36} className="opacity-30" />
        <p className="text-sm text-muted-foreground">
          No achievements available for this game.
        </p>
      </CenteredState>
    );
  }

  if (data.status === "empty") {
    return (
      <CenteredState focusKey="detail-achievements-empty">
        <Trophy size={36} className="opacity-30" />
        <p className="text-sm text-muted-foreground">
          This game has no achievement set.
        </p>
      </CenteredState>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <CompletionHeader summary={data.summary} />

      <FocusContainer
        opts={{ focusKey: "detail-achievements" }}
        className="flex flex-col gap-2"
      >
        {data.achievements.map((a) => (
          <AchievementRow key={a.id} achievement={a} />
        ))}
      </FocusContainer>
    </div>
  );
}

function CompletionHeader(props: { summary: AchievementSummary }) {
  const { unlocked, total, pointsEarned, pointsTotal, hasPoints } =
    props.summary;
  const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;

  return (
    <div className="flex items-center gap-5">
      <div
        className="relative grid size-[4.5rem] place-items-center rounded-full"
        style={{
          background: `conic-gradient(#fbbf24 ${pct}%, color-mix(in srgb, var(--color-muted-foreground) 22%, transparent) ${pct}% 100%)`,
        }}
      >
        <div className="grid size-[3.6rem] place-items-center rounded-full bg-background">
          <span className="text-base font-bold text-amber-400">{pct}%</span>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-lg font-semibold text-foreground">
          {unlocked} of {total} unlocked
        </p>
        {hasPoints && (
          <p className="text-sm text-muted-foreground">
            {pointsEarned} of {pointsTotal} points earned
          </p>
        )}
      </div>
    </div>
  );
}

function AchievementRow(props: { achievement: Achievement }) {
  const { achievement } = props;
  const { id, title, description, unlocked, iconUrl } = achievement;

  const { ref } = useFocusable<HTMLDivElement>({
    focusKey: `detail-achievement-${id}`,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: "nearest" });
    },
  });

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={cn(
        "flex items-center gap-4 rounded-xl border border-border/50 bg-muted/10 px-4 py-3 outline-none transition-all",
        "scale-[0.99] focus-hover:scale-100 focus-hover:border-accent/60",
        !unlocked && "opacity-55",
      )}
    >
      <div
        className={cn(
          "grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg",
          unlocked
            ? "bg-emerald-500/15 text-emerald-400"
            : "bg-muted/40 text-muted-foreground",
        )}
      >
        {iconUrl ? (
          <img
            src={iconUrl}
            alt=""
            className={cn("size-full object-cover", !unlocked && "grayscale")}
          />
        ) : unlocked ? (
          <Check size={20} />
        ) : (
          <Lock size={18} />
        )}
      </div>

      <div className="flex min-w-0 flex-col">
        <span className="truncate font-semibold text-foreground">{title}</span>
        <span className="truncate text-sm text-muted-foreground">
          {description}
        </span>
      </div>

      <AchievementMetric achievement={achievement} />
    </div>
  );
}

// RetroAchievements awards points; Steam awards none but exposes global rarity.
// Show whichever the provider supplied — points take precedence.
function AchievementMetric(props: { achievement: Achievement }) {
  const { points, rarityPercent } = props.achievement;

  if (points != null && points > 0) {
    return (
      <span className="ml-auto shrink-0 text-sm font-semibold text-amber-400">
        {points} pts
      </span>
    );
  }

  if (rarityPercent != null) {
    const rarity =
      rarityPercent < 10 ? rarityPercent.toFixed(1) : Math.round(rarityPercent);
    return (
      <span className="ml-auto shrink-0 text-right text-xs text-muted-foreground">
        {rarity}%<span className="block opacity-70">of players</span>
      </span>
    );
  }

  return null;
}

// Manual RetroAchievements game-id override for games whose ROM hash didn't
// resolve. Submitting fetches by the given id and refreshes the tab.
function ManualMatchForm(props: { gameId: number }) {
  const [value, setValue] = useState("");
  const { mutate, isPending } = useSetAchievementsManualMatch(props.gameId);

  const id = Number.parseInt(value, 10);
  const valid = Number.isFinite(id) && id > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) mutate(id);
      }}
      className="flex items-center gap-2"
    >
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        placeholder="RA game ID"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-36"
      />
      <Button type="submit" disabled={!valid || isPending}>
        {isPending ? (
          <LoaderCircle className="animate-spin" size={16} />
        ) : (
          "Map"
        )}
      </Button>
      <a
        href="https://retroachievements.org/gameList.php"
        target="_blank"
        rel="noreferrer"
        className="text-xs underline text-accent-text"
      >
        Find ID
      </a>
    </form>
  );
}

// A single focusable so the controller has somewhere to land when entering the
// tab content (Down from the tab header), mirroring the Media/Similar empties.
function CenteredState(props: { focusKey: string; children: ReactNode }) {
  return (
    <FocusableElement
      opts={{
        focusKey: props.focusKey,
        onFocus: ({ node }) => node?.focus({ preventScroll: true }),
      }}
      render={(ref: RefObject<HTMLDivElement>) => (
        <div
          ref={ref}
          tabIndex={-1}
          className="flex flex-col items-center justify-center gap-3 rounded-xl py-16 text-center outline-none"
        >
          {props.children}
        </div>
      )}
    />
  );
}
