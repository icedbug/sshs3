import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { shell as electronShell } from 'electron';
import type { StorageRegistry } from '../storage/StorageRegistry';
import { LocalStorageProvider } from '../storage/LocalStorageProvider';
import { formatDate, getMimeType } from '../storage/StorageProvider';
import type { FileReadResult, ExternalFileStatusEvent } from '../../shared/types/ipc';
import { createUploadCoalescer, type UploadCoalescer } from './uploadCoalescer';

export interface ExternalEditorSession {
  sessionToken: string;
  providerId: string;
  remotePath: string;
  tempDir?: string;
  tempFilePath: string;
  watcher?: fs.FSWatcher;
  /** Serialises the auto-uploads of this session's temp file. */
  uploader?: UploadCoalescer;
  /** Set once the session is being closed: stops re-attaching the file watch. */
  closed?: boolean;
}

// eslint-disable-next-line security/detect-unsafe-regex -- anchored non-backtracking pattern matching windows reserved device names
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// Types the OS would *run* rather than open for editing when handed to shell.openPath.
const ALWAYS_BLOCKED_EXTENSIONS = new Set(['.exe', '.com', '.msi', '.msp', '.scr', '.lnk', '.hta', '.jar', '.desktop', '.app']);
const WINDOWS_BLOCKED_EXTENSIONS = new Set([
  '.bat', '.cmd', '.ps1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.reg', '.cpl', '.pif', '.msc',
]);

/**
 * Reduces a remote-controlled path to a single, safe local file name. Remote file names are
 * attacker-influenced (a hostile SFTP server or S3 key): on Windows a name like
 * `..\\..\\Startup\\x.bat` survives `path.posix.basename` and would walk out of the temp dir
 * via `path.join`.
 */
export function toSafeLocalFileName(remotePath: string): string {
  const last = remotePath.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = last.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'file.txt';
  if (WINDOWS_RESERVED_NAMES.test(name)) name = `_${name}`;
  return name;
}

export function isBlockedExecutableType(fileName: string, platform: NodeJS.Platform = process.platform): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return ALWAYS_BLOCKED_EXTENSIONS.has(ext) || (platform === 'win32' && WINDOWS_BLOCKED_EXTENSIONS.has(ext));
}

const READ_IDLE_TIMEOUT_MS = 30_000;

function directoryResult(size: number): FileReadResult {
  return { content: '', size, isBinary: false, truncated: false, isDirectory: true };
}

/** Reading a directory as a file fails with EISDIR locally and with a generic Failure status over SFTP. */
function isDirectoryReadError(err: any): boolean {
  return (
    err?.code === 'EISDIR' ||
    (err?.statusCode === 4 && (err?.name === 'SftpError' || err?.message?.includes('Failure')))
  );
}

export interface ShellOpener {
  openPath(path: string): Promise<string> | any;
}

export interface FileEditorServiceOptions {
  shell?: ShellOpener;
  baseTempDir?: string;
  /** Quiet time after the last save before the file is uploaded. */
  uploadDebounceMs?: number;
}

/** How long closing a session waits for a last pending upload before giving up on it. */
const CLOSE_FLUSH_TIMEOUT_MS = 10_000;
/** After an editor replaced the file (rename), how long to wait for the new file to appear before giving up. */
const REATTACH_ATTEMPTS = 20;
const REATTACH_DELAY_MS = 100;

export class FileEditorService {
  private shell: ShellOpener;
  private baseTempDir: string;
  private sessions = new Map<string, ExternalEditorSession>();
  private uploadDebounceMs: number;

  constructor(options: FileEditorServiceOptions = {}) {
    this.uploadDebounceMs = options.uploadDebounceMs ?? 500;
    this.shell = options.shell ?? electronShell;
    this.baseTempDir = options.baseTempDir ?? path.join(os.tmpdir(), 'sshs3-editor');
  }

  /**
   * Reads up to maxBytes of a file as raw bytes, for callers that parse the content in the main process
   * and return only what they derived from it. `truncated` is set when the file is larger than maxBytes.
   */
  public async readBytes(
    storageRegistry: StorageRegistry,
    providerId: string,
    remotePath: string,
    maxBytes: number
  ): Promise<{ buffer: Buffer; truncated: boolean } | { isDirectory: true }> {
    const read = await this.readCapped(storageRegistry, providerId, remotePath, maxBytes);
    if ('directorySize' in read) return { isDirectory: true };
    return { buffer: read.buffer, truncated: read.truncated };
  }

