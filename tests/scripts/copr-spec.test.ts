import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  isValidTag,
  latestChangelogPackager,
  renderSpec,
  rpmChangelogDate,
} from '../../scripts/copr-spec.mjs';

// The Windows CI checkout has CRLF endings; the tests edit the spec with LF regexes, so work on an LF copy.
// CRLF input itself is covered by its own test below.
const SPEC = readFileSync(new URL('../../packaging/copr/sshs3.spec', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SHA = 'a'.repeat(64);
const PACKAGER = 'Jane Doe <jane@example.com>';
const base = { version: '1.2.3', sha256: SHA, release: 1, date: new Date(Date.UTC(2026, 9, 23)), packager: PACKAGER };

describe('isValidTag', () => {
  it('accepts vX.Y.Z only', () => {
    expect(isValidTag('v0.96.59')).toBe(true);
    expect(isValidTag('0.96.59')).toBe(false);
    expect(isValidTag('v0.96')).toBe(false);
    expect(isValidTag('v0.96.59-rc1')).toBe(false);
    expect(isValidTag('v1.2.3; rm -rf /')).toBe(false);
    expect(isValidTag(undefined)).toBe(false);
  });
});

describe('rpmChangelogDate', () => {
  it('formats like an RPM changelog header', () => {
    expect(rpmChangelogDate(new Date(Date.UTC(2026, 9, 23)))).toBe('Fri Oct 23 2026');
    expect(rpmChangelogDate(new Date(Date.UTC(2027, 0, 5)))).toBe('Tue Jan 05 2027');
  });
});

describe('latestChangelogPackager', () => {
  it('reads the packager from the newest entry', () => {
    expect(latestChangelogPackager('%changelog\n* Fri Oct 23 2026 A B <a@b.c> - 1.0-1\n- x\n')).toBe('A B <a@b.c>');
  });

  it('returns null without an entry', () => {
    expect(latestChangelogPackager('%changelog\n')).toBeNull();
  });

  it('finds one in the committed spec', () => {
    expect(latestChangelogPackager(SPEC)).not.toBeNull();
  });
});

describe('renderSpec', () => {
  it('rewrites version, release, checksum and adds a changelog entry on the real spec', () => {
    const out = renderSpec(SPEC, base);
    expect(out).toMatch(/^Version:\s+1\.2\.3$/m);
    expect(out).toMatch(/^Release:\s+1%\{\?dist\}$/m);
    expect(out).toContain(`%global source_sha256 ${SHA}`);
    expect(out).toContain(`%changelog\n* Fri Oct 23 2026 ${PACKAGER} - 1.2.3-1\n- Update to 1.2.3\n\n`);
    // Everything else is untouched.
    expect(out.split('\n').length).toBe(SPEC.split('\n').length + 3);
  });

  it('notes a rebuild when the release is above 1', () => {
    const out = renderSpec(SPEC, { ...base, release: 2 });
    expect(out).toMatch(/^Release:\s+2%\{\?dist\}$/m);
    expect(out).toContain('- 1.2.3-2\n- Update to 1.2.3\n- Rebuild (release 2)\n');
  });

  it('refuses malformed input', () => {
    expect(() => renderSpec(SPEC, { ...base, version: '1.2' })).toThrow(/invalid version/);
    expect(() => renderSpec(SPEC, { ...base, sha256: 'xyz' })).toThrow(/invalid sha256/);
    expect(() => renderSpec(SPEC, { ...base, release: 0 })).toThrow(/invalid release/);
    expect(() => renderSpec(SPEC, { ...base, packager: 'no email' })).toThrow(/invalid packager/);
  });

  it('refuses a spec whose lines are missing or duplicated', () => {
    expect(() => renderSpec(SPEC.replace(/^Version:.*\n/m, ''), base)).toThrow(/Version:.*found 0/);
    expect(() => renderSpec(`${SPEC}\nVersion: 9.9.9\n`, base)).toThrow(/Version:.*found 2/);
    expect(() => renderSpec(SPEC.replace(/^%global source_sha256 .*\n/m, ''), base)).toThrow(/source_sha256/);
    expect(() => renderSpec(SPEC.replace('%changelog\n', ''), base)).toThrow(/%changelog/);
  });

  it('handles a spec checked out with CRLF line endings and returns LF', () => {
    const crlf = SPEC.replace(/\r?\n/g, '\r\n');
    expect(latestChangelogPackager(crlf)).toBe(latestChangelogPackager(SPEC));
    const out = renderSpec(crlf, base);
    expect(out).not.toContain('\r');
    expect(out).toBe(renderSpec(SPEC, base));
  });

  it('does not interpret $ sequences in the packager', () => {
    const out = renderSpec(SPEC, { ...base, packager: 'A $& B <a@b.c>' });
    expect(out).toContain('* Fri Oct 23 2026 A $& B <a@b.c> - 1.2.3-1');
  });
});
