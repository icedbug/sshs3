import { describe, it, expect } from 'vitest';
import { externalLinkTarget, linkTitle } from '../../src/renderer/src/lib/markdownLinks';

describe('externalLinkTarget', () => {
  it('accepts absolute http and https addresses, in their normalised form', () => {
    expect(externalLinkTarget('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(externalLinkTarget('http://example.com')).toBe('http://example.com/');
    expect(externalLinkTarget('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
    expect(externalLinkTarget('  https://example.com/x  ')).toBe('https://example.com/x');
    expect(externalLinkTarget('https://example.com/a b')).toBe('https://example.com/a%20b');
  });

  it('refuses every other kind of link', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com/file',
      'mailto:a@example.com',
      'smb://server/share',
      'vbscript:x',
      '//example.com/protocol-relative',
      './other.md',
      '../up.md',
      'other.md',
      '/absolute/path.md',
      '#section',
      '',
      '   ',
    ]) {
      expect(externalLinkTarget(href), href).toBeNull();
    }
    expect(externalLinkTarget(undefined)).toBeNull();
  });

  it('refuses an address with a user name or password, which can hide the real host', () => {
    expect(externalLinkTarget('https://github.com@evil.example/')).toBeNull();
    expect(externalLinkTarget('https://user:pw@example.com/')).toBeNull(); // pragma: allowlist secret -- synthetic address for the test
  });

  it('does not let whitespace or control characters smuggle in another scheme', () => {
    expect(externalLinkTarget('java\tscript:alert(1)')).toBeNull();
    expect(externalLinkTarget('\u0001javascript:alert(1)')).toBeNull();
  });
});

describe('linkTitle', () => {
  it('shows only the destination when the link has no title of its own', () => {
    expect(linkTitle(undefined, 'https://example.com/')).toBe('https://example.com/');
    expect(linkTitle('  ', 'https://example.com/')).toBe('https://example.com/');
  });

  it('keeps the title the author gave and adds the destination after it', () => {
    expect(linkTitle('Open the docs', 'https://example.com/')).toBe('Open the docs (https://example.com/)');
  });

  it('works for a link that is not opened, and for no information at all', () => {
    expect(linkTitle('Other file', './other.md')).toBe('Other file (./other.md)');
    expect(linkTitle(undefined, './other.md')).toBe('./other.md');
    expect(linkTitle('Only a title', undefined)).toBe('Only a title');
    expect(linkTitle(undefined, undefined)).toBeUndefined();
  });
});
