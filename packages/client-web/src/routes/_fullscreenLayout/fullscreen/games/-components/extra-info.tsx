import { timestampToDate } from "@/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import { useMemo } from "react";

export function ExtraInfo() {
  const { gameMetadata, game } = useGameDetail();

  const playTime = useMemo(() => {
    const time = gameMetadata?.minutesPlayed;

    if (time === undefined) {
      return "Not played yet";
    }

    if (time > 60) {
      const hours = Math.floor(time / 60);
      const minutes = time % 60;

      return `${hours} hours ${minutes} minutes`;
    }

    return `${time} minutes`;
  }, [gameMetadata?.minutesPlayed]);

  const lastPlayed = useMemo(() => {
    const played = gameMetadata?.lastPlayed;

    if (!played) {
      return "Not played yet";
    }

    return timestampToDate(played).toLocaleString();
  }, [gameMetadata?.lastPlayed]);

  const addedOn = useMemo(() => {
    const timestamp = game.createdAt;

    if (!timestamp) {
      return "";
    }

    return timestampToDate(timestamp).toLocaleString();
  }, [game.createdAt]);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <InfoItem title="Play Time" value={playTime} />
      <InfoItem title="Last Played" value={lastPlayed} />
      {addedOn && <InfoItem title="Added On" value={addedOn} />}
    </div>
  );
}

function InfoItem(props: { title: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 bg-muted/10 px-4 py-3">
      <h3 className="text-[0.65rem] font-bold uppercase tracking-[0.15em] text-muted-foreground">
        {props.title}
      </h3>
      <p className="font-semibold text-foreground/90">{props.value}</p>
    </div>
  );
}
