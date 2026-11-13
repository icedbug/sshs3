import type { InstallLoginMethod, InstallLoginStep, SSHAuthType } from './types/ssh';

const KEY_AUTH_TYPES: SSHAuthType[] = ['privateKey', 'agent', 'smartcard', 'fido2'];

export interface LoginOrderInput {
  authType: SSHAuthType;
  loginMethod?: InstallLoginMethod;
  /** true when the selected keys are only the profile's own login key. */
  installsOwnKeyOnly?: boolean;
  /** Auth methods the server advertised at the probe, if known. */
  serverMethods?: string[];
  /** The profile has a PKCS#11 library set (e.g. left over from when it used a smartcard). */
  hasSmartcardLib?: boolean;
}

/**
 * The order in which we try to log in to install keys. Rule: never log in with the key that is being
 * installed. If the profile has a smartcard library (typically left over after a switch to FIDO2) the card
 * is tried before the password, because the host often trusts it already. An empty list means there is no
 * sensible login (the host only takes keys and the only key we have is the one to be installed).
 * Shared by main (which runs the order) and the renderer (which shows it).
 */
export function chooseLoginOrder(opts: LoginOrderInput): InstallLoginStep[] {
  const { authType, loginMethod = 'auto', installsOwnKeyOnly = false, serverMethods, hasSmartcardLib = false } = opts;
  if (loginMethod !== 'auto') return [loginMethod];
  if (authType === 'password') return ['password'];

  const passwordAllowed =
    !serverMethods || serverMethods.includes('password') || serverMethods.includes('keyboard-interactive');
  const profileIsKey = KEY_AUTH_TYPES.includes(authType);
  const card: InstallLoginStep[] = hasSmartcardLib && authType !== 'smartcard' ? ['smartcard'] : [];
  const password: InstallLoginStep[] = passwordAllowed ? ['password'] : [];

  if (installsOwnKeyOnly && profileIsKey) return [...card, ...password];
  return ['profile', ...card, ...password];
}

export const LOGIN_STEP_LABELS: Record<InstallLoginStep, string> = {
  password: 'Password', // pragma: allowlist secret
  profile: "This profile's key",
  smartcard: 'Smartcard (PKCS#11)',
  agent: 'Already-unlocked keys (ssh-agent)',
};
