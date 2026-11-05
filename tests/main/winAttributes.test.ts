import { describe, expect, it } from 'vitest';
import { buildAttribFlags, parseAttribOutput, unappliedAttributes } from '../../src/main/storage/winAttributes';

describe('parseAttribOutput', () => {
  it('reads the flag columns in front of the path', () => {
    expect(parseAttribOutput('A  SH        C:\\dir\\file.txt\r\n')).toEqual({
      readOnly: false,
      hidden: true,
      system: true,
      archive: true,
    });
    expect(parseAttribOutput('     R        C:\\dir\\file.txt')).toEqual({
      readOnly: true,
      hidden: false,
      system: false,
      archive: false,
    });
    expect(parseAttribOutput('              D:\\x')).toEqual({ readOnly: false, hidden: false, system: false, archive: false });
  });

  it('does not depend on how the path is decoded', () => {
    // OEM-codepage bytes read as UTF-8 give replacement characters in the path.
    expect(parseAttribOutput('A  H        C:\\Anv\ufffdndare\\f\ufffdl.txt').hidden).toBe(true);
    expect(parseAttribOutput('A    R       \\\\server\\share\\a.txt').readOnly).toBe(true);
  });

  it('throws instead of reporting no attributes when there is no attribute line', () => {
    expect(() => parseAttribOutput('File not found - C:\\nope')).toThrow();
    expect(() => parseAttribOutput('Filen hittades inte - C:\\nope')).toThrow();
    expect(() => parseAttribOutput('')).toThrow();
  });
});

describe('buildAttribFlags', () => {
  it('turns changes into attrib flags', () => {
    expect(buildAttribFlags({ readOnly: true, archive: false })).toEqual(['+R', '-A']);
    expect(buildAttribFlags({})).toEqual([]);
  });

  it('repeats the current H and S so attrib does not refuse a hidden or system file', () => {
    const current = { readOnly: false, hidden: true, system: true, archive: false };
    expect(buildAttribFlags({ readOnly: true }, current)).toEqual(['+R', '+H', '+S']);
    expect(buildAttribFlags({ hidden: false }, current)).toEqual(['-H', '+S']);
    expect(buildAttribFlags({}, current)).toEqual([]);
  });
});

describe('unappliedAttributes', () => {
  it('lists what did not take effect', () => {
    const actual = { readOnly: false, hidden: true, system: false, archive: false };
    expect(unappliedAttributes({ readOnly: true, hidden: true }, actual)).toEqual(['readOnly']);
    expect(unappliedAttributes({ hidden: true }, actual)).toEqual([]);
  });
});
