// Typed presentation interface for RetroAchievements data on the fullscreen
// detail page. There is NO RetroAchievements backend in Retrom yet (no proto
// fields, no codegen, no client integration), so the UI — the hero chip, the
// Achievements tab header, and the achievement rows — is built entirely against
// this interface and renders a "RetroAchievements not connected" state.
//
// A real RA integration is a separate, scoped follow-up and would require:
//   - RA Web API credentials (per-user API key) + a settings surface to enter them
//   - ROM hashing (the RA MD5 scheme) to resolve a local game to an RA game id
//   - fetching GetGameInfoAndUserProgress and caching it server-side
//   - new proto/codegen fields to carry achievements through the metadata service
// When that lands, only `useGameAchievements` below changes — the components
// already consume this shape.

export interface AchievementSummary {
  /** Number of achievements the user has unlocked. */
  unlocked: number;
  /** Total achievements in the game's set. */
  total: number;
  /** Points the user has earned. */
  pointsEarned: number;
  /** Total points available in the set. */
  pointsTotal: number;
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  points: number;
  unlocked: boolean;
  /** Badge/icon URL, when the source provides one. */
  iconUrl?: string;
  /** When the achievement was unlocked, if known. */
  unlockedAt?: Date;
}

export type AchievementsState =
  /** No RA integration configured/available for this install. */
  | { status: "not-connected" }
  /** Connected and fetching. */
  | { status: "loading" }
  /** Connected, but this game has no achievement set. */
  | { status: "empty" }
  /** Fetch failed. */
  | { status: "error"; message: string }
  /** Data available. */
  | {
      status: "ready";
      summary: AchievementSummary;
      achievements: Achievement[];
    };

/**
 * Resolve RetroAchievements data for a game.
 *
 * Stub: always reports "not-connected" until an RA backend exists. Swap this
 * body (e.g. a react-query hook against a new metadata-service field) to light
 * up the chip and tab without touching the presentational components.
 */
export function useGameAchievements(_gameId: number): AchievementsState {
  return { status: "not-connected" };
}
