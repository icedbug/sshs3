/** Chromium `--password-store` backends this app may select. */
export type KeyringBackend = 'gnome-libsecret' | 'basic';

/**
 * The keyring backend for `safeStorage`. Production always uses the OS keyring ('gnome-libsecret'; see the long
 * comment in index.ts for why it is pinned). A development or test run can ask for 'basic' (no OS keyring at all) with
 * SSHS3_KEYRING_BACKEND=basic: an isolated test instance shares the keyring item of the real app (same app name), so
 * without this it can create or replace the key the real profiles' secrets are encrypted with. The override is ignored in
 * a packaged build, so the environment can never switch a released app away from the keyring.
 */
export function resolvePasswordStore(env: NodeJS.ProcessEnv, isPackaged: boolean): KeyringBackend {
  if (!isPackaged && env.SSHS3_KEYRING_BACKEND === 'basic') return 'basic';
  return 'gnome-libsecret';
}