  /** Reads at most maxBytes from a file (idle timeout, directory and special-file checks included). */
  private async readCapped(
    storageRegistry: StorageRegistry,
    providerId: string,
    remotePath: string,
    maxBytes: number
  ): Promise<{ buffer: Buffer; totalBytes: number; truncated: boolean } | { directorySize: number }> {
    const provider = storageRegistry.get(providerId);
    if (!provider) {
      throw new Error(`Storage provider not found: ${providerId}`);
    }

    try {
      const stats = await provider.stat(remotePath);
      if (stats?.isDirectory) return { directorySize: stats.size || 0 };
      if (stats?.isSpecial) throw new Error('Not a regular file');
    } catch (err: any) {
      if (err?.message === 'Not a regular file') throw err;
      // If stat fails or is not supported by provider, proceed to createReadStream
    }

    let stream: NodeJS.ReadableStream;
    try {
      stream = await provider.createReadStream(remotePath);
    } catch (err: any) {
      if (isDirectoryReadError(err)) return { directorySize: 0 };
      throw err;
    }

    const effectiveMaxBytes =
      typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
        ? Math.min(Math.floor(maxBytes), 100 * 1024 * 1024)
        : 5 * 1024 * 1024;

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let truncated = false;
    let isDirDetected = false;

    await new Promise<void>((resolve, reject) => {
      // A stream that stops producing data (FIFO, stalled mount) would otherwise hold the read open forever.
      let idleTimer: NodeJS.Timeout | undefined;
      const destroyStream = (): void => {
        if ('destroy' in stream && typeof (stream as any).destroy === 'function') {
          (stream as any).destroy();
        }
      };
      const armIdleTimer = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          destroyStream();
          reject(new Error('Timed out waiting for file data'));
        }, READ_IDLE_TIMEOUT_MS);
      };
      armIdleTimer();

