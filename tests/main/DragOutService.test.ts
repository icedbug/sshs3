import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DragOutService, isSafeStageName, MAX_STAGED_FILE_BYTES } from '../../src/main/dragout/DragOutService';

describe('DragOutService', () => {
  let base: string;
  let stat: ReturnType<typeof vi.fn>;
  let addJob: ReturnType<typeof vi.fn>;
  let waitForJob: ReturnType<typeof vi.fn>;
  let service: DragOutService;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-dragout-svc-'));
    stat = vi.fn().mockResolvedValue({ name: 'a.txt', size: 10, isDirectory: false, mtimeMs: 1 });
    addJob = vi.fn((opts: { targetPath: string }) => {
      fs.writeFileSync(opts.targetPath, 'data');
      return { id: 'job-1' };
    });
    waitForJob = vi.fn().mockResolvedValue({ progress: { status: 'completed' } });
    service = new DragOutService(
      {
        getSource: (id) => (id === 'sftp-1' ? ({ stat } as never) : undefined),
        getLocal: async () => ({ type: 'local' }) as never,
        queue: { addJob, waitForJob } as never,
      },
      base
    );
  });

  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('downloads into a private temp dir under the original name', async () => {
    const [local] = await service.prepare('sftp-1', ['/srv/a.txt']);
    expect(path.basename(local)).toBe('a.txt');
    expect(local.startsWith(base)).toBe(true);
    expect(fs.readFileSync(local, 'utf8')).toBe('data');
    expect(addJob).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: '/srv/a.txt', isDirectory: false, verifyIntegrity: false })
    );
    if (process.platform !== 'win32') {
      // POSIX permission bits do not exist on Windows
      expect(fs.statSync(path.dirname(local)).mode & 0o077).toBe(0);
      expect(fs.statSync(path.dirname(path.dirname(local))).mode & 0o077).toBe(0);
    }
    expect(path.basename(path.dirname(path.dirname(local)))).toMatch(/^sshs3-dragout-.{6}$/);
  });

  it('reuses an unchanged copy and re-downloads after the file changed', async () => {
    const [first] = await service.prepare('sftp-1', ['/srv/a.txt']);
    const [second] = await service.prepare('sftp-1', ['/srv/a.txt']);
    expect(second).toBe(first);
    expect(addJob).toHaveBeenCalledTimes(1);
    stat.mockResolvedValue({ name: 'a.txt', size: 10, isDirectory: false, mtimeMs: 2 });
    await service.prepare('sftp-1', ['/srv/a.txt']);
    expect(addJob).toHaveBeenCalledTimes(2);
  });

  it('shares one download between concurrent requests', async () => {
    const [a, b] = await Promise.all([service.prepare('sftp-1', ['/srv/a.txt']), service.prepare('sftp-1', ['/srv/a.txt'])]);
    expect(a).toEqual(b);
    expect(addJob).toHaveBeenCalledTimes(1);
  });

  it('downloads a directory again every time and removes the previous copy', async () => {
    stat.mockResolvedValue({ name: 'dir', size: 0, isDirectory: true, mtimeMs: 1 });
    addJob.mockImplementation((opts: { targetPath: string }) => {
      fs.mkdirSync(opts.targetPath, { recursive: true });
      return { id: 'job-d' };
    });
    const [first] = await service.prepare('sftp-1', ['/srv/dir']);
    const [second] = await service.prepare('sftp-1', ['/srv/dir']);
    expect(addJob).toHaveBeenCalledTimes(2);
    expect(addJob).toHaveBeenCalledWith(expect.objectContaining({ isDirectory: true }));
    expect(second).not.toBe(first);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(true);
  });

  it('creates a single staging root for concurrent first requests and removes it on dispose', async () => {
    stat.mockImplementation(async (p: string) => ({ name: path.basename(p), size: 1, isDirectory: false, mtimeMs: 1 }));
    await Promise.all([service.prepare('sftp-1', ['/srv/a.txt']), service.prepare('sftp-1', ['/srv/b.txt'])]);
    expect(fs.readdirSync(base)).toHaveLength(1);
    await service.dispose();
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('sweeps stale roots only on the first request', async () => {
    await service.prepare('sftp-1', ['/srv/a.txt']);
    const stale = fs.mkdtempSync(path.join(base, 'sshs3-dragout-'));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    stat.mockResolvedValue({ name: 'a.txt', size: 10, isDirectory: false, mtimeMs: 5 });
    await service.prepare('sftp-1', ['/srv/a.txt']);
    expect(fs.existsSync(stale)).toBe(true);
  });

  it('refuses unknown providers, bad input, special and oversized files', async () => {
    await expect(service.prepare('nope', ['/a'])).rejects.toThrow('Storage provider not found');
    await expect(service.prepare('sftp-1', [])).rejects.toThrow();
    await expect(service.prepare('sftp-1', ['/'])).rejects.toThrow('this name');
    await expect(service.prepare('sftp-1', ['/a\0b'])).rejects.toThrow('Invalid path');
    stat.mockResolvedValue({ name: 'p', size: 0, isDirectory: false, isSpecial: true });
    await expect(service.prepare('sftp-1', ['/srv/pipe'])).rejects.toThrow('Not a regular file');
    stat.mockResolvedValue({ name: 'big', size: MAX_STAGED_FILE_BYTES + 1, isDirectory: false });
    await expect(service.prepare('sftp-1', ['/srv/big'])).rejects.toThrow('too large');
    expect(addJob).not.toHaveBeenCalled();
  });

  it('cleans up and reports failed transfers', async () => {
    waitForJob.mockResolvedValue({ progress: { status: 'failed' }, error: 'boom' });
    await expect(service.prepare('sftp-1', ['/srv/a.txt'])).rejects.toThrow('boom');
    const [root] = fs.readdirSync(base);
    expect(fs.readdirSync(path.join(base, root))).toEqual([]);
  });

  it('removes everything on dispose', async () => {
    await service.prepare('sftp-1', ['/srv/a.txt']);
    await service.dispose();
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it('never reuses a pre-created predictable directory and sweeps stale roots of this user', async () => {
    const decoy = path.join(base, 'sshs3-dragout-1000');
    fs.mkdirSync(decoy);
    const stale = fs.mkdtempSync(path.join(base, 'sshs3-dragout-'));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    const [local] = await service.prepare('sftp-1', ['/srv/a.txt']);
    expect(local.startsWith(decoy)).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
  });

  it('validates stage names', () => {
    expect(isSafeStageName('ok.txt')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) expect(isSafeStageName(bad)).toBe(false);
  });

  it('accepts POSIX-only names off Windows but rejects them on Windows', () => {
    const windowsOnlyBad = ['12:30.log', 'a*b', 'what?.txt', 'q"uote', 'a|b', 'a<b', 'dots.', 'space ', 'CON', 'nul.txt', 'com1', 'LPT9.log'];
    for (const name of windowsOnlyBad) {
      expect(isSafeStageName(name, 'linux')).toBe(true);
      expect(isSafeStageName(name, 'win32')).toBe(false);
    }
    for (const ok of ['ok.txt', 'console.log', 'com10', 'a b.txt', '.hidden']) expect(isSafeStageName(ok, 'win32')).toBe(true);
  });
});
