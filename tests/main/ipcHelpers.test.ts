import { describe, it, expect, afterEach } from 'vitest';
import {
  assertStrings,
  describeFido2StartupError,
  isMissingPathError,
  paneTreeHasAuthType,
  parseK8sProfile,
  resolveDirSyncTargetRoot,
  sessionUsesAuthType,
} from '../../src/main/ipc/ipcHelpers';

describe('ipcHelpers', () => {
  describe('paneTreeHasAuthType', () => {
    const tree = {
      type: 'split',
      children: [
        { type: 'leaf', config: { authType: 'password' } },
        { type: 'split', children: [{ type: 'leaf', config: { authType: 'fido2' } }, { type: 'leaf' }] },
      ],
    };

    it('finds an auth type in a nested pane tree', () => {
      expect(paneTreeHasAuthType(tree, 'fido2')).toBe(true);
      expect(paneTreeHasAuthType(tree, 'password')).toBe(true);
    });

    it('returns false when no leaf uses it or the input is not a tree', () => {
      expect(paneTreeHasAuthType(tree, 'smartcard')).toBe(false);
      expect(paneTreeHasAuthType(undefined, 'fido2')).toBe(false);
      expect(paneTreeHasAuthType('x', 'fido2')).toBe(false);
    });
  });

  describe('sessionUsesAuthType', () => {
    const leaf = (authType: string) => ({ paneTree: { type: 'leaf', config: { authType } } });

    it('looks at the main window and at every secondary window', () => {
      const session = { tabs: [leaf('password')], windows: [{ tabs: [leaf('password')] }, { tabs: [leaf('fido2')] }] };
      expect(sessionUsesAuthType(session, 'fido2')).toBe(true);
      expect(sessionUsesAuthType(session, 'password')).toBe(true);
      expect(sessionUsesAuthType(session, 'smartcard')).toBe(false);
    });

    it('copes with sessions that have no tabs or windows', () => {
      expect(sessionUsesAuthType({}, 'fido2')).toBe(false);
      expect(sessionUsesAuthType({ windows: [{}] }, 'fido2')).toBe(false);
      expect(sessionUsesAuthType(null, 'fido2')).toBe(false);
    });
  });

  describe('resolveDirSyncTargetRoot', () => {
    it('nests the source folder name under the target parent', () => {
      expect(resolveDirSyncTargetRoot('/home/me/docs', 'sftp', '/backup')).toBe('/backup/docs');
    });

    it('falls back to the target parent when the source has no base name', () => {
      expect(resolveDirSyncTargetRoot('/', 'sftp', '/backup')).toBe('/backup');
    });
  });

  describe('describeFido2StartupError', () => {
    const RAW = 'Provider "internal" returned failure -1: invalid format';
    const setPlatform = (value: string) => Object.defineProperty(process, 'platform', { value, configurable: true });
    const realPlatform = process.platform;
    afterEach(() => setPlatform(realPlatform));

    it('explains the blocked-PIN case on Linux instead of showing the raw ssh-add message', () => {
      setPlatform('linux');
      const msg = describeFido2StartupError(new Error(RAW));
      expect(msg).not.toBe(RAW);
      expect(msg).toMatch(/unplugged and reconnected/);
    });

    it('does not claim a cause it has not proven on Windows', () => {
      setPlatform('win32');
      const msg = describeFido2StartupError(new Error(RAW));
      expect(msg).not.toBe(RAW);
      expect(msg).toMatch(/Administrator/);
    });

    it('passes any other error message through', () => {
      expect(describeFido2StartupError(new Error('boom'))).toBe('boom');
      expect(describeFido2StartupError('plain')).toBe('plain');
    });
  });

  describe('isMissingPathError', () => {
    it.each([
      ['a local ENOENT', Object.assign(new Error('x'), { code: 'ENOENT' })],
      ['ENOTDIR', Object.assign(new Error('x'), { code: 'ENOTDIR' })],
      ['an S3 NoSuchKey', Object.assign(new Error('x'), { code: 'NoSuchKey' })],
      ['an S3 NotFound name', Object.assign(new Error('x'), { name: 'NotFound' })],
      ['an SFTP no-such-file status', Object.assign(new Error('x'), { name: 'SftpError', statusCode: 2 })],
      ['the S3 provider path message', new Error('Path not found: /a/b')],
      ['the pod provider message', new Error('File or directory not found: /etc/x')],
    ])('treats %s as a missing path', (_name, err) => {
      expect(isMissingPathError(err)).toBe(true);
    });

    it.each([
      ['a lost connection', new Error('Connection lost')],
      ['an SFTP permission status', Object.assign(new Error('x'), { name: 'SftpError', statusCode: 3 })],
      ['a timeout', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })],
      ['EACCES', Object.assign(new Error('x'), { code: 'EACCES' })],
      ['a message that merely mentions it', new Error('bucket not found in region')],
      ['a non-error', 'ENOENT'],
      ['null', null],
    ])('does not treat %s as a missing path', (_name, err) => {
      expect(isMissingPathError(err)).toBe(false);
    });
  });
});

