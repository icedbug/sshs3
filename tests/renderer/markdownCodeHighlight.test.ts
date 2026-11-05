import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { getLanguageExtension } from '../../src/renderer/src/components/Editor/editorLanguages';
import {
  MAX_HIGHLIGHT_CHARS,
  codeToCopy,
  highlightCode,
  readCodeBlock,
} from '../../src/renderer/src/lib/markdownCodeHighlight';

vi.mock('../../src/renderer/src/components/Editor/editorLanguages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/components/Editor/editorLanguages')>();
  return { ...actual, getLanguageExtension: vi.fn(actual.getLanguageExtension) };
});

const joined = (code: string, lang: string) => highlightCode(code, lang)?.map((s) => s.text).join('');

describe('highlightCode', () => {
  it('colours shell code and gives back exactly the same text', () => {
    const code = 'ssh user@host -p 22 # connect\necho "hej"\n';
    const segments = highlightCode(code, 'bash');
    expect(segments).not.toBeNull();
    expect(segments!.map((s) => s.text).join('')).toBe(code);
    expect(segments!.some((s) => s.className?.includes('tok-comment'))).toBe(true);
    expect(segments!.some((s) => s.className?.includes('tok-string'))).toBe(true);
  });

  it('never changes the text, whatever the language or content', () => {
    const samples: Array<[string, string]> = [
      ['const x: number = 1; // c\nfunction f() { return `a${x}`; }', 'ts'],
      ['name: web\nports:\n  - 8080 # http\n', 'yaml'],
      ['{"a": [1, true, null], "b": "\\u00e5"}', 'json'],
      ['def f(x):\n    return x * 2  # åäö\n', 'python'],
      ['FROM alpine:3.20\nRUN apk add curl\n', 'dockerfile'],
      ['  leading spaces\ttabs\r\nand CRLF\r\n', 'bash'],
    ];
    for (const [code, lang] of samples) expect(joined(code, lang)).toBe(code);
  });

  it('understands the usual fence names', () => {
    for (const lang of ['bash', 'sh', 'shell', 'zsh', 'typescript', 'ts', 'javascript', 'js', 'python', 'py', 'yaml', 'yml', 'json', 'dockerfile', 'sql', 'go', 'rust', 'html', 'BASH']) {
      expect(highlightCode('x = 1', lang), lang).not.toBeNull();
    }
  });

  it('returns null, meaning plain text, for unknown or missing languages and for odd fence names', () => {
    expect(highlightCode('some text', undefined)).toBeNull();
    expect(highlightCode('some text', 'text')).toBeNull();
    expect(highlightCode('some text', 'no-such-language')).toBeNull();
    expect(highlightCode('some text', '../../etc/passwd')).toBeNull();
    expect(highlightCode('some text', '')).toBeNull();
    expect(highlightCode('', 'bash')).toBeNull();
  });

  it('does not parse very large blocks', () => {
    expect(highlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'bash')).toBeNull();
    expect(highlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS), 'bash')).not.toBeNull();
  });
});

describe('highlightCode language cache', () => {
  it('builds the language of a fence only once, however many blocks use it', () => {
    vi.mocked(getLanguageExtension).mockClear();
    for (let i = 0; i < 5; i++) expect(highlightCode(`key = ${i}`, 'toml')).not.toBeNull();
    expect(getLanguageExtension).toHaveBeenCalledTimes(1);
  });

  it('remembers that a language is unknown too', () => {
    vi.mocked(getLanguageExtension).mockClear();
    for (let i = 0; i < 3; i++) expect(highlightCode('text', 'cache-test-unknown')).toBeNull();
    expect(getLanguageExtension).toHaveBeenCalledTimes(1);
  });

  it('gives the same colours the second time as the first', () => {
    const first = highlightCode('echo "a" # b', 'sh');
    const second = highlightCode('echo "a" # b', 'sh');
    expect(second).toEqual(first);
  });
});

describe('readCodeBlock', () => {
  it('reads the text and the fence language from the code element', () => {
    const code = createElement('code', { className: 'language-bash' }, 'ls -la\n');
    expect(readCodeBlock(code)).toEqual({ code: 'ls -la\n', lang: 'bash' });
  });

  it('reports no language for a fence without one', () => {
    expect(readCodeBlock(createElement('code', null, 'plain\n'))).toEqual({ code: 'plain\n', lang: undefined });
  });

  it('returns null for anything that is not a code element with text', () => {
    expect(readCodeBlock('just text')).toBeNull();
    expect(readCodeBlock(null)).toBeNull();
    expect(readCodeBlock(createElement('code', null, createElement('b', null, 'x')))).toBeNull();
  });
});

describe('codeToCopy', () => {
  it('drops only the newline that ends a fenced block', () => {
    expect(codeToCopy('a\nb\n')).toBe('a\nb');
    expect(codeToCopy('a\r\n')).toBe('a');
    expect(codeToCopy('a\n\n')).toBe('a\n');
    expect(codeToCopy('no newline')).toBe('no newline');
  });
});
