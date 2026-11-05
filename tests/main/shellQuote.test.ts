import { describe, it, expect } from 'vitest';
import { anchorPath, quotePathOperand, quoteShellArg } from '../../src/main/search/shellQuote';

describe('quoteShellArg', () => {
  it('wraps plain string in single quotes', () => {
    expect(quoteShellArg('hello')).toBe("'hello'");
    expect(quoteShellArg('path/to/file.txt')).toBe("'path/to/file.txt'");
  });

  it('escapes embedded single quotes', () => {
    expect(quoteShellArg("foo'bar")).toBe("'foo'\\''bar'");
    expect(quoteShellArg("don't stop")).toBe("'don'\\''t stop'");
  });

  it('strips null bytes', () => {
    expect(quoteShellArg('hello\0world')).toBe("'helloworld'");
    expect(quoteShellArg('command\0; rm -rf /')).toBe("'command; rm -rf /'");
  });
});

describe('quotePathOperand', () => {
  it('leaves absolute paths alone', () => {
    expect(quotePathOperand('/var/log/syslog')).toBe("'/var/log/syslog'");
    expect(quotePathOperand('/-odd/-file')).toBe("'/-odd/-file'");
  });

  it('anchors every relative path so it cannot be read as an option or a find expression', () => {
    expect(quotePathOperand('-e1e id')).toBe("'./-e1e id'");
    expect(quotePathOperand('-f')).toBe("'./-f'");
    expect(quotePathOperand('!x')).toBe("'./!x'");
    expect(quotePathOperand('(dir')).toBe("'./(dir'");
    expect(quotePathOperand('dir/-file')).toBe("'./dir/-file'");
  });
});

describe('anchorPath', () => {
  it('is idempotent and leaves already safe forms alone', () => {
    expect(anchorPath('logs')).toBe('./logs');
    expect(anchorPath(anchorPath('logs'))).toBe('./logs');
    for (const same of ['/abs/path', './rel', '../up/rel', '.', '..']) expect(anchorPath(same)).toBe(same);
    expect(quotePathOperand('./logs')).toBe("'./logs'"); // not doubled
  });
});
