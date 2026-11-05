import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  Download,
  Files,
  FolderPlus,
  Loader2,
  Lock,
  Pencil,
  Pin,
  Plus,
  Search,
  Server,
  Unlock,
  Upload,
  X,
} from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import type { TeamVaultStatus } from '@shared/types/teamVault';
import { collectTags } from '@shared/tags';
import { SSHProfileForm } from './SSHProfileForm';
import { S3ProfileForm } from './S3ProfileForm';
import { K8sConnectionTree } from './K8sConnectionTree';
import type { Tab, EditingState, TeamVaultMeta, TeamProfileTreeListHandle } from './types';
import { SshProfileRow, SshRecentRow } from './SshProfileRows';
import { S3ProfileRow, S3RecentRow } from './S3ProfileRows';
import { BulkActionBar } from './BulkActionBar';
import { SystemAwareRows } from './SystemAwareRows';
import { alignSystemMembers, systemMembersOf, systemNameOf, systemNames } from '../../lib/systemGrouping';
import { TeamProfileTreeList } from './TeamProfileTreeList';
import {
  collectFolderNames,
  filterS3Profiles,
  filterSshProfiles,
  folderNamesForTab,
  groupProfiles,
  mostRecentlyUsed,
  parseAdHocTarget,
} from './connectionGrouping';
import { ProfileFolderHeader } from './ProfileFolderHeader';
import { EmptyFolderDropZone } from './EmptyFolderDropZone';
import { ImportCandidatesModal } from './ImportCandidatesModal';
import { SSHTunnelsModal } from '../SSH/SSHTunnelsModal';
import { InstallKeyModal } from '../SSH/InstallKeyModal';
import { formatDateTime, describeIpcError } from '../../lib/format';
import { prepareConnect } from '../../lib/openProfile';
import { saveInOrder } from '../../lib/saveInOrder';
import { moveWithSystems } from '../../lib/systemEdit';
import { createSystemActions } from '../../lib/systemActions';
import { usePersonalBulkEdit } from '../../lib/usePersonalBulkEdit';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useConfirm } from '../ConfirmDialog';

export type { Tab };

interface ConnectionManagerModalProps {
  open: boolean;
  onClose: () => void;
  initialTab?: Tab;
  /** Opens straight into the empty "new profile" form for `initialTab` (e.g. from the welcome screen). */
  startNewProfile?: boolean;
  /** When set, shows a "Connect" action per profile and invokes this instead of only managing profiles. */
  onConnectSSH?: (config: SSHConnectionConfig) => void;
  /** When set, opens SFTP dual-pane file manager for the given SSH profile. */
  onConnectSFTP?: (config: SSHConnectionConfig) => void;
  onConnectS3?: (config: S3Config) => void;
  /** Connects to every server of a system ("Connect all"); `source` is 'personal' or the Team Vault id. Omit to hide the button. */
  onConnectSystem?: (members: SSHConnectionConfig[], source: string) => void;
  onConnectK8s?: (target: K8sTerminalTarget) => void;
  /** Opens a new tab following a container's logs. */
  onViewK8sLogs?: (target: K8sTerminalTarget) => void;
  /** Opens file manager targeting the container filesystem. */
  onBrowseK8sFiles?: (target: K8sTerminalTarget) => void;
  /** Master switch from Settings > Files & Storage. Off by default; hides the dotfiles pool field in the SSH form. */
  dotfilesPoolEnabled?: boolean;
  /** Master switch from Settings > Kubernetes & Debug. Off by default; enables OpenShift login and tools. */
  enableOpenShift?: boolean;
  /** Master switch from Settings > Files & Storage. Off by default; when off, a tab only shows folders that hold a profile of its own type (or no profiles anywhere yet). */
  shareFoldersAcrossTypes?: boolean;
}

