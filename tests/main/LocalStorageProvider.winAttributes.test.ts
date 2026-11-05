import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import { LocalStorageProvider } from '../../src/main/storage/LocalStorageProvider';

const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

/** A fake `attrib`: reads and writes one item's flags, and refuses a hidden/system item unless H/S are named. */
function fakeAttrib(initial: { R?: boolean; H?: boolean; S?: boolean; A?: boolean }) {
  const state = { R: false, H: false, S: false, A: false, ...initial };
  const calls: string[][] = [];
  vi.mocked(execFile).mockImplementation(((_file: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    calls.push(args);
    const flags = args.filter((a) => /^[+-][RHSA]$/.test(a));
    if (flags.length === 0) {
      const col = (on: boolean, letter: string) => (on ? letter : ' ');
      cb(null, { stdout: `${col(state.A, 'A')}  ${col(state.S, 'S')}${col(state.H, 'H')}${col(state.R, 'R')}      C:\\fake\\item\r\n`, stderr: '' });
      return;
    }
    const names = (letter: string) => flags.some((f) => f.endsWith(letter));
    const refused = (state.H && !names('H')) || (state.S && !names('S'));
    if (!refused) {
      for (const f of flags) state[f[1] as 'R' | 'H' | 'S' | 'A'] = f[0] === '+';
    }
    cb(null, { stdout: refused ? 'Not resetting hidden file - C:\\fake\\item\r\n' : '', stderr: '' });
  }) as never);
  return { state, calls };
}

describe('LocalStorageProvider Windows attributes', () => {
  let dir: string;
  let provider: LocalStorageProvider;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-winattr-'));
    provider = new LocalStorageProvider();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', origPlatform);
    fs.rmSync(dir, { recursive: true, force: true });
    vi.mocked(execFile).mockReset();
  });

  it('is Windows only', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(provider.getWinAttributes(dir)).rejects.toThrow('only available on Windows');
    await expect(provider.setWinAttributes(dir, { hidden: true })).rejects.toThrow('only available on Windows');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reads the flags of an item', async () => {
    fakeAttrib({ H: true, A: true });
    await expect(provider.getWinAttributes(dir)).resolves.toEqual({ readOnly: false, hidden: true, system: false, archive: true });
  });

  it('changes a flag and verifies the result', async () => {
    const { state, calls } = fakeAttrib({});
    await provider.setWinAttributes(dir, { readOnly: true });
    expect(state.R).toBe(true);
    // Read current, apply, read back: three attrib runs. H/S are repeated (as cleared) so attrib never refuses.
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(['+R', '-H', '-S', dir]);
  });

  it('repeats the current hidden and system flags so attrib does not refuse the item', async () => {
    const { state, calls } = fakeAttrib({ H: true, S: true });
    await provider.setWinAttributes(dir, { readOnly: true });
    expect(state).toMatchObject({ R: true, H: true, S: true });
    expect(calls[1]).toEqual(['+R', '+H', '+S', dir]);
  });

  it('fails when Windows exits 0 without applying the change', async () => {
    fakeAttrib({});
    vi.mocked(execFile).mockImplementation(((_file: string, args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
      cb(null, { stdout: args.some((a) => /^[+-][RHSA]$/.test(a)) ? '' : '     A        C:\\fake\\item\r\n', stderr: '' });
    }) as never);
    await expect(provider.setWinAttributes(dir, { readOnly: true })).rejects.toThrow('Windows did not apply: readOnly');
  });

  it('does nothing when there are no changes', async () => {
    const { calls } = fakeAttrib({});
    await provider.setWinAttributes(dir, {});
    expect(calls.filter((a) => a.some((x) => /^[+-][RHSA]$/.test(x)))).toHaveLength(0);
  });

  it('applies to a folder tree only when asked, with the requested flags only', async () => {
    const { calls } = fakeAttrib({ H: true });
    await provider.setWinAttributes(dir, { archive: true }, false);
    expect(calls.some((a) => a.includes('/S'))).toBe(false);

    calls.length = 0;
    await provider.setWinAttributes(dir, { archive: true }, true);
    expect(calls.at(-1)).toEqual(['+A', path.join(dir, '*'), '/S', '/D']);
  });

  it('skips the recursive pass for a file', async () => {
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    const { calls } = fakeAttrib({});
    await provider.setWinAttributes(file, { archive: true }, true);
    expect(calls.some((a) => a.includes('/S'))).toBe(false);
  });
});
