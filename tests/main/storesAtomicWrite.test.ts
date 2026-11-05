import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => {
  const mockObj = {
    app: { getPath: vi.fn().mockReturnValue('/tmp/user-data-unused') },
    safeStorage: { isEncryptionAvailable: vi.fn().mockReturnValue(false), encryptString: vi.fn(), decryptString: vi.fn() },
  };
  return { ...mockObj, default: mockObj };
});

import { SettingsStore } from '../../src/main/settings/SettingsStore';
import { ProfileStore } from '../../src/main/profile/ProfileStore';
import { SyncConfigStore } from '../../src/main/services/SyncConfigStore';
import { DirectorySyncProfileStore } from '../../src/main/dirsync/DirectorySyncProfileStore';

// M5 (code review 2026-11-03): the stores rewrote their file in place with writeFile, so a reader (or a crash)
// could see a truncated file, which then read as "empty". A file that was already open before the save must keep
// its complete old content, which only holds when the save replaces the file by rename.
describe.skipIf(process.platform === 'win32')('config stores replace their file instead of rewriting it', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stores-atomic-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function expectOldFileSurvivesSave(file: string, save: () => Promise<unknown>) {
    const before = await fs.readFile(file, 'utf-8');
    const openOld = await fs.open(file, 'r');
    try {
      await save();
      expect(await openOld.readFile('utf-8')).toBe(before);
      expect(await fs.readFile(file, 'utf-8')).not.toBe(before);
      expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toBeTruthy();
      expect((await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    } finally {
      await openOld.close();
    }
  }

  it('SettingsStore', async () => {
    const file = path.join(dir, 'settings.json');
    const store = new SettingsStore(file);
    await store.saveSettings({ fontSize: 14 } as never);
    await expectOldFileSurvivesSave(file, () => store.saveSettings({ fontSize: 16 } as never));
  });

  it('ProfileStore', async () => {
    const file = path.join(dir, 'profiles.json');
    const store = new ProfileStore(file);
    await store.replaceAll({ ssh: [], s3: [], folders: [{ id: 'f1', name: 'one' }] } as never);
    await expectOldFileSurvivesSave(file, () => store.replaceAll({ ssh: [], s3: [], folders: [{ id: 'f2', name: 'two' }] } as never));
  });

  it('SyncConfigStore', async () => {
    const file = path.join(dir, 'sync-config.json');
    const store = new SyncConfigStore(file);
    await store.setLastSyncAt('2026-11-03T10:00:00.000Z');
    await expectOldFileSurvivesSave(file, () => store.setLastSyncAt('2026-11-03T11:00:00.000Z'));
  });

  it('DirectorySyncProfileStore', async () => {
    const file = path.join(dir, 'dirsync.json');
    const store = new DirectorySyncProfileStore(file);
    const profile = (id: string) => ({ id, name: id, source: { providerConfigRef: 'local', path: '/a' }, target: { providerConfigRef: 'local', path: '/b' }, deleteExtraneous: false, createdAt: 'x', updatedAt: 'x' });
    await store.replaceAll([profile('one')] as never);
    await expectOldFileSurvivesSave(file, () => store.replaceAll([profile('two')] as never));
  });

  it('keeps a copy of an unparsable file as .corrupt before falling back to defaults', async () => {
    const settingsFile = path.join(dir, 'settings.json');
    await fs.writeFile(settingsFile, '{"fontSize": 1');
    await new SettingsStore(settingsFile).getSettings();
    expect(await fs.readFile(`${settingsFile}.corrupt`, 'utf-8')).toBe('{"fontSize": 1');

    const dirsyncFile = path.join(dir, 'dirsync.json');
    await fs.writeFile(dirsyncFile, '{"profiles": [');
    expect(await new DirectorySyncProfileStore(dirsyncFile).listIncludingTombstones()).toEqual([]);
    expect(await fs.readFile(`${dirsyncFile}.corrupt`, 'utf-8')).toBe('{"profiles": [');
  });
});
