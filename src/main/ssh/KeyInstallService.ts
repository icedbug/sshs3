import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { SmartcardDetector } from '../smartcard/SmartcardDetector';
import { AskpassServer } from '../smartcard/AskpassServer';
import { resolveSshBinary, parseHostKeyPrompt } from '../storage/sftp/OpenSshSftpProcess';
import type { HostKeyPromptInfo } from './HostKeyVerifier';
import type {
  InstallLoginMethod,
  InstallLoginStep,
  ProbeHostResult,
  SSHConnectionConfig,
  TestLoginResult,
} from '../../shared/types/ssh';
import { chooseLoginOrder } from '../../shared/loginOrder';
import { isPasswordPrompt, savedAskpassAnswer } from './askpassPrompt';
import type { SFTPConfig } from '../../shared/types/storage';
import {
  parsePublicKeyLine,
  parseInstallOutput,
  parseProbeOutput,
  isPrivateKeyEncrypted,
  REMOTE_INSTALL_COMMAND,
} from './PublicKeyUtils';

export type KeyInstallStatus = 'installed' | 'present' | 'invalid' | 'unknown';

export interface KeyInstallKeyResult {
  /** Fingerprint (`SHA256:...`), or an empty string for an invalid line. */
  fingerprint: string;
  status: KeyInstallStatus;
}

export interface KeyInstallOutcome {
  success: boolean;
  error?: string;
  results: KeyInstallKeyResult[];
  /** The login that was used (or the last one tried). */
  loginMethod?: InstallLoginStep;
}

/** How prompts from ssh (password, PIN, touch, host key) are answered. */
export interface PromptHandlers {
  /** Asks the user for a password/PIN/passphrase. Without a handler, anything the config cannot already answer is refused. */
  pinPromptHandler?: (prompt: string) => Promise<string> | string;
  /** Asks whether an unknown host key should be trusted. Missing => refused (fail closed). */
  hostKeyPromptHandler?: (info: HostKeyPromptInfo) => Promise<boolean>;
  onPresence?: (prompt: string) => void;
  onPresenceCleared?: () => void;
}

export interface KeyInstallOptions extends PromptHandlers {
  /** Config with the jump host resolved but without a smartcard/FIDO2 agent; that is loaded only when the profile's own login is needed. */
  config: SSHConnectionConfig;
  publicKeys: string[];
  loginMethod?: InstallLoginMethod;
  installsOwnKeyOnly?: boolean;
  serverMethods?: string[];
  /** Loads the card's/key's agent (PIN/touch). Called only if the profile's own login is actually attempted. */
  prepareProfileConfig?: (config: SSHConnectionConfig) => Promise<SSHConnectionConfig>;
}

const HOST_KEY_CONFIRM_RE = /are you sure you want to continue connecting/i;
const PRESENCE_RE = /confirm user presence|touch (your )?security key/i;
const MAX_STDOUT = 64 * 1024;

/**
 * Arguments for a one-off connection that runs a short command. Uses the same argument builder as
 * the terminal and SFTP (jump host, proxy, ciphers, identities), but without forwarding, tunnels or
 * multiplexing. NOTE: OpenSSH lets the first `-o` win, so `leadingArgs` go BEFORE the builder's
 * options while the rest are added after (and so cannot override what the builder already set).
 */
export function buildKeyInstallArgs(
  config: SSHConnectionConfig,
  remoteCommand: string = REMOTE_INSTALL_COMMAND,
  leadingArgs: string[] = []
): string[] {
  const clean: SSHConnectionConfig = {
    ...config,
    forwardAgent: false,
    x11Forwarding: false,
    tunnels: undefined,
  };
  const args = SmartcardDetector.buildSSHArguments(clean);
  // buildSSHArguments ends with `-- [user@]host`; options have to go in before that pair.
  const destination = args.splice(-2);
  return [
    ...leadingArgs,
    ...args,
    '-o', 'BatchMode=no',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'NumberOfPasswordPrompts=1',
    '-o', 'ConnectTimeout=20',
    '-T',
    ...destination,
    remoteCommand,
  ];
}

