import path from 'node:path';
import crypto from 'node:crypto';
import {
  BaseStorageProvider,
  formatDate,
  getMimeType,
} from './StorageProvider';
import {
  OpenSshSftpClientAdapter,
  type ISftpBackendClient,
} from './sftp/OpenSshSftpClientAdapter';
import type {
  FileEntry,
  IStorageProvider,
  SFTPConfig,
  SpaceInfo,
  StorageType,
  WriteStreamOptions,
} from '../../shared/types/storage';
import type { SshHostVerifier } from '../ssh/HostKeyVerifier';

/**
 * Parses permissions into an octal permission string (e.g. "755").
 */
function extractPermissions(item: any): string | undefined {
  if (typeof item.permissions === 'string') {
    return item.permissions;
  }
  if (typeof item.mode === 'number') {
    return (item.mode & 0o777).toString(8).padStart(3, '0');
  }
  if (item.attrs && typeof item.attrs.mode === 'number') {
    return (item.attrs.mode & 0o777).toString(8).padStart(3, '0');
  }
  if (item.rights && typeof item.rights === 'object') {
    const parseRights = (r: string = '') => {
      let val = 0;
      if (r.includes('r')) val += 4;
      if (r.includes('w')) val += 2;
      if (r.includes('x')) val += 1;
      return val;
    };
    const u = parseRights(item.rights.user);
    const g = parseRights(item.rights.group);
    const o = parseRights(item.rights.other);
    return `${u}${g}${o}`;
  }
  if (typeof item.longname === 'string' && item.longname.length >= 10) {
    const parseRwx = (str: string = '') => {
      let val = 0;
      if (str[0] === 'r') val += 4;
      if (str[1] === 'w') val += 2;
      if (str[2] === 'x') val += 1;
      return val;
    };
    const u = parseRwx(item.longname.slice(1, 4));
    const g = parseRwx(item.longname.slice(4, 7));
    const o = parseRwx(item.longname.slice(7, 10));
    return `${u}${g}${o}`;
  }
  return undefined;
}

/**
 * Parses modifyTime / mtime into yyyy-mm-dd HH:mm (24h) format.
 */
function parseModifyTime(stats: any): string | undefined {
  const m = stats.modifyTime ?? stats.mtime;
  if (m === undefined || m === null) {
    return undefined;
  }
  if (m instanceof Date) {
    return formatDate(m);
  }
  if (typeof m === 'number') {
    return formatDate(new Date(m > 1e11 ? m : m * 1000));
  }
  if (typeof m === 'string') {
    const d = new Date(m);
    if (!isNaN(d.getTime())) {
      return formatDate(d);
    }
  }
  return undefined;
}

/**
 * Parses modifyTime / mtime into epoch ms (UTC), for precise diffing.
 */
function parseModifyTimeMs(stats: any): number | undefined {
  const m = stats.modifyTime ?? stats.mtime;
  if (m === undefined || m === null) {
    return undefined;
  }
  if (m instanceof Date) {
    return m.getTime();
  }
  if (typeof m === 'number') {
    return m > 1e11 ? m : m * 1000;
  }
  if (typeof m === 'string') {
    const d = new Date(m);
    if (!isNaN(d.getTime())) {
      return d.getTime();
    }
  }
  return undefined;
}

