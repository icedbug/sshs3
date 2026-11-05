export type ArchiveKind = 'tar' | 'zip';

const TAR_EXTENSIONS = ['.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar'];

/** What extracts a file of this name, or `null` when it is not an archive we can unpack. */
export function detectArchiveKind(fileName: string): ArchiveKind | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  return TAR_EXTENSIONS.some((ext) => lower.endsWith(ext)) ? 'tar' : null;
}

/** "photos.tar.gz" -> "photos"; names without a known archive extension are returned unchanged. */
export function stripArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const ext of ['.zip', ...TAR_EXTENSIONS]) {
    if (lower.endsWith(ext) && fileName.length > ext.length) return fileName.slice(0, -ext.length);
  }
  return fileName;
}
