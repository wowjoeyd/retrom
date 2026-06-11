export const ARCHIVE_TYPES = [
  "zip",
  "7z",
  "tar_gz",
  "tar_xz",
  "appimage",
] as const;

export type ArchiveType = (typeof ARCHIVE_TYPES)[number];

const ARCHIVE_TYPE_LABELS: Record<ArchiveType, string> = {
  zip: "ZIP (.zip)",
  "7z": "7-Zip (.7z)",
  tar_gz: "Tarball (.tar.gz)",
  tar_xz: "Tarball (.tar.xz)",
  appimage: "AppImage",
};

export function archiveTypeLabel(type: ArchiveType): string {
  return ARCHIVE_TYPE_LABELS[type];
}

export function inferArchiveTypeFromUrl(url: string): ArchiveType | null {
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  let path: string;
  try {
    path = new URL(trimmed).pathname.toLowerCase();
  } catch {
    path = trimmed.toLowerCase();
  }

  if (path.endsWith(".tar.gz") || path.endsWith(".tgz")) {
    return "tar_gz";
  }
  if (path.endsWith(".tar.xz") || path.endsWith(".txz")) {
    return "tar_xz";
  }
  if (path.endsWith(".7z")) {
    return "7z";
  }
  if (path.endsWith(".zip")) {
    return "zip";
  }
  if (path.endsWith(".appimage")) {
    return "appimage";
  }

  return null;
}
