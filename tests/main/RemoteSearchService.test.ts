import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RemoteSearchService, buildFindGrepCommand } from '../../src/main/search/RemoteSearchService';
import { StorageRegistry } from '../../src/main/storage/StorageRegistry';
import { SFTPStorageProvider } from '../../src/main/storage/SFTPStorageProvider';
import type { SFTPConfig } from '../../src/shared/types/storage';
import type { SearchStartOptions } from '../../src/shared/types/search';

class FakeExecStream extends EventEmitter {
  public stderr = new EventEmitter();
  public close = vi.fn();
  public destroy = vi.fn();
}

function createProviderWithFakeExec(): { provider: SFTPStorageProvider; exec: ReturnType<typeof vi.fn>; stream: FakeExecStream } {
  const stream = new FakeExecStream();
  const exec = vi.fn((_cmd: string, cb: (err: any, stream: any) => void) => {
    cb(null, stream);
  });

  const fakeClient: any = {
    client: { exec },
    on: vi.fn(),
    removeListener: vi.fn(),
    setMaxListeners: vi.fn(),
  };

  const config: SFTPConfig = {
    id: 'sftp-test',
    host: 'example.com',
    port: 22,
    username: 'tester',
    authType: 'password',
    password: 'secret',
  };

  const provider = new SFTPStorageProvider(config, fakeClient);
  (provider as any).isConnected = true;

  return { provider, exec, stream };
}

