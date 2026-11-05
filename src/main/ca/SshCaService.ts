import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppAgent } from '../ssh/AppAgent';
import { ensureSecureDir, resolveAppAgentDir } from '../ssh/AppAgent';
import type { AppSettings } from '../../shared/types/settings';
import type {
  ISshCaProvider,
  SshCaBackendType,
  SshCaCertificateInfo,
  SshCaConfig,
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
import { discoverOidc, oidcClientOf, refreshOidcTokens, signInWithBrowser } from './oidcFlow';
import { OperationQueue } from './operationQueue';
import { createLogger } from '../log';

const caLog = createLogger('ssh-ca-service');

const NO_SMARTCARD_MESSAGE =
  'No smartcard detected. Insert your card (for example a YubiKey or another PIV smartcard) and ensure a PKCS#11 module is available.';

export interface SshCaServiceDependencies {
  appAgent: AppAgent;
  openExternal?: (url: string) => Promise<void>;
  providers?: Map<SshCaBackendType, ISshCaProvider>;
  getSettings?: () => Promise<AppSettings>;
  getPivPublicKey?: () => Promise<SshWireKeyInfo | null>;
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

  public login(config?: SshCaConfig, signal?: AbortSignal): Promise<SshCaStatus> {
    return this.operations.run((opSignal) => this.performLogin(config, opSignal), signal);
  }

  private async performLogin(config: SshCaConfig | undefined, signal: AbortSignal): Promise<SshCaStatus> {
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
      signal,
    });

    return this.getStatus();
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
    signal?: AbortSignal;
  }): Promise<void> {
    const { config, idToken, refreshToken, tokenEndpoint, username, signal } = params;

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

      const keyInfo = exportSshWirePublicKey(keyPair.publicKey, `sshs3-ca:${username}`);
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

      const signRes = await provider.sign(
        {
          publicKeyWireBase64,
          keyType,
          publicKeyLine,
          identityToken: idToken,
          username,
          principals: config.defaultPrincipals,
        },
        config,
        signal ?? new AbortController().signal
      );

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
      const lifetimeSeconds = Math.max(0, validBeforeSec - nowSec);
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
          comment: `sshs3-ca:${username}`,
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
