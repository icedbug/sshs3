import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Helpers for the tests that scan the renderer's JSX source for accessibility patterns. */

export const COMPONENTS_ROOT = join(__dirname, '../../src/renderer/src/components');

export function tsxFiles(dir: string = COMPONENTS_ROOT): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? tsxFiles(full) : full.endsWith('.tsx') ? [full] : [];
  });
}

export function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Index of the `>` that closes the tag whose attributes start at `from` (skips braces and quotes), or -1. */
export function tagEnd(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

/** Text of an element's content with every nested tag removed; what is left is text and `{expressions}`. */
export function withoutTags(content: string): string {
  let out = '';
  for (let i = 0; i < content.length; ) {
    if (content[i] === '<') {
      const end = tagEnd(content, i + 1);
      if (end < 0) break;
      i = end + 1;
    } else {
      out += content[i++];
    }
  }
  return out;
}

export function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}
