import fs from 'node:fs';
import path from 'node:path';

/**
 * What keeps one account of a web server inside its own folder. The desktop app never turns any of this
 * on: there the person at the keyboard owns the machine.
 *
 * On a web server one process serves every account, so "the home folder", "the ssh config" and "the
 * kubeconfig" of the process are the server's own, and one account's files are next to another's. Two
 * things hold the line. A path a client names is followed through every link before it is used and
 * refused when it ends outside the account's folder. And an ssh child or a Kubernetes client is only
 * started with files the account's own services were given: with the server-wide switch on, a caller
 * that forgot them is refused instead of quietly using the server's.
 */

let webServerProcess = false;

/** Turned on once by the web server. From then on ssh and Kubernetes never fall back to the server's own files. */
export function setWebServerProcess(on: boolean): void {
  webServerProcess = on;
}

export function isWebServerProcess(): boolean {
  return webServerProcess;
}

/**
 * Where `target` really is: every existing part followed through links, then what does not exist yet.
 * A link that points nowhere is refused: a write to it would create its target, wherever that is.
 */
export function realLocation(target: string): string {
  let existing = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(existing);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      if (fs.lstatSync(existing, { throwIfNoEntry: false })) throw new Error('That path goes through a link that leads nowhere.', { cause: error });
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

/** Whether `target`, followed through every link, is `root` or inside it. Anything that cannot be resolved is outside. */
export function isInside(root: string, target: string): boolean {
  try {
    const realRoot = realLocation(root);
    const real = realLocation(target);
    return real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
  } catch {
    return false;
  }
}

/** The files an account's ssh children read instead of the server user's `~/.ssh`. */
export interface SshClientFiles {
  /** Given to ssh with `-F`. It names the account's known hosts file and its key, and nothing else. */
  configPath: string;
  /**
   * The account's own ssh config: sshs3 keeps the account's saved hosts in a block of it, as it does in
   * `~/.ssh/config` on the desktop. No ssh process of the server reads it (see sshClientConfigText).
   */
  managedConfigPath: string;
  knownHostsPath: string;
}

// A symbol, so a config that arrives from a client as JSON can never carry it, and `{ ...config }` keeps it.
const SSH_CLIENT_FILES = Symbol('sshs3.sshClientFiles');

/** A copy of `config` that carries the account's ssh files. Only the account's own services call this. */
export function withSshClientFiles<T extends object>(config: T, files: SshClientFiles): T {
  return { ...config, [SSH_CLIENT_FILES]: files };
}

export function sshClientFilesOf(config: object | undefined | null): SshClientFiles | undefined {
  return config ? (config as Record<symbol, SshClientFiles | undefined>)[SSH_CLIENT_FILES] : undefined;
}

/** Names that say a variable holds a secret, whatever program it belongs to. */
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SESSION_?KEY/i;

/**
 * The part of the server's own environment a child started for an account gets. The server's
 * environment is the deployment's: its administrator password, its credential key, cloud keys and
 * tokens of whatever else runs beside it. None of that is the account's. What is left is what a
 * program needs to run at all (PATH, locale, library paths and the like).
 *
 * Left out: every variable of sshs3's own (`SSHS3_*`; the app adds the ones a child needs afterwards),
 * the server's ssh agent, and every name that says it holds a secret.
 */
export function serverEnvForAccountChild(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^SSHS3_/i.test(name) || name === 'SSH_AUTH_SOCK' || name === 'SSH_AGENT_PID' || SECRET_NAME.test(name)) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * The arguments that make an ssh child read the account's files. On the desktop: none, ssh reads the
 * person's own `~/.ssh`. On a web server a config without the account's files is refused.
 */
export function sshClientFileArgs(config: object): string[] {
  const files = sshClientFilesOf(config);
  if (files) return ['-F', files.configPath];
  if (webServerProcess) throw new Error('This connection was not set up for an account of this server, so it is not started.');
  return [];
}

function quoted(file: string): string {
  if (/["\r\n]/.test(file)) throw new Error('The server data folder has a character ssh cannot read in a path.');
  return `"${file}"`;
}

/**
 * The text of the file ssh is started with for one account. It holds for every host, a jump host
 * included (ssh starts the process for a jump host with the same file): host keys go to the account's
 * own file, the server's ssh agent is never asked, and the account's key is the only one offered when a
 * connection names none (without it ssh would try the server user's).
 *
 * The account's saved hosts (`.ssh/config`) are deliberately not read from here. What is in that file
 * comes from the account's profiles and from profile sync, and a host entry may name any key file or a
 * PKCS#11 library: ssh would use them for a host of that name, past the check a connection's own key
 * file gets. Everything a connection needs is on its command line, built and checked by the app.
 */
export function sshClientConfigText(files: { knownHostsPath: string; identityFile?: string }): string {
  return [
    '# Written by sshs3 for one account of this web server. It is written again when the account starts.',
    'Host *',
    `  UserKnownHostsFile ${quoted(files.knownHostsPath)}`,
    '  IdentityAgent none',
    `  IdentityFile ${files.identityFile ? quoted(files.identityFile) : 'none'}`,
    '',
  ].join('\n');
}

/**
 * Makes sure an account's ssh files are there and returns where they are: `.ssh/config` (its saved
 * hosts), `.ssh/known_hosts` (made by ssh when the first host key is accepted) and `.ssh/sshs3_config`,
 * the file ssh is started with. An account starts with no known host: host keys the server's own user
 * accepted before are not the account's, and each is asked about again.
 */
export function ensureAccountSshFiles(homeDir: string, identityFile?: string): SshClientFiles {
  const dir = path.join(homeDir, '.ssh');
  const files: SshClientFiles = {
    configPath: path.join(dir, 'sshs3_config'),
    managedConfigPath: path.join(dir, 'config'),
    knownHostsPath: path.join(dir, 'known_hosts'),
  };
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(files.managedConfigPath)) fs.writeFileSync(files.managedConfigPath, '', { mode: 0o600 });
  // ssh refuses a config file that others may write, so the mode is set on every start, not only when it is made.
  fs.writeFileSync(files.configPath, sshClientConfigText({ ...files, identityFile }), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(files.configPath, 0o600);
  return files;
}

/** One account of a web server, as far as its ssh connections need it. */
export interface SshAccount {
  /** The account's own folder. A key file a connection names has to be in it. */
  homeDir: string;
  files: SshClientFiles;
}

/**
 * A connection as an account of a web server may use it, carrying the account's ssh files. The config
 * comes from a client or from a saved profile the account wrote, so it is checked here, once, before
 * anything is started for it:
 *
 * - a key file or certificate it names has to be inside the account's own folder (followed through
 *   links): otherwise the server would sign in somewhere with a key that is another account's or its own;
 * - a smartcard or security key is refused: the PKCS#11 library is a program the server would load, and
 *   the reader would be the server's;
 * - the agent socket, the X display and the certificate authority are the server's, not the account's:
 *   whatever the config says about them is dropped. So are saved tunnels: a tunnel would listen on the
 *   server, or lead from the other host into the server's own network.
 *
 * A config that already carries this account's files went through here before; what the app added to it
 * since (its own agent, for one) is kept.
 */
export function confineSshConfig<T extends object>(config: T, account: SshAccount): T {
  if (sshClientFilesOf(config) === account.files) return config;
  const asked = config as T & {
    authType?: string;
    privateKeyPath?: unknown;
    certificateFile?: unknown;
    x11Forwarding?: unknown;
  };
  if (asked.authType === 'smartcard' || asked.authType === 'fido2') {
    throw new Error(
      "A smartcard or security key cannot be used on the sshs3 web server: it would be the server's card reader, not yours. Use a key file or a password."
    );
  }
  for (const field of ['privateKeyPath', 'certificateFile'] as const) {
    const file = asked[field];
    if (file === undefined || file === null || file === '') continue;
    if (typeof file !== 'string' || !path.isAbsolute(file) || !isInside(account.homeDir, file)) {
      throw new Error(
        'The key file of this connection is not in your own folder on this sshs3 server. Remove it from the server profile to sign in with your own key.'
      );
    }
  }
  const own = { ...config } as Record<string, unknown>;
  for (const field of ['agentPath', 'agentIdentityFiles', 'pkcs11LibPath', 'useSshCa', 'x11Display', 'fido2Resident', 'tunnels']) delete own[field];
  if (asked.x11Forwarding) own.x11Forwarding = false;
  return withSshClientFiles(own as T, account.files);
}

/**
 * An S3 connection as an account of a web server may use it. AWS SSO keeps its sign-in in the server
 * user's home folder, one for every account, so it is refused; a certificate file has to be the account's own.
 */
export function confineS3Config<T extends object>(config: T, homeDir: string): T {
  const asked = config as T & { authMode?: unknown; customCaPath?: unknown };
  if (asked.authMode === 'sso') {
    throw new Error(
      'AWS SSO sign-in cannot be used on the sshs3 web server: it is kept in one place for every account. Use an access key for this bucket.'
    );
  }
  const ca = asked.customCaPath;
  if (ca !== undefined && ca !== null && ca !== '' && (typeof ca !== 'string' || !path.isAbsolute(ca) || !isInside(homeDir, ca))) {
    throw new Error('The certificate file of this connection is not in your own folder on this sshs3 server.');
  }
  return config;
}

/** The environment variables a web client may set on a terminal it opens. Everything else is the server's. */
const CLIENT_ENV_NAMES = /^(?:TERM|COLORTERM|LANG|LC_[A-Z_]{1,24})$/;
const CLIENT_ENV_VALUE = /^[\x20-\x7e]{1,128}$/;

/** What is left of a web client's environment for a terminal: a few display and language names, short and printable. */
export function clientTerminalEnv(env: unknown): Record<string, string> {
  const kept: Record<string, string> = {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) return kept;
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (typeof value === 'string' && CLIENT_ENV_NAMES.test(name) && CLIENT_ENV_VALUE.test(value)) kept[name] = value;
  }
  return kept;
}
