import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import {
  SSOOIDCClient,
  RegisterClientCommand,
  StartDeviceAuthorizationCommand,
  CreateTokenCommand,
  AuthorizationPendingException,
  SlowDownException,
} from '@aws-sdk/client-sso-oidc';
import { SSOClient, ListAccountsCommand, ListAccountRolesCommand } from '@aws-sdk/client-sso';
import type {
  AwsSsoAccount,
  AwsSsoAccountRole,
  AwsSsoDevicePrompt,
  AwsSsoLoginResult,
  AwsSsoNetworkOptions,
} from '../../shared/types/aws';
import { encryptSecretValue, decryptSecretValue } from '../crypto/SecretFieldCrypto';
import { buildAwsNodeHttpHandler } from './buildAwsNodeHttpHandler';

export class AwsSsoLoginCancelledError extends Error {
  constructor() {
    super('AWS SSO login was cancelled');
    this.name = 'AwsSsoLoginCancelledError';
  }
}

export type { AwsSsoAccount, AwsSsoAccountRole, AwsSsoDevicePrompt, AwsSsoLoginResult };

interface ClientRegistrationCacheEntry {
  clientId: string;
  clientSecret: string;
  clientIdIssuedAt: number;
  clientSecretExpiresAt: number;
}

type ClientRegistrationCache = Record<string, ClientRegistrationCacheEntry>;

// A day of safety margin before the cached client registration's real expiry,
// so we never attempt to use a secret that expires mid-flow.
const REGISTRATION_SAFETY_MARGIN_SEC = 24 * 60 * 60;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AwsSsoLoginCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AwsSsoLoginCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface AwsSsoAuthServiceOptions {
  /** Overrides the client-registration cache file path (mainly for tests). */
  clientCacheFilePath?: string;
  /** Overrides the `~/.aws/sso/cache` directory (mainly for tests). */
  ssoCacheDir?: string;
}

/**
 * Implements the AWS SSO OIDC device-authorization login flow (the same
 * mechanism behind `aws sso login`) so S3 profiles can use temporary,
 * browser-approved credentials instead of static IAM access keys.
 */
export class AwsSsoAuthService extends EventEmitter {
  constructor(private options: AwsSsoAuthServiceOptions = {}) {
    super();
  }

  private clientCachePath(): string {
    if (this.options.clientCacheFilePath) {
      return this.options.clientCacheFilePath;
    }
    let baseDir: string;
    try {
      baseDir = app.getPath('userData');
    } catch {
      baseDir = path.join(os.homedir(), '.sshs3');
    }
    return path.join(baseDir, 'aws-sso-clients.json');
  }

  private ssoCacheDir(): string {
    return this.options.ssoCacheDir ?? path.join(os.homedir(), '.aws', 'sso', 'cache');
  }

  /**
   * Runs the full device-authorization flow: registers (or reuses a cached)
   * OIDC client, starts device authorization, invokes `onPrompt` with the
   * user code/verification URL, then polls for the token until the user
   * approves in their browser, the code expires, or `signal` aborts.
   * On success, writes the token to the same `~/.aws/sso/cache/*.json` file
   * `aws sso login` uses, so `fromSSO()` can pick it up directly.
   */
  public async login(
    startUrl: string,
    region: string,
    options?: {
      onPrompt?: (prompt: AwsSsoDevicePrompt) => void;
      signal?: AbortSignal;
      network?: AwsSsoNetworkOptions;
    }
  ): Promise<AwsSsoLoginResult> {
    const client = new SSOOIDCClient({ region, requestHandler: buildAwsNodeHttpHandler(options?.network) });
    const registration = await this.getOrRegisterClient(client, startUrl, region);

    const deviceAuth = await client.send(
      new StartDeviceAuthorizationCommand({
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        startUrl,
      })
    );

    if (
      !deviceAuth.deviceCode ||
      !deviceAuth.userCode ||
      !deviceAuth.verificationUri
    ) {
      throw new Error('AWS SSO did not return a valid device authorization response');
    }

    options?.onPrompt?.({
      verificationUri: deviceAuth.verificationUri,
      verificationUriComplete: deviceAuth.verificationUriComplete || undefined,
      userCode: deviceAuth.userCode,
      expiresIn: deviceAuth.expiresIn ?? 600,
    });

    const deadline = Date.now() + (deviceAuth.expiresIn ?? 600) * 1000;
    let intervalMs = Math.max(1, deviceAuth.interval ?? 5) * 1000;

    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error('AWS SSO login expired before it was approved in the browser');
      }

      await sleep(intervalMs, options?.signal);

