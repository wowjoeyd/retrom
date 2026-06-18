import { getFileStub, timestampToDate } from "@/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";
import { useMemo } from "react";

// Clean labeled metadata row (label + value, no boxed badges) in the Game Info
// content area. Real data only — any field that isn't available is omitted
// rather than shown as "Unknown".
export function ExtraInfo() {
  const { game, platform, platformMetadata, gameMetadata, emulator } =
    useGameDetail();
  const installationStatus = useInstallationStatus(game.id);

  const playTime = useMemo(() => {
    const time = gameMetadata?.minutesPlayed;
    if (time === undefined) return undefined;
    if (time > 60) {
      const hours = Math.floor(time / 60);
      const minutes = time % 60;
      return `${hours}h ${minutes}m`;
    }
    return `${time}m`;
  }, [gameMetadata?.minutesPlayed]);

  const lastPlayed = useMemo(() => {
    const played = gameMetadata?.lastPlayed;
    if (!played) return undefined;
    return timestampToDate(played).toLocaleDateString();
  }, [gameMetadata?.lastPlayed]);

  const addedOn = useMemo(() => {
    const timestamp = game.createdAt;
    if (!timestamp) return undefined;
    return timestampToDate(timestamp).toLocaleDateString();
  }, [game.createdAt]);

  const platformName = useMemo(() => {
    if (typeof platformMetadata?.name === "string" && platformMetadata.name) {
      return platformMetadata.name;
    }
    return getFileStub(platform.path) || undefined;
  }, [platformMetadata, platform.path]);

  const released = useMemo(() => {
    if (!gameMetadata?.releaseDate) return undefined;
    return timestampToDate(gameMetadata.releaseDate).getFullYear().toString();
  }, [gameMetadata?.releaseDate]);

  const source = game.thirdParty ? "Steam" : emulator ? "Emulator" : "Local";

  // Steam/third-party titles are managed by Steam, so a Retrom install state is
  // not meaningful — skip the field there.
  const status = game.thirdParty
    ? undefined
    : installationStatus === InstallationStatus.INSTALLED
      ? "Installed"
      : installationStatus === InstallationStatus.INSTALLING ||
          installationStatus === InstallationStatus.PAUSED
        ? "Installing"
        : "Not installed";

  const items: { label: string; value: string }[] = [
    { label: "Play Time", value: playTime ?? "Not played yet" },
    ...(lastPlayed ? [{ label: "Last Played", value: lastPlayed }] : []),
    ...(addedOn ? [{ label: "Added On", value: addedOn }] : []),
    ...(platformName ? [{ label: "Platform", value: platformName }] : []),
    { label: "Source", value: source },
    ...(status ? [{ label: "Status", value: status }] : []),
    ...(released ? [{ label: "Released", value: released }] : []),
  ];

  return (
    <div className="flex flex-wrap gap-x-10 gap-y-5">
      {items.map(({ label, value }) => (
        <div key={label} className="flex flex-col gap-1">
          <span className="text-[0.65rem] font-bold uppercase tracking-[0.15em] text-muted-foreground">
            {label}
          </span>
          <span className="font-semibold text-foreground/90">{value}</span>
        </div>
      ))}
    </div>
  );
}
