export function isValidTag(tag: unknown): boolean;
export function rpmChangelogDate(date: Date): string;
export function latestChangelogPackager(specText: string): string | null;
export function renderSpec(
  specText: string,
  options: { version: string; sha256: string; release: number; date: Date; packager: string },
): string;
