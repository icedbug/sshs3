import type { HostKeyPromptInfo } from '../../ssh/HostKeyVerifier';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { OpenSshSftpProcess } from './OpenSshSftpProcess';
import { SftpPacketProtocol } from './SftpPacketProtocol';
import { SftpReadStream, SftpWriteStream } from './SftpStreams';
import { FXF } from './SftpConstants';
import type { SFTPConfig } from '../../../shared/types/storage';

export interface ISftpBackendClient extends EventEmitter {
  connect(options?: any): Promise<void>;
  list(path: string): Promise<any[]>;
  stat(path: string): Promise<any>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  rmdir(path: string, recursive?: boolean): Promise<void>;
  delete(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  posixRename?(oldPath: string, newPath: string): Promise<void>;
  createReadStream(path: string, options?: any): NodeJS.ReadableStream;
  createWriteStream(path: string, options?: any): NodeJS.WritableStream;
  get?(path: string): Promise<Buffer>;
  put?(data: Buffer, path: string, options?: any): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  setstat?(path: string, attrs: any): Promise<void>;
  realPath(path: string): Promise<string>;
  statvfs?(path: string): Promise<{ totalBytes: number; freeBytes: number }>;
  end(): Promise<void>;
  exec?(cmd: string): Promise<{ stdout: Buffer; stderr: string }>;
  createExecStream?(cmd: string): NodeJS.ReadableStream;
  sftp?: any;
}

export class OpenSshSftpClientAdapter extends EventEmitter implements ISftpBackendClient {
  private process: OpenSshSftpProcess;
  private protocol?: SftpPacketProtocol;
  private config: SFTPConfig;
  private pinPromptHandler?: (prompt: string) => Promise<string> | string;
  private onPresence?: (prompt: string) => void;
  private onPresenceCleared?: () => void;
  private hostKeyPromptHandler?: (info: HostKeyPromptInfo) => Promise<boolean>;
  private sharedControlPath?: string;

  constructor(
    config: SFTPConfig,
    pinPromptHandler?: (prompt: string) => Promise<string> | string,
    onPresence?: (prompt: string) => void,
    hostKeyPromptHandler?: (info: HostKeyPromptInfo) => Promise<boolean>,
    onPresenceCleared?: () => void,
    controlPath?: string
  ) {
    super();
    this.sharedControlPath = controlPath;
    this.config = config;
    this.pinPromptHandler = pinPromptHandler;
    this.onPresence = onPresence;
    this.hostKeyPromptHandler = hostKeyPromptHandler;
    this.onPresenceCleared = onPresenceCleared;
    this.process = new OpenSshSftpProcess();
  }

  // Backward compatibility getter for code inspecting raw sftp instance
  public get sftp(): this {
    return this;
  }

  public async connect(): Promise<void> {
    // The shared master belongs to a terminal and may be gone on a reconnect, so only the first connect uses it.
    const controlPath = this.sharedControlPath;
    this.sharedControlPath = undefined;
    this.protocol = await this.process.start({
      config: this.config,
      controlPath,
      pinPromptHandler: this.pinPromptHandler,
      onPresence: this.onPresence,
      onPresenceCleared: this.onPresenceCleared,
      hostKeyPromptHandler: this.hostKeyPromptHandler,
    });
    this.protocol.on('close', () => this.emit('close'));
    this.protocol.on('error', (err) => this.emit('error', err));
  }

  public async list(remotePath: string): Promise<any[]> {
    if (!this.protocol) throw new Error('Not connected');
    const handle = await this.protocol.opendir(remotePath);
    const results: any[] = [];
    try {
      while (true) {
        const entries = await this.protocol.readdir(handle);
        if (!entries || entries.length === 0) break;
        for (const e of entries) {
          if (e.filename === '.' || e.filename === '..') continue;
          // A directory entry is one path component: a name with a separator or NUL would make
          // path.posix.join() (rmdir -r, list paths) leave the directory being listed.
          if (e.filename === '' || e.filename.includes('/') || e.filename.includes('\0')) continue;
          results.push({
            name: e.filename,
            type: e.attrs.isDirectory ? 'd' : e.attrs.isSymlink ? 'l' : '-',
            isDirectory: e.attrs.isDirectory,
            isSpecial: e.attrs.isSpecial,
            size: e.attrs.size,
            modifyTime: e.attrs.mtime ? e.attrs.mtime * 1000 : undefined,
            permissions: e.attrs.mode ? (e.attrs.mode & 0o777).toString(8).padStart(3, '0') : undefined,
          });
        }
      }
    } finally {
      await this.protocol.close(handle);
    }
    return results;
  }