      stream.on('data', (chunk: Buffer) => {
        armIdleTimer();
        if (totalBytes + chunk.length > effectiveMaxBytes) {
          const remaining = effectiveMaxBytes - totalBytes;
          if (remaining > 0) {
            chunks.push(chunk.subarray(0, remaining));
            totalBytes += remaining;
          }
          truncated = true;
          clearTimeout(idleTimer);
          destroyStream();
          resolve();
        } else {
          chunks.push(chunk);
          totalBytes += chunk.length;
        }
      });
      stream.on('end', () => {
        clearTimeout(idleTimer);
        resolve();
      });
      stream.on('error', (err: any) => {
        clearTimeout(idleTimer);
        if (truncated) {
          resolve();
        } else if (isDirectoryReadError(err)) {
          isDirDetected = true;
          resolve();
        } else {
          reject(err);
        }
      });
    });

    if (isDirDetected) return { directorySize: 0 };
    return { buffer: Buffer.concat(chunks), totalBytes, truncated };
  }

  /**
   * Reads up to maxBytes from the specified storage provider.
   * Detects binary content (null bytes in first 8KB) and reports truncation.
   */
  public async readFile(
    storageRegistry: StorageRegistry,
    providerId: string,
    remotePath: string,
    maxBytes: number = 5 * 1024 * 1024
  ): Promise<FileReadResult> {
    const read = await this.readCapped(storageRegistry, providerId, remotePath, maxBytes);
    if ('directorySize' in read) return directoryResult(read.directorySize);
    const { buffer: fullBuffer, totalBytes, truncated } = read;
    const checkLength = Math.min(fullBuffer.length, 8000);
    let isBinary = false;
    for (let i = 0; i < checkLength; i++) {
      if (fullBuffer[i] === 0) {
        isBinary = true;
        break;
      }
    }

    // Saving re-encodes the text as UTF-8, so a file that isn't valid UTF-8 (e.g. ISO-8859-1)
    // would come back with U+FFFD in place of the original bytes. `stream` is set only for a truncated read, where the
    // size limit may have cut a multi-byte sequence in half.
    let notUtf8 = false;
    if (!isBinary) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(fullBuffer, { stream: truncated });
      } catch {
        notUtf8 = true;
      }
    }

    const mimeType = getMimeType(remotePath);
    const shouldProvideBase64 =
      isBinary ||
      mimeType?.startsWith('image/') ||
      mimeType === 'application/pdf';

    return {
      content: isBinary ? '' : fullBuffer.toString('utf-8'),
      size: totalBytes,
      isBinary,
      truncated,
      notUtf8,
      base64: shouldProvideBase64 ? fullBuffer.toString('base64') : undefined,
      mimeType,
    };
  }

  /**
   * Writes utf-8 text content to the specified storage provider.
   */
  public async saveFile(
    storageRegistry: StorageRegistry,
    providerId: string,
    remotePath: string,
    content: string
  ): Promise<void> {
    const provider = storageRegistry.get(providerId);
    if (!provider) {
      throw new Error(`Storage provider not found: ${providerId}`);
    }

    const stream = await provider.createWriteStream(remotePath);
    const buffer = Buffer.from(content, 'utf-8');

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const fail = (err: any) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      stream.once('finish', finish);
      stream.once('close', finish);
      stream.once('error', fail);
      stream.end(buffer);
    });
  }

  /**
   * Opens the file in the OS default application (VS Code, Notepad, etc.).
   * For remote files (SFTP/S3), downloads to a temp folder, launches OS default app,
   * watches for changes via fs.watch, and automatically re-uploads on save.
   */
  public async openInExternalEditor(
    storageRegistry: StorageRegistry,
    providerId: string,
    remotePath: string,
    onStatus?: (event: ExternalFileStatusEvent) => void
  ): Promise<{ sessionToken: string; localPath: string }> {
    const provider = storageRegistry.get(providerId);
    if (!provider) {
      throw new Error(`Storage provider not found: ${providerId}`);
    }

    // Local filesystem: open directly in OS default application
    if (provider.type === 'local' && provider instanceof LocalStorageProvider) {
      const fullPath = provider.resolvePath(remotePath);
      const err = await this.shell.openPath(fullPath);
      if (err) {
        throw new Error(err);
      }
      const sessionToken = crypto.randomUUID();
      const session: ExternalEditorSession = {
        sessionToken,
        providerId,
        remotePath,
        tempFilePath: fullPath,
      };
      this.sessions.set(sessionToken, session);
      return { sessionToken, localPath: fullPath };
    }

    // Remote storage: download to temporary file and watch
    const sessionToken = crypto.randomUUID();
    const tempDir = path.join(this.baseTempDir, sessionToken);
    const baseName = toSafeLocalFileName(remotePath);
    const tempFilePath = path.join(tempDir, baseName);
    if (path.dirname(tempFilePath) !== tempDir) {
      throw new Error(`Refusing to write outside the temp directory: ${remotePath}`);
    }
    if (isBlockedExecutableType(baseName)) {
      throw new Error(
        `Refusing to open "${baseName}" with the OS default handler: this file type would be executed. Use the built-in editor instead.`
      );
    }

    // mode: 0o700 restricts this to the owning user. On a shared/multi-user
    // machine, the default (umask-derived, typically 0o755) would let any
    // other local user list this directory — defeating the random UUID as a
    // guard, since they could just read the directory name — and then read
    // the downloaded file itself, which may hold sensitive remote content.
    await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      // `mode` on a recursive mkdir isn't guaranteed to tighten a
      // pre-existing baseTempDir (e.g. left over from before this fix, or a
      // shared OS temp dir), so enforce it explicitly on both directories.
      await fsp.chmod(this.baseTempDir, 0o700).catch(() => {});
      await fsp.chmod(tempDir, 0o700).catch(() => {});
    }

    const readStream = await provider.createReadStream(remotePath);
    // mode: 0o600 keeps the downloaded content itself owner-only, matching
    // the containing directory (belt-and-suspenders: directory permissions
    // alone would already block other users, but the file's own mode
    // shouldn't rely on that).
    const writeStream = fs.createWriteStream(tempFilePath, { mode: 0o600 });

    await new Promise<void>((resolve, reject) => {
      readStream.pipe(writeStream);
      writeStream.once('finish', () => resolve());
      writeStream.once('error', reject);
      readStream.once('error', reject);
    });

    const openError = await this.shell.openPath(tempFilePath);
    if (openError) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(openError);
    }

    const session: ExternalEditorSession = { sessionToken, providerId, remotePath, tempDir, tempFilePath };
    this.sessions.set(sessionToken, session);

    const report = (status: 'uploaded' | 'error', error?: string): void => {
      onStatus?.({
        sessionToken,
        providerId,
        remotePath,
        status,
        ...(error !== undefined ? { error } : {}),
        timestamp: formatDate(new Date()),
      });
    };

    let lastMtime = 0;
    let lastSize = -1;
    try {
      const stats = await fsp.stat(tempFilePath);
      lastMtime = stats.mtimeMs;
      lastSize = stats.size;
    } catch {
      // ignore
    }

    // One upload at a time, changes folded together (see createUploadCoalescer).
    const uploadIfChanged = async (): Promise<void> => {
      let stats: fs.Stats;
      try {
        stats = await fsp.stat(tempFilePath);
      } catch {
        return; // replaced or removed for a moment (rename-save): the re-attached watch triggers again
      }
      if (stats.mtimeMs <= lastMtime && stats.size === lastSize) return;
      try {
        const content = await fsp.readFile(tempFilePath);
        const uploadStream = await provider.createWriteStream(remotePath);

        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolve();
            }
          };
          const fail = (err: any) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          };
          uploadStream.once('finish', finish);
          uploadStream.once('close', finish);
          uploadStream.once('error', fail);
          uploadStream.end(content);
        });

        // Only after it succeeded, so a failed upload is tried again on the next change.
        lastMtime = stats.mtimeMs;
        lastSize = stats.size;
        report('uploaded');
      } catch (uploadErr) {
        report('error', uploadErr instanceof Error ? uploadErr.message : String(uploadErr));
      }
    };
    const uploader = createUploadCoalescer(uploadIfChanged, this.uploadDebounceMs);
    session.uploader = uploader;

    const attach = (): boolean => {
      try {
        const watcher = fs.watch(tempFilePath, onFsEvent);
        watcher.on('error', () => {
          // The watched file went away; a 'rename' event normally handles that, nothing more to do here.
        });
        session.watcher = watcher;
        return true;
      } catch {
        return false; // Watcher could not be attached; external editing still succeeds
      }
    };

    // Editors that save by writing a new file and renaming it over the old one leave the old watch pointing at
    // a deleted file: look the path up again and carry on from the new file.
    let reattaching = false;
    const reattach = async (): Promise<void> => {
      if (reattaching) return;
      reattaching = true;
      try {
        session.watcher?.close();
        session.watcher = undefined;
        for (let attempt = 0; attempt < REATTACH_ATTEMPTS && !session.closed; attempt++) {
          try {
            await fsp.access(tempFilePath);
            // The session may have been closed while we waited; attaching now would leak a watcher nobody closes.
            if (session.closed) return;
            if (attach()) {
              uploader.trigger(); // the rename itself was a save
              return;
            }
          } catch {
            // not there yet
          }
          await new Promise((resolve) => setTimeout(resolve, REATTACH_DELAY_MS));
        }
        if (!session.closed) report('error', 'The file was removed by the external editor; automatic upload stopped.');
      } finally {
        reattaching = false;
      }
    };

    function onFsEvent(eventType: string): void {
      if (eventType === 'rename') void reattach();
      else uploader.trigger();
    }

    attach();

    return { sessionToken, localPath: tempFilePath };
  }

  /**
   * Closes an active external editor session and cleans up temporary files.
   */
  public async closeExternalEditor(sessionToken: string): Promise<void> {
    const session = this.sessions.get(sessionToken);
    if (!session) return;

    session.closed = true;
    session.watcher?.close();
    if (session.uploader) {
      // A save made just before closing may still be waiting out the debounce: upload it rather than lose it.
      // Bounded, so an unreachable server cannot keep the editor from closing.
      await Promise.race([
        session.uploader.flush(),
        new Promise((resolve) => setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS).unref?.()),
      ]);
      session.uploader.dispose();
    }

    if (session.tempDir) {
      try {
        await fsp.rm(session.tempDir, { recursive: true, force: true });
      } catch {
        // Ignore deletion errors
      }
    }

    this.sessions.delete(sessionToken);
  }

  public getSession(sessionToken: string): ExternalEditorSession | undefined {
    return this.sessions.get(sessionToken);
  }

  public getActiveSessions(): ExternalEditorSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Disposes all active watchers and temporary directories.
   */
  public async dispose(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.closed = true;
      session.uploader?.dispose();
      session.watcher?.close();
      if (session.tempDir) {
        try {
          await fsp.rm(session.tempDir, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
    }
    this.sessions.clear();
  }
}
