import { describe, it, expect, vi } from 'vitest';
import {
  findChangedKey,
  handleHostKeyChanged,
  isHostKeyChangedOutput,
  knownHostsPattern,
  parseKeygenFingerprints,
} from '../../src/main/ssh/hostKeyChanged';

const WARNING = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'The fingerprint for the ED25519 key sent by the remote host is',
  'SHA256:abc+DEF/123.',
  'Host key verification failed.',
].join('\r\n');

describe('isHostKeyChangedOutput', () => {
  it('detects the warning, also with ANSI escapes', () => {
    expect(isHostKeyChangedOutput(WARNING)).toBe(true);
    expect(isHostKeyChangedOutput('\x1b[1mREMOTE HOST IDENTIFICATION HAS CHANGED\x1b[0m')).toBe(true);
  });
  it('returns false for other output', () => {
    expect(isHostKeyChangedOutput('Permission denied (publickey).')).toBe(false);
  });
});

describe('parseKeygenFingerprints', () => {
  it('maps key type to fingerprint and skips comment lines', () => {
    const out = '# Host h found: line 1\n256 SHA256:aaa h (ED25519)\n3072 SHA256:bbb h (RSA)\n';
    expect([...parseKeygenFingerprints(out)]).toEqual([
      ['ED25519', 'SHA256:aaa'],
      ['RSA', 'SHA256:bbb'],
    ]);
  });
});

describe('parseKeygenFingerprints (ssh-keygen -F -l format)', () => {
  it('reads "host TYPE SHA256:xxx" lines', () => {
    const out = '# Host gnarg found: line 1 \ngnarg ED25519 SHA256:aaa\n# Host gnarg found: line 2 \ngnarg RSA SHA256:bbb\n';
    expect([...parseKeygenFingerprints(out)]).toEqual([
      ['ED25519', 'SHA256:aaa'],
      ['RSA', 'SHA256:bbb'],
    ]);
  });
});

describe('findChangedKey', () => {
  const known = new Map([['ED25519', 'SHA256:old']]);
  it('reports a known key type with a different fingerprint', () => {
    expect(findChangedKey(known, new Map([['ED25519', 'SHA256:new']]))).toEqual({
      keyType: 'ED25519',
      fingerprint: 'SHA256:new',
    });
  });
  it('ignores identical keys and key types not stored yet', () => {
    expect(findChangedKey(known, new Map([['ED25519', 'SHA256:old'], ['RSA', 'SHA256:x']]))).toBeNull();
  });
});

describe('knownHostsPattern', () => {
  it('brackets non-default ports', () => {
    expect(knownHostsPattern('h', 22)).toBe('h');
    expect(knownHostsPattern('h', 2222)).toBe('[h]:2222');
  });
});

describe('handleHostKeyChanged', () => {
  const target = { host: 'h', port: 22 };
  const probeChangedHostKey = vi.fn().mockResolvedValue({ keyType: 'ED25519', fingerprint: 'SHA256:probe' });

  it('removes the old entry only after the user agrees', async () => {
    const removeKnownHost = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const promptHostKeyTrust = vi.fn().mockResolvedValue(true);
    expect(await handleHostKeyChanged(target, { promptHostKeyTrust, notify, removeKnownHost, probeChangedHostKey })).toBe(true);
    expect(promptHostKeyTrust).toHaveBeenCalledWith(expect.objectContaining({ status: 'mismatch', host: 'h', fingerprint: 'SHA256:probe' }));
    expect(removeKnownHost).toHaveBeenCalledWith('h', 22);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Reconnect'));
  });

  it('leaves known_hosts alone when declined', async () => {
    const removeKnownHost = vi.fn();
    const promptHostKeyTrust = vi.fn().mockResolvedValue(false);
    expect(await handleHostKeyChanged(target, { promptHostKeyTrust, notify: vi.fn(), removeKnownHost, probeChangedHostKey })).toBe(false);
    expect(removeKnownHost).not.toHaveBeenCalled();
  });

  it('reports a failed removal', async () => {
    const notify = vi.fn();
    const removeKnownHost = vi.fn().mockRejectedValue(new Error('boom'));
    const promptHostKeyTrust = vi.fn().mockResolvedValue(true);
    expect(await handleHostKeyChanged(target, { promptHostKeyTrust, notify, removeKnownHost, probeChangedHostKey })).toBe(false);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('shows no dialog and removes nothing when the change cannot be confirmed', async () => {
    const notify = vi.fn();
    const removeKnownHost = vi.fn();
    const promptHostKeyTrust = vi.fn();
    const probe = vi.fn().mockResolvedValue(null);
    expect(
      await handleHostKeyChanged(target, { promptHostKeyTrust, notify, removeKnownHost, probeChangedHostKey: probe })
    ).toBe(false);
    expect(promptHostKeyTrust).not.toHaveBeenCalled();
    expect(removeKnownHost).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('ssh-keygen -R h'));
  });
});
