import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { SftpPacketProtocol, SftpError } from '../../src/main/storage/sftp/SftpPacketProtocol';
import { SftpReadStream } from '../../src/main/storage/sftp/SftpStreams';
import { FXP, FX_STATUS, ATTR } from '../../src/main/storage/sftp/SftpConstants';

describe('SftpPacketProtocol', () => {
  let clientIn: PassThrough;
  let clientOut: PassThrough;
  let protocol: SftpPacketProtocol;

  beforeEach(() => {
    clientIn = new PassThrough();
    clientOut = new PassThrough();
    protocol = new SftpPacketProtocol(clientIn, clientOut);
  });

  it('closes and stops buffering after an oversized packet length', () => {
    const errors: Error[] = [];
    protocol.on('error', (e: Error) => errors.push(e));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(17 * 1024 * 1024, 0);
    clientIn.write(header);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/exceeds safe maximum/);
    expect(clientIn.destroyed).toBe(true);
    expect((protocol as unknown as { incomingBuffer: Buffer }).incomingBuffer.length).toBe(0);
    // Later data is ignored instead of re-triggering the error or growing the buffer.
    (protocol as unknown as { onData: (c: Buffer) => void }).onData(Buffer.alloc(1024));
    expect((protocol as unknown as { incomingBuffer: Buffer }).incomingBuffer.length).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('splits a large write into packets below the sftp-server 256 KiB message limit', async () => {
    const packets: { offset: number; length: number; size: number }[] = [];
    clientOut.on('data', (buf: Buffer) => {
      expect(buf.readUInt8(4)).toBe(FXP.WRITE);
      const reqId = buf.readUInt32BE(5);
      const handleLen = buf.readUInt32BE(9);
      const offset = Number(buf.readBigUInt64BE(13 + handleLen));
      const length = buf.readUInt32BE(21 + handleLen);
      packets.push({ offset, length, size: buf.length });
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + 4);
      resp.writeUInt32BE(1 + 4 + 4 + 4, 0);
      resp.writeUInt8(FXP.STATUS, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(FX_STATUS.OK, 9);
      resp.writeUInt32BE(0, 13);
      clientIn.write(resp);
    });

    await protocol.write(Buffer.from('h1'), 1000, Buffer.alloc(300 * 1024, 1));

    expect(packets.length).toBeGreaterThan(1);
    expect(packets.every((pk) => pk.size < 256 * 1024)).toBe(true);
    expect(packets.reduce((sum, pk) => sum + pk.length, 0)).toBe(300 * 1024);
    // Consecutive, gap-free offsets starting where the caller asked.
    let expected = 1000;
    for (const pk of packets) {
      expect(pk.offset).toBe(expected);
      expected += pk.length;
    }
  });

  it('performs init handshake and receives version packet', async () => {
    // Listen for client init packet
    const clientPromise = protocol.init();

    clientOut.once('data', (data: Buffer) => {
      expect(data.readUInt32BE(0)).toBe(5); // len
      expect(data.readUInt8(4)).toBe(FXP.INIT); // type
      expect(data.readUInt32BE(5)).toBe(3); // version

      // Send mock server VERSION packet
      const resp = Buffer.alloc(9);
      resp.writeUInt32BE(5, 0);
      resp.writeUInt8(FXP.VERSION, 4);
      resp.writeUInt32BE(3, 5);
      clientIn.write(resp);
    });

    const version = await clientPromise;
    expect(version).toBe(3);
  });

  it('opens a file, reads data, and closes handle', async () => {
    // 1. OPEN
    const openPromise = protocol.open('/tmp/test.txt', 1);

    clientOut.once('data', (data: Buffer) => {
      const type = data.readUInt8(4);
      const reqId = data.readUInt32BE(5);
      expect(type).toBe(FXP.OPEN);

      // Respond with HANDLE
      const handle = Buffer.from('h123');
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + handle.length);
      resp.writeUInt32BE(1 + 4 + 4 + handle.length, 0);
      resp.writeUInt8(FXP.HANDLE, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(handle.length, 9);
      handle.copy(resp, 13);
      clientIn.write(resp);
    });

    const handle = await openPromise;
    expect(handle.toString()).toBe('h123');

    // 2. READ
    const readPromise = protocol.read(handle, 0, 10);
    clientOut.once('data', (data: Buffer) => {
      const type = data.readUInt8(4);
      const reqId = data.readUInt32BE(5);
      expect(type).toBe(FXP.READ);

      // Respond with DATA
      const content = Buffer.from('hello world');
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + content.length);
      resp.writeUInt32BE(1 + 4 + 4 + content.length, 0);
      resp.writeUInt8(FXP.DATA, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(content.length, 9);
      content.copy(resp, 13);
      clientIn.write(resp);
    });

    const data = await readPromise;
    expect(data?.toString()).toBe('hello world');

    // 3. READ returns null on EOF status
    const eofPromise = protocol.read(handle, 11, 10);
    clientOut.once('data', (buf: Buffer) => {
      const reqId = buf.readUInt32BE(5);
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + 4);
      resp.writeUInt32BE(1 + 4 + 4 + 4, 0);
      resp.writeUInt8(FXP.STATUS, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(FX_STATUS.EOF, 9);
      resp.writeUInt32BE(0, 13);
      clientIn.write(resp);
    });

    const eofData = await eofPromise;
    expect(eofData).toBeNull();

    // 4. CLOSE
    const closePromise = protocol.close(handle);
    clientOut.once('data', (buf: Buffer) => {
      const reqId = buf.readUInt32BE(5);
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + 4);
      resp.writeUInt32BE(1 + 4 + 4 + 4, 0);
      resp.writeUInt8(FXP.STATUS, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(FX_STATUS.OK, 9);
      resp.writeUInt32BE(0, 13);
      clientIn.write(resp);
    });

    await expect(closePromise).resolves.toBeUndefined();
  });

  it('rejects on SFTP error status with SftpError', async () => {
    const statPromise = protocol.stat('/nonexistent');

    clientOut.once('data', (buf: Buffer) => {
      const reqId = buf.readUInt32BE(5);
      const msg = Buffer.from('File not found');
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + 4 + msg.length);
      resp.writeUInt32BE(1 + 4 + 4 + 4 + msg.length, 0);
      resp.writeUInt8(FXP.STATUS, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(FX_STATUS.NO_SUCH_FILE, 9);
      resp.writeUInt32BE(msg.length, 13);
      msg.copy(resp, 17);
      clientIn.write(resp);
    });

    await expect(statPromise).rejects.toThrow(SftpError);
    await expect(statPromise).rejects.toMatchObject({
      statusCode: FX_STATUS.NO_SUCH_FILE,
      message: 'File not found',
    });
  });

  it('correctly parses directory entries via opendir and readdir', async () => {
    const opendirPromise = protocol.opendir('/var/log');
    clientOut.once('data', (data: Buffer) => {
      const reqId = data.readUInt32BE(5);
      const handle = Buffer.from('dirhandle');
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + handle.length);
      resp.writeUInt32BE(1 + 4 + 4 + handle.length, 0);
      resp.writeUInt8(FXP.HANDLE, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(handle.length, 9);
      handle.copy(resp, 13);
      clientIn.write(resp);
    });

    const handle = await opendirPromise;

    // READDIR returning entries
    const readdirPromise = protocol.readdir(handle);
    clientOut.once('data', (data: Buffer) => {
      const reqId = data.readUInt32BE(5);

      const fn = Buffer.from('syslog');
      const ln = Buffer.from('-rw-r--r-- 1 root root 1024 Jan 1 syslog');
      const attrFlags = ATTR.SIZE | ATTR.PERMISSIONS | ATTR.ACMODTIME;

      const entryLen = 4 + fn.length + 4 + ln.length + 4 + 8 + 4 + 8;
      const resp = Buffer.alloc(4 + 1 + 4 + 4 + entryLen);
      resp.writeUInt32BE(1 + 4 + 4 + entryLen, 0);
      resp.writeUInt8(FXP.NAME, 4);
      resp.writeUInt32BE(reqId, 5);
      resp.writeUInt32BE(1, 9); // count = 1

      let o = 13;
      resp.writeUInt32BE(fn.length, o);
      o += 4;
      fn.copy(resp, o);
      o += fn.length;

      resp.writeUInt32BE(ln.length, o);
      o += 4;
      ln.copy(resp, o);
      o += ln.length;

      resp.writeUInt32BE(attrFlags, o);
      o += 4;
      resp.writeBigUInt64BE(1024n, o);
      o += 8;
      resp.writeUInt32BE(0o100644, o); // regular file mode
      o += 4;
      resp.writeUInt32BE(1700000000, o); // atime
      o += 4;
      resp.writeUInt32BE(1700000000, o); // mtime

      clientIn.write(resp);
    });

    const entries = await readdirPromise;
    expect(entries).toHaveLength(1);
    expect(entries![0].filename).toBe('syslog');
    expect(entries![0].attrs.size).toBe(1024);
    expect(entries![0].attrs.isDirectory).toBe(false);
  });

  describe('malformed replies', () => {
    /** Answers the next request with `type`, a request id and `body` (the bytes after the id). */
    function replyToNext(type: number, body: Buffer): void {
      clientOut.once('data', (data: Buffer) => {
        const resp = Buffer.alloc(4 + 1 + 4 + body.length);
        resp.writeUInt32BE(1 + 4 + body.length, 0);
        resp.writeUInt8(type, 4);
        resp.writeUInt32BE(data.readUInt32BE(5), 5);
        body.copy(resp, 9);
        clientIn.write(resp);
      });
    }

    function lengthPrefixed(declared: number, actual: Buffer): Buffer {
      const b = Buffer.alloc(4 + actual.length);
      b.writeUInt32BE(declared, 0);
      actual.copy(b, 4);
      return b;
    }

    it('rejects a handle whose length runs past the packet', async () => {
      replyToNext(FXP.HANDLE, lengthPrefixed(100, Buffer.from('abc')));
      await expect(protocol.opendir('/x')).rejects.toThrow(/Malformed SFTP reply/);
    });

    it('rejects a data chunk whose length runs past the packet instead of returning it truncated', async () => {
      replyToNext(FXP.DATA, lengthPrefixed(1000, Buffer.from('short')));
      await expect(protocol.read(Buffer.from('h'), 0, 1000)).rejects.toThrow(/Malformed SFTP reply/);
    });

    it('rejects a name entry whose filename length runs past the packet', async () => {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(1, 0);
      replyToNext(FXP.NAME, Buffer.concat([count, lengthPrefixed(500, Buffer.from('name'))]));
      await expect(protocol.readdir(Buffer.from('h'))).rejects.toThrow(/Malformed SFTP reply/);
    });

    it('still accepts a handle and a data chunk that exactly fill the packet', async () => {
      replyToNext(FXP.HANDLE, lengthPrefixed(3, Buffer.from('abc')));
      await expect(protocol.opendir('/x')).resolves.toEqual(Buffer.from('abc'));
      replyToNext(FXP.DATA, lengthPrefixed(5, Buffer.from('hello')));
      await expect(protocol.read(Buffer.from('h'), 0, 5)).resolves.toEqual(Buffer.from('hello'));
    });
  });
});

describe('SftpStreams', () => {
  let clientIn: PassThrough;
  let clientOut: PassThrough;
  let protocol: SftpPacketProtocol;

  beforeEach(() => {
    clientIn = new PassThrough();
    clientOut = new PassThrough();
    protocol = new SftpPacketProtocol(clientIn, clientOut);
  });

  it('reads data chunk via SftpReadStream', async () => {
    const stream = new SftpReadStream(protocol, '/tmp/read.txt');

    // Auto-respond to OPEN
    clientOut.on('data', (buf: Buffer) => {
      const type = buf.readUInt8(4);
      const reqId = buf.readUInt32BE(5);
      if (type === FXP.OPEN) {
        const h = Buffer.from('h1');
        const resp = Buffer.alloc(4 + 1 + 4 + 4 + h.length);
        resp.writeUInt32BE(1 + 4 + 4 + h.length, 0);
        resp.writeUInt8(FXP.HANDLE, 4);
        resp.writeUInt32BE(reqId, 5);
        resp.writeUInt32BE(h.length, 9);
        h.copy(resp, 13);
        clientIn.write(resp);
      } else if (type === FXP.READ) {
        const offset = Number(buf.readBigUInt64BE(15));
        if (offset === 0) {
          const content = Buffer.from('StreamContent');
          const resp = Buffer.alloc(4 + 1 + 4 + 4 + content.length);
          resp.writeUInt32BE(1 + 4 + 4 + content.length, 0);
          resp.writeUInt8(FXP.DATA, 4);
          resp.writeUInt32BE(reqId, 5);
          resp.writeUInt32BE(content.length, 9);
          content.copy(resp, 13);
          clientIn.write(resp);
        } else {
          // EOF
          const resp = Buffer.alloc(4 + 1 + 4 + 4 + 4);
          resp.writeUInt32BE(1 + 4 + 4 + 4, 0);
          resp.writeUInt8(FXP.STATUS, 4);
          resp.writeUInt32BE(reqId, 5);
          resp.writeUInt32BE(FX_STATUS.EOF, 9);
          resp.writeUInt32BE(0, 13);
          clientIn.write(resp);
        }
      } else if (type === FXP.CLOSE) {
        const resp = Buffer.alloc(4 + 1 + 4 + 4 + 4);
        resp.writeUInt32BE(1 + 4 + 4 + 4, 0);
        resp.writeUInt8(FXP.STATUS, 4);
        resp.writeUInt32BE(reqId, 5);
        resp.writeUInt32BE(FX_STATUS.OK, 9);
        resp.writeUInt32BE(0, 13);
        clientIn.write(resp);
      }
    });

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks).toString()).toBe('StreamContent');
  });

  it('reads filesystem space via statvfs@openssh.com', async () => {
    const promise = protocol.statvfs('/data');
    clientOut.once('data', (data: Buffer) => {
      expect(data.readUInt8(4)).toBe(FXP.EXTENDED);
      const reqId = data.readUInt32BE(5);
      const nameLen = data.readUInt32BE(9);
      expect(data.subarray(13, 13 + nameLen).toString()).toBe('statvfs@openssh.com');

      // f_bsize, f_frsize, f_blocks, f_bfree, f_bavail, f_files, f_ffree, f_favail, f_fsid, f_flag, f_namemax
      const fields = [4096n, 1024n, 1000n, 400n, 300n, 0n, 0n, 0n, 0n, 0n, 255n];
      const body = Buffer.alloc(fields.length * 8);
      fields.forEach((v, i) => body.writeBigUInt64BE(v, i * 8));
      const resp = Buffer.alloc(4 + 1 + 4 + body.length);
      resp.writeUInt32BE(1 + 4 + body.length, 0);
      resp.writeUInt8(FXP.EXTENDED_REPLY, 4);
      resp.writeUInt32BE(reqId, 5);
      body.copy(resp, 9);
      clientIn.write(resp);
    });

    // total = blocks * frsize, free = bavail (what a non-root user can use) * frsize
    expect(await promise).toEqual({ totalBytes: 1000 * 1024, freeBytes: 300 * 1024 });
  });
});
