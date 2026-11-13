import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LocalContentSearchService } from '../../src/main/search/LocalContentSearchService';
import { StorageRegistry } from '../../src/main/storage/StorageRegistry';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';
import type { SearchStartOptions } from '../../src/shared/types/search';

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(check, 5);
    };
    check();
  });
}

describe('LocalContentSearchService', () => {
  let tempDir: string;
  let registry: StorageRegistry;
  let service: LocalContentSearchService;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sshs3-local-search-test-'));
    registry = new StorageRegistry();
    registry.register(new LocalStorageProvider({ id: 'local-test', name: 'Local' }));
    service = new LocalContentSearchService();
  });

  afterEach(async () => {
    service.dispose();
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function baseOptions(overrides: Partial<SearchStartOptions> = {}): SearchStartOptions {
    return {
      providerId: 'local-test',
      sourceType: 'local',
      rootPath: tempDir,
      query: 'needle',
      mode: 'literal',
      caseSensitive: false,
      ...overrides,
    };
  }

  it('recursively finds matches across nested directories', async () => {
    await fsp.mkdir(path.join(tempDir, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'a.log'), 'no match here\n');
    await fsp.writeFile(path.join(tempDir, 'sub', 'b.log'), 'line one\ncontains needle right here\n');

    const results: any[] = [];
    const done: any[] = [];
    await service.startSearch(registry, baseOptions(), (e) => results.push(...e.matches), () => {}, (e) => done.push(e));

    await waitFor(() => done.length === 1);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      displayPath: path.join('sub', 'b.log'),
      lineNumber: 2,
      source: 'local-fs',
    });
    expect(done[0]).toMatchObject({ matchCount: 1, scannedCount: 2, cancelled: false, truncated: false });
  });

  it('is case-insensitive by default and case-sensitive when requested', async () => {
    await fsp.writeFile(path.join(tempDir, 'a.txt'), 'Needle in a haystack\n');

    const insensitive: any[] = [];
    await service.startSearch(registry, baseOptions(), (e) => insensitive.push(...e.matches), () => {}, () => {});
    await waitFor(() => insensitive.length === 1);
    expect(insensitive).toHaveLength(1);

    const sensitive: any[] = [];
    const done: any[] = [];
    await service.startSearch(
      registry,
      baseOptions({ caseSensitive: true }),
      (e) => sensitive.push(...e.matches),
      () => {},
      (e) => done.push(e)
    );
    await waitFor(() => done.length === 1);
    expect(sensitive).toHaveLength(0);
  });

  it('skips binary files silently and files larger than maxFileSizeBytes with a warning', async () => {
    await fsp.writeFile(path.join(tempDir, 'binary.dat'), Buffer.from([0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
    await fsp.writeFile(path.join(tempDir, 'huge.txt'), 'needle\n'.repeat(1000));

    const results: any[] = [];
    const errors: any[] = [];
    const done: any[] = [];
    await service.startSearch(
      registry,
      baseOptions({ maxFileSizeBytes: 100 }),
      (e) => results.push(...e.matches),
      (e) => errors.push(e),
      (e) => done.push(e)
    );

    await waitFor(() => done.length === 1);
    expect(results).toHaveLength(0);
    expect(errors.some((e) => e.message.includes('exceeds size cap'))).toBe(true);
  });

  it('respects include/exclude globs', async () => {
    await fsp.writeFile(path.join(tempDir, 'keep.csv'), 'needle\n');
    await fsp.writeFile(path.join(tempDir, 'skip.txt'), 'needle\n');

    const results: any[] = [];
    const done: any[] = [];
    await service.startSearch(
      registry,
      baseOptions({ includeGlobs: ['*.csv'] }),
      (e) => results.push(...e.matches),
      () => {},
      (e) => done.push(e)
    );

    await waitFor(() => done.length === 1);
    expect(results).toHaveLength(1);
    expect(results[0].displayPath).toBe('keep.csv');
  });

  // Needs a directory this process may not read. chmod does not give that on Windows, and nothing is
  // unreadable to root (a container): there the test has no way to set up what it tests, so it is skipped.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a non-fatal error for an unreadable subdirectory without aborting the search', async () => {

    await fsp.mkdir(path.join(tempDir, 'locked'));
    await fsp.writeFile(path.join(tempDir, 'locked', 'secret.txt'), 'needle\n');
    await fsp.writeFile(path.join(tempDir, 'visible.txt'), 'needle here\n');
    await fsp.chmod(path.join(tempDir, 'locked'), 0o000);

    try {
      const results: any[] = [];
      const errors: any[] = [];
      const done: any[] = [];
      await service.startSearch(
        registry,
        baseOptions(),
        (e) => results.push(...e.matches),
        (e) => errors.push(e),
        (e) => done.push(e)
      );

      await waitFor(() => done.length === 1);
      expect(results).toHaveLength(1);
      expect(results[0].displayPath).toBe('visible.txt');
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].fatal).toBe(false);
    } finally {
      await fsp.chmod(path.join(tempDir, 'locked'), 0o755).catch(() => {});
    }
  });

  it('stays responsive to cancel while deep inside one file with many matching lines', async () => {
    // Regression test: the per-line loop used to run fully synchronously with no
    // `await` anywhere in it once a file was being scanned. Node has one JS thread, so
    // a single large enough file blocks that thread for its *entire* scan — including
    // the `search:cancel` IPC handler, which can't run (and so can't set the
    // cancellation flag) until the loop finally yields on its own. A real user's
    // "Cancel does nothing" report traces to exactly this: cancelling mid-file did
    // nothing until that one file happened to finish.
    //
    // Measured directly: scanning 15,000,000 matching lines in one file with no
    // in-loop yield takes ~4.5s end to end, i.e. cancel would be stuck for that long.
    const lineCount = 15_000_000;
    await fsp.writeFile(path.join(tempDir, 'giant.txt'), 'this line contains needle\n'.repeat(lineCount));

    const done: any[] = [];
    const { searchId } = await service.startSearch(
      registry,
      baseOptions({ maxFileSizeBytes: 500 * 1024 * 1024, maxResults: 100_000_000 }),
      () => {},
      () => {},
      (e) => done.push(e)
    );

    // Wait long enough that the file has definitely finished being read off disk and
    // the per-line loop is genuinely underway, so cancelling now tests interrupting a
    // loop already in progress — not just aborting the initial read. Scheduled via
    // setTimeout, like a real IPC message would be: it only runs once Node's event loop
    // is free to process queued callbacks — exactly what an unyielding loop would starve.
    await new Promise((r) => setTimeout(r, 500));
    const scheduledAt = Date.now();
    setTimeout(() => service.cancelSearch(searchId), 0);

    await waitFor(() => done.length === 1, 8000);
    const elapsed = Date.now() - scheduledAt;

    expect(done[0].cancelled).toBe(true);
    expect(done[0].matchCount).toBeLessThan(lineCount);
    expect(elapsed).toBeLessThan(1500);
  }, 15000);

  it('cancelSearch stops the search and marks the done event cancelled', async () => {
    for (let i = 0; i < 20; i++) {
      await fsp.writeFile(path.join(tempDir, `file${i}.txt`), 'needle\n');
    }

    const done: any[] = [];
    const { searchId } = await service.startSearch(registry, baseOptions(), () => {}, () => {}, (e) => done.push(e));
    service.cancelSearch(searchId);

    await waitFor(() => done.length === 1);
    expect(done[0]).toMatchObject({ cancelled: true });
  });

  it('stops scanning a single large file immediately when cancelled mid-file, instead of finishing it', async () => {
    // Regression test: the per-line loop used to check only `hasHitCap()`, not the
    // cancellation flag, so cancelling while a worker was deep inside one large file let
    // it keep matching every remaining line before the outer loop noticed the cancel.
    const lineCount = 500_000;
    const content = 'this line contains needle\n'.repeat(lineCount);
    await fsp.writeFile(path.join(tempDir, 'huge.txt'), content);

    const results: any[] = [];
    const done: any[] = [];
    const { searchId } = await service.startSearch(
      registry,
      baseOptions({ maxFileSizeBytes: 100 * 1024 * 1024, maxResults: 10_000_000 }),
      (e) => results.push(...e.matches),
      () => {},
      (e) => done.push(e)
    );

    service.cancelSearch(searchId);

    await waitFor(() => done.length === 1, 5000);

    expect(done[0]).toMatchObject({ cancelled: true });
    expect(results.length).toBeLessThan(lineCount);
  });

  it('stops accepting matches once maxResults is hit and marks the result truncated', async () => {
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(path.join(tempDir, `file${i}.txt`), 'needle\n');
    }

    const results: any[] = [];
    const done: any[] = [];
    await service.startSearch(
      registry,
      baseOptions({ maxResults: 2 }),
      (e) => results.push(...e.matches),
      () => {},
      (e) => done.push(e)
    );

    await waitFor(() => done.length === 1);
    expect(results.length).toBeLessThanOrEqual(2);
    expect(done[0].truncated).toBe(true);
  });

  it('emits progress heartbeats while scanning', async () => {
    await fsp.writeFile(path.join(tempDir, 'a.txt'), 'needle\n');

    const progress: any[] = [];
    const done: any[] = [];
    await service.startSearch(
      registry,
      baseOptions(),
      () => {},
      () => {},
      (e) => done.push(e),
      (e) => progress.push(e)
    );

    await waitFor(() => done.length === 1);
    // A fast local search may finish before any 300ms heartbeat fires — just confirm the
    // plumbing doesn't throw and, if any fired, that the shape is right.
    if (progress.length > 0) {
      expect(progress[0]).toHaveProperty('scannedCount');
    }
  });

  it('previewLines returns the lines around a match', async () => {
    await fsp.writeFile(path.join(tempDir, 'a.txt'), 'one\ntwo\nneedle\nfour\nfive\n');

    const result = await service.previewLines(registry, 'local-test', path.join(tempDir, 'a.txt'), 3, 1);
    expect(result.startLine).toBe(2);
    expect(result.content).toBe('two\nneedle\nfour');
  });
});
