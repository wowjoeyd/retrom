import { useCallback, useState } from "react";
import { Button } from "@retrom/ui/components/button";
import { Checkbox } from "@retrom/ui/components/checkbox";
import { DialogClose, DialogFooter } from "@retrom/ui/components/dialog";
import { LoaderCircleIcon } from "lucide-react";
import { useGameDetail } from "@/providers/game-details";
import { useSyncSteamMetadata } from "@/mutations/useSyncSteamMetadata";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@retrom/ui/lib/utils";

export function SteamTab() {
  const { game } = useGameDetail();
  const navigate = useNavigate();

  const [syncPlayData, setSyncPlayData] = useState(false);
  const [forceRefresh, setForceRefresh] = useState(false);

  const { mutateAsync: syncSteam, status: steamStatus } =
    useSyncSteamMetadata();

  const pending = steamStatus === "pending";
  const canSubmit = syncPlayData || forceRefresh;

  const handleRefresh = useCallback(async () => {
    if (!canSubmit) return;

    await syncSteam({ gameIds: [game.id], forceRefresh });

    await navigate({
      to: ".",
      search: (prev) => ({ ...prev, updateMetadataModal: undefined }),
    });
  }, [game.id, forceRefresh, canSubmit, syncSteam, navigate]);

  return (
    <div className="flex flex-col gap-6 mt-4">
      <p className="text-sm text-muted-foreground">
        Refresh Steam-specific data for this game. Steam games cannot be
        re-matched through IGDB — use the options below to control what gets
        updated. To update theme audio, use the Music tab.
      </p>

      <div className="flex flex-col gap-4">
        <label
          className={cn(
            "flex items-start gap-3 cursor-pointer",
            pending && "opacity-50 pointer-events-none",
          )}
        >
          <Checkbox
            checked={syncPlayData}
            onCheckedChange={(v) => setSyncPlayData(!!v)}
            disabled={pending}
            className="mt-0.5"
          />
          <div className="grid gap-1 leading-none">
            <span className="font-medium text-sm">Sync play data</span>
            <span className="text-xs text-muted-foreground">
              Re-fetch playtime and last-played timestamp from the Steam Web
              API.
            </span>
          </div>
        </label>

        <label
          className={cn(
            "flex items-start gap-3 cursor-pointer",
            pending && "opacity-50 pointer-events-none",
          )}
        >
          <Checkbox
            checked={forceRefresh}
            onCheckedChange={(v) => setForceRefresh(!!v)}
            disabled={pending}
            className="mt-0.5"
          />
          <div className="grid gap-1 leading-none">
            <span className="font-medium text-sm">
              Force refresh all Steam metadata
            </span>
            <span className="text-xs text-muted-foreground">
              Re-download everything from Steam: name, description, cover,
              background, screenshots, and videos. Overwrites any existing
              metadata for this game.
            </span>
          </div>
        </label>
      </div>

      <DialogFooter className="gap-2">
        <DialogClose asChild>
          <Button type="button" variant="secondary" disabled={pending}>
            Cancel
          </Button>
        </DialogClose>

        <Button
          type="button"
          disabled={pending || !canSubmit}
          onClick={handleRefresh}
        >
          {pending ? <LoaderCircleIcon className="animate-spin" /> : "Refresh"}
        </Button>
      </DialogFooter>
    </div>
  );
}