describe('parseK8sProfile', () => {
  const valid = { id: 'abc-123', name: ' Prod ', server: 'api.example.com:6443' };

  it('trims, keeps known fields and drops the rest', () => {
    expect(
      parseK8sProfile({ ...valid, namespace: ' team-a ', insecureSkipTlsVerify: true, token: 'sha256~x' })
    ).toEqual({
      id: 'abc-123',
      name: 'Prod',
      server: 'api.example.com:6443',
      namespace: 'team-a',
      insecureSkipTlsVerify: true,
    });
  });

  it('rejects malformed input', () => {
    expect(() => parseK8sProfile(null)).toThrow(/Invalid profile/);
    expect(() => parseK8sProfile({ ...valid, id: 'a/b' })).toThrow(/profile id/);
    expect(() => parseK8sProfile({ ...valid, name: '' })).toThrow(/name is required/);
    expect(() => parseK8sProfile({ ...valid, name: 'n'.repeat(300) })).toThrow(/profile name/);
    expect(() => parseK8sProfile({ ...valid, server: '' })).toThrow(/Server URL/);
    expect(() => parseK8sProfile({ ...valid, namespace: 'a b' })).toThrow(/namespace/);
    expect(() => parseK8sProfile({ ...valid, insecureSkipTlsVerify: 'yes' })).toThrow(/TLS/);
  });
});

describe('server URL rules (saved, synced and shared clusters)', () => {
  const profile = (server: string) => ({ id: 'p1', name: 'Prod', server });

  it('rejects embedded credentials, query strings and fragments', () => {
    // Fake credentials: the test asserts they are rejected.
    expect(() => parseK8sProfile(profile('https://user:secret@api.example.com:6443'))).toThrow(/user name or password/); // pragma: allowlist secret
    expect(() => parseK8sProfile(profile('https://token@api.example.com'))).toThrow(/user name or password/);
    expect(() => parseK8sProfile(profile('https://api.example.com:6443/?token=abc'))).toThrow(/query or fragment/);
    expect(() => parseK8sProfile(profile('https://api.example.com:6443/#frag'))).toThrow(/query or fragment/);
  });

  it('requires https, except plain http to a loopback address', () => {
    expect(() => parseK8sProfile(profile('http://api.example.com:6443'))).toThrow(/must use https/);
    expect(parseK8sProfile(profile('http://127.0.0.1:8001')).server).toBe('http://127.0.0.1:8001');
    expect(parseK8sProfile(profile('http://localhost:8001')).server).toBe('http://localhost:8001');
    expect(parseK8sProfile(profile('http://[::1]:8001')).server).toBe('http://[::1]:8001');
    expect(() => parseK8sProfile(profile('http://127.0.0.1.example.com'))).toThrow(/must use https/);
    expect(parseK8sProfile(profile('api.example.com:6443')).server).toBe('api.example.com:6443');
  });

  it('rejects inputs that parse differently here than in a consumer', () => {
    expect(() => parseK8sProfile(profile('http:/api.example.com'))).toThrow(/Invalid server URL/);
    expect(() => parseK8sProfile(profile('ftp://api.example.com'))).toThrow(/Invalid server URL/);
    expect(() => parseK8sProfile(profile('https:\\\\api.example.com'))).toThrow(/Invalid server URL/);
    expect(parseK8sProfile(profile('HTTPS://api.example.com:6443/')).server).toBe('https://api.example.com:6443');
  });
});

describe('assertStrings', () => {
  it('accepts non-empty strings', () => {
    expect(() => assertStrings({ providerId: 'local', remotePath: 'C:\\x' })).not.toThrow();
  });

  it('names the first argument that is not a non-empty string', () => {
    expect(() => assertStrings({ providerId: 'local', remotePath: 5 })).toThrow('Invalid argument: remotePath');
    expect(() => assertStrings({ providerId: '' })).toThrow('Invalid argument: providerId');
    expect(() => assertStrings({ providerId: undefined })).toThrow('Invalid argument: providerId');
  });
});
