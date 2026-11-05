import {
  buildAuthorizeUrl,
  buildMetadataUrl,
  buildRedirectUri,
  buildTokenRequest,
  generatePkce,
  generateState,
  parseOAuthMetadata,
  parseTokenResponse,
  type OAuthMetadata,
} from './openshiftOAuth';
import { requestJson } from '../oauth/requestJson';
import { startCallbackServer, type CallbackServer } from '../oauth/loopbackAuth';
import type { K8sOpenShiftProbeResult } from '../../shared/types/kubernetes';

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export const BROWSER_SIGN_IN_UNSUPPORTED =
  'This cluster does not expose an OpenShift OAuth server. Browser sign-in needs OpenShift 4.13 or newer with the built-in OAuth server; paste a login command instead.';

export class OpenShiftWebLoginCancelledError extends Error {
  constructor() {
    super('OpenShift browser sign-in was cancelled');
    this.name = 'OpenShiftWebLoginCancelledError';
  }
}

export interface OpenShiftWebLoginServiceOptions {
  /** Test seam: lets the mock OAuth server speak plain http. Never set in the app. */
  allowHttp?: boolean;
  callbackTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface OpenShiftWebLoginRequest {
  server: string;
  insecureSkipTlsVerify?: boolean;
  callbackPort?: number;
}

export interface OpenShiftWebLoginHooks {
  /** Called once with the authorization URL the user must open in a browser. */
  onAuthorizeUrl: (url: string) => void;
  signal?: AbortSignal;
}

/**
 * OpenShift browser sign-in: the same authorization code + PKCE flow as
 * `oc login --web`. It only produces an access token; storing it in the
 * kubeconfig is left to `loginWithToken`, so both sign-in paths share validation.
 */
export class OpenShiftWebLoginService {
  private active: AbortController | null = null;

  constructor(private readonly options: OpenShiftWebLoginServiceOptions = {}) {}

  private get allowHttp(): boolean {
    return this.options.allowHttp === true;
  }

  private get requestTimeoutMs(): number {
    return this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async fetchMetadata(server: string, insecureSkipTlsVerify?: boolean): Promise<OAuthMetadata> {
    const res = await requestJson(buildMetadataUrl(server), {
      method: 'GET',
      insecureSkipTlsVerify,
      timeoutMs: this.requestTimeoutMs,
      allowHttp: this.allowHttp,
    });
    if (res.statusCode !== 200 || res.json === undefined) {
      throw new Error(BROWSER_SIGN_IN_UNSUPPORTED);
    }
    return parseOAuthMetadata(res.json, { allowHttp: this.allowHttp });
  }

  /** Never throws: any failure to discover the OAuth server means "not supported". */
  async probe(server: string, insecureSkipTlsVerify?: boolean): Promise<K8sOpenShiftProbeResult> {
    try {
      await this.fetchMetadata(server, insecureSkipTlsVerify);
      return { supported: true };
    } catch (err) {
      return { supported: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  cancel(): void {
    this.active?.abort();
  }

  async login(
    request: OpenShiftWebLoginRequest,
    hooks: OpenShiftWebLoginHooks
  ): Promise<{ token: string; expiresAt?: string }> {
    this.cancel();
    const controller = new AbortController();
    this.active = controller;
    const onExternalAbort = () => controller.abort();
    if (hooks.signal?.aborted) controller.abort();
    else hooks.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const throwIfCancelled = () => {
      if (controller.signal.aborted) throw new OpenShiftWebLoginCancelledError();
    };

    let callbackServer: CallbackServer | undefined;
    try {
      const metadata = await this.fetchMetadata(request.server, request.insecureSkipTlsVerify);
      throwIfCancelled();

      const pkce = metadata.supportsS256 ? generatePkce() : undefined;
      const state = generateState();
      callbackServer = await startCallbackServer({
        requestedPort: request.callbackPort,
        state,
        signal: controller.signal,
        timeoutMs: this.options.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS,
        onCancelError: () => new OpenShiftWebLoginCancelledError(),
      });

      const redirectUri = buildRedirectUri(callbackServer.host, callbackServer.port);
      hooks.onAuthorizeUrl(buildAuthorizeUrl(metadata, { redirectUri, state, challenge: pkce?.challenge }));
      const code = await callbackServer.waitForCode();
      throwIfCancelled();

      const tokenRequest = buildTokenRequest({ code, redirectUri, verifier: pkce?.verifier });
      const res = await requestJson(metadata.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: tokenRequest.authorization,
        },
        body: tokenRequest.body,
        insecureSkipTlsVerify: request.insecureSkipTlsVerify,
        timeoutMs: this.requestTimeoutMs,
        allowHttp: this.allowHttp,
      });
      if (res.statusCode !== 200 && res.json === undefined) {
        throw new Error(`OpenShift token request failed (HTTP ${res.statusCode})`);
      }
      const token = parseTokenResponse(res.json);
      return { token: token.accessToken, expiresAt: token.expiresAt };
    } finally {
      callbackServer?.close();
      hooks.signal?.removeEventListener('abort', onExternalAbort);
      if (this.active === controller) this.active = null;
    }
  }
}
