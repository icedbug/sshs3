#!/usr/bin/env node
// Style and consistency lint for docs/user-guide/*.md (see "Page style (v2)" in docs/user-guide/README.md).
//
//   node scripts/docs-lint.mjs [--strict] [file.md ...]
//
// Errors fail the run; warnings only fail with --strict. The checks are pure functions over the file text
// (lintDoc) so they are unit tested in tests/scripts/docs-lint.test.ts; the CLI below only gathers context:
// the keyboard shortcuts from src/shared/types/settings.ts, the screenshots in docs/screenshots and, when a
// sshs3-site checkout sits next to this repo (or SSHS3_SITE_DIR is set), the page URLs of its registry.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Flat URLs the guide used before the category structure; links to them only work through a redirect. */
const LEGACY_SLUGS = [
  'getting-started', 'terminal', 'file-manager', 'connections', 'performance-bar', 'kubernetes', 's3-storage',
  'networking-tunnels', 'security-smartcards', 'team-vault', 'sync-environment', 'git-developer',
  'settings-shortcuts', 'windows', 'architecture-internals',
];

const CALLOUT_TYPES = new Set(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']);

/** HTML the renderer passes through; any other bare <tag> outside code silently disappears in the browser. */
const ALLOWED_TAGS = new Set(['kbd', 'br', 'video', 'source', 'img', 'a', 'b', 'i', 'em', 'strong', 'code', 'sup', 'sub']);

/** Pages that legitimately have no Troubleshooting section. */
const NO_TROUBLESHOOTING = new Set(['quickstart.md', 'team-vault.md']);

/** Shortcuts that exist in the terminal but are not configurable (so absent from settings.ts). */
const EXTRA_SHORTCUTS = new Set(['Ctrl+Shift+V']);

const EMOJI = /\p{Extended_Pictographic}/u;
const SWEDISH = /[åäöÅÄÖ]/;

/** Replace inline code spans with spaces of the same length so the other checks ignore their content. */
export function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

/** Normalize `<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>` (or one kbd with a plus-joined combo) to `Ctrl+Shift+D`. */
export function kbdCombos(line) {
  const combos = [];
  for (const m of line.matchAll(/<kbd>[^<]+<\/kbd>(?:\s*\+\s*<kbd>[^<]+<\/kbd>)*/g)) {
    const keys = [...m[0].matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((k) => k[1].trim());
    combos.push(keys.join('+'));
  }
  return combos;
}

function columnCount(row) {
  const cells = stripInlineCode(row).replace(/\\\|/g, '  ').trim().replace(/^\|/, '').replace(/\|$/, '');
  return cells.split('|').length;
}

/**
 * @param {string} file base name, e.g. `terminal.md`
 * @param {string} text file content
 * @param {{ knownPages?: Set<string>|null, shortcuts?: Set<string>|null, images?: Set<string>|null }} [ctx]
 *   knownPages: page slugs such as `workspace/terminal` (null = skip the link-target check);
 *   shortcuts: default shortcuts from settings.ts (null = skip); images: file names in docs/screenshots (null = skip).
 * @returns {{ file: string, line: number, level: 'error'|'warn', rule: string, message: string }[]}
 */
export function lintDoc(file, text, ctx = {}) {
  const findings = [];
  const add = (line, level, rule, message) => findings.push({ file, line, level, rule, message });
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  const firstContent = lines.findIndex((l) => l.trim() !== '');
  if (firstContent === -1 || !/^## \S/.test(lines[firstContent])) {
    add(firstContent + 1, 'error', 'title', 'the file must start with a "## Title" line (the site renders the registry title as <h1> and drops this line)');
  }

  let inFence = false;
  let fenceStart = 0;
  let tabsStart = 0;
  let tabsEnd = 0;
  let sawTroubleshooting = false;
  let tableHeaderCols = null;
  let tableStartLine = 0;
  const h2 = [];

  lines.forEach((raw, i) => {
    const n = i + 1;
    if (/^\s*```/.test(raw)) {
      if (!inFence) fenceStart = n;
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    if (SWEDISH.test(raw)) add(n, 'error', 'english-only', 'the guide is English only');
    if (/<!--\s*tabs:start/.test(raw)) tabsStart++;
    if (/<!--\s*tabs:end/.test(raw)) tabsEnd++;
    if (/<details/i.test(raw)) add(n, 'error', 'details', '<details> folding is not used; write a short "Technical Architecture" subsection instead');

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      const title = heading[2];
      if (EMOJI.test(title)) add(n, 'error', 'heading-emoji', 'no emoji in headings');
      if (/^(purpose|how to use|limitations\s*(&|and)\s*caveats|technical internals\s*(&|and)\s*architecture)\b/i.test(title.replace(/[^\p{L}\p{N}&\s]/gu, '').trim())) {
        add(n, 'error', 'legacy-block', 'per-feature Purpose / How to Use / Limitations blocks are retired; use tables and callouts');
      }
      if (/troubleshooting/i.test(title)) sawTroubleshooting = true;
      if (heading[1] === '##') h2.push({ n, title });
    }

    if (/^\s+>\s*\[!/.test(raw)) add(n, 'error', 'callout-in-list', 'a callout indented under a list item is not rendered; end the list or use bold text');
    for (const m of raw.matchAll(/\[!([A-Za-z]+)\]/g)) {
      if (/^\s*>\s*\[!/.test(raw) && !CALLOUT_TYPES.has(m[1])) add(n, 'error', 'callout-type', `unknown callout type [!${m[1]}]`);
    }

    const plain = stripInlineCode(raw);

    for (const m of plain.matchAll(/<\/?([A-Za-z][\w-]*)(\s[^>]*)?>/g)) {
      if (!ALLOWED_TAGS.has(m[1].toLowerCase())) add(n, 'error', 'bare-tag', `<${m[1]}> outside backticks disappears when rendered; put it in \`code\``);
    }

    for (const m of plain.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^\.{0,2}\/?[\w./-]*\.md(#.*)?$/.test(target) && !/^https?:/.test(target)) add(n, 'error', 'relative-md-link', `link "${target}" points at a .md file, which does not exist on the site; use the page URL`);
      const docs = /^\/docs\/([^#?]*?)\/?(#.*)?$/.exec(target);
      if (docs) {
        const slug = docs[1];
        if (LEGACY_SLUGS.includes(slug)) add(n, 'error', 'legacy-link', `"${target}" is an old flat URL; link the category URL`);
        else if (ctx.knownPages && slug !== '' && !ctx.knownPages.has(slug)) add(n, 'error', 'unknown-page', `"${target}" is not a page in the site registry`);
      }
    }

    if (ctx.images) {
      for (const m of raw.matchAll(/\/img\/(?:docs\/)?([\w.-]+\.(?:png|svg|mp4|webm|gif))/g)) {
        if (!ctx.images.has(m[1])) add(n, 'error', 'missing-image', `${m[1]} is not in docs/screenshots`);
      }
    }

    if (ctx.shortcuts) {
      for (const combo of kbdCombos(raw)) {
        if (/^Ctrl\+(Alt\+)?Shift\+[A-Z]$/.test(combo) && !ctx.shortcuts.has(combo) && !EXTRA_SHORTCUTS.has(combo)) {
          add(n, 'error', 'unknown-shortcut', `${combo} is not a default shortcut in settings.ts`);
        }
      }
    }

    if (/^\s*\|/.test(raw)) {
      const cols = columnCount(raw);
      if (tableHeaderCols === null) {
        tableHeaderCols = cols;
        tableStartLine = n;
      } else if (cols !== tableHeaderCols) {
        add(n, 'error', 'table-columns', `row has ${cols} columns, the table starting at line ${tableStartLine} has ${tableHeaderCols}`);
      }
    } else {
      tableHeaderCols = null;
    }
  });

  if (inFence) add(fenceStart, 'error', 'unclosed-fence', 'code fence is never closed');
  if (tabsStart !== tabsEnd) add(1, 'error', 'tabs-balance', `<!-- tabs:start --> (${tabsStart}) and <!-- tabs:end --> (${tabsEnd}) do not match`);

  h2.slice(1).forEach(({ n, title }) => {
    if (!/^\d+\.\s/.test(title) && !/^next steps$/i.test(title)) add(n, 'warn', 'numbered-sections', `section "${title}" should be numbered ("## N. …")`);
  });
  if (!sawTroubleshooting && !NO_TROUBLESHOOTING.has(file) && file !== 'README.md') {
    add(lines.length, 'warn', 'troubleshooting', 'no "Troubleshooting & Diagnostics" section (the last section of a page)');
  }

  return findings;
}

/** Default shortcuts from settings.ts, normalized like kbdCombos (`Ctrl+Shift+D`). */
export function parseShortcuts(settingsSource) {
  const set = new Set();
  for (const m of settingsSource.matchAll(/defaultKeys:\s*'([^']+)'/g)) set.add(m[1]);
  return set;
}

/** Page slugs (`workspace/terminal`) from the site's MODULES registry. */
export function parseRegistrySlugs(buildDocsSource) {
  const set = new Set();
  for (const m of buildDocsSource.matchAll(/fullSlug:\s*'([^']+)'/g)) set.add(m[1]);
  return set;
}

function main(args) {
  const strict = args.includes('--strict');
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const guideDir = path.join(rootDir, 'docs', 'user-guide');
  const requested = args.filter((a) => !a.startsWith('--'));
  const files = (requested.length ? requested.map((f) => path.basename(f)) : readdirSync(guideDir).filter((f) => f.endsWith('.md'))).sort();

  const settingsFile = path.join(rootDir, 'src', 'shared', 'types', 'settings.ts');
  const shortcuts = existsSync(settingsFile) ? parseShortcuts(readFileSync(settingsFile, 'utf8')) : null;
  const shotsDir = path.join(rootDir, 'docs', 'screenshots');
  const images = existsSync(shotsDir) ? new Set(readdirSync(shotsDir)) : null;
  const siteDir = process.env.SSHS3_SITE_DIR || path.join(rootDir, '..', 'sshs3-site');
  const registryFile = path.join(siteDir, 'scripts', 'build-docs.js');
  const knownPages = existsSync(registryFile) ? parseRegistrySlugs(readFileSync(registryFile, 'utf8')) : null;
  if (!knownPages) console.log('docs-lint: sshs3-site checkout not found, skipping the page-link target check');

  let errors = 0;
  let warnings = 0;
  for (const file of files) {
    // README.md describes the conventions (and quotes the retired patterns), so it only gets the structural checks.
    const isReadme = file === 'README.md';
    const text = readFileSync(path.join(guideDir, file), 'utf8');
    const findings = isReadme
      ? lintDoc(file, text, {}).filter((f) => ['unclosed-fence', 'table-columns', 'english-only'].includes(f.rule))
      : lintDoc(file, text, { knownPages, shortcuts, images });
    for (const f of findings) {
      console.log(`${f.level === 'error' ? 'error' : 'warn '} ${f.file}:${f.line} [${f.rule}] ${f.message}`);
      if (f.level === 'error') errors++;
      else warnings++;
    }
  }
  console.log(`docs-lint: ${files.length} files, ${errors} errors, ${warnings} warnings`);
  if (errors > 0 || (strict && warnings > 0)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