export class SFTPStorageProvider extends BaseStorageProvider implements IStorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageType = 'sftp';

  private config: SFTPConfig;
  private client: ISftpBackendClient;
  private isConnected: boolean = false;
  private connectionPromise: Promise<void> | null = null;
  private cachedHomeDir?: string;
  /** Counts deliberate `disconnect()` calls, so a call in flight when one happens is not retried onto a new connection. */
  private disconnectCount = 0;
  private pinPromptHandler?: (prompt: string) => Promise<string> | string;

  constructor(
    config: SFTPConfig,
    client?: ISftpBackendClient | any,
    hostVerifier?: SshHostVerifier,
    pinPromptHandler?: (prompt: string) => Promise<string> | string,
    presence?: { onPresence?: (prompt: string) => void; onPresenceCleared?: () => void },
    /** SSH master socket to share for the first connect (a terminal's), instead of authenticating again. */
    controlPath?: string
  ) {
    super();
    this.config = { ...config };
    const port = config.port ?? 22;
    this.id = config.id ?? `${config.username}@${config.host}:${port}`;
    this.name = config.name ?? `${config.username}@${config.host}`;
    this.pinPromptHandler = pinPromptHandler;
    this.client = client ?? new OpenSshSftpClientAdapter(
        this.config,
        this.pinPromptHandler,
        presence?.onPresence,
        hostVerifier?.hostKeyPrompt,
        presence?.onPresenceCleared,
        controlPath
      );
    this.attachLifecycleListeners(this.client);
  }

  private onLifecycleCleanup = (): void => {
    this.isConnected = false;
  };

  private attachLifecycleListeners(client: any): void {
    if (!client || typeof client.on !== 'function') return;
    if (typeof client.setMaxListeners === 'function') {
      client.setMaxListeners(100);
    }
    try {
      client.removeListener('close', this.onLifecycleCleanup);
      client.removeListener('end', this.onLifecycleCleanup);
      client.removeListener('error', this.onLifecycleCleanup);
    } catch {
      // ignore
    }
    client.on('close', this.onLifecycleCleanup);
    client.on('end', this.onLifecycleCleanup);
    client.on('error', this.onLifecycleCleanup);
  }

  /**
   * Ensures an active connection to the SFTP server, establishing one if needed.
   * Deduplicates concurrent connection attempts.
   */
  public async ensureConnected(): Promise<void> {
    // A dropped connection resets `isConnected` through the client's close/end/error events.
    if (this.isConnected) {
      return;
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    const doConnect = async () => {
      try {
        // OpenSSH handles auth and host key trust itself (host key prompts reach
        // hostVerifier.hostKeyPrompt via askpass; absent => rejected).
        await this.client.connect();
        this.isConnected = true;
      } catch (err: any) {
        this.isConnected = false;
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes('All configured authentication methods failed') ||
          /Permission denied \(/.test(msg)
        ) {
          if (this.config.authType === 'agent') {
            throw new Error(
              'SSH agent authentication failed: The server rejected the agent key, or the agent has no identities loaded (run "ssh-add").',
              { cause: err }
            );
          }
          throw new Error(
            'Authentication failed: The server rejected the login. Check that the password is correct, or use an SSH key.',
            { cause: err }
          );
        }
        if (msg.includes('read ECONNRESET')) {
          throw new Error(
            'Connection reset by remote server (read ECONNRESET). The SSH server may have closed the connection or dropped it due to authentication failures.',
            { cause: err }
          );
        }
        if (msg.includes('getConnection')) {
          const clean = msg.replace(/^getConnection:?\s*/i, '').trim();
          throw new Error(`Could not connect to SFTP: ${clean || 'Connection failed'}`, { cause: err });
        }
        throw err;
      }
    };

    this.connectionPromise = doConnect().finally(() => {
      this.connectionPromise = null;
    });

    return this.connectionPromise;
  }

  private isConnectionDropError(err: any): boolean {
    if (!err) return false;
    const msg = String(err.message || err);
    const code = err.code;
    return (
      code === 'ECONNRESET' ||
      code === 'EPIPE' ||
      code === 'ECONNABORTED' ||
      code === 'ENOTCONN' ||
      msg.includes('ECONNRESET') ||
      msg.includes('EPIPE') ||
      msg.includes('Not connected') ||
      msg.includes('No SFTP connection') ||
      // What SftpPacketProtocol rejects with when the ssh process went away under a call.
      msg.includes('SFTP stream closed') ||
      msg.includes('SFTP connection is closed')
    );
  }

  private async executeWithReconnect<T>(fn: () => Promise<T>): Promise<T> {
    const generation = this.disconnectCount;
    await this.ensureConnected();
    try {
      return await fn();
    } catch (err: any) {
      // A disconnect() while the call was running also ends it with a "stream closed" error; reconnecting
      // then would reopen a connection nobody holds a reference to any more.
      if (this.isConnectionDropError(err) && generation === this.disconnectCount) {
        this.isConnected = false;
        await this.ensureConnected();
        // disconnect() can also come while the reconnect is under way.
        if (generation !== this.disconnectCount) throw err;
        return await fn();
      }
      throw err;
    }
  }

  public async getHomeDir(): Promise<string> {
    if (this.cachedHomeDir) {
      return this.cachedHomeDir;
    }
    await this.ensureConnected();
    try {
      if (typeof this.client.realPath === 'function') {
        const real = await this.client.realPath('.');
        if (real && real.startsWith('/') && (real !== '/' || this.config.username === 'root')) {
          this.cachedHomeDir = real;
          return real;
        }
      }
    } catch {
      // Fallback
    }
    const fallback =
      this.config.username === 'root' ? '/root' : `/home/${this.config.username || 'user'}`;
    this.cachedHomeDir = fallback;
    return fallback;
  }

  /** `df <path>` equivalent via statvfs@openssh.com; undefined if the server doesn't support it. */
  public async getSpace(remotePath: string): Promise<SpaceInfo | undefined> {
    if (typeof this.client.statvfs !== 'function') return undefined;
    return this.executeWithReconnect(async () => {
      try {
        return await this.client.statvfs!(await this.resolveRemotePath(remotePath));
      } catch (err: any) {
        if (this.isConnectionDropError(err)) throw err;
        return undefined;
      }
    });
  }

  public async resolveRemotePath(remotePath: string): Promise<string> {
    const p = (remotePath || '').replace(/\\/g, '/').trim();
    if (p === '~' || p === '' || p === '.') {
      return await this.getHomeDir();
    }
    if (p.startsWith('~/')) {
      const home = await this.getHomeDir();
      return path.posix.join(home, p.slice(2));
    }
    if (p.startsWith('~')) {
      const home = await this.getHomeDir();
      return path.posix.join(home, p.slice(1));
    }
    return path.posix.normalize(p);
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      const fileList = await this.client.list(resolved);
      const results: FileEntry[] = [];

      for (const item of fileList) {
        const isDir = item.type === 'd' || (item as any).isDirectory === true;
        const entryPath = path.posix.join(resolved, item.name);
        const mtime = parseModifyTime(item);
        const mtimeMs = parseModifyTimeMs(item);

        results.push({
          name: item.name,
          path: entryPath,
          size: item.size,
          isDirectory: isDir,
          isSymlink: item.type === 'l' || (item as any).isSymlink === true,
          isSpecial: (item as any).isSpecial === true || undefined,
          mtime,
          mtimeMs,
          mimeType: isDir ? undefined : getMimeType(item.name),
          permissions: extractPermissions(item),
        });
      }

      // Sort directories first, then alphabetical by name
      results.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      return results;
    });
  }

  async stat(remotePath: string): Promise<FileEntry> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      const stats = await this.client.stat(resolved);
      const isDir = Boolean(stats.isDirectory);
      const name = path.posix.basename(resolved) || resolved;
      const mtime = parseModifyTime(stats);
      const mtimeMs = parseModifyTimeMs(stats);

      return {
        name,
        path: resolved,
        size: stats.size,
        isDirectory: isDir,
        isSymlink: stats.isSymlink === true,
        isSpecial: (stats as any).isSpecial === true || undefined,
        mtime,
        mtimeMs,
        mimeType: isDir ? undefined : getMimeType(name),
        permissions: extractPermissions(stats),
      };
    });
  }

  async createFolder(remotePath: string): Promise<void> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      await this.client.mkdir(resolved, true);
    });
  }

  async delete(remotePath: string, isDirectory: boolean): Promise<void> {
    const resolved = await this.resolveRemotePath(remotePath);
    if (
      resolved === '/' ||
      resolved === '.' ||
      resolved === '..' ||
      remotePath.trim() === '/' ||
      remotePath.trim() === ''
    ) {
      throw new Error(`Cannot delete root directory: ${remotePath}`);
    }

    return this.executeWithReconnect(async () => {
      if (isDirectory) {
        await this.client.rmdir(resolved, true);
      } else {
        await this.client.delete(resolved);
      }
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.executeWithReconnect(async () => {
      const resolvedOld = await this.resolveRemotePath(oldPath);
      const resolvedNew = await this.resolveRemotePath(newPath);

      // Try posixRename first (OpenSSH extension: atomic rename overwriting destination)
      if (typeof this.client.posixRename === 'function') {
        try {
          await this.client.posixRename(resolvedOld, resolvedNew);
          return;
        } catch {
          // Fall back if server doesn't support the OpenSSH extension
        }
      }

      try {
        await this.client.rename(resolvedOld, resolvedNew);
      } catch (renameErr) {
        // Standard SFTP v3 rename fails if the destination exists. Move the destination aside
        // rather than deleting it, so a second failure (e.g. the source vanished) can restore it.
        let destination: { isDirectory?: boolean } | undefined;
        try {
          destination = await this.client.stat(resolvedNew);
        } catch {
          throw renameErr; // No destination to replace: the original failure is the real one.
        }
        // Never replace a directory (posix-rename wouldn't either); that would silently swap it for a file.
        if (destination?.isDirectory) throw renameErr;

        const backup = `${resolvedNew}.sshs3-rename-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        try {
          await this.client.rename(resolvedNew, backup);
        } catch {
          throw renameErr;
        }
        try {
          await this.client.rename(resolvedOld, resolvedNew);
        } catch (retryErr) {
          await this.client.rename(backup, resolvedNew).catch(() => {});
          throw retryErr;
        }
        await this.client.delete(backup).catch(() => {});
      }
    });
  }

  async createReadStream(
    remotePath: string,
    start?: number,
    end?: number
  ): Promise<NodeJS.ReadableStream> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      const streamOptions: { chunkSize: number; autoClose: boolean; start?: number; end?: number } = {
        chunkSize: 128 * 1024,
        autoClose: true,
      };
      if (typeof start === 'number') streamOptions.start = start;
      if (typeof end === 'number') streamOptions.end = end;
      return this.client.createReadStream(resolved, streamOptions);
    });
  }

  async createWriteStream(
    remotePath: string,
    options?: WriteStreamOptions
  ): Promise<NodeJS.WritableStream> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      const streamOptions = {
        chunkSize: 128 * 1024,
        autoClose: true,
        ...(options as any),
      };
      return this.client.createWriteStream(resolved, streamOptions);
    });
  }

  async writeFile(
    remotePath: string,
    data: Buffer | Uint8Array,
    options?: WriteStreamOptions
  ): Promise<void> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      if (typeof this.client.put === 'function') {
        await this.client.put(
          Buffer.isBuffer(data) ? data : Buffer.from(data),
          resolved,
          { mode: options?.mode }
        );
      } else {
        const stream = await this.createWriteStream(remotePath, options);
        await new Promise<void>((resolve, reject) => {
          stream.on('finish', resolve);
          stream.on('error', reject);
          (stream as any).end(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });
      }
    });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      if (typeof this.client.get === 'function') {
        const res = await this.client.get(resolved);
        return Buffer.isBuffer(res) ? res : Buffer.from(res as any);
      }
      const stream = await this.createReadStream(remotePath);
      const chunks: Buffer[] = [];
      return new Promise<Buffer>((resolve, reject) => {
        stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
  }

  async chmod(remotePath: string, mode: number | string): Promise<void> {
    const numericMode = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    if (Number.isNaN(numericMode)) {
      throw new Error(`Invalid chmod mode: ${mode}`);
    }
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      await this.client.chmod(resolved, numericMode);
    });
  }

  async setModifiedTime(remotePath: string, mtimeMs: number): Promise<void> {
    return this.executeWithReconnect(async () => {
      const resolved = await this.resolveRemotePath(remotePath);
      const epochSeconds = Math.floor(mtimeMs / 1000);

      if (typeof this.client.setstat === 'function') {
        await this.client.setstat(resolved, { atime: epochSeconds, mtime: epochSeconds });
        return;
      }

      throw new Error('setModifiedTime is not supported by this SFTP connection');
    });
  }

  public async exec(cmd: string): Promise<{ stdout: Buffer; stderr: string }> {
    await this.ensureConnected();
    if (typeof this.client.exec === 'function') {
      return await this.client.exec(cmd);
    }
    throw new Error('This SFTP connection does not support running remote commands');
  }

  public createExecStream(cmd: string): NodeJS.ReadableStream {
    if (typeof this.client.createExecStream === 'function') {
      return this.client.createExecStream(cmd);
    }
    throw new Error('createExecStream is not supported by this SFTP connection');
  }

  async disconnect(): Promise<void> {
    this.disconnectCount += 1;
    if (this.connectionPromise) {
      try {
        await this.connectionPromise;
      } catch {
        // Ignore connection errors during disconnect
      }
    }
    try {
      await this.client.end();
    } finally {
      this.isConnected = false;
    }
  }
}
