/**
 * ssh_config / ssh command-line directives that must never be accepted from
 * untrusted input — either a connection profile's free-form `extraOptions`
 * (built into a native `ssh` command line by `SmartcardDetector`) or a
 * managed block written into the user's real `~/.ssh/config` by remote
 * profile sync (`SshNativeFileMerger`). Both call sites share this single
 * list so adding a new dangerous directive only has to happen once.
 *
 * A sync source that can plant one of these (a compromised sync target, a
 * compromised paired device, or a leaked master password) would otherwise
 * get, depending on the directive: arbitrary command execution as the local
 * user (`ProxyCommand`, `LocalCommand`, `RemoteCommand`, `KnownHostsCommand`),
 * config injection (`Match`, `Include`), or a silent host-key-verification
 * bypass enabling MITM (`StrictHostKeyChecking`, `UserKnownHostsFile`,
 * `GlobalKnownHostsFile`, `HostbasedAuthentication`, `IdentityAgent`).
 *
 * Do not remove entries without understanding why they're here.
 */
export const BLOCKED_SSH_DIRECTIVES = new Set([
  'proxycommand',
  'localcommand',
  'permitlocalcommand',
  'remotecommand',
  'match',
  'include',
  'knownhostscommand',
  'stricthostkeychecking',
  'userknownhostsfile',
  'globalknownhostsfile',
  'hostbasedauthentication',
  'identityagent',
  // Load an arbitrary local library into ssh / spawn a local helper.
  'securitykeyprovider',
  'xauthlocation',
  // Sends local environment variables (`SendEnv *` would include secrets held in the ssh process's environment).
  'sendenv',
]);

/**
 * The only options a profile's free-form `extraOptions` may carry. Unlike the blocklist
 * above this is an allowlist: `extraOptions` can arrive from a synced or imported profile
 * (untrusted), and ssh has far too many directives that run commands, load libraries,
 * redirect the connection or weaken verification (and new ones appear in every release)
 * to enumerate the bad ones. Everything here only tunes the connection itself.
 *
 * Deliberately absent: anything the app sets itself from first-class profile fields
 * (identity files, agent, PKCS#11, jump hosts, proxy, control sockets, forwarding, X11) and
 * anything affecting host-key verification or running commands.
 */
export const ALLOWED_SSH_EXTRA_OPTIONS = new Set([
  'serveraliveinterval',
  'serveralivecountmax',
  'tcpkeepalive',
  'compression',
  'connecttimeout',
  'connectionattempts',
  'ipqos',
  'addressfamily',
  'ciphers',
  'macs',
  'kexalgorithms',
  'hostkeyalgorithms',
  'pubkeyacceptedalgorithms',
  'preferredauthentications',
  'identitiesonly',
  'numberofpasswordprompts',
  'requesttty',
  'loglevel',
  'escapechar',
  'exitonforwardfailure',
  'hashknownhosts',
  'visualhostkey',
  'rekeylimit',
  // Not 'sendenv': it forwards local environment variables to the server, and the ssh child's environment holds
  // secrets (e.g. SSHS3_PROXY_PASSWORD). 'setenv' only sets the fixed values written in the option itself.
  'setenv',
]);

/** True when `key` is exactly one allowlisted option name (so "ProxyCommand x #" or quoted names never match). */
export function isAllowedExtraOption(key: string): boolean {
  return ALLOWED_SSH_EXTRA_OPTIONS.has(key.trim().toLowerCase());
}

/**
 * The directives a managed `~/.ssh/config` block may contain when it arrives from a sync pull:
 * exactly what buildSshConfigHostBlock generates, plus the allowlisted extra options. Anything
 * else (e.g. VerifyHostKeyDNS, CanonicalizeHostname, UpdateHostKeys, or a directive added in a
 * future OpenSSH release) is stripped, since a blocklist cannot enumerate the dangerous ones.
 * `proxyjump`, `forwardagent` and `pkcs11provider` are generated from the sender's profiles and
 * therefore stay accepted here.
 */
export const ALLOWED_MANAGED_BLOCK_DIRECTIVES = new Set([
  'host',
  'hostname',
  'port',
  'user',
  'identityfile',
  'pkcs11provider',
  'proxyjump',
  'forwardagent',
  ...ALLOWED_SSH_EXTRA_OPTIONS,
]);
