import { EventEmitter } from 'node:events';
import {
  FXP,
  ATTR,
  FX_STATUS,
  FX_STATUS_MESSAGE,
  type SftpFileStats,
  type SftpNameEntry,
} from './SftpConstants';
import { isSpecialFileMode } from './sftpFileType';

/** Largest data payload per SSH_FXP_WRITE; well under sftp-server's 256 KiB message limit. */
export const MAX_WRITE_DATA = 64 * 1024;

export class SftpError extends Error {
  public readonly statusCode: number;
  public readonly statusName: string;

  constructor(statusCode: number, customMessage?: string) {
    const statusName = FX_STATUS_MESSAGE[statusCode] || `SFTP error ${statusCode}`;
    super(customMessage || statusName);
    this.name = 'SftpError';
    this.statusCode = statusCode;
    this.statusName = statusName;
  }
}

interface PendingRequest {
  type: number;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  allowEof?: boolean;
}

export class SftpPacketProtocol extends EventEmitter {
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private incomingBuffer = Buffer.alloc(0);
  private versionPromise: Promise<number> | null = null;
  private versionResolve: ((version: number) => void) | null = null;
  private versionReject: ((err: Error) => void) | null = null;
  private isClosed = false;

  constructor(
    private readable: NodeJS.ReadableStream,
    private writable: NodeJS.WritableStream
  ) {
    super();

    this.readable.on('data', (chunk: Buffer) => this.onData(chunk));
    this.readable.on('error', (err: Error) => this.handleFatalError(err));
    this.readable.on('close', () => this.handleClose());
    this.readable.on('end', () => this.handleClose());
  }

  private handleFatalError(err: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // Stop buffering: after a fatal error (e.g. an oversized packet length) no further data
    // may accumulate, and the peer is cut off so it cannot keep feeding us.
    this.incomingBuffer = Buffer.alloc(0);
    (this.readable as { destroy?: () => void }).destroy?.();
    if (this.versionReject) {
      this.versionReject(err);
      this.versionReject = null;
      this.versionResolve = null;
    }
    for (const [, req] of this.pendingRequests) {
      req.reject(err);
    }
    this.pendingRequests.clear();
    this.emit('error', err);
  }

