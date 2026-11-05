import { transferFile, joinPaths, getBaseName } from '../transfer/TransferPipeline';
import type { IStorageProvider, FileEntry, TransferProgress } from '../../shared/types/storage';
import type { DirectoryDiffEntry, DirectoryDiffResult, DirectorySyncApplyResult } from '../../shared/types/dirsync';

/** Tolerance for mtime comparisons (filesystem/SFTP clock drift, sub-second truncation). */
const MTIME_TOLERANCE_MS = 2000;

export type ScanSide = 'source' | 'target';
export type ScanProgressCallback = (side: ScanSide, filesCount: number, currentItem: string) => void;

function isNotFoundError(err: unknown): boolean {
  // Codes only: matching message text would also accept e.g. "bucket does not exist" or "network path not found".
  const e = err as { code?: unknown; name?: unknown; statusCode?: unknown } | null;
  // The OpenSSH SFTP engine reports SSH_FX_NO_SUCH_FILE as SftpError.statusCode 2 and sets no `code`.
  if (e?.name === 'SftpError' && e.statusCode === 2) return true;
  return e?.code === 'ENOENT' || e?.code === 'NoSuchKey' || e?.code === 2;
}

/** True when `relativePath` is one of `skipped` or lies below one of them. */
function isUnderSkipped(relativePath: string, skipped: string[]): boolean {
  return skipped.some((p) => relativePath === p || relativePath.startsWith(`${p}/`));
}

/**
 * Recursively walks a directory tree via provider.list(), building a flat
 * Map<relativePath, FileEntry> keyed by POSIX-style relative path (relative
 * to rootPath). Mirrors the traversal/path-handling style of the internal
 * scanDirectory() in TransferPipeline.ts.
 */
export async function buildTree(
  provider: IStorageProvider,
  rootPath: string,
  onScanProgress?: (filesCount: number, currentItem: string) => void,
  state: { count: number } = { count: 0 },
  skipped: string[] = [],
  symlinks: string[] = []
): Promise<Map<string, FileEntry>> {
  const result = new Map<string, FileEntry>();

  async function walk(currentPath: string, relPrefix: string, isRoot: boolean): Promise<void> {
    let entries: FileEntry[];
    try {
      entries = await provider.list(currentPath);
    } catch (err) {
      // The root not existing yet is normal (e.g. a brand-new nested sync
      // target) and shouldn't be reported as a problem — it's simply empty.
      // Any other failure at the root (broken connection, permission denied)
      // must abort: treating the tree as empty would make the other side look
      // entirely new / entirely extraneous.
      // A subdirectory that *was* listed a moment ago failing to read
      // (permission denied, transient disappearance, etc.) is a real
      // anomaly, so only those get surfaced to the user as skipped.
      if (isRoot) {
        if (isNotFoundError(err)) return;
        throw err;
      }
      skipped.push(relPrefix || currentPath);
      return;
    }

    for (const entry of entries) {
      const baseName = getBaseName(entry.name.replace(/\\/g, '/')) || entry.name;
      if (!baseName || baseName === '.' || baseName === '..') {
        continue;
      }
      // FIFOs, sockets and devices are never copied, so they are not part of the comparison either.
      if (entry.isSpecial) continue;
      const relativePath = relPrefix ? `${relPrefix}/${baseName}` : baseName;
      const childPath = entry.path || joinPaths(provider.type, currentPath, baseName);

      // Symbolic links, files and folders alike, are left out and only reported (as transfers do). A folder link
      // is never followed: a link back to an ancestor would expand into phantom entries until the OS gives up
      // (ELOOP). A file link is not copied as content, and a link on the target is never written through (that
      // could overwrite a file outside the target folder). Because the path is reported as skipped, nothing at or
      // below it is copied as "new" or deleted as "extraneous" on the strength of the other side alone.
      if (entry.isSymlink) {
        symlinks.push(relativePath);
        continue;
      }

      result.set(relativePath, entry);
      state.count++;
      onScanProgress?.(state.count, relativePath);

      if (entry.isDirectory) {
        await walk(childPath, relativePath, false);
      }
    }
  }

  await walk(rootPath, '', true);
  return result;
}

