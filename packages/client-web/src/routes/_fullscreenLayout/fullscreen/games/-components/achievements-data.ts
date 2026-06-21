// Presentation interface + data hook for unified achievements (Steam +
// RetroAchievements). The server resolves which provider applies to a game,
// fetches the set + the user's progress, caches it, and serves it through the
// MetadataService.GetGameAchievements RPC. This hook maps that response into the
// shape the hero chip and the Achievements tab render against — the components
// never talk to the RPC directly.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
  GameAchievementsStatus,
  type GameAchievement,
} from "@retrom/codegen/retrom/services/metadata-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { usePublicUrl, createUrl } from "@/utils/urls";

export interface AchievementSummary {
  /** Provider id: "steam" | "retroachievements". */
  provider: string;
  /** Number of achievements the user has unlocked. */
  unlocked: number;
  /** Total achievements in the game's set. */
  total: number;
  /** Points the user has earned (RetroAchievements). */
  pointsEarned: number;
  /** Total points available in the set (RetroAchievements). */
  pointsTotal: number;
  /** Whether this provider awards points (Steam does not). */
  hasPoints: boolean;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  unlocked: boolean;
  /** Points (RetroAchievements). Absent for Steam. */
  points?: number;
  /** Global unlock percentage (rarity), when available. */
  rarityPercent?: number;
  /** Badge/icon URL, resolved to an absolute URL. */
  iconUrl?: string;
  /** When the achievement was unlocked, if known. */
  unlockedAt?: Date;
}

export type AchievementsState =
  /** Fetching (RPC pending). */
  | { status: "loading" }
  /** A provider applies but its account credentials are missing/incomplete. */
  | { status: "not-configured" }
  /** No provider applies to this game (native/custom title). */
  | { status: "not-supported" }
  /** RetroAchievements: the content hash didn't resolve to an RA game. */
  | { status: "not-identified" }
  /** Configured but progress couldn't load (private profile, bad key, error). */
  | { status: "needs-attention"; message: string }
  /** A provider applies and is configured, but the game has no set. */
  | { status: "empty" }
  /** Data available. */
  | {
      status: "ready";
      summary: AchievementSummary;
      achievements: Achievement[];
    };

/**
 * Resolve achievements for a game through the server-side provider/cache path.
 * Pending → "loading", RPC error → "needs-attention", otherwise the server's
 * resolved status maps 1:1 onto the presentation states above.
 */
export function useGameAchievements(gameId: number): AchievementsState {
  const retromClient = useRetromClient();
  const publicUrl = usePublicUrl();

  const { data, status: queryStatus } = useQuery({
    queryKey: ["game-achievements", gameId],
    queryFn: () => retromClient.metadataClient.getGameAchievements({ gameId }),
  });

  return useMemo<AchievementsState>(() => {
    if (queryStatus === "pending") {
      return { status: "loading" };
    }

    if (queryStatus === "error" || !data) {
      return {
        status: "needs-attention",
        message: "Couldn't load achievements. Check the console for details.",
      };
    }

    switch (data.status) {
      case GameAchievementsStatus.NOT_SUPPORTED:
      case GameAchievementsStatus.UNSPECIFIED:
        return { status: "not-supported" };
      case GameAchievementsStatus.NOT_CONFIGURED:
        return { status: "not-configured" };
      case GameAchievementsStatus.NOT_IDENTIFIED:
        return { status: "not-identified" };
      case GameAchievementsStatus.NEEDS_ATTENTION:
        return {
          status: "needs-attention",
          message: data.message || "Achievements need attention.",
        };
      case GameAchievementsStatus.EMPTY:
        return { status: "empty" };
      case GameAchievementsStatus.POPULATED: {
        const set = data.set;
        if (!set) {
          return { status: "empty" };
        }

        const achievements = set.achievements.map((a) =>
          toAchievement(a, publicUrl),
        );

        return {
          status: "ready",
          summary: {
            provider: set.provider,
            unlocked: set.unlocked,
            total: set.total,
            pointsEarned: set.pointsEarned,
            pointsTotal: set.pointsTotal,
            hasPoints: set.pointsTotal > 0,
          },
          achievements,
        };
      }
      default:
        return { status: "not-supported" };
    }
  }, [data, queryStatus, publicUrl]);
}

function toAchievement(
  a: GameAchievement,
  publicUrl: URL | undefined,
): Achievement {
  return {
    id: a.id,
    title: a.name,
    description: a.description,
    unlocked: a.unlocked,
    points: a.points,
    rarityPercent: a.rarityPercent,
    iconUrl: resolveBadgeUrl(a.iconUrl, publicUrl),
    unlockedAt: a.unlockedAt ? timestampDate(a.unlockedAt) : undefined,
  };
}

// Server badges are relative `media/...` paths served under /rest/public; on a
// cache miss the server falls back to the provider's absolute CDN URL, which we
// pass through untouched.
function resolveBadgeUrl(
  iconUrl: string | undefined,
  publicUrl: URL | undefined,
): string | undefined {
  if (!iconUrl) return undefined;
  if (/^https?:\/\//i.test(iconUrl)) return iconUrl;
  if (publicUrl) return createUrl({ path: iconUrl, base: publicUrl })?.href;
  return undefined;
}
