import { PropsWithChildren, ReactNode } from "react";

export function checkIsDesktop() {
  return (
    import.meta.env.IS_DESKTOP !== undefined ||
    import.meta.env.VITE_IS_DESKTOP !== undefined
  );
}

export function isEmulatorPackagesEnabled() {
  const value =
    import.meta.env.VITE_RETROM_EMULATOR_PACKAGES_ENABLED ??
    import.meta.env.RETROM_EMULATOR_PACKAGES_ENABLED;

  if (!value) {
    return true;
  }

  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

export function isEmulatorPackageSyncEnabled() {
  const value =
    import.meta.env.VITE_EMULATOR_PACKAGE_SYNC ??
    import.meta.env.EMULATOR_PACKAGE_SYNC;

  if (!value) {
    return true;
  }

  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

export function isEnhancedEmulatorUserDataEnabled() {
  const value =
    import.meta.env.VITE_EMULATOR_USER_DATA_ENHANCED ??
    import.meta.env.EMULATOR_USER_DATA_ENHANCED;

  if (!value) {
    return false;
  }

  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

export function DesktopOnly(props: PropsWithChildren) {
  return checkIsDesktop() ? <> {props.children} </> : <></>;
}

export function WebOnly(props: PropsWithChildren) {
  return !checkIsDesktop() ? <> {props.children} </> : <></>;
}

export function PlatformDependent(props: {
  desktop?: ReactNode;
  web?: ReactNode;
}) {
  return <>{checkIsDesktop() ? props.desktop : props.web}</>;
}
