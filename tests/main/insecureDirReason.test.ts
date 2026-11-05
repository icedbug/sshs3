import { describe, it, expect } from 'vitest';
import { insecureDirReason } from '../../src/main/ssh/AppAgent';

const dir = (mode: number, uid = 1000, kind: 'dir' | 'symlink' | 'file' = 'dir') => ({
  mode,
  uid,
  isSymbolicLink: () => kind === 'symlink',
  isDirectory: () => kind === 'dir',
});

describe('insecureDirReason', () => {
  it('accepts a private directory owned by the current user on POSIX', () => {
    expect(insecureDirReason(dir(0o040700), 'linux', 1000)).toBeNull();
    expect(insecureDirReason(dir(0o040700), 'darwin', 1000)).toBeNull();
  });

  it('refuses a directory open to group or others on POSIX', () => {
    expect(insecureDirReason(dir(0o040750), 'linux', 1000)).toBe('accessible by group/others');
    expect(insecureDirReason(dir(0o040707), 'linux', 1000)).toBe('accessible by group/others');
  });

  it('refuses a directory owned by another user on POSIX', () => {
    expect(insecureDirReason(dir(0o040700, 0), 'linux', 1000)).toBe('owned by another user');
  });

  it('refuses a symlink or a plain file everywhere', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(insecureDirReason(dir(0o040700, 1000, 'symlink'), platform, 1000)).toBe('not a plain directory');
      expect(insecureDirReason(dir(0o100600, 1000, 'file'), platform, 1000)).toBe('not a plain directory');
    }
  });

  it('does not apply the POSIX permission and owner checks on Windows, which reports 0o777 for every directory', () => {
    expect(insecureDirReason(dir(0o040777, 0), 'win32', undefined)).toBeNull();
  });
});
