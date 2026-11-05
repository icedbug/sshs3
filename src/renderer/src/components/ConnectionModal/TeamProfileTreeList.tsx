import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { AlertTriangle, CloudDownload, Loader2, Lock, Plus, Unlock, X } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import type { TeamVaultPayload, TeamVaultStatus } from '@shared/types/teamVault';
import type { EditingState, TeamVaultMeta, TeamProfileTreeListHandle } from './types';
import { TeamProfileTree } from './TeamProfileTree';
import { TeamFolderSidebar } from './TeamFolderSidebar';
import { TeamBulkEdit } from './TeamBulkEdit';
import { SystemAwareRows } from './SystemAwareRows';
import { alignSystemMembers, systemNames } from '../../lib/systemGrouping';
import { saveInOrder } from '../../lib/saveInOrder';
import { moveWithSystems } from '../../lib/systemEdit';
import { createSystemActions } from '../../lib/systemActions';
import { TeamSshProfileRow, TeamS3ProfileRow } from './TeamProfileRows';
import { buildTeamFolderTree, collectTeamFolderSuggestions, filterTeamFolderNamesForTab } from './teamFolderTree';
import { filterSshProfiles, filterS3Profiles } from './connectionGrouping';
import { describeIpcError } from '../../lib/format';
import { useConfirm } from '../ConfirmDialog';

/** One known team's worth of state this component owns — never shared across vaultIds, same
 * per-team isolation invariant `TeamVaultService`'s own `Map<vaultId, ...>` upholds on the main
 * side (see its class doc comment). */
interface VaultEntry {
  status: TeamVaultStatus;
  payload: TeamVaultPayload | null;
  folderPath: string[];
  unlockRecipientId: string;
  unlockIdentityPath: string;
  unlocking: boolean;
  showManualUnlock: boolean;
  notice: 'auto-pulled' | 'remote-changed' | null;
}

interface TeamProfileTreeListProps {
  tab: 'ssh' | 's3';
  query: string;
  /** The one team currently selected in the Connection Manager's per-team tab row (§D) — when
   * set, only that vaultId's section is rendered (locked-form or unlocked tree), instead of every
   * known team stacked as sections. `null`/undefined falls back to the old "every known team"
   * rendering (used by tests that don't go through the tab row). */
  activeVaultId?: string | null;
  onConnectSSH?: (config: SSHConnectionConfig) => void;
  onConnectSFTP?: (config: SSHConnectionConfig) => void;
  onConnectS3?: (config: S3Config) => void;
  setEditing: Dispatch<SetStateAction<EditingState | null>>;
  onNewProfile: (type: 'ssh' | 's3', vaultId: string) => void;
  /** Connects to every server of a system ("Connect all"); `source` is the Team Vault id. Omit to hide the button. */
  onConnectSystem?: (members: SSHConnectionConfig[], source: string) => void;
  /** Reported every time known vaults/payloads change, so `ConnectionManagerModal` can look up
   * `isAdmin`/`folderSuggestions` for whichever vaultId the open edit form belongs to — this
   * component is the only one that actually fetches every unlocked vault's payload, so it's the
   * only place that can answer "is the signed-in identity an admin of vault X" without a second,
   * redundant fetch. */
  onVaultsMetaChange: (metas: TeamVaultMeta[]) => void;
  /** Where each team's folder browser is, by `<tab>/<vaultId>` (the SSH and S3 tabs show different folders).
   * Kept by the parent so that it survives this component being unmounted while a profile is edited;
   * without it the position is kept here. */
  folderPaths?: Record<string, string[]>;
  onFolderPathChange?: (key: string, path: string[]) => void;
}

