import { describe, it, expect } from 'vitest';
import { relative } from 'node:path';
import { COMPONENTS_ROOT as ROOT, lineOf, read, tagEnd, tsxFiles } from './sourceScan';

// An error that appears after a failed action must reach screen-reader users: its element needs role="alert".
// This scans the renderer components for the conditional-error pattern the app uses,
//   {error && ( <div className="... red-..."> ...
// and fails for any such element without a role, so a new banner cannot silently skip it.

const VAR = String.raw`(?:\w+\.)?[A-Za-z]*(?:[Ee]rr(?:or)?|errorMessage)\b`;
const CONDITIONAL = new RegExp(String.raw`\{\s*${VAR}(?:\s*&&\s*[!\w.]+)*\s*&&\s*\(?\s*<(div|p|span)\b`, 'g');

describe('error banners are announced', () => {
  it('every conditional red/rose error element carries a role', () => {
    const missing: string[] = [];
    for (const file of tsxFiles(ROOT)) {
      const source = read(file);
      for (const match of source.matchAll(CONDITIONAL)) {
        const tagStart = (match.index ?? 0) + match[0].lastIndexOf('<');
        const tag = source.slice(tagStart, tagEnd(source, tagStart));
        if (/red-|rose-/.test(tag) && !/\brole=/.test(tag)) {
          missing.push(`${relative(ROOT, file)}:${lineOf(source, tagStart)}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('finds the banners it is meant to guard (the scan is not silently empty)', () => {
    let found = 0;
    for (const file of tsxFiles(ROOT)) {
      for (const _ of read(file).matchAll(CONDITIONAL)) found += 1;
    }
    expect(found).toBeGreaterThan(30);
  });
});
