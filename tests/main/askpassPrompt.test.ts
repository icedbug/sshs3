import { describe, it, expect } from 'vitest';
import {
  classifyAskpassPrompt,
  describeAskpassPrompt,
  isHostKeyConfirmPrompt,
  isPasswordPrompt,
  isServerAskedPrompt,
  savedAskpassAnswer,
} from '../../src/main/ssh/askpassPrompt';

describe('askpassPrompt', () => {
  it('answers a prompt only with the secret of the matching kind', () => {
    const cfg = { authType: 'privateKey', password: 'acct-pw', passphrase: 'key-pp' }; // pragma: allowlist secret
    expect(savedAskpassAnswer('Enter passphrase for /home/me/.ssh/id_ed25519:', cfg)).toBe('key-pp');
    // A server-controlled password prompt must never receive the local key passphrase.
    expect(savedAskpassAnswer("bob@h's password: ", cfg)).toBeUndefined();
    expect(savedAskpassAnswer("bob@h's password: ", { ...cfg, authType: 'password' })).toBe('acct-pw');
    expect(savedAskpassAnswer('Verification code:', { ...cfg, authType: 'password' })).toBeUndefined();
    expect(savedAskpassAnswer('Enter PIN for token:', cfg)).toBeUndefined();
    // A server's keyboard-interactive question mentioning "passphrase" must not get the key passphrase.
    expect(savedAskpassAnswer('(bob@h) Enter passphrase: ', cfg)).toBeUndefined();
    expect(savedAskpassAnswer('Server passphrase:', cfg)).toBeUndefined();
  });

  // M2 (code review 2026-11-03): with a jump host, ssh asks for the jump hop's password through the same
  // askpass, as "jumpuser@jump's password:". The target's saved password must not answer that.
  describe('saved password and jump hosts', () => {
    const cfg = {
      authType: 'password',
      password: 'target-pw', // pragma: allowlist secret
      host: 'db.internal',
      username: 'alice',
      proxyJump: 'bob@bastion.example.com',
    };

    it('does not answer the jump host\'s password prompt', () => {
      expect(savedAskpassAnswer("bob@bastion.example.com's password: ", cfg)).toBeUndefined();
      expect(savedAskpassAnswer('(bob@bastion.example.com) Password: ', cfg)).toBeUndefined();
    });

    it('still answers the target\'s own prompt, as password or keyboard-interactive', () => {
      expect(savedAskpassAnswer("alice@db.internal's password: ", cfg)).toBe('target-pw');
      expect(savedAskpassAnswer('(alice@db.internal) Password: ', cfg)).toBe('target-pw');
      expect(savedAskpassAnswer("ALICE@DB.INTERNAL's password: ", cfg)).toBeUndefined(); // user names are case-sensitive
      expect(savedAskpassAnswer("alice@DB.internal's password: ", cfg)).toBe('target-pw'); // host names are not
    });

    it('answers the target when the jump host is a saved profile, and the same user name on another host is refused', () => {
      const byProfile = { ...cfg, proxyJump: undefined, proxyJumpProfileId: 'jump-1' };
      expect(savedAskpassAnswer("alice@db.internal's password: ", byProfile)).toBe('target-pw');
      expect(savedAskpassAnswer("alice@bastion.example.com's password: ", byProfile)).toBeUndefined();
    });

    it('refuses a prompt it cannot attribute to the target when a jump host is configured', () => {
      expect(savedAskpassAnswer('Password: ', cfg)).toBeUndefined();
    });

    it('matches the host and user ssh truncates in its prompt (30 and 128 characters)', () => {
      const longUser = 'u'.repeat(40);
      const longHost = `${'h'.repeat(140)}.example.com`;
      const long = { ...cfg, username: longUser, host: longHost };
      expect(savedAskpassAnswer(`${'u'.repeat(30)}@${'h'.repeat(128)}'s password: `, long)).toBe('target-pw');
    });

    it('is unchanged without a jump host: the prompt is not matched against the profile host', () => {
      const direct = { ...cfg, proxyJump: undefined };
      expect(savedAskpassAnswer("alice@resolved-by-ssh-config's password: ", direct)).toBe('target-pw');
    });
  });

  it('recognises account password prompts but not PIN or passphrase prompts mentioning "password"', () => {
    expect(isPasswordPrompt('alice@host.example.com\'s password: ')).toBe(true);
    expect(isPasswordPrompt('Enter passphrase for key (password protected):')).toBe(false);
    expect(isPasswordPrompt('Enter PIN for PKCS#11 password:')).toBe(false);
  });

  it('classifies password, fido2, passphrase and smartcard prompts', () => {
    expect(classifyAskpassPrompt("bob@h's password:")).toBe('password');
    expect(classifyAskpassPrompt('Enter PIN for sk-ssh-ed25519@openssh.com key', 'privateKey')).toBe('fido2');
    expect(classifyAskpassPrompt('Confirm user presence for YubiKey')).toBe('fido2');
    expect(classifyAskpassPrompt('Enter anything', 'fido2')).toBe('fido2');
    expect(classifyAskpassPrompt('Enter passphrase for /home/me/.ssh/id_ed25519:')).toBeUndefined();
    expect(classifyAskpassPrompt('Enter PIN for PIV_II (PIV Card Holder pin):', 'smartcard')).toBe('smartcard');
  });

  it('never presents a question the server asked as a local smartcard or FIDO2 PIN prompt', () => {
    for (const authType of ['smartcard', 'fido2', 'privateKey', undefined]) {
      for (const text of [
        '(bob@h) Verification code: ',
        '(bob@h) Password or PIN: ',
        '(bob@h) Enter PIN for YubiKey: ',
        '(bob@h) Enter PIN for sk-ssh-ed25519@openssh.com key: ',
      ]) {
        expect(isServerAskedPrompt(text), text).toBe(true);
        expect(classifyAskpassPrompt(text, authType), `${authType} ${text}`).toBe('password');
      }
    }
    // The server's own words are shown, not replaced by "Enter your smartcard PIN …".
    expect(describeAskpassPrompt('(bob@h) Verification code: ', { authType: 'smartcard', name: 'Prod', host: 'h' })).toEqual({
      kind: 'password',
      prompt: '(bob@h) Verification code:',
      context: 'SSH: Prod (h)',
    });
  });

  it("still treats ssh's own local PIN prompts as PIN prompts", () => {
    // Formats taken from the ssh binary: "Enter PIN for '%.32s': " (PKCS#11), "Enter PIN for %s key %s: " (FIDO).
    expect(isServerAskedPrompt("Enter PIN for 'PIV_II (PIV Card Holder pin)': ")).toBe(false);
    expect(isServerAskedPrompt('Enter PIN for ED25519-SK key /home/me/.ssh/id_ed25519_sk: ')).toBe(false);
    expect(classifyAskpassPrompt("Enter PIN for 'PIV_II (PIV Card Holder pin)': ", 'smartcard')).toBe('smartcard');
    expect(classifyAskpassPrompt('Enter PIN for ED25519-SK key /home/me/.ssh/id_ed25519_sk: ', 'fido2')).toBe('fido2');
    // A user name with a parenthesis does not hide the prefix.
    expect(isServerAskedPrompt('(svc(prod)@host) Verification code: ')).toBe(true);
    expect(classifyAskpassPrompt('(svc(prod)@host) Enter PIN: ', 'smartcard')).toBe('password');
    // A parenthesis later in the text is not the server prefix.
    expect(isServerAskedPrompt('Enter PIN for (bob@h) token: ')).toBe(false);
  });

  it('describes a prompt with the host label used in the dialog', () => {
    expect(describeAskpassPrompt("bob@h's password: ", { name: 'Prod', host: 'h' })).toEqual({
      kind: 'password',
      prompt: "bob@h's password:",
      context: 'SSH: Prod (h)',
    });
    expect(describeAskpassPrompt('', { authType: 'fido2', host: 'h' })).toEqual({
      kind: 'fido2',
      prompt: 'Enter PIN for security key to connect via SSH to h:',
      context: 'FIDO2: h',
    });
    expect(describeAskpassPrompt('Enter PIN', { authType: 'smartcard', name: 'Prod', host: 'h' })).toEqual({
      kind: 'smartcard',
      prompt: 'Enter your smartcard PIN to connect via SSH to Prod (h):',
      context: 'Smartcard: Prod (h)',
    });
  });

  it('describes a passphrase prompt like a smartcard prompt (kind undefined, generic text)', () => {
    const d = describeAskpassPrompt('Enter passphrase for key:', { host: 'h' });
    expect(d.kind).toBeUndefined();
    expect(d.prompt).toBe('Enter your smartcard PIN to connect via SSH to h:');
  });

  it('recognises the host key confirmation question and its retry, but not PIN prompts', () => {
    expect(isHostKeyConfirmPrompt("The authenticity of host 'h' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ")).toBe(true);
    expect(isHostKeyConfirmPrompt("Please type 'yes', 'no' or the fingerprint: ")).toBe(true);
    expect(isHostKeyConfirmPrompt('Enter PIN for PKCS#11 token:')).toBe(false);
  });
});