export interface SshRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 'accepted'/'rejected' if ssh asked a host-key question, otherwise 'trusted' (already known). */
  hostKey: 'trusted' | 'accepted' | 'rejected';
}

/**
 * Runs a command over OpenSSH with askpass wired to the UI. Shared by the install, the probe and the
 * login test. Stdin (if given) never goes through the command line.
 */
export async function runSshCommand(
  config: SSHConnectionConfig,
  remoteCommand: string,
  handlers: PromptHandlers = {},
  opts: { stdin?: string; leadingArgs?: string[] } = {}
): Promise<SshRunResult> {
  const { pinPromptHandler, hostKeyPromptHandler, onPresence, onPresenceCleared } = handlers;
  let passwordAnswered = false;
  let hostKey: SshRunResult['hostKey'] = 'trusted';
  const askpass = new AskpassServer({
    onPresence: (prompt) => onPresence?.(prompt),
    promptHandler: async (rawPrompt: string) => {
      if (HOST_KEY_CONFIRM_RE.test(rawPrompt)) {
        if (!hostKeyPromptHandler) {
          hostKey = 'rejected';
          return 'no';
        }
        const info = parseHostKeyPrompt(rawPrompt, { host: config.host, port: config.port ?? 22 } as SFTPConfig);
        const trusted = await hostKeyPromptHandler(info);
        hostKey = trusted ? 'accepted' : 'rejected';
        return trusted ? 'yes' : 'no';
      }
      // Saved credentials via savedAskpassAnswer: the password only on a password profile, the passphrase only on
      // ssh's own local key prompt, never on a prompt the server sent. The password is used at most once
      // (NumberOfPasswordPrompts=1).
      const saved = savedAskpassAnswer(rawPrompt, config);
      if (saved !== undefined) {
        if (!isPasswordPrompt(rawPrompt)) return saved;
        if (!passwordAnswered) {
          passwordAnswered = true;
          return saved;
        }
      }
      return pinPromptHandler ? await pinPromptHandler(rawPrompt) : '';
    },
  });

  try {
    await askpass.start();
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...askpass.getEnv(),
      ...SmartcardDetector.buildProxyEnv(config),
    };
    if (config.agentPath) env.SSH_AUTH_SOCK = config.agentPath;

    const args = buildKeyInstallArgs(config, remoteCommand, opts.leadingArgs);
    const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(resolveSshBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'], env });
        let out = '';
        let err = '';
        child.stdout?.on('data', (c: Buffer) => {
          out = (out + c.toString('utf-8')).slice(-MAX_STDOUT);
        });
        child.stderr?.on('data', (c: Buffer) => {
          const text = c.toString('utf-8');
          err = (err + text).slice(-4096);
          if (PRESENCE_RE.test(text)) onPresence?.(text.trim());
        });
        child.once('error', reject);
        child.once('close', (c) => resolve({ code: c, stdout: out, stderr: err }));
        child.stdin?.on('error', () => {});
        child.stdin?.end(opts.stdin ?? '');
      }
    );
    return { code, stdout, stderr, hostKey };
  } finally {
    onPresenceCleared?.();
    await askpass.stop().catch(() => {});
  }
}

/** Config for a smartcard login with the profile's PKCS#11 library, whatever method the profile otherwise uses. */
function toSmartcardConfig(config: SSHConnectionConfig): SSHConnectionConfig {
  return {
    ...config,
    authType: 'smartcard',
    privateKeyPath: undefined,
    fido2Resident: undefined,
    agentPath: undefined,
    password: undefined,
  };
}

/** Config for keys that are already unlocked (the desktop's ssh-agent and default keys): no card, no chosen file. */
function toAgentConfig(config: SSHConnectionConfig): SSHConnectionConfig {
  return {
    ...config,
    authType: 'agent',
    privateKeyPath: undefined,
    pkcs11LibPath: undefined,
    fido2Resident: undefined,
    agentPath: undefined,
    password: undefined,
  };
}