      try {
        const tokenResp = await client.send(
          new CreateTokenCommand({
            clientId: registration.clientId,
            clientSecret: registration.clientSecret,
            grantType: 'urn:ietf:params:oauth:grant-type:device_code',
            deviceCode: deviceAuth.deviceCode,
          })
        );

        if (!tokenResp.accessToken || !tokenResp.expiresIn) {
          throw new Error('AWS SSO did not return a valid access token');
        }

        const expiresAt = new Date(Date.now() + tokenResp.expiresIn * 1000).toISOString();
        await this.writeSsoTokenCache(startUrl, {
          startUrl,
          region,
          accessToken: tokenResp.accessToken,
          expiresAt,
          clientId: registration.clientId,
          clientSecret: registration.clientSecret,
          registrationExpiresAt: new Date(registration.clientSecretExpiresAt * 1000).toISOString(),
        });

        return { accessToken: tokenResp.accessToken, expiresAt };
      } catch (err) {
        if (err instanceof AuthorizationPendingException) {
          continue;
        }
        if (err instanceof SlowDownException) {
          intervalMs += 5000;
          continue;
        }
        throw err;
      }
    }
  }

  public async listAccounts(
    accessToken: string,
    region: string,
    network?: AwsSsoNetworkOptions
  ): Promise<AwsSsoAccount[]> {
    const client = new SSOClient({ region, requestHandler: buildAwsNodeHttpHandler(network) });
    const results: AwsSsoAccount[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await client.send(new ListAccountsCommand({ accessToken, nextToken }));
      for (const a of resp.accountList ?? []) {
        if (a.accountId) {
          results.push({ accountId: a.accountId, accountName: a.accountName, emailAddress: a.emailAddress });
        }
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    results.sort((a, b) => (a.accountName ?? a.accountId).localeCompare(b.accountName ?? b.accountId));
    return results;
  }

  public async listAccountRoles(
    accessToken: string,
    region: string,
    accountId: string,
    network?: AwsSsoNetworkOptions
  ): Promise<AwsSsoAccountRole[]> {
    const client = new SSOClient({ region, requestHandler: buildAwsNodeHttpHandler(network) });
    const results: AwsSsoAccountRole[] = [];
    let nextToken: string | undefined;
    do {
      const resp = await client.send(new ListAccountRolesCommand({ accessToken, accountId, nextToken }));
      for (const r of resp.roleList ?? []) {
        if (r.roleName) results.push({ roleName: r.roleName });
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    results.sort((a, b) => a.roleName.localeCompare(b.roleName));
    return results;
  }

  private async getOrRegisterClient(
    client: SSOOIDCClient,
    startUrl: string,
    region: string
  ): Promise<ClientRegistrationCacheEntry> {
    const key = crypto.createHash('sha1').update(`${startUrl}|${region}`).digest('hex');
    const cache = await this.readClientCache();
    const existing = cache[key];
    const nowSec = Math.floor(Date.now() / 1000);

    if (existing && existing.clientSecretExpiresAt - REGISTRATION_SAFETY_MARGIN_SEC > nowSec) {
      return existing;
    }

    const response = await client.send(
      new RegisterClientCommand({
        clientName: 'sshs3',
        clientType: 'public',
      })
    );

    if (!response.clientId || !response.clientSecret || !response.clientSecretExpiresAt) {
      throw new Error('AWS SSO did not return valid client registration data');
    }

    const entry: ClientRegistrationCacheEntry = {
      clientId: response.clientId,
      clientSecret: response.clientSecret,
      clientIdIssuedAt: response.clientIdIssuedAt ?? nowSec,
      clientSecretExpiresAt: response.clientSecretExpiresAt,
    };

    cache[key] = entry;
    await this.writeClientCache(cache);
    return entry;
  }

  /**
   * Unlike ~/.aws/sso/cache/<hash>.json below, this cache is entirely our
   * own format/location (not read by the AWS CLI or SDK), so there's no
   * interop reason to keep clientSecret in plaintext here (M5, code
   * review). encryptSecretValue/decryptSecretValue already handle the
   * "no OS keyring available" fallback transparently, including reading
   * back an older plaintext-written cache unchanged.
   */
  private async readClientCache(): Promise<ClientRegistrationCache> {
    try {
      const raw = await fs.readFile(this.clientCachePath(), 'utf-8');
      const data = JSON.parse(raw);
      if (typeof data !== 'object' || !data) return {};
      const cache: ClientRegistrationCache = data;
      for (const entry of Object.values(cache)) {
        entry.clientSecret = decryptSecretValue(entry.clientSecret);
      }
      return cache;
    } catch {
      return {};
    }
  }

  private async writeClientCache(cache: ClientRegistrationCache): Promise<void> {
    const filePath = this.clientCachePath();
    const onDisk: ClientRegistrationCache = {};
    for (const [key, entry] of Object.entries(cache)) {
      onDisk[key] = { ...entry, clientSecret: encryptSecretValue(entry.clientSecret) };
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(onDisk, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Ignore chmod failures on non-POSIX filesystems
    }
  }

  /**
   * Writes to the same `~/.aws/sso/cache/<sha1(startUrl)>.json` path and
   * schema that `aws sso login` uses, so `fromSSO()` (used by
   * `S3StorageProvider`) can read the token directly with no extra glue.
   */
  private async writeSsoTokenCache(
    startUrl: string,
    token: {
      startUrl: string;
      region: string;
      accessToken: string;
      expiresAt: string;
      clientId: string;
      clientSecret: string;
      registrationExpiresAt: string;
    }
  ): Promise<void> {
    const cacheDir = this.ssoCacheDir();
    const cacheKey = crypto.createHash('sha1').update(startUrl).digest('hex');
    const filePath = path.join(cacheDir, `${cacheKey}.json`);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(token, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Ignore chmod failures on non-POSIX filesystems
    }
  }
}
