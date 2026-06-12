import { useLocalEmulatorConfigs } from "@/queries/useLocalEmulatorConfigs";
import {
  checkIsDesktop,
  isEmulatorPackageSyncEnabled,
  isEnhancedEmulatorUserDataEnabled,
} from "@/lib/env";
import { pushEmulatorPreserveData } from "@retrom/plugin-emulator-sync";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

export const EMULATOR_USER_DATA_AUTO_SYNC_KEY =
  "retrom-emulator-user-data-auto-sync";
const lastUserDataSyncKey = (emulatorId: number) =>
  `retrom-emulator-user-data-last-sync-${emulatorId}`;

export function emulatorUserDataAutoSyncEnabled() {
  return localStorage.getItem(EMULATOR_USER_DATA_AUTO_SYNC_KEY) === "true";
}

export function setEmulatorUserDataAutoSyncEnabled(enabled: boolean) {
  localStorage.setItem(EMULATOR_USER_DATA_AUTO_SYNC_KEY, String(enabled));
}

export function getLastEmulatorUserDataSync(emulatorId: number) {
  return localStorage.getItem(lastUserDataSyncKey(emulatorId));
}

export function setLastEmulatorUserDataSync(emulatorId: number, value = new Date()) {
  localStorage.setItem(lastUserDataSyncKey(emulatorId), value.toISOString());
}

export function EmulatorUserDataAutoSync() {
  const queryClient = useQueryClient();
  const started = useRef(false);
  const enabled =
    checkIsDesktop() &&
    isEmulatorPackageSyncEnabled() &&
    isEnhancedEmulatorUserDataEnabled() &&
    emulatorUserDataAutoSyncEnabled();

  const configs = useLocalEmulatorConfigs({
    enabled,
    selectFn: (data) =>
      data.configs.filter(
        (config) => config.managedPaths && config.linkedPackageId !== undefined,
      ),
  });

  useEffect(() => {
    if (!enabled || started.current || !configs.data?.length) {
      return;
    }

    started.current = true;
    void Promise.allSettled(
      configs.data.map((config) =>
        pushEmulatorPreserveData({ emulatorId: config.emulatorId }),
      ),
    ).then((results) => {
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && configs.data?.[index]) {
          setLastEmulatorUserDataSync(configs.data[index].emulatorId);
        }
      });
    }).finally(() => {
      void queryClient.invalidateQueries({
        predicate: (query) =>
          ["emulator-sync-status", "emulator-packages"].some((key) =>
            query.queryKey.includes(key),
          ),
      });
    });
  }, [configs.data, enabled, queryClient]);

  return null;
}
