import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { app } from 'electron';
import type { DotfileImportedFile, DotfilePool } from '../../shared/types/dotfiles';
import { defaultDotfileRemotePath } from '../../shared/dotfilePath';
import { backupCorruptFile, writeFileAtomic } from '../storage/atomicFile';

function formatTimestamp(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

/** Pooled content is stored as UTF-8 text; larger or binary files are not importable. */
const MAX_IMPORT_BYTES = 1024 * 1024;

export class DotfilePoolStore {
  private filePath: string;
  private baseDir: string;
  private masterDir: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
      this.baseDir = path.dirname(customPath);
    } else {
      let baseDir: string;
      try {
        baseDir = app.getPath('userData');
      } catch {
        baseDir = path.join(os.homedir(), '.sshs3');
      }
      this.baseDir = baseDir;
      this.filePath = path.join(baseDir, 'dotfile-pools.json');
    }
    this.masterDir = path.join(this.baseDir, 'dotfiles');
  }

  public getFilePath(): string {
    return this.filePath;
  }

  public getMasterDir(): string {
    return this.masterDir;
  }

  public sanitizePoolId(poolId: string): string {
    if (!poolId || typeof poolId !== 'string') {
      throw new Error('Invalid pool ID');
    }
    const trimmed = poolId.trim();
    if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..') || !/^[a-zA-Z0-9_\-.]+$/.test(trimmed)) {
      throw new Error(`Invalid pool ID format: ${poolId}`);
    }
    const resolved = path.resolve(this.masterDir, trimmed);
    if (!resolved.startsWith(this.masterDir + path.sep)) {
      throw new Error(`Path traversal detected in pool ID: ${poolId}`);
    }
    return trimmed;
  }

  public getPoolDirectory(poolId: string): string {
    const cleanId = this.sanitizePoolId(poolId);
    return path.join(this.masterDir, cleanId);
  }

  public getMasterFilePath(poolId: string, remotePath: string): string {
    const rel = remotePath.replace(/^~[/\\]?/, '').replace(/^[/\\]+/, '');
    const poolDir = this.getPoolDirectory(poolId);
    const resolved = path.resolve(poolDir, rel || 'unnamed-file');
    if (!resolved.startsWith(poolDir + path.sep) && resolved !== poolDir) {
      return path.join(poolDir, path.basename(remotePath) || 'unnamed-file');
    }
    return resolved;
  }

  private async readRawPools(): Promise<DotfilePool[]> {
    let raw: string | undefined;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      return Array.isArray(data.pools) ? data.pools : [];
    } catch (err) {
      // [] would make the next save drop every pool: keep a copy of an unparsable file first.
      if (raw !== undefined && err instanceof SyntaxError) await backupCorruptFile(this.filePath, raw);
      return [];
    }
  }

  public async getPools(options?: { includeDeleted?: boolean }): Promise<DotfilePool[]> {
    const rawPools = await this.readRawPools();
    const pools: DotfilePool[] = [];
    for (const pool of rawPools) {
      try {
        pool.masterDirectory = this.getPoolDirectory(pool.id);
      } catch {
        continue;
      }
      pools.push(pool);
      for (const file of pool.files) {
        try {
          const masterPath = this.getMasterFilePath(pool.id, file.remotePath);
          file.masterFilePath = masterPath;
          file.masterFileName = path.basename(masterPath);
          try {
            const diskContent = await fs.readFile(masterPath, 'utf-8');
            file.content = diskContent;
          } catch {
            // If file does not exist on disk yet, keep pool file content
          }
        } catch {
          // Skip invalid file path mapping
        }
      }
    }
    if (options?.includeDeleted) {
      return pools;
    }
    // Hide soft-deleted (tombstoned) pools/files from normal callers. Only
    // remote profile sync (via includeDeleted: true) needs to see these, so
    // it can propagate the deletion to other machines.
    return pools
      .filter((pool) => !pool.deletedAt)
      .map((pool) => ({ ...pool, files: pool.files.filter((file) => !file.deletedAt) }));
  }

  public async getPool(id: string, options?: { includeDeleted?: boolean }): Promise<DotfilePool | undefined> {
    const pools = await this.getPools(options);
    return pools.find((p) => p.id === id);
  }

  /**
   * @param options.preserveTimestamps When true, skip auto-stamping
   *   pool/file `updatedAt`. Used exclusively by remote profile sync when
   *   writing back an already-merged pool, so the timestamps that the merge
   *   decision was based on aren't overwritten with "now".
   */
  public async savePool(pool: DotfilePool, options?: { preserveTimestamps?: boolean }): Promise<void> {
    if (!pool || !pool.id || typeof pool.id !== 'string' || !pool.id.trim()) {
      throw new Error('Pool ID is required');
    }

    return this.queueMutation(() => this.savePoolUnqueued(pool, options));
  }

  /** The body of `savePool`; callers must already hold the write queue (see `queueMutation`). */
  private async savePoolUnqueued(pool: DotfilePool, options?: { preserveTimestamps?: boolean }): Promise<void> {
    const poolDir = this.getPoolDirectory(pool.id);
    if (pool.deletedAt) {
      try {
        await fs.rm(poolDir, { recursive: true, force: true });
      } catch {
        // Ignore folder deletion failure
      }
    } else {
      await fs.mkdir(poolDir, { recursive: true });
    }

    const existingPools = await this.readRawPools();
    const existingFilesById = new Map(
      (existingPools.find((p) => p.id === pool.id)?.files ?? []).map((f) => [f.id, f])
    );

    // Callers (the pool editor) work from getPools(), which hides file tombstones, so saving that
    // list back would drop them and let other machines resurrect the deleted files. Carry over
    // any stored tombstone the incoming pool does not mention. (A sync pull passes tombstones itself.)
    const persistedFiles = [...pool.files];
    if (!pool.deletedAt) {
      const incomingIds = new Set(pool.files.map((f) => f.id).filter(Boolean));
      for (const old of existingPools.find((p) => p.id === pool.id)?.files ?? []) {
        if (old.deletedAt && !incomingIds.has(old.id)) persistedFiles.push(old);
      }
    }

    const now = formatTimestamp();
    pool.masterDirectory = poolDir;
    if (!options?.preserveTimestamps) {
      pool.updatedAt = now;
    }

    // Write master files to disk (for non-deleted files and pools)
    if (!pool.deletedAt) {
      for (const file of pool.files) {
        if (!file.id) {
          file.id = crypto.randomUUID();
        }
        const masterPath = this.getMasterFilePath(pool.id, file.remotePath);
        file.masterFilePath = masterPath;
        file.masterFileName = path.basename(masterPath);

        if (file.deletedAt) {
          // A tombstone must not delete the master file of an active file that maps to the same path.
          const sharedWithActive = pool.files.some(
            (other) => !other.deletedAt && this.getMasterFilePath(pool.id, other.remotePath) === masterPath
          );
          if (sharedWithActive) continue;
          try {
            await fs.rm(masterPath, { force: true });
          } catch {
            // Ignore file deletion failure
          }
        } else {
          await fs.mkdir(path.dirname(masterPath), { recursive: true });
          await fs.writeFile(masterPath, file.content, 'utf-8');

          if (file.mode) {
            try {
              const modeNum = parseInt(file.mode, 8);
              if (!isNaN(modeNum)) {
                await fs.chmod(masterPath, modeNum);
              }
            } catch {
              // Ignore chmod failures on non-POSIX filesystems
            }
          }
        }

        if (!options?.preserveTimestamps) {
          const existingFile = existingFilesById.get(file.id);
          const contentChanged =
            !existingFile ||
            existingFile.content !== file.content ||
            existingFile.mode !== file.mode ||
            existingFile.remotePath !== file.remotePath;
          file.updatedAt = contentChanged ? now : (file.updatedAt ?? existingFile?.updatedAt ?? now);
        }
      }
    }

    const pools = await this.readRawPools();
    const index = pools.findIndex((p) => p.id === pool.id);
    const toPersist: DotfilePool = { ...pool, files: persistedFiles };
    if (index >= 0) {
      pools[index] = toPersist;
    } else {
      pools.push(toPersist);
    }
    await this.persist(pools);
  }

  public async deletePool(id: string): Promise<void> {
    if (!id || typeof id !== 'string') return;
    let poolDir: string;
    try {
      poolDir = this.getPoolDirectory(id);
    } catch {
      return;
    }
    return this.queueMutation(async () => {
      const pools = await this.readRawPools();
      const pool = pools.find((p) => p.id === id && !p.deletedAt);
      if (pool) {
        const now = formatTimestamp();
        // Soft-delete: keep a lightweight tombstone (no file contents, they're
        // gone from disk below) so remote profile sync can propagate the
        // deletion instead of the pool silently reappearing on the next pull.
        pool.deletedAt = now;
        pool.updatedAt = now;
        pool.files = [];
        await this.persist(pools);
      }
      try {
        await fs.rm(poolDir, { recursive: true, force: true });
      } catch {
        // Ignore folder deletion failure
      }
    });
  }

  /**
   * Same as getPools({ includeDeleted: true }), provided as a clearer entry
   * point for remote profile sync.
   */
  public async getPoolsIncludingTombstones(): Promise<DotfilePool[]> {
    return this.getPools({ includeDeleted: true });
  }

  public async openPoolFolder(poolId: string): Promise<string> {
    const poolDir = this.getPoolDirectory(poolId);
    await fs.mkdir(poolDir, { recursive: true });
    try {
      const { shell } = await import('electron');
      if (shell?.openPath) {
        return await shell.openPath(poolDir);
      }
    } catch {
      // Ignore in non-electron environments
    }
    return '';
  }

  /**
   * Reads local files chosen by the user (or previously pooled via
   * `sourcePath`). Only regular, non-binary files up to MAX_IMPORT_BYTES are
   * returned; anything missing, unreadable or skipped is simply absent so
   * callers can treat absence as "source missing".
   */
  public async importLocalFiles(filePaths: string[]): Promise<DotfileImportedFile[]> {
    const results: DotfileImportedFile[] = [];
    const home = os.homedir();
    for (const p of filePaths) {
      try {
        if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
        const stat = await fs.stat(p);
        if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) continue;
        const buf = await fs.readFile(p);
        if (buf.includes(0)) continue;
        results.push({
          name: path.basename(p),
          path: p,
          content: buf.toString('utf-8'),
          mode: (stat.mode & 0o777).toString(8),
          size: stat.size,
          suggestedRemotePath: defaultDotfileRemotePath(p, home),
        });
      } catch {
        // Skip files that cannot be read
      }
    }
    return results;
  }

  public async addFileToPool(
    poolId: string,
    fileData: { remotePath: string; content: string; mode?: string; sourcePath?: string }
  ): Promise<DotfilePool> {
    // One queued read-modify-write; getPools() → savePool() outside the queue could interleave with another save.
    return this.queueMutation(async () => {
      const pools = await this.getPools();
      let pool = pools.find((p) => p.id === poolId);
      if (!pool) {
        pool = {
          id: poolId,
          name: 'Default Pool',
          files: [],
        };
      }

      const existingFile = pool.files.find((f) => f.remotePath === fileData.remotePath);
      if (existingFile) {
        existingFile.content = fileData.content;
        if (fileData.mode) existingFile.mode = fileData.mode;
        if (fileData.sourcePath) existingFile.sourcePath = fileData.sourcePath;
        existingFile.updatedAt = formatTimestamp();
      } else {
        pool.files.push({
          id: crypto.randomUUID(),
          remotePath: fileData.remotePath,
          content: fileData.content,
          mode: fileData.mode,
          sourcePath: fileData.sourcePath,
          updatedAt: formatTimestamp(),
        });
      }

      await this.savePoolUnqueued(pool);
      return (await this.getPool(poolId))!;
    });
  }

  private queueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const resultPromise = this.writeQueue.then(mutation, mutation);
    this.writeQueue = resultPromise.then(
      () => {},
      () => {}
    );
    return resultPromise;
  }

  private async persist(pools: DotfilePool[]): Promise<void> {
    await writeFileAtomic(this.filePath, JSON.stringify({ pools }, null, 2), { mode: 0o600 });
  }
}