/** Config for a password login: no keys, cards or agents, so no PIN/touch prompts come up. */
function toPasswordConfig(config: SSHConnectionConfig): SSHConnectionConfig {
  return {
    ...config,
    authType: 'password',
    privateKeyPath: undefined,
    pkcs11LibPath: undefined,
    agentPath: undefined,
    fido2Resident: undefined,
    passphrase: undefined,
  };
}

function lastErrorLines(stderr: string, code: number | null): string {
  // stderr can hold ssh diagnostics but never a password/PIN (those go through askpass, not stdin).
  return stderr.trim().split('\n').slice(-3).join(' ').trim() || `ssh exited with code ${code}`;
}

/** Builds the login config for one step; only smartcard/FIDO2 steps load the hardware agent (PIN/touch). */
async function configForStep(
  step: InstallLoginStep,
  config: SSHConnectionConfig,
  prepare?: (config: SSHConnectionConfig) => Promise<SSHConnectionConfig>
): Promise<SSHConnectionConfig> {
  switch (step) {
    case 'password':
      return toPasswordConfig(config);
    case 'agent':
      return toAgentConfig(config);
    case 'smartcard': {
      const card = toSmartcardConfig(config);
      return prepare ? prepare(card) : card;
    }
    default:
      return prepare ? prepare(config) : config;
  }
}

/**
 * Installs public keys in `~/.ssh/authorized_keys` on the target host, like `ssh-copy-id`.
 * The login order follows `chooseLoginOrder` (never with the key being installed); if one login is denied
 * the next is tried. All prompts (password, PIN, touch, host key) go through askpass to the UI. The keys are
 * sent on stdin and never end up on the command line.
 */
export async function installPublicKeys(options: KeyInstallOptions): Promise<KeyInstallOutcome> {
  const { config, prepareProfileConfig } = options;

  const parsed = options.publicKeys.map((k) => parsePublicKeyLine(k));
  const valid = parsed.filter((p): p is NonNullable<typeof p> => p !== null);
  const results: KeyInstallKeyResult[] = parsed.map((p) =>
    p ? { fingerprint: p.fingerprint, status: 'unknown' } : { fingerprint: '', status: 'invalid' }
  );
  if (valid.length === 0) {
    return { success: false, error: 'No valid public key to install', results };
  }

  const order = chooseLoginOrder({
    authType: config.authType,
    loginMethod: options.loginMethod,
    installsOwnKeyOnly: options.installsOwnKeyOnly,
    serverMethods: options.serverMethods,
    hasSmartcardLib: !!config.pkcs11LibPath?.trim(),
  });
  if (order.length === 0) {
    return {
      success: false,
      error:
        'The host only accepts keys, and the only key selected is the one this profile logs in with. ' +
        'Log in with another key ("Log in with: Profile\'s key"), or run the copied command on the host.',
      results,
    };
  }

  if (order.includes('smartcard') && !config.pkcs11LibPath?.trim()) {
    return { success: false, error: 'Choose a PKCS#11 library in the profile to log in with the smartcard.', results };
  }

  const stdin = valid.map((p) => p.line).join('\n') + '\n';
  let lastError = '';
  let used: InstallLoginStep = order[0];
  try {
    for (const mode of order) {
      used = mode;
      const loginConfig = await configForStep(mode, config, prepareProfileConfig);
      const { code, stdout, stderr } = await runSshCommand(loginConfig, REMOTE_INSTALL_COMMAND, options, { stdin });

      const statuses = parseInstallOutput(stdout);
      // The script numbers only the valid lines, in the order they were sent.
      let n = 0;
      for (const r of results) {
        if (r.status === 'invalid') continue;
        n += 1;
        r.status = statuses.get(n) ?? 'unknown';
      }
      if (code === 0 && statuses.size >= valid.length) {
        return { success: true, results, loginMethod: used };
      }
      lastError = lastErrorLines(stderr, code);
      // Only a denied login justifies trying the next method; network or host-key errors do not.
      if (!/Permission denied/i.test(stderr)) break;
    }
    return { success: false, error: lastError, results, loginMethod: used };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), results, loginMethod: used };
  }
}

