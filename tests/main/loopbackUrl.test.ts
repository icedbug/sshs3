import { describe, it, expect } from 'vitest';
import { isLoopbackHttpUrl } from '../../src/main/ca/loopbackUrl';

describe('isLoopbackHttpUrl', () => {
  it.each([
    'http://127.0.0.1',
    'http://127.0.0.1:8200',
    'http://127.1.2.3/path',
    'http://127.1',
    'http://localhost',
    'http://localhost:9000/.well-known/openid-configuration',
    'http://LOCALHOST:9000',
    'http://[::1]:8080',
  ])('accepts %s', (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(true);
  });

  it.each([
    'http://localhost.evil.com',
    'http://127.0.0.1.nip.io',
    'http://127.0.0.1.evil.com:8200',
    'http://localhost@evil.com',
    'http://evil.com/?u=http://localhost',
    'http://128.0.0.1',
    'http://10.0.0.1',
    'https://127.0.0.1',
    'https://example.com',
    'ftp://localhost',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isLoopbackHttpUrl(url)).toBe(false);
  });
});