  private handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const err = new Error('SFTP stream closed');
    if (this.versionReject) {
      this.versionReject(err);
      this.versionReject = null;
      this.versionResolve = null;
    }
    for (const [, req] of this.pendingRequests) {
      req.reject(err);
    }
    this.pendingRequests.clear();
    this.emit('close');
  }

  private onData(chunk: Buffer): void {
    if (this.isClosed) return;
    this.incomingBuffer = Buffer.concat([this.incomingBuffer, chunk]);

    while (this.incomingBuffer.length >= 4) {
      const packetLength = this.incomingBuffer.readUInt32BE(0);
      if (packetLength > 16 * 1024 * 1024) {
        this.handleFatalError(new Error(`SFTP packet length ${packetLength} exceeds safe maximum of 16MB`));
        return;
      }
      if (this.incomingBuffer.length < 4 + packetLength) {
        break; // Wait for full packet
      }

      const packet = this.incomingBuffer.subarray(4, 4 + packetLength);
      this.incomingBuffer = this.incomingBuffer.subarray(4 + packetLength);

      this.processPacket(packet);
    }
  }

  private processPacket(packet: Buffer): void {
    if (packet.length < 1) return;
    const type = packet.readUInt8(0);

    if (type === FXP.VERSION) {
      if (packet.length < 5) {
        if (this.versionReject) this.versionReject(new Error('Invalid SSH_FXP_VERSION packet'));
        return;
      }
      const version = packet.readUInt32BE(1);
      if (this.versionResolve) {
        this.versionResolve(version);
        this.versionResolve = null;
        this.versionReject = null;
      }
      return;
    }

    if (packet.length < 5) return;
    const requestId = packet.readUInt32BE(1);
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    this.pendingRequests.delete(requestId);

    if (type === FXP.STATUS) {
      const statusCode = packet.length >= 9 ? packet.readUInt32BE(5) : FX_STATUS.FAILURE;
      if (statusCode === FX_STATUS.OK) {
        pending.resolve(undefined);
        return;
      }
      if (statusCode === FX_STATUS.EOF && pending.allowEof) {
        pending.resolve(null);
        return;
      }
      let errorMsg = '';
      if (packet.length >= 13) {
        const msgLen = packet.readUInt32BE(9);
        if (packet.length >= 13 + msgLen) {
          errorMsg = packet.subarray(13, 13 + msgLen).toString('utf-8');
        }
      }
      pending.reject(new SftpError(statusCode, errorMsg));
      return;
    }

    try {
      switch (type) {
        case FXP.HANDLE: {
          const handleLen = packet.readUInt32BE(5);
          const handle = Buffer.from(packet.subarray(9, fieldEnd(packet, 9, handleLen)));
          pending.resolve(handle);
          break;
        }
        case FXP.DATA: {
          const dataLen = packet.readUInt32BE(5);
          const data = Buffer.from(packet.subarray(9, fieldEnd(packet, 9, dataLen)));
          pending.resolve(data);
          break;
        }
        case FXP.NAME: {
          const count = packet.readUInt32BE(5);
          let offset = 9;
          const entries: SftpNameEntry[] = [];
          for (let i = 0; i < count; i++) {
            if (offset + 4 > packet.length) break;
            const fnLen = packet.readUInt32BE(offset);
            offset += 4;
            const filename = packet.subarray(offset, fieldEnd(packet, offset, fnLen)).toString('utf-8');
            offset += fnLen;

            if (offset + 4 > packet.length) break;
            const lnLen = packet.readUInt32BE(offset);
            offset += 4;
            const longname = packet.subarray(offset, fieldEnd(packet, offset, lnLen)).toString('utf-8');
            offset += lnLen;

            const { stats, nextOffset } = parseAttrs(packet, offset);
            offset = nextOffset;

            entries.push({ filename, longname, attrs: stats });
          }
          pending.resolve(entries);
          break;
        }
        case FXP.ATTRS: {
          const { stats } = parseAttrs(packet, 5);
          pending.resolve(stats);
          break;
        }
        case FXP.EXTENDED_REPLY: {
          pending.resolve(packet.subarray(5));
          break;
        }
        default:
          pending.reject(new Error(`Unexpected SFTP response packet type: ${type}`));
          break;
      }
    } catch (err: any) {
      pending.reject(err);
    }
  }

  public async init(): Promise<number> {
    if (this.versionPromise) return this.versionPromise;

    this.versionPromise = new Promise<number>((resolve, reject) => {
      this.versionResolve = resolve;
      this.versionReject = reject;

      const initPacket = Buffer.alloc(9);
      initPacket.writeUInt32BE(5, 0); // length
      initPacket.writeUInt8(FXP.INIT, 4); // type
      initPacket.writeUInt32BE(3, 5); // version 3
      this.sendRaw(initPacket);
    });

    return this.versionPromise;
  }

  private sendRequest<T>(
    type: number,
    payloadBuilder: (requestId: number) => Buffer,
    allowEof?: boolean
  ): Promise<T> {
    if (this.isClosed) {
      return Promise.reject(new Error('SFTP connection is closed'));
    }
    const requestId = this.nextRequestId++;
    const payload = payloadBuilder(requestId);
    const packet = Buffer.alloc(4 + payload.length);
    packet.writeUInt32BE(payload.length, 0);
    payload.copy(packet, 4);

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        type,
        resolve,
        reject,
        allowEof,
      });
      this.sendRaw(packet);
    });
  }

  private sendRaw(data: Buffer): void {
    this.writable.write(data);
  }

  public async open(
    remotePath: string,
    pflags: number,
    attrs?: Partial<SftpFileStats>
  ): Promise<Buffer> {
    return this.sendRequest<Buffer>(FXP.OPEN, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const attrBuf = serializeAttrs(attrs);
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length + 4 + attrBuf.length);
      let o = 0;
      b.writeUInt8(FXP.OPEN, o);
      o += 1;
      b.writeUInt32BE(reqId, o);
      o += 4;
      b.writeUInt32BE(pathBuf.length, o);
      o += 4;
      pathBuf.copy(b, o);
      o += pathBuf.length;
      b.writeUInt32BE(pflags, o);
      o += 4;
      attrBuf.copy(b, o);
      return b;
    });
  }

  public async close(handle: Buffer): Promise<void> {
    return this.sendRequest<void>(FXP.CLOSE, (reqId) => {
      const b = Buffer.alloc(1 + 4 + 4 + handle.length);
      b.writeUInt8(FXP.CLOSE, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(handle.length, 5);
      handle.copy(b, 9);
      return b;
    });
  }

  public async read(
    handle: Buffer,
    offset: number,
    length: number
  ): Promise<Buffer | null> {
    return this.sendRequest<Buffer | null>(
      FXP.READ,
      (reqId) => {
        const b = Buffer.alloc(1 + 4 + 4 + handle.length + 8 + 4);
        let o = 0;
        b.writeUInt8(FXP.READ, o);
        o += 1;
        b.writeUInt32BE(reqId, o);
        o += 4;
        b.writeUInt32BE(handle.length, o);
        o += 4;
        handle.copy(b, o);
        o += handle.length;
        b.writeBigUInt64BE(BigInt(offset), o);
        o += 8;
        b.writeUInt32BE(length, o);
        return b;
      },
      true // allowEof -> returns null on EOF
    );
  }

  /**
   * Writes `data` at `offset`, split into SSH_FXP_WRITE packets of at most `MAX_WRITE_DATA` bytes:
   * OpenSSH's sftp-server drops the connection on any message over 256 KiB, so a single packet for
   * a large buffer would kill the whole session.
   */
  public async write(
    handle: Buffer,
    offset: number,
    data: Buffer
  ): Promise<void> {
    if (data.length <= MAX_WRITE_DATA) {
      return this.writePacket(handle, offset, data);
    }
    for (let pos = 0; pos < data.length; pos += MAX_WRITE_DATA) {
      await this.writePacket(handle, offset + pos, data.subarray(pos, pos + MAX_WRITE_DATA));
    }
  }

  private async writePacket(
    handle: Buffer,
    offset: number,
    data: Buffer
  ): Promise<void> {
    return this.sendRequest<void>(FXP.WRITE, (reqId) => {
      const b = Buffer.alloc(1 + 4 + 4 + handle.length + 8 + 4 + data.length);
      let o = 0;
      b.writeUInt8(FXP.WRITE, o);
      o += 1;
      b.writeUInt32BE(reqId, o);
      o += 4;
      b.writeUInt32BE(handle.length, o);
      o += 4;
      handle.copy(b, o);
      o += handle.length;
      b.writeBigUInt64BE(BigInt(offset), o);
      o += 8;
      b.writeUInt32BE(data.length, o);
      o += 4;
      data.copy(b, o);
      return b;
    });
  }

  public async stat(remotePath: string): Promise<SftpFileStats> {
    return this.sendRequest<SftpFileStats>(FXP.STAT, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length);
      b.writeUInt8(FXP.STAT, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(pathBuf.length, 5);
      pathBuf.copy(b, 9);
      return b;
    });
  }

  public async lstat(remotePath: string): Promise<SftpFileStats> {
    return this.sendRequest<SftpFileStats>(FXP.LSTAT, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length);
      b.writeUInt8(FXP.LSTAT, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(pathBuf.length, 5);
      pathBuf.copy(b, 9);
      return b;
    });
  }

  public async fstat(handle: Buffer): Promise<SftpFileStats> {
    return this.sendRequest<SftpFileStats>(FXP.FSTAT, (reqId) => {
      const b = Buffer.alloc(1 + 4 + 4 + handle.length);
      b.writeUInt8(FXP.FSTAT, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(handle.length, 5);
      handle.copy(b, 9);
      return b;
    });
  }

  public async setstat(
    remotePath: string,
    attrs: { mode?: number; mtime?: number; atime?: number; size?: number }
  ): Promise<void> {
    return this.sendRequest<void>(FXP.SETSTAT, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const attrBuf = serializeAttrs(attrs);
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length + attrBuf.length);
      let o = 0;
      b.writeUInt8(FXP.SETSTAT, o);
      o += 1;
      b.writeUInt32BE(reqId, o);
      o += 4;
      b.writeUInt32BE(pathBuf.length, o);
      o += 4;
      pathBuf.copy(b, o);
      o += pathBuf.length;
      attrBuf.copy(b, o);
      return b;
    });
  }

  public async opendir(remotePath: string): Promise<Buffer> {
    return this.sendRequest<Buffer>(FXP.OPENDIR, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length);
      b.writeUInt8(FXP.OPENDIR, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(pathBuf.length, 5);
      pathBuf.copy(b, 9);
      return b;
    });
  }

  public async readdir(handle: Buffer): Promise<SftpNameEntry[] | null> {
    return this.sendRequest<SftpNameEntry[] | null>(
      FXP.READDIR,
      (reqId) => {
        const b = Buffer.alloc(1 + 4 + 4 + handle.length);
        b.writeUInt8(FXP.READDIR, 0);
        b.writeUInt32BE(reqId, 1);
        b.writeUInt32BE(handle.length, 5);
        handle.copy(b, 9);
        return b;
      },
      true // allowEof -> returns null on EOF
    );
  }

  public async mkdir(remotePath: string, attrs?: Partial<SftpFileStats>): Promise<void> {
    return this.sendRequest<void>(FXP.MKDIR, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const attrBuf = serializeAttrs(attrs);
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length + attrBuf.length);
      let o = 0;
      b.writeUInt8(FXP.MKDIR, o);
      o += 1;
      b.writeUInt32BE(reqId, o);
      o += 4;
      b.writeUInt32BE(pathBuf.length, o);
      o += 4;
      pathBuf.copy(b, o);
      o += pathBuf.length;
      attrBuf.copy(b, o);
      return b;
    });
  }

  public async rmdir(remotePath: string): Promise<void> {
    return this.sendRequest<void>(FXP.RMDIR, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length);
      b.writeUInt8(FXP.RMDIR, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(pathBuf.length, 5);
      pathBuf.copy(b, 9);
      return b;
    });
  }

  public async remove(remotePath: string): Promise<void> {
    return this.sendRequest<void>(FXP.REMOVE, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length);
      b.writeUInt8(FXP.REMOVE, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(pathBuf.length, 5);
      pathBuf.copy(b, 9);
      return b;
    });
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    return this.sendRequest<void>(FXP.RENAME, (reqId) => {
      const oldBuf = Buffer.from(oldPath, 'utf-8');
      const newBuf = Buffer.from(newPath, 'utf-8');
      const b = Buffer.alloc(1 + 4 + 4 + oldBuf.length + 4 + newBuf.length);
      let o = 0;
      b.writeUInt8(FXP.RENAME, o);
      o += 1;
      b.writeUInt32BE(reqId, o);
      o += 4;
      b.writeUInt32BE(oldBuf.length, o);
      o += 4;
      oldBuf.copy(b, o);
      o += oldBuf.length;
      b.writeUInt32BE(newBuf.length, o);
      o += 4;
      newBuf.copy(b, o);
      return b;
    });
  }

  public async posixRename(oldPath: string, newPath: string): Promise<void> {
    const extName = Buffer.from('posix-rename@openssh.com', 'utf-8');
    const oldBuf = Buffer.from(oldPath, 'utf-8');
    const newBuf = Buffer.from(newPath, 'utf-8');

    return this.sendRequest<void>(FXP.EXTENDED, (reqId) => {
      const b = Buffer.alloc(1 + 4 + 4 + extName.length + 4 + oldBuf.length + 4 + newBuf.length);
      let o = 0;
      b.writeUInt8(FXP.EXTENDED, o);
      o += 1;
      b.writeUInt32BE(reqId, o);
      o += 4;
      b.writeUInt32BE(extName.length, o);
      o += 4;
      extName.copy(b, o);
      o += extName.length;
      b.writeUInt32BE(oldBuf.length, o);
      o += 4;
      oldBuf.copy(b, o);
      o += oldBuf.length;
      b.writeUInt32BE(newBuf.length, o);
      o += 4;
      newBuf.copy(b, o);
      return b;
    });
  }

  /** statvfs@openssh.com: filesystem space for the filesystem containing `remotePath` (the server's `df <path>`). */
  public async statvfs(remotePath: string): Promise<{ totalBytes: number; freeBytes: number }> {
    const extName = Buffer.from('statvfs@openssh.com', 'utf-8');
    const pathBuf = Buffer.from(remotePath, 'utf-8');
    const reply = await this.sendRequest<Buffer>(FXP.EXTENDED, (reqId) => {
      const b = Buffer.alloc(1 + 4 + 4 + extName.length + 4 + pathBuf.length);
      let o = 0;
      b.writeUInt8(FXP.EXTENDED, o);
      o += 1;
      b.writeUInt32BE(reqId, o);
      o += 4;
      b.writeUInt32BE(extName.length, o);
      o += 4;
      extName.copy(b, o);
      o += extName.length;
      b.writeUInt32BE(pathBuf.length, o);
      o += 4;
      pathBuf.copy(b, o);
      return b;
    });
    // Reply: f_bsize, f_frsize, f_blocks, f_bfree, f_bavail, ... (all uint64, big-endian).
    if (reply.length < 40) throw new Error('Malformed statvfs reply');
    const frsize = Number(reply.readBigUInt64BE(8)) || Number(reply.readBigUInt64BE(0));
    return {
      totalBytes: Number(reply.readBigUInt64BE(16)) * frsize,
      freeBytes: Number(reply.readBigUInt64BE(32)) * frsize,
    };
  }

  public async realpath(remotePath: string): Promise<string> {
    const res = await this.sendRequest<SftpNameEntry[]>(FXP.REALPATH, (reqId) => {
      const pathBuf = Buffer.from(remotePath, 'utf-8');
      const b = Buffer.alloc(1 + 4 + 4 + pathBuf.length);
      b.writeUInt8(FXP.REALPATH, 0);
      b.writeUInt32BE(reqId, 1);
      b.writeUInt32BE(pathBuf.length, 5);
      pathBuf.copy(b, 9);
      return b;
    });

    if (res && res.length > 0) {
      return res[0].filename;
    }
    return remotePath;
  }
}

