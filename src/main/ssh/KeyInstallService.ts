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
  /** Fingeravtryck (`SHA256:...`), eller tom sträng för ogiltig rad. */
  fingerprint: string;
  status: KeyInstallStatus;
}

export interface KeyInstallOutcome {
  success: boolean;
  error?: string;
  results: KeyInstallKeyResult[];
  /** Inloggningen som användes (eller sist försöktes). */
  loginMethod?: InstallLoginStep;
}

/** Hur frågor från ssh (lösen, PIN, touch, värdnyckel) besvaras. */
export interface PromptHandlers {
  /** Frågar användaren efter lösen/PIN/lösenfras. Utan handler nekas allt som inte config redan kan svara på. */
  pinPromptHandler?: (prompt: string) => Promise<string> | string;
  /** Frågar om en okänd värdnyckel ska litas på. Saknas => nekas (fail closed). */
  hostKeyPromptHandler?: (info: HostKeyPromptInfo) => Promise<boolean>;
  onPresence?: (prompt: string) => void;
  onPresenceCleared?: () => void;
}

export interface KeyInstallOptions extends PromptHandlers {
  /** Config med jump host upplöst men utan smartcard/FIDO2-agent; den laddas först när profilens egen inloggning behövs. */
  config: SSHConnectionConfig;
  publicKeys: string[];
  loginMethod?: InstallLoginMethod;
  installsOwnKeyOnly?: boolean;
  serverMethods?: string[];
  /** Laddar kortets/nyckelns agent (PIN/touch). Anropas bara om profilens egen inloggning faktiskt försöks. */
  prepareProfileConfig?: (config: SSHConnectionConfig) => Promise<SSHConnectionConfig>;
}

const HOST_KEY_CONFIRM_RE = /are you sure you want to continue connecting/i;
const PRESENCE_RE = /confirm user presence|touch (your )?security key/i;
const MAX_STDOUT = 64 * 1024;

/**
 * Argument för en engångsanslutning som kör ett kort kommando. Bygger på samma argumentbyggare som
 * terminal och SFTP (jump host, proxy, chiffer, identiteter), men utan vidarebefordring, tunnlar och
 * multiplexing. OBS: OpenSSH låter första `-o` vinna, så `leadingArgs` hamnar FÖRE byggarens
 * alternativ medan övrigt läggs efter (och därför inte kan åsidosätta det byggaren redan satt).
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
  // buildSSHArguments slutar med `-- [user@]host`; alternativ måste in före det paret.
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
  /** 'accepted'/'rejected' om ssh ställde en värdnyckelfråga, annars 'trusted' (redan känd). */
  hostKey: 'trusted' | 'accepted' | 'rejected';
}

/**
 * Kör ett kommando över OpenSSH med askpass kopplat till UI:t. Gemensam för installation, probe och
 * inloggningstest. Stdin (om angiven) går aldrig via kommandoraden.
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
      // Sparade uppgifter via savedAskpassAnswer: lösen bara på lösenprofil, lösenfras bara på sshs egen lokala
      // nyckelfråga, aldrig på en fråga servern ställt. Lösen används högst en gång (NumberOfPasswordPrompts=1).
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

/** Config för kortinloggning med profilens PKCS#11-bibliotek, oavsett vilken metod profilen annars har. */
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

/** Config för redan upplåsta nycklar (skrivbordets ssh-agent och standardnycklar): inget kort, ingen vald fil. */
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

/** Config för lösenordsinloggning: inga nycklar, kort eller agenter, så inga PIN-/touch-frågor uppstår. */
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
  // stderr kan innehålla ssh-diagnostik men aldrig lösen/PIN (de går via askpass, inte stdin).
  return stderr.trim().split('\n').slice(-3).join(' ').trim() || `ssh exited with code ${code}`;
}

/** Bygger inloggningsconfig för ett steg; bara kort/FIDO2-steg laddar maskinvaruagenten (PIN/touch). */
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
 * Installerar publika nycklar i `~/.ssh/authorized_keys` på målhosten, som `ssh-copy-id`.
 * Inloggningsordning enligt `chooseLoginOrder` (aldrig med nyckeln som installeras); nekas en inloggning
 * provas nästa. Alla frågor (lösen, PIN, touch, värdnyckel) går via askpass till UI:t. Nycklarna skickas på
 * stdin och hamnar aldrig i kommandoraden.
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
      // Skriptet numrerar bara de giltiga raderna, i samma ordning som de skickades.
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
      // Bara en nekad inloggning motiverar nästa metod; nätverks- eller värdnyckelfel gör det inte.
      if (!/Permission denied/i.test(stderr)) break;
    }
    return { success: false, error: lastError, results, loginMethod: used };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), results, loginMethod: used };
  }
}

/**
 * Tyst probe utan lösen/PIN/touch: `ssh -o PreferredAuthentications=none ... true`. Svarar på om hosten nås
 * (genom jump host/proxy), om värdnyckeln är betrodd, och vilka auth-metoder servern tillåter. Bara en okänd
 * värdnyckel kan ge en fråga till användaren.
 */
export async function probeHost(config: SSHConnectionConfig, handlers: PromptHandlers = {}): Promise<ProbeHostResult> {
  // Ingen identitet behövs för probe: minimala argument (jump host och proxy följer med).
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
 * Riktig inloggning med profilens egen metod (kör `true`). Till skillnad från en ren konfigvalidering
 * bevisar det att kedjan fungerar, inklusive PIN/touch för smartcard och FIDO2.
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
 * Verifierar att inloggning med enbart den givna privata nyckelfilen fungerar (inga lösen, inga agenter).
 * Returnerar undefined när det inte går att avgöra utan interaktion: lösenfrasskyddad nyckel eller
 * FIDO2-nyckel (kräver touch). Då är ett misslyckande ingen information om servern.
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
