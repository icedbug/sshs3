import type { ProxyConfig } from './storage';

export type SSHAuthType = 'password' | 'privateKey' | 'smartcard' | 'agent' | 'fido2';

export type SSHTunnelType = 'local' | 'remote' | 'dynamic';

export interface SSHTunnelConfig {
  id: string;
  /** User-chosen display label, independent of the underlying SSH profile's name (e.g. "jumpbox", "prod-bastion"). */
  name: string;
  type: SSHTunnelType;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  description?: string;
  enabled?: boolean;
}

/** A currently running standalone tunnel process (started independently of any terminal session). */
export interface SSHActiveTunnel {
  id: string;
  connectionId: string;
  connectionName: string;
  tunnel: SSHTunnelConfig;
  status: 'active' | 'error';
  startedAt: string;
  error?: string;
  pid?: number;
}

export interface SSHConnectionConfig {
  id: string;
  name: string;
  host: string;
  port?: number; // default 22
  username: string;
  authType: SSHAuthType;
  password?: string;
  /** Team Vault only, set by the main process on read: true when a password is stored but was
   * stripped before reaching the renderer (member role — see TeamVaultService.getPayloadForRenderer).
   * Never persisted as part of the profile itself. */
  hasPassword?: boolean;
  /** Team Vault only, set by the renderer when connecting a shared profile: lets main resolve the
   * real secret fields itself (TeamVaultService.resolveProfileForConnect) instead of trusting
   * this object's own password/passphrase, which may have been stripped for a member. Never
   * persisted. */
  teamVaultProfileRef?: { vaultId: string; profileId: string };
  privateKeyPath?: string;
  passphrase?: string;
  pkcs11LibPath?: string; // path to .so or .dll
  pin?: string;
  agentPath?: string;
  /**
   * Runtime only, never persisted or synced: public key files selecting which of the keys in a shared
   * agent (`agentPath`) this connection may use. Set when the agent holds more than this profile's
   * card (the app-wide agent); makes ssh run with IdentitiesOnly and one `-i` per file.
   */
  agentIdentityFiles?: string[];
  /**
   * authType 'fido2' only. true = a discoverable/resident credential loaded
   * straight off the connected security key (no privateKeyPath); false/unset
   * = a regular `id_*_sk` key file referenced by privateKeyPath, same as a
   * plain 'privateKey' profile. Resident mode requires an ssh-agent (the app
   * loads one privately per session); SFTP uses the same OpenSSH path as the terminal.
   */
  fido2Resident?: boolean;
  extraOptions?: Record<string, string>;
  initialPath?: string;
  proxy?: ProxyConfig;
  group?: string;
  lastUsedAt?: string;
  /** ISO 8601 timestamp of the last edit. Used by remote profile sync to resolve conflicts. */
  updatedAt?: string;
  /** ISO 8601 timestamp set instead of removing the entry outright, so sync can propagate the deletion. */
  deletedAt?: string;
  /** Whether to forward the local ssh-agent to the remote host (-A / ForwardAgent yes). */
  forwardAgent?: boolean;
  /** Whether to enable X11 forwarding (-Y / ForwardX11Trusted yes). */
  x11Forwarding?: boolean;
  /** Custom local X11 display (default: '127.0.0.1:0.0' on Windows, process.env.DISPLAY or ':0' on Linux/macOS). */
  x11Display?: string;
  compression?: boolean;
  serverAliveInterval?: number;
  ciphers?: string;
  kexAlgorithms?: string;
  macs?: string;
  /**
   * References another saved SSH profile to jump through, taking precedence over `proxyJump`
   * when both are set (the UI only ever sets one at a time). Falls back to `proxyJump`'s raw
   * `user@host[:port]` text when the id doesn't resolve to a live profile (e.g. it was deleted).
   */
  proxyJumpProfileId?: string;
  /** Manually-entered ProxyJump target, e.g. "jumpuser@bastion.example.com:22" — for jump hosts not managed as a profile in this app. Ignored when `proxyJumpProfileId` resolves. */
  proxyJump?: string;
  tunnels?: SSHTunnelConfig[];
  /** Dotfiles pool to sync on connect. Unset = feature not opted into for this host. */
  poolId?: string;
  /** Unset = never sync, even if a pool is assigned. 'ask' prompts on diff, 'always' syncs silently. */
  dotfilesSyncPolicy?: 'ask' | 'always';
  /** Whether to automatically attempt reconnection when the SSH session drops unexpectedly. */
  autoReconnect?: boolean;
  /** Maximum number of auto-reconnection attempts (default: 3). */
  maxReconnectAttempts?: number;
  /** Initial delay in ms before reconnection attempts (default: 2000ms). */
  reconnectDelayMs?: number;
  /** Shared Workspace description of what this VM/server/cluster does. */
  description?: string;
  /** Cluster name this node belongs to (e.g. 'k8s-eu-north-1', 'Proxmox-Prod', 'Postgres-HA'). */
  cluster?: string;
  /** Node role inside the cluster (e.g. 'control-plane', 'worker-node', 'gpu-node', 'ingress', 'primary-db', 'replica-db'). */
  nodeRole?: string;
  /** Infrastructure role (e.g. 'web', 'database', 'proxy', 'k8s', 'worker', 'bastion', 'storage'). */
  role?: string;
  /** Services or tags running on this host (e.g. ['nginx', 'docker', 'postgres']). */
  tags?: string[];
  /** Team member / user who last updated this profile's metadata. */
  updatedBy?: string;
  /** Whether this SSH node is shared in the S3 Team Workspace. */
  shared?: boolean;
}

