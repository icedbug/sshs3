import { describe, it, expect } from 'vitest';
import {
  applyPolicy,
  isFeatureAllowed,
  isUpdateCheckDisabled,
  managedSettingIds,
  stripLockedKeys,
} from '../../src/main/policy/policyApply';
import { EMPTY_POLICY, type PolicyDocument } from '../../src/shared/types/policy';
import { DEFAULT_SETTINGS } from '../../src/shared/types/settings';

const policy: PolicyDocument = {
  settings: { autoCheckUpdates: false, smartcardAuthMode: 'always-prompt' },
  features: { gitKeyFetch: false },
};

describe('policyApply', () => {
  it('overrides managed values and leaves the rest', () => {
    const settings = { ...DEFAULT_SETTINGS, autoCheckUpdates: true, smartcardAuthMode: 'agent-global' as const, terminalFontSize: 17 };
    const effective = applyPolicy(settings, policy);
    expect(effective.autoCheckUpdates).toBe(false);
    expect(effective.smartcardAuthMode).toBe('always-prompt');
    expect(effective.terminalFontSize).toBe(17);
  });

  it('returns the same object for an empty policy', () => {
    expect(applyPolicy(DEFAULT_SETTINGS, EMPTY_POLICY)).toBe(DEFAULT_SETTINGS);
  });

  it('strips locked keys from a save and keeps the others', () => {
    expect(stripLockedKeys({ autoCheckUpdates: true, theme: 'light' }, policy)).toEqual({ theme: 'light' });
    const same = { theme: 'light' as const };
    expect(stripLockedKeys(same, EMPTY_POLICY)).toBe(same);
  });

  it('lists managed ids', () => {
    expect(managedSettingIds(policy)).toEqual(['autoCheckUpdates', 'smartcardAuthMode']);
  });

  it('allows features unless explicitly disabled', () => {
    expect(isFeatureAllowed(policy, 'gitKeyFetch')).toBe(false);
    expect(isFeatureAllowed(policy, 'dotfileGitImport')).toBe(true);
    expect(isFeatureAllowed(EMPTY_POLICY, 'gitKeyFetch')).toBe(true);
  });

  it.each([
    [{}, EMPTY_POLICY, false],
    [{ SSHS3_DISABLE_UPDATES: '1' }, EMPTY_POLICY, true],
    [{ SSHS3_DISABLE_UPDATES: '0' }, EMPTY_POLICY, false],
    [{}, { settings: { autoCheckUpdates: false }, features: {} }, true],
    [{}, { settings: { autoCheckUpdates: true }, features: {} }, false],
  ] as const)('update check disabled: env %j policy %j -> %s', (env, doc, expected) => {
    expect(isUpdateCheckDisabled(env as NodeJS.ProcessEnv, doc as PolicyDocument)).toBe(expected);
  });
});
