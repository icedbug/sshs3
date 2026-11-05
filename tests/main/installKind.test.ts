import { describe, expect, it, vi } from 'vitest';
import { isNsisInstall } from '../../src/main/update/installKind';

describe('isNsisInstall', () => {
  const exe = 'C:\\Users\\a\\AppData\\Local\\Programs\\sshs3\\sshs3.exe';

  it('is true off Windows without looking at the disk', () => {
    const exists = vi.fn();
    expect(isNsisInstall('linux', {}, '/opt/sshs3/sshs3', exists)).toBe(true);
    expect(isNsisInstall('darwin', {}, '/Applications/sshs3', exists)).toBe(true);
    expect(exists).not.toHaveBeenCalled();
  });

  it('is true on Windows when the NSIS uninstaller sits beside the executable', () => {
    const exists = vi.fn(() => true);
    expect(isNsisInstall('win32', {}, exe, exists)).toBe(true);
    expect(exists).toHaveBeenCalledWith('C:\\Users\\a\\AppData\\Local\\Programs\\sshs3\\Uninstall sshs3.exe');
  });

  it('is false for an MSI install or an unpacked ZIP, which have no NSIS uninstaller', () => {
    expect(isNsisInstall('win32', {}, 'C:\\Program Files\\sshs3\\sshs3.exe', () => false)).toBe(false);
  });

  it('is false for the portable exe, which runs from a temporary folder', () => {
    const exists = vi.fn(() => true);
    expect(isNsisInstall('win32', { PORTABLE_EXECUTABLE_DIR: 'C:\\Tools' }, exe, exists)).toBe(false);
    expect(exists).not.toHaveBeenCalled();
  });
});
