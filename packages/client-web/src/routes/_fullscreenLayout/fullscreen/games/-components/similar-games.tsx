import {
  FocusableElement,
  FocusContainer,
  useFocusable,
} from "@/components/fullscreen/focus-container";
import { ScrollArea, ScrollBar } from "@retrom/ui/components/scroll-area";
import { cn } from "@retrom/ui/lib/utils";
import { useGameDetail } from "@/providers/game-details";
import { HotkeyLayer } from "@/providers/hotkeys/layers";
import { useGameMetadata } from "@/queries/useGameMetadata";
import { useGames } from "@/queries/useGames";
import { useNavigate } from "@tanstack/react-router";
import { AlertCircleIcon, LoaderCircleIcon } from "lucide-react";
import { RefObject, useMemo } from "react";
import { createUrl, usePublicUrl } from "@/utils/urls";
import { Skeleton } from "@retrom/ui/components/skeleton";

// How many cards the row renders at most.
const MAX_SIMILAR = 20;

// Relative weights for the similarity score. IGDB's curated "similar games"
// (when ingested) are the strongest signal; shared genres are the primary
// library-derived signal; a shared platform only breaks ties between otherwise
// equally-similar games. Genres are the only structured similarity facet Retrom
// stores — there is no tags/franchise model — so genre overlap + IGDB similars
// are all the similarity metadata available.
const WEIGHT_IGDB = 1000;
const WEIGHT_SHARED_GENRE = 10;
const WEIGHT_SAME_PLATFORM = 1;

// Rank the rest of the library by similarity to the current game and return the
// ordered game ids to show. Similarity is driven by shared genres and IGDB's
// curated similar-games list; a shared platform is only a tiebreaker. When no
// game shares any similarity signal we fall back to "more from this platform",
// and only when even that is empty does the tab show its clean empty state.
export function SimilarGames() {
  const { game, extraMetadata } = useGameDetail();
  const currentGameId = game.id;
  const currentPlatformId = game.platformId;

  // Signals for the *current* game come straight from the detail context — its
  // genres and (if present) IGDB similar games are already loaded, so they cost
  // no extra fetch here.
  const currentGenreIds = useMemo(
    () => new Set((extraMetadata?.genres?.value ?? []).map((g) => g.id)),
    [extraMetadata?.genres],
  );
  const igdbSimilarIds = useMemo(
    () =>
      new Set(
        (extraMetadata?.similarGames?.value ?? [])
          .map((g) => g.id)
          .filter((id) => id !== currentGameId),
      ),
    [extraMetadata?.similarGames, currentGameId],
  );

  // The candidate universe: every (non-deleted) game in the library. Shares the
  // react-query cache with the grid's library load.
  const { data: allGames, status: gamesStatus } = useGames({
    selectFn: (data) => data.games,
  });

  const gameIds = useMemo(() => allGames?.map((g) => g.id) ?? [], [allGames]);

  // Bulk genres for the whole library, keyed by game id. Gated until the game
  // list resolves so we never fire a getGameMetadata([]) request. This is the
  // only way to read per-game genres (they aren't carried on GetGames), so the
  // overlap scoring needs it.
  const { data: genresById, status: genresStatus } = useGameMetadata({
    request: { gameIds },
    enabled: gameIds.length > 0,
    selectFn: (data) => {
      const map = new Map<number, number[]>();
      for (const [id, genres] of Object.entries(data.genres)) {
        map.set(
          Number(id),
          genres.value.map((genre) => genre.id),
        );
      }
      return map;
    },
  });

  const similarIds = useMemo(() => {
    if (!allGames) return [];

    const scored: { id: number; score: number }[] = [];
    const samePlatformFallback: number[] = [];

    for (const candidate of allGames) {
      if (candidate.id === currentGameId) continue;

      const samePlatform =
        currentPlatformId !== undefined &&
        candidate.platformId === currentPlatformId;

      if (samePlatform) samePlatformFallback.push(candidate.id);

      const candidateGenres = genresById?.get(candidate.id) ?? [];
      let sharedGenres = 0;
      for (const genreId of candidateGenres) {
        if (currentGenreIds.has(genreId)) sharedGenres++;
      }

      const isIgdbSimilar = igdbSimilarIds.has(candidate.id);

      // Require a real similarity signal (a curated IGDB match or a shared
      // genre) to count as "similar"; a shared platform alone is only a
      // fallback, handled below.
      if (sharedGenres === 0 && !isIgdbSimilar) continue;

      scored.push({
        id: candidate.id,
        score:
          (isIgdbSimilar ? WEIGHT_IGDB : 0) +
          sharedGenres * WEIGHT_SHARED_GENRE +
          (samePlatform ? WEIGHT_SAME_PLATFORM : 0),
      });
    }

    if (scored.length > 0) {
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SIMILAR)
        .map((s) => s.id);
    }

    // No similarity metadata to rank by (e.g. a game with no genres in a
    // library without IGDB similars) — fall back to other games on the same
    // platform, a sensible "more from this platform" row, before giving up.
    return samePlatformFallback.slice(0, MAX_SIMILAR);
  }, [
    allGames,
    genresById,
    currentGameId,
    currentPlatformId,
    currentGenreIds,
    igdbSimilarIds,
  ]);

  // Only a failed *game list* is a hard error — without it there's no candidate
  // universe. A failed genres fetch degrades gracefully instead: scoring just
  // sees no genres and falls back to IGDB similars / same platform. We stay in
  // the loading state until the game list resolves and (once it has games) its
  // genres do too; the genres query reports `pending`/idle while disabled, so it
  // only counts toward loading once it's actually enabled and still fetching.
  const status =
    gamesStatus === "error"
      ? "error"
      : gamesStatus === "pending" ||
          (gameIds.length > 0 && genresStatus === "pending")
        ? "pending"
        : "success";

  return (
    <div
      className={cn(
        "w-full rounded-lg border border-border/50 bg-muted/10 pt-2",
        "transition-all focus-within:border-accent/60 hover:border-accent/60",
      )}
    >
      <ScrollArea className="w-full">
        <FocusContainer
          opts={{
            focusKey: "similar-games",
          }}
          className={cn(
            "flex gap-2 p-4",
            "[&_p]:text-muted-foreground [&_p]:my-6 [&_p]:flex [&_p]:gap-2 [&_p]:mx-auto",
          )}
        >
          {status === "pending" ? (
            <p className="text-muted-foreground">
              <LoaderCircleIcon className="animate-spin" />
              Loading similar games...
            </p>
          ) : status === "error" ? (
            <p className="text-muted-foreground">
              <AlertCircleIcon className="text-destructive-text" />
              Error loading similar games
            </p>
          ) : !similarIds.length ? (
            <FocusableElement
              opts={{
                focusKey: `empty-similar-games`,
                onFocus: ({ node }) => {
                  node?.focus({ preventScroll: true });
                  node?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                    inline: "center",
                  });
                },
              }}
              render={(ref: RefObject<HTMLParagraphElement>) => (
                <p ref={ref} tabIndex={-1} className="outline-none">
                  No similar games found for this game.
                </p>
              )}
            />
          ) : (
            similarIds.map((id) => <SimilarGame key={id} gameId={id} />)
          )}
        </FocusContainer>

        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}

