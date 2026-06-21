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
      // NOT `disabled` while pending: a disabled <button> drops DOM focus to
      // <body>, which moves it outside this popup's focus boundary. B would then
      // bubble past the popup's BACK handler to the detail page's document-level
      // back-to-grid handler, exiting the whole page instead of closing the
      // popup. Keep the button focusable (spinner + aria-busy show progress) and
      // just guard against re-triggering while the refresh is in flight.
      aria-busy={isPending}
      onClick={() => {
        if (!isPending) refresh({ game, gameMetadata, platformMetadata });
      }}
      handlers={{
        ACCEPT: { actionBar: { label: "Refresh", position: "right" } },
      }}
    >
      Refresh Metadata
    </MenuEntryButton>
  );
}
