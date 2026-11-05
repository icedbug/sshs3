import { useCallback, useEffect, useState } from 'react';
import type { K8sProfile } from '@shared/types/kubernetes';

export interface TeamK8sGroup {
  vaultId: string;
  vaultName: string;
  profiles: K8sProfile[];
}

/**
 * The shared K8s cluster templates of every unlocked Team Vault the user has not hidden. Locked vaults
 * are only counted (unlocking happens in the SSH/S3 tabs), and nothing here ever holds a secret.
 */
export function useK8sTeamProfiles(enabled: boolean) {
  const [groups, setGroups] = useState<TeamK8sGroup[]>([]);
  const [lockedCount, setLockedCount] = useState(0);

  const reload = useCallback(async () => {
    if (!enabled || !window.multissh?.teamVaultList) return;
    try {
      const [statuses, settings] = await Promise.all([
        window.multissh.teamVaultList(),
        window.multissh.settingsGet?.().catch(() => undefined),
      ]);
      const visible = statuses.filter(
        (s) => s.vaultId && settings?.connectionManagerVisibleTeamVaults?.[s.vaultId] !== false
      );
      setLockedCount(visible.filter((s) => !s.unlocked).length);
      const loaded = await Promise.all(
        visible
          .filter((s) => s.unlocked)
          .map(async (s): Promise<TeamK8sGroup | null> => {
            const payload = await window.multissh.teamVaultGetPayload(s.vaultId as string).catch(() => null);
            if (!payload) return null;
            return { vaultId: s.vaultId as string, vaultName: s.vaultName || (s.vaultId as string), profiles: payload.k8s ?? [] };
          })
      );
      setGroups(loaded.filter((g): g is TeamK8sGroup => g !== null));
    } catch {
      setGroups([]);
      setLockedCount(0);
    }
  }, [enabled]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { groups, lockedCount, reload };
}
