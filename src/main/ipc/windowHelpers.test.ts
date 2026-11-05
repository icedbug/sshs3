import { describe, it, expect } from 'vitest';
import { parseMoveTarget, parseTabHandoff } from './windowHelpers';

const tab = { id: 't1', type: 'terminal', title: 'T' };

describe('parseTabHandoff', () => {
  it('accepts a tab with its sessions', () => {
    const h = parseTabHandoff({ tab, sessions: [{ paneId: 'p1', sessionId: 's1', kind: 'ssh', extra: 1 }] });
    expect(h.sessions).toEqual([{ paneId: 'p1', sessionId: 's1', kind: 'ssh' }]);
    expect(h.tab).toBe(tab);
  });

  it.each([
    [null],
    [{}],
    [{ tab: { id: 't', type: 'weird' }, sessions: [] }],
    [{ tab: { type: 'terminal' }, sessions: [] }],
    [{ tab, sessions: 'x' }],
    [{ tab, sessions: [{ paneId: 'p', sessionId: '', kind: 'ssh' }] }],
    [{ tab, sessions: [{ paneId: 'p', sessionId: 's', kind: 'pty' }] }],
    [{ tab: [], sessions: [] }],
  ])('rejects malformed input %#', (input) => {
    expect(() => parseTabHandoff(input)).toThrow();
  });

  it('rejects too many sessions and oversized tabs', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({ paneId: `p${i}`, sessionId: `s${i}`, kind: 'ssh' }));
    expect(() => parseTabHandoff({ tab, sessions: many })).toThrow();
    expect(() => parseTabHandoff({ tab: { ...tab, blob: 'x'.repeat(1_100_000) }, sessions: [] })).toThrow(/too large/);
  });
});

describe('parseMoveTarget', () => {
  it('accepts "new" and positive integer window ids only', () => {
    expect(parseMoveTarget('new')).toBe('new');
    expect(parseMoveTarget(3)).toBe(3);
    for (const bad of [0, -1, 1.5, '3', null, undefined, {}]) expect(() => parseMoveTarget(bad)).toThrow();
  });
});