function SimilarGame(props: { gameId: number }) {
  const publicUrl = usePublicUrl();
  const { data, status } = useGameMetadata({
    request: { gameIds: [props.gameId] },
    selectFn: (data) => ({
      metadata: data.metadata.at(0),
      mediaPaths:
        props.gameId in data.mediaPaths
          ? data.mediaPaths[props.gameId]
          : undefined,
    }),
  });

  const navigate = useNavigate();
  const { ref } = useFocusable<HTMLDivElement>({
    focusKey: `similar-game-${props.gameId}`,
    onFocus: ({ node }) => {
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
    },
  });

  const goToGame = () => {
    navigate({
      to: "/fullscreen/games/$gameId",
      resetScroll: false,
      params: { gameId: props.gameId.toString() },
    }).catch(console.error);
  };

  const coverUrl = useMemo(() => {
    const localPath = data?.mediaPaths?.coverUrl;
    if (localPath && publicUrl) {
      return createUrl({ path: localPath, base: publicUrl })?.href;
    }

    return data?.metadata?.coverUrl;
  }, [publicUrl, data]);

  return (
    <HotkeyLayer handlers={{ ACCEPT: { handler: () => goToGame() } }}>
      <div
        ref={ref}
        tabIndex={-1}
        className={cn(
          "focus-hover:shadow-[var(--fs-focus-glow)] min-w-[150px] max-w-[200px]",
          "outline-none scale-95 transition-all duration-200 focus-hover:scale-100 cursor-pointer",
        )}
        onClick={() => goToGame()}
      >
        {status !== "pending" ? (
          coverUrl ? (
            <img src={coverUrl} alt="" />
          ) : null
        ) : (
          <Skeleton className="border aspect-[3/4]" />
        )}
      </div>
    </HotkeyLayer>
  );
}
