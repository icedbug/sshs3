import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitConfigService, literalSigningKey, signingKeyConfigValue } from '../../src/main/git/GitConfigService';

const ED = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHYVXCy7aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab';
const ECDSA = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBLpI3kvB7DVAhtdc0BAVfZoGrkDGqP9CY33B';
const SK = 'sk-ssh-ed25519@openssh.com AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29tAAAAIGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6MDEyMzQ1';

function gitAvailable(): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('literalSigningKey / signingKeyConfigValue', () => {
  it('finds the public key with or without the key:: marker, and ignores file paths', () => {
    expect(literalSigningKey(ED)).toBe(ED);
    expect(literalSigningKey(`key::${ECDSA}`)).toBe(ECDSA);
    expect(literalSigningKey(`  key:: ${SK}  `)).toBe(SK);
    expect(literalSigningKey('/home/alice/.ssh/id_ed25519.pub')).toBeNull();
    expect(literalSigningKey('~/.ssh/id_ecdsa.pub')).toBeNull();
    // A file whose name merely starts like a key type is still a path.
    expect(literalSigningKey('ecdsa-work.pub')).toBeNull();
    expect(literalSigningKey('ssh-keys/id.pub')).toBeNull();
    expect(literalSigningKey('sk-key')).toBeNull();
  });

  it('adds key:: for every literal key Git would otherwise read as a file name', () => {
    expect(signingKeyConfigValue(ED)).toBe(ED);
    expect(signingKeyConfigValue(ECDSA)).toBe(`key::${ECDSA}`);
    expect(signingKeyConfigValue(SK)).toBe(`key::${SK}`);
  });
});

// Runs the real git against a throw-away HOME and global config, never the user's own.
describe.skipIf(!gitAvailable())('GitConfigService.configureSigning with real git', () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-gitcfg-'));
    for (const name of ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) saved[name] = process.env[name];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(path.join(home, 'gitconfig'), { force: true });
    fs.rmSync(path.join(home, '.ssh'), { recursive: true, force: true });
  });

  const stored = () =>
    execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['config', '--global', '--get', 'user.signingkey'], {
      encoding: 'utf-8',
    }).trim();
  const allowedSigners = () => fs.readFileSync(path.join(home, '.ssh', 'allowed_signers'), 'utf-8');

  it('stores an ecdsa or security key with key::, which Git needs to read it as a key', async () => {
    for (const key of [ECDSA, SK]) {
      const res = await GitConfigService.configureSigning({ signingKey: key, email: 'a@example.com' });
      expect(res.success).toBe(true);
      expect(stored()).toBe(`key::${key}`);
      // The panel compares the configured key with the listed ones: it must see the bare key.
      expect((await GitConfigService.getSigningConfig()).signingKey).toBe(key);
      expect(allowedSigners()).toContain(`a@example.com namespaces="git" ${key}`);
    }
  });

  it('keeps an ssh- key as it was (Git reads those without a prefix)', async () => {
    await GitConfigService.configureSigning({ signingKey: ED, email: 'a@example.com' });
    expect(stored()).toBe(ED);
    expect(allowedSigners()).toContain(`a@example.com namespaces="git" ${ED}`);
  });

  it('accepts a key that already has the marker and still updates allowed_signers', async () => {
    const res = await GitConfigService.configureSigning({ signingKey: `key::${ECDSA}`, email: 'a@example.com' });
    expect(res.success).toBe(true);
    expect(res.allowedSignersUpdated).toBe(true);
    expect(stored()).toBe(`key::${ECDSA}`);
    expect(allowedSigners()).toContain(`a@example.com namespaces="git" ${ECDSA}`);
  });

  it('stores a file named like a key type unchanged, without a key:: prefix', async () => {
    const res = await GitConfigService.configureSigning({ signingKey: 'ecdsa-work.pub', email: 'a@example.com' });
    expect(res.success).toBe(true);
    expect(stored()).toBe('ecdsa-work.pub');
    expect(fs.existsSync(path.join(home, '.ssh', 'allowed_signers'))).toBe(false);
  });

  it('stores a key file path unchanged and leaves allowed_signers alone', async () => {
    const res = await GitConfigService.configureSigning({ signingKey: '~/.ssh/id_ecdsa.pub', email: 'a@example.com' });
    expect(res.success).toBe(true);
    expect(stored()).toBe('~/.ssh/id_ecdsa.pub');
    expect(fs.existsSync(path.join(home, '.ssh', 'allowed_signers'))).toBe(false);
  });
});