/**
 * End offset of a length-prefixed field. A length that runs past the packet is a malformed reply:
 * subarray() would silently clamp it, handing back a truncated handle, file chunk or name.
 */
function fieldEnd(packet: Buffer, start: number, length: number): number {
  const end = start + length;
  if (end > packet.length) throw new Error('Malformed SFTP reply: field length exceeds packet size');
  return end;
}

function parseAttrs(
  packet: Buffer,
  startOffset: number
): { stats: SftpFileStats; nextOffset: number } {
  let offset = startOffset;
  if (offset + 4 > packet.length) {
    return {
      stats: { size: 0, isDirectory: false, isSymlink: false },
      nextOffset: offset,
    };
  }
  const flags = packet.readUInt32BE(offset);
  offset += 4;

  let size = 0;
  let uid: number | undefined;
  let gid: number | undefined;
  let mode: number | undefined;
  let atime: number | undefined;
  let mtime: number | undefined;

  if (flags & ATTR.SIZE) {
    if (offset + 8 <= packet.length) {
      size = Number(packet.readBigUInt64BE(offset));
      offset += 8;
    }
  }

  if (flags & ATTR.UIDGID) {
    if (offset + 8 <= packet.length) {
      uid = packet.readUInt32BE(offset);
      offset += 4;
      gid = packet.readUInt32BE(offset);
      offset += 4;
    }
  }

  if (flags & ATTR.PERMISSIONS) {
    if (offset + 4 <= packet.length) {
      mode = packet.readUInt32BE(offset);
      offset += 4;
    }
  }

  if (flags & ATTR.ACMODTIME) {
    if (offset + 8 <= packet.length) {
      atime = packet.readUInt32BE(offset);
      offset += 4;
      mtime = packet.readUInt32BE(offset);
      offset += 4;
    }
  }

  if (flags & ATTR.EXTENDED) {
    if (offset + 4 <= packet.length) {
      const extCount = packet.readUInt32BE(offset);
      offset += 4;
      for (let i = 0; i < extCount; i++) {
        if (offset + 4 > packet.length) break;
        const typeLen = packet.readUInt32BE(offset);
        offset += 4 + typeLen;
        if (offset + 4 > packet.length) break;
        const dataLen = packet.readUInt32BE(offset);
        offset += 4 + dataLen;
      }
    }
  }

  const isDirectory = mode !== undefined ? (mode & 0o170000) === 0o040000 : false;
  const isSymlink = mode !== undefined ? (mode & 0o170000) === 0o120000 : false;
  const isSpecial = isSpecialFileMode(mode);

  return {
    stats: {
      size,
      uid,
      gid,
      mode,
      atime,
      mtime,
      isDirectory,
      isSymlink,
      isSpecial,
    },
    nextOffset: offset,
  };
}