/**
 * Renders one section per team this device knows about (docs/team-vault-plan.md's multi-team
 * plan §7): an unlocked team gets its own `TeamProfileTree` (folder browser) plus a "New Profile"
 * button; a locked team gets a collapsed header with an inline unlock form, same pattern
 * `TeamVaultDetailPanel` uses. Deliberately presentational-with-its-own-data-fetching rather than
 * a dumb view fed entirely by `ConnectionManagerModal` — every Team Vault IPC call this component
 * triggers (unlock, folder CRUD, profile delete/clone/move) is scoped to the specific vaultId its
 * own section belongs to, so one team's actions can never leak into another's, mirroring the
 * same isolation `TeamVaultService` enforces on the backend. Only two actions bubble up to the
 * parent (`onConnectSSH`/`onConnectSFTP`/`onConnectS3`, and opening the SSH/S3 edit form via
 * `setEditing`/`onNewProfile`), since the form itself is rendered by `ConnectionManagerModal`.
 */
export const TeamProfileTreeList = forwardRef<TeamProfileTreeListHandle, TeamProfileTreeListProps>(function TeamProfileTreeList(
  {
    tab,
    query,
    activeVaultId,
    onConnectSSH,
    onConnectSFTP,
    onConnectS3,
    onConnectSystem,
    setEditing,
    onNewProfile,
    onVaultsMetaChange,
    folderPaths,
    onFolderPathChange,
  },
  ref
) {
  const confirm = useConfirm();
  const [entries, setEntries] = useState<Record<string, VaultEntry>>({});
  const [vaultOrder, setVaultOrder] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedSystems, setCollapsedSystems] = useState<Record<string, boolean>>({});
  const toggleSystem = (key: string) => setCollapsedSystems((prev) => ({ ...prev, [key]: !prev[key] }));

  const loadPayload = useCallback(async (vaultId: string) => {
    try {
      const payload = await window.multissh.teamVaultGetPayload(vaultId);
      setEntries((prev) => (prev[vaultId] ? { ...prev, [vaultId]: { ...prev[vaultId], payload } } : prev));
    } catch {
      setEntries((prev) => (prev[vaultId] ? { ...prev, [vaultId]: { ...prev[vaultId], payload: null } } : prev));
    }
  }, []);

  const refreshVault = useCallback(
    async (vaultId: string) => {
      try {
        const status = await window.multissh.teamVaultGetStatus(vaultId);
        setEntries((prev) => {
          const existing = prev[vaultId];
          return {
            ...prev,
            [vaultId]: {
              status,
              payload: existing?.payload ?? null,
              folderPath: existing?.folderPath ?? [],
              unlockRecipientId: existing?.unlockRecipientId || status.selfRecipientId || '',
              unlockIdentityPath: existing?.unlockIdentityPath || status.selfIdentityFilePath || '',
              unlocking: false,
              showManualUnlock: existing?.showManualUnlock ?? false,
              notice: existing?.notice ?? null,
            },
          };
        });
        if (status.unlocked) {
          await loadPayload(vaultId);
        }
      } catch {
        // Best-effort — a vault this device can no longer read is simply dropped on the next
        // full load() rather than surfaced as a hard error here.
      }
    },
    [loadPayload]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statuses = await window.multissh.teamVaultList();
      setVaultOrder(statuses.map((s) => s.vaultId!).filter(Boolean));
      setEntries((prev) => {
        const next: Record<string, VaultEntry> = {};
        for (const status of statuses) {
          if (!status.vaultId) continue;
          const existing = prev[status.vaultId];
          next[status.vaultId] = {
            status,
            payload: existing?.payload ?? null,
            folderPath: existing?.folderPath ?? [],
            unlockRecipientId: existing?.unlockRecipientId || status.selfRecipientId || '',
            unlockIdentityPath: existing?.unlockIdentityPath || status.selfIdentityFilePath || '',
            unlocking: false,
            showManualUnlock: existing?.showManualUnlock ?? false,
            notice: existing?.notice ?? null,
          };
        }
        return next;
      });
      await Promise.all(statuses.filter((s) => s.unlocked && s.vaultId).map((s) => loadPayload(s.vaultId!)));
    } catch (err) {
      setError(describeIpcError(err, 'Failed to load the list of teams'));
    } finally {
      setLoading(false);
    }
  }, [loadPayload]);

  useEffect(() => {
    void load();
  }, [load]);

  // Background auto-poll (IpcBridge.runTeamVaultAutoPoll) pushes these per-vaultId — refresh
  // just the affected team's payload so an edit from another member shows up without a manual
  // reopen, same as the single-team version of this used to, but scoped per vault now.
  useEffect(() => {
    const unsubscribePulled = window.multissh.onTeamVaultAutoPulled?.(({ vaultId }) => {
      setEntries((prev) => (prev[vaultId] ? { ...prev, [vaultId]: { ...prev[vaultId], notice: 'auto-pulled' } } : prev));
      void refreshVault(vaultId);
    });
    const unsubscribeChanged = window.multissh.onTeamVaultRemoteChanged?.(({ vaultId }) => {
      setEntries((prev) => (prev[vaultId] ? { ...prev, [vaultId]: { ...prev[vaultId], notice: 'remote-changed' } } : prev));
    });
    return () => {
      unsubscribePulled?.();
      unsubscribeChanged?.();
    };
  }, [refreshVault]);

  // Tell the parent which team each visible profile belongs to, and whether this device is an
  // admin of it — ConnectionManagerModal needs this to gate the edit form's secret field and
  // folder-suggestion autocomplete, but has no other way to know (it doesn't fetch payloads
  // itself any more).
  useEffect(() => {
    const trimmedQuery = query.trim().toLowerCase();
    const metas: TeamVaultMeta[] = vaultOrder
      .map((vaultId) => entries[vaultId])
      .filter((e): e is VaultEntry => !!e)
      .map((e) => ({
        vaultId: e.status.vaultId!,
        vaultName: e.status.vaultName,
        isAdmin: !!e.status.members?.some((m) => m.recipientId === e.status.selfRecipientId && m.role === 'admin'),
        folderSuggestions: collectTeamFolderSuggestions(e.payload?.folders ?? [], e.payload?.ssh ?? [], e.payload?.s3 ?? []),
        systemSuggestions: systemNames(e.payload?.ssh ?? []),
        unlocked: e.status.unlocked,
        matchCount: !trimmedQuery
          ? 0
          : tab === 'ssh'
            ? filterSshProfiles(e.payload?.ssh ?? [], trimmedQuery).length
            : filterS3Profiles(e.payload?.s3 ?? [], trimmedQuery).length,
      }));
    onVaultsMetaChange(metas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, vaultOrder, tab, query]);

  const updateEntry = (vaultId: string, patch: Partial<VaultEntry>) => {
    setEntries((prev) => (prev[vaultId] ? { ...prev, [vaultId]: { ...prev[vaultId], ...patch } } : prev));
  };

  // §C: the one safe action on a sync conflict (pushToRemote deliberately has no merge/force
  // path — see TeamVaultService.pushToRemote's doc comment) is to discard this machine's unpushed
  // local changes and adopt the remote's latest version instead.
  const [gettingLatestVaultId, setGettingLatestVaultId] = useState<string | null>(null);

  const handleGetLatest = async (vaultId: string) => {
    if (
      !(await confirm({
        title: 'Get latest version',
        message: 'A newer version is available on the remote. Your unsynced changes here will be lost. Get the latest version anyway?',
        confirmLabel: 'Get latest (discard local changes)',
      }))
    ) {
      return;
    }
    setGettingLatestVaultId(vaultId);
    setError(null);
    try {
      await window.multissh.teamVaultPull(vaultId, { force: true });
      updateEntry(vaultId, { notice: null });
      await refreshVault(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to get the latest version'));
    } finally {
      setGettingLatestVaultId(null);
    }
  };

  const handleUnlock = async (vaultId: string) => {
    const entry = entries[vaultId];
    if (!entry || !entry.unlockRecipientId.trim() || !entry.unlockIdentityPath.trim()) return;
    updateEntry(vaultId, { unlocking: true });
    setError(null);
    try {
      await window.multissh.teamVaultUnlock(vaultId, entry.unlockRecipientId.trim(), entry.unlockIdentityPath.trim());
      await refreshVault(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to unlock the Team Vault'));
      updateEntry(vaultId, { unlocking: false });
    }
  };

  useImperativeHandle(ref, () => ({ refreshVault }), [refreshVault]);

  const handleCloneSSH = async (vaultId: string, profile: SSHConnectionConfig) => {
    const clone: SSHConnectionConfig = { ...profile, id: crypto.randomUUID(), name: `${profile.name} (Copy)` };
    delete clone.lastUsedAt;
    delete clone.teamVaultProfileRef;
    try {
      await window.multissh.teamVaultSaveSSHProfile(vaultId, clone);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to clone profile'));
    }
  };

  const handleCloneS3 = async (vaultId: string, profile: S3Config) => {
    const clone: S3Config = { ...profile, id: crypto.randomUUID(), name: `${profile.name} (Copy)` };
    delete clone.lastUsedAt;
    delete clone.teamVaultProfileRef;
    try {
      await window.multissh.teamVaultSaveS3Profile(vaultId, clone);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to clone profile'));
    }
  };

  const handleDeleteSSH = async (vaultId: string, id: string, name: string) => {
    if (!(await confirm({ title: 'Delete profile', message: `Delete the shared SSH profile "${name}"?` }))) return;
    try {
      await window.multissh.teamVaultDeleteSSHProfile(vaultId, id);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete profile'));
    }
  };

  const handleDeleteS3 = async (vaultId: string, id: string, name: string) => {
    if (!(await confirm({ title: 'Delete profile', message: `Delete the shared S3 profile "${name}"?` }))) return;
    try {
      await window.multissh.teamVaultDeleteS3Profile(vaultId, id);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete profile'));
    }
  };

  const handleCreateTeamFolder = async (vaultId: string, fullPath: string) => {
    try {
      await window.multissh.teamVaultSaveFolder(vaultId, fullPath);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to create folder'));
    }
  };

  const handleRenameTeamFolder = async (vaultId: string, oldPath: string, newPath: string) => {
    try {
      await window.multissh.teamVaultRenameFolder(vaultId, oldPath, newPath);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to rename folder'));
    }
  };

  const handleDeleteTeamFolder = async (vaultId: string, path: string) => {
    if (
      !(await confirm({
        title: 'Delete folder',
        message: `Delete folder "${path}"? Profiles inside (including any subfolders) will be moved to Ungrouped.`,
      }))
    ) {
      return;
    }
    try {
      await window.multissh.teamVaultDeleteFolder(vaultId, path, false);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete folder'));
    }
  };

  const handleSetTeamFolderIcon = async (vaultId: string, path: string, icon: string | undefined) => {
    try {
      await window.multissh.teamVaultSetFolderIcon(vaultId, path, icon);
      await loadPayload(vaultId);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to set folder icon'));
    }
  };

  /** Saves a profile from the list as it is shown, without the vault reference the list adds to each one for connecting. */
  const saveSharedProfile = (vaultId: string, kind: 'ssh' | 's3', profile: SSHConnectionConfig | S3Config) => {
    const { teamVaultProfileRef: _ref, ...saved } = profile as (SSHConnectionConfig | S3Config) & { teamVaultProfileRef?: unknown };
    return kind === 'ssh'
      ? window.multissh.teamVaultSaveSSHProfile(vaultId, saved as SSHConnectionConfig)
      : window.multissh.teamVaultSaveS3Profile(vaultId, saved as S3Config);
  };

  const handleDropOnTeamFolder = async (
    vaultId: string,
    targetPath: string | undefined,
    e: React.DragEvent,
    kind: 'ssh' | 's3'
  ) => {
    e.preventDefault();
    try {
      const dataStr = e.dataTransfer.getData('text/plain');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      if (data.type !== kind) return;
      const payload = entries[vaultId]?.payload;
      if (kind === 'ssh') {
        // A server in a system takes the whole system along.
        const changed = moveWithSystems(payload?.ssh ?? [], new Set([data.id]), targetPath);
        if (changed.length > 0) {
          await saveInOrder(
            changed,
            (p) => window.multissh.teamVaultSaveSSHProfile(vaultId, p),
            () => loadPayload(vaultId),
            setError,
            'Failed to move the profile'
          );
        }
      } else {
        const profile = payload?.s3.find((p) => p.id === data.id);
        if (profile && profile.group !== targetPath) {
          await window.multissh.teamVaultSaveS3Profile(vaultId, { ...profile, group: targetPath });
          await loadPayload(vaultId);
        }
      }
    } catch {
      // Ignore invalid drag-drop data
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-txt-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading teams...
      </div>
    );
  }

  // The list itself could not be loaded: there is nothing else to show, so offer another try.
  if (error && vaultOrder.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary transition-colors hover:bg-app-surface-hover hover:text-txt-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  // A failed action (unlock, folder change, sync) is shown above the teams, which stay usable.
  const errorBanner = error ? (
    <div
      role="alert"
      className="flex items-start justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
    >
      <span className="min-w-0 break-words">{error}</span>
      <button
        type="button"
        aria-label="Dismiss error"
        title="Dismiss"
        onClick={() => setError(null)}
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-red-500/20"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  ) : null;

  if (vaultOrder.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <Lock className="h-5 w-5 text-amber-400" />
        <p className="text-sm text-txt-muted">No Team Vault has been set up on this machine yet.</p>
        <p className="text-xs text-txt-muted">Settings &gt; Team Vault</p>
      </div>
    );
  }

  // When a specific team tab is selected (§D), render only that one vault's section — the old
  // "every known team stacked as sections" behavior still applies when activeVaultId is omitted
  // (e.g. existing tests that render this component directly).
  const visibleVaultIds = activeVaultId ? vaultOrder.filter((id) => id === activeVaultId) : vaultOrder;

  return (
    <div className="space-y-4">
      {errorBanner}
      {visibleVaultIds.map((vaultId) => {
        const entry = entries[vaultId];
        if (!entry) return null;
        const { status } = entry;
        const title = status.vaultName || status.vaultId || vaultId;

        if (!status.unlocked) {
          return (
            <div
              key={vaultId}
              className="flex flex-col items-center gap-3 rounded-lg border border-border-subtle bg-app-surface-subtle p-6 text-center"
            >
              <Lock className="h-6 w-6 text-amber-400" />
              <p className="text-sm font-medium text-txt-secondary">{title} is locked</p>
              {!entry.showManualUnlock && entry.unlockRecipientId && entry.unlockIdentityPath && status.selfRecipientId ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleUnlock(vaultId);
                  }}
                  className="flex flex-col items-center gap-2"
                >
                  <button
                    type="submit"
                    disabled={entry.unlocking}
                    className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {entry.unlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                    Unlock as {entry.unlockRecipientId}
                  </button>
                  <button
                    type="button"
                    onClick={() => updateEntry(vaultId, { showManualUnlock: true, unlockRecipientId: '', unlockIdentityPath: '' })}
                    className="text-xs text-txt-muted underline hover:text-txt-secondary"
                  >
                    Use a different identity...
                  </button>
                </form>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void handleUnlock(vaultId);
                  }}
                  className="flex w-full max-w-xs flex-col gap-2"
                >
                  <input
                    type="text"
                    value={entry.unlockRecipientId}
                    onChange={(e) => updateEntry(vaultId, { unlockRecipientId: e.target.value })}
                    placeholder="Your recipient id"
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                  />
                  <input
                    type="text"
                    value={entry.unlockIdentityPath}
                    onChange={(e) => updateEntry(vaultId, { unlockIdentityPath: e.target.value })}
                    placeholder="Path to your identity file"
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                  />
                  <button
                    type="submit"
                    disabled={entry.unlocking || !entry.unlockRecipientId.trim() || !entry.unlockIdentityPath.trim()}
                    className="flex items-center justify-center gap-1.5 self-center rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {entry.unlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                    Unlock
                  </button>
                </form>
              )}
            </div>
          );
        }

        const ssh = entry.payload?.ssh ?? [];
        const s3 = entry.payload?.s3 ?? [];
        // `storedSshWithRef` is what edits start from; `sshWithRef` only differs in the folder of a system's servers, for drawing.
        const storedSshWithRef = ssh.map((p) => ({ ...p, teamVaultProfileRef: { vaultId, profileId: p.id } }));
        const sshWithRef = alignSystemMembers(storedSshWithRef);
        const systemActions = createSystemActions({
          profiles: ssh,
          save: (p: SSHConnectionConfig) => window.multissh.teamVaultSaveSSHProfile(vaultId, p),
          reload: () => loadPayload(vaultId),
          onError: setError,
          confirm,
        });
        const s3WithRef = s3.map((p) => ({ ...p, teamVaultProfileRef: { vaultId, profileId: p.id } }));
        const filteredSSH = filterSshProfiles(sshWithRef, query);
        const filteredS3 = filterS3Profiles(s3WithRef, query);
        const activeProfiles = tab === 'ssh' ? filteredSSH : filteredS3;
        // Scope the folder registry to this tab's type (§13) before building the tree — a folder
        // used only for S3 buckets shouldn't show up, empty, on the SSH tab and vice versa.
        const tabFolders = filterTeamFolderNamesForTab(tab, entry.payload?.folders ?? [], ssh, s3);
        const tree =
          tab === 'ssh'
            ? buildTeamFolderTree(tabFolders, filteredSSH, entry.payload?.folderIcons ?? {})
            : buildTeamFolderTree(tabFolders, filteredS3, entry.payload?.folderIcons ?? {});

        const currentFolderPath = folderPaths ? (folderPaths[`${tab}/${vaultId}`] ?? []) : entry.folderPath;
        const navigateToFolder = (path: string[]) =>
          onFolderPathChange ? onFolderPathChange(`${tab}/${vaultId}`, path) : updateEntry(vaultId, { folderPath: path });

        return (
          <div key={vaultId} className="space-y-2 rounded-lg border border-border-subtle bg-app-surface-subtle p-3">
            <div className="flex items-center justify-end gap-2">
              {/* Omitted when a specific tab is selected (§D/§11) — the Connection Manager's own
                  tab row already names this team, so repeating it here was a duplicate heading. */}
              {!activeVaultId && (
                <p className="mr-auto flex items-center gap-1.5 text-xs font-semibold text-txt-secondary">
                  <Unlock className="h-3.5 w-3.5 text-emerald-400" />
                  {title}
                </p>
              )}
              <div className="flex items-center gap-2">
                {entry.notice === 'auto-pulled' && (
                  <span className="flex items-center gap-1 text-2xs text-txt-muted">
                    <CloudDownload className="h-3 w-3 text-emerald-400" />
                    Updated
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onNewProfile(tab, vaultId)}
                  className="flex items-center gap-1 rounded-lg bg-sky-600 px-2 py-1 text-2xs font-medium text-white hover:bg-sky-500"
                >
                  <Plus className="h-3 w-3" />
                  New Profile
                </button>
              </div>
            </div>

            {/* §C: a sync conflict (local unpushed changes + a newer remote revision) gets one
                safe action, not just a passive badge — pushToRemote has no merge/force path, so
                "get the latest version" (discarding local changes) is the only way to resolve it
                here, same as TeamVaultListPanel's identical banner for the Settings view. */}
            {entry.notice === 'remote-changed' && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-2xs text-amber-300">
                <span className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  A newer version is available — your unsynced changes here will be lost.
                </span>
                <button
                  type="button"
                  onClick={() => void handleGetLatest(vaultId)}
                  disabled={gettingLatestVaultId === vaultId}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-amber-700/60 px-2 py-1 font-medium text-amber-200 hover:bg-amber-950/40 disabled:opacity-50"
                >
                  {gettingLatestVaultId === vaultId ? <Loader2 className="h-3 w-3 animate-spin" /> : <CloudDownload className="h-3 w-3" />}
                  Get latest
                </button>
              </div>
            )}

            {activeProfiles.length === 0 && tree.roots.length === 0 ? (
              <p className="py-4 text-center text-xs text-txt-muted">
                {query ? 'No shared profiles matched your search' : 'No shared profiles yet'}
              </p>
            ) : (
              <TeamBulkEdit<SSHConnectionConfig | S3Config>
                key={`${vaultId}/${tab}`}
                profiles={activeProfiles}
                allProfiles={tab === 'ssh' ? storedSshWithRef : s3WithRef}
                systemSuggestions={tab === 'ssh' ? systemNames(ssh) : undefined}
                save={(profile) => saveSharedProfile(vaultId, tab, profile)}
                reload={() => loadPayload(vaultId)}
                onError={setError}
                folderSuggestions={collectTeamFolderSuggestions(entry.payload?.folders ?? [], ssh, s3)}
              >
                {(rowSelect) => {
                  const renderTeamProfile = (profile: SSHConnectionConfig | S3Config) => (
                  tab === 'ssh' ? (
                    <TeamSshProfileRow
                      key={profile.id}
                      profile={profile as SSHConnectionConfig}
                      onConnectSSH={onConnectSSH}
                      onConnectSFTP={onConnectSFTP}
                      handleCloneSSH={(p) => handleCloneSSH(vaultId, p)}
                      handleDeleteSSH={(id, name) => handleDeleteSSH(vaultId, id, name)}
                      setEditing={setEditing}
                      select={rowSelect(profile.id)}
                    />
                  ) : (
                    <TeamS3ProfileRow
                      key={profile.id}
                      profile={profile as S3Config}
                      onConnectS3={onConnectS3}
                      handleCloneS3={(p) => handleCloneS3(vaultId, p)}
                      handleDeleteS3={(id, name) => handleDeleteS3(vaultId, id, name)}
                      setEditing={setEditing}
                      select={rowSelect(profile.id)}
                    />
                  )
                  );
                  return (
              <div className="flex gap-3">
                {/* The folder tree beside the list; while searching, the results are one flat list and the tree is not needed. */}
                {tree.roots.length > 0 && !query.trim() && (
                  <div className="hidden md:block">
                    <TeamFolderSidebar
                      roots={tree.roots}
                      ungroupedCount={tree.ungrouped.length}
                      currentPath={currentFolderPath}
                      onNavigate={navigateToFolder}
                      onDropProfile={(targetPath, e) => void handleDropOnTeamFolder(vaultId, targetPath, e, tab)}
                    />
                  </div>
                )}
                <div className="min-w-0 flex-1">
              <TeamProfileTree
                roots={tree.roots}
                ungrouped={tree.ungrouped}
                currentPath={currentFolderPath}
                onNavigate={navigateToFolder}
                query={query}
                renderProfile={renderTeamProfile}
                renderProfileList={
                  tab === 'ssh'
                    ? (list) => (
                        <SystemAwareRows
                          profiles={list as SSHConnectionConfig[]}
                          source={vaultId}
                          renderProfile={renderTeamProfile}
                          onConnectSystem={onConnectSystem}
                          collapsed={collapsedSystems}
                          onToggle={toggleSystem}
                          onRenameSystem={(members, name) => void systemActions.rename(members, name)}
                          onUngroupSystem={(members) => void systemActions.ungroup(members)}
                        />
                      )
                    : undefined
                }
                onDropProfile={(targetPath, e) => void handleDropOnTeamFolder(vaultId, targetPath, e, tab)}
                onCreateFolder={(fullPath) => handleCreateTeamFolder(vaultId, fullPath)}
                onRenameFolder={(oldPath, newPath) => handleRenameTeamFolder(vaultId, oldPath, newPath)}
                onDeleteFolder={(path) => handleDeleteTeamFolder(vaultId, path)}
                onSetFolderIcon={(path, icon) => handleSetTeamFolderIcon(vaultId, path, icon)}
              />
                </div>
              </div>
                  );
                }}
              </TeamBulkEdit>
            )}
          </div>
        );
      })}
    </div>
  );
});