export const ConnectionManagerModal: React.FC<ConnectionManagerModalProps> = ({
  open,
  onClose,
  initialTab = 'ssh',
  startNewProfile = false,
  onConnectSSH,
  onConnectSFTP,
  onConnectS3,
  onConnectSystem,
  onConnectK8s,
  onViewK8sLogs,
  onBrowseK8sFiles,
  dotfilesPoolEnabled = false,
  enableOpenShift = false,
  shareFoldersAcrossTypes = false,
}) => {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [sshProfiles, setSshProfiles] = useState<SSHConnectionConfig[]>([]);
  const [s3Profiles, setS3Profiles] = useState<S3Config[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [tunnelsProfile, setTunnelsProfile] = useState<SSHConnectionConfig | null>(null);
  const [installKeyProfile, setInstallKeyProfile] = useState<SSHConnectionConfig | null>(null);

  // Personal / per-team source "tab" (connection-manager-plan: a flat tab row, one per team this
  // device knows about, next to "Personal" — not a merged list with a badge, and not a single
  // binary "Teams" toggle any more. `'personal'` is the sentinel for the personal view; any other
  // value is a `vaultId`. Team profiles live in each Team Vault's encryptedPayload, never in
  // profiles.json, and are only visible per-team while that team's vault is unlocked — see
  // `TeamProfileTreeList`, which owns the per-vault state (statuses, payloads, unlock forms).
  const [source, setSource] = useState<string>('personal');
  // Every team this device knows about, for the tab row itself (label, lock state, description) —
  // fetched here independently of `TeamProfileTreeList` (which only mounts once a team tab is
  // actually selected) so the tab row can show every team up front, even while on "Personal".
  const [teamVaultTabs, setTeamVaultTabs] = useState<TeamVaultStatus[]>([]);
  // Local, per-device "show as tab" preference (AppSettings.connectionManagerVisibleTeamVaults) —
  // missing entry defaults to visible (true), same as TeamVaultDetailPanel's toggle.
  const [visibleTeamVaults, setVisibleTeamVaults] = useState<Record<string, boolean>>({});
  // Discreet per-tab sync dot (§C/§D): which vaultIds are mid push/pull right now, driven by the
  // main-process TEAM_VAULT_SYNC_STATUS event (fired right before/after each background sync).
  const [syncingVaultIds, setSyncingVaultIds] = useState<Record<string, boolean>>({});
  // Reported by `TeamProfileTreeList` whenever its known vaults/payloads change — the only way
  // this modal can tell which team an open edit belongs to (for the secret-field gate and folder
  // suggestions below), since it no longer fetches payloads itself.
  const [teamVaultsMeta, setTeamVaultsMeta] = useState<TeamVaultMeta[]>([]);
  // `TeamProfileTreeList` owns the only live `unlocked` status per vault (it unlocks/locks them),
  // so when it reports metas here, also patch the tab row's own copy — otherwise the tab's lock
  // icon stays stale until the next `loadTeamVaultTabs()` poll (e.g. switching protocol tabs).
  const handleVaultsMetaChange = useCallback((metas: TeamVaultMeta[]) => {
    setTeamVaultsMeta(metas);
    setTeamVaultTabs((prev) =>
      prev.map((tab) => {
        const meta = metas.find((m) => m.vaultId === tab.vaultId);
        return meta && meta.unlocked !== tab.unlocked ? { ...tab, unlocked: meta.unlocked } : tab;
      })
    );
  }, []);
  // So a save made through the edit form (rendered here, not by TeamProfileTreeList) can refresh
  // that one vault's cached payload immediately — see TeamProfileTreeListHandle's doc comment.
  const teamProfileTreeListRef = useRef<TeamProfileTreeListHandle>(null);
  // Where each team's folder browser is, by `<tab>/<vaultId>`. Here rather than in TeamProfileTreeList, which
  // is unmounted while a profile is edited and would otherwise start at the root again afterwards.
  const [teamFolderPaths, setTeamFolderPaths] = useState<Record<string, string[]>>({});
  const handleTeamFolderPathChange = useCallback((key: string, path: string[]) => {
    setTeamFolderPaths((prev) => ({ ...prev, [key]: path }));
  }, []);

  const loadTeamVaultTabs = useCallback(async () => {
    try {
      const [statuses, settings] = await Promise.all([window.multissh.teamVaultList(), window.multissh.settingsGet()]);
      setTeamVaultTabs(statuses);
      setVisibleTeamVaults(settings.connectionManagerVisibleTeamVaults ?? {});
      return { statuses, defaultTab: settings.connectionManagerDefaultTab };
    } catch {
      // Best-effort — the tab row simply shows "Personal" only if this fails.
      return { statuses: [] as TeamVaultStatus[], defaultTab: undefined };
    }
  }, []);

  // Visible team tabs, in the order teamVaultList() returned them — a missing
  // visibleTeamVaults[vaultId] entry defaults to visible (true), same default as the toggle in
  // TeamVaultDetailPanel.
  const visibleTeamVaultTabs = useMemo(
    () => teamVaultTabs.filter((v) => v.vaultId && visibleTeamVaults[v.vaultId] !== false),
    [teamVaultTabs, visibleTeamVaults]
  );
  // Hoisted rather than calling .find() twice in the JSX below (the tab row's `source`-scoped
  // description line reads this same lookup twice: once to gate rendering, once for the text).
  const activeTeamVaultTab = useMemo(
    () => visibleTeamVaultTabs.find((v) => v.vaultId === source),
    [visibleTeamVaultTabs, source]
  );

  const handleSetDefaultTab = async (key: string) => {
    try {
      await window.multissh.settingsSave({ connectionManagerDefaultTab: key });
    } catch {
      // Non-critical preference — a failed save just means the old default sticks.
    }
  };

  // "Unlock all" (§12) — deliberately independent of whether a `TeamProfileTreeList` happens to
  // be mounted (it only mounts once a team tab is selected, or a search is active — see its own
  // mount condition below): calling straight through to `teamVaultUnlock` here means the button,
  // visible from the tab row in every view including Personal, always actually does something.
  // Same gate as the per-team quick "Unlock as <id>" button: only vaults with an already-known
  // identity are attempted.
  const [unlockingAllTeams, setUnlockingAllTeams] = useState(false);
  const handleUnlockAllTeams = async () => {
    const targets = visibleTeamVaultTabs.filter(
      (v) => !v.unlocked && v.vaultId && v.selfRecipientId && v.selfIdentityFilePath
    );
    setUnlockingAllTeams(true);
    // One at a time, not Promise.all: every unlock here needs a touch on the physical
    // smartcard, and firing them concurrently raced independent age-plugin-yubikey processes
    // against the same USB token — one touch could only satisfy one of them, the other failed
    // silently. The main process now also serializes this itself (TeamVaultCryptoService), but
    // staying sequential here keeps the touch prompts in a clear, predictable one-at-a-time order
    // instead of relying solely on that queue.
    const failed: string[] = [];
    for (const v of targets) {
      try {
        await window.multissh.teamVaultUnlock(v.vaultId!, v.selfRecipientId!, v.selfIdentityFilePath!);
        // TeamProfileTreeList owns its own independent per-vault status/payload cache (entries),
        // never refreshed just because a sibling-triggered unlock happened — without this, the
        // actual panel content for that team (not just this tab row's lock icon) stayed stale
        // until the component happened to unmount/remount (e.g. switching to Personal and back).
        // Same pattern this modal already uses after other cross-component mutations (the
        // edit-form save flow, below).
        await teamProfileTreeListRef.current?.refreshVault(v.vaultId!);
      } catch {
        failed.push(v.vaultName || v.vaultId!);
      }
    }
    await loadTeamVaultTabs();
    setUnlockingAllTeams(false);
    if (failed.length > 0) {
      setError(`Failed to unlock: ${failed.join(', ')}`);
    }
  };

  // Editing a team's description directly from its tab row — the same `teamVaultSetDescription`
  // call `TeamVaultDetailPanel` (Settings) makes, just reachable without leaving the Connection
  // Manager too. `editingTabDescription` holds the vaultId currently being edited (not a bool —
  // only one tab's editor is open at a time, and this doubles as "which tab" for the save call).
  const [editingTabDescription, setEditingTabDescription] = useState<string | null>(null);
  const [tabDescriptionDraft, setTabDescriptionDraft] = useState('');
  const [savingTabDescription, setSavingTabDescription] = useState(false);
  const [tabDescriptionError, setTabDescriptionError] = useState<string | null>(null);

  const handleSaveTabDescription = async (vaultId: string) => {
    setSavingTabDescription(true);
    setTabDescriptionError(null);
    try {
      await window.multissh.teamVaultSetDescription(vaultId, tabDescriptionDraft.trim());
      await loadTeamVaultTabs();
      setEditingTabDescription(null);
    } catch (err) {
      setTabDescriptionError(describeIpcError(err, 'Failed to save the description'));
    } finally {
      setSavingTabDescription(false);
    }
  };

  useEffect(() => {
    const unsubscribe = window.multissh.onTeamVaultSyncStatus?.(({ vaultId, syncing }) => {
      setSyncingVaultIds((prev) => ({ ...prev, [vaultId]: syncing }));
    });
    return () => unsubscribe?.();
  }, []);

  // A background auto-pull/remote-change also means the tab row's lock/role/description may be
  // stale — cheap enough to just refetch the whole tab list rather than patch one field.
  useEffect(() => {
    const unsubPulled = window.multissh.onTeamVaultAutoPulled?.(() => void loadTeamVaultTabs());
    const unsubChanged = window.multissh.onTeamVaultRemoteChanged?.(() => void loadTeamVaultTabs());
    return () => {
      unsubPulled?.();
      unsubChanged?.();
    };
  }, [loadTeamVaultTabs]);

  // Folder creation and rename
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');

  // Drag and drop target feedback
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);

  // Import / Export menu and modal
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [importCandidates, setImportCandidates] = useState<SSHConnectionConfig[] | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(new Set());
  const [importTargetFolder, setImportTargetFolder] = useState<string>('Imported');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const profiles = await window.multissh.profilesGet();
      setSshProfiles(profiles.ssh || []);
      setS3Profiles(profiles.s3 || []);
      setFolders(profiles.folders || []);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to load profiles'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setEditing(startNewProfile ? { type: initialTab } : null);
      setSearchQuery('');
      setNewFolderOpen(false);
      setRenamingFolder(null);
      setImportMenuOpen(false);
      setImportCandidates(null);
      // Synchronous reset to safe defaults the instant the modal opens — reopening on a
      // previously-selected team tab must not briefly flash that tab's stale content (and a
      // settingsGet()+teamVaultList() round trip isn't instant) before the async load below gets
      // a chance to correct it to the remembered default tab.
      setSource('personal');
      setTeamVaultTabs([]);
      void load();
      void loadTeamVaultTabs().then(({ statuses, defaultTab }) => {
        // Only honor a remembered default tab if it's still a real, visible team — otherwise
        // fall back to Personal rather than opening onto a team that no longer exists/unlocked
        // state this device has since forgotten.
        if (defaultTab && defaultTab !== 'personal' && statuses.some((s) => s.vaultId === defaultTab)) {
          setSource(defaultTab);
        } else {
          setSource('personal');
        }
      });
    }
  }, [open, initialTab, startNewProfile, load, loadTeamVaultTabs]);

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  // Team profiles skip the "lastUsedAt" write-back deliberately (see prepareConnect).
  // Rows may show a profile with its system's folder (for drawing only): connecting stamps and saves the stored one.
  const storedSSH = (profile: SSHConnectionConfig) => sshProfiles.find((p) => p.id === profile.id) ?? profile;
  const handleConnectSSH = async (profile: SSHConnectionConfig) => {
    onConnectSSH?.(await prepareConnect(storedSSH(profile), source, (p) => window.multissh.profilesSaveSSH(p)));
  };

  // UX audit finding #3: the quickstart card promised "a local shell, ad-hoc
  // SSH connection or WSL" but there was never actually a way to connect to
  // an SSH host without first saving it as a profile — "New Profile"'s only
  // action was "Save Profile". Typing "user@host" (or "user@host:port") into
  // the same search box used for filtering saved profiles now offers a
  // one-off connection, unsaved by default, with "Save as profile" alongside
  // it for anyone who decides afterwards that they want to keep it.
  const buildAdHocConfig = (): SSHConnectionConfig | null => {
    if (!adHocTarget) return null;
    return {
      id: crypto.randomUUID(),
      name: adHocTarget.username ? `${adHocTarget.username}@${adHocTarget.host}` : adHocTarget.host,
      host: adHocTarget.host,
      port: adHocTarget.port,
      username: adHocTarget.username || '',
      authType: 'password',
    };
  };

  const handleConnectAdHoc = () => {
    const config = buildAdHocConfig();
    if (!config) return;
    onConnectSSH?.(config);
  };

  const handleConnectAdHocSFTP = () => {
    const config = buildAdHocConfig();
    if (!config) return;
    onConnectSFTP?.(config);
  };

  const handleSaveAdHocAsProfile = () => {
    const config = buildAdHocConfig();
    if (!config) return;
    setEditing({ type: 'ssh', config });
  };

  const handleConnectS3 = async (profile: S3Config) => {
    onConnectS3?.(await prepareConnect(profile, source, (p) => window.multissh.profilesSaveS3(p)));
  };

  // Which team the open edit form's profile belongs to, if any — a NEW shared profile carries
  // this on `editing.teamVaultId` (set by `TeamProfileTreeList`'s per-vault "New Profile"
  // button, which has no profile object yet to tag); an EXISTING one already carries it on
  // `config.teamVaultProfileRef.vaultId` (every team profile `TeamProfileTreeList` renders is
  // pre-tagged with that ref). `undefined` means a personal profile.
  const editingTeamVaultId = editing?.teamVaultId ?? (editing?.config as { teamVaultProfileRef?: { vaultId: string } } | undefined)?.teamVaultProfileRef?.vaultId;

  const handleSaveSSH = async (config: SSHConnectionConfig) => {
    try {
      if (editingTeamVaultId) {
        await window.multissh.teamVaultSaveSSHProfile(editingTeamVaultId, config);
        await teamProfileTreeListRef.current?.refreshVault(editingTeamVaultId);
      } else {
        await window.multissh.profilesSaveSSH(config);
        await load();
      }
      setEditing(null);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to save profile'));
    }
  };

  const handleSaveS3 = async (config: S3Config) => {
    try {
      if (editingTeamVaultId) {
        await window.multissh.teamVaultSaveS3Profile(editingTeamVaultId, config);
        await teamProfileTreeListRef.current?.refreshVault(editingTeamVaultId);
      } else {
        await window.multissh.profilesSaveS3(config);
        await load();
      }
      setEditing(null);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to save profile'));
    }
  };

  // Personal-profile only — shared (Team Vault) profile delete/clone/save-via-drag-and-drop are
  // handled directly inside `TeamProfileTreeList`, which owns that per-vault state itself.
  const handleDeleteSSH = async (id: string, name: string) => {
    if (!(await confirm({ title: 'Delete profile', message: `Delete the SSH profile "${name}"?` }))) return;
    try {
      await window.multissh.profilesDeleteSSH(id);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete profile'));
    }
  };

  const handleDeleteS3 = async (id: string, name: string) => {
    if (!(await confirm({ title: 'Delete profile', message: `Delete the S3 profile "${name}"?` }))) return;
    try {
      await window.multissh.profilesDeleteS3(id);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete profile'));
    }
  };

  // Option A: Clone/Duplicate (personal only — see the comment above handleDeleteSSH)
  const handleCloneSSH = async (profile: SSHConnectionConfig) => {
    const clone: SSHConnectionConfig = {
      ...profile,
      id: crypto.randomUUID(),
      name: `${profile.name} (Copy)`,
    };
    delete clone.lastUsedAt;
    try {
      await window.multissh.profilesSaveSSH(clone);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to clone profile'));
    }
  };

  const handleCloneS3 = async (profile: S3Config) => {
    const clone: S3Config = {
      ...profile,
      id: crypto.randomUUID(),
      name: `${profile.name} (Copy)`,
    };
    delete clone.lastUsedAt;
    try {
      await window.multissh.profilesSaveS3(clone);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to clone profile'));
    }
  };

  // Folder management
  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;
    try {
      await window.multissh.profilesSaveFolder(trimmed);
      setNewFolderName('');
      setNewFolderOpen(false);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to create folder'));
    }
  };

  const handleCommitRenameFolder = async (oldName: string) => {
    const trimmed = renameFolderValue.trim();
    if (!trimmed || trimmed === oldName) {
      setRenamingFolder(null);
      return;
    }
    try {
      await window.multissh.profilesRenameFolder(oldName, trimmed);
      setRenamingFolder(null);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to rename folder'));
    }
  };

  const handleDeleteFolder = async (folderName: string) => {
    if (
      !(await confirm({
        title: 'Delete folder',
        message: `Delete folder "${folderName}"? Profiles inside will be moved to Ungrouped.`,
      }))
    ) {
      return;
    }
    try {
      await window.multissh.profilesDeleteFolder(folderName, false);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete folder'));
    }
  };

  // Drag and Drop
  const handleDropOnGroup = async (e: React.DragEvent, groupName: string) => {
    e.preventDefault();
    setDragOverGroup(null);
    try {
      const dataStr = e.dataTransfer.getData('text/plain');
      if (!dataStr) return;
      const data = JSON.parse(dataStr);
      const targetGroup = groupName === 'Ungrouped' ? undefined : groupName;

      if (data.type === 'ssh') {
        // A server in a system takes the whole system along.
        const changed = moveWithSystems(sshProfiles, new Set([data.id]), targetGroup);
        if (changed.length > 0) {
          await saveInOrder(changed, (p) => window.multissh.profilesSaveSSH(p), load, setError, 'Failed to move the profile');
        }
      } else if (data.type === 's3') {
        const profile = s3Profiles.find((p) => p.id === data.id);
        if (profile && profile.group !== targetGroup) {
          await window.multissh.profilesSaveS3({ ...profile, group: targetGroup });
          await load();
        }
      }
    } catch {
      // Ignore invalid drag-drop data
    }
  };

  const systemActions = createSystemActions({
    profiles: sshProfiles,
    save: (p: SSHConnectionConfig) => window.multissh.profilesSaveSSH(p),
    reload: load,
    onError: setError,
    confirm,
  });

  // Team Vault folder CRUD and drag-and-drop moves now live entirely inside
  // `TeamProfileTreeList`, which owns every unlocked vault's payload/folder state itself (and is
  // the only thing that knows which vaultId a given team folder action belongs to).

  const handleNewTeamProfile = (type: 'ssh' | 's3', vaultId: string) => {
    setEditing({ type, teamVaultId: vaultId });
  };

  // Option D: Import / Export
  const handleImportSshConfig = async () => {
    setImportMenuOpen(false);
    try {
      const result = await window.multissh.profilesImportSshConfig();
      if (!result.profiles || result.profiles.length === 0) {
        window.alert(`No Host entries found in ~/.ssh/config`);
        return;
      }
      setImportCandidates(result.profiles);
      setSelectedCandidateIds(new Set(result.profiles.map((p) => p.id)));
      setImportTargetFolder('Imported');
    } catch (err) {
      setError(describeIpcError(err, 'Failed to import ~/.ssh/config'));
    }
  };

  const handleConfirmImportCandidates = async () => {
    if (!importCandidates) return;
    const toImport = importCandidates.filter((p) => selectedCandidateIds.has(p.id));
    if (toImport.length === 0) {
      setImportCandidates(null);
      return;
    }

    try {
      const folder = importTargetFolder.trim() || undefined;
      if (folder) {
        await window.multissh.profilesSaveFolder(folder).catch(() => {});
      }
      for (const p of toImport) {
        await window.multissh.profilesSaveSSH({ ...p, group: folder });
      }
      setImportCandidates(null);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to save imported profiles'));
    }
  };

  const handleExportJson = async () => {
    setImportMenuOpen(false);
    try {
      const res = await window.multissh.profilesExportJson();
      if (res) {
        window.alert(`Successfully exported ${res.count} profiles to ${res.filePath}`);
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to export profiles'));
    }
  };

  const handleImportJson = async () => {
    setImportMenuOpen(false);
    try {
      const res = await window.multissh.profilesImportJson();
      if (res && res.count > 0) {
        await load();
        window.alert(`Successfully imported ${res.count} profiles!`);
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to import profiles'));
    }
  };

  const query = searchQuery.trim().toLowerCase();

  // Ad-hoc quick-connect and personal-only folders/import/export never apply in the Team view —
  // shared profiles have no concept of either in this round (§3).
  const adHocTarget = useMemo(
    () => (tab === 'ssh' && source === 'personal' ? parseAdHocTarget(searchQuery) : null),
    [tab, source, searchQuery]
  );

  const filteredSSH = useMemo(() => filterSshProfiles(sshProfiles, query), [sshProfiles, query]);
  const filteredS3 = useMemo(() => filterS3Profiles(s3Profiles, query), [s3Profiles, query]);

  // Which team the currently open edit form's profile belongs to (see `editingTeamVaultId`
  // above), looked up in the metadata `TeamProfileTreeList` reports — the only place that still
  // knows per-vault admin status and folder suggestions, since this modal no longer fetches any
  // vault's payload itself.
  const editingTeamMeta = useMemo(
    () => teamVaultsMeta.find((m) => m.vaultId === editingTeamVaultId),
    [teamVaultsMeta, editingTeamVaultId]
  );
  const isTeamAdmin = Boolean(editingTeamMeta?.isAdmin);
  const teamFolderSuggestions = editingTeamMeta?.folderSuggestions ?? [];
  const personalTagSuggestions = useMemo(() => collectTags([...sshProfiles, ...s3Profiles]), [sshProfiles, s3Profiles]);

  const allFolderNames = useMemo(
    () => collectFolderNames(folders, sshProfiles, s3Profiles),
    [folders, sshProfiles, s3Profiles]
  );
  const sshFolderNames = useMemo(
    () => folderNamesForTab('ssh', allFolderNames, sshProfiles, s3Profiles, shareFoldersAcrossTypes),
    [allFolderNames, sshProfiles, s3Profiles, shareFoldersAcrossTypes]
  );
  const s3FolderNames = useMemo(
    () => folderNamesForTab('s3', allFolderNames, sshProfiles, s3Profiles, shareFoldersAcrossTypes),
    [allFolderNames, sshProfiles, s3Profiles, shareFoldersAcrossTypes]
  );

  // A system lives in one folder: its servers are drawn there even if their own folder differs.
  // A system's folder comes from all of its servers, so align before the search narrows the list.
  const alignedSSH = useMemo(() => filterSshProfiles(alignSystemMembers(sshProfiles), query), [sshProfiles, query]);
  const groupedSSH = useMemo(() => groupProfiles(sshFolderNames, alignedSSH, query), [alignedSSH, sshFolderNames, query]);
  const groupedS3 = useMemo(() => groupProfiles(s3FolderNames, filteredS3, query), [filteredS3, s3FolderNames, query]);

  const bulk = usePersonalBulkEdit({
    tab,
    source,
    open,
    sshProfiles: filteredSSH,
    allSshProfiles: sshProfiles,
    s3Profiles: filteredS3,
    sshFolders: sshFolderNames,
    s3Folders: s3FolderNames,
    reload: load,
    onError: setError,
  });

  const renderSshProfile = (profile: SSHConnectionConfig) => (
    <SshProfileRow
      key={profile.id}
      profile={profile}
      onConnectSSH={onConnectSSH}
      onConnectSFTP={onConnectSFTP}
      handleConnectSSH={handleConnectSSH}
      handleCloneSSH={handleCloneSSH}
      handleDeleteSSH={handleDeleteSSH}
      setEditing={setEditing}
      setInstallKeyProfile={setInstallKeyProfile}
      setTunnelsProfile={setTunnelsProfile}
      select={bulk.ssh.rowSelect(profile.id)}
    />
  );

  // "N more results elsewhere" (§8): the search field only filters the active source
  // (Personal, or one team), so surface — without switching away — whatever else matches in
  // Personal and every other unlocked team, each one jump-to-able.
  const otherSourceMatches = useMemo(() => {
    if (!query || tab === 'k8s') return [];
    const results: { key: string; label: string; count: number }[] = [];
    if (source !== 'personal') {
      const personalCount = tab === 'ssh' ? filteredSSH.length : filteredS3.length;
      if (personalCount > 0) results.push({ key: 'personal', label: 'Personal', count: personalCount });
    }
    for (const meta of teamVaultsMeta) {
      if (meta.vaultId === source || meta.matchCount === 0) continue;
      results.push({ key: meta.vaultId, label: meta.vaultName || meta.vaultId, count: meta.matchCount });
    }
    return results;
  }, [query, tab, source, filteredSSH, filteredS3, teamVaultsMeta]);

  // Collapsed state of the "Recently Used" box, remembered per viewer (best effort).
  const [recentCollapsed, setRecentCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('connmgr.recentCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleRecent = useCallback(() => {
    setRecentCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('connmgr.recentCollapsed', next ? '1' : '0');
      } catch {
        /* storage unavailable: keep in-memory state only */
      }
      return next;
    });
  }, []);

  const recentSSH = useMemo(() => mostRecentlyUsed(sshProfiles), [sshProfiles]);
  const recentS3 = useMemo(() => mostRecentlyUsed(s3Profiles), [s3Profiles]);

  // M12 (code review): only enabled for the list view, not while a form is
  // being edited (`editing` set to a non-null value) — an accidental Escape
  // press or stray click while filling in a new SSH/S3 profile should not
  // silently discard it, since there's no unsaved-changes warning here.
  const handleBackdropClick = useModalDismiss(onClose, open, !editing);
  useModalDismiss(() => setImportCandidates(null), !!importCandidates);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Connection Manager" className="flex h-[85vh] max-h-[720px] w-full max-w-4xl flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden relative">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Connection Manager</h2>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex border-b border-divider bg-app-surface px-2 pt-2">
          {(
            [
              { key: 'ssh' as Tab, label: 'SSH / SFTP', icon: Server },
              { key: 's3' as Tab, label: 'S3 Object Storage', icon: Cloud },
              { key: 'k8s' as Tab, label: 'Kubernetes', icon: Boxes },
            ]
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key);
                setEditing(null);
                setImportMenuOpen(false);
              }}
              className={
                'flex items-center gap-1.5 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors ' +
                (tab === key
                  ? 'bg-app-card text-sky-400 border-t-2 border-sky-500 font-semibold'
                  : 'text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover')
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* Personal + one tab per team (§D of the join-flow plan) — a flat tab row, not a binary
            "Personal"/"Teams" toggle: each visible, unlocked-or-not team gets its own tab next to
            Personal, with a discreet sync dot and a hover "pin as default" action. Hidden for
            Kubernetes, which has no concept of either. */}
        {tab !== 'k8s' && !editing && visibleTeamVaultTabs.length > 0 && (
          <div className="border-b border-divider bg-app-surface px-4 py-2">
            <div className="flex items-center gap-1.5">
              {[
                { key: 'personal', label: 'Personal', vault: null as TeamVaultStatus | null },
                ...visibleTeamVaultTabs.map((v) => ({ key: v.vaultId!, label: v.vaultName || v.vaultId!, vault: v })),
              ].map(({ key, label, vault }) => (
                <div key={key} className="group relative">
                  <button
                    type="button"
                    onClick={() => setSource(key)}
                    title={vault?.vaultDescription || undefined}
                    className={
                      'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ' +
                      (source === key
                        ? 'bg-sky-600 text-white shadow-sm'
                        : 'text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary')
                    }
                  >
                    {vault ? (
                      vault.unlocked ? (
                        <Unlock className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <Lock className="h-3.5 w-3.5 text-amber-400" />
                      )
                    ) : (
                      <Server className="h-3.5 w-3.5" />
                    )}
                    {label}
                    {vault && (
                      <span
                        title={syncingVaultIds[vault.vaultId!] ? 'Syncing now' : vault.lastSyncAt ? `Last synced ${formatDateTime(vault.lastSyncAt)}` : 'Not synced yet'}
                        className={
                          'h-1.5 w-1.5 rounded-full ' +
                          (syncingVaultIds[vault.vaultId!] ? 'animate-pulse bg-emerald-400' : 'bg-txt-muted/40')
                        }
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSetDefaultTab(key)}
                    title="Set as default tab"
                    // Opacity-based reveal, not `hidden`/`display:none` — per CLAUDE.md's
                    // keyboard-first mandate, this button must stay in the tab order and
                    // reachable via Tab even when the pointer never hovers it. `focus-visible`
                    // (not just `focus`) also reveals it, so a sighted keyboard user tabbing
                    // through sees it appear instead of invisibly activating a mystery control.
                    className="absolute -right-1 -top-1 rounded bg-app-surface p-0.5 text-txt-muted opacity-0 outline-none transition-opacity hover:text-sky-400 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-sky-500 group-hover:opacity-100"
                  >
                    <Pin className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
              {visibleTeamVaultTabs.filter((v) => !v.unlocked).length > 1 && (
                <button
                  type="button"
                  onClick={() => void handleUnlockAllTeams()}
                  disabled={unlockingAllTeams}
                  title="Unlock every team that already has a saved identity"
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
                >
                  <Unlock className="h-3.5 w-3.5" />
                  Unlock all
                </button>
              )}
            </div>
            {source !== 'personal' && activeTeamVaultTab && (
              <div className="mt-1.5">
                {editingTabDescription === activeTeamVaultTab.vaultId ? (
                  <div className="flex items-start gap-1.5">
                    <textarea
                      autoFocus
                      value={tabDescriptionDraft}
                      onChange={(e) => setTabDescriptionDraft(e.target.value)}
                      maxLength={500}
                      rows={2}
                      placeholder="What is this team for? (shown to every member here)"
                      className="min-w-0 flex-1 rounded border border-border-subtle bg-app-input px-1.5 py-0.5 text-2xs text-txt-primary outline-none focus:border-sky-500"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveTabDescription(activeTeamVaultTab.vaultId!)}
                      disabled={savingTabDescription}
                      className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                      title="Save"
                    >
                      {savingTabDescription ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                    </button>
                    <button
                      aria-label="Cancel"
                      type="button"
                      onClick={() => setEditingTabDescription(null)}
                      disabled={savingTabDescription}
                      className="text-txt-muted hover:text-txt-secondary disabled:opacity-50"
                      title="Cancel"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  (activeTeamVaultTab.vaultDescription || activeTeamVaultTab.selfRole === 'admin') && (
                    <div className="flex items-start gap-1.5">
                      <p className="max-h-16 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap text-2xs text-txt-muted">
                        {activeTeamVaultTab.vaultDescription || 'No description yet.'}
                      </p>
                      {activeTeamVaultTab.selfRole === 'admin' && (
                        <button
                          aria-label="Edit description"
                          type="button"
                          onClick={() => {
                            setTabDescriptionDraft(activeTeamVaultTab.vaultDescription ?? '');
                            setTabDescriptionError(null);
                            setEditingTabDescription(activeTeamVaultTab.vaultId!);
                          }}
                          className="shrink-0 text-txt-muted hover:text-txt-secondary"
                          title="Edit description"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )
                )}
                {editingTabDescription === activeTeamVaultTab.vaultId && tabDescriptionError && (
                  <p className="mt-1 text-2xs text-red-400">{tabDescriptionError}</p>
                )}
              </div>
            )}
          </div>
        )}

        <div
          className={
            editing
              ? 'flex flex-1 min-h-0 flex-col overflow-hidden'
              : 'flex-1 overflow-y-auto p-4'
          }
        >
          {error && !editing && (
            <div role="alert" className="mb-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {editing ? (
            <>
              {error && (
                <div role="alert" className="mx-4 mt-4 shrink-0 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                  {error}
                </div>
              )}
              {editing.type === 'ssh' ? (
                <SSHProfileForm
                  initial={editing.config as SSHConnectionConfig | undefined}
                  onSave={handleSaveSSH}
                  onCancel={() => setEditing(null)}
                  dotfilesPoolEnabled={dotfilesPoolEnabled}
                  folderSuggestions={editingTeamVaultId ? teamFolderSuggestions : undefined}
                  tagSuggestions={editingTeamVaultId ? undefined : personalTagSuggestions}
                  systemSuggestions={editingTeamVaultId ? editingTeamMeta?.systemSuggestions : systemNames(sshProfiles)}
                  canEditSecret={!editingTeamVaultId || isTeamAdmin}
                />
              ) : (
                <S3ProfileForm
                  initial={editing.config as S3Config | undefined}
                  onSave={handleSaveS3}
                  onCancel={() => setEditing(null)}
                  folderSuggestions={editingTeamVaultId ? teamFolderSuggestions : undefined}
                  tagSuggestions={editingTeamVaultId ? undefined : personalTagSuggestions}
                  canEditSecret={!editingTeamVaultId || isTeamAdmin}
                />
              )}
            </>
          ) : (
            <>
              {tab !== 'k8s' && (
                <div className="mb-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    {!(source !== 'personal' && activeTeamVaultTab && !activeTeamVaultTab.unlocked) && (
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-txt-muted" />
                      <input
                        type="text"
                        data-autofocus
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          // The "single match -> connect" shortcut only applies to Personal:
                          // Team matches can now span several unlocked teams at once
                          // (TeamProfileTreeList), so "exactly one match" isn't well-defined
                          // across all of them the way it is for a single personal list.
                          if (e.key === 'Enter' && source === 'personal') {
                            if (adHocTarget && onConnectSSH) {
                              e.preventDefault();
                              handleConnectAdHoc();
                            } else if (tab === 'ssh' && filteredSSH.length === 1 && onConnectSSH) {
                              e.preventDefault();
                              void handleConnectSSH(filteredSSH[0]);
                            } else if (tab === 's3' && filteredS3.length === 1 && onConnectS3) {
                              e.preventDefault();
                              void handleConnectS3(filteredS3[0]);
                            }
                          }
                        }}
                        placeholder={
                          tab === 'ssh'
                            ? 'Search profiles, or type user@host to connect...'
                            : 'Search profiles or folders...'
                        }
                        className="w-full rounded-lg border border-border-subtle bg-app-input py-1.5 pl-8 pr-3 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                      />
                    </div>
                    )}

                    {source === 'personal' && (
                      <button
                        type="button"
                        onClick={() => setEditing({ type: tab })}
                        className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shrink-0 shadow-sm transition-colors"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        New Profile
                      </button>
                    )}

                    {source === 'personal' && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setNewFolderOpen(true);
                            setNewFolderName('');
                          }}
                          title="Create Folder"
                          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary shrink-0 transition-colors"
                        >
                          <FolderPlus className="h-3.5 w-3.5 text-amber-400" />
                          Folder
                        </button>

                        {/* Import / Export Menu */}
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => setImportMenuOpen((prev) => !prev)}
                            title="Import and Export Profiles"
                            className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface px-2 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary shrink-0 transition-colors"
                          >
                            <Download className="h-3.5 w-3.5 text-sky-400" />
                            <span className="text-xs">Sync</span>
                          </button>

                          {importMenuOpen && (
                            <div className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-border-subtle bg-app-card py-1 shadow-xl text-xs">
                              {tab === 'ssh' && (
                                <button
                                  type="button"
                                  onClick={() => void handleImportSshConfig()}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
                                >
                                  <Upload className="h-3.5 w-3.5 text-sky-400" />
                                  <span>Import ~/.ssh/config</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void handleExportJson()}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
                              >
                                <Download className="h-3.5 w-3.5 text-emerald-400" />
                                <span>Export JSON Backup</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleImportJson()}
                                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary"
                              >
                                <Upload className="h-3.5 w-3.5 text-amber-400" />
                                <span>Import JSON Backup</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {otherSourceMatches.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 text-2xs text-txt-muted">
                      <span>Also matches:</span>
                      {otherSourceMatches.map((m) => (
                        <button
                          key={m.key}
                          type="button"
                          onClick={() => setSource(m.key)}
                          className="rounded border border-border-subtle bg-app-surface px-2 py-0.5 text-txt-secondary hover:border-sky-500/40 hover:text-sky-400 transition-colors"
                        >
                          {m.label} ({m.count})
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Inline New Folder Input */}
                  {source === 'personal' && newFolderOpen && (
                    <div className="flex items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-950/20 p-2 animate-in fade-in duration-100">
                      <FolderPlus className="h-4 w-4 text-sky-400 shrink-0" />
                      <input
                        aria-label="Folder name"
                        type="text"
                        autoFocus
                        placeholder="Folder name..."
                        value={newFolderName}
                        onChange={(e) => setNewFolderName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleCreateFolder();
                          if (e.key === 'Escape') {
                            // Stop this local Escape from also bubbling up to
                            // the modal's own window-level Escape-to-close
                            // handler (M12) — it should only cancel the
                            // rename here, not close the whole dialog.
                            e.stopPropagation();
                            setNewFolderOpen(false);
                          }
                        }}
                        className="flex-1 rounded border border-border-subtle bg-app-input px-2 py-1 text-xs text-txt-primary outline-none focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={() => void handleCreateFolder()}
                        disabled={!newFolderName.trim()}
                        className="rounded bg-sky-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                      >
                        Create
                      </button>
                      <button
                        aria-label="Close"
                        title="Close"
                        type="button"
                        onClick={() => {
                          setNewFolderOpen(false);
                          setNewFolderName('');
                        }}
                        className="rounded p-1 text-txt-muted hover:text-txt-primary"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {source === 'personal' && (tab === 'ssh' || tab === 's3') && (
                <div className="mb-3">
                  <BulkActionBar {...bulk.barProps} />
                </div>
              )}

              {tab === 'k8s' && (
                <K8sConnectionTree
                  enableOpenShift={enableOpenShift}
                  onExec={onConnectK8s}
                  onViewLogs={
                    onViewK8sLogs
                      ? (target) => {
                          onViewK8sLogs(target);
                          onClose();
                        }
                      : undefined
                  }
                  onBrowseFiles={
                    onBrowseK8sFiles
                      ? (target) => {
                          onBrowseK8sFiles(target);
                          onClose();
                        }
                      : undefined
                  }
                />
              )}

              {loading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-txt-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading profiles...
                </div>
              )}

              {!loading && tab === 'ssh' && source === 'personal' && (
                <div className="space-y-4">
                  {/* Ad-hoc quick connect: "user@host" typed into search */}
                  {adHocTarget && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-txt-primary">
                            Connect to {adHocTarget.username}@{adHocTarget.host}
                            {adHocTarget.port ? `:${adHocTarget.port}` : ''}
                          </div>
                          <div className="text-xs text-txt-muted">
                            One-off connection — nothing is saved unless you choose to
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {onConnectSSH && (
                            <button
                              type="button"
                              onClick={handleConnectAdHoc}
                              className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
                            >
                              Connect
                            </button>
                          )}
                          {onConnectSFTP && (
                            <button
                              type="button"
                              title="Open SFTP in Dual-Pane File Manager"
                              onClick={handleConnectAdHocSFTP}
                              className="flex items-center gap-1 rounded-lg bg-sky-700/80 hover:bg-sky-600 px-2 py-1 text-xs font-medium text-white shadow-sm transition-colors"
                            >
                              <Files className="h-3 w-3" />
                              SFTP
                            </button>
                          )}
                          <button
                            type="button"
                            title="Save as a profile instead of connecting once"
                            onClick={handleSaveAdHocAsProfile}
                            className="rounded-lg border border-border-subtle px-2 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                          >
                            Save as profile
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Recently Used SSH Profiles */}
                  {!query && recentSSH.length > 0 && (
                    <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-2">
                      <button
                        type="button"
                        onClick={toggleRecent}
                        aria-expanded={!recentCollapsed}
                        className={`flex w-full items-center gap-1.5 text-xs font-semibold text-sky-400 ${recentCollapsed ? '' : 'mb-2'}`}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <span>Recently Used</span>
                        {recentCollapsed ? <ChevronRight className="ml-auto h-3.5 w-3.5" /> : <ChevronDown className="ml-auto h-3.5 w-3.5" />}
                      </button>
                      <div className={recentCollapsed ? 'hidden' : 'flex flex-col gap-1.5'}>
                        {recentSSH.map((profile) => (
                          <SshRecentRow
                            key={`recent-${profile.id}`}
                            profile={profile}
                            onConnectSSH={onConnectSSH}
                            onConnectSFTP={onConnectSFTP}
                            handleConnectSSH={handleConnectSSH}
                            handleCloneSSH={handleCloneSSH}
                            handleDeleteSSH={handleDeleteSSH}
                            setEditing={setEditing}
                            setInstallKeyProfile={setInstallKeyProfile}
                            setTunnelsProfile={setTunnelsProfile}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Grouped SSH Profiles with Drag & Drop */}
                  {filteredSSH.length === 0 && sshFolderNames.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-6 text-center">
                      <p className="text-sm text-txt-muted">
                        {query ? 'No profiles matched your search' : 'No SSH profiles yet'}
                      </p>
                      {!query && (
                        <button
                          type="button"
                          onClick={() => setEditing({ type: tab })}
                          className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          New Profile
                        </button>
                      )}
                    </div>
                  ) : (
                    groupedSSH.map(([groupName, profiles]) => {
                      const isCollapsed = Boolean(collapsedGroups[`ssh-${groupName}`]);
                      const isDragOver = dragOverGroup === groupName;
                      return (
                        <div key={`group-${groupName}`} className="space-y-1.5">
                          {/* Folder Header */}
                          <ProfileFolderHeader
                            groupName={groupName}
                            profileCount={profiles.length}
                            isCollapsed={isCollapsed}
                            isDragOver={isDragOver}
                            dragOverGroup={dragOverGroup}
                            setDragOverGroup={setDragOverGroup}
                            renamingFolder={renamingFolder}
                            setRenamingFolder={setRenamingFolder}
                            renameFolderValue={renameFolderValue}
                            setRenameFolderValue={setRenameFolderValue}
                            onToggle={() => toggleGroup(`ssh-${groupName}`)}
                            onDrop={(e) => void handleDropOnGroup(e, groupName)}
                            onCommitRename={handleCommitRenameFolder}
                            onDeleteFolder={handleDeleteFolder}
                          />

                          {/* Folder Content / Cards */}
                          {!isCollapsed && (
                            <div className="flex flex-col gap-1.5 px-2">
                              {profiles.length === 0 ? (
                                <EmptyFolderDropZone
                                  groupName={groupName}
                                  isDragOver={isDragOver}
                                  dragOverGroup={dragOverGroup}
                                  setDragOverGroup={setDragOverGroup}
                                  onDrop={(e) => void handleDropOnGroup(e, groupName)}
                                />
                              ) : (
                                <SystemAwareRows
                                  profiles={profiles}
                                  source={source}
                                  renderProfile={renderSshProfile}
                                  onConnectSystem={
                                    onConnectSystem &&
                                    // All of the system, not only the servers a search leaves in the list.
                                    ((members, src) => onConnectSystem(systemMembersOf(sshProfiles, systemNameOf(members[0]) ?? ''), src))
                                  }
                                  collapsed={collapsedGroups}
                                  onToggle={toggleGroup}
                                  onRenameSystem={(members, name) => void systemActions.rename(members, name)}
                                  onUngroupSystem={(members) => void systemActions.ungroup(members)}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {tab === 'ssh' && (source !== 'personal' || query) && (
                // Mounted while on Personal too, but only once there's a query (§8):
                // activeVaultId="personal" matches no real vaultId, so this renders nothing
                // visible either way — but mounting it unconditionally would fetch every
                // unlocked team's payload just for browsing Personal with nothing typed, which
                // defeats the lazy-fetch design TeamProfileTreeList otherwise relies on (see its
                // own doc comment). Gating on `query` limits that eager fetch to exactly the
                // moment the "N more results elsewhere" notice below actually needs the data.
                <TeamProfileTreeList
                  ref={teamProfileTreeListRef}
                  folderPaths={teamFolderPaths}
                  onFolderPathChange={handleTeamFolderPathChange}
                  tab="ssh"
                  query={query}
                  activeVaultId={source}
                  onConnectSSH={onConnectSSH}
                  onConnectSFTP={onConnectSFTP}
                  onConnectSystem={onConnectSystem}
                  setEditing={setEditing}
                  onNewProfile={handleNewTeamProfile}
                  onVaultsMetaChange={handleVaultsMetaChange}
                />
              )}

              {!loading && tab === 's3' && source === 'personal' && (
                <div className="space-y-4">
                  {/* Recently Used S3 Profiles */}
                  {!query && recentS3.length > 0 && (
                    <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-2">
                      <button
                        type="button"
                        onClick={toggleRecent}
                        aria-expanded={!recentCollapsed}
                        className={`flex w-full items-center gap-1.5 text-xs font-semibold text-amber-400 ${recentCollapsed ? '' : 'mb-2'}`}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        <span>Recently Used</span>
                        {recentCollapsed ? <ChevronRight className="ml-auto h-3.5 w-3.5" /> : <ChevronDown className="ml-auto h-3.5 w-3.5" />}
                      </button>
                      <div className={recentCollapsed ? 'hidden' : 'flex flex-col gap-1.5'}>
                        {recentS3.map((profile) => (
                          <S3RecentRow
                            key={`recent-s3-${profile.id}`}
                            profile={profile}
                            onConnectS3={onConnectS3}
                            handleConnectS3={handleConnectS3}
                            handleCloneS3={handleCloneS3}
                            handleDeleteS3={handleDeleteS3}
                            setEditing={setEditing}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Grouped S3 Profiles with Drag & Drop */}
                  {filteredS3.length === 0 && s3FolderNames.length === 0 ? (
                    <div className="flex flex-col items-center gap-3 py-6 text-center">
                      <p className="text-sm text-txt-muted">
                        {query ? 'No profiles matched your search' : 'No S3 profiles yet'}
                      </p>
                      {!query && (
                        <button
                          type="button"
                          onClick={() => setEditing({ type: tab })}
                          className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          New Profile
                        </button>
                      )}
                    </div>
                  ) : (
                    groupedS3.map(([groupName, profiles]) => {
                      const isCollapsed = Boolean(collapsedGroups[`s3-${groupName}`]);
                      const isDragOver = dragOverGroup === groupName;
                      return (
                        <div key={`group-s3-${groupName}`} className="space-y-1.5">
                          {/* Folder Header */}
                          <ProfileFolderHeader
                            groupName={groupName}
                            profileCount={profiles.length}
                            isCollapsed={isCollapsed}
                            isDragOver={isDragOver}
                            dragOverGroup={dragOverGroup}
                            setDragOverGroup={setDragOverGroup}
                            renamingFolder={renamingFolder}
                            setRenamingFolder={setRenamingFolder}
                            renameFolderValue={renameFolderValue}
                            setRenameFolderValue={setRenameFolderValue}
                            onToggle={() => toggleGroup(`s3-${groupName}`)}
                            onDrop={(e) => void handleDropOnGroup(e, groupName)}
                            onCommitRename={handleCommitRenameFolder}
                            onDeleteFolder={handleDeleteFolder}
                          />

                          {!isCollapsed && (
                            <div className="flex flex-col gap-1.5 px-2">
                              {profiles.length === 0 ? (
                                <EmptyFolderDropZone
                                  groupName={groupName}
                                  isDragOver={isDragOver}
                                  dragOverGroup={dragOverGroup}
                                  setDragOverGroup={setDragOverGroup}
                                  onDrop={(e) => void handleDropOnGroup(e, groupName)}
                                />
                              ) : (
                                profiles.map((profile) => (
                                  <S3ProfileRow
                                    key={profile.id}
                                    profile={profile}
                                    onConnectS3={onConnectS3}
                                    handleConnectS3={handleConnectS3}
                                    handleCloneS3={handleCloneS3}
                                    handleDeleteS3={handleDeleteS3}
                                    setEditing={setEditing}
                                    select={bulk.s3.rowSelect(profile.id)}
                                  />
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {tab === 's3' && (source !== 'personal' || query) && (
                // See the "ssh" mount above for why this is gated on `query` while on Personal.
                <TeamProfileTreeList
                  ref={teamProfileTreeListRef}
                  folderPaths={teamFolderPaths}
                  onFolderPathChange={handleTeamFolderPathChange}
                  tab="s3"
                  query={query}
                  activeVaultId={source}
                  onConnectS3={onConnectS3}
                  setEditing={setEditing}
                  onNewProfile={handleNewTeamProfile}
                  onVaultsMetaChange={handleVaultsMetaChange}
                />
              )}
            </>
          )}
        </div>

        {/* SSH Config Import Candidates Preview Modal */}
        {importCandidates && (
          <ImportCandidatesModal
            importCandidates={importCandidates}
            importTargetFolder={importTargetFolder}
            setImportTargetFolder={setImportTargetFolder}
            selectedCandidateIds={selectedCandidateIds}
            setSelectedCandidateIds={setSelectedCandidateIds}
            onClose={() => setImportCandidates(null)}
            onConfirm={handleConfirmImportCandidates}
          />
        )}
      </div>
    </div>
    {installKeyProfile && (
      <InstallKeyModal connection={installKeyProfile} onClose={() => setInstallKeyProfile(null)} />
    )}
    {tunnelsProfile && (
      <SSHTunnelsModal
        connection={tunnelsProfile}
        open={true}
        onClose={() => setTunnelsProfile(null)}
        onProfileUpdated={(updated) => {
          setSshProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          setTunnelsProfile(updated);
        }}
      />
    )}
    </>
  );
};

export default ConnectionManagerModal;
