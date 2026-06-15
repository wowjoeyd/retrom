import { useRetromClient } from "@/providers/retrom-client";
import { DeleteEmulatorPackagesRequestSchema } from "@retrom/codegen/retrom/services/emulator-package-service_pb";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { create } from "@bufbuild/protobuf";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useDeleteEmulatorPackages() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: (request: { packageIds: number[]; deleteFiles?: boolean }) =>
      retromClient.emulatorPackageClient.deleteEmulatorPackages(
        create(DeleteEmulatorPackagesRequestSchema, request),
      ),
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
