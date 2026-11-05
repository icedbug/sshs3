import { describe, expect, it } from 'vitest';
import { isTerminalReply, printableInput } from './terminalInput';

describe('printableInput', () => {
  it('keeps typed and pasted text', () => {
    expect(printableInput('ls -la /tmp')).toBe('ls -la /tmp');
  });

  it('drops the markers around a bracketed paste', () => {
    expect(printableInput('\x1b[200~cat /etc/hosts\x1b[201~')).toBe('cat /etc/hosts');
  });

  it('drops cursor-key sequences instead of leaving their tail behind', () => {
    expect(printableInput('\x1b[A')).toBe('');
    expect(printableInput('\x1b[1;5C')).toBe('');
    expect(printableInput('\x1bOH')).toBe('');
  });

  it('drops other control characters', () => {
    expect(printableInput('a\tb\x01c')).toBe('abc');
  });
});

describe('isTerminalReply', () => {
  it.each([
    ['device attributes', '\x1b[?62;4c'],
    ['secondary device attributes', '\x1b[>0;276;0c'],
    ['cursor position', '\x1b[24;1R'],
    ['kitty keyboard flags', '\x1b[?0u'],
    ['a background colour reply', '\x1b]11;rgb:0000/0000/0000\x1b\\'],
    ['a background colour reply ended with BEL', '\x1b]11;rgb:0000/0000/0000\x07'],
    ['an XTVERSION reply', '\x1bP>|xterm.js(5.3.0)\x1b\\'],
    ['focus in', '\x1b[I'],
  ])('recognises %s as a terminal reply', (_name, data) => {
    expect(isTerminalReply(data)).toBe(true);
  });

  it.each([
    ['text', 'ls'],
    ['an arrow key', '\x1b[A'],
    ['ctrl+arrow', '\x1b[1;5C'],
    ['a function key', '\x1b[15~'],
    ['alt+key', '\x1bb'],
    ['a pasted marker', '\x1b[200~cat\x1b[201~'],
    ['enter', '\r'],
  ])('does not take %s for a reply', (_name, data) => {
    expect(isTerminalReply(data)).toBe(false);
  });
});