describe('RemoteSearchService', () => {
  let registry: StorageRegistry;
  let service: RemoteSearchService;

  beforeEach(() => {
    registry = new StorageRegistry();
    service = new RemoteSearchService();
  });

  function baseOptions(overrides: Partial<SearchStartOptions> = {}): SearchStartOptions {
    return {
      providerId: 'sftp-test',
      sourceType: 'sftp',
      rootPath: '/data',
      query: 'needle',
      mode: 'literal',
      caseSensitive: false,
      ...overrides,
    };
  }

  it('builds a find | xargs grep command with the pattern and root single-quoted', async () => {
    const { provider, exec } = createProviderWithFakeExec();
    registry.register(provider);

    await service.startSearch(registry, baseOptions(), () => {}, () => {}, () => {});

    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = exec.mock.calls[0][0] as string;
    expect(cmd).toContain("find '/data'");
    expect(cmd).toContain("-e 'needle'");
    expect(cmd).toContain('grep');
    expect(cmd).toContain('-F'); // literal mode
    expect(cmd).toContain('-i'); // caseSensitive: false
  });

  it('escapes single quotes in the query so it cannot break out of the shell argument', async () => {
    const { provider, exec } = createProviderWithFakeExec();
    registry.register(provider);

    await service.startSearch(registry, baseOptions({ query: "it's a test" }), () => {}, () => {}, () => {});

    const cmd = exec.mock.calls[0][0] as string;
    expect(cmd).toContain("-e 'it'\\''s a test'");
  });

  it('uses -E for regex mode and omits -i when caseSensitive is true', async () => {
    const { provider, exec } = createProviderWithFakeExec();
    registry.register(provider);

    await service.startSearch(
      registry,
      baseOptions({ mode: 'regex', caseSensitive: true }),
      () => {},
      () => {},
      () => {}
    );

    const cmd = exec.mock.calls[0][0] as string;
    expect(cmd).toContain('-E');
    expect(cmd).not.toContain(' -i ');
  });

  it('parses interleaved/partial stdout chunks into structured matches, batched on close', async () => {
    const { provider, stream } = createProviderWithFakeExec();
    registry.register(provider);

    const results: any[] = [];
    const done: any[] = [];

    await service.startSearch(registry, baseOptions(), (e) => results.push(...e.matches), () => {}, (e) => done.push(e));

    // Split a single grep line across two chunks to exercise the line-buffering logic.
    stream.emit('data', Buffer.from('/data/a.log:3:hello '));
    stream.emit('data', Buffer.from('needle world\n/data/b.log:10:another needle here\n'));
    stream.emit('close');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      path: '/data/a.log',
      displayPath: 'a.log',
      lineNumber: 3,
      snippet: 'hello needle world',
      source: 'sftp-grep',
    });
    expect(results[1]).toMatchObject({ path: '/data/b.log', displayPath: 'b.log', lineNumber: 10 });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ matchCount: 2, cancelled: false, truncated: false });
  });

  it('strips an anchored relative root from the displayed path of each result', async () => {
    const { provider, stream, exec } = createProviderWithFakeExec();
    registry.register(provider);
    const results: any[] = [];

    await service.startSearch(registry, baseOptions({ rootPath: 'logs' }), (e) => results.push(...e.matches), () => {}, () => {});
    stream.emit('data', Buffer.from('./logs/a.txt:1:needle\n./logs/sub/b.txt:2:needle\n'));
    stream.emit('close');

    expect(exec.mock.calls[0][0]).toContain("find './logs'");
    expect(results.map((m) => m.displayPath)).toEqual(['a.txt', 'sub/b.txt']);
  });

  it('reports stderr lines as non-fatal errors without aborting the search', async () => {
    const { provider, stream } = createProviderWithFakeExec();
    registry.register(provider);

    const errors: any[] = [];
    const done: any[] = [];
    await service.startSearch(registry, baseOptions(), () => {}, (e) => errors.push(e), (e) => done.push(e));

    stream.stderr.emit('data', Buffer.from("find: '/data/secret': Permission denied\n"));
    stream.emit('close');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ fatal: false });
    expect(errors[0].message).toContain('Permission denied');
    expect(done).toHaveLength(1);
  });

  it('cancelSearch destroys the exec stream and marks the done event as cancelled', async () => {
    const { provider, stream } = createProviderWithFakeExec();
    registry.register(provider);

    const done: any[] = [];
    const { searchId } = await service.startSearch(registry, baseOptions(), () => {}, () => {}, (e) => done.push(e));

    service.cancelSearch(searchId);
    expect(stream.destroy).toHaveBeenCalledTimes(1);

    // Cancelling a real ssh2 stream eventually fires 'close' on the channel itself.
    stream.emit('close');

    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ cancelled: true });
  });

  it('stops accepting matches once maxResults is hit and marks the result truncated', async () => {
    const { provider, stream } = createProviderWithFakeExec();
    registry.register(provider);

    const results: any[] = [];
    const done: any[] = [];
    await service.startSearch(
      registry,
      baseOptions({ maxResults: 2 }),
      (e) => results.push(...e.matches),
      () => {},
      (e) => done.push(e)
    );

    stream.emit(
      'data',
      Buffer.from('/data/a.log:1:needle one\n/data/b.log:2:needle two\n/data/c.log:3:needle three\n')
    );

    expect(results).toHaveLength(2);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ matchCount: 2, truncated: true });
  });

  it('emits progress heartbeats while the search is running and stops after done', async () => {
    vi.useFakeTimers();
    try {
      const { provider, stream } = createProviderWithFakeExec();
      registry.register(provider);

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

      stream.emit('data', Buffer.from('/data/a.log:1:needle one\n'));
      vi.advanceTimersByTime(300);

      expect(progress.length).toBeGreaterThanOrEqual(1);
      expect(progress[0]).toMatchObject({ matchCount: 1 });

      const countBeforeClose = progress.length;
      stream.emit('close');
      expect(done).toHaveLength(1);

      vi.advanceTimersByTime(1000);
      expect(progress.length).toBe(countBeforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildFindGrepCommand hardening', () => {
  const base = { query: 'needle', mode: 'literal' as const, caseSensitive: true };

  it('anchors a dash-leading root, ends grep options and sanitises numeric limits', () => {
    const cmd = buildFindGrepCommand('-evil', {
      ...base,
      maxDepth: '1; id' as never,
      maxResults: '5; id' as never,
    } as never);
    expect(cmd).toContain("find './-evil'");
    expect(cmd).not.toContain('-maxdepth');
    expect(cmd).toContain("-e 'needle' --");
    expect(cmd).toContain('| head -n 600');
    expect(cmd).not.toContain('; id');
  });
});
