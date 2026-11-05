import { describe, it, expect } from 'vitest';
import { resolvePasswordStore } from '../../src/main/crypto/passwordStore';

describe('resolvePasswordStore', () => {
  it('uses the OS keyring by default', () => {
    expect(resolvePasswordStore({}, false)).toBe('gnome-libsecret');
    expect(resolvePasswordStore({}, true)).toBe('gnome-libsecret');
  });

  it('lets an unpackaged test or dev run opt out of the OS keyring', () => {
    expect(resolvePasswordStore({ SSHS3_KEYRING_BACKEND: 'basic' }, false)).toBe('basic');
  });

  it('never honors the override in a packaged build', () => {
    expect(resolvePasswordStore({ SSHS3_KEYRING_BACKEND: 'basic' }, true)).toBe('gnome-libsecret');
  });

  it('ignores any other value', () => {
    expect(resolvePasswordStore({ SSHS3_KEYRING_BACKEND: 'kwallet6' }, false)).toBe('gnome-libsecret');
    expect(resolvePasswordStore({ SSHS3_KEYRING_BACKEND: '' }, false)).toBe('gnome-libsecret');
  });
});
