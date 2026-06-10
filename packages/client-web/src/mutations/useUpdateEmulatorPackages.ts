import { pollJobSubscriptions } from "@/lib/pollJobSubscriptions";
import { useRetromClient } from "@/providers/retrom-client";
import { useToast } from "@retrom/ui/hooks/use-toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useUpdateEmulatorPackages() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: () =>
      retromClient.emulatorPackageClient.updateEmulatorPackages({}),
    onError: (err) => {
      toast({
        title: "Error updating emulator packages",
        variant: "destructive",
        description: err.message,
      });
    },
    onSuccess: async ({ jobIds }) => {
      toast({ title: "Emulator package scan started" });

      await pollJobSubscriptions(retromClient, jobIds, (jobName) => {
        toast({ title: `Job complete: ${jobName}` });
      });

      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes("emulator-packages"),
      });
    },
  });
}