export interface DetectedSmartcardLib {
  name: string; // ('Net iD', 'OpenSC', etc.)
  path: string;
  platform: 'linux' | 'win32';
  exists: boolean;
}

/** One identity (certificate/key) an app-managed smartcard agent currently holds. */
export interface CachedSmartcardIdentity {
  comment: string; // e.g. "PIV AUTH pubkey" — the certificate's label
  fingerprint: string;
  keyType: string;
  /**
   * X.509 certificate details for this identity, read directly from the PKCS#11 token and
   * matched to it by fingerprint. Undefined if the token doesn't expose a readable certificate
   * for this key, or reading/parsing it failed — the identity itself is still valid either way.
   */
  certificate?: {
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    upn?: string;
  };
}

/** One cached global smartcard agent ('agent-global' PIN caching mode), and what it holds. */
export interface CachedSmartcardAgent {
  pkcs11LibPath: string;
  identities: CachedSmartcardIdentity[];
}

export type Fido2KeyType = 'ed25519-sk' | 'ecdsa-sk';

/** One discoverable ("resident") FIDO2 credential found on a connected security key. */
export interface Fido2ResidentKey {
  fingerprint: string;
  comment: string;
  keyType: string;
  /**
   * Present only when this entry came from `ykman` rather than the `ssh-add
   * -K` fallback — required to delete this specific credential (`ssh-add`
   * has no per-credential delete of its own). Its absence is what the UI
   * uses to decide whether to show a delete button for this entry at all.
   */
  credentialId?: string;
}

/**
 * Marks the specific "outPath already exists" error `generateFido2Key` throws, so the renderer
 * (which only ever sees a thrown Error's `message` across the IPC boundary — everything else about
 * a custom error class is lost) can offer an overwrite-and-retry instead of just showing the text.
 */
export const FIDO2_KEY_FILE_EXISTS_PREFIX = 'FIDO2_KEY_FILE_EXISTS:';

export interface GenerateFido2KeyRequest {
  outPath: string;
  keyType: Fido2KeyType;
  resident: boolean;
  verifyRequired: boolean;
  /** Replace a pre-existing file at outPath instead of failing — only send this after the user has confirmed it. */
  overwrite?: boolean;
}

export interface GeneratedFido2Key {
  publicKey: string;
  privateKeyPath: string;
  publicKeyPath: string;
}

/** Local shell to spawn on Windows. Ignored on macOS/Linux, which always use the user's $SHELL. */
export type LocalShellType = 'default' | 'cmd' | 'powershell' | 'pwsh' | 'wsl';

export interface PtyOptions {
  /** Host-selected executable and args for dedicated jobs. */
  shellBinary?: string;
  shellArgs?: string[];
  cols?: number; // default 80
  rows?: number; // default 24
  cwd?: string;
  env?: Record<string, string>;
  /** Windows only: which shell to spawn for a local terminal. */
  shellType?: LocalShellType;
  /** Windows only: specific WSL distribution to launch (wsl.exe -d <distro>). */
  wslDistro?: string;
}

