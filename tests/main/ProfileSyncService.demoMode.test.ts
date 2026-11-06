import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => {
  const mockObj = {
    app: { getPath: () => path.join(os.tmpdir(), 'sshs3-profile-sync-mode-unused') },
    safeStorage: {
      isEncryptionAvailable: vi.fn().mockReturnValue(false),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
  };
  return { ...mockObj, default: mockObj };
});

import { setDemoModeForTesting } from '../../src/main/demo/demoMode';
import { ProfileSyncService } from '../../src/main/services/ProfileSyncService';
import type { IStorageProvider } from '../../src/shared/types/storage';

/**
 * ProfileSyncService's own remote entry points, the last line of defence behind IpcBridge: outside demo mode
 * they reach the sync target, in demo mode they are refused before it is touched. The sync target records
 * every call made on it.
 */

const PROFILE_SYNC_DISABLED = /Remote profile sync is disabled in demo mode/;
const SYNC_DIR = 'profile-sync/.sshs3';
const TOPOLOGY = `${SYNC_DIR}/topology.enc`;

afterEach(() => {
  setDemoModeForTesting(undefined);
});

/** A sync target holding `existing`, recording every call made on it as "<method> <path>". */
function syncTarget(existing: string[] = []) {
  const files = new Set(existing);
  const calls: string[] = [];
  const missing = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });
  const provider: IStorageProvider = {
    id: 'sshs3-remote-profile-sync',
    name: 'Profile sync bucket',
    type: 's3',
    list: async (dir) => {
      calls.push(`list ${dir}`);
      return [];
    },
    stat: async (key) => {
      calls.push(`stat ${key}`);
      if (!files.has(key)) throw missing(key);
      return { name: path.posix.basename(key), path: key, size: 64, isDirectory: false, mtime: '2026-01-01T00:00:00.000Z' };
    },
    createFolder: async (dir) => {
      calls.push(`createFolder ${dir}`);
    },
    delete: async (key) => {
      calls.push(`delete ${key}`);
      files.delete(key);
    },
    rename: async (from) => {
      calls.push(`rename ${from}`);
    },
    createReadStream: async (key) => {
      calls.push(`createReadStream ${key}`);
      throw missing(key);
    },
    createWriteStream: async (key) => {
      calls.push(`createWriteStream ${key}`);
      throw new Error('not used here');
    },
    readFile: async (key) => {
      calls.push(`readFile ${key}`);
      throw missing(key);
    },
    writeFile: async (key) => {
      calls.push(`writeFile ${key}`);
      files.add(key);
    },
  };
  return { provider, calls, files };
}

/** Only the remote side is exercised: the local stores and the crypto service are never reached here. */
function createService(): ProfileSyncService {
  const unused = {} as never;
  return new ProfileSyncService(unused, unused, unused, unused, {
    sshConfigPath: path.join(os.tmpdir(), 'sshs3-profile-sync-mode-unused', 'ssh_config'),
    knownHostsPath: path.join(os.tmpdir(), 'sshs3-profile-sync-mode-unused', 'known_hosts'),
  });
}

describe('ProfileSyncService remote entry points: outside demo mode against demo mode', () => {
  it('normal mode: asks the sync target whether another device already pushed to it', async () => {
    setDemoModeForTesting(false);
    const target = syncTarget([TOPOLOGY]);
    await expect(createService().hasRemoteData(target.provider, 'profile-sync')).resolves.toBe(true);
    expect(target.calls).toEqual([`stat ${TOPOLOGY}`]);
  });

  it('demo mode: refuses to ask, without touching the sync target', async () => {
    setDemoModeForTesting(true);
    const target = syncTarget([TOPOLOGY]);
    await expect(createService().hasRemoteData(target.provider, 'profile-sync')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    expect(target.calls).toEqual([]);
  });

  it('normal mode: resetting sync deletes the sync files on the target', async () => {
    setDemoModeForTesting(false);
    const target = syncTarget([TOPOLOGY]);
    await expect(createService().wipeRemote(target.provider, 'profile-sync')).resolves.toEqual({ deletedCount: 1, errors: [] });
    expect(target.calls).toContain(`stat ${TOPOLOGY}`);
    expect(target.calls).toContain(`delete ${TOPOLOGY}`);
    expect(target.calls).toContain(`delete ${SYNC_DIR}`);
    expect(target.files.has(TOPOLOGY)).toBe(false);
  });

  it('demo mode: push, pull, compare and reset are refused before the sync target is touched', async () => {
    setDemoModeForTesting(true);
    const target = syncTarget([TOPOLOGY]);
    const service = createService();

    await expect(service.pushToRemote(target.provider, 'profile-sync')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(service.pullFromRemote(target.provider, 'profile-sync')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(service.compareWithRemote(target.provider, 'profile-sync')).rejects.toThrow(PROFILE_SYNC_DISABLED);
    await expect(service.wipeRemote(target.provider, 'profile-sync')).rejects.toThrow(PROFILE_SYNC_DISABLED);

    expect(target.calls).toEqual([]);
    expect(target.files.has(TOPOLOGY)).toBe(true);
  });
});
