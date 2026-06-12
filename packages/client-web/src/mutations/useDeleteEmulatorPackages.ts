import { useRetromClient } from "@/providers/retrom-client";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

type DeleteEmulatorPackagesRequest = {
  packageIds: number[];
  deleteFiles?: boolean;
};

type DeleteEmulatorPackagesResponse = {
  deletedPackageIds: number[];
};

export function useDeleteEmulatorPackages() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: (request: DeleteEmulatorPackagesRequest) => {
      const client = retromClient.emulatorPackageClient as any;
      if (typeof client.deleteEmulatorPackages !== "function") {
        throw new Error("Deleting emulator packages is not supported by this server build");
      }
      return client.deleteEmulatorPackages(request) as Promise<DeleteEmulatorPackagesResponse>;
    },
    onError: (err) => {
      toast({
        title: "Failed to remove emulator package",
        variant: "destructive",
        description: err.message,
      });
    },
    onSuccess: async ({ deletedPackageIds }: DeleteEmulatorPackagesResponse) => {
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
