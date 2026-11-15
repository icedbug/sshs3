import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AppAgent } from '../ssh/AppAgent';
import { ensureSecureDir, resolveAppAgentDir } from '../ssh/AppAgent';
import type { AppSettings } from '../../shared/types/settings';
import type {
  ISshCaProvider,
  SshCaBackendType,
  SshCaCertificateInfo,
  SshCaConfig,
  SshCaSignRequest,
  SshCaStatus,
} from '../../shared/types/sshCa';
import { StepCaProvider } from './providers/StepCaProvider';
import { VaultCaProvider } from './providers/VaultCaProvider';
import {
  computeOpenSshFingerprint,
  isoToEpochSeconds,
  parseOpenSshCertificate,
  validateOpenSshCertificate,
} from './sshCertificateUtils';
import { exportSshWirePublicKey, type SshWireKeyInfo } from './sshPublicKeyFormat';
import {
  createWebOidcAuthRequest,
  discoverOidc,
  exchangeOidcAuthorizationCode,
  oidcClientOf,
  parseWebOidcCallback,
  refreshOidcTokens,
  signInWithBrowser,
  type WebOidcCallbackInput,
} from './oidcFlow';
import { OperationQueue } from './operationQueue';
import { createLogger } from '../log';

const caLog = createLogger('ssh-ca-service');

const NO_SMARTCARD_MESSAGE =
  'No smartcard detected. Insert your card (for example a YubiKey or another PIV smartcard) and ensure a PKCS#11 module is available.';

export const DEFAULT_AGENT_CERT_TTL_SECONDS = 900;
export const MIN_AGENT_CERT_TTL_SECONDS = 60;
export const MAX_AGENT_CERT_TTL_SECONDS = 3600;
const WEB_CALLBACK_DEFAULT_TTL_MS = 120_000;
const PRINCIPAL_RE = /^[a-zA-Z0-9._@-]{1,64}$/;
const SAFE_ID_RE = /[^a-zA-Z0-9._-]/g;

export interface SshCaWebAuthPrompt {
  state: string;
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: number;
}

export interface SshCaServiceDependencies {
  appAgent: AppAgent;
  openExternal?: (url: string) => Promise<void>;
  providers?: Map<SshCaBackendType, ISshCaProvider>;
  getSettings?: () => Promise<AppSettings>;
  getPivPublicKey?: () => Promise<SshWireKeyInfo | null>;
  /** Static callback URL for web/headless mode (e.g. `https://sshs3.example.com/api/ca/oidc/callback`). */
  webCallbackUrl?: string;
  /** Dynamic resolver for the web-relayed callback URL when running in web/headless server mode. */
  getWebCallbackUrl?: () => string | undefined;
  /** Invoked when a web-relayed OIDC flow produces an authorization URL to forward to the browser client. */
  onWebAuthUrl?: (prompt: SshCaWebAuthPrompt) => void | Promise<void>;
  /** Allows plain `http://` web callback URLs in non-loopback local dev/test headless mode. */
  allowInsecureWebCallback?: boolean;
}

export interface SshCaLoginOptions {
  /** `'auto'` uses web relay when `webCallbackUrl` is available, otherwise desktop loopback browser sign-in. */
  mode?: 'auto' | 'loopback' | 'web';
  redirectUri?: string;
  ttlMs?: number;
  allowInsecureRedirectUri?: boolean;
  onAuthUrl?: (prompt: SshCaWebAuthPrompt) => void | Promise<void>;
  /** Optional agent-scoping constraints applied to the certificate signing request. */
  agentScope?: Omit<AgentScopedCertOptions, 'username'> & { username?: string };
}

export interface SshCaWebLoginStart {
  state: string;
  authorizationUrl: string;
  redirectUri: string;
  expiresAt: number;
  completion: Promise<SshCaStatus>;
}

export interface SshCaWebCallbackResult {
  ok: boolean;
  status?: SshCaStatus;
  error?: string;
}

export interface AgentScopedCertOptions {
  username: string;
  agentId: string;
  taskId?: string;
  requestedPrincipals?: string[];
  allowedPrincipals?: string[];
  allowRoot?: boolean;
  ttlSeconds?: number;
  forceCommand?: string;
  sourceAddresses?: string[];
  permitPty?: boolean;
  nowSeconds?: number;
}

