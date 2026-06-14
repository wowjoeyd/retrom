import { pollJobSubscriptions } from "@/lib/pollJobSubscriptions";
import { useRetromClient } from "@/providers/retrom-client";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

type InstallCustomCatalogPackageRequest = Record<string, unknown>;
type InstallCustomCatalogPackageResponse = {
  jobId: string;
};

export function useInstallCustomCatalogPackage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: (request: InstallCustomCatalogPackageRequest) => {
      const client = retromClient.emulatorPackageClient as unknown as {
        installCustomCatalogPackage?: (
          req: InstallCustomCatalogPackageRequest,
        ) => Promise<InstallCustomCatalogPackageResponse>;
      };
      if (typeof client.installCustomCatalogPackage !== "function") {
        throw new Error(
          "Custom emulator package install is not supported by this server build",
        );
      }
      return client.installCustomCatalogPackage(request);
    },
    onError: (err) => {
      toast({
        title: "Custom emulator install failed",
        variant: "destructive",
        description: err.message,
      });
    },
    onSuccess: async ({ jobId }: InstallCustomCatalogPackageResponse) => {
      toast({ title: "Installing custom emulator package to NAS…" });

      await pollJobSubscriptions(retromClient, [jobId], (jobName) => {
        toast({ title: `Job complete: ${jobName}` });
      });

      await queryClient.invalidateQueries({
        predicate: (query) =>
          [
            "emulator-packages",
            "emulator-catalog",
            "emulators",
            "local-emulator-configs",
          ].some((key) => query.queryKey.includes(key)),
      });
    },
  });
}
