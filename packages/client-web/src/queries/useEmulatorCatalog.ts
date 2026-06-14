import {
  GetEmulatorCatalogRequestSchema,
  type GetEmulatorCatalogResponse,
} from "@retrom/codegen/retrom/services/emulator-package-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useQuery } from "@tanstack/react-query";
import { MessageInitShape } from "@bufbuild/protobuf";

type SelectFn<S> = (data: GetEmulatorCatalogResponse) => S;

export function useEmulatorCatalog<T = GetEmulatorCatalogResponse>(
  opts: {
    request?: MessageInitShape<typeof GetEmulatorCatalogRequestSchema>;
    selectFn?: SelectFn<T>;
    enabled?: boolean;
  } = {},
) {
  const { request = {}, selectFn, enabled = true } = opts;
  const retromClient = useRetromClient();

  return useQuery({
    queryKey: ["emulator-catalog", request, retromClient],
    select: selectFn,
    enabled,
    queryFn: () =>
      retromClient.emulatorPackageClient.getEmulatorCatalog(request),
  });
}
