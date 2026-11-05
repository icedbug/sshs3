import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { kbdCombos, lintDoc, parseRegistrySlugs, parseShortcuts, stripInlineCode } from '../../scripts/docs-lint.mjs';

const GOOD = [
  '## Terminal',
  '',
  'Intro with `<path>` and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>.',
  '',
  '## 1. Section',
  '',
  '| A | B |',
  '| :--- | :--- |',
  '| `x | y` | z |',
  '',
  '> [!TIP]',
  '> Fine.',
  '',
  '## 2. Troubleshooting & Diagnostics',
  '',
].join('\n');

const rules = (text: string, ctx = {}, file = 'page.md') => lintDoc(file, text, ctx).map((f) => f.rule);

describe('lintDoc', () => {
  it('accepts a page in the v2 style', () => {
    expect(lintDoc('page.md', GOOD, { shortcuts: new Set(['Ctrl+Shift+D']) })).toEqual([]);
  });

  it('requires the leading "## Title" line', () => {
    expect(rules('# Title\n\n## 1. A\n\n## 2. Troubleshooting\n')).toContain('title');
    expect(rules('')).toContain('title');
  });

  it('rejects emoji in headings and the retired per-feature blocks', () => {
    expect(rules(GOOD + '\n### 🎯 Purpose\n')).toEqual(expect.arrayContaining(['heading-emoji', 'legacy-block']));
    expect(rules(GOOD + '\n#### Limitations & Caveats\n')).toContain('legacy-block');
    expect(rules(GOOD + '\n### Good to know\n')).not.toContain('legacy-block');
  });

  it('rejects <details> and non-English letters', () => {
    expect(rules(GOOD + '\n<details>\n')).toContain('details');
    expect(rules(GOOD + '\nSkärmbild\n')).toContain('english-only');
  });

  it('rejects callouts inside list items and unknown callout types', () => {
    expect(rules(GOOD + '\n1. Step\n   > [!NOTE]\n   > text\n')).toContain('callout-in-list');
    expect(rules(GOOD + '\n> [!INFO]\n> text\n')).toContain('callout-type');
  });

  it('flags bare tags outside code but allows code spans, fences and the passthrough set', () => {
    expect(rules(GOOD + '\nRun ssh <host> now\n')).toContain('bare-tag');
    expect(rules(GOOD + '\nRun `ssh <host>` now\n')).not.toContain('bare-tag');
    expect(rules(GOOD + '\n```bash\nssh <host>\n```\n')).not.toContain('bare-tag');
    expect(rules(GOOD + '\n<kbd>Esc</kbd> and <br>\n')).not.toContain('bare-tag');
  });

  it('flags legacy flat links, .md links and unknown pages', () => {
    const known = new Set(['workspace/terminal']);
    expect(rules(GOOD + '\n[x](/docs/terminal/)\n', { knownPages: known })).toContain('legacy-link');
    expect(rules(GOOD + '\n[x](performance-bar.md)\n')).toContain('relative-md-link');
    expect(rules(GOOD + '\n[x](/docs/nowhere/page/)\n', { knownPages: known })).toContain('unknown-page');
    expect(rules(GOOD + '\n[x](/docs/workspace/terminal/#split)\n', { knownPages: known })).toEqual([]);
    expect(rules(GOOD + '\n[x](/docs/nowhere/page/)\n', { knownPages: null })).not.toContain('unknown-page');
  });

  it('checks images against the screenshot folder', () => {
    const images = new Set(['split.png']);
    expect(rules(GOOD + '\n![a](/img/docs/split.png)\n', { images })).toEqual([]);
    expect(rules(GOOD + '\n![a](/img/docs/gone.png)\n', { images })).toContain('missing-image');
  });

  it('flags shortcuts that are not defaults in settings.ts', () => {
    const shortcuts = new Set(['Ctrl+Shift+D']);
    expect(rules(GOOD + '\nPress <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>.\n', { shortcuts })).toContain('unknown-shortcut');
    expect(rules(GOOD + '\nPress <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>.\n', { shortcuts })).not.toContain('unknown-shortcut');
    expect(rules(GOOD + '\nPress <kbd>Ctrl+Shift+B</kbd>.\n', { shortcuts })).toContain('unknown-shortcut');
  });

  it('checks table column counts, ignoring pipes in code and escaped pipes', () => {
    expect(rules(GOOD + '\n| A | B |\n| :-- | :-- |\n| 1 | 2 | 3 |\n')).toContain('table-columns');
    expect(rules(GOOD + '\n| A | B |\n| :-- | :-- |\n| `a|b` | c\\|d |\n')).not.toContain('table-columns');
  });

  it('checks fences and tab markers are balanced', () => {
    expect(rules(GOOD + '\n```bash\nls\n')).toContain('unclosed-fence');
    expect(rules(GOOD + '\n<!-- tabs:start -->\n')).toContain('tabs-balance');
  });

  it('warns about unnumbered sections and a missing troubleshooting section, with exemptions', () => {
    const noTs = '## T\n\n## 1. A\n\n## Extras\n';
    const found = lintDoc('page.md', noTs);
    expect(found.filter((f) => f.level === 'warn').map((f) => f.rule).sort()).toEqual(['numbered-sections', 'troubleshooting']);
    expect(lintDoc('quickstart.md', noTs).map((f) => f.rule)).not.toContain('troubleshooting');
    expect(rules('## T\n\n## 1. A\n\n## Next Steps\n\n', {}, 'quickstart.md')).toEqual([]);
  });
});

describe('helpers', () => {
  it('stripInlineCode keeps the line length', () => {
    expect(stripInlineCode('a `<b>` c')).toBe('a       c');
  });

  it('kbdCombos joins separate and combined kbd forms', () => {
    expect(kbdCombos('<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd> and <kbd>Ctrl+Alt+Shift+W</kbd>')).toEqual(['Ctrl+Shift+D', 'Ctrl+Alt+Shift+W']);
    expect(kbdCombos('<kbd>Ctrl</kbd>+<kbd>+</kbd>')).toEqual(['Ctrl++']);
  });

  it('parses shortcut defaults and registry slugs', () => {
    expect(parseShortcuts("{ id: 'a', defaultKeys: 'Ctrl+Shift+D' }, { defaultKeys: 'F5' }")).toEqual(new Set(['Ctrl+Shift+D', 'F5']));
    expect(parseRegistrySlugs("fullSlug: 'workspace/terminal',\n fullSlug: 'cloud/tunnels'")).toEqual(new Set(['workspace/terminal', 'cloud/tunnels']));
  });
});

describe('the real user guide', () => {
  it('passes the lint (errors and warnings)', () => {
    const dir = new URL('../../docs/user-guide/', import.meta.url);
    const shortcuts = parseShortcuts(readFileSync(new URL('../../src/shared/types/settings.ts', import.meta.url), 'utf8'));
    const images = new Set(readdirSync(new URL('../../docs/screenshots/', import.meta.url)));
    const findings = readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .flatMap((f) => lintDoc(f, readFileSync(new URL(f, dir), 'utf8'), { shortcuts, images }));
    expect(findings).toEqual([]);
  });
});
