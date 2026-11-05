import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { SettingsStore } from '../../src/main/settings/SettingsStore';
import { DEFAULT_SETTINGS } from '../../src/shared/types/settings';

describe('SettingsStore', () => {
  let tempDir: string;
  let settingsFile: string;
  let store: SettingsStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-settings-test-'));
    settingsFile = path.join(tempDir, 'settings.json');
    store = new SettingsStore(settingsFile);
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('returns default settings when file does not exist', async () => {
    const settings = await store.getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('drops a saved copyLastOutput binding that is still the superseded default', async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({ shortcuts: { newTerminal: 'Ctrl+Alt+T', copyLastOutput: 'Ctrl+Shift+G', snippets: 'Ctrl+Alt+S' } })
    );
    const { shortcuts } = await store.getSettings();
    expect(shortcuts).toEqual({ newTerminal: 'Ctrl+Alt+T', snippets: 'Ctrl+Alt+S' });
  });

  it('drops saved bindings that are still a superseded default which collided with TUIs', async () => {
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        shortcuts: { closeTab: 'Ctrl+W', copyLastOutput: 'Alt+C', rerunWithSudo: 'Alt+S', newRemoteFileManager: 'Ctrl+Shift+Alt+F', snippets: 'Ctrl+Shift+L' },
      })
    );
    expect((await store.getSettings()).shortcuts).toEqual({ snippets: 'Ctrl+Shift+L' });
  });

  it('keeps a copyLastOutput binding the user chose themselves', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ shortcuts: { copyLastOutput: 'Alt+Y' } }));
    expect((await store.getSettings()).shortcuts).toEqual({ copyLastOutput: 'Alt+Y' });
  });

  it('saves partial settings and updates values while retaining defaults', async () => {
    await store.saveSettings({ theme: 'light', terminalFontSize: 16 });
    const settings = await store.getSettings();

    expect(settings.theme).toBe('light');
    expect(settings.terminalFontSize).toBe(16);
    expect(settings.terminalFontFamily).toBe(DEFAULT_SETTINGS.terminalFontFamily);
    expect(settings.defaultNewTabType).toBe(DEFAULT_SETTINGS.defaultNewTabType);
  });

  it('updates defaultNewTabType setting', async () => {
    await store.saveSettings({ defaultNewTabType: 'filemanager' });
    const settings = await store.getSettings();

    expect(settings.defaultNewTabType).toBe('filemanager');
  });

  describe('setTeamVaultTabVisible', () => {
    it('sets one vaultId entry in connectionManagerVisibleTeamVaults without touching others', async () => {
      await store.setTeamVaultTabVisible('vlt_a', false);
      await store.setTeamVaultTabVisible('vlt_b', true);
      const settings = await store.getSettings();
      expect(settings.connectionManagerVisibleTeamVaults).toEqual({ vlt_a: false, vlt_b: true });
    });

    it('never clobbers another team\'s entry even when two calls race on a stale read — the whole point of this atomic method over a renderer-side get/mutate/save round trip', async () => {
      // Seed one existing entry first, same as if a prior session had already toggled it.
      await store.setTeamVaultTabVisible('vlt_existing', true);

      // Two "concurrent" toggles for two different teams, fired without awaiting either first —
      // a plain settingsGet() -> mutate -> settingsSave() renderer round trip would have both
      // read the same pre-toggle snapshot and the second save to land would silently drop the
      // first toggle's change. This method's own internal queueMutation must serialize the two
      // read-modify-writes instead.
      await Promise.all([store.setTeamVaultTabVisible('vlt_a', false), store.setTeamVaultTabVisible('vlt_b', true)]);

      const settings = await store.getSettings();
      expect(settings.connectionManagerVisibleTeamVaults).toEqual({
        vlt_existing: true,
        vlt_a: false,
        vlt_b: true,
      });
    });

    it('leaves every other setting untouched', async () => {
      await store.saveSettings({ theme: 'light' });
      await store.setTeamVaultTabVisible('vlt_a', false);
      const settings = await store.getSettings();
      expect(settings.theme).toBe('light');
    });
  });
});

describe('SettingsStore with a machine policy', () => {
  let tempDir: string;
  let settingsFile: string;
  const policy = { settings: { autoCheckUpdates: false }, features: {} } as const;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-settings-policy-'));
    settingsFile = path.join(tempDir, 'settings.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns the policy value but keeps the stored one for sync', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ autoCheckUpdates: true }));
    const store = new SettingsStore(settingsFile, policy);
    expect((await store.getSettings()).autoCheckUpdates).toBe(false);
    expect((await store.getStoredSettings()).autoCheckUpdates).toBe(true);
  });

  it('never writes a managed value to disk, so removing the policy restores the user choice', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ autoCheckUpdates: true }));
    const managed = new SettingsStore(settingsFile, policy);
    const saved = await managed.saveSettings({ autoCheckUpdates: true, theme: 'light' });
    expect(saved.autoCheckUpdates).toBe(false);
    await managed.setTeamVaultTabVisible('v1', true);
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf-8'));
    expect(onDisk.autoCheckUpdates).toBe(true);
    expect(onDisk.theme).toBe('light');
    expect((await new SettingsStore(settingsFile).getSettings()).autoCheckUpdates).toBe(true);
  });

  it('stores a synced value for a managed key when sync writes back, but never the policy value', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ autoCheckUpdates: true }));
    const store = new SettingsStore(settingsFile, policy);
    const stamp = '2026-10-25T12:00:00.000Z';
    await store.saveSettings({ autoCheckUpdates: true, theme: 'light', updatedAt: stamp }, { preserveTimestamp: true });
    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf-8'));
    expect(onDisk).toMatchObject({ autoCheckUpdates: true, theme: 'light', updatedAt: stamp });
    expect((await store.getSettings()).autoCheckUpdates).toBe(false);
  });

  it('does not let a save try to change a locked value', async () => {
    await fs.writeFile(settingsFile, JSON.stringify({ autoCheckUpdates: true }));
    const store = new SettingsStore(settingsFile, policy);
    await store.saveSettings({ autoCheckUpdates: false });
    expect(JSON.parse(await fs.readFile(settingsFile, 'utf-8')).autoCheckUpdates).toBe(true);
  });
});
