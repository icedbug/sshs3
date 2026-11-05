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
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data') },
    safeStorage: {
      isEncryptionAvailable: mockIsEncryptionAvailable,
      encryptString: mockEncryptString,
      decryptString: mockDecryptString,
    },
  };
  return { ...mockObj, default: mockObj };
});

import { SyncConfigStore } from '../../src/main/services/SyncConfigStore';
import type { StorageConnectConfig } from '../../src/shared/types/ipc';

describe('SyncConfigStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    mockIsEncryptionAvailable.mockReturnValue(true);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-sync-config-test-'));
    storePath = path.join(tempDir, 'sync-config.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns an empty config when no file exists yet', async () => {
    const store = new SyncConfigStore(storePath);
    expect(await store.getConfig()).toEqual({});
  });

  it('encrypts the sync target credentials at rest and decrypts them on read', async () => {
    const store = new SyncConfigStore(storePath);
    const target: StorageConnectConfig = {
      id: 'sync-target',
      name: 'My Sync Bucket',
      type: 's3',
      s3Config: { id: 'sync-target', name: 'My Sync Bucket', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'top-secret' },
    };
    await store.setTarget(target);

    const raw = await fs.readFile(storePath, 'utf-8');
    expect(raw).not.toContain('top-secret');

    const config = await store.getConfig();
    expect(config.target?.s3Config?.secretAccessKey).toBe('top-secret');
    expect(config.target?.s3Config?.accessKeyId).toBe('AKIA');
  });

  it('keeps target secrets it cannot decrypt when an unrelated field is saved with the keyring unavailable', async () => {
    const store = new SyncConfigStore(storePath);
    await store.setTarget({
      id: 'sync-target',
      name: 'My Sync Bucket',
      type: 's3',
      s3Config: { id: 'sync-target', name: 'My Sync Bucket', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'top-secret' },
    });

    mockIsEncryptionAvailable.mockReturnValue(false);
    expect((await store.getConfig()).target?.s3Config?.secretAccessKey).toBe('');
    await store.setLastSyncAt('2026-10-27 20:00');

    mockIsEncryptionAvailable.mockReturnValue(true);
    const config = await store.getConfig();
    expect(config.lastSyncAt).toBe('2026-10-27 20:00');
    expect(config.target?.s3Config?.secretAccessKey).toBe('top-secret');
  });

  it('copies an unparsable config file aside instead of silently discarding it', async () => {
    await fs.writeFile(storePath, '{"target": {', 'utf-8');
    const store = new SyncConfigStore(storePath);
    await store.setTarget({
      id: 't',
      name: 'T',
      type: 's3',
      s3Config: { id: 't', name: 'T', region: 'us-east-1', accessKeyId: 'A', secretAccessKey: 's' },
    });
    expect(await fs.readFile(`${storePath}.corrupt`, 'utf-8')).toBe('{"target": {');
  });

  it('persists salts independently without clobbering the other one', async () => {
    const store = new SyncConfigStore(storePath);
    const topologySalt = Buffer.from('topology-salt-bytes');
    await store.setSalts({ topologySalt });

    let config = await store.getConfig();
    expect(config.topologySaltBase64).toBe(topologySalt.toString('base64'));
    expect(config.credentialsSaltBase64).toBeUndefined();

    const credentialsSalt = Buffer.from('credentials-salt-bytes');
    await store.setSalts({ credentialsSalt });

    config = await store.getConfig();
    expect(config.topologySaltBase64).toBe(topologySalt.toString('base64'));
    expect(config.credentialsSaltBase64).toBe(credentialsSalt.toString('base64'));
  });

  it('records the last successful sync timestamp', async () => {
    const store = new SyncConfigStore(storePath);
    await store.setLastSyncAt('2026-01-01T00:00:00.000Z');
    expect((await store.getConfig()).lastSyncAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('persists autoSync setting', async () => {
    const store = new SyncConfigStore(storePath);
    expect((await store.getConfig()).autoSync).toBeUndefined();
    await store.setAutoSync(true);
    expect((await store.getConfig()).autoSync).toBe(true);
    await store.setAutoSync(false);
    expect((await store.getConfig()).autoSync).toBe(false);
  });

  it('replaceTarget() swaps the location and drops the salts, last sync and auto-sync, but keeps the smartcard link', async () => {
    const store = new SyncConfigStore(storePath);
    const target = (host: string): StorageConnectConfig => ({
      id: 'sync', name: 'Sync', type: 'sftp', sftpConfig: { host, port: 22, username: 'u', authType: 'password', password: 'pw' } as any, // pragma: allowlist secret
    });
    await store.setTarget(target('old.example.com'), '/old');
    await store.setSalts({ topologySalt: Buffer.from('a'), credentialsSalt: Buffer.from('b') });
    await store.setLastSyncAt('2026-11-03T10:00:00.000Z');
    await store.setAutoSync(true);
    await store.setSmartcardSync({ pkcs11LibPath: '/lib/x.so' });

    await store.replaceTarget(target('new.example.com'), '/new');

    const config = await store.getConfig();
    expect(config.target?.sftpConfig?.host).toBe('new.example.com');
    expect(config.remoteBasePath).toBe('/new');
    expect(config.topologySaltBase64).toBeUndefined();
    expect(config.credentialsSaltBase64).toBeUndefined();
    expect(config.lastSyncAt).toBeUndefined();
    expect(config.autoSync).toBe(false);
    expect(config.smartcardSync?.pkcs11LibPath).toBe('/lib/x.so');
  });

  it('clear() resets the target, salts, and every other field for the "delete all sync data" action', async () => {
    const store = new SyncConfigStore(storePath);
    await store.setTarget({
      id: 'sync-target',
      name: 'My Sync Bucket',
      type: 's3',
      s3Config: { id: 'sync-target', name: 'My Sync Bucket', region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'top-secret' },
    });
    await store.setSalts({ topologySalt: Buffer.from('a'), credentialsSalt: Buffer.from('b') });
    await store.setLastSyncAt('2026-01-01T00:00:00.000Z');
    await store.setAutoSync(true);
    await store.setSmartcardSync({ pkcs11LibPath: '/usr/lib/opensc-pkcs11.so' });

    await store.clear();

    expect(await store.getConfig()).toEqual({});
  });
});