/**
 * Compares a source and target directory tree (both walked in parallel) and
 * classifies each relative path as 'new' (source only), 'changed' (both
 * present but size/mtime differ beyond tolerance), 'only-target' (target
 * only), 'conflict' (a file on one side and a folder on the other), or
 * 'same' (excluded from `entries`, counted only).
 */
export async function computeDiff(
  sourceProvider: IStorageProvider,
  sourcePath: string,
  targetProvider: IStorageProvider,
  targetPath: string,
  onScanProgress?: ScanProgressCallback
): Promise<DirectoryDiffResult> {
  const unreadableSource: string[] = [];
  const unreadableTarget: string[] = [];
  const symlinksSource: string[] = [];
  const symlinksTarget: string[] = [];
  const [sourceMap, targetMap] = await Promise.all([
    buildTree(sourceProvider, sourcePath, (count, item) => onScanProgress?.('source', count, item), { count: 0 }, unreadableSource, symlinksSource),
    buildTree(targetProvider, targetPath, (count, item) => onScanProgress?.('target', count, item), { count: 0 }, unreadableTarget, symlinksTarget),
  ]);
  // For the "unknown, not new/extraneous" rule an unreadable folder and a symlink behave the same.
  const skippedSource = [...unreadableSource, ...symlinksSource];
  const skippedTarget = [...unreadableTarget, ...symlinksTarget];

  const entries: DirectoryDiffEntry[] = [];
  const counts = { new: 0, changed: 0, onlyTarget: 0, same: 0, conflict: 0 };

  // A path that is a file on one side and a folder on the other. What lies below it is unknown territory, so
  // nothing under it may be copied as "new" or deleted as "extraneous" on the strength of one side alone.
  const conflictPaths: string[] = [];
  for (const [relativePath, sourceEntry] of sourceMap) {
    const targetEntry = targetMap.get(relativePath);
    if (targetEntry && Boolean(sourceEntry.isDirectory) !== Boolean(targetEntry.isDirectory)) {
      conflictPaths.push(relativePath);
    }
  }
  const isBelowConflict = (relativePath: string): boolean =>
    conflictPaths.some((p) => relativePath.startsWith(`${p}/`));

  const allKeys = new Set<string>([...sourceMap.keys(), ...targetMap.keys()]);
  const sortedKeys = Array.from(allKeys).sort((a, b) => a.localeCompare(b));

  for (const relativePath of sortedKeys) {
    const sourceEntry = sourceMap.get(relativePath);
    const targetEntry = targetMap.get(relativePath);

    if (sourceEntry && !targetEntry) {
      // Under a target folder that could not be read this only means "unknown", not "new".
      if (isUnderSkipped(relativePath, skippedTarget) || isBelowConflict(relativePath)) continue;
      entries.push({ relativePath, isDirectory: sourceEntry.isDirectory, status: 'new', sourceEntry });
      counts.new++;
      continue;
    }

    if (!sourceEntry && targetEntry) {
      // Under a source folder that could not be read this only means "unknown", not "extraneous".
      if (isUnderSkipped(relativePath, skippedSource) || isBelowConflict(relativePath)) continue;
      entries.push({ relativePath, isDirectory: targetEntry.isDirectory, status: 'only-target', targetEntry });
      counts.onlyTarget++;
      continue;
    }

    if (sourceEntry && targetEntry) {
      if (Boolean(sourceEntry.isDirectory) !== Boolean(targetEntry.isDirectory)) {
        entries.push({ relativePath, isDirectory: sourceEntry.isDirectory, status: 'conflict', sourceEntry, targetEntry });
        counts.conflict++;
        continue;
      }

      // Directories match on presence alone; there's no meaningful size/mtime to diff.
      if (sourceEntry.isDirectory) {
        counts.same++;
        continue;
      }

      const sizeDiffers = sourceEntry.size !== targetEntry.size;
      let mtimeDiffers = false;
      if (sourceEntry.mtimeMs !== undefined && targetEntry.mtimeMs !== undefined) {
        mtimeDiffers = Math.abs(sourceEntry.mtimeMs - targetEntry.mtimeMs) > MTIME_TOLERANCE_MS;
      }

      if (sizeDiffers || mtimeDiffers) {
        entries.push({ relativePath, isDirectory: false, status: 'changed', sourceEntry, targetEntry });
        counts.changed++;
      } else {
        counts.same++;
      }
    }
  }

  return {
    entries,
    counts,
    scannedAt: new Date().toISOString(),
    skippedPaths: { source: unreadableSource, target: unreadableTarget },
    skippedSymlinks: { source: symlinksSource, target: symlinksTarget },
  };
}

