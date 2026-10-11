import { describe, it, expect } from 'vitest';
import {
  MAX_COMBINING_MARKS,
  MAX_COMMAND_LINES,
  MAX_COMMAND_CHARS,
  MAX_MULTILINE_COMMAND_CHARS,
  checkSuggestedCommand,
  neutralizeText,
  showHiddenCharacters,
  type CommandCheckOptions,
  type CommandRejection,
} from '../../src/shared/aiCommand';

const MULTI: CommandCheckOptions = { allowMultiline: true };

const LOOP = 'for f in *.log; do\n  gzip "$f"\ndone';

describe('checkSuggestedCommand accepts', () => {
  const cases: Array<{ name: string; text: string; options?: CommandCheckOptions; command: string; lineCount: number }> = [
    { name: 'a plain command', text: 'ls -la', command: 'ls -la', lineCount: 1 },
    {
      name: 'a pipeline with quotes',
      text: `ps aux | grep -i 'ssh' | awk '{print $2}' | xargs -r echo "pid: {}"`,
      command: `ps aux | grep -i 'ssh' | awk '{print $2}' | xargs -r echo "pid: {}"`,
      lineCount: 1,
    },
    { name: 'an emoji with a variation selector', text: 'echo \u2764\uFE0F', command: 'echo \u2764\uFE0F', lineCount: 1 },
    { name: 'visible non-ASCII text', text: 'echo "blåbär äpple öl é 日本語 😀"', command: 'echo "blåbär äpple öl é 日本語 😀"', lineCount: 1 },
    { name: 'an emoji with a text variation selector', text: 'echo ❤︎', command: 'echo ❤︎', lineCount: 1 },
    { name: 'a keycap emoji', text: 'echo 1️⃣ #️⃣ *⃣', command: 'echo 1️⃣ #️⃣ *⃣', lineCount: 1 },
    { name: 'a flag and a skin tone emoji', text: 'echo \u{1F1F8}\u{1F1EA} \u{1F44D}\u{1F3FD}', command: 'echo \u{1F1F8}\u{1F1EA} \u{1F44D}\u{1F3FD}', lineCount: 1 },
    { name: 'decomposed Swedish letters', text: 'echo å ä ö', command: 'echo å ä ö', lineCount: 1 },
    { name: 'stacked marks of a Vietnamese letter', text: 'echo ệ', command: 'echo ệ', lineCount: 1 },
    { name: 'a Thai syllable with vowel and tone marks', text: 'echo กิ่', command: 'echo กิ่', lineCount: 1 },
    {
      name: 'exactly MAX_COMBINING_MARKS marks on one letter',
      text: `echo e${'́'.repeat(MAX_COMBINING_MARKS)}`,
      command: `echo e${'́'.repeat(MAX_COMBINING_MARKS)}`,
      lineCount: 1,
    },
    { name: 'a trailing newline, which is removed', text: 'ls -la\n', command: 'ls -la', lineCount: 1 },
    { name: 'a trailing run of LF and CRLF, which is removed', text: 'ls -la\r\n\n\r\n', command: 'ls -la', lineCount: 1 },
    { name: 'leading and trailing spaces, which are kept', text: '  ls -la  ', command: '  ls -la  ', lineCount: 1 },
    { name: 'a 3-line for-loop when multiline is allowed', text: LOOP, options: MULTI, command: LOOP, lineCount: 3 },
    { name: 'a 3-line for-loop with trailing newline', text: `${LOOP}\n`, options: MULTI, command: LOOP, lineCount: 3 },
    { name: 'a single line when multiline is allowed', text: 'pwd', options: MULTI, command: 'pwd', lineCount: 1 },
    {
      name: 'exactly MAX_COMMAND_CHARS characters',
      text: 'a'.repeat(MAX_COMMAND_CHARS),
      command: 'a'.repeat(MAX_COMMAND_CHARS),
      lineCount: 1,
    },
    {
      name: 'MAX_COMMAND_CHARS characters followed by a newline',
      text: `${'a'.repeat(MAX_COMMAND_CHARS)}\n`,
      command: 'a'.repeat(MAX_COMMAND_CHARS),
      lineCount: 1,
    },
    {
      name: 'a longer text when multiline is allowed, up to the multiline limit',
      text: 'a'.repeat(MAX_MULTILINE_COMMAND_CHARS),
      options: MULTI,
      command: 'a'.repeat(MAX_MULTILINE_COMMAND_CHARS),
      lineCount: 1,
    },
  ];

  it.each(cases)('$name', ({ text, options, command, lineCount }) => {
    expect(checkSuggestedCommand(text, options)).toEqual({ ok: true, command, lineCount, requiresBracketedPaste: lineCount > 1 });
  });
});

