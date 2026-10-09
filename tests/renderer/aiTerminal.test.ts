import { describe, it, expect } from 'vitest';
import { eraseTypedLine, isFailureExitCode, looksLikeFailure, TypedLineTracker } from '../../src/renderer/src/lib/aiTerminal';

describe('isFailureExitCode', () => {
  it('treats non-zero codes as failures, except the user stopping the command', () => {
    expect(isFailureExitCode(1)).toBe(true);
    expect(isFailureExitCode(127)).toBe(true);
    expect(isFailureExitCode(0)).toBe(false);
    expect(isFailureExitCode(null)).toBe(false);
    expect(isFailureExitCode(130)).toBe(false); // Ctrl+C
    expect(isFailureExitCode(148)).toBe(false); // Ctrl+Z
  });
});

describe('looksLikeFailure', () => {
  it.each([
    'bash: dokcer: command not found',
    'cat: /etc/nope: No such file or directory',
    "'foo' is not recognized as an internal or external command,",
    'Traceback (most recent call last):\n  File "x.py", line 1\nNameError: name "y" is not defined',
    "fatal: not a git repository (or any of the parent directories): .git",
    'error[E0425]: cannot find value `x` in this scope',
    'E: Unable to locate package ngnix',
    'npm ERR! code ENOENT',
    'curl: (6) Could not resolve host: exmaple.com',
    'ssh: connect to host 10.0.0.1 port 22: Connection refused',
  ])('flags %s', (output) => {
    expect(looksLikeFailure(`$ some command\n${output}`)).toBe(true);
  });

  it.each([
    '',
    'total 0\ndrwxr-xr-x 2 root root 40 Oct  9 12:00 .',
    'app.log: 2026-10-09 12:00 INFO no errors found',
    'grep error /var/log/syslog matched 0 lines',
  ])('leaves ordinary output alone: %s', (output) => {
    expect(looksLikeFailure(output)).toBe(false);
  });

  it('only looks at the end of long output', () => {
    const output = ['bash: x: command not found', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
    expect(looksLikeFailure(output)).toBe(false);
    expect(looksLikeFailure(null)).toBe(false);
  });
});

describe('eraseTypedLine', () => {
  it('sends one backspace per character, counting an emoji as one', () => {
    expect(eraseTypedLine('ls')).toBe('\x7f\x7f');
    expect(eraseTypedLine('hitta 🐳 filer')).toBe('\x7f'.repeat(13));
    expect(eraseTypedLine('')).toBe('');
  });
});

describe('TypedLineTracker', () => {
  it('follows typing, backspace and Enter', () => {
    const t = new TypedLineTracker();
    t.feed('find big');
    t.feed('g');
    t.feed('\x7f');
    t.feed(' files');
    expect(t.text).toBe('find big files');
    t.feed('\r');
    expect(t.text).toBe('');
  });

  it('keeps pasted text but drops the bracketed-paste markers', () => {
    const t = new TypedLineTracker();
    t.feed('\x1b[200~list open ports\x1b[201~');
    expect(t.text).toBe('list open ports');
  });

  it('gives up after line editing it cannot follow, until the line is reset', () => {
    const t = new TypedLineTracker();
    t.feed('echo hi');
    t.feed('\x1b[A'); // Up: history recall
    expect(t.text).toBeNull();
    t.feed('more');
    expect(t.text).toBeNull();
    t.feed('\x03'); // Ctrl+C
    expect(t.text).toBe('');

    t.feed('do');
    t.feed('\t'); // tab completion
    expect(t.text).toBeNull();
    t.feed('\x15'); // Ctrl+U
    t.feed('ok');
    expect(t.text).toBe('ok');
  });
});