export interface ApplyOptions {
  deleteExtraneous: boolean;
}

/**
 * Applies a (possibly filtered) set of diff entries: copies included
 * new/changed entries from source to target (creating target folders first),
 * and — when deleteExtraneous is set — deletes included only-target entries.
 * 'conflict' entries (file vs folder) are never acted on, whatever the caller passes in.
 */
export async function apply(
  entries: DirectoryDiffEntry[],
  sourceProvider: IStorageProvider,
  targetProvider: IStorageProvider,
  targetPath: string,
  options: ApplyOptions,
  onProgress?: (progress: TransferProgress) => void
): Promise<DirectorySyncApplyResult> {
  const result: DirectorySyncApplyResult = { copied: 0, deleted: 0, failed: 0, errors: [] };
  const jobId = 'dirsync-apply';

  // The sync root itself (e.g. the source folder nested under the chosen
  // target parent) may not exist yet — create it before copying into it.
  try {
    await targetProvider.createFolder(targetPath);
  } catch {
    // Already exists (or provider doesn't need explicit creation) — fine.
  }

  const toCopy = entries.filter((e) => e.status === 'new' || e.status === 'changed');
  const dirsToCreate = toCopy
    .filter((e) => e.isDirectory)
    .sort((a, b) => a.relativePath.split('/').length - b.relativePath.split('/').length);
  const filesToCopy = toCopy.filter((e) => !e.isDirectory);

  for (const dirEntry of dirsToCreate) {
    try {
      const targetFull = joinPaths(targetProvider.type, targetPath, dirEntry.relativePath);
      await targetProvider.createFolder(targetFull);
    } catch (err) {
      result.failed++;
      result.errors.push({ path: dirEntry.relativePath, error: (err as Error)?.message ?? String(err) });
    }
  }

  for (const fileEntry of filesToCopy) {
    const sourceFull = fileEntry.sourceEntry?.path ?? joinPaths(sourceProvider.type, '', fileEntry.relativePath);
    const targetFull = joinPaths(targetProvider.type, targetPath, fileEntry.relativePath);
    try {
      await transferFile({
        jobId,
        sourceProvider,
        sourcePath: sourceFull,
        targetProvider,
        targetPath: targetFull,
        totalBytes: fileEntry.sourceEntry?.size,
        onProgress,
      });
      // Preserve the source's mtime on the target so the *next* diff compares
      // against the original modification time, not "when it was copied" —
      // otherwise every synced file would look "changed" on every re-run.
      if (fileEntry.sourceEntry?.mtimeMs !== undefined) {
        try {
          await targetProvider.setModifiedTime?.(targetFull, fileEntry.sourceEntry.mtimeMs);
        } catch {
          // Not fatal — the copy itself succeeded, and not every provider
          // combination can preserve mtime (e.g. an S3 target).
        }
      }
      result.copied++;
    } catch (err) {
      result.failed++;
      result.errors.push({ path: fileEntry.relativePath, error: (err as Error)?.message ?? String(err) });
    }
  }

  if (options.deleteExtraneous) {
    const toDelete = entries.filter((e) => e.status === 'only-target');
    // Deepest paths first so a directory is emptied before it is removed.
    const sortedForDelete = [...toDelete].sort(
      (a, b) => b.relativePath.split('/').length - a.relativePath.split('/').length
    );
    for (const delEntry of sortedForDelete) {
      const targetFull = delEntry.targetEntry?.path ?? joinPaths(targetProvider.type, targetPath, delEntry.relativePath);
      try {
        await targetProvider.delete(targetFull, delEntry.isDirectory);
        result.deleted++;
      } catch (err) {
        result.failed++;
        result.errors.push({ path: delEntry.relativePath, error: (err as Error)?.message ?? String(err) });
      }
    }
  }

  return result;
}

export class DirectorySyncService {
  buildTree = buildTree;
  computeDiff = computeDiff;
  apply = apply;
}
