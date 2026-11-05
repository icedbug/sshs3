import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types/settings';
import { mergeSavedSettings, settingsPatchFromForm } from '../../src/renderer/src/lib/settingsSave';

const settings = (over: Partial<AppSettings> = {}): AppSettings => ({ ...DEFAULT_SETTINGS, ...over });

describe('settingsPatchFromForm', () => {
  it('leaves out the settings that are written by their own IPC calls, keeps everything else', () => {
    const form = settings({
      terminalFontSize: 15,
      showHiddenFiles: true,
      connectionManagerVisibleTeamVaults: { 'vault-1': true },
      connectionManagerDefaultTab: 'vault-1',
    });
    const patch = settingsPatchFromForm(form);
    expect('connectionManagerVisibleTeamVaults' in patch).toBe(false);
    expect('connectionManagerDefaultTab' in patch).toBe(false);
    expect(patch.terminalFontSize).toBe(15);
    expect(patch.showHiddenFiles).toBe(true);
  });

  it('does not change the object it was given', () => {
    const form = settings({ connectionManagerVisibleTeamVaults: { a: true } });
    settingsPatchFromForm(form);
    expect(form.connectionManagerVisibleTeamVaults).toEqual({ a: true });
  });
});

describe('mergeSavedSettings', () => {
  it('takes the value the main process kept for what was sent, and refreshes the keys written elsewhere', () => {
    const current = settings({ terminalFontSize: 14, connectionManagerVisibleTeamVaults: {} });
    const saved = settings({
      terminalFontSize: 12, // a policy-managed value
      connectionManagerVisibleTeamVaults: { 'vault-1': true },
      connectionManagerDefaultTab: 'vault-1',
    });
    const next = mergeSavedSettings(current, saved, { terminalFontSize: 14 });
    expect(next.terminalFontSize).toBe(12);
    expect(next.connectionManagerVisibleTeamVaults).toEqual({ 'vault-1': true });
    expect(next.connectionManagerDefaultTab).toBe('vault-1');
  });

  it('does not undo a newer change of a key that was sent: the response belongs to the older save', () => {
    // Hidden files toggled on, then off again before the first save came back.
    const current = settings({ showHiddenFiles: false });
    const saved = settings({ showHiddenFiles: true });
    expect(mergeSavedSettings(current, saved, { showHiddenFiles: true }).showHiddenFiles).toBe(false);
  });

  it('compares nested values by content', () => {
    const current = settings({ shortcuts: { a: 'Ctrl+A' } as never });
    const saved = settings({ shortcuts: { a: 'Ctrl+B' } as never });
    expect(mergeSavedSettings(current, saved, { shortcuts: { a: 'Ctrl+A' } as never }).shortcuts).toEqual({ a: 'Ctrl+B' });
  });

  it('leaves what was not sent alone, so a change made while the save was under way survives', () => {
    const current = settings({ showHiddenFiles: false, terminalFontSize: 18 });
    const saved = settings({ showHiddenFiles: true, terminalFontSize: 14 });
    const next = mergeSavedSettings(current, saved, { showHiddenFiles: false });
    expect(next.showHiddenFiles).toBe(true); // what the main process kept for the key that was sent
    expect(next.terminalFontSize).toBe(18);
  });
});
