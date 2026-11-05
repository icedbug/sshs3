import { describe, it, expect, vi } from 'vitest';

const { mockStart } = vi.hoisted(() => ({
  mockStart: vi.fn().mockResolvedValue({ on: vi.fn() }),
}));

vi.mock('../../src/main/storage/sftp/OpenSshSftpProcess', () => ({
  OpenSshSftpProcess: class {
    start = mockStart;
  },
}));

import { OpenSshSftpClientAdapter } from '../../src/main/storage/sftp/OpenSshSftpClientAdapter';

describe('OpenSshSftpClientAdapter shared control socket', () => {
  it('hands the given socket to the first connect only', async () => {
    const adapter = new OpenSshSftpClientAdapter(
      { id: 'a', host: 'h', port: 22, username: 'u', authType: 'agent' },
      undefined,
      undefined,
      undefined,
      undefined,
      '/tmp/terminal.sock'
    );
    await adapter.connect();
    await adapter.connect();
    expect(mockStart.mock.calls[0][0].controlPath).toBe('/tmp/terminal.sock');
    expect(mockStart.mock.calls[1][0].controlPath).toBeUndefined();
  });
});

describe('OpenSshSftpClientAdapter.list', () => {
  function adapterWithEntries(filenames: string[]): OpenSshSftpClientAdapter {
    const adapter = new OpenSshSftpClientAdapter({ id: 'a', host: 'h', port: 22, username: 'u', authType: 'agent' });
    const entries = filenames.map((filename) => ({
      filename,
      longname: '',
      attrs: { size: 1, isDirectory: false, isSymlink: false },
    }));
    const readdir = vi.fn().mockResolvedValueOnce(entries).mockResolvedValue(null);
    (adapter as unknown as { protocol: unknown }).protocol = {
      opendir: vi.fn().mockResolvedValue(Buffer.from('h')),
      readdir,
      close: vi.fn().mockResolvedValue(undefined),
    };
    return adapter;
  }

  it('skips entries that are not a single path component', async () => {
    const adapter = adapterWithEntries(['ok.txt', '.', '..', '../escape', 'a/b', '/etc/passwd', 'nul\0name', '']);
    const names = (await adapter.list('/data')).map((e) => e.name);
    expect(names).toEqual(['ok.txt']);
  });

  it('keeps ordinary names, including dots, spaces, backslashes and non-ASCII', async () => {
    const names = ['.hidden', 'a b', 'back\\slash', 'rapport åäö.pdf', '..dots', 'x..'];
    const listed = (await adapterWithEntries(names).list('/data')).map((e) => e.name);
    expect(listed).toEqual(names);
  });
});

describe('OpenSshSftpClientAdapter.mkdir (recursive)', () => {
  /** `existing` maps a path to what stat sees there; mkdir fails for a path in `denied` or already in `existing`. */
  function adapterWith(existing: Record<string, { isDirectory: boolean }>, denied: string[] = []) {
    const adapter = new OpenSshSftpClientAdapter({ id: 'a', host: 'h', port: 22, username: 'u', authType: 'agent' });
    const created: string[] = [];
    const mkdir = vi.fn(async (p: string) => {
      if (denied.includes(p)) throw new Error('Permission denied');
      if (p in existing) throw new Error('Failure');
      created.push(p);
      existing[p] = { isDirectory: true };
    });
    const stat = vi.fn(async (p: string) => {
      if (!(p in existing)) throw new Error('No such file');
      return existing[p];
    });
    (adapter as unknown as { protocol: unknown }).protocol = { mkdir, stat };
    return { adapter, mkdir, created };
  }

  it('creates the missing folders and accepts parents that already exist', async () => {
    const { adapter, created } = adapterWith({ '/home': { isDirectory: true } });
    await adapter.mkdir('/home/alice/new', true);
    expect(created).toEqual(['/home/alice', '/home/alice/new']);
  });

  it('succeeds when the folder asked for already exists', async () => {
    const { adapter } = adapterWith({ '/home': { isDirectory: true }, '/home/alice': { isDirectory: true } });
    await expect(adapter.mkdir('/home/alice', true)).resolves.toBeUndefined();
  });

  it('reports Permission denied for the folder asked for instead of pretending it was created', async () => {
    const { adapter } = adapterWith({ '/root': { isDirectory: true } }, ['/root/forbidden']);
    await expect(adapter.mkdir('/root/forbidden', true)).rejects.toThrow('Permission denied');
  });

  it('reports a failure when a file is in the way', async () => {
    const { adapter } = adapterWith({ '/home': { isDirectory: true }, '/home/alice': { isDirectory: false } });
    await expect(adapter.mkdir('/home/alice', true)).rejects.toThrow('Failure');
  });

  it('reports a parent that cannot be created through the last step', async () => {
    const { adapter } = adapterWith({ '/home': { isDirectory: true } }, ['/home/alice', '/home/alice/new']);
    await expect(adapter.mkdir('/home/alice/new', true)).rejects.toThrow('Permission denied');
  });

  it('keeps ignoring a failing parent that is not a plain directory, such as a Windows drive root', async () => {
    // mkdir of '/C:' fails and stat is unhelpful, but the folder below it can still be made.
    const { adapter, created } = adapterWith({});
    const protocol = (adapter as unknown as { protocol: { mkdir: (p: string) => Promise<void> } }).protocol;
    const original = protocol.mkdir;
    protocol.mkdir = vi.fn(async (p: string) => {
      if (p === '/C:') throw new Error('Failure');
      return original(p);
    });
    await expect(adapter.mkdir('/C:/data', true)).resolves.toBeUndefined();
    expect(created).toEqual(['/C:/data']);
  });
});
