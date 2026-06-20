import { MenuEntryButton } from "../menubar/menu-entry-button";
import { useGameDetail } from "@/providers/game-details";
import { useRefreshGameMetadata } from "@/mutations/useRefreshGameMetadata";
import { RefreshCw } from "lucide-react";

// (Re)scrape this game's metadata: Steam games refresh from the Steam store,
// everything else re-queries IGDB (by the existing match when known) and
// re-applies — re-caching media and theme audio. A background job; the toast
// reports start/finish, so the panel stays open.
export function RefreshMetadataAction() {
  const { game, gameMetadata, platformMetadata } = useGameDetail();
  const { mutate: refresh, isPending } = useRefreshGameMetadata();

  return (
    <MenuEntryButton
      id="refresh-metadata-action"
      icon={
        <RefreshCw
          size={18}
          className={isPending ? "animate-spin" : undefined}
        />
      }
      label={
        game.thirdParty
          ? "Re-fetch this game's details from Steam"
          : "Re-scrape this game's details from IGDB"
      }
      disabled={isPending}
      onClick={() => refresh({ game, gameMetadata, platformMetadata })}
      handlers={{
        ACCEPT: { actionBar: { label: "Refresh", position: "right" } },
      }}
    >
      Refresh Metadata
    </MenuEntryButton>
  );
}