  public async stat(remotePath: string): Promise<any> {
    if (!this.protocol) throw new Error('Not connected');
    const s = await this.protocol.stat(remotePath);
    return {
      size: s.size,
      isDirectory: s.isDirectory,
      isSymlink: s.isSymlink,
      isSpecial: s.isSpecial,
      modifyTime: s.mtime ? s.mtime * 1000 : undefined,
      mode: s.mode,
      permissions: s.mode ? (s.mode & 0o777).toString(8).padStart(3, '0') : undefined,
    };
  }

  public async statvfs(remotePath: string): Promise<{ totalBytes: number; freeBytes: number }> {
    if (!this.protocol) throw new Error('Not connected');
    return await this.protocol.statvfs(remotePath);
  }

  public async realPath(remotePath: string): Promise<string> {
    if (!this.protocol) throw new Error('Not connected');
    return await this.protocol.realpath(remotePath);
  }

  public async mkdir(remotePath: string, recursive?: boolean): Promise<void> {
    if (!this.protocol) throw new Error('Not connected');
    if (recursive) {
      const parts = remotePath.split('/').filter(Boolean);
      let current = remotePath.startsWith('/') ? '' : '.';
      for (const [index, part] of parts.entries()) {
        current = current === '' ? `/${part}` : `${current}/${part}`;
        try {
          await this.protocol.mkdir(current);
        } catch (err) {
          // A parent that already exists makes mkdir fail; that is fine, and if one really cannot be
          // created the last step below fails too. Only the folder that was asked for must end up a directory.
          if (index < parts.length - 1) continue;
          const existing = await this.protocol.stat(current).catch(() => null);
          if (!existing?.isDirectory) throw err;
        }
      }
      return;
    }
    await this.protocol.mkdir(remotePath);
  }

  public async rmdir(remotePath: string, recursive?: boolean): Promise<void> {
    if (!this.protocol) throw new Error('Not connected');
    if (recursive) {
      const items = await this.list(remotePath);
      for (const item of items) {
        const itemPath = path.posix.join(remotePath, item.name);
        if (item.type === 'd' || item.isDirectory) {
          await this.rmdir(itemPath, true);
        } else {
          await this.protocol.remove(itemPath);
        }
      }
    }
    await this.protocol.rmdir(remotePath);
  }

  public async delete(remotePath: string): Promise<void> {
    if (!this.protocol) throw new Error('Not connected');
    await this.protocol.remove(remotePath);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    if (!this.protocol) throw new Error('Not connected');
    await this.protocol.rename(oldPath, newPath);
  }

  public async posixRename(oldPath: string, newPath: string): Promise<void> {
    if (!this.protocol) throw new Error('Not connected');
    await this.protocol.posixRename(oldPath, newPath);
  }

  public createReadStream(remotePath: string, options?: any): NodeJS.ReadableStream {
    if (!this.protocol) throw new Error('Not connected');
    return new SftpReadStream(this.protocol, remotePath, options);
  }

  public createWriteStream(remotePath: string, options?: any): NodeJS.WritableStream {
    if (!this.protocol) throw new Error('Not connected');
    return new SftpWriteStream(this.protocol, remotePath, options);
  }

  public async put(data: Buffer, remotePath: string, options?: any): Promise<void> {
    if (!this.protocol) throw new Error('Not connected');
    const handle = await this.protocol.open(
      remotePath,
      FXF.WRITE | FXF.CREAT | FXF.TRUNC,
      { mode: options?.mode }
    );
    try {
      await this.protocol.write(handle, 0, data);
    } finally {
      await this.protocol.close(handle);
    }
  }

  public async get(remotePath: string): Promise<Buffer> {
    if (!this.protocol) throw new Error('Not connected');
    const handle = await this.protocol.open(remotePath, FXF.READ);
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      const CHUNK_SIZE = 64 * 1024;
      while (true) {
        const chunk = await this.protocol.read(handle, offset, CHUNK_SIZE);
        if (!chunk || chunk.length === 0) break;
        chunks.push(chunk);
        offset += chunk.length;
      }
      return Buffer.concat(chunks);
    } finally {
      await this.protocol.close(handle);
    }
  }

  public async chmod(remotePath: string, mode: number): Promise<void> {
    if (!this.protocol) throw new Error('Not connected');
    await this.protocol.setstat(remotePath, { mode });
  }

  public async setstat(remotePath: string, attrs: any, callback?: (err?: any) => void): Promise<void> {
    if (!this.protocol) {
      const err = new Error('Not connected');
      if (callback) return callback(err);
      throw err;
    }
    try {
      await this.protocol.setstat(remotePath, attrs);
      if (callback) callback();
    } catch (err) {
      if (callback) callback(err);
      else throw err;
    }
  }

  public async exec(cmd: string): Promise<{ stdout: Buffer; stderr: string }> {
    return await this.process.exec(cmd);
  }

  public createExecStream(cmd: string): NodeJS.ReadableStream {
    return this.process.createExecStream(cmd);
  }

  public async end(): Promise<void> {
    await this.process.close();
    this.emit('end');
    this.emit('close');
  }
}
