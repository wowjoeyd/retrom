import { InstallCustomCatalogPackageRequestSchema } from "@retrom/codegen/retrom/services/emulator-package-service_pb";
import { pollJobSubscriptions } from "@/lib/pollJobSubscriptions";
import { useRetromClient } from "@/providers/retrom-client";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageInitShape } from "@bufbuild/protobuf";

export function useInstallCustomCatalogPackage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: (
      request: MessageInitShape<
        typeof InstallCustomCatalogPackageRequestSchema
      >,
    ) =>
      retromClient.emulatorPackageClient.installCustomCatalogPackage(request),
    onError: (err) => {
      toast({
        title: "Custom emulator install failed",
        variant: "destructive",
        description: err.message,
      });
    },
    onSuccess: async ({ jobId }) => {
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
