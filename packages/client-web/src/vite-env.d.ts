/// <reference types="vite/client" />

const _Vars = [
  "RETROM_PORT",
  "RETROM_HOST",
  "RETROM_HOSTNAME",
  "RETROM_LOCAL_SERVICE_HOST",
  "RETROM_VERSION",
  "UPTRACE_DSN",
  "BASE_URL",
  "OTEL_SERVICE_NAME",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "IS_DESKTOP",
  "RETROM_EMULATOR_PACKAGES_ENABLED",
  "EMULATOR_PACKAGE_SYNC",
  "EMULATOR_USER_DATA_ENHANCED",
  "RETROM_AUTO_SYNC_EMULATOR_USER_DATA",
] as const;

type Env = (typeof _Vars)[number] | `VITE_${(typeof _Vars)[number]}`;

// eslint-disable-next-line
interface ImportMetaEnv extends Record<Env, string | undefined> {}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
