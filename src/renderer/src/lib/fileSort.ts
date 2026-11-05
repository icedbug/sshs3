import type { FileEntry } from '@shared/types/storage';

export type FileSortKey = 'name' | 'size' | 'permissions' | 'mtime';
export type FileSortDir = 'asc' | 'desc';

/** Group order: directories, dot-directories, files, dotfiles. Stays fixed regardless of sort direction. */
function groupRank(e: FileEntry): number {
  // Recursive-filter hits carry a relative path as name; the dot test is on the entry's own name.
  const isDot = e.name.slice(e.name.lastIndexOf('/') + 1).startsWith('.');
  return (e.isDirectory ? 0 : 2) + (isDot ? 1 : 0);
}

function compareByKey(a: FileEntry, b: FileEntry, key: FileSortKey): number {
  switch (key) {
    case 'name':
      return a.name.localeCompare(b.name);
    case 'size':
      return a.size - b.size;
    case 'permissions':
      return (a.permissions ?? '').localeCompare(b.permissions ?? '');
    default:
      return (a.mtime ?? '').localeCompare(b.mtime ?? '');
  }
}

/** Returns a sorted copy; the sort direction only reorders entries within each group. */
export function sortFileEntries(entries: FileEntry[], key: FileSortKey, dir: FileSortDir): FileEntry[] {
  return [...entries].sort((a, b) => {
    const rank = groupRank(a) - groupRank(b);
    if (rank !== 0) return rank;
    const cmp = compareByKey(a, b, key);
    return dir === 'asc' ? cmp : -cmp;
  });
}
