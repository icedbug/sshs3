import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { archiveRefusal } from '../../src/main/archive/archiveCommands';
import { removeLinksUnder } from '../../src/main/archive/ArchiveService';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';
import { isInside, realLocation } from '../../src/main/web/tenantBoundary';
import { startWebServer, tarWithLink, type WebClient, type WebServerKit } from '../helpers/webServerKit';

const posix = process.platform !== 'win32';

/**
 * C2: the "local files" folder of an account was checked by reading the path as text, and unpacking an
 * archive made a symbolic link in it. Through the link a member listed, read and wrote the server's disk.
 */
describe('web server: an account\'s local files stay in its own folder', () => {
  let kit: WebServerKit;
  let omar: WebClient;
  let sandbox: string;
  let secret: string;

  beforeEach(async () => {
    kit = await startWebServer();
    const { memberCookie, memberId } = await kit.team();
    omar = await kit.connect(memberCookie);
    await omar.invoke('storage:connect', { id: 'local', name: 'Local', type: 'local' });
    sandbox = path.join(kit.dataDir, 'users', memberId, 'files');
    // The server's own secret: beside the data folder's files, outside every account's folder.
    secret = path.join(kit.dataDir, 'server-secret.txt');
    await fs.writeFile(secret, 'SERVER-ONLY-SECRET\n');
  });

  afterEach(async () => {
    omar.close();
    await kit.stop();
  });

  it.skipIf(!posix)('does not unpack an archive that holds a symbolic link', async () => {
    await omar.invoke('file:save', 'local', 'x.tar', tarWithLink('esc', kit.dataDir));
    await expect(omar.invoke('archive:extract', 'local', 'x.tar')).rejects.toThrow(/holds a link to another place/);
    // Nothing was unpacked: no folder, no link.
    expect((await fs.readdir(sandbox)).sort()).toEqual(['x.tar']);
  });

  it.skipIf(!posix)('does not unpack an archive that holds a hard link', async () => {
    await omar.invoke('file:save', 'local', 'h.tar', tarWithLink('second-name', secret, true));
    await expect(omar.invoke('archive:extract', 'local', 'h.tar')).rejects.toThrow(/holds a hard link/);
    expect((await fs.readdir(sandbox)).sort()).toEqual(['h.tar']);
  });

  it.skipIf(!posix)('does not unpack a zip that holds a symbolic link', async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'zip-with-link-'));
    try {
      await fs.symlink(kit.dataDir, path.join(work, 'esc'));
      await fs.writeFile(path.join(work, 'plain.txt'), 'plain');
      // -y stores the link itself instead of what it points at.
      execFileSync('zip', ['-y', '-q', path.join(sandbox, 'z.zip'), 'esc', 'plain.txt'], { cwd: work });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
    await expect(omar.invoke('archive:extract', 'local', 'z.zip')).rejects.toThrow(/holds a link to another place/);
    expect((await fs.readdir(sandbox)).sort()).toEqual(['z.zip']);
  });

  it('still packs and unpacks ordinary files', async () => {
    await omar.invoke('storage:create-folder', 'local', 'docs');
    await omar.invoke('file:save', 'local', 'docs/a.txt', 'alpha');
    const archive = await omar.invoke('archive:compress', 'local', '', ['docs'], 'tar.gz');
    expect(archive).toBe('docs.tar.gz');
    const folder = await omar.invoke('archive:extract', 'local', 'docs.tar.gz');
    expect(await fs.readFile(path.join(sandbox, String(folder), 'docs', 'a.txt'), 'utf8')).toBe('alpha');
  });

  it.skipIf(!posix)('does not follow a link that is in the folder anyway', async () => {
    // However it got there (an older version unpacked it, a tool this did not foresee): it leads nowhere for a client.
    await fs.symlink(kit.dataDir, path.join(sandbox, 'esc'));
    await fs.symlink(secret, path.join(sandbox, 'secret-link.txt'));
    await fs.symlink(path.join(kit.dataDir, 'not-there-yet.txt'), path.join(sandbox, 'dangling'));

    await expect(omar.invoke('storage:list', 'local', 'esc')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('file:read', 'local', 'esc/server-secret.txt')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('file:read', 'local', 'secret-link.txt')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('storage:stat', 'local', 'secret-link.txt')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('file:save', 'local', 'esc/written-by-member.txt', 'hello')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('file:save', 'local', 'dangling', 'hello')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('storage:create-folder', 'local', 'esc/made-by-member')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('storage:rename', 'local', 'esc/server-secret.txt', 'mine.txt')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('storage:chmod', 'local', 'secret-link.txt', '777')).rejects.toThrow(/outside the allowed base directory/);
    // A copy is refused at once, before anything is queued: the source cannot be looked at.
    await expect(omar.invoke('transfer:add', { sourceProviderId: 'local', sourcePath: 'secret-link.txt', targetProviderId: 'local', targetPath: 'copy.txt' })).rejects.toThrow(
      /Cannot copy "secret-link.txt": .*outside the allowed base directory/,
    );
    expect(await omar.invoke('transfer:get-jobs')).toEqual([]);
    expect(await fs.readFile(path.join(sandbox, 'copy.txt'), 'utf8').catch(() => '')).not.toContain('SERVER-ONLY-SECRET');
    expect(fssync.existsSync(path.join(kit.dataDir, 'written-by-member.txt'))).toBe(false);
    expect(fssync.existsSync(path.join(kit.dataDir, 'not-there-yet.txt'))).toBe(false);
    expect(fssync.existsSync(path.join(kit.dataDir, 'made-by-member'))).toBe(false);
    expect(await fs.readFile(secret, 'utf8')).toBe('SERVER-ONLY-SECRET\n');

    // The listing shows them as links and says nothing about what they point at.
    const listing = (await omar.invoke('storage:list', 'local', '')) as Array<{ name: string; isSymlink?: boolean; isDirectory: boolean; size: number }>;
    const esc = listing.find((e) => e.name === 'esc')!;
    const link = listing.find((e) => e.name === 'secret-link.txt')!;
    expect(esc).toMatchObject({ isSymlink: true, isDirectory: false, size: 0 });
    expect(link).toMatchObject({ isSymlink: true, size: 0 });

    // Search does not read through them either.
    const preview = omar.invoke('search:preview', 'local', 'secret-link.txt', 1, 1);
    await expect(preview).rejects.toThrow();
  });

  it.skipIf(!posix)('removes links that an unpacking tool left behind, and only those', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unpacked-'));
    try {
      await fs.mkdir(path.join(dir, 'sub'));
      await fs.writeFile(path.join(dir, 'plain.txt'), 'plain');
      await fs.symlink(secret, path.join(dir, 'sub', 'link'));
      // A second name for a file outside the folder.
      await fs.link(secret, path.join(dir, 'sub', 'hard'));
      // Two names for one file, both inside the folder: an ordinary archive may hold that.
      await fs.writeFile(path.join(dir, 'twin-a'), 'twin');
      await fs.link(path.join(dir, 'twin-a'), path.join(dir, 'twin-b'));
      await removeLinksUnder(dir);
      expect((await fs.readdir(dir)).sort()).toEqual(['plain.txt', 'sub', 'twin-a', 'twin-b']);
      expect(await fs.readdir(path.join(dir, 'sub'))).toEqual([]);
      expect(await fs.readFile(secret, 'utf8')).toBe('SERVER-ONLY-SECRET\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('what decides whether an archive is unpacked into an account\'s folder', () => {
  it('refuses links and names that leave the folder, in the listings of tar and zipinfo', () => {
    const plain = '-rw-r--r-- root/root 5 2026-01-01 00:00 a.txt\ndrwxr-xr-x root/root 0 2026-01-01 00:00 dir/\n';
    expect(archiveRefusal('a.txt\ndir/\n', plain)).toBeUndefined();
    expect(archiveRefusal('esc\n', 'lrwxrwxrwx root/root 0 2026-01-01 00:00 esc -> /etc\n')).toMatch(/link to another place/);
    expect(archiveRefusal('esc\n', 'lrwxrwxrwx  0 root root 0 Jan  1 00:00 esc -> /etc\n')).toMatch(/link to another place/);
    expect(archiveRefusal('b\n', 'hrw-r--r-- root/root 0 2026-01-01 00:00 b link to a\n')).toMatch(/hard link/);
    // zipinfo: a header line, then one line per member.
    expect(archiveRefusal('esc\n', 'Archive:  z.zip\nZip file size: 300 bytes, number of entries: 1\nlrwxrwxrwx  3.0 unx        4 bx stor 26-Jan-01 00:00 esc\n1 file\n')).toMatch(/link to another place/);
    expect(archiveRefusal('../up.txt\n', '-rw-r--r-- root/root 5 2026-01-01 00:00 ../up.txt\n')).toMatch(/outside its folder/);
    expect(archiveRefusal('a/../../up.txt\n', plain)).toMatch(/outside its folder/);
    expect(archiveRefusal('/etc/cron.d/x\n', plain)).toMatch(/outside its folder/);
    expect(archiveRefusal('C:\\Windows\\x\n', plain)).toMatch(/outside its folder/);
    // Two dots inside a name are a name, not a way up.
    expect(archiveRefusal('notes..txt\n..hidden\n', plain)).toBeUndefined();
    // A file whose name looks like a listing line makes nothing pass that should not.
    expect(archiveRefusal('lrwxrwxrwx fake\n', '-rw-r--r-- root/root 5 2026-01-01 00:00 lrwxrwxrwx fake\n')).toBeUndefined();
  });
});

describe('where a path really is', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'real-location-')));
    await fs.mkdir(path.join(dir, 'root', 'inner'), { recursive: true });
    await fs.mkdir(path.join(dir, 'outside'));
    await fs.writeFile(path.join(dir, 'outside', 'secret'), 's');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('follows links in every part of the path, also when the last parts do not exist yet', async () => {
    const root = path.join(dir, 'root');
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'inner', 'new', 'file.txt'))).toBe(true);
    expect(realLocation(path.join(root, 'inner', 'new', 'file.txt'))).toBe(path.join(root, 'inner', 'new', 'file.txt'));
    expect(isInside(root, path.join(dir, 'outside', 'secret'))).toBe(false);
    expect(isInside(root, path.join(dir, 'rootx'))).toBe(false);
    if (!posix) return;
    await fs.symlink(path.join(dir, 'outside'), path.join(root, 'way-out'));
    await fs.symlink(path.join(dir, 'outside', 'nothing-here'), path.join(root, 'dangling'));
    await fs.symlink(path.join(root, 'inner'), path.join(root, 'way-in'));
    expect(isInside(root, path.join(root, 'way-out'))).toBe(false);
    expect(isInside(root, path.join(root, 'way-out', 'secret'))).toBe(false);
    expect(isInside(root, path.join(root, 'way-out', 'new-file'))).toBe(false);
    // A link that points at nothing yet: a write would make its target, outside.
    expect(isInside(root, path.join(root, 'dangling'))).toBe(false);
    // A link that stays inside is fine.
    expect(isInside(root, path.join(root, 'way-in', 'x'))).toBe(true);
    // A root that is itself reached through a link still holds what is in it.
    await fs.symlink(root, path.join(dir, 'root-link'));
    expect(isInside(path.join(dir, 'root-link'), path.join(root, 'inner'))).toBe(true);
  });

  it.skipIf(!posix)('the desktop app follows links as before: only a confined provider checks them', async () => {
    const root = path.join(dir, 'root');
    await fs.symlink(path.join(dir, 'outside'), path.join(root, 'way-out'));
    const desktop = new LocalStorageProvider({ basePath: root });
    expect(desktop.confined).toBe(false);
    expect((await desktop.readFile('way-out/secret')).toString()).toBe('s');
    expect(await desktop.getHomeDir()).toBe(os.homedir());
    const account = new LocalStorageProvider({ basePath: root, confined: true });
    await expect(account.readFile('way-out/secret')).rejects.toThrow(/outside the allowed base directory/);
    expect(await account.getHomeDir()).toBe(root);
    expect(await account.listVolumes()).toEqual([]);
  });
});
