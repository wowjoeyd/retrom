import {
  createContext,
  PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
} from "react";
import { usePlatforms } from "@/queries/usePlatforms";
import { getFileStub, timestampToDate } from "@/lib/utils";
import { useGames } from "@/queries/useGames";
import { GameWithMetadata } from "@/components/game-list";
import { Route } from "@/routes/_fullscreenLayout";
import { useInstallationIndex } from "@/providers/installation-index";
import { InstallationStatus } from "@retrom/codegen/retrom/client/installation_pb";

export type GroupKind = "platform" | "metadataProperty" | (string & {});

// User-selectable library sort. Each key maps to a partitioning strategy below
// so the grid (and the alphabet quick-scroll scrubber) always has meaningful
// section headers. Backed entirely by real Retrom fields.
export type SortKey =
  | "name"
  | "lastPlayed"
  | "dateAdded"
  | "playTime"
  | "releaseDate"
  | "platform";

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Alphabetical" },
  { key: "lastPlayed", label: "Last Played" },
  { key: "dateAdded", label: "Date Added" },
  { key: "playTime", label: "Play Time" },
  { key: "releaseDate", label: "Release Date" },
  { key: "platform", label: "Platform" },
];

export const DEFAULT_SORT_KEY: SortKey = "name";

// User-selectable library filters. Every filter is backed by data already in
// Retrom's local/server model — installation status (from the installation
// index) and the game's Steam linkage (steam_app_id on the Game row). Filters
// in the same section are OR'd together; different sections are AND'd, so e.g.
// "Installed" + "Steam" shows installed Steam games, while "Installed" +
// "Not Installed" (both availability) is a no-op union.
export type FilterKey = "installed" | "notInstalled" | "steam" | "nonSteam";

export type FilterSection = "Availability" | "Source";

export const FILTER_OPTIONS: {
  key: FilterKey;
  label: string;
  section: FilterSection;
}[] = [
  { key: "installed", label: "Installed", section: "Availability" },
  { key: "notInstalled", label: "Not Installed", section: "Availability" },
  { key: "steam", label: "Steam", section: "Source" },
  { key: "nonSteam", label: "Local / Non-Steam", section: "Source" },
];

type PartitionContext = {
  platformNameById?: Map<number, string>;
};

export type Group = {
  kind: GroupKind;
  id: number;
  name: string;
  sortKey: SortKey;
  partitionedGames: [string, GameWithMetadata[]][];
  allGames: GameWithMetadata[];
};

type GroupContext = {
  allGroups: Group[];
  activeGroup?: Group;
  previousGroup?: Group;
  nextGroup?: Group;
};

const context = createContext<GroupContext | undefined>(undefined);

