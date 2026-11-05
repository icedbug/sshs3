import { describe, it, expect, vi } from 'vitest';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { SftpReadStream, SftpWriteStream } from '../../src/main/storage/sftp/SftpStreams';

function makeProtocol() {
  const handle = Buffer.from('h1');
  return {
    open: vi.fn().mockResolvedValue(handle),
    read: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SftpWriteStream', () => {
  it('creates the target file for a zero-byte stream', async () => {
    const protocol = makeProtocol();
    await pipeline(Readable.from([]), new SftpWriteStream(protocol as any, '/remote/empty.txt'));

    expect(protocol.open).toHaveBeenCalledTimes(1);
    expect(protocol.open.mock.calls[0][0]).toBe('/remote/empty.txt');
    expect(protocol.write).not.toHaveBeenCalled();
    expect(protocol.close).toHaveBeenCalledTimes(1);
  });

  it('opens only once when data is written', async () => {
    const protocol = makeProtocol();
    await pipeline(Readable.from([Buffer.from('abc')]), new SftpWriteStream(protocol as any, '/remote/a.txt'));

    expect(protocol.open).toHaveBeenCalledTimes(1);
    expect(protocol.write).toHaveBeenCalledTimes(1);
    expect(protocol.close).toHaveBeenCalledTimes(1);
  });

  it('reports the target as untouched until the lazy open has succeeded (H2)', async () => {
    const protocol = makeProtocol();
    const stream = new SftpWriteStream(protocol as any, '/remote/a.txt');
    expect(stream.targetTouched).toBe(false);

    await pipeline(Readable.from([Buffer.from('abc')]), stream);
    expect(stream.targetTouched).toBe(true);
  });

  // Code review of the unpushed commits: destroying the stream while the open is on the wire must neither leak the handle
  // nor let the caller judge the target "untouched" before the server has answered.
  it('closes a handle that arrives after the stream was destroyed, and settles before the touched flag is read', async () => {
    const protocol = makeProtocol();
    let answer!: (h: Buffer) => void;
    protocol.open.mockReturnValue(new Promise<Buffer>((resolve) => { answer = resolve; }));
    const stream = new SftpWriteStream(protocol as any, '/remote/a.txt');
    stream.on('error', () => {});
    stream.write(Buffer.from('abc'));
    await new Promise((r) => setImmediate(r));
    stream.destroy(new Error('cancelled'));

    const settled = stream.targetSettled();
    answer(Buffer.from('late'));
    await settled;

    expect(stream.targetTouched).toBe(true);
    expect(protocol.close).toHaveBeenCalledWith(Buffer.from('late'));
  });

  // Code review: the zero-byte path in _final had the same hole as _write.
  it('closes a handle that arrives after an empty stream was destroyed, and settles first', async () => {
    const protocol = makeProtocol();
    let answer!: (h: Buffer) => void;
    protocol.open.mockReturnValue(new Promise<Buffer>((resolve) => { answer = resolve; }));
    const stream = new SftpWriteStream(protocol as any, '/remote/empty.txt');
    stream.on('error', () => {});
    stream.end();
    await new Promise((r) => setImmediate(r));
    stream.destroy(new Error('cancelled'));
    let resolved = false;
    const settled = stream.targetSettled().then(() => { resolved = true; });
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false); // the open is on the wire: not settled yet
    answer(Buffer.from('late'));
    await settled;
    expect(stream.targetTouched).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(protocol.close).toHaveBeenCalledWith(Buffer.from('late'));
  });

  it('stays untouched when the open fails (H2)', async () => {
    const protocol = makeProtocol();
    protocol.open.mockRejectedValue(new Error('permission denied'));
    const stream = new SftpWriteStream(protocol as any, '/remote/a.txt');

    await expect(pipeline(Readable.from([Buffer.from('abc')]), stream)).rejects.toThrow('permission denied');
    expect(stream.targetTouched).toBe(false);
  });

  // Low finding (code review 2026-11-03): some servers only report a failed write (full disk, quota) when the
  // handle is closed. Ignoring that error made an incomplete upload look successful.
  it('fails the upload when the server reports an error on closing the file', async () => {
    const protocol = makeProtocol();
    protocol.close.mockRejectedValue(new Error('SSH_FX_FAILURE: quota exceeded'));

    await expect(
      pipeline(Readable.from([Buffer.from('abc')]), new SftpWriteStream(protocol as any, '/remote/a.txt'))
    ).rejects.toThrow('quota exceeded');
  });

  it('still ignores a close error while tearing down a stream that already failed', async () => {
    const protocol = makeProtocol();
    protocol.write.mockRejectedValue(new Error('write failed'));
    protocol.close.mockRejectedValue(new Error('close failed too'));

    await expect(
      pipeline(Readable.from([Buffer.from('abc')]), new SftpWriteStream(protocol as any, '/remote/a.txt'))
    ).rejects.toThrow('write failed');
  });

  it('propagates an open failure for a zero-byte stream', async () => {
    const protocol = makeProtocol();
    protocol.open.mockRejectedValue(new Error('permission denied'));

    await expect(
      pipeline(Readable.from([]), new SftpWriteStream(protocol as any, '/remote/empty.txt'))
    ).rejects.toThrow('permission denied');
  });
});

describe('SftpReadStream', () => {
  it('reads multi-chunk binary data until EOF without stalling', async () => {
    const protocol = makeProtocol();
    const chunk1 = Buffer.alloc(64 * 1024, 0xaa);
    const chunk2 = Buffer.alloc(64 * 1024, 0xbb);
    const chunk3 = Buffer.alloc(10 * 1024, 0xcc);

    protocol.read
      .mockResolvedValueOnce(chunk1)
      .mockResolvedValueOnce(chunk2)
      .mockResolvedValueOnce(chunk3)
      .mockResolvedValueOnce(Buffer.alloc(0)); // EOF

    const readStream = new SftpReadStream(protocol as any, '/remote/large.png', { chunkSize: 64 * 1024 });
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      readStream.on('data', (c) => chunks.push(c));
      readStream.on('end', () => resolve());
      readStream.on('error', (e) => reject(e));
    });

    const full = Buffer.concat(chunks);
    expect(full.length).toBe(chunk1.length + chunk2.length + chunk3.length);
    expect(protocol.open).toHaveBeenCalledTimes(1);
    expect(protocol.read).toHaveBeenCalledTimes(4);
    expect(protocol.close).toHaveBeenCalledTimes(1);
  });

  it('handles consumer pause and resume backpressure without stalling', async () => {
    const protocol = makeProtocol();
    const chunk1 = Buffer.alloc(64 * 1024, 0x11);
    const chunk2 = Buffer.alloc(64 * 1024, 0x22);

    protocol.read
      .mockResolvedValueOnce(chunk1)
      .mockResolvedValueOnce(chunk2)
      .mockResolvedValueOnce(Buffer.alloc(0)); // EOF

    const readStream = new SftpReadStream(protocol as any, '/remote/img.png', { chunkSize: 64 * 1024 });
    const chunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      readStream.on('data', (c) => {
        chunks.push(c);
        readStream.pause();
        setTimeout(() => readStream.resume(), 5);
      });
      readStream.on('end', () => resolve());
      readStream.on('error', (e) => reject(e));
    });

    const full = Buffer.concat(chunks);
    expect(full.length).toBe(chunk1.length + chunk2.length);
  });
});
