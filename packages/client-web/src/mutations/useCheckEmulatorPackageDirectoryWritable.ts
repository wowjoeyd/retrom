import {
  CheckEmulatorPackageDirectoryWritableRequestSchema,
} from "@retrom/codegen/retrom/services/emulator-package-service_pb";
import { useRetromClient } from "@/providers/retrom-client";
import { useMutation } from "@tanstack/react-query";
import { MessageInitShape } from "@bufbuild/protobuf";

export function useCheckEmulatorPackageDirectoryWritable() {
  const retromClient = useRetromClient();

  return useMutation({
    mutationFn: (
      request: MessageInitShape<
        typeof CheckEmulatorPackageDirectoryWritableRequestSchema
      >,
    ) =>
      retromClient.emulatorPackageClient.checkEmulatorPackageDirectoryWritable(
        request,
      ),
  });
}