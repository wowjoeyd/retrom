import { ReactNode, useMemo } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleDashed,
  DownloadCloud,
  Gamepad2,
  HardDrive,
  Joystick,
  Monitor,
} from "lucide-react";
import { getFileStub, timestampToDate } from "@/lib/utils";
import { cn } from "@retrom/ui/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import { useInstallationStatus } from "@/queries/useInstallationStatus";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";

// Compact, couch-readable metadata chips. Real data only — any field that isn't
// available is simply omitted rather than shown as "Unknown".
export function StatsStrip() {
  const { game, platform, platformMetadata, gameMetadata, emulator } =
    useGameDetail();
  const installationStatus = useInstallationStatus(game.id);

  const platformName = useMemo(() => {
    if (typeof platformMetadata?.name === "string" && platformMetadata.name) {
      return platformMetadata.name;
    }
    return getFileStub(platform.path) || undefined;
  }, [platformMetadata, platform.path]);

  const releaseDate = useMemo(() => {
    if (!gameMetadata?.releaseDate) return undefined;
    return timestampToDate(gameMetadata.releaseDate).getFullYear().toString();
  }, [gameMetadata?.releaseDate]);

  const source = game.thirdParty
    ? { icon: <Gamepad2 size={16} />, label: "Source", value: "Steam" }
    : emulator
      ? { icon: <Joystick size={16} />, label: "Source", value: "Emulator" }
      : { icon: <HardDrive size={16} />, label: "Source", value: "Local" };

  // Steam/third-party titles are managed by Steam, so a Retrom install state is
  // not meaningful — skip the chip there.
  const status = game.thirdParty
    ? undefined
    : installationStatus === InstallationStatus.INSTALLED
      ? { icon: <CheckCircle2 size={16} />, value: "Ready", ready: true }
      : installationStatus === InstallationStatus.INSTALLING ||
          installationStatus === InstallationStatus.PAUSED
        ? {
            icon: <DownloadCloud size={16} />,
            value: "Installing",
            ready: false,
          }
        : {
            icon: <CircleDashed size={16} />,
            value: "Not installed",
            ready: false,
          };

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <Chip icon={source.icon} label={source.label} value={source.value} />
      {platformName && (
        <Chip
          icon={<Monitor size={16} />}
          label="Platform"
          value={platformName}
        />
      )}
      {status && (
        <Chip
          icon={status.icon}
          label="Status"
          value={status.value}
          accent={status.ready}
        />
      )}
      {releaseDate && (
        <Chip
          icon={<CalendarDays size={16} />}
          label="Released"
          value={releaseDate}
        />
      )}
    </div>
  );
}

function Chip(props: {
  icon: ReactNode;
  label: string;
  value: string;
  accent?: boolean;
}) {
  const { icon, label, value, accent } = props;

  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-3.5 py-2">
      <span
        className={cn(
          "shrink-0",
          accent ? "text-accent-text" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-[0.6rem] font-bold uppercase tracking-[0.15em] text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "text-sm font-semibold",
            accent ? "text-accent-text" : "text-foreground",
          )}
        >
          {value}
        </span>
      </div>
    </div>
  );
}
