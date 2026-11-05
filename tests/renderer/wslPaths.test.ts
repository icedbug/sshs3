import { describe, it, expect } from 'vitest';
import { wslToWindowsPath, windowsToWslPath } from '../../src/renderer/src/lib/wslPaths';

describe('wslToWindowsPath', () => {
  it('maps /mnt/<drive> to a drive path', () => {
    expect(wslToWindowsPath('/mnt/c/Users/alun/sshs3/README.md')).toBe('C:\\Users\\alun\\sshs3\\README.md');
    expect(wslToWindowsPath('/mnt/d')).toBe('D:\\');
  });

  it('maps other absolute paths into the distro share when the distro is known', () => {
    expect(wslToWindowsPath('/home/alun/a.md', 'Ubuntu')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\alun\\a.md');
  });

  it('leaves paths it cannot translate unchanged', () => {
    expect(wslToWindowsPath('/home/alun/a.md')).toBe('/home/alun/a.md');
    expect(wslToWindowsPath('C:\\x\\y')).toBe('C:\\x\\y');
  });
});

describe('windowsToWslPath', () => {
  it('maps drive paths to /mnt/<drive>', () => {
    expect(windowsToWslPath('C:\\Users\\alun\\my file.txt')).toBe('/mnt/c/Users/alun/my file.txt');
    expect(windowsToWslPath('D:\\')).toBe('/mnt/d');
  });

  it('maps the distro share back to a Linux path', () => {
    expect(windowsToWslPath('\\\\wsl.localhost\\Ubuntu\\home\\alun\\a.md')).toBe('/home/alun/a.md');
    expect(windowsToWslPath('\\\\wsl$\\Ubuntu\\etc')).toBe('/etc');
  });

  it('leaves other paths unchanged', () => {
    expect(windowsToWslPath('/already/posix')).toBe('/already/posix');
  });
});
