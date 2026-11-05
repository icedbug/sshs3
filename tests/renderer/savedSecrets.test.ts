import { describe, it, expect } from 'vitest';
import { withSavedS3Secrets, withSavedSshSecrets } from '../../src/renderer/src/lib/savedSecrets';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { S3Config } from '../../src/shared/types/storage';

const ssh = (over: Partial<SSHConnectionConfig> = {}): SSHConnectionConfig =>
  ({ id: 'p1', name: 'Prod', host: 'h', username: 'u', authType: 'password', ...over }) as SSHConnectionConfig;
const s3 = (over: Partial<S3Config> = {}): S3Config =>
  ({ id: 's1', name: 'Bucket', region: 'r', accessKeyId: 'AKIA', secretAccessKey: '', ...over }) as S3Config;

describe('withSavedSshSecrets', () => {
  it('fills in the saved password and passphrase that a restored tab does not have', () => {
    const saved = ssh({ password: 'pw', passphrase: 'pp', proxy: { type: 'socks5', host: 'p', port: 1080, password: 'proxy-pw' } }); // pragma: allowlist secret
    const restored = ssh({ proxy: { type: 'socks5', host: 'p', port: 1080 } });

    const result = withSavedSshSecrets(restored, [saved]);

    expect(result).toMatchObject({ password: 'pw', passphrase: 'pp', proxy: { host: 'p', password: 'proxy-pw' } }); // pragma: allowlist secret
  });

  it('keeps a secret the tab already has, and never touches a PIN', () => {
    const saved = ssh({ password: 'saved-pw', pin: '1234' }); // pragma: allowlist secret
    const result = withSavedSshSecrets(ssh({ password: 'own-pw' }), [saved]); // pragma: allowlist secret
    expect(result.password).toBe('own-pw'); // pragma: allowlist secret
    expect(result.pin).toBeUndefined();
  });

  it('leaves a tab that does not come from a saved profile alone', () => {
    const restored = ssh({ id: 'quick-connect-1' });
    expect(withSavedSshSecrets(restored, [ssh({ password: 'pw' })])).toBe(restored); // pragma: allowlist secret
    expect(withSavedSshSecrets(restored, undefined)).toBe(restored);
  });

  it('does not hand the secrets to another server: the session file is not trusted', () => {
    const saved = ssh({ password: 'pw', passphrase: 'pp', proxy: { type: 'socks5', host: 'p', port: 1080, password: 'proxy-pw' } }); // pragma: allowlist secret
    const proxied = { proxy: { type: 'socks5' as const, host: 'p', port: 1080 } };

    for (const redirected of [{ host: 'attacker.example.com' }, { port: 2222 }, { username: 'root' }]) {
      const restored = ssh({ ...redirected, ...proxied });
      expect(withSavedSshSecrets(restored, [saved])).toBe(restored);
    }
    // A proxy pointed elsewhere does not get the proxy's password; the rest still follows the profile.
    const viaOtherProxy = ssh({ proxy: { type: 'socks5', host: 'attacker-proxy', port: 1080 } });
    const result = withSavedSshSecrets(viaOtherProxy, [saved]);
    expect(result.password).toBe('pw'); // pragma: allowlist secret
    expect(result.proxy?.password).toBeUndefined();
    // The default port is the same thing as 22.
    expect(withSavedSshSecrets(ssh({ port: 22, ...proxied }), [ssh({ password: 'pw', proxy: proxied.proxy })]).password).toBe('pw'); // pragma: allowlist secret
  });

  it('does not use the secret of a deleted profile or one whose authentication type has changed', () => {
    const restored = ssh();
    expect(withSavedSshSecrets(restored, [ssh({ password: 'pw', deletedAt: '2026-10-01T00:00:00.000Z' })])).toBe(restored); // pragma: allowlist secret
    expect(withSavedSshSecrets(restored, [ssh({ password: 'pw', authType: 'privateKey' })])).toBe(restored); // pragma: allowlist secret
  });
});

describe('withSavedS3Secrets', () => {
  it('fills in the saved secret key and session token', () => {
    const saved = s3({ secretAccessKey: 'secret-key', sessionToken: 'tok' }); // pragma: allowlist secret
    expect(withSavedS3Secrets(s3(), [saved])).toMatchObject({ secretAccessKey: 'secret-key', sessionToken: 'tok' }); // pragma: allowlist secret
  });

  it('does not hand the secret key to another endpoint, region or access key', () => {
    const saved = s3({ secretAccessKey: 'secret-key', endpoint: 'https://s3.example.com' }); // pragma: allowlist secret
    for (const redirected of [{ endpoint: 'https://attacker.example.com' }, { endpoint: undefined }, { region: 'eu-north-1' }, { accessKeyId: 'AKIAOTHER' }]) {
      const restored = s3({ endpoint: 'https://s3.example.com', ...redirected });
      expect(withSavedS3Secrets(restored, [saved])).toBe(restored);
    }
  });

  it('keeps a key the tab already has and leaves a tab without a saved profile alone', () => {
    expect(withSavedS3Secrets(s3({ secretAccessKey: 'own' }), [s3({ secretAccessKey: 'saved' })]).secretAccessKey).toBe('own'); // pragma: allowlist secret
    const unknown = s3({ id: 'other' });
    expect(withSavedS3Secrets(unknown, [s3({ secretAccessKey: 'saved' })])).toBe(unknown); // pragma: allowlist secret
  });
});