export function GroupContextProvider(props: PropsWithChildren) {
  const {
    activeGroupId,
    sortBy = DEFAULT_SORT_KEY,
    filters,
  } = Route.useSearch();
  const { installations } = useInstallationIndex();

  const { data: platforms } = usePlatforms({
    request: { withMetadata: true },
    selectFn: (data) =>
      data.platforms.map((platform) => {
        const metadata = data.metadata.find(
          (metadata) => metadata.platformId === platform.id,
        );

        return {
          ...platform,
          metadata,
        };
      }),
  });

  const { data: games } = useGames({
    request: { withMetadata: true },
    selectFn: (data) =>
      data.games.map((game) => {
        const metadata = data.metadata.find(
          (metadata) => metadata.gameId === game.id,
        );

        return {
          ...game,
          metadata,
        };
      }),
  });

  const platformNameById = useMemo(() => {
    const map = new Map<number, string>();
    platforms?.forEach((platform) =>
      map.set(
        platform.id,
        platform.metadata?.name ?? getFileStub(platform.path),
      ),
    );
    return map;
  }, [platforms]);

  const partitionCtx = useMemo<PartitionContext>(
    () => ({ platformNameById }),
    [platformNameById],
  );

  // Apply the active library filters to a list of games. Returns the input
  // untouched when no filters are active so the unfiltered path stays cheap.
  const filterGames = useCallback(
    (input: GameWithMetadata[]): GameWithMetadata[] => {
      const active = filters ?? [];
      if (active.length === 0) return input;

      const availability = active.filter(
        (f) => f === "installed" || f === "notInstalled",
      );
      const source = active.filter((f) => f === "steam" || f === "nonSteam");

      return input.filter((game) => {
        if (availability.length) {
          const isInstalled =
            (installations[game.id] ?? InstallationStatus.NOT_INSTALLED) ===
            InstallationStatus.INSTALLED;
          const ok = availability.some((f) =>
            f === "installed" ? isInstalled : !isInstalled,
          );
          if (!ok) return false;
        }

        if (source.length) {
          const isSteam = game.steamAppId != null;
          const ok = source.some((f) => (f === "steam" ? isSteam : !isSteam));
          if (!ok) return false;
        }

        return true;
      });
    },
    [filters, installations],
  );

  const allGames: Group = useMemo(() => {
    const filtered = filterGames(games ?? []);
    return {
      kind: "metadataProperty",
      id: -1,
      name: "All Games",
      sortKey: sortBy,
      partitionedGames: partitionGamesByKey(filtered, sortBy, partitionCtx),
      allGames: filtered,
    };
  }, [games, sortBy, partitionCtx, filterGames]);

  const recentlyPlayed: Group = useMemo(() => {
    // Membership is the 50 most recently played games; the chosen sort only
    // affects how those games are ordered/partitioned (does not mutate the
    // shared games array). Filters are applied to the pool first so the group
    // shows the 50 most-recent games that match the active filters.
    const ranked = filterGames([...(games ?? [])])
      .filter((game) => game.metadata?.lastPlayed)
      .sort(
        (a, b) =>
          timestampToDate(b.metadata?.lastPlayed).getTime() -
          timestampToDate(a.metadata?.lastPlayed).getTime(),
      )
      .slice(0, 50);

    return {
      kind: "metadataProperty",
      id: -2,
      name: "Recently Played",
      sortKey: sortBy,
      partitionedGames: partitionGamesByKey(ranked, sortBy, partitionCtx),
      allGames: ranked,
    };
  }, [games, sortBy, partitionCtx, filterGames]);

  const platformGroups: Group[] = useMemo(
    () =>
      platforms
        ?.map((platform) => {
          const platformGames = filterGames(
            games?.filter((game) => game.platformId === platform.id) ?? [],
          );

          return {
            kind: "platform" as const,
            id: platform.id,
            name: platform.metadata?.name ?? getFileStub(platform.path),
            sortKey: sortBy,
            allGames: platformGames,
            partitionedGames: partitionGamesByKey(
              platformGames,
              sortBy,
              partitionCtx,
            ),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)) ?? [],
    [platforms, games, sortBy, partitionCtx, filterGames],
  );

  const allGroups: Group[] = useMemo(() => {
    return [allGames, recentlyPlayed].concat(platformGroups);
  }, [allGames, recentlyPlayed, platformGroups]);

  const { activeGroup, nextGroup, previousGroup } = useMemo(() => {
    const activeGroupIdx = allGroups.findIndex(
      (group) => group.id === activeGroupId,
    );

    if (activeGroupIdx === -1) {
      return {};
    }

    function getNext(idx: number) {
      const nextIdx = (idx + 1) % allGroups.length;

      return allGroups.at(nextIdx);
    }

    function getPrev(idx: number) {
      const prevIdx = idx - 1;

      return allGroups.at(prevIdx);
    }

    const activeGroup = allGroups.at(activeGroupIdx);
    const previousGroup = getPrev(activeGroupIdx);
    const nextGroup = getNext(activeGroupIdx);

    return { activeGroup, previousGroup, nextGroup };
  }, [allGroups, activeGroupId]);

  return (
    <context.Provider
      value={{ activeGroup, previousGroup, nextGroup, allGroups }}
      {...props}
    />
  );
}

export function useGroupContext() {
  const ctx = useContext(context);

  if (ctx === undefined) {
    throw new Error(
      "useGroupContext must be used within a GroupContextProvider",
    );
  }

  return ctx;
}

function gameName(game: GameWithMetadata): string {
  return game.metadata?.name ?? getFileStub(game.path);
}

function byName(a: GameWithMetadata, b: GameWithMetadata): number {
  return gameName(a).localeCompare(gameName(b));
}

function monthLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

const PLAY_TIME_BUCKETS: { label: string; minMinutes: number }[] = [
  { label: "100+ hours", minMinutes: 6000 },
  { label: "50–100 hours", minMinutes: 3000 },
  { label: "10–50 hours", minMinutes: 600 },
  { label: "1–10 hours", minMinutes: 60 },
  { label: "Under 1 hour", minMinutes: 1 },
];

function partitionGamesByKey(
  gamesToPartition: GameWithMetadata[],
  key: SortKey,
  ctx?: PartitionContext,
): Group["partitionedGames"] {
  switch (key) {
    case "name":
      return partitionByName(gamesToPartition);
    case "lastPlayed":
      return partitionByMonth(
        gamesToPartition,
        (game) => game.metadata?.lastPlayed,
        "Never Played",
      );
    case "dateAdded":
      return partitionByMonth(
        gamesToPartition,
        (game) => game.createdAt,
        "Unknown",
      );
    case "playTime":
      return partitionByPlayTime(gamesToPartition);
    case "releaseDate":
      return partitionByYear(gamesToPartition);
    case "platform":
      return partitionByPlatform(gamesToPartition, ctx?.platformNameById);
  }
}

function partitionByName(
  gamesToPartition: GameWithMetadata[],
): Group["partitionedGames"] {
  const charGroups = new Map<string, GameWithMetadata[]>(
    [
      "#",
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
      "J",
      "K",
      "L",
      "M",
      "N",
      "O",
      "P",
      "Q",
      "R",
      "S",
      "T",
      "U",
      "V",
      "W",
      "X",
      "Y",
      "Z",
    ].map((c) => [c, []]),
  );

  gamesToPartition.forEach((game) => {
    const name = gameName(game);
    const char = /^[a-zA-Z]/.test(name[0]) ? name[0].toUpperCase() : "#";

    if (!charGroups.has(char)) {
      console.error("Incorrect character group, game may not be visible", char);
    }

    charGroups.get(char)?.push(game);
  });

  for (const arr of charGroups.values()) {
    arr.sort(byName);
  }

  return Array.from(charGroups.entries()).sort(([k1], [k2]) =>
    k1.localeCompare(k2),
  );
}

function partitionByMonth(
  gamesToPartition: GameWithMetadata[],
  getTimestamp: (game: GameWithMetadata) => GameWithMetadata["createdAt"],
  missingLabel: string,
): Group["partitionedGames"] {
  const buckets = new Map<string, GameWithMetadata[]>();
  const missing: GameWithMetadata[] = [];

  gamesToPartition.forEach((game) => {
    const ts = getTimestamp(game);
    if (!ts) {
      missing.push(game);
      return;
    }

    const label = monthLabel(timestampToDate(ts));
    const arr = buckets.get(label) ?? [];
    arr.push(game);
    buckets.set(label, arr);
  });

  for (const arr of buckets.values()) {
    arr.sort(
      (a, b) =>
        timestampToDate(getTimestamp(b)).getTime() -
        timestampToDate(getTimestamp(a)).getTime(),
    );
  }

  const entries = Array.from(buckets.entries()).sort(
    ([k1], [k2]) => new Date(k2).getTime() - new Date(k1).getTime(),
  );

  if (missing.length) {
    missing.sort(byName);
    entries.push([missingLabel, missing]);
  }

  return entries;
}

function partitionByPlayTime(
  gamesToPartition: GameWithMetadata[],
): Group["partitionedGames"] {
  const order = [...PLAY_TIME_BUCKETS.map((b) => b.label), "Never Played"];
  const buckets = new Map<string, GameWithMetadata[]>(
    order.map((label) => [label, []]),
  );

  gamesToPartition.forEach((game) => {
    const minutes = game.metadata?.minutesPlayed ?? 0;
    const bucket =
      PLAY_TIME_BUCKETS.find((b) => minutes >= b.minMinutes)?.label ??
      "Never Played";
    buckets.get(bucket)?.push(game);
  });

  for (const arr of buckets.values()) {
    arr.sort(
      (a, b) =>
        (b.metadata?.minutesPlayed ?? 0) - (a.metadata?.minutesPlayed ?? 0),
    );
  }

  return order
    .map((label): [string, GameWithMetadata[]] => [
      label,
      buckets.get(label) ?? [],
    ])
    .filter(([, arr]) => arr.length > 0);
}

function partitionByYear(
  gamesToPartition: GameWithMetadata[],
): Group["partitionedGames"] {
  const buckets = new Map<string, GameWithMetadata[]>();
  const missing: GameWithMetadata[] = [];

  gamesToPartition.forEach((game) => {
    const ts = game.metadata?.releaseDate;
    if (!ts) {
      missing.push(game);
      return;
    }

    const year = String(timestampToDate(ts).getFullYear());
    const arr = buckets.get(year) ?? [];
    arr.push(game);
    buckets.set(year, arr);
  });

  for (const arr of buckets.values()) {
    arr.sort(
      (a, b) =>
        timestampToDate(b.metadata?.releaseDate).getTime() -
        timestampToDate(a.metadata?.releaseDate).getTime(),
    );
  }

  const entries = Array.from(buckets.entries()).sort(
    ([k1], [k2]) => Number(k2) - Number(k1),
  );

  if (missing.length) {
    missing.sort(byName);
    entries.push(["Unknown", missing]);
  }

  return entries;
}

function partitionByPlatform(
  gamesToPartition: GameWithMetadata[],
  platformNameById?: Map<number, string>,
): Group["partitionedGames"] {
  const buckets = new Map<string, GameWithMetadata[]>();
  const unknown: GameWithMetadata[] = [];

  gamesToPartition.forEach((game) => {
    const name =
      game.platformId !== undefined
        ? platformNameById?.get(game.platformId)
        : undefined;

    if (!name) {
      unknown.push(game);
      return;
    }

    const arr = buckets.get(name) ?? [];
    arr.push(game);
    buckets.set(name, arr);
  });

  for (const arr of buckets.values()) {
    arr.sort(byName);
  }

  const entries = Array.from(buckets.entries()).sort(([k1], [k2]) =>
    k1.localeCompare(k2),
  );

  if (unknown.length) {
    unknown.sort(byName);
    entries.push(["Unknown", unknown]);
  }

  return entries;
}
