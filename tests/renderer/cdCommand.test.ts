import { describe, it, expect } from 'vitest';
import { cdCommand, shellQuote } from '../../src/renderer/src/lib/cdCommand';

describe('shellQuote', () => {
  it('single-quotes a path and escapes a quote inside it', () => {
    expect(shellQuote('/var/www')).toBe("'/var/www'");
    expect(shellQuote("/it's")).toBe("'/it'\\''s'");
  });
});

describe('cdCommand', () => {
  it('quotes an absolute path, spaces and shell characters included', () => {
    expect(cdCommand('/srv/my app')).toBe("cd '/srv/my app'");
    expect(cdCommand('/a;rm -rf /')).toBe("cd '/a;rm -rf /'");
  });

  it('leaves the home directory unquoted so the shell expands it', () => {
    expect(cdCommand('~')).toBe('cd ~');
    expect(cdCommand('~/webshop')).toBe("cd ~/'webshop'");
  });

  it('still quotes everything after the home directory', () => {
    expect(cdCommand('~/my app;ls')).toBe("cd ~/'my app;ls'");
  });

  it('does not expand ~user or a ~ that is not first', () => {
    expect(cdCommand('~root/x')).toBe("cd '~root/x'");
    expect(cdCommand('/a/~/b')).toBe("cd '/a/~/b'");
  });
});
