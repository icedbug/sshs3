import { Children, isValidElement, type ReactNode } from 'react';
import { Language, LanguageSupport } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { Parser } from '@lezer/common';
import { classHighlighter, highlightTree } from '@lezer/highlight';
import { getLanguageExtension } from '../components/Editor/editorLanguages';

/** A run of code text, with the `tok-*` classes of its syntax token when it has one. */
export interface CodeSegment {
  text: string;
  className?: string;
}

/** Larger blocks are shown as plain text: parsing them would block the UI for no real gain. */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/** Fence names that are not a file extension the editor already knows. */
const FENCE_ALIASES: Record<string, string> = {
  bash: 'sh',
  shell: 'sh',
  zsh: 'sh',
  typescript: 'ts',
  javascript: 'js',
  node: 'js',
  python: 'py',
  python3: 'py',
  yaml: 'yml',
  rust: 'rs',
  golang: 'go',
  'c++': 'cpp',
  markdown: 'md',
};

/** The file name the editor's language lookup needs for a fence such as ```bash. */
function fileNameForFence(lang: string): string | null {
  const name = lang.trim().toLowerCase();
  if (!/^[a-z0-9+#.-]{1,20}$/.test(name)) return null;
  if (name === 'dockerfile') return 'Dockerfile';
  if (name === 'nginx') return 'site.nginx';
  return `code.${FENCE_ALIASES[name] ?? name}`;
}

function parserOf(extension: Extension | null): Parser | null {
  if (extension instanceof LanguageSupport) return extension.language.parser;
  if (extension instanceof Language) return extension.parser;
  return null;
}

/**
 * The parser of each file name asked for so far. Building a language is not free (each call to
 * getLanguageExtension defines a new one) and a README repeats the same few languages; unknown
 * languages are remembered too.
 */
const parserCache = new Map<string, Parser | null>();

function parserForFile(fileName: string): Parser | null {
  const cached = parserCache.get(fileName);
  if (cached !== undefined) return cached;
  const parser = parserOf(getLanguageExtension(fileName));
  parserCache.set(fileName, parser);
  return parser;
}

/**
 * Splits `code` into syntax-coloured segments using the same languages as the editor, or returns
 * null when the language is unknown, the block is large or anything goes wrong. The segments always
 * join back to exactly `code`; if they ever would not, null is returned so that what is shown and
 * copied is never altered.
 */
export function highlightCode(code: string, lang: string | undefined): CodeSegment[] | null {
  if (!lang || !code || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const fileName = fileNameForFence(lang);
  if (!fileName) return null;
  const parser = parserForFile(fileName);
  if (!parser) return null;

  try {
    const tree = parser.parse(code);
    const segments: CodeSegment[] = [];
    let pos = 0;
    highlightTree(tree, classHighlighter, (from, to, classes) => {
      if (from < pos || to <= from) return;
      if (from > pos) segments.push({ text: code.slice(pos, from) });
      segments.push({ text: code.slice(from, to), className: classes });
      pos = to;
    });
    if (pos < code.length) segments.push({ text: code.slice(pos) });
    return segments.map((s) => s.text).join('') === code ? segments : null;
  } catch {
    return null;
  }
}

/** The text and fence language of the `<code>` element react-markdown puts inside a `<pre>`. */
export function readCodeBlock(children: ReactNode): { code: string; lang: string | undefined } | null {
  const child = Children.toArray(children)[0];
  if (!isValidElement(child)) return null;
  const props = child.props as { className?: unknown; children?: ReactNode };
  if (typeof props.children !== 'string') return null;
  const className = typeof props.className === 'string' ? props.className : '';
  const lang = /(?:^|\s)language-(\S+)/.exec(className)?.[1];
  return { code: props.children, lang };
}

/** What the copy button puts on the clipboard: the code without the newline that ends a fenced block. */
export function codeToCopy(code: string): string {
  return code.replace(/\r?\n$/, '');
}