export interface AgentScopedCertSpec {
  keyId: string;
  principals: string[];
  ttlSeconds: number;
  validAfter: number;
  validBefore: number;
  validAfterIso: string;
  validBeforeIso: string;
  criticalOptions: Record<string, string>;
  extensions: string[];
}

function isValidCidr(cidr: string): boolean {
  const parts = cidr.split('/');
  if (parts.length !== 2) return false;
  const [ip, prefixRaw] = parts;
  if (!/^\d{1,3}$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  const ipVer = net.isIP(ip);
  if (ipVer === 4) return prefix >= 0 && prefix <= 32;
  if (ipVer === 6) return prefix >= 0 && prefix <= 128;
  return false;
}

/**
 * Builds constrained, short-lived SSH CA certificate parameters for an AI agent run:
 * - Clamps TTL to `[60s, 3600s]` (default `900s`).
 * - Blocks `root` and `*` principals unless `allowRoot: true` is explicitly set, and intersects
 *   with `allowedPrincipals` when provided.
 * - Attaches optional OpenSSH `force-command` and `source-address` critical options and strips
 *   forwarding/user-rc extensions by default.
 */
export function buildAgentScopedCertSpec(options: AgentScopedCertOptions): AgentScopedCertSpec {
  const safeUser = options.username.trim().replace(SAFE_ID_RE, '_') || 'agent-user';
  const safeAgent = options.agentId.trim().replace(SAFE_ID_RE, '_') || 'agent';
  const safeTask = options.taskId?.trim().replace(SAFE_ID_RE, '_');
  const keyId = safeTask ? `sshs3-agent:${safeUser}:${safeAgent}:${safeTask}` : `sshs3-agent:${safeUser}:${safeAgent}`;

  const rawTtl = options.ttlSeconds ?? DEFAULT_AGENT_CERT_TTL_SECONDS;
  const ttlSeconds = Math.max(
    MIN_AGENT_CERT_TTL_SECONDS,
    Math.min(MAX_AGENT_CERT_TTL_SECONDS, Math.round(Number.isFinite(rawTtl) ? rawTtl : DEFAULT_AGENT_CERT_TTL_SECONDS))
  );
  const nowSec = Math.floor(options.nowSeconds ?? Date.now() / 1000);
  const validAfter = nowSec;
  const validBefore = nowSec + ttlSeconds;

  const allowRoot = options.allowRoot === true;
  const requested = (options.requestedPrincipals && options.requestedPrincipals.length > 0
    ? options.requestedPrincipals
    : [options.username.trim()]
  )
    .map((p) => p.trim())
    .filter(Boolean);

  const allowedSet = options.allowedPrincipals
    ? new Set(options.allowedPrincipals.map((p) => p.trim()).filter(Boolean))
    : undefined;

  const principals: string[] = [];
  const seen = new Set<string>();
  for (const principal of requested) {
    if (principal === '*' || (!allowRoot && principal === 'root')) {
      throw new Error(`Principal "${principal}" is not permitted for agent-scoped SSH CA certificates`);
    }
    if (!PRINCIPAL_RE.test(principal)) {
      throw new Error(`Invalid SSH CA principal "${principal}"`);
    }
    if (allowedSet && !allowedSet.has(principal)) {
      continue;
    }
    if (!seen.has(principal)) {
      seen.add(principal);
      principals.push(principal);
    }
  }
  if (principals.length === 0) {
    throw new Error('No permitted principals remain for agent-scoped SSH CA certificate');
  }

  const criticalOptions: Record<string, string> = {};
  if (options.forceCommand !== undefined) {
    const cmd = options.forceCommand.trim();
    if (!cmd) {
      throw new Error('forceCommand cannot be empty when specified');
    }
    // eslint-disable-next-line no-control-regex -- reject control characters in OpenSSH force-command option
    if (/[\u0000-\u001f\u007f]/.test(cmd)) {
      throw new Error('forceCommand contains disallowed control characters');
    }
    criticalOptions['force-command'] = cmd;
  }

  if (options.sourceAddresses && options.sourceAddresses.length > 0) {
    const cidrs = options.sourceAddresses.map((s) => s.trim()).filter(Boolean);
    for (const cidr of cidrs) {
      if (!isValidCidr(cidr)) {
        throw new Error(`Invalid source-address CIDR "${cidr}"`);
      }
    }
    if (cidrs.length > 0) {
      criticalOptions['source-address'] = cidrs.join(',');
    }
  }

  const extensions = options.permitPty ? ['permit-pty'] : [];

  return {
    keyId,
    principals,
    ttlSeconds,
    validAfter,
    validBefore,
    validAfterIso: new Date(validAfter * 1000).toISOString(),
    validBeforeIso: new Date(validBefore * 1000).toISOString(),
    criticalOptions,
    extensions,
  };
}

interface PendingWebCallback {
  state: string;
  expiresAt: number;
  resolveCode: (code: string) => void;
  rejectCode: (err: Error) => void;
  completion: Promise<SshCaStatus>;
  cleanup: () => void;
}

interface ActiveSession {
  config: SshCaConfig;
  username: string;
  principals: string[];
  parsedCert: SshCaCertificateInfo;
  certFingerprint: string;
  certificateFilePath?: string;
  refreshToken?: string;
  tokenEndpoint?: string;
}

export class SshCaService {
  private readonly deps: SshCaServiceDependencies;
  private readonly providers: Map<SshCaBackendType, ISshCaProvider>;
  private activeSession: ActiveSession | null = null;
  private statusListeners = new Set<(status: SshCaStatus) => void>();
  private expirationTimer: NodeJS.Timeout | null = null;
  private renewalTimer: NodeJS.Timeout | null = null;
  private pendingWebCallbacks = new Map<string, PendingWebCallback>();
  /** Login, renew and logout run one at a time; logout cancels whatever is queued or running. */
  private readonly operations = new OperationQueue('SSH CA operation was cancelled');

  constructor(deps: SshCaServiceDependencies) {
    this.deps = deps;
    this.providers = deps.providers ?? new Map<SshCaBackendType, ISshCaProvider>([
      ['step-ca', new StepCaProvider()],
      ['vault', new VaultCaProvider()],
    ]);
  }

  public getStatus(): SshCaStatus {
    if (!this.activeSession) {
      return { active: false };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const validSecondsRemaining = Math.max(0, isoToEpochSeconds(this.activeSession.parsedCert.validBefore) - nowSec);

    if (validSecondsRemaining === 0) {
      return {
        active: false,
        configId: this.activeSession.config.id,
        username: this.activeSession.username,
        principals: this.activeSession.principals,
        expiresAt: this.activeSession.parsedCert.validBefore,
        validSecondsRemaining: 0,
        error: 'Certificate expired',
      };
    }

    const certInfo: SshCaCertificateInfo = { ...this.activeSession.parsedCert, principals: [...this.activeSession.parsedCert.principals] };

    return {
      active: true,
      configId: this.activeSession.config.id,
      username: this.activeSession.username,
      principals: this.activeSession.principals,
      expiresAt: certInfo.validBefore,
      validSecondsRemaining,
      certInfo,
      certificateFilePath: this.activeSession.certificateFilePath,
    };
  }

  public getActiveCertificateFilePath(): string | undefined {
    if (!this.activeSession) return undefined;
    const nowSec = Math.floor(Date.now() / 1000);
    if (isoToEpochSeconds(this.activeSession.parsedCert.validBefore) <= nowSec) {
      return undefined;
    }
    return this.activeSession.certificateFilePath;
  }

  public onStatusChanged(listener: (status: SshCaStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private notifyStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (err) {
        caLog.error('Error notifying SSH CA status listener:', (err as Error).message);
      }
    }
  }

  public login(config?: SshCaConfig, signal?: AbortSignal, options?: SshCaLoginOptions): Promise<SshCaStatus> {
    return this.operations.run((opSignal) => this.performLogin(config, opSignal, options), signal);
  }

  /**
   * Starts a web-relayed OIDC CA login for headless / browser-server mode. Resolves with the
   * authorization URL + state as soon as OIDC discovery finishes; `completion` resolves when
   * `handleWebCallback` delivers the callback redirect.
   */
  public startWebLogin(
    config?: SshCaConfig,
    options: Omit<SshCaLoginOptions, 'mode'> & { signal?: AbortSignal } = {}
  ): Promise<SshCaWebLoginStart> {
    let resolveStarted!: (started: SshCaWebLoginStart) => void;
    let rejectStarted!: (err: Error) => void;
    const startedPromise = new Promise<SshCaWebLoginStart>((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });

    const completion = this.operations.run(
      (opSignal) =>
        this.performWebLogin(config, opSignal, options, (prompt) => {
          resolveStarted({ ...prompt, completion });
        }),
      options.signal
    );

    completion.catch((err) => {
      rejectStarted(err instanceof Error ? err : new Error(String(err)));
    });

    return startedPromise;
  }

  /**
   * Delivers an HTTP callback (query string, `URLSearchParams`, or parsed params) from `/api/ca/oidc/callback`
   * to the matching pending web login flow. Unknown or mismatched states are rejected without disturbing active flows.
   */
  public async handleWebCallback(
    input: string | URLSearchParams | WebOidcCallbackInput
  ): Promise<SshCaWebCallbackResult> {
    const rawState = this.extractCallbackState(input);
    const pending = rawState ? this.findPendingWebCallback(rawState) : undefined;
    if (!pending) {
      return { ok: false, error: 'Invalid or expired SSH CA OIDC callback state' };
    }
    if (Date.now() > pending.expiresAt) {
      pending.cleanup();
      const err = new Error('Timed out waiting for the web sign-in to the SSH CA identity provider.');
      pending.rejectCode(err);
      return { ok: false, error: err.message };
    }

    const outcome = parseWebOidcCallback(input, pending.state);
    if (outcome.kind === 'state-mismatch') {
      return { ok: false, error: 'Invalid or expired SSH CA OIDC callback state' };
    }
    if (outcome.kind === 'error') {
      pending.cleanup();
      pending.rejectCode(new Error(outcome.message));
      await pending.completion.catch(() => {});
      return { ok: false, error: outcome.message };
    }

    pending.cleanup();
    pending.resolveCode(outcome.code);
    try {
      const status = await pending.completion;
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private extractCallbackState(input: string | URLSearchParams | WebOidcCallbackInput): string | null {
    if (typeof input === 'string') {
      const query = input.startsWith('?') ? input.slice(1) : input;
      return new URLSearchParams(query).get('state');
    }
    if (input instanceof URLSearchParams) {
      return input.get('state');
    }
    return input.state ?? null;
  }

  private findPendingWebCallback(candidateState: string): PendingWebCallback | undefined {
    let matched: PendingWebCallback | undefined;
    for (const entry of this.pendingWebCallbacks.values()) {
      const a = Buffer.from(candidateState);
      const b = Buffer.from(entry.state);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        matched = entry;
      }
    }
    return matched;
  }

  private resolveWebCallbackUrl(override?: string): string | undefined {
    const raw = override?.trim() || this.deps.getWebCallbackUrl?.()?.trim() || this.deps.webCallbackUrl?.trim();
    return raw || undefined;
  }

  private shouldUseWebRelay(options?: SshCaLoginOptions): boolean {
    if (options?.mode === 'loopback') return false;
    if (options?.mode === 'web') return true;
    return Boolean(this.resolveWebCallbackUrl(options?.redirectUri));
  }

  private async performLogin(
    config: SshCaConfig | undefined,
    signal: AbortSignal,
    options?: SshCaLoginOptions
  ): Promise<SshCaStatus> {
    if (this.shouldUseWebRelay(options)) {
      return this.performWebLogin(config, signal, options ?? {});
    }
    return this.performLoopbackLogin(config, signal, options);
  }

  private async prepareLoginContext(config: SshCaConfig | undefined) {
    const activeConfig = config ?? (await this.resolveDefaultConfig());
    if (!activeConfig) {
      throw new Error('No SSH CA configuration provided or configured in settings');
    }

    caLog.info(`Initiating login for SSH CA config "${activeConfig.name}" (${activeConfig.id})`);

    let preloadedPivKey: SshWireKeyInfo | undefined;
    if (activeConfig.keySource === 'piv') {
      if (!this.deps.getPivPublicKey) {
        throw new Error('PIV hardware token key source is not supported in this environment');
      }
      const pivKey = await this.deps.getPivPublicKey();
      if (!pivKey) {
        throw new Error(NO_SMARTCARD_MESSAGE);
      }
      preloadedPivKey = pivKey;
    }

    return { activeConfig, preloadedPivKey };
  }

  private async performLoopbackLogin(
    config: SshCaConfig | undefined,
    signal: AbortSignal,
    options?: SshCaLoginOptions
  ): Promise<SshCaStatus> {
    const { activeConfig, preloadedPivKey } = await this.prepareLoginContext(config);

    const client = oidcClientOf(activeConfig);
    const endpoints = await discoverOidc(client, signal);
    const tokens = await signInWithBrowser(client, endpoints, (url) => this.openInBrowser(url), signal);

    await this.signAndLoadCertificate({
      config: activeConfig,
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      tokenEndpoint: endpoints.tokenEndpoint,
      username: tokens.username,
      pivKey: preloadedPivKey,
      agentScope: options?.agentScope,
      signal,
    });

    return this.getStatus();
  }

  private async performWebLogin(
    config: SshCaConfig | undefined,
    signal: AbortSignal,
    options: Omit<SshCaLoginOptions, 'mode'>,
    onPrepared?: (prompt: SshCaWebAuthPrompt) => void
  ): Promise<SshCaStatus> {
    const redirectUri = this.resolveWebCallbackUrl(options.redirectUri);
    if (!redirectUri) {
      throw new Error('No web OIDC callback URL configured for headless/web SSH CA login');
    }

    const { activeConfig, preloadedPivKey } = await this.prepareLoginContext(config);
    const client = oidcClientOf(activeConfig);
    const endpoints = await discoverOidc(client, signal);

    const authReq = createWebOidcAuthRequest(client, endpoints, redirectUri, {
      ttlMs: options.ttlMs ?? WEB_CALLBACK_DEFAULT_TTL_MS,
      allowInsecureRedirectUri: options.allowInsecureRedirectUri ?? this.deps.allowInsecureWebCallback,
    });

    let settled = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    codePromise.catch(() => {});

    const ttlMs = Math.max(10_000, authReq.expiresAt - authReq.createdAt);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCode(new Error('Timed out waiting for the web sign-in to the SSH CA identity provider.'));
    }, ttlMs);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectCode(new Error('SSH CA operation was cancelled'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      this.pendingWebCallbacks.delete(authReq.state);
    };

    if (signal.aborted) {
      cleanup();
      throw new Error('SSH CA operation was cancelled');
    }
    signal.addEventListener('abort', onAbort, { once: true });

    const placeholderCompletion = Promise.resolve().then(() => this.getStatus());
    const entry: PendingWebCallback = {
      state: authReq.state,
      expiresAt: authReq.expiresAt,
      resolveCode: (code: string) => {
        if (settled) return;
        settled = true;
        resolveCode(code);
      },
      rejectCode: (err: Error) => {
        if (settled) return;
        settled = true;
        rejectCode(err);
      },
      completion: placeholderCompletion,
      cleanup,
    };
    this.pendingWebCallbacks.set(authReq.state, entry);

    const prompt: SshCaWebAuthPrompt = {
      state: authReq.state,
      authorizationUrl: authReq.authorizationUrl,
      redirectUri: authReq.redirectUri,
      expiresAt: authReq.expiresAt,
    };

    const runFlow = (async (): Promise<SshCaStatus> => {
      try {
        onPrepared?.(prompt);
        if (options.onAuthUrl) {
          await options.onAuthUrl(prompt);
        } else if (this.deps.onWebAuthUrl) {
          await this.deps.onWebAuthUrl(prompt);
        } else if (this.deps.openExternal) {
          await this.deps.openExternal(prompt.authorizationUrl);
        }

        const code = await codePromise;
        const tokens = await exchangeOidcAuthorizationCode(
          client,
          endpoints,
          {
            code,
            redirectUri: authReq.redirectUri,
            codeVerifier: authReq.codeVerifier,
            expectedNonce: authReq.nonce,
          },
          signal
        );

        await this.signAndLoadCertificate({
          config: activeConfig,
          idToken: tokens.idToken,
          refreshToken: tokens.refreshToken,
          tokenEndpoint: endpoints.tokenEndpoint,
          username: tokens.username,
          pivKey: preloadedPivKey,
          agentScope: options.agentScope,
          signal,
        });

        return this.getStatus();
      } finally {
        cleanup();
      }
    })();

    entry.completion = runFlow;
    return runFlow;
  }

  private async openInBrowser(url: string): Promise<void> {
    if (this.deps.openExternal) {
      await this.deps.openExternal(url);
      return;
    }
    const { shell } = await import('electron');
    await shell.openExternal(url);
  }

  public logout(): Promise<void> {
    // Cancel what is queued or running (a pending browser sign-in, a renewal) before it can reinstall a
    // certificate behind the logout, and stop the timers right away.
    this.operations.cancelAll();
    this.clearTimers();
    for (const pending of [...this.pendingWebCallbacks.values()]) {
      pending.cleanup();
      pending.rejectCode(new Error('SSH CA operation was cancelled'));
    }
    return this.operations.run(() => this.performLogout());
  }

  private async performLogout(): Promise<void> {
    this.clearTimers();

    if (this.activeSession) {
      if (this.activeSession.certificateFilePath) {
        try {
          await fs.promises.unlink(this.activeSession.certificateFilePath);
        } catch {
          // Non-fatal
        }
      }
      try {
        await this.deps.appAgent.removeIdentities([this.activeSession.certFingerprint]);
      } catch (err) {
        caLog.warn('Failed to evict certificate from ssh-agent during logout:', (err as Error).message);
      }
      this.activeSession = null;
    }

    this.notifyStatus();
  }

  /** User-initiated renewal: tries a silent token refresh, then falls back to an interactive sign-in. */
  public renew(signal?: AbortSignal): Promise<SshCaStatus> {
    return this.operations.run((opSignal) => this.performRenew(opSignal, true), signal);
  }

  /** Timer-driven renewal: never opens a browser with nobody there to use it. */
  private renewSilently(): Promise<SshCaStatus> {
    return this.operations.run((opSignal) => this.performRenew(opSignal, false));
  }

  private async performRenew(signal: AbortSignal, allowInteractive: boolean): Promise<SshCaStatus> {
    if (!this.activeSession) {
      throw new Error('No active SSH CA session to renew');
    }

    const session = this.activeSession;
    if (session.refreshToken && session.tokenEndpoint) {
      try {
        caLog.info(`Attempting token refresh for SSH CA session "${session.username}"`);
        const refreshed = await refreshOidcTokens(
          oidcClientOf(session.config),
          session.tokenEndpoint,
          session.refreshToken,
          signal
        );
        if (refreshed) {
          await this.signAndLoadCertificate({
            config: session.config,
            idToken: refreshed.idToken,
            refreshToken: refreshed.refreshToken ?? session.refreshToken,
            tokenEndpoint: session.tokenEndpoint,
            username: session.username,
            signal,
          });
          return this.getStatus();
        }
      } catch (err) {
        if (signal.aborted) throw err; // cancelled by logout: do not start an interactive sign-in
        caLog.warn(
          `Token refresh failed${allowInteractive ? ', falling back to interactive login' : ''}:`,
          (err as Error).message
        );
      }
    }

    if (!allowInteractive) {
      throw new Error('Silent SSH CA renewal failed; sign in again before the certificate expires');
    }
    // Fall back to full interactive login with saved config
    return this.performLogin(session.config, signal);
  }

  private async signAndLoadCertificate(params: {
    config: SshCaConfig;
    idToken: string;
    refreshToken?: string;
    tokenEndpoint?: string;
    username: string;
    pivKey?: SshWireKeyInfo;
    agentScope?: SshCaLoginOptions['agentScope'];
    signal?: AbortSignal;
  }): Promise<void> {
    const { config, idToken, refreshToken, tokenEndpoint, username, agentScope, signal } = params;

    const scopedSpec = agentScope
      ? buildAgentScopedCertSpec({
          ...agentScope,
          username: agentScope.username ?? username,
          requestedPrincipals: agentScope.requestedPrincipals ?? config.defaultPrincipals,
        })
      : undefined;
    const requestedPrincipals = scopedSpec ? scopedSpec.principals : config.defaultPrincipals;
    const keyComment = scopedSpec ? scopedSpec.keyId : `sshs3-ca:${username}`;

    let publicKeyWireBase64: string;
    let keyType: string;
    let publicKeyLine: string;
    let pubKey: Buffer | undefined;
    let privSeed: Buffer | undefined;
    let pkcs8Buffer: Buffer | undefined;

    if (config.keySource === 'piv') {
      const pivKey = params.pivKey ?? (await this.deps.getPivPublicKey?.());
      if (!pivKey) {
        throw new Error(NO_SMARTCARD_MESSAGE);
      }
      publicKeyWireBase64 = pivKey.wireBase64;
      keyType = pivKey.keyType;
      publicKeyLine = pivKey.publicKeyLine;
    } else {
      // Generate ephemeral Ed25519 keypair in memory
      const keyPair = crypto.generateKeyPairSync('ed25519');
      pkcs8Buffer = keyPair.privateKey.export({ type: 'pkcs8', format: 'der' });
      privSeed = pkcs8Buffer.subarray(pkcs8Buffer.length - 32);

      const keyInfo = exportSshWirePublicKey(keyPair.publicKey, keyComment);
      publicKeyWireBase64 = keyInfo.wireBase64;
      keyType = keyInfo.keyType;
      publicKeyLine = keyInfo.publicKeyLine;
      const spki = keyPair.publicKey.export({ type: 'spki', format: 'der' });
      pubKey = spki.subarray(spki.length - 32);
    }

    try {
      const provider = this.providers.get(config.backend);
      if (!provider) {
        throw new Error(`Unsupported SSH CA backend: ${config.backend}`);
      }

      const signReq: SshCaSignRequest = {
        publicKeyWireBase64,
        keyType,
        publicKeyLine,
        identityToken: idToken,
        username,
        principals: requestedPrincipals,
      };
      const signRes = await provider.sign(signReq, config, signal ?? new AbortController().signal);

      if (signal?.aborted) {
        throw new Error('SSH CA sign-in was cancelled');
      }

      const certWire = Buffer.from(signRes.certificateWireBase64, 'base64');
      const parsedCert = parseOpenSshCertificate(certWire);
      // The certificate must be for the key we asked the CA to sign, not for some other key.
      const validation = validateOpenSshCertificate(parsedCert, {
        expectedPublicKeyFingerprint: computeOpenSshFingerprint(Buffer.from(publicKeyWireBase64, 'base64')),
      });
      if (!validation.valid) {
        throw new Error(`SSH CA issued invalid certificate: ${validation.error}`);
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const validBeforeSec = isoToEpochSeconds(parsedCert.validBefore);
      const certLifetimeSec = Math.max(0, validBeforeSec - nowSec);
      const lifetimeSeconds = scopedSpec
        ? Math.min(certLifetimeSec || scopedSpec.ttlSeconds, scopedSpec.ttlSeconds)
        : certLifetimeSec;
      const certFingerprint = computeOpenSshFingerprint(certWire);

      // Install the new certificate first; the previous one is only evicted once this has succeeded,
      // so a failed renewal leaves the working identity (and the status that describes it) intact.
      let certificateFilePath: string | undefined;

      if (config.keySource === 'piv') {
        const certsDir = path.join(resolveAppAgentDir(), 'certs');
        await ensureSecureDir(path.dirname(certsDir));
        await ensureSecureDir(certsDir);
        const safeFp = parsedCert.publicKeyFingerprint.replace(/[^a-zA-Z0-9_-]/g, '_');
        certificateFilePath = path.join(certsDir, `${safeFp}-cert.pub`);
        // Write-then-rename: the path is the same on every renewal of a PIV key, so a failed write must
        // not destroy the certificate that is still in use.
        const tmpPath = `${certificateFilePath}.${process.pid}.tmp`;
        try {
          await fs.promises.writeFile(tmpPath, signRes.certificateLine + '\n', { mode: 0o600 });
          await fs.promises.rename(tmpPath, certificateFilePath);
        } catch (err) {
          await fs.promises.unlink(tmpPath).catch(() => {});
          throw err;
        }
        caLog.info(`Saved PIV SSH CA certificate to ${certificateFilePath}`);
      } else {
        // Load new certificate into the app-managed SSH agent
        await this.deps.appAgent.addCertifiedEd25519Key({
          certificateWire: certWire,
          publicKeyBytes: pubKey!,
          privateKeySeedBytes: privSeed!,
          comment: keyComment,
          lifetimeSeconds: lifetimeSeconds > 0 ? lifetimeSeconds : undefined,
        });
      }

      await this.evictReplacedSession(certificateFilePath, certFingerprint);

      this.activeSession = {
        config,
        username,
        principals: parsedCert.principals,
        parsedCert,
        certFingerprint,
        certificateFilePath,
        refreshToken,
        tokenEndpoint,
      };

      this.scheduleTimers(validBeforeSec, refreshToken !== undefined);
      this.notifyStatus();
    } finally {
      // Also on a failed sign/validate/install: the ephemeral private key must not linger in memory.
      privSeed?.fill(0);
      pkcs8Buffer?.fill(0);
    }
  }

  /**
   * Removes the previous session's certificate (file and agent identity) after its replacement is in place.
   * A PIV certificate keeps the same path across renewals, so the file is only unlinked when the path differs.
   */
  private async evictReplacedSession(newCertificateFilePath: string | undefined, newCertFingerprint: string): Promise<void> {
    const previous = this.activeSession;
    if (!previous) return;

    if (previous.certificateFilePath && previous.certificateFilePath !== newCertificateFilePath) {
      try {
        await fs.promises.unlink(previous.certificateFilePath);
      } catch {
        // Non-fatal
      }
    }
    if (previous.certFingerprint !== newCertFingerprint) {
      try {
        await this.deps.appAgent.removeIdentities([previous.certFingerprint]);
      } catch {
        // Non-fatal
      }
    }
  }

  private scheduleTimers(validBeforeSec: number, hasRefreshToken: boolean): void {
    this.clearTimers();

    const nowMs = Date.now();
    const expiryMs = validBeforeSec * 1000;
    const remainingMs = expiryMs - nowMs;

    if (remainingMs <= 0) {
      this.notifyStatus();
      return;
    }

    // Node.js setTimeout clamps delay to 32-bit signed int (max ~24.8 days); prevent overflow warning & 1ms trigger
    const MAX_TIMEOUT_MS = 2_147_483_647;

    // Set expiration timer
    this.expirationTimer = setTimeout(() => {
      caLog.info('SSH CA certificate expired');
      this.notifyStatus();
    }, Math.min(remainingMs, MAX_TIMEOUT_MS));

    // If a refresh token is present, schedule automatic renewal 60 seconds before expiry
    if (hasRefreshToken && remainingMs > 75_000) {
      const renewInMs = remainingMs - 60_000;
      this.renewalTimer = setTimeout(async () => {
        caLog.info('Triggering automatic SSH CA certificate renewal before expiry');
        try {
          await this.renewSilently();
        } catch (err) {
          caLog.warn('Automatic SSH CA renewal failed:', (err as Error).message);
        }
      }, Math.min(renewInMs, MAX_TIMEOUT_MS));
    }
  }

  private clearTimers(): void {
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer);
      this.expirationTimer = null;
    }
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private async resolveDefaultConfig(): Promise<SshCaConfig | null> {
    if (!this.deps.getSettings) return null;
    const settings = await this.deps.getSettings();
    const configs = settings.sshCaConfigs;
    if (!configs || configs.length === 0) return null;

    if (settings.defaultSshCaConfigId) {
      const found = configs.find((c) => c.id === settings.defaultSshCaConfigId);
      if (found) return found;
    }

    return configs[0];
  }
}