export interface SSHPtyExitEvent {
  exitCode: number;
  signal?: number;
}

export interface SSHPtySession {
  sessionId: string;
  config: SSHConnectionConfig;
  pid: number;
  cols: number;
  rows: number;
  /** Path to OpenSSH multiplexing control socket (on Unix platforms), if active. */
  controlPath?: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose: () => void };
  onExit(listener: (event: SSHPtyExitEvent) => void): { dispose: () => void };
  dispose(): Promise<void>;
  /** Returns the buffered recent scrollback terminal output. */
  getScrollbackBuffer?(): string;
  /** Whether the session is currently attempting to reconnect. */
  isReconnecting?(): boolean;
  /** Attempts to manually re-establish the underlying SSH connection. */
  reconnect?(): Promise<boolean>;
}

export interface XServerStatus {
  available: boolean;
  executablePath?: string;
  running: boolean;
  managedByApp: boolean;
  pid?: number;
  display: string;
  platform?: string;
}

/** Varifrån en publik nyckel kommer. */
export type PublicKeySource = 'file' | 'agent' | 'fido2' | 'smartcard' | 'manual' | 'github' | 'gitlab' | 'git-custom';

/** En publik nyckel som kan installeras i `authorized_keys` på en host. */
export interface LocalPublicKey {
  /** Fingeravtryck (`SHA256:...`), unikt per nyckel. */
  id: string;
  /** Hela raden som skrivs till authorized_keys (`<typ> <base64>[ <kommentar>]`). */
  line: string;
  type: string;
  fingerprint: string;
  comment: string;
  source: PublicKeySource;
  /** Visningsnamn, t.ex. filnamn eller agentens kommentar. */
  label: string;
  /** Privat nyckelfil bredvid .pub-filen, om den finns. Används för att verifiera inloggning efteråt. */
  privateKeyPath?: string;
}

export interface ListPublicKeysRequest {
  /** Profilen (sparad eller osparad); ger nyckelfilen och (med includeHardware) kortet/säkerhetsnyckeln. Valfri vid global listning. */
  config?: SSHConnectionConfig;
  /** Läs även nycklar från smartcard/FIDO2 (kräver PIN/touch). */
  includeHardware?: boolean;
}

/** Hur vi loggar in på hosten för att kunna installera nycklarna. */
export type InstallLoginStep = 'password' | 'profile' | 'smartcard' | 'agent';
export type InstallLoginMethod = 'auto' | InstallLoginStep;

export interface InstallPublicKeysRequest {
  config: SSHConnectionConfig;
  publicKeys: string[];
  /** Default 'auto': se `chooseLoginOrder`. */
  loginMethod?: InstallLoginMethod;
  /** true när de valda nycklarna bara är profilens egen inloggningsnyckel (då är det poänglöst att logga in med den). */
  installsOwnKeyOnly?: boolean;
  /** Auth-metoder som servern annonserade vid senaste probe, om kända. */
  serverMethods?: string[];
}

export type ProbeErrorKind =
  | 'dns'
  | 'timeout'
  | 'refused'
  | 'unreachable'
  | 'closed'
  | 'hostkey-rejected'
  | 'hostkey-changed'
  | 'unknown';

/** Resultat av en tyst probe (inga lösen/PIN/touch): nåbarhet, värdnyckel och tillåtna auth-metoder. */
export interface ProbeHostResult {
  reachable: boolean;
  /** 'accepted' = användaren litade på en ny värdnyckel nu. */
  hostKey: 'trusted' | 'accepted' | 'rejected' | 'changed';
  /** Auth-metoder servern tillåter, t.ex. ['publickey', 'password']. */
  methods: string[];
  errorKind?: ProbeErrorKind;
  error?: string;
}

export interface TestLoginResult {
  success: boolean;
  error?: string;
}

export type InstallKeyStatus = 'installed' | 'present' | 'invalid' | 'unknown';

export interface InstallKeyResult {
  fingerprint: string;
  status: InstallKeyStatus;
  /** Inloggning med bara den nya nyckeln: true = fungerar, false = misslyckades, undefined = kunde inte verifieras. */
  verified?: boolean;
}

export interface InstallPublicKeysResult {
  success: boolean;
  error?: string;
  results: InstallKeyResult[];
  /** Vilken inloggning som slutligen användes. */
  loginMethod?: InstallLoginStep;
}
