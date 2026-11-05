import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileTailService } from '../../src/main/editor/FileTailService';
import { StorageRegistry } from '../../src/main/storage/StorageRegistry';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';

describe('FileTailService', () => {
  let tempDir: string;
  let registry: StorageRegistry;
  let service: FileTailService;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sshs3-tail-test-'));
    registry = new StorageRegistry();
    const localProvider = new LocalStorageProvider({
      id: 'local-test',
      name: 'Local',
      basePath: tempDir,
    });
    registry.register(localProvider);
    service = new FileTailService();
  });

  afterEach(async () => {
    service.dispose();
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('fetches initial tail content and streams appended data via polling', async () => {
    const filePath = path.join(tempDir, 'test.log');
    await fsp.writeFile(filePath, 'Line 1\nLine 2\nLine 3\n');

    const dataEvents: string[] = [];
    const errorEvents: string[] = [];

    const result = await service.startTail(
      registry,
      'local-test',
      filePath,
      (event) => dataEvents.push(event.chunk),
      (event) => errorEvents.push(event.error)
    );

    expect(result.tailId).toBeDefined();
    expect(result.initialContent).toBe('Line 1\nLine 2\nLine 3\n');

    // Append new line to log file
    await fsp.appendFile(filePath, 'Line 4\n');

    // Wait for polling tick (2000ms)
    await new Promise((resolve) => setTimeout(resolve, 2200));

    expect(dataEvents.length).toBeGreaterThan(0);
    expect(dataEvents.join('')).toContain('Line 4\n');
    expect(errorEvents.length).toBe(0);

    service.stopTail(result.tailId);
  });

  // Low finding: the range end is inclusive, so asking for "up to size" read one byte past the file, and a byte
  // that arrived in between was delivered twice.
  it('asks the provider for the new bytes only, ending at the last byte of the file', async () => {
    const filePath = path.join(tempDir, 'range.log');
    await fsp.writeFile(filePath, 'abc\n');
    const provider = registry.get('local-test')!;
    const spy = vi.spyOn(provider, 'createReadStream');

    const result = await service.startTail(registry, 'local-test', filePath, () => {}, () => {});
    spy.mockClear();
    await fsp.appendFile(filePath, 'defg\n');
    await new Promise((resolve) => setTimeout(resolve, 2300));

    const ranged = spy.mock.calls.filter((c) => typeof c[1] === 'number');
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged[0].slice(1)).toEqual([4, 8]); // bytes 4..8 of a 9-byte file
    service.stopTail(result.tailId);
  }, 10000);

  it('does not break a multi-byte character that is appended in two pieces', async () => {
    const filePath = path.join(tempDir, 'utf8.log');
    await fsp.writeFile(filePath, 'start\n');
    const chunks: string[] = [];
    const result = await service.startTail(registry, 'local-test', filePath, (e) => chunks.push(e.chunk), () => {});

    const euro = Buffer.from('€');
    await fsp.appendFile(filePath, euro.subarray(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 2300)); // first poll sees only half a character
    await fsp.appendFile(filePath, euro.subarray(2));
    await new Promise((resolve) => setTimeout(resolve, 2300));

    expect(chunks.join('')).toBe('€');
    service.stopTail(result.tailId);
  }, 15000);

  it('stops tailing when stopTail is called', async () => {
    const filePath = path.join(tempDir, 'test2.log');
    await fsp.writeFile(filePath, 'Initial\n');

    const dataEvents: string[] = [];

    const result = await service.startTail(
      registry,
      'local-test',
      filePath,
      (event) => dataEvents.push(event.chunk),
      () => {}
    );

    service.stopTail(result.tailId);

    // Append after stop
    await fsp.appendFile(filePath, 'Appended after stop\n');
    await new Promise((resolve) => setTimeout(resolve, 2200));

    expect(dataEvents.length).toBe(0);
  });
});
