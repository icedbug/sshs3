import { describe, it, expect } from 'vitest';
import { isNoopOsDrop } from '../../src/renderer/src/components/FileManager/filePaneHelpers';

describe('isNoopOsDrop', () => {
  it('is true when every dropped path already sits in the target folder or is the target', () => {
    expect(isNoopOsDrop(['/home/me/a.txt', '/home/me/b.txt'], '/home/me')).toBe(true);
    expect(isNoopOsDrop(['/home/me/docs'], '/home/me/docs')).toBe(true);
  });

  it('is false when anything comes from elsewhere, or nothing was dropped', () => {
    expect(isNoopOsDrop(['/home/me/a.txt', '/tmp/b.txt'], '/home/me')).toBe(false);
    expect(isNoopOsDrop(['/home/me/sub/a.txt'], '/home/me')).toBe(false);
    expect(isNoopOsDrop([], '/home/me')).toBe(false);
  });
});
