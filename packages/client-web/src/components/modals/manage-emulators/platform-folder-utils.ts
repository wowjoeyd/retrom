export function platformFolderBasename(platformPath: string): string {
  const normalized = platformPath.replace(/[/\\]+$/, "");
  const segments = normalized.split(/[/\\]/).filter(Boolean);
  return segments.at(-1) ?? platformPath;
}
