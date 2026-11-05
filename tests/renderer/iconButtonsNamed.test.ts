import { describe, it, expect } from 'vitest';
import { relative } from 'node:path';
import { COMPONENTS_ROOT as ROOT, lineOf, read, tagEnd, tsxFiles, withoutTags } from './sourceScan';

// A button that shows only an icon has no text to name it. `title` is a hover tooltip and only a fallback name,
// so the button must carry an explicit aria-label. This scans every <button> in the renderer components: when its
// content holds no text (and no {expression} that could render text), it needs aria-label or aria-labelledby.

function iconOnlyButtonsWithoutName(): string[] {
  const unnamed: string[] = [];
  for (const file of tsxFiles(ROOT)) {
    const source = read(file);
    for (const match of source.matchAll(/<button\b/g)) {
      const start = match.index ?? 0;
      const end = tagEnd(source, start + match[0].length);
      if (end < 0) continue;
      const tag = source.slice(start, end);
      if (/aria-label|aria-labelledby/.test(tag) || tag.trimEnd().endsWith('/')) continue;
      const close = source.indexOf('</button>', end);
      if (close < 0) continue;
      if (/[A-Za-z]/.test(withoutTags(source.slice(end + 1, close)))) continue; // has text or an expression
      unnamed.push(`${relative(ROOT, file)}:${lineOf(source, start)}`);
    }
  }
  return unnamed;
}

describe('icon-only buttons are named', () => {
  it('every <button> without text has an aria-label', () => {
    expect(iconOnlyButtonsWithoutName()).toEqual([]);
  });

  it('scans a meaningful number of buttons (the scan is not silently empty)', () => {
    let buttons = 0;
    for (const file of tsxFiles(ROOT)) buttons += (read(file).match(/<button\b/g) ?? []).length;
    expect(buttons).toBeGreaterThan(300);
  });
});
