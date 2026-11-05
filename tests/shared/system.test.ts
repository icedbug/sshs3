import { describe, it, expect } from 'vitest';
import {
  MAX_SYSTEM_NAME_LENGTH,
  MAX_SYSTEM_TUNNELS,
  normalizeSystem,
  sameSystemName,
  withNormalizedSystem,
} from '../../src/shared/system';

const tunnels = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];

describe('normalizeSystem', () => {
  it('keeps a name, trimmed, and leaves everything else out when it was not given', () => {
    expect(normalizeSystem({ name: '  web  ' }, tunnels)).toEqual({ name: 'web' });
  });

  it('drops the whole membership when it is not an object or has no usable name', () => {
    expect(normalizeSystem(undefined, tunnels)).toBeUndefined();
    expect(normalizeSystem(null, tunnels)).toBeUndefined();
    expect(normalizeSystem('web', tunnels)).toBeUndefined();
    expect(normalizeSystem([], tunnels)).toBeUndefined();
    expect(normalizeSystem({}, tunnels)).toBeUndefined();
    expect(normalizeSystem({ name: '   ' }, tunnels)).toBeUndefined();
    expect(normalizeSystem({ name: 5 }, tunnels)).toBeUndefined();
  });

  it('rejects names that are too long or contain control characters', () => {
    expect(normalizeSystem({ name: 'a'.repeat(MAX_SYSTEM_NAME_LENGTH) }, tunnels)?.name).toHaveLength(MAX_SYSTEM_NAME_LENGTH);
    expect(normalizeSystem({ name: 'a'.repeat(MAX_SYSTEM_NAME_LENGTH + 1) }, tunnels)).toBeUndefined();
    expect(normalizeSystem({ name: 'we\u0000b' }, tunnels)).toBeUndefined();
    expect(normalizeSystem({ name: 'we\nb' }, tunnels)).toBeUndefined();
  });

  it('keeps shell only when it is switched off, since on is the default', () => {
    expect(normalizeSystem({ name: 'web', shell: false }, tunnels)).toEqual({ name: 'web', shell: false });
    expect(normalizeSystem({ name: 'web', shell: true }, tunnels)).toEqual({ name: 'web' });
    expect(normalizeSystem({ name: 'web', shell: 'no' }, tunnels)).toEqual({ name: 'web' });
  });

  it('keeps a trimmed start directory and drops an empty, oversize or odd one', () => {
    expect(normalizeSystem({ name: 'web', startDirectory: ' /var/www ' }, tunnels)).toEqual({ name: 'web', startDirectory: '/var/www' });
    expect(normalizeSystem({ name: 'web', startDirectory: '   ' }, tunnels)).toEqual({ name: 'web' });
    expect(normalizeSystem({ name: 'web', startDirectory: '/'.repeat(1025) }, tunnels)).toEqual({ name: 'web' });
    expect(normalizeSystem({ name: 'web', startDirectory: '/a\u0000b' }, tunnels)).toEqual({ name: 'web' });
    expect(normalizeSystem({ name: 'web', startDirectory: 42 }, tunnels)).toEqual({ name: 'web' });
  });

  it('keeps only tunnel ids the profile really has, once each', () => {
    expect(normalizeSystem({ name: 'web', tunnelIds: ['t2', 'gone', 't2', 't1', 7] }, tunnels)).toEqual({
      name: 'web',
      tunnelIds: ['t2', 't1'],
    });
  });

  it('drops tunnel ids when the profile has no tunnels, and the key when none are left', () => {
    expect(normalizeSystem({ name: 'web', tunnelIds: ['t1'] }, undefined)).toEqual({ name: 'web' });
    expect(normalizeSystem({ name: 'web', tunnelIds: [] }, tunnels)).toEqual({ name: 'web' });
    expect(normalizeSystem({ name: 'web', tunnelIds: 't1' }, tunnels)).toEqual({ name: 'web' });
  });

  it('keeps at most the allowed number of tunnels', () => {
    const many = Array.from({ length: MAX_SYSTEM_TUNNELS + 5 }, (_, i) => ({ id: `t${i}` }));
    const result = normalizeSystem({ name: 'web', tunnelIds: many.map((t) => t.id) }, many);
    expect(result?.tunnelIds).toHaveLength(MAX_SYSTEM_TUNNELS);
  });

  it('ignores unknown properties, so nothing unvalidated is stored', () => {
    const result = normalizeSystem({ name: 'web', password: 'x', extra: { a: 1 } }, tunnels); // pragma: allowlist secret
    expect(result).toEqual({ name: 'web' });
  });

  it('is idempotent', () => {
    const once = normalizeSystem({ name: ' web ', shell: false, startDirectory: ' /x ', tunnelIds: ['t1', 't1'] }, tunnels);
    expect(normalizeSystem(once, tunnels)).toEqual(once);
  });
});

describe('withNormalizedSystem', () => {
  it('returns the same object when the profile has no system key', () => {
    const profile = { id: 'a', tunnels } as { id: string; tunnels: Array<{ id: string }>; system?: never };
    expect(withNormalizedSystem(profile)).toBe(profile);
  });

  it('cleans the membership against the profile\'s own tunnels', () => {
    const profile = { id: 'a', tunnels: [{ id: 't1' }], system: { name: ' web ', tunnelIds: ['t1', 't9'] } };
    expect(withNormalizedSystem(profile)).toEqual({ id: 'a', tunnels: [{ id: 't1' }], system: { name: 'web', tunnelIds: ['t1'] } });
  });

  it('removes the key when the membership is not valid', () => {
    const cleaned = withNormalizedSystem({ id: 'a', system: { name: '  ' } });
    expect('system' in cleaned).toBe(false);
  });

  it('does not touch its input', () => {
    const profile = { id: 'a', system: { name: ' web ' } };
    withNormalizedSystem(profile);
    expect(profile.system.name).toBe(' web ');
  });
});

describe('sameSystemName', () => {
  it('compares names ignoring case and surrounding space', () => {
    expect(sameSystemName('Web', ' web ')).toBe(true);
    expect(sameSystemName('Web', 'Db')).toBe(false);
  });
});
