import { Code, ConnectError } from "@connectrpc/connect";
import { isEmulatorPackagesEnabled } from "@/lib/env";
import { useRetromClient } from "@/providers/retrom-client";
import { useQuery } from "@tanstack/react-query";

export function useEmulatorPackagesAvailable() {
  const retromClient = useRetromClient();
  const clientFlagEnabled = isEmulatorPackagesEnabled();

  return useQuery({
    queryKey: ["emulator-packages-available", retromClient, clientFlagEnabled],
    enabled: clientFlagEnabled,
    staleTime: 5 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      try {
        await retromClient.emulatorPackageClient.getEmulatorCatalog({});
        return true;
      } catch (error) {
        if (
          error instanceof ConnectError &&
          (error.code === Code.Unimplemented || error.code === Code.Unavailable)
        ) {
          return false;
        }

        throw error;
      }
    },
  });
}
