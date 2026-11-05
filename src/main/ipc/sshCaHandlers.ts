import { IPC_CHANNELS } from '../../shared/types/ipc';
import type {
  SshCaConfig,
  SshCaDetectRequest,
  SshCaDetectResult,
  SshCaStatus,
  SshCaVaultDetectRequest,
  SshCaVaultDetectResult,
} from '../../shared/types/sshCa';
import type { IpcBridge } from '../IpcBridge';
import type { SshCaService } from '../ca/SshCaService';
import { detectStepCa } from '../ca/stepCaDiscovery';
import { detectVault } from '../ca/vaultDiscovery';

export type SshCaHost = Pick<IpcBridge, 'registerHandler'> & {
  sshCaService: Pick<SshCaService, 'getStatus' | 'login' | 'logout' | 'renew'>;
};

export function validateSshCaConfig(input: unknown): SshCaConfig | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const c = input as Partial<SshCaConfig>;
  if (!c.id || typeof c.id !== 'string') throw new Error('Invalid SSH CA configuration: missing id');
  if (!c.name || typeof c.name !== 'string') throw new Error('Invalid SSH CA configuration: missing name');
  if (c.backend !== 'step-ca' && c.backend !== 'vault') {
    throw new Error(`Invalid SSH CA configuration: unsupported backend "${c.backend}"`);
  }
  if (!c.caUrl || typeof c.caUrl !== 'string') throw new Error('Invalid SSH CA configuration: missing caUrl');
  if (!c.oidcIssuerUrl || typeof c.oidcIssuerUrl !== 'string') {
    throw new Error('Invalid SSH CA configuration: missing oidcIssuerUrl');
  }
  if (!c.oidcClientId || typeof c.oidcClientId !== 'string') {
    throw new Error('Invalid SSH CA configuration: missing oidcClientId');
  }
  return {
    id: String(c.id).trim(),
    name: String(c.name).trim(),
    backend: c.backend,
    caUrl: String(c.caUrl).trim(),
    rootCaCert: c.rootCaCert ? String(c.rootCaCert) : undefined,
    oidcIssuerUrl: String(c.oidcIssuerUrl).trim(),
    oidcClientId: String(c.oidcClientId).trim(),
    keySource: c.keySource === 'piv' ? 'piv' : 'ephemeral',
    defaultPrincipals: Array.isArray(c.defaultPrincipals)
      ? c.defaultPrincipals.map((p) => String(p).trim()).filter(Boolean)
      : undefined,
    vaultAuthPath: c.vaultAuthPath ? String(c.vaultAuthPath).trim() : undefined,
    vaultRole: c.vaultRole ? String(c.vaultRole).trim() : undefined,
    vaultSshMount: c.vaultSshMount ? String(c.vaultSshMount).trim() : undefined,
    vaultSshRole: c.vaultSshRole ? String(c.vaultSshRole).trim() : undefined,
    vaultNamespace: c.vaultNamespace ? String(c.vaultNamespace).trim() : undefined,
  };
}

export function validateSshCaDetectRequest(input: unknown): SshCaDetectRequest {
  if (!input || typeof input !== 'object') throw new Error('Invalid SSH CA detect request');
  const r = input as Partial<SshCaDetectRequest>;
  if (typeof r.caUrl !== 'string' || !r.caUrl.trim() || r.caUrl.length > 2048) {
    throw new Error('Invalid SSH CA detect request: caUrl');
  }
  if (r.rootFingerprint !== undefined && (typeof r.rootFingerprint !== 'string' || r.rootFingerprint.length > 200)) {
    throw new Error('Invalid SSH CA detect request: rootFingerprint');
  }
  if (r.rootCaCert !== undefined && (typeof r.rootCaCert !== 'string' || r.rootCaCert.length > 100_000)) {
    throw new Error('Invalid SSH CA detect request: rootCaCert');
  }
  return { caUrl: r.caUrl, rootFingerprint: r.rootFingerprint, rootCaCert: r.rootCaCert };
}

export function validateSshCaVaultDetectRequest(input: unknown): SshCaVaultDetectRequest {
  if (!input || typeof input !== 'object') throw new Error('Invalid SSH CA detect request');
  const r = input as Partial<SshCaVaultDetectRequest>;
  if (typeof r.caUrl !== 'string' || !r.caUrl.trim() || r.caUrl.length > 2048) {
    throw new Error('Invalid SSH CA detect request: caUrl');
  }
  if (r.namespace !== undefined && (typeof r.namespace !== 'string' || r.namespace.length > 256)) {
    throw new Error('Invalid SSH CA detect request: namespace');
  }
  if (r.rootCaCert !== undefined && (typeof r.rootCaCert !== 'string' || r.rootCaCert.length > 100_000)) {
    throw new Error('Invalid SSH CA detect request: rootCaCert');
  }
  return { caUrl: r.caUrl, namespace: r.namespace, rootCaCert: r.rootCaCert };
}

export function registerSshCaHandlers(bridge: SshCaHost): void {
  bridge.registerHandler(IPC_CHANNELS.SSH_CA_GET_STATUS, (): SshCaStatus => {
    return bridge.sshCaService.getStatus();
  });

  bridge.registerHandler(
    IPC_CHANNELS.SSH_CA_LOGIN,
    async (_event, rawConfig?: unknown): Promise<SshCaStatus> => {
      const config = validateSshCaConfig(rawConfig);
      return await bridge.sshCaService.login(config);
    }
  );

  bridge.registerHandler(IPC_CHANNELS.SSH_CA_LOGOUT, async (): Promise<void> => {
    await bridge.sshCaService.logout();
  });

  bridge.registerHandler(
    IPC_CHANNELS.SSH_CA_DETECT,
    async (_event, rawRequest?: unknown): Promise<SshCaDetectResult> => {
      return await detectStepCa(validateSshCaDetectRequest(rawRequest));
    }
  );

  bridge.registerHandler(
    IPC_CHANNELS.SSH_CA_DETECT_VAULT,
    async (_event, rawRequest?: unknown): Promise<SshCaVaultDetectResult> => {
      return await detectVault(validateSshCaVaultDetectRequest(rawRequest));
    }
  );

  bridge.registerHandler(IPC_CHANNELS.SSH_CA_RENEW, async (): Promise<SshCaStatus> => {
    return await bridge.sshCaService.renew();
  });
}
