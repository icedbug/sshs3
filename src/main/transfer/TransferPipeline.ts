import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  FileEntry,
  IStorageProvider,
  StorageType,
  TransferProgress,
} from '../../shared/types/storage';
import { settleTargetTouched, wasTargetTouched, whenTargetSettledLater } from '../storage/targetTouched';

/**
 * Controller to pause and resume streaming in TransferPipeline.
 */
export class PauseController {
  private _isPaused = false;
  private _resumeResolvers: Array<() => void> = [];

  get isPaused(): boolean {
    return this._isPaused;
  }

  pause(): void {
    this._isPaused = true;
  }

  resume(): void {
    if (this._isPaused) {
      this._isPaused = false;
      const resolvers = this._resumeResolvers;
      this._resumeResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  async waitIfPaused(): Promise<void> {
    if (!this._isPaused) return;
    await new Promise<void>((resolve) => {
      this._resumeResolvers.push(resolve);
    });
  }

  abort(): void {
    if (this._isPaused) {
      this.resume();
    }
  }
}

export interface ByteMeterOptions {
  jobId?: string;
  fileName?: string;
  totalBytes?: number;
  throttleIntervalMs?: number;
  signal?: AbortSignal;
  pauseController?: PauseController;
  onProgress?: (progress: TransferProgress) => void;
  emitCompletedOnFlush?: boolean;
  computeChecksum?: boolean;
}

/**
 * Transform stream that counts bytes, computes transfer speed (bytes/s),
 * throttles progress updates to avoid flooding event loops, and coordinates pausing.
 */
export class ByteMeter extends Transform {
  public transferredBytes = 0;
  public totalBytes: number;
  public readonly jobId: string;
  public readonly fileName: string;
  private readonly throttleIntervalMs: number;
  private readonly signal?: AbortSignal;
  private readonly pauseController?: PauseController;
  private readonly onProgress?: (progress: TransferProgress) => void;
  private readonly emitCompletedOnFlush: boolean;
  private readonly computeChecksum: boolean;
  private hasher?: crypto.Hash;
  private md5Hasher?: crypto.Hash;
  private _sha256?: string;
  private _md5?: string;
  private startTime = 0;
  private lastEmitTime = 0;
  private lastEmittedBytes = 0;

  constructor(options: ByteMeterOptions = {}) {
    super();
    this.jobId = options.jobId ?? 'transfer-job';
    this.fileName = options.fileName ?? 'unknown';
    this.totalBytes = options.totalBytes ?? 0;
    this.throttleIntervalMs = options.throttleIntervalMs ?? 100;
    this.signal = options.signal;
    this.pauseController = options.pauseController;
    this.onProgress = options.onProgress;
    this.emitCompletedOnFlush = options.emitCompletedOnFlush ?? true;
    this.computeChecksum = options.computeChecksum ?? true;
    if (this.computeChecksum) {
      this.hasher = crypto.createHash('sha256');
      this.md5Hasher = crypto.createHash('md5');
    }
  }

  private calculateSpeed(now: number): number {
    if (this.lastEmitTime > 0 && now > this.lastEmitTime) {
      const deltaBytes = this.transferredBytes - this.lastEmittedBytes;
      const deltaTime = (now - this.lastEmitTime) / 1000;
      if (deltaTime > 0) {
        return Math.round(deltaBytes / deltaTime);
      }
    }
    if (this.startTime === 0) return 0;
    const elapsedSec = (now - this.startTime) / 1000;
    return elapsedSec > 0 ? Math.round(this.transferredBytes / elapsedSec) : 0;
  }

  private emitProgress(status: TransferProgress['status']): void {
    if (!this.onProgress) return;
    const now = Date.now();
    const bytesPerSecond = this.calculateSpeed(now);
    const total = this.totalBytes > 0 ? this.totalBytes : this.transferredBytes;
    const percentage =
      total > 0
        ? Math.min(100, Math.round((this.transferredBytes / total) * 100))
        : status === 'completed'
          ? 100
          : 0;

    this.onProgress({
      jobId: this.jobId,
      fileName: this.fileName,
      transferredBytes: this.transferredBytes,
      totalBytes: this.totalBytes,
      percentage,
      bytesPerSecond,
      status,
    });
  }

  override async _transform(
    chunk: any,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): Promise<void> {
    try {
      if (this.signal?.aborted) {
        const err = new Error('Transfer aborted');
        err.name = 'AbortError';
        callback(err);
        return;
      }

      if (this.pauseController?.isPaused) {
        if (this.signal) {
          const onAbort = () => {
            this.pauseController?.abort();
          };
          this.signal.addEventListener('abort', onAbort, { once: true });
          try {
            await this.pauseController.waitIfPaused();
          } finally {
            this.signal.removeEventListener('abort', onAbort);
          }
        } else {
          await this.pauseController.waitIfPaused();
        }
      }

      if (this.signal?.aborted) {
        const err = new Error('Transfer aborted');
        err.name = 'AbortError';
        callback(err);
        return;
      }

      const now = Date.now();
      if (this.startTime === 0) {
        this.startTime = now;
      }

      const chunkSize = Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk);
      this.transferredBytes += chunkSize;

      if (this.hasher) {
        this.hasher.update(chunk);
        this.md5Hasher?.update(chunk);
      }

      if (this.throttleIntervalMs === 0) {
        this.emitProgress('running');
        this.lastEmitTime = now;
        this.lastEmittedBytes = this.transferredBytes;
      } else if (
        this.lastEmitTime === 0 ||
        now - this.lastEmitTime >= this.throttleIntervalMs
      ) {
        this.emitProgress('running');
        this.lastEmitTime = now;
        this.lastEmittedBytes = this.transferredBytes;
      }

      callback(null, chunk);
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    if (this.startTime === 0) {
      this.startTime = Date.now();
    }
    if (this.hasher && !this._sha256) {
      this._sha256 = this.hasher.digest('hex');
      this._md5 = this.md5Hasher?.digest('hex');
    }
    if (this.emitCompletedOnFlush) {
      this.emitProgress('completed');
    }
    callback();
  }

  /**
   * Returns the computed SHA-256 digest of the transferred bytes in hex.
   */
  get sha256(): string | undefined {
    if (this.hasher && !this._sha256) {
      this._sha256 = this.hasher.digest('hex');
      this._md5 = this.md5Hasher?.digest('hex');
    }
    return this._sha256;
  }

  /**
   * Returns the computed MD5 digest of the transferred bytes in hex.
   */
  get md5(): string | undefined {
    if (this.md5Hasher && !this._md5) {
      this._sha256 = this.hasher?.digest('hex');
      this._md5 = this.md5Hasher.digest('hex');
    }
    return this._md5;
  }

  /**
   * Emits the 'completed' progress event on demand (M8, code review):
   * transferFile() suppresses the automatic _flush-time emission above so it
   * can verify transferredBytes against the source's size first, and only
   * then report completion — never before that check has passed.
   */
  public emitCompletedNow(): void {
    this.emitProgress('completed');
  }
}

export interface TransferOptions {
  jobId?: string;
  sourceProvider: IStorageProvider;
  sourcePath: string;
  targetProvider: IStorageProvider;
  targetPath: string;
  totalBytes?: number;
  signal?: AbortSignal;
  pauseController?: PauseController;
  onProgress?: (progress: TransferProgress) => void;
  throttleIntervalMs?: number;
  emitCompleted?: boolean;
  /** How long a failed transfer waits for an open that is still on the wire (default 5 s); tests shorten it. */
  targetSettleTimeoutMs?: number;
  verifyIntegrity?: boolean;
  verifyChecksum?: boolean | 'sha256' | 'md5';
  expectedChecksum?: string;
  maxRetries?: number;
  concurrency?: number;
}

/**
 * Join paths according to target storage provider conventions.
 */
export function joinPaths(
  providerType: StorageType,
  parent: string,
  child: string
): string {
  if (providerType === 'local') {
    if (!parent) return child;
    return path.join(parent, child);
  }

  // SFTP and S3 paths use posix slashes
  if (!parent || parent === '.') return child;
  if (parent === '/') {
    return `/${child.replace(/^\/+/, '')}`;
  }
  const cleanParent = parent.replace(/\/+$/, '');
  const cleanChild = child.replace(/^\/+/, '');
  if (!cleanParent) return cleanChild;
  return `${cleanParent}/${cleanChild}`;
}

/**
 * Extract filename or folder name from a POSIX or Windows path.
 */
export function getBaseName(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash >= 0) {
    return normalized.slice(lastSlash + 1);
  }
  return normalized;
}

/**
 * Directory name of a path, following the target storage provider's path
 * conventions (native separators for local, posix for SFTP/S3).
 */
export function dirName(providerType: StorageType, filePath: string): string {
  if (providerType === 'local') {
    return path.dirname(filePath);
  }
  const normalized = filePath.replace(/\\/g, '/');
  return path.posix.dirname(normalized) || '/';
}

/**
 * Whether a path already exists on a storage provider.
 */
export async function pathExists(
  provider: IStorageProvider,
  targetPath: string
): Promise<boolean> {
  try {
    await provider.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds a sibling path that does not yet exist by appending " (1)", " (2)",
 * etc. before the file extension (e.g. "report.pdf" -> "report (1).pdf"),
 * used to resolve transfer conflicts with the "rename" policy.
 */
export async function resolveNonConflictingPath(
  provider: IStorageProvider,
  providerType: StorageType,
  targetPath: string
): Promise<string> {
  const dir = dirName(providerType, targetPath);
  const base = getBaseName(targetPath);
  const dotIndex = base.lastIndexOf('.');
  const hasExt = dotIndex > 0 && dotIndex < base.length - 1;
  const stem = hasExt ? base.slice(0, dotIndex) : base;
  const ext = hasExt ? base.slice(dotIndex) : '';

  let candidate = targetPath;
  for (let n = 1; n <= 1000; n++) {
    if (!(await pathExists(provider, candidate))) {
      return candidate;
    }
    candidate = joinPaths(providerType, dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/**
 * Check if a path is or should be considered a directory on a storage provider.
 */
export async function isDirectoryPath(
  provider: IStorageProvider,
  targetPath: string
): Promise<boolean> {
  const norm = targetPath.trim();
  if (
    norm === '' ||
    norm === '/' ||
    norm === '.' ||
    norm === '..' ||
    norm.endsWith('/') ||
    norm.endsWith('\\')
  ) {
    return true;
  }
  try {
    const entry = await provider.stat(targetPath);
    return Boolean(entry.isDirectory);
  } catch {
    return false;
  }
}

/**
 * Detects whether an error thrown during a file transfer is transient
 * and safe to retry (e.g. temporary network drops, reset connections).
 */
export function isRetryableTransferError(err: any): boolean {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const msg = (err.message || String(err)).toLowerCase();
  if (msg.includes('aborted') || msg.includes('cancelled') || msg.includes('incomplete')) {
    return false;
  }
  const code = err.code || '';
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'ECONNABORTED' ||
    code === 'EHOSTUNREACH' ||
    msg.includes('connection lost') ||
    msg.includes('channel closed') ||
    msg.includes('connection reset') ||
    msg.includes('socket hung up') ||
    msg.includes('closed by remote')
  );
}

/**
 * Transfer a single file directly between storage providers via Node.js memory streams,
 * with automatic retries for transient connection errors.
 */
export async function transferFile(options: TransferOptions): Promise<void> {
  const maxRetries = options.maxRetries ?? 2;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      return await executeTransferFile(options);
    } catch (err: any) {
      if (attempt <= maxRetries && isRetryableTransferError(err) && !options.signal?.aborted) {
        await new Promise((r) => setTimeout(r, 200 * attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Hidden temporary sibling of `targetPath` (".<name>.sshs3-part-<random>") that an overwrite is written to before it
 * is renamed over the target.
 */
export function tempSiblingPath(providerType: StorageType, targetPath: string): string {
  const name = getBaseName(targetPath) || 'file';
  const tempName = `.${name}.sshs3-part-${crypto.randomBytes(6).toString('hex')}`;
  const sep = providerType === 'local' ? Math.max(targetPath.lastIndexOf('/'), targetPath.lastIndexOf(path.sep)) : targetPath.lastIndexOf('/');
  return sep >= 0 ? `${targetPath.slice(0, sep + 1)}${tempName}` : tempName;
}

async function executeTransferFile(options: TransferOptions): Promise<void> {
  if (options.signal?.aborted) {
    const err = new Error('Transfer aborted');
    err.name = 'AbortError';
    throw err;
  }

  const fileName =
    getBaseName(options.sourcePath) || options.sourcePath || 'file';

  let resolvedTargetPath = options.targetPath;
  const isTargetDir = await isDirectoryPath(
    options.targetProvider,
    resolvedTargetPath
  );
  if (isTargetDir && fileName && getBaseName(resolvedTargetPath) !== fileName) {
    resolvedTargetPath = joinPaths(
      options.targetProvider.type,
      resolvedTargetPath,
      fileName
    );
  }

  let totalBytes = options.totalBytes;
  if (totalBytes === undefined || totalBytes < 0) {
    let stat: FileEntry | undefined;
    try {
      stat = await options.sourceProvider.stat(options.sourcePath);
    } catch {
      stat = undefined;
    }
    if (stat?.isSpecial) {
      throw new Error(`Not a regular file: ${fileName}`);
    }
    totalBytes = stat && stat.size >= 0 ? stat.size : 0;
  }

  const readStream = await options.sourceProvider.createReadStream(
    options.sourcePath
  );
  // Attach immediately, before any further `await` — a stream with zero
  // 'error' listeners crashes the whole main process on an unhandled error
  // event (Node's default behavior), and the source file/connection can
  // fail (e.g. deleted between the stat() above and here — TOCTOU) in the
  // gap before createWriteStream resolves below and pipeline() attaches its
  // own listener, when nothing else is listening yet. This can't be a bare
  // no-op, though: if the error fires and is fully consumed before
  // pipeline() ever attaches, pipeline() would never learn about it and the
  // transfer would look "successful" despite a broken source stream — so
  // this records it instead, and it's checked for below before proceeding.
  let earlyReadError: Error | undefined;
  readStream.on('error', (err) => {
    earlyReadError = err;
  });
  let writeStream: NodeJS.WritableStream | undefined;
  let earlyWriteError: Error | undefined;
  // Path the bytes are written to: the final path, or a temporary sibling when an existing file is being replaced.
  let writePath = resolvedTargetPath;

  try {
    if (options.signal?.aborted) {
      const err = new Error('Transfer aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Overwriting an existing file: write a temporary sibling first and rename it over the target only once
    // the copy is complete and verified, so a failed or cancelled overwrite leaves the original file in place.
    // S3 uploads only replace the object when they finish, so S3 keeps writing straight to the key.
    const existingTarget =
      options.targetProvider.type === 's3'
        ? undefined
        : await options.targetProvider.stat(resolvedTargetPath).catch(() => undefined);
    if (existingTarget && !existingTarget.isDirectory) {
      writePath = tempSiblingPath(options.targetProvider.type, resolvedTargetPath);
    }

    writeStream = await options.targetProvider.createWriteStream(
      writePath,
      { size: totalBytes }
    );
    // Same reasoning as readStream above, for the equivalent gap before
    // pipeline() is called just below.
    writeStream.on('error', (err) => {
      earlyWriteError = err;
    });

    if (earlyReadError) throw earlyReadError;
    if (earlyWriteError) throw earlyWriteError;

    const meter = new ByteMeter({
      jobId: options.jobId,
      fileName,
      totalBytes,
      throttleIntervalMs: options.throttleIntervalMs,
      signal: options.signal,
      pauseController: options.pauseController,
      onProgress: options.onProgress,
      // Always suppressed here (regardless of options.emitCompleted) so the
      // integrity check below runs, and can still throw, before any
      // 'completed' progress event ever reaches the caller (M8).
      emitCompletedOnFlush: false,
    });

    await pipeline(readStream, meter, writeStream, { signal: options.signal });

    // M8 (code review): byte count was previously tracked only for the
    // progress bar and never checked against the source's actual size, so a
    // stream that silently truncated or corrupted mid-transfer could still
    // finish as 'completed'. totalBytes of 0 means the size was unknown (the
    // stat() above failed) or the source is genuinely empty; neither case
    // has a real reference to verify against.
    if (totalBytes > 0 && meter.transferredBytes !== totalBytes) {
      throw new Error(
        `Transfer of "${fileName}" incomplete: expected ${totalBytes} bytes but transferred ${meter.transferredBytes}`
      );
    }

    // P1 #15: Post-transfer integrity & checksum verification on target
    if (options.verifyIntegrity !== false) {
      let targetStat: FileEntry | undefined;
      try {
        targetStat = await options.targetProvider.stat(writePath);
      } catch (statErr: any) {
        throw new Error(
          `Transfer integrity verification failed: could not stat target file "${fileName}": ${statErr?.message || statErr}`,
          { cause: statErr }
        );
      }

      if (totalBytes > 0 && targetStat.size !== totalBytes) {
        throw new Error(
          `Transfer integrity verification failed for "${fileName}": expected ${totalBytes} bytes on target, found ${targetStat.size}`
        );
      }

      // Check caller's expected checksum if provided
      if (options.expectedChecksum) {
        const actualChecksum = meter.sha256;
        if (actualChecksum && actualChecksum.toLowerCase() !== options.expectedChecksum.toLowerCase()) {
          throw new Error(
            `Checksum verification failed for "${fileName}": expected ${options.expectedChecksum} but computed ${actualChecksum}`
          );
        }
      }

      // Check target provider's checksum if requested
      if (options.verifyChecksum) {
        const algo = typeof options.verifyChecksum === 'string' ? options.verifyChecksum : 'sha256';
        if (typeof options.targetProvider.getChecksum === 'function') {
          const targetChecksum = await options.targetProvider.getChecksum(writePath, algo);
          const sourceChecksum = algo === 'md5' ? meter.md5 : meter.sha256;
          if (targetChecksum && sourceChecksum && targetChecksum.toLowerCase() !== sourceChecksum.toLowerCase()) {
            throw new Error(
              `Checksum verification failed for "${fileName}": source ${algo} (${sourceChecksum}) does not match target ${algo} (${targetChecksum})`
            );
          }
        }
      }
    }

    if (writePath !== resolvedTargetPath) {
      // Keep the replaced file's permissions (a new file gets the default mode). Best effort.
      const mode = existingTarget?.permissions;
      if (mode && /^[0-7]{3,4}$/.test(mode) && typeof options.targetProvider.chmod === 'function') {
        await options.targetProvider.chmod(writePath, mode).catch(() => {});
      }
      await options.targetProvider.rename(writePath, resolvedTargetPath);
    }

    if (options.emitCompleted ?? true) {
      meter.emitCompletedNow();
    }
  } catch (err) {
    if (typeof (readStream as any)?.destroy === 'function') {
      if (typeof (readStream as any)?.on === 'function') {
        (readStream as any).on('error', () => {});
      }
      (readStream as any).destroy(err as Error);
    }
    if (typeof (writeStream as any)?.destroy === 'function') {
      if (typeof (writeStream as any)?.on === 'function') {
        (writeStream as any).on('error', () => {});
      }
      (writeStream as any).destroy(err as Error);
    }
    // M7 (code review): a failed/aborted transfer previously left a
    // truncated file at the exact final filename, indistinguishable from a
    // complete one. Only attempted once writeStream exists (some bytes may
    // already be on disk); best-effort, since some providers/paths may
    // reject deleting a file that's still open or was never created.
    // H2 (code review 2026-11-03): only when the provider has actually opened
    // or replaced the target. A cancelled S3 overwrite, a read-only file that
    // could not be opened or an SFTP open that never happened leave the
    // original in place, and deleting it would destroy the user's data.
    // When replacing an existing file, writePath is the temporary sibling: only that is removed, never the original.
    const settled = writeStream ? await settleTargetTouched(writeStream, options.targetSettleTimeoutMs) : true;
    if (writeStream && wasTargetTouched(writeStream)) {
      await options.targetProvider.delete(writePath, false).catch(() => {});
    } else if (writeStream && !settled) {
      // The server has not answered the open yet and may still truncate the file: clean up if it did, without holding up the error.
      whenTargetSettledLater(writeStream, async () => {
        if (!wasTargetTouched(writeStream)) return;
        // Only the empty file our own late open left behind: a newer transfer may have written the path since.
        const now = await options.targetProvider.stat(writePath).catch(() => null);
        if (now && now.size === 0) await options.targetProvider.delete(writePath, false).catch(() => {});
      });
    }
    throw err;
  }
}

interface ScannedFile {
  sourcePath: string;
  targetPath: string;
  size: number;
}

interface ScanResult {
  folders: string[];
  files: ScannedFile[];
  totalBytes: number;
  /** Symbolic links that were not copied: links to folders, broken links, links to special files. */
  skippedLinks: number;
}

async function scanDirectory(
  sourceProvider: IStorageProvider,
  currentSourcePath: string,
  currentTargetPath: string,
  targetType: StorageType,
  signal?: AbortSignal,
  onScanProgress?: (filesCount: number, currentItem: string) => void,
  state: { filesCount: number } = { filesCount: 0 }
): Promise<ScanResult> {
  if (signal?.aborted) {
    const err = new Error('Transfer aborted');
    err.name = 'AbortError';
    throw err;
  }

  const result: ScanResult = {
    folders: [],
    files: [],
    totalBytes: 0,
    skippedLinks: 0,
  };

  const entries = await sourceProvider.list(currentSourcePath);

  for (const entry of entries) {
    if (signal?.aborted) {
      const err = new Error('Transfer aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Prevent infinite recursion on '.' and '..' and reject path traversal
    const baseName = path.posix.basename(entry.name.replace(/\\/g, '/'));
    if (!baseName || baseName === '.' || baseName === '..') {
      continue;
    }
    const childTargetPath = joinPaths(targetType, currentTargetPath, baseName);
    const childSourcePath =
      entry.path || joinPaths(sourceProvider.type, currentSourcePath, baseName);
    // Never recurse through a symlink during a directory transfer (H6 code-review
    // finding): that can escape the source tree entirely (a link to "/" or a
    // parent) or spin forever on a symlink cycle, since no cycle detection
    // exists here. A link to a regular file is copied as that file's content
    // (the link is followed for files only); links to folders, broken links
    // and links to special files are skipped and counted, so the job can say so.
    if (entry.isSymlink) {
      const linked = await sourceProvider.stat(childSourcePath).catch(() => undefined);
      if (!linked || linked.isDirectory || linked.isSpecial) {
        result.skippedLinks++;
        continue;
      }
      state.filesCount++;
      const size = linked.size > 0 ? linked.size : 0;
      result.files.push({ sourcePath: childSourcePath, targetPath: childTargetPath, size });
      result.totalBytes += size;
      onScanProgress?.(state.filesCount, baseName);
      continue;
    }
    // FIFOs, sockets and devices cannot be copied: reading a FIFO blocks until something writes to it (M7).
    if (entry.isSpecial) {
      continue;
    }

    if (entry.isDirectory) {
      result.folders.push(childTargetPath);
      onScanProgress?.(state.filesCount, baseName);
      const subResult = await scanDirectory(
        sourceProvider,
        childSourcePath,
        childTargetPath,
        targetType,
        signal,
        onScanProgress,
        state
      );
      result.folders.push(...subResult.folders);
      result.files.push(...subResult.files);
      result.totalBytes += subResult.totalBytes;
      result.skippedLinks += subResult.skippedLinks;
    } else {
      state.filesCount++;
      result.files.push({
        sourcePath: childSourcePath,
        targetPath: childTargetPath,
        size: entry.size || 0,
      });
      result.totalBytes += entry.size || 0;
      onScanProgress?.(state.filesCount, baseName);
    }
  }

  return result;
}

/**
 * Transfer an entire directory recursively between storage providers.
 */
export async function transferDirectory(
  options: TransferOptions
): Promise<void> {
  if (options.signal?.aborted) {
    const err = new Error('Transfer aborted');
    err.name = 'AbortError';
    throw err;
  }

  const rootName = getBaseName(options.sourcePath) || options.sourcePath || 'directory';

  // Inform UI that scanning has begun
  options.onProgress?.({
    jobId: options.jobId ?? 'directory-transfer',
    fileName: rootName,
    transferredBytes: 0,
    totalBytes: 0,
    percentage: 0,
    bytesPerSecond: 0,
    status: 'running',
    statusMessage: 'Scanning folder structure...',
  });

  const scan = await scanDirectory(
    options.sourceProvider,
    options.sourcePath,
    options.targetPath,
    options.targetProvider.type,
    options.signal,
    (filesCount) => {
      options.onProgress?.({
        jobId: options.jobId ?? 'directory-transfer',
        fileName: rootName,
        transferredBytes: 0,
        totalBytes: 0,
        percentage: 0,
        bytesPerSecond: 0,
        status: 'running',
        statusMessage: `Scanning (${filesCount} ${filesCount === 1 ? 'file found' : 'files found'})...`,
      });
    }
  );

  if (options.targetPath) {
    await options.targetProvider.createFolder(options.targetPath);
  }

  for (let i = 0; i < scan.folders.length; i++) {
    const folder = scan.folders[i];
    if (options.signal?.aborted) {
      const err = new Error('Transfer aborted');
      err.name = 'AbortError';
      throw err;
    }
    options.onProgress?.({
      jobId: options.jobId ?? 'directory-transfer',
      fileName: rootName,
      transferredBytes: 0,
      totalBytes: scan.totalBytes,
      percentage: 0,
      bytesPerSecond: 0,
      status: 'running',
      statusMessage: `Creating subdirectory (${i + 1}/${scan.folders.length})...`,
    });
    await options.targetProvider.createFolder(folder);
  }

  const doneMessage =
    scan.skippedLinks > 0
      ? `Done — ${scan.skippedLinks} symbolic ${scan.skippedLinks === 1 ? 'link' : 'links'} skipped (links to folders or missing files are not copied)`
      : 'Done';

  if (scan.files.length === 0) {
    options.onProgress?.({
      jobId: options.jobId ?? 'directory-transfer',
      fileName: rootName,
      transferredBytes: 0,
      totalBytes: 0,
      percentage: 100,
      bytesPerSecond: 0,
      status: 'completed',
      statusMessage: doneMessage,
    });
    return;
  }

  const totalDirectoryBytes = scan.totalBytes;
  const concurrency = Math.min(options.concurrency ?? 3, Math.max(1, scan.files.length));
  const fileTransferredMap = new Map<string, number>();
  const failedFiles: Array<{ path: string; error: string }> = [];
  let completedCount = 0;
  let nextFileIndex = 0;

  const emitDirectoryProgress = (currentFileName: string, bytesPerSecond = 0) => {
    let currentOverall = 0;
    for (const b of fileTransferredMap.values()) {
      currentOverall += b;
    }
    const percentage =
      totalDirectoryBytes > 0
        ? Math.min(100, Math.round((currentOverall / totalDirectoryBytes) * 100))
        : 100;

    options.onProgress?.({
      jobId: options.jobId ?? 'directory-transfer',
      fileName: rootName,
      transferredBytes: currentOverall,
      totalBytes: totalDirectoryBytes,
      percentage,
      bytesPerSecond,
      status: 'running',
      statusMessage: `File ${completedCount}/${scan.files.length}: ${currentFileName}`,
    });
  };

  const runWorker = async () => {
    while (nextFileIndex < scan.files.length) {
      if (options.signal?.aborted) {
        const err = new Error('Transfer aborted');
        err.name = 'AbortError';
        throw err;
      }
      const currentIndex = nextFileIndex++;
      const file = scan.files[currentIndex];

      try {
        await transferFile({
          ...options,
          sourcePath: file.sourcePath,
          targetPath: file.targetPath,
          totalBytes: file.size,
          emitCompleted: false,
          onProgress: (fp) => {
            fileTransferredMap.set(file.sourcePath, fp.transferredBytes);
            emitDirectoryProgress(path.basename(file.sourcePath), fp.bytesPerSecond);
          },
        });
        fileTransferredMap.set(file.sourcePath, file.size);
      } catch (err: any) {
        if (err?.name === 'AbortError' || options.signal?.aborted) {
          throw err;
        }
        failedFiles.push({
          path: file.sourcePath,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        completedCount++;
        emitDirectoryProgress(path.basename(file.sourcePath));
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => runWorker());
  await Promise.all(workers);

  if (failedFiles.length > 0) {
    const preview = failedFiles
      .slice(0, 5)
      .map((f) => `${path.basename(f.path)}: ${f.error}`)
      .join('; ');
    const suffix = failedFiles.length > 5 ? `; and ${failedFiles.length - 5} more` : '';
    throw new Error(
      `${failedFiles.length} of ${scan.files.length} file(s) failed to transfer: ${preview}${suffix}`
    );
  }

  options.onProgress?.({
    jobId: options.jobId ?? 'directory-transfer',
    fileName: rootName,
    transferredBytes: totalDirectoryBytes,
    totalBytes: totalDirectoryBytes,
    percentage: 100,
    bytesPerSecond: 0,
    status: 'completed',
    statusMessage: doneMessage,
  });
}

/**
 * TransferPipeline class encapsulating streaming file and directory transfers.
 */
export class TransferPipeline {
  static async transferFile(options: TransferOptions): Promise<void> {
    return transferFile(options);
  }

  static async transferDirectory(options: TransferOptions): Promise<void> {
    return transferDirectory(options);
  }

  async transferFile(options: TransferOptions): Promise<void> {
    return transferFile(options);
  }

  async transferDirectory(options: TransferOptions): Promise<void> {
    return transferDirectory(options);
  }
}
