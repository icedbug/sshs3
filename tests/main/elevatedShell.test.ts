import { describe, expect, it } from 'vitest';
import {
  elevatedShellExecutable,
  elevatedStartCommand,
  isUacDeclined,
  UAC_DECLINED_EXIT_CODE,
} from '../../src/main/ipc/elevatedShell';

describe('elevatedShellExecutable', () => {
  it('maps the whitelisted shells', () => {
    expect(elevatedShellExecutable('cmd')).toBe('cmd.exe');
    expect(elevatedShellExecutable('powershell')).toBe('powershell.exe');
    expect(elevatedShellExecutable('pwsh')).toBe('pwsh.exe');
  });

  it('rejects everything else, including inherited object keys and non-strings', () => {
    for (const value of ['wsl', '', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 42, null, undefined, {}]) {
      expect(elevatedShellExecutable(value)).toBeNull();
    }
  });
});

describe('UAC handling', () => {
  it('builds a script that starts the program elevated and maps a declined prompt to a fixed exit code', () => {
    const script = elevatedStartCommand('cmd.exe');
    expect(script).toContain("Start-Process -FilePath 'cmd.exe'");
    expect(script).toContain('-Verb RunAs');
    expect(script).toContain('1223');
    expect(script).toContain(`exit ${UAC_DECLINED_EXIT_CODE}`);
  });

  it('recognises the exit code regardless of language', () => {
    expect(isUacDeclined({ code: UAC_DECLINED_EXIT_CODE, stderr: 'Åtgärden avbröts av användaren' })).toBe(true);
    expect(isUacDeclined({ code: 1, stderr: 'canceled by the user' })).toBe(false);
    expect(isUacDeclined(new Error('x'))).toBe(false);
    expect(isUacDeclined(null)).toBe(false);
  });
});
