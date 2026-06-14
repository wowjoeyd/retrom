import { useRetromClient } from "@/providers/retrom-client";
import { useQuery } from "@tanstack/react-query";
import {
  SearchGameSoundtrackRequestSchema,
  SearchGameSoundtrackResponse,
} from "@retrom/codegen/retrom/services/metadata-service_pb";
import { create } from "@bufbuild/protobuf";

type SelectFn<S> = (data: SearchGameSoundtrackResponse) => S;

export function useSearchGameSoundtrack<T = SearchGameSoundtrackResponse>(
  gameId: number,
  opts: { enabled?: boolean; selectFn?: SelectFn<T> } = {},
) {
  const { enabled = true, selectFn } = opts;
  const retromClient = useRetromClient();

  return useQuery({
    enabled,
    queryKey: ["searchGameSoundtrack", gameId],
    queryFn: () =>
      retromClient.metadataClient.searchGameSoundtrack(
        create(SearchGameSoundtrackRequestSchema, { gameId }),
      ),
    select: selectFn,
    staleTime: 5 * 60 * 1000,
  });
}
