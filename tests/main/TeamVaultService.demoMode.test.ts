import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => {
  const mockObj = {
    app: { getPath: () => path.join(os.tmpdir(), 'sshs3-team-vault-mode-unused') },
    safeStorage: {
      isEncryptionAvailable: vi.fn().mockReturnValue(false),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
  };
  return { ...mockObj, default: mockObj };
});

import { setDemoModeForTesting } from '../../src/main/demo/demoMode';
import { TeamVaultService } from '../../src/main/services/TeamVaultService';
import type { IStorageProvider } from '../../src/shared/types/storage';

/**
 * TeamVaultService's remote entry points, which the Team Vault IPC handlers and the background auto-push and
 * auto-poll call: outside demo mode they reach the team's target, in demo mode they are refused before it is
 * touched. The target records every call made on it; it holds no vault, as for a team being joined.
 */

const VAULT_DISABLED = /Team Vault sync is disabled in demo mode/;
const VAULT_ID = 'vlt_team-ops';
const REMOTE_VAULT = `team/team-vault/${VAULT_ID}/vault.json`;

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  setDemoModeForTesting(undefined);
});

async function createService(): Promise<TeamVaultService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-vault-mode-'));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return new TeamVaultService({ baseDir: dir });
}

/** An empty team target, recording every call made on it as "<method> <path>". */
function emptyTarget() {
  const calls: string[] = [];
  const missing = (key: string) => Object.assign(new Error(`NoSuchKey: ${key}`), { name: 'NoSuchKey' });
  const provider: IStorageProvider = {
    id: 'team-vault-target',
    name: 'Team Vault bucket',
    type: 's3',
    list: async (dir) => {
      calls.push(`list ${dir}`);
      return [];
    },
    stat: async (key) => {
      calls.push(`stat ${key}`);
      throw missing(key);
    },
    createFolder: async (dir) => {
      calls.push(`createFolder ${dir}`);
    },
    delete: async (key) => {
      calls.push(`delete ${key}`);
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
    },
  };
  return { provider, calls };
}

describe('TeamVaultService remote entry points: outside demo mode against demo mode', () => {
  it('normal mode: looks for the vault on the team target when a member joins', async () => {
    setDemoModeForTesting(false);
    const service = await createService();
    const target = emptyTarget();
    await expect(service.hasRemoteVault(VAULT_ID, target.provider, 'team')).resolves.toBe(false);
    expect(target.calls).toEqual([`stat ${REMOTE_VAULT}`]);
  });

  it('normal mode: the auto-poll check and the sync preview look at the vault on the team target', async () => {
    setDemoModeForTesting(false);
    const service = await createService();
    const target = emptyTarget();
    await expect(service.hasRemoteChangedSinceLastSync(VAULT_ID, target.provider, 'team')).resolves.toBe(false);
    await expect(service.getSyncPreview(VAULT_ID, target.provider, 'team')).resolves.toEqual({
      hasUnpushedLocalChanges: false,
      remoteChanged: false,
    });
    expect(target.calls).toEqual([`stat ${REMOTE_VAULT}`, `stat ${REMOTE_VAULT}`]);
  });

  it('normal mode: a pull fetches the vault from the team target (and fails here, since there is none)', async () => {
    setDemoModeForTesting(false);
    const service = await createService();
    const target = emptyTarget();
    await expect(service.pullFromRemote(VAULT_ID, target.provider, 'team')).rejects.toThrow(/NoSuchKey/);
    expect(target.calls).toEqual([`stat ${REMOTE_VAULT}`]);
  });

  it('demo mode: joining, polling, previewing, pushing, pulling and merging never touch the team target', async () => {
    setDemoModeForTesting(true);
    const service = await createService();
    const target = emptyTarget();

    await expect(service.hasRemoteVault(VAULT_ID, target.provider, 'team')).rejects.toThrow(VAULT_DISABLED);
    await expect(service.hasRemoteChangedSinceLastSync(VAULT_ID, target.provider, 'team')).rejects.toThrow(VAULT_DISABLED);
    await expect(service.getSyncPreview(VAULT_ID, target.provider, 'team')).rejects.toThrow(VAULT_DISABLED);
    await expect(service.pushToRemote(VAULT_ID, target.provider, 'team')).rejects.toThrow(VAULT_DISABLED);
    await expect(service.pullFromRemote(VAULT_ID, target.provider, 'team')).rejects.toThrow(VAULT_DISABLED);
    await expect(service.mergeWithRemote(VAULT_ID, target.provider, 'team')).rejects.toThrow(VAULT_DISABLED);

    expect(target.calls).toEqual([]);
  });
});