describe('checkSuggestedCommand rejects', () => {
  const cases: Array<{ name: string; text: string; options?: CommandCheckOptions; reason: CommandRejection }> = [
    {
      name: 'the bracketed paste escape exploit',
      text: 'ls\u001b[201~\rid > /tmp/pwned\r\u001b[200~',
      reason: 'control-characters',
    },
    { name: 'a lone CR', text: 'ls\r-la', reason: 'control-characters' },
    { name: 'a CR as the final character after other text', text: 'ls\r', reason: 'control-characters' },
    { name: 'CRLF in the middle', text: 'ls\r\nid', reason: 'control-characters' },
    { name: 'CRLF in the middle when multiline is allowed', text: 'ls\r\nid', options: MULTI, reason: 'control-characters' },
    { name: 'ESC when multiline is allowed', text: 'ls\n\u001b[2J', options: MULTI, reason: 'control-characters' },
    { name: 'NUL', text: 'ls\u0000-la', reason: 'control-characters' },
    { name: 'TAB', text: 'ls\t-la', reason: 'control-characters' },
    { name: 'Ctrl-C', text: 'ls\u0003', reason: 'control-characters' },
    { name: 'Ctrl-D', text: 'cat\u0004', reason: 'control-characters' },
    { name: 'backspace', text: 'ls -la\u0008x', reason: 'control-characters' },
    { name: 'DEL', text: 'ls\u007f-la', reason: 'control-characters' },
    { name: 'U+009B (single-byte CSI)', text: 'ls\u009b2J', reason: 'control-characters' },
    { name: 'U+0085 (NEL)', text: 'ls\u0085id', reason: 'control-characters' },
    { name: 'U+2028 (line separator)', text: 'ls\u{2028}id', reason: 'hidden-characters' },
    { name: 'U+2029 (paragraph separator)', text: 'ls\u{2029}id', reason: 'hidden-characters' },
    { name: 'U+202E (right-to-left override)', text: 'echo \u{202E}txt.exe', reason: 'hidden-characters' },
    { name: 'U+2066 (left-to-right isolate)', text: 'echo \u{2066}x', reason: 'hidden-characters' },
    { name: 'U+200B (zero-width space)', text: 'ls\u{200B}-la', reason: 'hidden-characters' },
    { name: 'U+200D (zero-width joiner)', text: 'echo \u{1F468}\u{200D}\u{1F469}', reason: 'hidden-characters' },
    { name: 'U+FEFF (BOM)', text: '\u{FEFF}ls -la', reason: 'hidden-characters' },
    { name: 'U+00AD (soft hyphen)', text: 'ls\u{AD} -la', reason: 'hidden-characters' },
    { name: 'a tag character', text: 'ls\u{E0041}', reason: 'hidden-characters' },
    { name: 'NBSP', text: 'ls\u{A0}-la', reason: 'hidden-characters' },
    { name: 'U+2003 (em space)', text: 'ls\u{2003}-la', reason: 'hidden-characters' },
    { name: 'U+202F (narrow NBSP)', text: 'ls\u{202F}-la', reason: 'hidden-characters' },
    { name: 'U+3000 (ideographic space)', text: 'ls\u{3000}-la', reason: 'hidden-characters' },
    { name: 'a lone high surrogate', text: 'ls\ud800-la', reason: 'hidden-characters' },
    { name: 'a lone low surrogate', text: 'ls\udc00-la', reason: 'hidden-characters' },
    { name: 'a private-use character', text: 'ls\u{E000}-la', reason: 'hidden-characters' },
    { name: 'an unassigned code point', text: 'ls\u{378}-la', reason: 'hidden-characters' },
    { name: 'a noncharacter', text: 'ls\u{FFFF}', reason: 'hidden-characters' },
    { name: 'a Hangul filler', text: 'ls\u{3164}-la', reason: 'hidden-characters' },
    { name: 'a Braille blank', text: 'ls\u{2800}-la', reason: 'hidden-characters' },
    { name: 'a supplementary variation selector', text: 'ls\u{E0100}', reason: 'hidden-characters' },
    { name: 'a combining grapheme joiner', text: 'ls\u{34F}-la', reason: 'hidden-characters' },
    { name: 'U+200C (zero-width non-joiner), also where a script needs it', text: 'echo می‌خواهم', reason: 'hidden-characters' },
    { name: 'variation selector 1 after ASCII', text: 'ls\u{FE00} -la', reason: 'hidden-characters' },
    { name: 'variation selector 15 after ASCII', text: 'ls\u{FE0E}', reason: 'hidden-characters' },
    { name: 'variation selector 16 after ASCII', text: 'ls\u{FE0F}', reason: 'hidden-characters' },
    { name: 'variation selector 16 at the start', text: '\u{FE0F}ls', reason: 'hidden-characters' },
    { name: 'a Mongolian free variation selector four', text: 'ls\u{180F}', reason: 'hidden-characters' },
    { name: 'variation selector 1 after an emoji', text: 'echo ❤︀', reason: 'hidden-characters' },
    { name: 'two emoji variation selectors in a row', text: 'echo ❤️️', reason: 'hidden-characters' },
    { name: 'an emoji variation selector after a space', text: 'echo ❤ ️', reason: 'hidden-characters' },
    { name: 'an emoji variation selector after a digit without the keycap mark', text: 'echo 1️', reason: 'hidden-characters' },
    { name: 'a text variation selector in a keycap', text: 'echo 1︎⃣', reason: 'hidden-characters' },
    { name: 'an emoji variation selector before a trailing newline', text: 'echo 1️\n', reason: 'hidden-characters' },
    { name: 'a Khitan filler', text: 'ls\u{16FE4}-la', reason: 'hidden-characters' },
    { name: 'an ideographic half fill space', text: 'ls\u{303F}-la', reason: 'hidden-characters' },
    { name: 'the object replacement character', text: 'ls\u{FFFC}-la', reason: 'hidden-characters' },
    { name: 'a musical null notehead', text: 'ls\u{1D159}-la', reason: 'hidden-characters' },
    { name: 'an Egyptian hieroglyph full blank', text: 'ls\u{13441}-la', reason: 'hidden-characters' },
    { name: 'an Egyptian hieroglyph half blank', text: 'ls\u{13442}-la', reason: 'hidden-characters' },
    { name: 'a combining stroke overlay on every letter', text: `echo ok; ${[...'rm -rf ~'].map((c) => `${c}̶`).join('')}`, reason: 'hidden-characters' },
    { name: 'a combining long solidus overlay', text: 'echo ≠', reason: 'hidden-characters' },
    { name: 'a combining enclosing circle backslash', text: 'echo r⃠m⃠', reason: 'hidden-characters' },
    { name: 'a keycap mark that does not follow a keycap base', text: 'echo a⃣', reason: 'hidden-characters' },
    { name: 'one more than MAX_COMBINING_MARKS marks', text: `echo e${'́'.repeat(MAX_COMBINING_MARKS + 1)}`, reason: 'hidden-characters' },
    { name: '900 combining marks on one letter', text: `ls${'́'.repeat(900)}`, reason: 'hidden-characters' },
    { name: 'a combining mark at the start of the text', text: '́ls', reason: 'hidden-characters' },
    { name: 'a combining mark after a space', text: 'ls ́-la', reason: 'hidden-characters' },
    { name: 'a combining mark at the start of a line', text: 'ls\ńid', options: MULTI, reason: 'hidden-characters' },
    { name: 'MAX_COMMAND_CHARS + 1 characters', text: 'a'.repeat(MAX_COMMAND_CHARS + 1), reason: 'too-long' },
    {
      name: 'MAX_MULTILINE_COMMAND_CHARS + 1 characters when multiline is allowed',
      text: 'a'.repeat(MAX_MULTILINE_COMMAND_CHARS + 1),
      options: MULTI,
      reason: 'too-long',
    },
    { name: 'an empty string', text: '', reason: 'empty' },
    { name: 'only spaces', text: '   ', reason: 'empty' },
    { name: 'only line breaks', text: '\n\r\n\n', reason: 'empty' },
    { name: 'only whitespace and a line break', text: ' \t \n', reason: 'empty' },
    { name: 'two lines without allowMultiline', text: 'ls\nid', reason: 'multiple-lines' },
    { name: 'a second line holding only a space', text: 'ls\n \n', reason: 'multiple-lines' },
    { name: 'two lines with allowMultiline false', text: 'ls\nid', options: { allowMultiline: false }, reason: 'multiple-lines' },
  ];

  it.each(cases)('$name', ({ text, options, reason }) => {
    const result = checkSuggestedCommand(text, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      // A short user-facing sentence in printable ASCII: it never echoes the offending characters.
      expect(result.message).toMatch(/^[\x20-\x7e]{10,}$/);
      expect(result.message.endsWith('.')).toBe(true);
    }
  });

  it('never echoes the checked text in the message', () => {
    const result = checkSuggestedCommand('rm-secret-marker\u001b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('rm-secret-marker');
  });

  it('puts control characters before hidden characters', () => {
    const result = checkSuggestedCommand('a\u{200B}\u001bb');
    expect(result).toMatchObject({ ok: false, reason: 'control-characters' });
  });

  it('rejects a non-string value as empty instead of throwing', () => {
    expect(checkSuggestedCommand(undefined as unknown as string)).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('checkSuggestedCommand length limit', () => {
  const EMOJI = '\u{1F600}';

  it('counts code points, so characters outside the BMP count once', () => {
    expect(checkSuggestedCommand(EMOJI.repeat(MAX_COMMAND_CHARS))).toMatchObject({ ok: true });
    expect(checkSuggestedCommand(`echo ${EMOJI.repeat(MAX_COMMAND_CHARS - 5)}`)).toMatchObject({ ok: true });
    expect(checkSuggestedCommand(`echo ${EMOJI.repeat(501)}`)).toMatchObject({ ok: true });
    expect(checkSuggestedCommand(`${'a'.repeat(100)}${EMOJI.repeat(MAX_COMMAND_CHARS - 100)}`)).toMatchObject({ ok: true });
  });

  it('rejects one code point over the limit, however it is encoded', () => {
    expect(checkSuggestedCommand(EMOJI.repeat(MAX_COMMAND_CHARS + 1))).toMatchObject({ ok: false, reason: 'too-long' });
    expect(checkSuggestedCommand(`echo ${EMOJI.repeat(MAX_COMMAND_CHARS - 4)}`)).toMatchObject({ ok: false, reason: 'too-long' });
    expect(checkSuggestedCommand(`${'a'.repeat(MAX_COMMAND_CHARS)}${EMOJI}`)).toMatchObject({ ok: false, reason: 'too-long' });
    expect(checkSuggestedCommand('日'.repeat(MAX_COMMAND_CHARS + 1))).toMatchObject({ ok: false, reason: 'too-long' });
    expect(checkSuggestedCommand('a'.repeat(MAX_COMMAND_CHARS * 2 + 1))).toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('applies the same counting to the multiline limit', () => {
    expect(checkSuggestedCommand(EMOJI.repeat(MAX_MULTILINE_COMMAND_CHARS), MULTI)).toMatchObject({ ok: true });
    expect(checkSuggestedCommand(EMOJI.repeat(MAX_MULTILINE_COMMAND_CHARS + 1), MULTI)).toMatchObject({ ok: false, reason: 'too-long' });
  });

  it('names a limit in the message that agrees with the count', () => {
    const result = checkSuggestedCommand(EMOJI.repeat(MAX_COMMAND_CHARS + 1));
    expect(result).toMatchObject({ ok: false, reason: 'too-long' });
    if (!result.ok) expect(result.message).toContain(`${MAX_COMMAND_CHARS} characters`);
  });
});

describe('checkSuggestedCommand options', () => {
  it('treats null like omitted options', () => {
    expect(checkSuggestedCommand('ls', null)).toEqual({ ok: true, command: 'ls', lineCount: 1, requiresBracketedPaste: false });
    expect(checkSuggestedCommand('ls\nid', null)).toMatchObject({ ok: false, reason: 'multiple-lines' });
  });

  it('treats undefined like omitted options', () => {
    expect(checkSuggestedCommand('ls\nid', undefined)).toMatchObject({ ok: false, reason: 'multiple-lines' });
  });

  it('allows several lines only for the boolean true', () => {
    for (const value of ['true', 1, {}, [], 'yes']) {
      const options = { allowMultiline: value } as unknown as CommandCheckOptions;
      expect(checkSuggestedCommand('ls\nid', options)).toMatchObject({ ok: false, reason: 'multiple-lines' });
    }
    expect(checkSuggestedCommand('ls\nid', 5 as unknown as CommandCheckOptions)).toMatchObject({ ok: false, reason: 'multiple-lines' });
  });
});

describe('checkSuggestedCommand requiresBracketedPaste', () => {
  // xterm turns LF into CR when it pastes. Outside bracketed paste mode that CR
  // presses Enter, so a result with several lines is only safe inside it.
  it('is false for a single line, also when several lines are allowed', () => {
    expect(checkSuggestedCommand('ls -la')).toMatchObject({ ok: true, requiresBracketedPaste: false });
    expect(checkSuggestedCommand('ls -la\n')).toMatchObject({ ok: true, requiresBracketedPaste: false });
    expect(checkSuggestedCommand('ls -la', MULTI)).toMatchObject({ ok: true, requiresBracketedPaste: false });
    expect(checkSuggestedCommand('ls -la\n', MULTI)).toMatchObject({ ok: true, requiresBracketedPaste: false });
  });

  it('is true for two or more lines', () => {
    expect(checkSuggestedCommand('echo a\necho b', MULTI)).toEqual({
      ok: true,
      command: 'echo a\necho b',
      lineCount: 2,
      requiresBracketedPaste: true,
    });
    expect(checkSuggestedCommand(LOOP, MULTI)).toMatchObject({ ok: true, lineCount: 3, requiresBracketedPaste: true });
  });

  it('is true for a leading line break, which would press Enter on whatever is typed already', () => {
    expect(checkSuggestedCommand('\nrm x', MULTI)).toMatchObject({ ok: true, lineCount: 2, requiresBracketedPaste: true });
  });

  it('is true exactly when the command holds a line break', () => {
    for (const text of ['a', 'a\nb', '\na', 'a\n\nb', 'a\n b', 'a\n\n\nb']) {
      const result = checkSuggestedCommand(text, MULTI);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.requiresBracketedPaste).toBe(result.command.includes('\n'));
    }
  });
});

describe('checkSuggestedCommand only removes one trailing run of line breaks', () => {
  it('returns exactly the checked text', () => {
    const text = '  echo hi  \n\n';
    const result = checkSuggestedCommand(text);
    expect(result).toEqual({ ok: true, command: '  echo hi  ', lineCount: 1, requiresBracketedPaste: false });
  });

  it('stops the trailing run at the first character that is not a line break', () => {
    expect(checkSuggestedCommand('ls\n \n', MULTI)).toEqual({
      ok: true,
      command: 'ls\n ',
      lineCount: 2,
      requiresBracketedPaste: true,
    });
  });

  it('handles a very long run of line breaks in linear time', () => {
    const started = Date.now();
    const result = checkSuggestedCommand(`${'\n'.repeat(200000)}x`);
    expect(result).toMatchObject({ ok: false, reason: 'too-long' });
    expect(checkSuggestedCommand(`ls${'\r\n'.repeat(200000)}`)).toMatchObject({ ok: true, command: 'ls' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('checkSuggestedCommand line limit', () => {
  it('accepts up to MAX_COMMAND_LINES lines and refuses more', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `echo ${i}`).join('\n');
    expect(checkSuggestedCommand(lines(MAX_COMMAND_LINES), MULTI).ok).toBe(true);
    const over = checkSuggestedCommand(lines(MAX_COMMAND_LINES + 1), MULTI);
    expect(over).toMatchObject({ ok: false, reason: 'too-many-lines' });
  });
});

describe('neutralizeText', () => {
  it('keeps line breaks and tabs and shows everything else a command would be refused for', () => {
    expect(neutralizeText('a\n\tb \u202E c\u001b[201~\r d\u200Be')).toBe('a\n\tb <U+202E> c<ESC>[201~<CR> d<U+200B>e');
  });

  it('leaves ordinary text and emoji alone', () => {
    expect(neutralizeText('Use `ls -la`.\n1. Done ✔ 🎉')).toBe('Use `ls -la`.\n1. Done ✔ 🎉');
  });
});

describe('showHiddenCharacters', () => {
  const rejectedSamples: string[] = [
    'ls\u001b[201~\rid > /tmp/pwned\r\u001b[200~',
    'ls\r-la',
    'ls\r\nid',
    'ls\u0000-la',
    'ls\t-la',
    'cat\u0004',
    'ls\u007f-la',
    'ls\u009b2J',
    'ls\u0085id',
    'ls\u{2028}id',
    'ls\u{2029}id',
    'echo \u{202E}txt.exe',
    'ls\u{200B}-la',
    '\u{FEFF}ls -la',
    'ls\u{A0}-la',
    'ls\u{3000}-la',
    'ls\ud800-la',
    'ls\u{E000}-la',
    'ls\u{378}-la',
    'echo \u{1F468}\u{200D}\u{1F469}',
    'ls\u{E0041}',
    'ls\nid',
    LOOP,
    '',
    '   ',
    'a'.repeat(MAX_COMMAND_CHARS + 1),
    'ls\u{FE00} -la',
    'ls\u{FE0F}',
    'ls\u{180F}',
    '1\u{FE0F}',
    '1\u{FE0F}\u{20E3}\u{20E3}',
    '❤\u{FE0F}\u{FE0F}\u{FE0F}',
    'ls\u{16FE4}\u{303F}\u{FFFC}\u{1D159}\u{13441}\u{13442}-la',
    'echo ok; r̶m̶ ̶-̶r̶f̶',
    'echo r⃠m⃠',
    `ls${'́'.repeat(900)}`,
    '́ls ́id\ńx',
    'ls\ń́',
  ];

  it.each(rejectedSamples.map((sample, index) => ({ index, sample })))(
    'output for rejected sample #$index is free of rejected characters',
    ({ sample }) => {
      const shown = showHiddenCharacters(sample);
      // \p{Cc} covers the C0 and C1 controls including line breaks.
      expect(shown).not.toMatch(/\p{Cc}/u);
      const result = checkSuggestedCommand(shown, MULTI);
      if (!result.ok) {
        expect(['empty', 'too-long', 'multiple-lines']).toContain(result.reason);
      }
      // Without multiline the shown text is a single line as well, because line breaks are replaced.
      const single = checkSuggestedCommand(shown);
      if (!single.ok) expect(['empty', 'too-long']).toContain(single.reason);
    },
  );

  it('uses readable names for common control characters', () => {
    expect(showHiddenCharacters('ls\u001b[201~\rid > /tmp/pwned\r\u001b[200~')).toBe('ls<ESC>[201~<CR>id > /tmp/pwned<CR><ESC>[200~');
    expect(showHiddenCharacters('a\tb')).toBe('a<TAB>b');
    expect(showHiddenCharacters('a\u0000b')).toBe('a<NUL>b');
    expect(showHiddenCharacters('a\u0004b')).toBe('a<EOT>b');
    expect(showHiddenCharacters('a\u007fb')).toBe('a<DEL>b');
  });

  it('uses <U+XXXX> for the other rejected characters', () => {
    expect(showHiddenCharacters('a\u{202E}b')).toBe('a<U+202E>b');
    expect(showHiddenCharacters('a\u{200B}b\u{FEFF}c')).toBe('a<U+200B>b<U+FEFF>c');
    expect(showHiddenCharacters('a\u{A0}b\u{3000}c')).toBe('a<U+00A0>b<U+3000>c');
    expect(showHiddenCharacters('a\u009bb\u0085c')).toBe('a<U+009B>b<U+0085>c');
    expect(showHiddenCharacters('a\ud800b')).toBe('a<U+D800>b');
    expect(showHiddenCharacters('a\u{E000}b')).toBe('a<U+E000>b');
    expect(showHiddenCharacters('a\u{E0041}b')).toBe('a<U+E0041>b');
  });

  it('marks the invisible variation selectors and blank characters', () => {
    expect(showHiddenCharacters('ls\u{FE00} -la')).toBe('ls<U+FE00> -la');
    expect(showHiddenCharacters('ls\u{FE0F}')).toBe('ls<U+FE0F>');
    expect(showHiddenCharacters('ls\u{180F}')).toBe('ls<U+180F>');
    expect(showHiddenCharacters('a\u{16FE4}b\u{303F}c\u{FFFC}d')).toBe('a<U+16FE4>b<U+303F>c<U+FFFC>d');
    expect(showHiddenCharacters('a\u{1D159}b\u{13441}c\u{13442}d')).toBe('a<U+1D159>b<U+13441>c<U+13442>d');
  });

  it('keeps variation selectors where they belong to an emoji', () => {
    expect(showHiddenCharacters('echo ❤️ ❤︎')).toBe('echo ❤️ ❤︎');
    expect(showHiddenCharacters('1️⃣')).toBe('1️⃣');
    expect(showHiddenCharacters('❤️️')).toBe('❤️<U+FE0F>');
  });

  it('does not let a cut-off keycap mark vouch for the selector before it', () => {
    expect(showHiddenCharacters('1️⃣', 2)).toBe('1<U+FE0F>…');
    expect(showHiddenCharacters('1️⃣', 3)).toBe('1️⃣');
  });

  it('marks overlay marks, stray marks and marks beyond the run limit', () => {
    expect(showHiddenCharacters('r̶m')).toBe('r<U+0336>m');
    expect(showHiddenCharacters('x⃠')).toBe('x<U+20E0>');
    expect(showHiddenCharacters('́ls')).toBe('<U+0301>ls');
    expect(showHiddenCharacters('ls ́')).toBe('ls <U+0301>');
    expect(showHiddenCharacters('a\nb́\ńc')).toBe('a ⏎ b́ ⏎ <U+0301>c');
    const marks = '́'.repeat(MAX_COMBINING_MARKS);
    expect(showHiddenCharacters(`e${marks}́́`)).toBe(`e${marks}<U+0301>́`);
  });

  it('shows line breaks as a return symbol and keeps visible characters', () => {
    expect(showHiddenCharacters('for x\ndo y\ndone')).toBe('for x ⏎ do y ⏎ done');
    expect(showHiddenCharacters('blåbär 日本語 😀 ls -la')).toBe('blåbär 日本語 😀 ls -la');
  });

  it('truncates with an ellipsis after maxLength characters', () => {
    expect(showHiddenCharacters('a'.repeat(300))).toBe(`${'a'.repeat(200)}…`);
    expect(showHiddenCharacters('abcdef', 3)).toBe('abc…');
    expect(showHiddenCharacters('abc', 3)).toBe('abc');
    expect(showHiddenCharacters('abc', 10)).toBe('abc');
    expect(showHiddenCharacters('abc', 0)).toBe('…');
    expect(showHiddenCharacters('', 0)).toBe('');
  });

  it('truncates between characters, never inside a marker or a surrogate pair', () => {
    expect(showHiddenCharacters('\u001b\u001b\u001b', 2)).toBe('<ESC><ESC>…');
    expect(showHiddenCharacters('\u{202E}\u{202E}\u{202E}', 1)).toBe('<U+202E>…');
    expect(showHiddenCharacters('\u{1F600}\u{1F600}\u{1F600}', 2)).toBe('\u{1F600}\u{1F600}…');
  });

  it('keeps the truncated output free of rejected characters', () => {
    const shown = showHiddenCharacters('x'.repeat(10) + '\u001b'.repeat(500), 50);
    expect(checkSuggestedCommand(shown).ok).toBe(true);
  });
});

describe('every code point', () => {
  // A full sweep: a character is rejected by checkSuggestedCommand exactly when
  // showHiddenCharacters changes it, and what showHiddenCharacters outputs is
  // always accepted.
  it('is either accepted unchanged or replaced by an accepted marker', () => {
    const problems: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const text = `a${ch}b`;
      const check = checkSuggestedCommand(text, MULTI);
      const shown = showHiddenCharacters(text);
      const shownCheck = checkSuggestedCommand(shown, MULTI);
      const rejected = !check.ok && (check.reason === 'control-characters' || check.reason === 'hidden-characters');
      const label = `U+${cp.toString(16).toUpperCase()}`;
      if (!shownCheck.ok) problems.push(`${label}: shown text rejected`);
      else if (cp === 0x0a) {
        if (!check.ok || shown !== 'a ⏎ b') problems.push(`${label}: line break`);
      } else if (rejected === (shown === text)) problems.push(`${label}: rejected=${rejected} unchanged=${shown === text}`);
      if (!rejected && cp !== 0x0a && (!check.ok || check.command !== text)) problems.push(`${label}: accepted text altered`);
    }
    expect(problems).toEqual([]);
  });

  // Independent oracle: the Unicode properties themselves, not the helper that
  // the implementation uses, so a gap in the implementation shows up here.
  it('rejects every default-ignorable code point, every variation selector and every invisible class', () => {
    const invisible = /[\p{Default_Ignorable_Code_Point}\p{Variation_Selector}\p{Cc}\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;
    const problems: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (!invisible.test(ch) || cp === 0x20) continue;
      // Lowercase letters on both sides, so no emoji, keycap or mark context can excuse the character.
      const result = checkSuggestedCommand(`a${ch}b`, MULTI);
      const expected = cp === 0x0a;
      if (result.ok !== expected) problems.push(`U+${cp.toString(16).toUpperCase()}`);
    }
    expect(problems).toEqual([]);
  });

  it('rejects blank-looking characters that have no Unicode property to say so', () => {
    const blanks = [
      0x2800, 0x2d7f, 0x303f, 0xfffc, 0x1107f, 0x11a47, 0x11a99, 0x11f42, 0x13440, 0x13441, 0x13442, 0x16fe4, 0x1bc9d, 0x1d159,
      0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0,
    ];
    for (const cp of blanks) {
      expect(checkSuggestedCommand(`a${String.fromCodePoint(cp)}b`)).toMatchObject({ ok: false, reason: 'hidden-characters' });
    }
  });

  it('accepts every emoji, with and without a variation selector, but not a stray selector', () => {
    const emoji = /\p{Emoji}/u;
    const problems: string[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp += 1) {
      const ch = String.fromCodePoint(cp);
      if (!emoji.test(ch)) continue;
      for (const text of [`a${ch}b`, `a${ch}️b`, `a${ch}︎b`]) {
        if (!checkSuggestedCommand(text).ok) problems.push(`U+${cp.toString(16).toUpperCase()} in ${JSON.stringify(text)}`);
      }
      if (checkSuggestedCommand(`a${ch}️️b`).ok) problems.push(`U+${cp.toString(16).toUpperCase()} with two selectors`);
    }
    expect(problems).toEqual([]);
  });

  it('accepts the composed and the decomposed form of ordinary text alike', () => {
    for (const text of ['blåbär äpple öl', 'Ångström ñandú', 'Việt Nam ệ', 'ΐ ᾳ', 'ก็ ที่', 'שָׁלוֹם', 'مَرْحَبًا', 'Привет', '한국어', 'ｶﾀｶﾅ']) {
      for (const form of ['NFC', 'NFD', 'NFKC', 'NFKD'] as const) {
        const normalized = text.normalize(form);
        expect(checkSuggestedCommand(`echo ${normalized}`)).toMatchObject({ ok: true, command: `echo ${normalized}` });
      }
    }
  });

  it('keeps the shown text of random mixtures acceptable', () => {
    const pieces = [
      'a', 'ls', ' ', '\n', '\r', '\u001b', '́', '̈', '̶', '⃠', '⃣', '︎', '️', '᠏', '❤', '\u{1F600}',
      '1', '#', '*', '‍', '​', '〿', '᛾4', '\u{16FE4}', '\u{FFFC}', '\ud800', '\udc00', ' ', '　', 'ก', 'ิ',
    ];
    // A small linear congruential generator keeps the run reproducible.
    let seed = 20240607;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const problems: string[] = [];
    for (let round = 0; round < 3000; round += 1) {
      let text = '';
      for (let n = 1 + next(24); n > 0; n -= 1) text += pieces[next(pieces.length)];
      const limit = next(5) === 0 ? 1 + next(text.length + 1) : 200;
      const shown = showHiddenCharacters(text, limit);
      const result = checkSuggestedCommand(shown, MULTI);
      if (!result.ok && !['empty', 'too-long', 'multiple-lines'].includes(result.reason)) {
        problems.push(`${JSON.stringify(text)} / ${limit} -> ${JSON.stringify(shown)} (${result.reason})`);
      }
      // A text that is accepted is shown unchanged, apart from line breaks.
      const original = checkSuggestedCommand(text, MULTI);
      if (original.ok && showHiddenCharacters(text, 100000) !== text.replace(/\n/g, ' ⏎ ')) {
        problems.push(`accepted but changed: ${JSON.stringify(text)}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('accepts exactly the plain space among the Unicode space separators', () => {
    expect(checkSuggestedCommand('a b').ok).toBe(true);
    for (const cp of [0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000]) {
      expect(checkSuggestedCommand(`a${String.fromCodePoint(cp)}b`)).toMatchObject({ ok: false, reason: 'hidden-characters' });
    }
  });
});
