import type { FileEntry } from './storage';

export interface DirectoryDiffEntry {
  relativePath: string;
  isDirectory: boolean;
  /**
   * 'conflict': the same relative path is a file on one side and a folder on the other. It is only reported:
   * nothing is copied to or deleted from it, and nothing below it is diffed.
   */
  status: 'new' | 'changed' | 'only-target' | 'conflict';
  sourceEntry?: FileEntry;
  targetEntry?: FileEntry;
}

export interface DirectoryDiffResult {
  entries: DirectoryDiffEntry[];
  counts: { new: number; changed: number; onlyTarget: number; same: number; conflict: number };
  scannedAt: string;
  /** Subdirectories that could not be read (e.g. permission denied) and were skipped, per side. */
  skippedPaths: { source: string[]; target: string[] };
  /**
   * Symbolic links (files and folders), per side. They are left out of the comparison on both sides: nothing is
   * copied from, written through or deleted at such a path, and nothing below it is compared.
   */
  skippedSymlinks: { source: string[]; target: string[] };
}

export interface DirectorySyncProfile {
  id: string;
  name: string;
  source: { providerConfigRef: string; path: string }; // ref to saved SFTP/S3 profile id, or 'local'
  target: { providerConfigRef: string; path: string };
  deleteExtraneous: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  /** Set when the profile is deleted; kept as a tombstone so remote profile sync can propagate the deletion. */
  deletedAt?: string;
}

export interface DirectorySyncApplyResult {
  copied: number;
  deleted: number;
  failed: number;
  errors: Array<{ path: string; error: string }>;
}
