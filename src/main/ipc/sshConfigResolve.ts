import type { SSHConnectionConfig } from '../../shared/types/ssh';
import type { IpcBridge } from '../IpcBridge';

/** What `resolveSshConfigForConnect` needs from the bridge. */
export type SshConfigResolveHost = Pick<IpcBridge, 'restoreSavedSecrets' | 'teamVaultService'>;

/**
 * Turns the connection config the renderer sent into the one main actually connects with: a Team Vault
 * shared profile is looked up by its reference, and a saved password or key passphrase is restored.
 * The renderer's own copy may have had both stripped (a Team Vault member never receives the real
 * secrets, and the secrets of saved profiles never leave main), so a connection has to be resolved here
 * rather than trusting `config.password`. Used by the terminal and tunnel handlers. Not yet by the file
 * manager (`storageHandlers`, which has its own Team Vault lookup), git (`gitHandlers`) or key
 * installation (`keyInstallHandlers`); the last two restore saved secrets but ignore a Team Vault
 * reference, which has not been checked against a shared profile.
 */
export async function resolveSshConfigForConnect(
  bridge: SshConfigResolveHost,
  config: SSHConnectionConfig
): Promise<SSHConnectionConfig> {
  let resolved = config;
  if (resolved.teamVaultProfileRef) {
    const shared = await bridge.teamVaultService.resolveProfileForConnect(
      resolved.teamVaultProfileRef.vaultId,
      'ssh',
      resolved.teamVaultProfileRef.profileId
    );
    resolved = { ...(shared as SSHConnectionConfig), id: resolved.id };
  }
  return bridge.restoreSavedSecrets(resolved);
}
