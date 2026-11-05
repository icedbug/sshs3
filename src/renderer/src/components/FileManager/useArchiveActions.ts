import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { FileEntry } from '@shared/types/storage';
import { describeIpcError, joinPath } from '../../lib/format';
import type { SourceType } from './types';

/** Archives are packed and unpacked by tar/zip on the machine that holds the files, so only local and SFTP panes offer them. */
export function supportsArchives(sourceType: SourceType): boolean {
  return sourceType === 'local' || sourceType === 'sftp';
}

interface UseArchiveActionsParams {
  providerId: string;
  currentPath: string;
  selectedEntries: FileEntry[];
  load: (force?: boolean) => Promise<void> | void;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setSelectedPaths: Dispatch<SetStateAction<Set<string>>>;
  /** Moves the list's keyboard focus to the new item, so Enter acts on what is highlighted. */
  requestFocus: (path: string) => void;
}

/** Compress / extract for the selection of a file pane; the new archive or folder is selected afterwards. */
export function useArchiveActions({
  providerId,
  currentPath,
  selectedEntries,
  load,
  setLoading,
  setError,
  setSelectedPaths,
  requestFocus,
}: UseArchiveActionsParams) {
  // The operation can outlive the folder it started in; the latest path tells whether the pane is still there.
  const latestPathRef = useRef(currentPath);
  latestPathRef.current = currentPath;

  const run = useCallback(
    async (op: () => Promise<string>, failure: string) => {
      const startPath = currentPath;
      setLoading(true);
      setError(null);
      try {
        const createdName = await op();
        // Reloading or selecting after the user moved on would show the old folder's list in the new one.
        if (latestPathRef.current === startPath) {
          // Focus first: the list re-focuses its active row whenever its entries change, so asking after the
          // reload would let that pending re-focus put the keyboard focus back on the row that was clicked.
          const createdPath = joinPath(startPath, createdName);
          requestFocus(createdPath);
          await load(true);
          setSelectedPaths(new Set([createdPath]));
        }
      } catch (err) {
        setError(describeIpcError(err, failure));
      } finally {
        setLoading(false);
      }
    },
    [currentPath, load, setLoading, setError, setSelectedPaths, requestFocus]
  );

  const handleCompress = useCallback(
    (format: 'tar.gz' | 'zip') => {
      // Entries are named relative to the pane's folder; recursive-filter hits (names with a path) are not direct children.
      const names = selectedEntries.map((e) => e.name);
      if (names.length === 0 || names.some((n) => n.includes('/'))) return Promise.resolve();
      if (names.some((n) => n.includes('\\'))) {
        setError('Names containing a backslash cannot be archived. Rename them first.');
        return Promise.resolve();
      }
      return run(() => window.multissh.archiveCompress(providerId, currentPath, names, format), 'Failed to create archive');
    },
    [providerId, currentPath, selectedEntries, run, setError]
  );

  const handleExtract = useCallback(() => {
    if (selectedEntries.length !== 1) return Promise.resolve();
    const archivePath = selectedEntries[0].path;
    return run(() => window.multissh.archiveExtract(providerId, archivePath), 'Failed to extract archive');
  }, [providerId, selectedEntries, run]);

  return { handleCompress, handleExtract };
}
