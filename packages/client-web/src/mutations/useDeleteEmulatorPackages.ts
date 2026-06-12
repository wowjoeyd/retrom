import { DeleteEmulatorPackagesRequestSchema } from "@retrom/codegen/retrom/services/emulator-package-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageInitShape } from "@bufbuild/protobuf";

export function useDeleteEmulatorPackages() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: (
      request: MessageInitShape<typeof DeleteEmulatorPackagesRequestSchema>,
    ) => retromClient.emulatorPackageClient.deleteEmulatorPackages(request),
    onError: (err) => {
      toast({
        title: "Failed to remove emulator package",
        variant: "destructive",
        description: err.message,
      });
    },
    onSuccess: async ({ deletedPackageIds }) => {
      toast({
        title:
          deletedPackageIds.length === 1
            ? "Emulator package removed"
            : `${deletedPackageIds.length} emulator packages removed`,
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
