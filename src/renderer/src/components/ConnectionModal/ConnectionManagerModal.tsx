import React, { useCallback, useEffect, useState, useMemo } from 'react';
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Clock,
  Cloud,
  CloudDownload,
  Download,
  Files,
  FolderPlus,
  Loader2,
  Lock,
  Plus,
  Search,
  Server,
  Unlock,
  Upload,
  Users,
  X,
} from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import type { TeamVaultPayload, TeamVaultStatus } from '@shared/types/teamVault';
import { SSHProfileForm } from './SSHProfileForm';
import { S3ProfileForm } from './S3ProfileForm';
import { K8sConnectionTree } from './K8sConnectionTree';
import type { Tab, EditingState } from './types';
import { SshProfileRow, SshRecentRow } from './SshProfileRows';
import { S3ProfileRow, S3RecentRow } from './S3ProfileRows';
import { TeamSshProfileRow, TeamS3ProfileRow } from './TeamProfileRows';
import { TeamProfileTree } from './TeamProfileTree';
import { buildTeamFolderTree, collectTeamFolderSuggestions } from './teamProfileTreeModel';
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
import { useModalDismiss } from '../../lib/useModalDismiss';
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

  // Personal / Team source toggle (connection-manager-plan: two separate views, not a merged
  // list with a badge — Team profiles live in the Team Vault's encryptedPayload, never in
  // profiles.json, and are only visible while the vault is unlocked).
  const [source, setSource] = useState<'personal' | 'team'>('personal');
  const [teamPayload, setTeamPayload] = useState<TeamVaultPayload | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamNotice, setTeamNotice] = useState<'auto-pulled' | 'remote-changed' | null>(null);
  // Inline unlock, so getting to shared profiles doesn't require a detour through Settings >
  // Team Vault — same "Unlock as X" / manual-fallback pattern TeamVaultSettingsPanel already uses.
  const [teamStatus, setTeamStatus] = useState<TeamVaultStatus | null>(null);
  // Breadcrumb position in the Team Vault folder card browser (TeamProfileTree) — lifted here so
  // it survives re-renders and resets alongside the rest of the modal's navigation state below.
  const [teamFolderPath, setTeamFolderPath] = useState<string[]>([]);
  const [unlockRecipientId, setUnlockRecipientId] = useState('');
  const [unlockIdentityPath, setUnlockIdentityPath] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [showManualUnlock, setShowManualUnlock] = useState(false);

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

  // Best-effort: null means "locked / no vault / failed to read" — the Team view shows an
  // unlock prompt rather than an error for any of those, same as TeamVaultSettingsPanel's own
  // best-effort reads elsewhere.
  const loadTeam = useCallback(async () => {
    setTeamLoading(true);
    try {
      const status = await window.multissh.teamVaultGetStatus();
      setTeamStatus(status);
      // Prefill only an empty field — never clobbers something the user already typed this
      // session (e.g. unlocking as a different member than the one remembered).
      setUnlockRecipientId((prev) => prev || status.selfRecipientId || '');
      setUnlockIdentityPath((prev) => prev || status.selfIdentityFilePath || '');
      setTeamPayload(await window.multissh.teamVaultGetPayload());
    } catch {
      setTeamStatus(null);
      setTeamPayload(null);
    } finally {
      setTeamLoading(false);
    }
  }, []);

  const handleTeamUnlock = async () => {
    if (!unlockRecipientId.trim() || !unlockIdentityPath.trim()) return;
    setUnlocking(true);
    setError(null);
    try {
      await window.multissh.teamVaultUnlock(unlockRecipientId.trim(), unlockIdentityPath.trim());
      await loadTeam();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to unlock the Team Vault'));
    } finally {
      setUnlocking(false);
    }
  };

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setSource('personal');
      setEditing(startNewProfile ? { type: initialTab } : null);
      setSearchQuery('');
      setNewFolderOpen(false);
      setRenamingFolder(null);
      setTeamFolderPath([]);
      setImportMenuOpen(false);
      setImportCandidates(null);
      setTeamNotice(null);
      setShowManualUnlock(false);
      void load();
      void loadTeam();
    }
  }, [open, initialTab, startNewProfile, load, loadTeam]);

  // Background auto-poll (IpcBridge.runTeamVaultAutoPoll) pushes these while the modal is open —
  // refresh the Team view so an edit from another member shows up without a manual reopen.
  useEffect(() => {
    if (!open) return;
    const unsubscribePulled = window.multissh.onTeamVaultAutoPulled?.(() => {
      setTeamNotice('auto-pulled');
      void loadTeam();
    });
    const unsubscribeChanged = window.multissh.onTeamVaultRemoteChanged?.(() => {
      setTeamNotice('remote-changed');
    });
    return () => {
      unsubscribePulled?.();
      unsubscribeChanged?.();
    };
  }, [open, loadTeam]);

  const toggleGroup = (groupKey: string) => {
    setCollapsedGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };

  const handleConnectSSH = async (profile: SSHConnectionConfig) => {
    // Team profiles skip the "lastUsedAt" touch write-back deliberately: bumping it would bump
    // the vault's revision (every mutating write does — see TeamVaultService.persistPayload),
    // which every other member's background poll would then pick up as "something changed" for
    // what's really just a per-viewer stat nobody else needs to see.
    if (source === 'team') {
      onConnectSSH?.(profile);
      return;
    }
    const updated = { ...profile, lastUsedAt: formatDateTime(new Date()) };
    try {
      await window.multissh.profilesSaveSSH(updated);
    } catch {
      // Safe to proceed even if touch fails
    }
    onConnectSSH?.(updated);
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
    if (source === 'team') {
      onConnectS3?.(profile);
      return;
    }
    const updated = { ...profile, lastUsedAt: formatDateTime(new Date()) };
    try {
      await window.multissh.profilesSaveS3(updated);
    } catch {
      // Safe to proceed even if touch fails
    }
    onConnectS3?.(updated);
  };

  const handleSaveSSH = async (config: SSHConnectionConfig) => {
    try {
      if (source === 'team') {
        await window.multissh.teamVaultSaveSSHProfile(config);
        await loadTeam();
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
      if (source === 'team') {
        await window.multissh.teamVaultSaveS3Profile(config);
        await loadTeam();
      } else {
        await window.multissh.profilesSaveS3(config);
        await load();
      }
      setEditing(null);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to save profile'));
    }
  };

  const handleDeleteSSH = async (id: string, name: string) => {
    if (!(await confirm({ title: 'Delete connection', message: `Delete the SSH connection "${name}"?` }))) return;
    try {
      if (source === 'team') {
        await window.multissh.teamVaultDeleteSSHProfile(id);
        await loadTeam();
      } else {
        await window.multissh.profilesDeleteSSH(id);
        await load();
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete profile'));
    }
  };

  const handleDeleteS3 = async (id: string, name: string) => {
    if (!(await confirm({ title: 'Delete connection', message: `Delete the S3 connection "${name}"?` }))) return;
    try {
      if (source === 'team') {
        await window.multissh.teamVaultDeleteS3Profile(id);
        await loadTeam();
      } else {
        await window.multissh.profilesDeleteS3(id);
        await load();
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete profile'));
    }
  };

  // Option A: Clone/Duplicate
  const handleCloneSSH = async (profile: SSHConnectionConfig) => {
    const clone: SSHConnectionConfig = {
      ...profile,
      id: crypto.randomUUID(),
      name: `${profile.name} (Copy)`,
    };
    delete clone.lastUsedAt;
    try {
      if (source === 'team') {
        await window.multissh.teamVaultSaveSSHProfile(clone);
        await loadTeam();
      } else {
        await window.multissh.profilesSaveSSH(clone);
        await load();
      }
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
      if (source === 'team') {
        await window.multissh.teamVaultSaveS3Profile(clone);
        await loadTeam();
      } else {
        await window.multissh.profilesSaveS3(clone);
        await load();
      }
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
        const profile = sshProfiles.find((p) => p.id === data.id);
        if (profile && profile.group !== targetGroup) {
          await window.multissh.profilesSaveSSH({ ...profile, group: targetGroup });
          await load();
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

  // Team Vault folder tree (arbitrary depth, shared via TeamVaultPayload.folders — see
  // teamProfileTree.ts) — separate handlers from the personal, flat folder ones above, since
  // Team Vault folders are synced state (teamVaultSaveFolder/etc, re-fetched via loadTeam()),
  // never the local profileStore.
  const handleCreateTeamFolder = async (fullPath: string) => {
    try {
      await window.multissh.teamVaultSaveFolder(fullPath);
      await loadTeam();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to create folder'));
    }
  };

  const handleRenameTeamFolder = async (oldPath: string, newPath: string) => {
    try {
      await window.multissh.teamVaultRenameFolder(oldPath, newPath);
      await loadTeam();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to rename folder'));
    }
  };

  const handleDeleteTeamFolder = async (path: string) => {
    if (
      !(await confirm({
        title: 'Delete folder',
        message: `Delete folder "${path}"? Profiles inside (including any subfolders) will be moved to Ungrouped.`,
      }))
    ) {
      return;
    }
    try {
      await window.multissh.teamVaultDeleteFolder(path, false);
      await loadTeam();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete folder'));
    }
  };

  const handleSetTeamFolderIcon = async (path: string, icon: string | undefined) => {
    try {
      await window.multissh.teamVaultSetFolderIcon(path, icon);
      await loadTeam();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to set folder icon'));
    }
  };

  const handleDropOnTeamFolder = async (
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
      if (kind === 'ssh') {
        const profile = teamPayload?.ssh.find((p) => p.id === data.id);
        if (profile && profile.group !== targetPath) {
          await window.multissh.teamVaultSaveSSHProfile({ ...profile, group: targetPath });
          await loadTeam();
        }
      } else {
        const profile = teamPayload?.s3.find((p) => p.id === data.id);
        if (profile && profile.group !== targetPath) {
          await window.multissh.teamVaultSaveS3Profile({ ...profile, group: targetPath });
          await loadTeam();
        }
      }
    } catch {
      // Ignore invalid drag-drop data
    }
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

  // Whether the current unlocked identity holds the 'admin' role for this vault — same check as
  // TeamVaultSettingsPanel's isAdmin. Gates whether the password/secret field of a shared profile
  // is editable/visible in the form below (TeamVaultService enforces the same rule server-side;
  // this only drives the UI).
  const isTeamAdmin = useMemo(
    () => Boolean(teamStatus?.members?.some((m) => m.recipientId === teamStatus.selfRecipientId && m.role === 'admin')),
    [teamStatus]
  );

  // Tags each shared profile with a reference main can use to resolve the real secret itself on
  // connect (TeamVaultService.resolveProfileForConnect) — see SSHConnectionConfig.teamVaultProfileRef.
  const teamSshWithRef = useMemo(
    () =>
      teamStatus?.vaultId
        ? (teamPayload?.ssh ?? []).map((p) => ({ ...p, teamVaultProfileRef: { vaultId: teamStatus.vaultId!, profileId: p.id } }))
        : teamPayload?.ssh ?? [],
    [teamPayload, teamStatus]
  );
  const teamS3WithRef = useMemo(
    () =>
      teamStatus?.vaultId
        ? (teamPayload?.s3 ?? []).map((p) => ({ ...p, teamVaultProfileRef: { vaultId: teamStatus.vaultId!, profileId: p.id } }))
        : teamPayload?.s3 ?? [],
    [teamPayload, teamStatus]
  );

  const filteredTeamSSH = useMemo(() => filterSshProfiles(teamSshWithRef, query), [teamSshWithRef, query]);
  const filteredTeamS3 = useMemo(() => filterS3Profiles(teamS3WithRef, query), [teamS3WithRef, query]);
  const teamSshTree = useMemo(
    () => buildTeamFolderTree(teamPayload?.folders ?? [], filteredTeamSSH, teamPayload?.folderIcons ?? {}),
    [teamPayload, filteredTeamSSH]
  );
  const teamS3Tree = useMemo(
    () => buildTeamFolderTree(teamPayload?.folders ?? [], filteredTeamS3, teamPayload?.folderIcons ?? {}),
    [teamPayload, filteredTeamS3]
  );
  const teamFolderSuggestions = useMemo(
    () => collectTeamFolderSuggestions(teamPayload?.folders ?? [], teamPayload?.ssh ?? [], teamPayload?.s3 ?? []),
    [teamPayload]
  );

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

  const groupedSSH = useMemo(() => groupProfiles(sshFolderNames, filteredSSH, query), [filteredSSH, sshFolderNames, query]);
  const groupedS3 = useMemo(() => groupProfiles(s3FolderNames, filteredS3, query), [filteredS3, s3FolderNames, query]);

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

  // Shown in place of either Team list (SSH/S3) whenever the vault isn't unlocked — lets unlocking
  // happen right here instead of requiring a detour through Settings > Team Vault.
  const teamLockedPrompt = !teamStatus?.exists ? (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <Lock className="h-5 w-5 text-amber-400" />
      <p className="text-sm text-txt-muted">No Team Vault has been set up on this machine yet.</p>
      <p className="text-xs text-txt-muted">Settings &gt; Team Vault</p>
    </div>
  ) : (
    <div className="mx-auto max-w-sm space-y-2 py-8 text-center">
      <Lock className="mx-auto h-5 w-5 text-amber-400" />
      <p className="text-sm text-txt-muted">Unlock the Team Vault to see shared connections.</p>
      {!showManualUnlock && unlockRecipientId && unlockIdentityPath && teamStatus.selfRecipientId ? (
        <div className="flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() => void handleTeamUnlock()}
            disabled={unlocking}
            className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {unlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
            Unlock as {unlockRecipientId}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowManualUnlock(true);
              setUnlockRecipientId('');
              setUnlockIdentityPath('');
            }}
            className="text-xs text-txt-muted underline hover:text-txt-secondary"
          >
            Use a different identity...
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <input
            type="text"
            value={unlockRecipientId}
            onChange={(e) => setUnlockRecipientId(e.target.value)}
            placeholder="Your recipient id"
            className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
          />
          <input
            type="text"
            value={unlockIdentityPath}
            onChange={(e) => setUnlockIdentityPath(e.target.value)}
            placeholder="Path to your identity file"
            className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleTeamUnlock()}
              disabled={unlocking || !unlockRecipientId.trim() || !unlockIdentityPath.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {unlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
              Unlock
            </button>
            {showManualUnlock && teamStatus.selfRecipientId && teamStatus.selfIdentityFilePath && (
              <button
                type="button"
                onClick={() => {
                  setShowManualUnlock(false);
                  setUnlockRecipientId(teamStatus.selfRecipientId ?? '');
                  setUnlockIdentityPath(teamStatus.selfIdentityFilePath ?? '');
                }}
                className="text-xs text-txt-muted underline hover:text-txt-secondary"
              >
                Use my saved identity
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );

  if (!open) return null;

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div role="dialog" aria-modal="true" aria-label="Connection Manager" className="flex h-[85vh] max-h-[720px] w-full max-w-4xl flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden relative">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Connection Manager</h2>
          </div>
          <button aria-label="Close" title="Close"
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

        {/* Personal / Team source toggle — a separate view, not a merged list with a badge (see
            docs/team-vault-plan.md's connection-manager plan for why). Hidden for Kubernetes,
            which has no concept of either. */}
        {tab !== 'k8s' && !editing && (
          <div className="flex items-center gap-2 border-b border-divider bg-app-surface px-4 py-2">
            {(
              [
                { key: 'personal' as const, label: 'Personal', icon: Server },
                // Shows the vault's own descriptive name once it has one (teamVaultRename) —
                // falls back to the generic "Team" label for a vault that never got one (created
                // before the feature existed, or left blank on purpose).
                { key: 'team' as const, label: teamStatus?.vaultName || 'Team', icon: Users },
              ]
            ).map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setSource(key)}
                className={
                  'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ' +
                  (source === key
                    ? 'bg-sky-600 text-white shadow-sm'
                    : 'text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary')
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
            {source === 'team' && teamNotice && (
              <span className="ml-2 flex items-center gap-1.5 text-2xs text-txt-muted">
                {teamNotice === 'auto-pulled' ? (
                  <>
                    <CloudDownload className="h-3 w-3 text-emerald-400" />
                    Updated from another member
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3 w-3 text-amber-400" />
                    A newer version is available — push your changes to sync
                  </>
                )}
              </span>
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
            <div className="mb-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          {editing ? (
            <>
              {error && (
                <div className="mx-4 mt-4 shrink-0 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                  {error}
                </div>
              )}
              {editing.type === 'ssh' ? (
                <SSHProfileForm
                  initial={editing.config as SSHConnectionConfig | undefined}
                  onSave={handleSaveSSH}
                  onCancel={() => setEditing(null)}
                  dotfilesPoolEnabled={dotfilesPoolEnabled}
                  folderSuggestions={source === 'team' ? teamFolderSuggestions : undefined}
                  canEditSecret={source !== 'team' || isTeamAdmin}
                />
              ) : (
                <S3ProfileForm
                  initial={editing.config as S3Config | undefined}
                  onSave={handleSaveS3}
                  onCancel={() => setEditing(null)}
                  folderSuggestions={source === 'team' ? teamFolderSuggestions : undefined}
                  canEditSecret={source !== 'team' || isTeamAdmin}
                />
              )}
            </>
          ) : (
            <>
              {tab !== 'k8s' && (
                <div className="mb-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-txt-muted" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const activeSSH = source === 'team' ? filteredTeamSSH : filteredSSH;
                            const activeS3 = source === 'team' ? filteredTeamS3 : filteredS3;
                            if (adHocTarget && onConnectSSH) {
                              e.preventDefault();
                              handleConnectAdHoc();
                            } else if (tab === 'ssh' && activeSSH.length === 1 && onConnectSSH) {
                              e.preventDefault();
                              void handleConnectSSH(activeSSH[0]);
                            } else if (tab === 's3' && activeS3.length === 1 && onConnectS3) {
                              e.preventDefault();
                              void handleConnectS3(activeS3[0]);
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

                    {(source === 'personal' || teamPayload !== null) && (
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
                      <button aria-label="Close" title="Close"
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
                                profiles.map((profile) => (
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

              {tab === 'ssh' && source === 'team' && (
                <div className="space-y-2">
                  {teamLoading ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-txt-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading Team Vault...
                    </div>
                  ) : teamPayload === null ? (
                    teamLockedPrompt
                  ) : filteredTeamSSH.length === 0 && teamSshTree.roots.length === 0 ? (
                    <p className="py-6 text-center text-sm text-txt-muted">
                      {query ? 'No shared profiles matched your search' : 'No shared SSH profiles yet'}
                    </p>
                  ) : (
                    <TeamProfileTree
                      roots={teamSshTree.roots}
                      ungrouped={teamSshTree.ungrouped}
                      currentPath={teamFolderPath}
                      onNavigate={setTeamFolderPath}
                      query={query}
                      renderProfile={(profile) => (
                        <TeamSshProfileRow
                          key={profile.id}
                          profile={profile}
                          onConnectSSH={onConnectSSH}
                          onConnectSFTP={onConnectSFTP}
                          handleCloneSSH={handleCloneSSH}
                          handleDeleteSSH={handleDeleteSSH}
                          setEditing={setEditing}
                        />
                      )}
                      onDropProfile={(targetPath, e) => void handleDropOnTeamFolder(targetPath, e, 'ssh')}
                      onCreateFolder={handleCreateTeamFolder}
                      onRenameFolder={handleRenameTeamFolder}
                      onDeleteFolder={handleDeleteTeamFolder}
                      onSetFolderIcon={handleSetTeamFolderIcon}
                    />
                  )}
                </div>
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

              {tab === 's3' && source === 'team' && (
                <div className="space-y-2">
                  {teamLoading ? (
                    <div className="flex items-center justify-center gap-2 py-8 text-sm text-txt-muted">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading Team Vault...
                    </div>
                  ) : teamPayload === null ? (
                    teamLockedPrompt
                  ) : filteredTeamS3.length === 0 && teamS3Tree.roots.length === 0 ? (
                    <p className="py-6 text-center text-sm text-txt-muted">
                      {query ? 'No shared profiles matched your search' : 'No shared S3 profiles yet'}
                    </p>
                  ) : (
                    <TeamProfileTree
                      roots={teamS3Tree.roots}
                      ungrouped={teamS3Tree.ungrouped}
                      currentPath={teamFolderPath}
                      onNavigate={setTeamFolderPath}
                      query={query}
                      renderProfile={(profile) => (
                        <TeamS3ProfileRow
                          key={profile.id}
                          profile={profile}
                          onConnectS3={onConnectS3}
                          handleCloneS3={handleCloneS3}
                          handleDeleteS3={handleDeleteS3}
                          setEditing={setEditing}
                        />
                      )}
                      onDropProfile={(targetPath, e) => void handleDropOnTeamFolder(targetPath, e, 's3')}
                      onCreateFolder={handleCreateTeamFolder}
                      onRenameFolder={handleRenameTeamFolder}
                      onDeleteFolder={handleDeleteTeamFolder}
                      onSetFolderIcon={handleSetTeamFolderIcon}
                    />
                  )}
                </div>
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
