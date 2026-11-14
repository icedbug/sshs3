import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebAuthService, restrictPrivateKeyFile } from '../../src/main/web/WebAuthService';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The access entries icacls lists for a file: one per line, without the file's own path. */
function accessEntries(file: string): string[] {
  const out = execFileSync('icacls', [file], { encoding: 'utf8' });
  return out
    .split(/\r?\n/)
    .map((line) => line.replace(file, '').trim())
    .filter((line) => /:\(/.test(line));
}

describe('private key files of the web build', () => {
  it('asks Windows for an access list of the running account alone, and nothing elsewhere', () => {
    const run = vi.fn();
    expect(restrictPrivateKeyFile('/keys/id_ed25519', 'linux', run)).toBe(true);
    expect(run).not.toHaveBeenCalled();

    expect(restrictPrivateKeyFile('C:\\keys\\id_ed25519', 'win32', run)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0] as [string, string[]];
    expect(command).toBe('icacls');
    expect(args.slice(0, 3)).toEqual(['C:\\keys\\id_ed25519', '/inheritance:r', '/grant:r']);
    expect(args[3]).toMatch(new RegExp(`${os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:F$`));

    // An account that cannot be named with its domain is named without it; when neither works, it says so.
    const picky = vi.fn((_command: string, a: string[]) => {
      if (a[3].includes('\\')) throw new Error('No mapping between account names and security IDs was done.');
    });
    const before = process.env.USERDOMAIN;
    process.env.USERDOMAIN = 'WORKGROUP';
    try {
      expect(restrictPrivateKeyFile('C:\\keys\\id_ed25519', 'win32', picky)).toBe(true);
      expect(picky).toHaveBeenCalledTimes(2);
      expect(restrictPrivateKeyFile('C:\\keys\\id_ed25519', 'win32', () => { throw new Error('no icacls'); })).toBe(false);
    } finally {
      if (before === undefined) delete process.env.USERDOMAIN;
      else process.env.USERDOMAIN = before;
    }
  });

  it.runIf(process.platform === 'win32')('writes an account\'s key so that only the running account can read it (ssh.exe refuses any other)', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-web-key-'));
    dirs.push(dataDir);
    const auth = new WebAuthService(dataDir);
    const me = os.userInfo().username.toLowerCase();
    const onlyMine = (file: string) => {
      const entries = accessEntries(file);
      expect(entries).toHaveLength(1);
      expect(entries[0].toLowerCase()).toContain(`${me}:`);
      expect(entries[0]).not.toContain('(I)');
    };

    const made = await auth.ensureUserSshKey('user-1', 'sara');
    onlyMine(made.privateKeyPath);

    // A key file from before this was done (it inherits the folder's access list) is put right when next asked for.
    const old = auth.getUserPrivateKeyPath('user-2');
    await fs.mkdir(path.dirname(old), { recursive: true });
    await fs.copyFile(made.privateKeyPath, old);
    execFileSync('icacls', [old, '/reset'], { stdio: 'ignore' });
    await fs.writeFile(auth.getUserPublicKeyPath('user-2'), `${made.publicKey}\n`);
    expect(accessEntries(old).some((entry) => entry.includes('(I)'))).toBe(true);
    await auth.ensureUserSshKey('user-2', 'erik');
    onlyMine(old);

    // An imported key is restricted too.
    const pem = await fs.readFile(made.privateKeyPath, 'utf8');
    const imported = await auth.importUserSshKey('user-3', pem, made.publicKey);
    onlyMine(imported.privateKeyPath);

    // So is the key that opens every secret the server stores.
    const { setWebDataDir, safeStorage } = await import('../../src/main/web/electronShim');
    const before = process.env.SSHS3_MASTER_KEY;
    delete process.env.SSHS3_MASTER_KEY;
    try {
      setWebDataDir(dataDir);
      safeStorage.encryptString('x');
      onlyMine(path.join(dataDir, 'server-master.key'));
    } finally {
      if (before !== undefined) process.env.SSHS3_MASTER_KEY = before;
    }
  });
});
