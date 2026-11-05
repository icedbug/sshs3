import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import type { AppSettings } from '@shared/types/settings';
import type { TeamVaultPayload, TeamVaultStatus } from '@shared/types/teamVault';
import type { SearchSource } from './globalSearchIndex';

/** The slice of `window.multissh` the global search reads; injected so the loading rules are testable. */
export interface SearchSourcesApi {
  profilesGet(): Promise<{ ssh: SSHConnectionConfig[]; s3: S3Config[] }>;
  teamVaultList(): Promise<TeamVaultStatus[]>;
  teamVaultGetPayload(vaultId: string): Promise<TeamVaultPayload | null>;
  settingsGet(): Promise<Pick<AppSettings, 'connectionManagerVisibleTeamVaults'>>;
}

export interface LockedVault {
  vaultId: string;
  name: string;
}

export interface LoadedSearchSources {
  /** Personal profiles first, then each unlocked, visible Team Vault. */
  sources: SearchSource[];
  /** Visible vaults whose profiles cannot be searched until they are unlocked. */
  locked: LockedVault[];
}

/** Runs one read; a rejection, a synchronous throw (an API that is not wired) or an empty answer all become null. */
async function attempt<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return (await read()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads every profile the palette can search. A source that cannot be read is skipped (the palette
 * must open and search the rest) and a vault the user hid in Connection Manager is left out. A Team
 * Vault profile gets the same `teamVaultProfileRef` Connection Manager adds, which is what lets the
 * main process fetch its real secrets when connecting.
 */
export async function loadSearchSources(api: SearchSourcesApi): Promise<LoadedSearchSources> {
  const [personalRaw, vaultsRaw, settingsRaw] = await Promise.all([
    attempt(() => api.profilesGet()),
    attempt(() => api.teamVaultList()),
    attempt(() => api.settingsGet()),
  ]);
  const personal = { ssh: personalRaw?.ssh ?? [], s3: personalRaw?.s3 ?? [] };
  const vaults = vaultsRaw ?? [];
  const visible = settingsRaw?.connectionManagerVisibleTeamVaults ?? {};

  const shown = vaults.filter((v): v is TeamVaultStatus & { vaultId: string } => v.exists && !!v.vaultId && visible[v.vaultId] !== false);
  const locked = shown.filter((v) => !v.unlocked).map((v) => ({ vaultId: v.vaultId, name: v.vaultName || v.vaultId }));
  const open = shown.filter((v) => v.unlocked);

  const payloads = await Promise.all(open.map((v) => attempt(() => api.teamVaultGetPayload(v.vaultId))));
  const sources: SearchSource[] = [{ source: 'personal', ssh: personal.ssh, s3: personal.s3 }];
  open.forEach((vault, i) => {
    const payload = payloads[i];
    if (!payload) return;
    const ref = (profileId: string) => ({ teamVaultProfileRef: { vaultId: vault.vaultId, profileId } });
    sources.push({
      source: vault.vaultId,
      label: vault.vaultName || vault.vaultId,
      ssh: payload.ssh.map((p) => ({ ...p, ...ref(p.id) })),
      s3: payload.s3.map((p) => ({ ...p, ...ref(p.id) })),
    });
  });
  return { sources, locked };
}