/**
 * Silent probe without password/PIN/touch: `ssh -o PreferredAuthentications=none ... true`. Tells whether the
 * host is reachable (through the jump host/proxy), whether the host key is trusted, and which auth methods the
 * server allows. Only an unknown host key can lead to a question for the user.
 */
export async function probeHost(config: SSHConnectionConfig, handlers: PromptHandlers = {}): Promise<ProbeHostResult> {
  // The probe needs no identity: minimal arguments (the jump host and proxy still apply).
  const bare: SSHConnectionConfig = {
    ...config,
    authType: 'agent',
    privateKeyPath: undefined,
    pkcs11LibPath: undefined,
    agentPath: undefined,
    fido2Resident: undefined,
    password: undefined,
    passphrase: undefined,
  };
  try {
    const { code, stderr, hostKey } = await runSshCommand(bare, 'true', handlers, {
      leadingArgs: ['-o', 'PreferredAuthentications=none', '-o', 'PubkeyAuthentication=no'],
    });
    const p = parseProbeOutput(stderr, code);
    const finalHostKey: ProbeHostResult['hostKey'] = p.hostKeyChanged ? 'changed' : hostKey;
    return {
      reachable: p.reachable && finalHostKey !== 'rejected',
      hostKey: finalHostKey,
      methods: p.methods,
      errorKind: finalHostKey === 'rejected' && !p.errorKind ? 'hostkey-rejected' : p.errorKind,
      error: finalHostKey === 'rejected' && !p.error ? 'The host key was not trusted.' : p.error,
    };
  } catch (err) {
    return {
      reachable: false,
      hostKey: 'trusted',
      methods: [],
      errorKind: 'unknown',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * A real login with the profile's own method (runs `true`). Unlike a pure config validation, it
 * proves that the chain works, including PIN/touch for smartcard and FIDO2.
 */
export async function testLogin(
  config: SSHConnectionConfig,
  handlers: PromptHandlers = {}
): Promise<TestLoginResult> {
  // A key-based profile must prove its own key works: without this, OpenSSH quietly falls back to a
  // password prompt and a rejected key would be reported as "logged in".
  const leadingArgs =
    config.authType === 'password' ? [] : ['-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no'];
  try {
    const { code, stderr } = await runSshCommand(config, 'true', handlers, { leadingArgs });
    return code === 0 ? { success: true } : { success: false, error: lastErrorLines(stderr, code) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Verifies that a login with only the given private key file works (no passwords, no agents).
 * Returns undefined when that cannot be decided without interaction: a passphrase-protected key or
 * a FIDO2 key (needs touch). A failure then says nothing about the server.
 */
export async function verifyKeyLogin(
  config: SSHConnectionConfig,
  privateKeyPath: string,
  keyType: string
): Promise<boolean | undefined> {
  if (keyType.startsWith('sk-')) return undefined;
  let text: string;
  try {
    text = await fs.readFile(privateKeyPath, 'utf-8');
  } catch {
    return undefined;
  }
  if (isPrivateKeyEncrypted(text)) return undefined;

  const probe: SSHConnectionConfig = {
    ...config,
    authType: 'privateKey',
    privateKeyPath,
    password: undefined,
    passphrase: undefined,
    agentPath: undefined,
    forwardAgent: false,
    x11Forwarding: false,
    tunnels: undefined,
  };
  const args = SmartcardDetector.buildSSHArguments(probe);
  const destination = args.splice(-2);
  args.push(
    '-o', 'BatchMode=yes',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'PubkeyAuthentication=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ConnectTimeout=15',
    '-T',
    ...destination,
    'true'
  );
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...SmartcardDetector.buildProxyEnv(probe),
  };
  return new Promise<boolean>((resolve) => {
    const child = spawn(resolveSshBinary(), args, { stdio: ['ignore', 'ignore', 'ignore'], env });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}
