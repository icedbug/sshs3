import { describe, it, expect } from 'vitest';
import { hasControlChars } from '../../src/renderer/src/lib/shellSafety';

describe('hasControlChars', () => {
  it('flags C0, DEL and C1 characters', () => {
    for (const bad of ['a\u0000b', 'a\u0015b', 'a\u0003b', 'a\nb', 'a\rb', 'a\tb', 'a\u001bb', 'a\u007fb', 'a\u009bb']) {
      expect(hasControlChars(bad)).toBe(true);
    }
  });

  it('accepts ordinary and non-ASCII text', () => {
    for (const ok of ['', '/home/me/My Docs/a b.txt', "it's $x", 'räksmörgås.txt', '日本語.txt', 'emoji-\u{1F600}.md']) {
      expect(hasControlChars(ok)).toBe(false);
    }
  });
});
