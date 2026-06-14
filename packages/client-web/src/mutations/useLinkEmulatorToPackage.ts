import { LinkEmulatorToPackageRequestSchema } from "@retrom/codegen/retrom/services/emulator-package-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageInitShape } from "@bufbuild/protobuf";

export function useLinkEmulatorToPackage() {
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: (
      request: MessageInitShape<typeof LinkEmulatorToPackageRequestSchema>,
    ) => retromClient.emulatorPackageClient.linkEmulatorToPackage(request),
    onSuccess: () => {
      return queryClient.invalidateQueries({
        predicate: (query) =>
          [
            "local-emulator-configs",
            "emulator-sync-status",
            "emulator-packages",
          ].some((key) => query.queryKey.includes(key)),
      });
    },
  });
}
