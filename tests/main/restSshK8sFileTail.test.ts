import { describe, it, expect, afterEach, vi } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import { FileTailService } from '../../src/main/editor/FileTailService';
import { SFTPStorageProvider } from '../../src/main/storage/SFTPStorageProvider';
import type { StorageRegistry } from '../../src/main/storage/StorageRegistry';

/** An in-memory file behind the two provider calls the polling tail uses. */
function memoryProvider(initial: Buffer) {
  let content = initial;
  const provider = {
    type: 'local',
    stat: vi.fn(async () => ({ size: content.length })),
    createReadStream: vi.fn(async (_p: string, start = 0, end?: number) =>
      Readable.from([content.subarray(start, end === undefined ? undefined : end + 1)])
    ),
  };
  return {
    provider,
    append: (b: Buffer | string) => {
      content = Buffer.concat([content, Buffer.from(b)]);
    },
  };
}

const registryOf = (provider: unknown) => ({ get: () => provider }) as unknown as StorageRegistry;

describe('FileTailService poll cap and SFTP streaming', () => {
  const original = FileTailService.MAX_POLL_BYTES;
  let service: FileTailService | undefined;

  afterEach(() => {
    service?.dispose();
    FileTailService.MAX_POLL_BYTES = original;
    vi.useRealTimers();
  });

  it('caps each poll at 1 MB by default', () => {
    expect(FileTailService.MAX_POLL_BYTES).toBe(1024 * 1024);
  });

  // Code review: the polling fallback read the whole newly appended range in one go, with no limit.
  it('reads at most MAX_POLL_BYTES per poll and says how many bytes it skipped', async () => {
    vi.useFakeTimers();
    FileTailService.MAX_POLL_BYTES = 10;
    const { provider, append } = memoryProvider(Buffer.from('start\n'));
    const chunks: string[] = [];
    service = new FileTailService();
    await service.startTail(registryOf(provider), 'p', '/log', (e) => chunks.push(e.chunk), () => {});

    append('0123456789012345678901234\nLAST-LINE\n'); // 36 bytes
    provider.createReadStream.mockClear();
    await vi.advanceTimersByTimeAsync(2100);

    expect(provider.createReadStream).toHaveBeenCalledWith('/log', 6 + 26, 6 + 36 - 1);
    expect(chunks.join('')).toBe('\n… 26 bytes skipped …\nLAST-LINE\n');

    // Small appends after a skip are read in full, as before.
    append('next\n');
    await vi.advanceTimersByTimeAsync(2100);
    expect(chunks.join('')).toBe('\n… 26 bytes skipped …\nLAST-LINE\nnext\n');
  });

  it('does not start the capped read inside a multi-byte character', async () => {
    vi.useFakeTimers();
    FileTailService.MAX_POLL_BYTES = 4;
    const { provider, append } = memoryProvider(Buffer.alloc(0));
    const chunks: string[] = [];
    service = new FileTailService();
    await service.startTail(registryOf(provider), 'p', '/log', (e) => chunks.push(e.chunk), () => {});

    append('xxxx€ab'); // € is 3 bytes; the last 4 bytes start with its two continuation bytes
    await vi.advanceTimersByTimeAsync(2100);

    expect(chunks.join('')).toBe('\n… 7 bytes skipped …\nab');
    expect(chunks.join('')).not.toContain('�');
  });

  it('streams tail -f over SFTP through createExecStream instead of polling', async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const provider = Object.create(SFTPStorageProvider.prototype) as any;
    Object.defineProperty(provider, 'type', { value: 'sftp' });
    provider.stat = vi.fn(async () => ({ size: 0 }));
    provider.createReadStream = vi.fn(async () => Readable.from([Buffer.alloc(0)]));
    provider.ensureConnected = vi.fn(async () => {});
    provider.resolveRemotePath = vi.fn(async (p: string) => p);
    provider.createExecStream = vi.fn(() => stream);

    const chunks: string[] = [];
    service = new FileTailService();
    const { tailId } = await service.startTail(registryOf(provider), 'p', '/var/log/app.log', (e) => chunks.push(e.chunk), () => {});

    expect(provider.createExecStream).toHaveBeenCalledWith(expect.stringMatching(/^tail -n 0 -f .*app\.log/));
    const euro = Buffer.from('€');
    stream.write(euro.subarray(0, 1));
    stream.write(Buffer.concat([euro.subarray(1), Buffer.from('\n')]));
    await vi.advanceTimersByTimeAsync(2100);
    expect(chunks.join('')).toBe('€\n');
    expect(provider.stat).toHaveBeenCalledTimes(1); // only the initial stat: no polling

    service.stopTail(tailId);
    expect(stream.destroyed).toBe(true);
  });
});
