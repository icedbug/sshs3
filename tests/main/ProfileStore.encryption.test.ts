import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { mockEncryptString, mockDecryptString, mockIsEncryptionAvailable } = vi.hoisted(() => {
  return {
    mockEncryptString: vi.fn((value: string) => Buffer.from(`cipher:${value}`, 'utf-8')),
    mockDecryptString: vi.fn((buf: Buffer) => buf.toString('utf-8').replace(/^cipher:/, '')),
    mockIsEncryptionAvailable: vi.fn().mockReturnValue(true),
  };
});

vi.mock('electron', () => {
  const mockObj = {
    app: {
      getPath: vi.fn().mockReturnValue('/tmp/user-data'),
    },
    safeStorage: {
      isEncryptionAvailable: mockIsEncryptionAvailable,
      encryptString: mockEncryptString,
      decryptString: mockDecryptString,
    },
  };
  return { ...mockObj, default: mockObj };
});

import { ProfileStore } from '../../src/main/profile/ProfileStore';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

describe('ProfileStore encryption', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    mockIsEncryptionAvailable.mockReturnValue(true);
    mockEncryptString.mockClear();
    mockDecryptString.mockReset();
    mockDecryptString.mockImplementation((buf: Buffer) => buf.toString('utf-8').replace(/^cipher:/, ''));
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-profiles-enc-test-'));
    storePath = path.join(tempDir, 'profiles.json');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('keeps undecryptable ciphertext on disk when another mutation persists while the keyring is unavailable', async () => {
    const store = new ProfileStore(storePath);
    await store.saveSSH({
      id: 'ssh-1',
      name: 'Prod',
      host: 'prod.example.com',
      username: 'admin',
      authType: 'password',
      password: 'super-secret',
    });
    const before = JSON.parse(await fs.readFile(storePath, 'utf-8')).ssh[0].password;

    mockIsEncryptionAvailable.mockReturnValue(false);
    await store.saveFolder('Work');
    const after = JSON.parse(await fs.readFile(storePath, 'utf-8')).ssh[0].password;
    expect(after).toBe(before);

    mockIsEncryptionAvailable.mockReturnValue(true);
    expect((await store.getProfiles()).ssh[0].password).toBe('super-secret');
  });

  describe('countUndecryptableSecrets', () => {
    async function seed(store: ProfileStore) {
      await store.saveSSH({
        id: 'ssh-1',
        name: 'Prod',
        host: 'prod.example.com',
        username: 'admin',
        authType: 'password',
        password: 'super-secret',
        passphrase: 'key-phrase',
      });
      await store.saveS3({
        id: 's3-1',
        name: 'MinIO',
        accessKeyId: 'AKIA',
        secretAccessKey: 'fixture-key-value', // pragma: allowlist secret
        endpoint: 'https://minio.example.com',
        region: 'us-east-1',
      } as S3Config);
      await store.saveSSH({
        id: 'ssh-2',
        name: 'Plain key login',
        host: 'dev.example.com',
        username: 'dev',
        authType: 'agent',
      });
    }

    it('is 0 while every secret still decrypts', async () => {
      const store = new ProfileStore(storePath);
      await seed(store);
      expect(await store.countUndecryptableSecrets()).toBe(0);
    });

    it('counts each encrypted secret that can no longer be decrypted (the keyring key was replaced)', async () => {
      const store = new ProfileStore(storePath);
      await seed(store);

      mockDecryptString.mockImplementation(() => {
        throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      });
      // password + passphrase + S3 secret; the profile without secrets adds nothing
      expect(await store.countUndecryptableSecrets()).toBe(3);

      // The ciphertext is still on disk, untouched: counting never rewrites the file
      const raw = JSON.parse(await fs.readFile(storePath, 'utf-8'));
      expect(raw.ssh[0].password).toMatch(/^enc:v1:/);
    });

    it('counts everything when no keyring is available at all, and ignores deleted profiles', async () => {
      const store = new ProfileStore(storePath);
      await seed(store);
      await store.deleteS3('s3-1');

      mockIsEncryptionAvailable.mockReturnValue(false);
      expect(await store.countUndecryptableSecrets()).toBe(2);
    });

    it('is 0 for a missing profiles file', async () => {
      expect(await new ProfileStore(storePath).countUndecryptableSecrets()).toBe(0);
    });
  });

  it('copies an unparsable profiles.json aside before overwriting it', async () => {
    await fs.writeFile(storePath, '{ not json', 'utf-8');
    const store = new ProfileStore(storePath);
    await store.saveFolder('Work');
    expect(await fs.readFile(`${storePath}.corrupt`, 'utf-8')).toBe('{ not json');
  });

  it('stores SSH password/passphrase encrypted on disk and decrypts on read', async () => {
    const store = new ProfileStore(storePath);
    const config: SSHConnectionConfig = {
      id: 'ssh-1',
      name: 'Prod',
      host: 'prod.example.com',
      username: 'admin',
      authType: 'password',
      password: 'super-secret',
      passphrase: 'key-phrase',
    };
    await store.saveSSH(config);

    const raw = await fs.readFile(storePath, 'utf-8');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('key-phrase');
    expect(raw).toContain('enc:v1:');
    expect(mockEncryptString).toHaveBeenCalledWith('super-secret');
    expect(mockEncryptString).toHaveBeenCalledWith('key-phrase');

    const profiles = await store.getProfiles();
    expect(profiles.ssh[0].password).toBe('super-secret');
    expect(profiles.ssh[0].passphrase).toBe('key-phrase');
    // Non-secret fields are untouched / stored in plaintext.
    expect(raw).toContain('prod.example.com');
  });

  it('stores S3 secretAccessKey/sessionToken encrypted on disk and decrypts on read', async () => {
    const store = new ProfileStore(storePath);
    const config: S3Config = {
      id: 's3-1',
      name: 'Backup',
      region: 'us-east-1',
      accessKeyId: 'AKIA_PLAINTEXT_OK',
      secretAccessKey: 'super-secret-key',
      sessionToken: 'temp-token',
    };
    await store.saveS3(config);

    const raw = await fs.readFile(storePath, 'utf-8');
    expect(raw).not.toContain('super-secret-key');
    expect(raw).not.toContain('temp-token');
    expect(raw).toContain('AKIA_PLAINTEXT_OK');

    const profiles = await store.getProfiles();
    expect(profiles.s3[0].secretAccessKey).toBe('super-secret-key');
    expect(profiles.s3[0].sessionToken).toBe('temp-token');
  });

  it('falls back to plaintext when OS encryption is unavailable, without losing data', async () => {
    mockIsEncryptionAvailable.mockReturnValue(false);
    const store = new ProfileStore(storePath);
    const config: SSHConnectionConfig = {
      id: 'ssh-2',
      name: 'NoKeyring',
      host: 'h',
      username: 'u',
      authType: 'password',
      password: 'plain-fallback',
    };
    await store.saveSSH(config);

    expect(mockEncryptString).not.toHaveBeenCalled();
    const profiles = await store.getProfiles();
    expect(profiles.ssh[0].password).toBe('plain-fallback');
  });

  it('reads legacy plaintext profiles.json written before encryption was added', async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify({
        ssh: [
          {
            id: 'legacy-1',
            name: 'Legacy',
            host: 'legacy.example.com',
            username: 'root',
            authType: 'password',
            password: 'old-plaintext-password',
          },
        ],
        s3: [],
      }),
      'utf-8'
    );

    const store = new ProfileStore(storePath);
    const profiles = await store.getProfiles();
    expect(profiles.ssh[0].password).toBe('old-plaintext-password');
  });

  it('stores proxy password encrypted on disk and decrypts on read', async () => {
    const store = new ProfileStore(storePath);
    const config: SSHConnectionConfig = {
      id: 'ssh-proxy',
      name: 'Proxy SSH',
      host: 'proxy.example.com',
      username: 'user',
      authType: 'password',
      password: 'ssh-password',
      proxy: {
        enabled: true,
        type: 'socks5',
        host: '10.0.0.1',
        port: 1080,
        username: 'proxyuser',
        password: 'proxy-secret-password',
      },
    };
    await store.saveSSH(config);

    const raw = await fs.readFile(storePath, 'utf-8');
    expect(raw).not.toContain('proxy-secret-password');
    expect(mockEncryptString).toHaveBeenCalledWith('proxy-secret-password');

    const profiles = await store.getProfiles();
    expect(profiles.ssh[0].proxy?.password).toBe('proxy-secret-password');
    expect(profiles.ssh[0].proxy?.username).toBe('proxyuser');
  });
});
