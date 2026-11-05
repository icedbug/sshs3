import { describe, it, expect } from 'vitest';
import { assertIdTokenNonce, decodeJwtClaims, usernameFromIdToken } from '../../src/main/ca/oidcFlow';

const jwt = (claims: unknown) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('decodeJwtClaims', () => {
  it('decodes the payload without verifying it', () => {
    expect(decodeJwtClaims(jwt({ sub: 'u1', nonce: 'n' }))).toEqual({ sub: 'u1', nonce: 'n' });
  });

  it.each(['', 'not-a-jwt', 'a.%%%.c', `a.${Buffer.from('[1,2]').toString('base64url')}.c`, `a.${Buffer.from('null').toString('base64url')}.c`])(
    'returns undefined for %j',
    (token) => {
      expect(decodeJwtClaims(token)).toBeUndefined();
    }
  );
});

describe('usernameFromIdToken', () => {
  it('prefers preferred_username, then email, then sub', () => {
    expect(usernameFromIdToken(jwt({ preferred_username: 'alun', email: 'a@x', sub: 's' }))).toBe('alun');
    expect(usernameFromIdToken(jwt({ email: 'a@x', sub: 's' }))).toBe('a@x');
    expect(usernameFromIdToken(jwt({ sub: 's' }))).toBe('s');
  });

  it('falls back to "user" for unusable tokens', () => {
    expect(usernameFromIdToken(jwt({}))).toBe('user');
    expect(usernameFromIdToken('garbage')).toBe('user');
  });
});

describe('assertIdTokenNonce', () => {
  it('accepts the nonce that was sent', () => {
    expect(() => assertIdTokenNonce(jwt({ nonce: 'abc' }), 'abc')).not.toThrow();
  });

  it('rejects a different, a missing or a non-string nonce and an undecodable token', () => {
    expect(() => assertIdTokenNonce(jwt({ nonce: 'other' }), 'abc')).toThrow(/nonce/);
    expect(() => assertIdTokenNonce(jwt({ sub: 'x' }), 'abc')).toThrow(/nonce/);
    expect(() => assertIdTokenNonce(jwt({ nonce: 123 }), '123')).toThrow(/nonce/);
    expect(() => assertIdTokenNonce('garbage', 'abc')).toThrow(/nonce/);
  });
});
