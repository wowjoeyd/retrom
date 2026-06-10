import {
  create,
  fromBinary,
  MessageInitShape,
  toBinary,
} from "@bufbuild/protobuf";
import {
  EnsureEmulatorSyncedPayloadSchema,
  EmulatorSyncIndex,
  EmulatorSyncIndexSchema,
  EmulatorSyncProgressUpdate,
  EmulatorSyncProgressUpdateSchema,
  GetEmulatorSyncStatusPayloadSchema,
  GetEmulatorSyncStatusResponse,
  GetEmulatorSyncStatusResponseSchema,
} from "@retrom/codegen/retrom/client/emulator-sync_pb";
import {
  Channel,
  InvokeArgs,
  invoke as invokeImpl,
  InvokeOptions,
} from "@tauri-apps/api/core";

const invoke = <TOutput>(
  method: `plugin:emulator-sync|${string}`,
  args?: InvokeArgs,
  options?: InvokeOptions,
) => invokeImpl<TOutput>(method, args, options);

export async function ensureEmulatorSynced(
  payload: MessageInitShape<typeof EnsureEmulatorSyncedPayloadSchema>,
): Promise<string> {
  return invoke<string>("plugin:emulator-sync|ensure_emulator_synced", {
    payload: toBinary(
      EnsureEmulatorSyncedPayloadSchema,
      create(EnsureEmulatorSyncedPayloadSchema, payload),
    ),
  });
}

export async function getEmulatorSyncStatus(
  payload: MessageInitShape<typeof GetEmulatorSyncStatusPayloadSchema>,
): Promise<GetEmulatorSyncStatusResponse> {
  return invoke<number[]>("plugin:emulator-sync|get_emulator_sync_status", {
    payload: toBinary(
      GetEmulatorSyncStatusPayloadSchema,
      create(GetEmulatorSyncStatusPayloadSchema, payload),
    ),
  }).then((res) =>
    fromBinary(GetEmulatorSyncStatusResponseSchema, new Uint8Array(res)),
  );
}

export async function getEmulatorSyncIndex(): Promise<EmulatorSyncIndex> {
  return invoke<number[]>("plugin:emulator-sync|get_emulator_sync_index").then(
    (res) => fromBinary(EmulatorSyncIndexSchema, new Uint8Array(res)),
  );
}

export async function subscribeToEmulatorSyncUpdates<
  TCallback extends (update: EmulatorSyncProgressUpdate) => unknown,
>(onMessage: TCallback) {
  const channel = new Channel<number[]>((v) => {
    const message = fromBinary(
      EmulatorSyncProgressUpdateSchema,
      new Uint8Array(v),
    );

    onMessage(message);
  });

  await invoke("plugin:emulator-sync|subscribe_to_emulator_sync_updates", {
    channel,
  });

  return channel;
}

export async function unsubscribeFromEmulatorSyncUpdates(
  channel: Channel<number[]> | number,
) {
  const channelId = typeof channel === "number" ? channel : channel.id;

  return invoke("plugin:emulator-sync|unsubscribe_from_emulator_sync_updates", {
    channelId,
  });
}

export async function abortEmulatorSync(emulatorId: number): Promise<void> {
  return invoke("plugin:emulator-sync|abort_emulator_sync", { emulatorId });
}

export async function openEmulatorCacheDir(): Promise<void> {
  return invoke("plugin:emulator-sync|open_emulator_cache_dir");
}