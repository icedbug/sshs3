import { describe, expect, it } from 'vitest';
import { plural } from './plural';

describe('plural', () => {
  it('uses the singular for exactly one and the plural otherwise, including zero', () => {
    expect(plural(1, 'session')).toBe('1 session');
    expect(plural(2, 'session')).toBe('2 sessions');
    expect(plural(0, 'file transfer')).toBe('0 file transfers');
  });

  it('accepts an irregular plural', () => {
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
    expect(plural(3, 'entry', 'entries')).toBe('3 entries');
  });
});
