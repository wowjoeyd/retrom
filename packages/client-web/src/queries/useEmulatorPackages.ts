import {
  GetEmulatorPackagesRequestSchema,
  type GetEmulatorPackagesResponse,
} from "@retrom/codegen/retrom/services/emulator-package-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useQuery } from "@tanstack/react-query";
import { MessageInitShape } from "@bufbuild/protobuf";

type SelectFn<S> = (data: GetEmulatorPackagesResponse) => S;

export function useEmulatorPackages<T = GetEmulatorPackagesResponse>(
  opts: {
    request?: MessageInitShape<typeof GetEmulatorPackagesRequestSchema>;
    selectFn?: SelectFn<T>;
    enabled?: boolean;
  } = {},
) {
  const { request = {}, selectFn, enabled = true } = opts;
  const retromClient = useRetromClient();

  return useQuery({
    queryKey: ["emulator-packages", request, retromClient],
    select: selectFn,
    enabled,
    queryFn: () =>
      retromClient.emulatorPackageClient.getEmulatorPackages(request),
  });
}
