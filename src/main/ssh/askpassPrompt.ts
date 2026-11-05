import type { AskpassPromptKind } from '../../shared/types/ipc';

/** OpenSSH asking for an account password (as opposed to a PIN or key passphrase). */
export function isPasswordPrompt(rawPrompt: string): boolean {
  return /password/i.test(rawPrompt) && !/pin|passphrase/i.test(rawPrompt);
}

/** OpenSSH's "continue connecting (yes/no)?" host key question, which it also routes through askpass. */
export function isHostKeyConfirmPrompt(rawPrompt: string): boolean {
  return /are you sure you want to continue connecting|please type 'yes', 'no'/i.test(rawPrompt);
}

/**
 * The `user@host` a password prompt is addressed to: ssh writes "user@host's password: " for its own password
 * authentication and "(user@host) Password: " for a keyboard-interactive question. ssh cuts the user at 30 and
 * the host at 128 characters in these prompts.
 */
export function parsePromptTarget(rawPrompt: string): { user: string; host: string } | undefined {
  const m = /^\s*\(?([^@\s()]+)@(.+?)(?:'s password:|\)\s)/i.exec(rawPrompt);
  return m ? { user: m[1], host: m[2] } : undefined;
}

type AskpassProfile = {
  authType?: string;
  password?: string;
  passphrase?: string;
  host?: string;
  username?: string;
  proxyJump?: string;
  proxyJumpProfileId?: string;
};

/** Whether this password prompt is addressed to the profile's own target, as opposed to a jump host on the way. */
function isAddressedToTarget(rawPrompt: string, config: AskpassProfile): boolean {
  const addressee = parsePromptTarget(rawPrompt);
  if (!addressee || !config.host || !config.username) return false;
  const host = config.host.trim().replace(/^\[|\]$/g, '');
  return addressee.user === config.username.slice(0, 30) && addressee.host.toLowerCase() === host.slice(0, 128).toLowerCase();
}

/**
 * The saved secret that may answer this prompt, if any. A key passphrase only ever answers a
 * passphrase prompt and the account password only a password prompt on a password profile; any
 * other prompt (a server-controlled keyboard-interactive question, a PIN) gets `undefined` so the
 * caller asks the user. Otherwise a remote server's "password:" prompt would receive the local
 * key passphrase.
 *
 * With a jump host the hop asks for its own password through the same askpass, so the target's password
 * only answers a prompt addressed to the target's own user@host; anything else is left to the user.
 */
export function savedAskpassAnswer(rawPrompt: string, config: AskpassProfile): string | undefined {
  if (isPasswordPrompt(rawPrompt)) {
    if (config.authType !== 'password' || !config.password) return undefined;
    const viaJumpHost = Boolean(config.proxyJump?.trim() || config.proxyJumpProfileId);
    if (viaJumpHost && !isAddressedToTarget(rawPrompt, config)) return undefined;
    return config.password;
  }
  // Only ssh's own local key prompt ("Enter passphrase for key '…':"). A server-controlled
  // keyboard-interactive question reaches askpass prefixed "(user@host) ", so it never matches.
  if (/^\s*Enter passphrase for /i.test(rawPrompt)) return config.passphrase || undefined;
  return undefined;
}

/**
 * A question the SSH server asked (keyboard-interactive). ssh always shows those as "(user@host) <text>",
 * whereas its own local prompts (key passphrase, PKCS#11 / FIDO PIN) have no such prefix.
 */
export function isServerAskedPrompt(rawPrompt: string): boolean {
  // `.` stops at a line break; a user or host name may itself contain `)`, so it is not excluded.
  return /^\s*\(.*@.*\)\s/.test(rawPrompt);
}

/**
 * Which kind of secret an OpenSSH askpass prompt wants. `undefined` is a key passphrase;
 * anything unrecognised is treated as a smartcard PIN, except a question the server asked: that is
 * never presented as a local PIN prompt, so a server cannot make the user type a hardware PIN into it.
 */
export function classifyAskpassPrompt(rawPrompt: string, authType?: string): AskpassPromptKind | undefined {
  if (isPasswordPrompt(rawPrompt) || isServerAskedPrompt(rawPrompt)) return 'password';
  if (authType === 'fido2' || /authenticator|security key|yubikey|fido|sk-/i.test(rawPrompt)) return 'fido2';
  return /passphrase/i.test(rawPrompt) ? undefined : 'smartcard';
}

/** What to show the user for an askpass prompt of an interactive SSH session. */
export function describeAskpassPrompt(
  rawPrompt: string,
  config: { authType?: string; name?: string; host: string }
): { kind: AskpassPromptKind | undefined; prompt: string; context: string } {
  const kind = classifyAskpassPrompt(rawPrompt, config.authType);
  const hostLabel = config.name ? `${config.name} (${config.host})` : config.host;
  if (kind === 'password') {
    return { kind, prompt: rawPrompt.trim(), context: `SSH: ${hostLabel}` };
  }
  if (kind === 'fido2') {
    return {
      kind,
      prompt: rawPrompt.trim() || `Enter PIN for security key to connect via SSH to ${hostLabel}:`,
      context: `FIDO2: ${hostLabel}`,
    };
  }
  return {
    kind,
    prompt: `Enter your smartcard PIN to connect via SSH to ${hostLabel}:`,
    context: `Smartcard: ${hostLabel}`,
  };
}