function serializeAttrs(attrs?: {
  mode?: number;
  mtime?: number;
  atime?: number;
  size?: number;
}): Buffer {
  if (!attrs) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(0, 0);
    return b;
  }

  let flags = 0;
  let len = 4;

  if (typeof attrs.size === 'number') {
    flags |= ATTR.SIZE;
    len += 8;
  }
  if (typeof attrs.mode === 'number') {
    flags |= ATTR.PERMISSIONS;
    len += 4;
  }
  if (typeof attrs.mtime === 'number' || typeof attrs.atime === 'number') {
    flags |= ATTR.ACMODTIME;
    len += 8;
  }

  const b = Buffer.alloc(len);
  let o = 0;
  b.writeUInt32BE(flags, o);
  o += 4;

  if (flags & ATTR.SIZE) {
    b.writeBigUInt64BE(BigInt(attrs.size!), o);
    o += 8;
  }
  if (flags & ATTR.PERMISSIONS) {
    b.writeUInt32BE(attrs.mode!, o);
    o += 4;
  }
  if (flags & ATTR.ACMODTIME) {
    const at = typeof attrs.atime === 'number' ? attrs.atime : attrs.mtime!;
    const mt = typeof attrs.mtime === 'number' ? attrs.mtime : attrs.atime!;
    b.writeUInt32BE(at, o);
    o += 4;
    b.writeUInt32BE(mt, o);
  }

  return b;
}
