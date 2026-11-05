import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Cloud,
  Copy,
  DownloadCloud,
  Loader2,
  Lock,
  Pencil,
  Shield,
  ShieldOff,
  Trash2,
  Unlock,
  UploadCloud,
  Users,
} from 'lucide-react';
import type { TeamVaultRole, TeamVaultStatus, TeamVaultSyncPreview } from '@shared/types/teamVault';
import { SyncTargetForm, emptySyncTargetDraft, draftFromTargetConfig, buildSyncTarget, type SyncTargetDraft } from './SyncTargetForm';
import { describeIpcError } from '../../lib/format';
import { formatDateTime } from '../../lib/dateFormat';
import { parseTeamVaultJoinInfo } from '../../lib/teamVaultJoinInfo';
import { useConfirm } from '../ConfirmDialog';
import { useEscapeToClose } from '../../lib/useModalDismiss';

function emptyS3TargetDraft(): SyncTargetDraft {
  return { ...emptySyncTargetDraft(), type: 's3' };
}

interface TeamVaultDetailPanelProps {
  vaultId: string;
  /** Returns to `TeamVaultListPanel` — wired to both an explicit "Back" button and Escape. */
  onBack: () => void;
  /** Called after this vault is deleted (admin, whole-team) or forgotten on this device, so the
   * list can drop it and return to the list view. */
  onVaultRemoved: () => void;
}

/**
 * Per-team detail/admin UI for the Team Vault (docs/team-vault-plan.md's multi-team plan §7) —
 * mounted by `TeamVaultListPanel` with `key={vaultId}` so switching teams always starts from a
 * clean draft state. Creating a brand-new vault or generating a join-request identity both now
 * live in `TeamVaultListPanel` instead (neither has a `vaultId` to scope itself by yet) — this
 * panel only ever renders for a team already known on this device.
 */
export const TeamVaultDetailPanel: React.FC<TeamVaultDetailPanelProps> = ({ vaultId, onBack, onVaultRemoved }) => {
  const confirm = useConfirm();
  const [status, setStatus] = useState<TeamVaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEscapeToClose(onBack, true);

  // Rename the vault (admin only) — the descriptive name shown instead of the opaque vaultId.
  const [editingVaultName, setEditingVaultName] = useState(false);
  const [vaultNameEdit, setVaultNameEdit] = useState('');
  const [savingVaultName, setSavingVaultName] = useState(false);
  const [vaultIdCopied, setVaultIdCopied] = useState(false);

  // Free-text description (admin only) — shown in the Connection Manager's per-team tab so a
  // member can tell what the team is for without asking out of band (§D of the join-flow plan).
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionEdit, setDescriptionEdit] = useState('');
  const [savingDescription, setSavingDescription] = useState(false);

  // "Copy invite" per member (§A) — an age-encrypted blob of this vault's S3 target for that
  // specific recipient, so they never have to type it in by hand.
  const [invitingRecipientId, setInvitingRecipientId] = useState<string | null>(null);
  const [copiedInviteFor, setCopiedInviteFor] = useState<string | null>(null);

  // Local, per-device "show this team as a tab in the Connection Manager" preference (§D) —
  // never synced, lives in AppSettings, defaults to true when no entry exists yet.
  const [showAsTab, setShowAsTab] = useState(true);
  const [savingShowAsTab, setSavingShowAsTab] = useState(false);

  // Unlock (needed for add/remove — see TeamVaultService.unlock's doc comment on the still-open
  // PIN question).
  const [unlockRecipientId, setUnlockRecipientId] = useState('');
  const [unlockIdentityPath, setUnlockIdentityPath] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [locking, setLocking] = useState(false);
  const [syncPreview, setSyncPreview] = useState<TeamVaultSyncPreview | null>(null);
  // Shown only as a fallback (multiple identities, a new machine, or a lost config) — when
  // status.selfRecipientId/selfIdentityFilePath are already known, unlocking needs no fields at
  // all, just a button (found to be a real usability problem otherwise — see docs/team-vault-plan.md).
  const [showManualUnlock, setShowManualUnlock] = useState(false);

  // Recover using the saved recovery key text — guided alternative to "Use a different identity"
  // for someone who has only the printed/saved recovery identity, not a file path and not the
  // internal recipientId (both handled by teamVaultUnlockWithRecoveryText).
  const [showRecoveryUnlock, setShowRecoveryUnlock] = useState(false);
  const [recoveryTextInput, setRecoveryTextInput] = useState('');
  const [recovering, setRecovering] = useState(false);

  const [deletingVault, setDeletingVault] = useState(false);

  // Add member — the admin pastes the whole join-info blob a new member copies from their own
  // "Generate my Team Vault ID" step (TeamVaultListPanel); parsed automatically so the admin
  // never has to hand-copy the long age1yubikey1... string themselves.
  const [joinInfoPaste, setJoinInfoPaste] = useState('');
  const [newRecipientId, setNewRecipientId] = useState('');
  const [newAgeRecipient, setNewAgeRecipient] = useState('');
  const [newRole, setNewRole] = useState<TeamVaultRole>('member');
  const [addingMember, setAddingMember] = useState(false);

  const [busyRecipientId, setBusyRecipientId] = useState<string | null>(null);

  // S3 target config + push/pull (Fas 3)
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState<SyncTargetDraft>(emptyS3TargetDraft());
  const [targetError, setTargetError] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const s = await window.multissh.teamVaultGetStatus(vaultId);
      setStatus(s);
      // Prefill rather than making the admin retype/relocate these every session — found to be a
      // real usability problem during end-to-end testing (see docs/team-vault-plan.md). Only
      // fills an empty field, so it never clobbers something the admin already typed this
      // session (e.g. unlocking as a different member than the one remembered).
      setUnlockRecipientId((prev) => prev || s.selfRecipientId || '');
      setUnlockIdentityPath((prev) => prev || s.selfIdentityFilePath || '');
      // Shown before Push/Pull (§14) — best-effort, so a failure here never blocks the rest of
      // the panel from loading.
      if (s.remoteConfigured) {
        setSyncPreview(await window.multissh.teamVaultGetSyncPreview(vaultId));
      } else {
        setSyncPreview(null);
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to load Team Vault status'));
    } finally {
      setLoading(false);
    }
  }, [vaultId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await window.multissh.settingsGet();
        if (cancelled) return;
        const entry = settings.connectionManagerVisibleTeamVaults?.[vaultId];
        setShowAsTab(entry ?? true);
      } catch {
        // Best-effort preference load — defaults to visible (the initial state) on failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultId]);

  const handleRenameVault = async () => {
    setSavingVaultName(true);
    setError(null);
    try {
      await window.multissh.teamVaultRename(vaultId, vaultNameEdit.trim());
      setEditingVaultName(false);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to rename the vault'));
    } finally {
      setSavingVaultName(false);
    }
  };

  const handleSetDescription = async () => {
    setSavingDescription(true);
    setError(null);
    try {
      await window.multissh.teamVaultSetDescription(vaultId, descriptionEdit.trim());
      setEditingDescription(false);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to save the description'));
    } finally {
      setSavingDescription(false);
    }
  };

  const handleCopyInvite = async (recipientId: string) => {
    setInvitingRecipientId(recipientId);
    setError(null);
    try {
      const invite = await window.multissh.teamVaultBuildInvite(vaultId, recipientId);
      await navigator.clipboard.writeText(invite);
      setCopiedInviteFor(recipientId);
      setTimeout(() => setCopiedInviteFor((prev) => (prev === recipientId ? null : prev)), 3000);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to build the invite'));
    } finally {
      setInvitingRecipientId(null);
    }
  };

  const handleToggleShowAsTab = async (checked: boolean) => {
    setSavingShowAsTab(true);
    setShowAsTab(checked);
    try {
      // Atomic read-modify-write in the main process (SettingsStore.setTeamVaultTabVisible) —
      // not a settingsGet() -> mutate -> settingsSave() round trip here, which would race against
      // another team's detail panel toggling its own entry at the same time and silently clobber
      // it (see that method's doc comment).
      await window.multissh.settingsSetTeamVaultTabVisible(vaultId, checked);
    } catch (err) {
      setShowAsTab(!checked);
      setError(describeIpcError(err, 'Failed to save this preference'));
    } finally {
      setSavingShowAsTab(false);
    }
  };

  const handleJoinInfoPaste = (value: string) => {
    setJoinInfoPaste(value);
    const parsed = parseTeamVaultJoinInfo(value);
    if (parsed) {
      setNewRecipientId(parsed.recipientId);
      setNewAgeRecipient(parsed.ageRecipient);
    } else {
      setNewAgeRecipient('');
    }
  };

  const handleLock = async () => {
    setLocking(true);
    setError(null);
    try {
      await window.multissh.teamVaultLock(vaultId);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to lock the Team Vault'));
    } finally {
      setLocking(false);
    }
  };

  const handleUnlock = async () => {
    if (!unlockRecipientId.trim() || !unlockIdentityPath.trim()) return;
    setUnlocking(true);
    setError(null);
    try {
      await window.multissh.teamVaultUnlock(vaultId, unlockRecipientId.trim(), unlockIdentityPath.trim());
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to unlock the Team Vault'));
    } finally {
      setUnlocking(false);
    }
  };

  const handleUnlockWithRecovery = async () => {
    if (!recoveryTextInput.trim()) return;
    setRecovering(true);
    setError(null);
    try {
      await window.multissh.teamVaultUnlockWithRecoveryText(vaultId, recoveryTextInput);
      setRecoveryTextInput('');
      setShowRecoveryUnlock(false);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to recover the Team Vault with that key'));
    } finally {
      setRecovering(false);
    }
  };

  const handleAddMember = async () => {
    if (!newRecipientId.trim() || !newAgeRecipient.trim() || !status) return;
    setAddingMember(true);
    setError(null);
    try {
      await window.multissh.teamVaultAddMember(vaultId, newRecipientId.trim(), newAgeRecipient.trim(), newRole);
      setJoinInfoPaste('');
      setNewRecipientId('');
      setNewAgeRecipient('');
      setNewRole('member');
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to add member'));
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemoveMember = async (recipientId: string) => {
    if (!(await confirm({
      title: 'Remove member',
      message: `Remove "${recipientId}" from the Team Vault? They keep whatever they already synced, but lose access to anything added after this.`,
    }))) {
      return;
    }
    setBusyRecipientId(recipientId);
    setError(null);
    try {
      await window.multissh.teamVaultRemoveMember(vaultId, recipientId);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to remove member'));
    } finally {
      setBusyRecipientId(null);
    }
  };

  const handleDeleteVault = async () => {
    if (!(await confirm({
      title: 'Remove vault from this machine',
      message:
        'This forgets the Team Vault on this machine only — the remote S3 copy (if any) is not touched, and other members keep their access. You can get it back later by joining again if a remote copy exists.',
    }))) {
      return;
    }
    setDeletingVault(true);
    setError(null);
    try {
      await window.multissh.teamVaultDelete(vaultId);
      onVaultRemoved();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to remove the vault from this machine'));
    } finally {
      setDeletingVault(false);
    }
  };

  const handleSetRole = async (recipientId: string, role: TeamVaultRole) => {
    setBusyRecipientId(recipientId);
    setError(null);
    try {
      await window.multissh.teamVaultSetRole(vaultId, recipientId, role);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to change role'));
    } finally {
      setBusyRecipientId(null);
    }
  };

  // Prefills from the saved target (same precedent the general Synchronization settings panel
  // already set for its own target editor — see buildSyncStatus()/draftFromTargetConfig) rather
  // than starting blank: the admin previously had to retype the bucket/region/credentials from
  // scratch every time just to change one field.
  const openEditTarget = () => {
    setTargetDraft(
      status?.targetConfig
        ? draftFromTargetConfig(status.targetConfig, status.remoteBasePath ?? '')
        : emptyS3TargetDraft()
    );
    setTargetError(null);
    setEditingTarget(true);
  };

  const handleSaveTarget = async () => {
    if (targetDraft.type !== 's3') {
      setTargetError('The Team Vault only supports an S3-compatible target.');
      return;
    }
    if (!targetDraft.remoteBasePath.trim()) {
      setTargetError('A bucket (optionally "bucket/prefix") is required.');
      return;
    }
    // A blank secret is only acceptable when a secret is already saved for this target (the
    // secret itself never round-trips to this form — see TeamVaultStatus.targetConfig's doc
    // comment — so "blank" here means "keep the saved one", which the IPC handler enforces).
    const hasSavedSecret = Boolean(status?.targetConfig?.s3Config.hasSecretAccessKey);
    if (!targetDraft.accessKeyId?.trim() || (!targetDraft.secretAccessKey && !hasSavedSecret)) {
      setTargetError('Access key ID and secret access key are required.');
      return;
    }
    setTargetError(null);
    setSavingTarget(true);
    try {
      await window.multissh.teamVaultSetTarget(vaultId, buildSyncTarget(targetDraft), targetDraft.remoteBasePath);
      setEditingTarget(false);
      await load();
    } catch (err) {
      setTargetError(describeIpcError(err, 'Failed to save the Team Vault target'));
    } finally {
      setSavingTarget(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    setError(null);
    try {
      await window.multissh.teamVaultPush(vaultId);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Push failed'));
    } finally {
      setPushing(false);
    }
  };

  const handlePull = async (force = false) => {
    setPulling(true);
    setError(null);
    try {
      await window.multissh.teamVaultPull(vaultId, force ? { force: true } : undefined);
      await load();
    } catch (err) {
      // TeamVaultUnpushedChangesError loses its class crossing IPC (plain Error on this side),
      // so this matches on the message text — see TeamVaultService.pullFromRemote's doc comment
      // for why this needs an explicit choice rather than silently overwriting local changes.
      const message = err instanceof Error ? err.message : '';
      if (!force && message.includes('have not been pushed yet')) {
        setPulling(false);
        const proceed = await confirm({
          title: 'Unpushed local changes',
          message:
            'This machine has local Team Vault changes (e.g. shared profile edits) that have not been pushed yet. Pulling now would discard them. Push first instead, or pull anyway and discard them?',
          confirmLabel: 'Pull anyway (discard local changes)',
        });
        if (proceed) {
          await handlePull(true);
        }
        return;
      }
      setError(describeIpcError(err, 'Pull failed'));
    } finally {
      setPulling(false);
    }
  };

  // Client-side only, for deciding whether to show the delete-vault button — the server enforces
  // the real admin check (`TeamVaultService.requireUnlockedAsAdmin`) regardless of this.
  const isAdmin = !!status?.members?.some((m) => m.recipientId === status.selfRecipientId && m.role === 'admin');
  // Who the "fewer than 2 admins" warning's quick "Promote <member>" action (§16) would offer —
  // the first non-admin member, if any.
  const otherMembers = status?.members?.filter((m) => m.role !== 'admin') ?? [];

  // A new member's join flow (`TeamVaultListPanel`) needs the real vaultId up front — the remote
  // object path is keyed by it, so there's no way to discover it blind the way a single-team
  // install's "point at a bucket and pull" used to work. Anyone already in the team copies it
  // from here and sends it to the joiner the same out-of-band way they already share the S3
  // target/credentials.
  const handleCopyVaultId = async () => {
    if (!status?.vaultId) return;
    try {
      await navigator.clipboard.writeText(status.vaultId);
      setVaultIdCopied(true);
      setTimeout(() => setVaultIdCopied(false), 3000);
    } catch {
      setError('Failed to copy the Team ID to clipboard');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface px-2 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Teams
        </button>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-txt-primary">
          <Shield className="h-4 w-4 text-sky-400" />
          {status?.vaultName || status?.vaultId || vaultId}
        </h3>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-txt-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Team Vault status...
        </div>
      ) : !status?.exists ? (
        <p className="text-xs text-txt-muted">
          This team isn't known on this device anymore. Go back to the team list.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-border-subtle bg-app-surface p-3 text-xs">
            <div className="grid grid-cols-[88px_1fr] items-center gap-x-2 gap-y-1">
              <span className="text-txt-muted">Vault</span>
              {editingVaultName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    aria-label="Vault name"
                    type="text"
                    autoFocus
                    value={vaultNameEdit}
                    onChange={(e) => setVaultNameEdit(e.target.value)}
                    maxLength={200}
                    placeholder={status.vaultId}
                    className="rounded border border-border-subtle bg-app-input px-1.5 py-0.5 text-xs text-txt-primary outline-none focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleRenameVault()}
                    disabled={savingVaultName}
                    className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                    title="Save"
                  >
                    {savingVaultName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    aria-label="Cancel"
                    type="button"
                    onClick={() => setEditingVaultName(false)}
                    disabled={savingVaultName}
                    className="text-txt-muted hover:text-txt-secondary disabled:opacity-50"
                    title="Cancel"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-txt-secondary">{status.vaultName || status.vaultId}</span>
                  {status.unlocked && isAdmin && (
                    <button
                      aria-label="Rename vault"
                      type="button"
                      onClick={() => {
                        setVaultNameEdit(status.vaultName ?? '');
                        setEditingVaultName(true);
                      }}
                      className="text-txt-muted hover:text-txt-secondary"
                      title="Rename vault"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
              <span className="text-txt-muted">Team ID</span>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-2xs text-txt-muted">{status.vaultId}</span>
                <button
                  type="button"
                  onClick={() => void handleCopyVaultId()}
                  title="Copy — share with anyone joining this team"
                  className="shrink-0 text-txt-muted hover:text-txt-secondary"
                >
                  {vaultIdCopied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
              <span className="text-txt-muted">Status</span>
              <span className="flex items-center gap-2">
                <span className={status.unlocked ? 'text-emerald-400' : 'text-amber-400'}>
                  {status.unlocked ? 'Unlocked for this session' : 'Locked'}
                </span>
                {status.unlocked && (
                  <button
                    type="button"
                    onClick={() => void handleLock()}
                    disabled={locking}
                    title="Lock this Team Vault now"
                    className="rounded-lg border border-border-subtle px-1.5 py-0.5 text-2xs text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                  >
                    {locking ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Lock now'}
                  </button>
                )}
              </span>
              {status.selfRole && (
                <>
                  <span className="text-txt-muted">Your role</span>
                  <span className="capitalize text-txt-secondary">{status.selfRole}</span>
                </>
              )}
              <span className="self-start text-txt-muted">Description</span>
              {editingDescription ? (
                <div className="flex min-w-0 flex-1 items-start gap-1.5">
                  <textarea
                    aria-label="Description"
                    autoFocus
                    value={descriptionEdit}
                    onChange={(e) => setDescriptionEdit(e.target.value)}
                    maxLength={500}
                    rows={2}
                    placeholder="What is this team for? (shown to members in the Connection Manager)"
                    className="min-w-0 flex-1 rounded border border-border-subtle bg-app-input px-1.5 py-0.5 text-xs text-txt-primary outline-none focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSetDescription()}
                    disabled={savingDescription}
                    className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                    title="Save"
                  >
                    {savingDescription ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    aria-label="Cancel"
                    type="button"
                    onClick={() => setEditingDescription(false)}
                    disabled={savingDescription}
                    className="text-txt-muted hover:text-txt-secondary disabled:opacity-50"
                    title="Cancel"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div className="flex min-w-0 items-start gap-1.5">
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-txt-secondary">
                    {status.vaultDescription || '—'}
                  </span>
                  {status.unlocked && isAdmin && (
                    <button
                      aria-label="Edit description"
                      type="button"
                      onClick={() => {
                        setDescriptionEdit(status.vaultDescription ?? '');
                        setEditingDescription(true);
                      }}
                      className="shrink-0 text-txt-muted hover:text-txt-secondary"
                      title="Edit description"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                </div>
              )}
            </div>
            <label className="mt-2 flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
              <span className="text-txt-muted">Show this team as a tab in the Connection Manager</span>
              <input
                type="checkbox"
                checked={showAsTab}
                disabled={savingShowAsTab}
                onChange={(e) => void handleToggleShowAsTab(e.target.checked)}
                className="h-3.5 w-3.5 accent-sky-500"
              />
            </label>
          </div>

          {(status.adminCount ?? 0) < 2 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="flex-1 space-y-1.5">
                <p>
                  This vault has fewer than 2 admins. If the sole admin loses their card, only the
                  recovery key can restore access.
                </p>
                {status.unlocked && isAdmin && otherMembers.length > 0 && (
                  <button
                    type="button"
                    onClick={() => void handleSetRole(otherMembers[0].recipientId, 'admin')}
                    disabled={busyRecipientId === otherMembers[0].recipientId}
                    className="rounded-lg border border-amber-700/60 bg-amber-900/30 px-2 py-1 text-xs font-medium text-amber-200 hover:bg-amber-900/50 disabled:opacity-50"
                  >
                    Promote {otherMembers[0].recipientId}
                  </button>
                )}
              </div>
            </div>
          )}

          {!status.unlocked && (
            <div className="space-y-2 rounded-lg border border-border-subtle bg-app-surface p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-txt-secondary">
                <Lock className="h-3.5 w-3.5 text-amber-400" />
                Unlock to add, remove, or promote members
              </p>

              {!showManualUnlock && status.selfRecipientId && status.selfIdentityFilePath ? (
                <>
                  <p className="text-xs text-txt-muted">
                    Unlock as <span className="text-txt-secondary">{status.selfRecipientId}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleUnlock()}
                      disabled={unlocking}
                      className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {unlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                      Unlock
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
                </>
              ) : (
                <>
                  <input
                    aria-label="Your recipient id"
                    type="text"
                    value={unlockRecipientId}
                    onChange={(e) => setUnlockRecipientId(e.target.value)}
                    placeholder="Your recipient id"
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                  />
                  <input
                    aria-label="Path to your identity file"
                    type="text"
                    value={unlockIdentityPath}
                    onChange={(e) => setUnlockIdentityPath(e.target.value)}
                    placeholder="Path to your identity file"
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleUnlock()}
                      disabled={unlocking || !unlockRecipientId.trim() || !unlockIdentityPath.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                    >
                      {unlocking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                      Unlock
                    </button>
                    {showManualUnlock && status.selfRecipientId && status.selfIdentityFilePath && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowManualUnlock(false);
                          setUnlockRecipientId(status.selfRecipientId ?? '');
                          setUnlockIdentityPath(status.selfIdentityFilePath ?? '');
                        }}
                        className="text-xs text-txt-muted underline hover:text-txt-secondary"
                      >
                        Use my saved identity
                      </button>
                    )}
                  </div>
                </>
              )}

              {!showRecoveryUnlock ? (
                <button
                  type="button"
                  onClick={() => setShowRecoveryUnlock(true)}
                  className="text-xs text-txt-muted underline hover:text-txt-secondary"
                >
                  Lost your card? Recover using your saved recovery key...
                </button>
              ) : (
                <div className="space-y-2 border-t border-border-subtle pt-2">
                  <p className="text-xs text-txt-secondary">
                    Paste the recovery key text you saved when this vault was created (the
                    &quot;AGE-SECRET-KEY-1...&quot; block). This unlocks the vault with
                    admin-equivalent access so you can re-add yourself as a regular member.
                  </p>
                  <textarea
                    aria-label="Recovery key"
                    value={recoveryTextInput}
                    onChange={(e) => setRecoveryTextInput(e.target.value)}
                    placeholder="AGE-SECRET-KEY-1..."
                    rows={3}
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted font-mono"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleUnlockWithRecovery()}
                      disabled={recovering || !recoveryTextInput.trim()}
                      className="flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                    >
                      {recovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlock className="h-3.5 w-3.5" />}
                      Recover vault access
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowRecoveryUnlock(false);
                        setRecoveryTextInput('');
                      }}
                      disabled={recovering}
                      className="text-xs text-txt-muted underline hover:text-txt-secondary disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-medium text-txt-secondary">
              <Users className="h-3.5 w-3.5 text-sky-400" />
              Members ({status.members?.length ?? 0})
            </p>
            <div className="space-y-1.5">
              {(status.members ?? []).map((m) => (
                <div
                  key={m.recipientId}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-txt-primary">{m.recipientId}</div>
                    <div className="text-txt-muted">{m.role}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {status.unlocked && isAdmin && m.recipientId !== status.selfRecipientId && (
                      <button
                        type="button"
                        onClick={() => void handleCopyInvite(m.recipientId)}
                        disabled={invitingRecipientId === m.recipientId}
                        title="Copy an invite blob for this member (their S3 target, no manual setup needed)"
                        className="flex items-center gap-1 rounded-lg border border-border-subtle px-2 py-1 text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                      >
                        {invitingRecipientId === m.recipientId ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : copiedInviteFor === m.recipientId ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                        {copiedInviteFor === m.recipientId ? 'Copied' : 'Copy invite'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleSetRole(m.recipientId, m.role === 'admin' ? 'member' : 'admin')}
                      disabled={
                        !status.unlocked ||
                        busyRecipientId === m.recipientId ||
                        (m.role === 'admin' && (status.adminCount ?? 0) <= 1)
                      }
                      title={
                        !status.unlocked
                          ? 'Unlock the vault first'
                          : m.role === 'admin' && (status.adminCount ?? 0) <= 1
                            ? "Can't demote the last admin — promote another member first"
                            : undefined
                      }
                      className="rounded-lg border border-border-subtle px-2 py-1 text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                    >
                      {m.role === 'admin' ? 'Demote' : 'Promote'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemoveMember(m.recipientId)}
                      disabled={!status.unlocked || busyRecipientId === m.recipientId}
                      aria-label={`Remove member ${m.recipientId}`}
                      title={status.unlocked ? 'Remove member' : 'Unlock the vault first'}
                      className="rounded-lg border border-red-900/60 p-1.5 text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2 rounded-lg border border-border-subtle bg-app-surface p-3">
            <p className="text-xs font-medium text-txt-secondary">Add a member</p>
            <ol className="space-y-0.5 text-2xs text-txt-muted">
              <li>1. They open Settings → Team Vault → "Join an existing team" → "Generate my Team Vault ID" and send you what it copies.</li>
              <li>2. Paste it below.</li>
              <li>3. Once added, send them "Copy invite" from their row below.</li>
            </ol>
            <textarea
              aria-label="Join info from the new member"
              value={joinInfoPaste}
              onChange={(e) => handleJoinInfoPaste(e.target.value)}
              placeholder="Paste their join info (step 1 above)"
              rows={3}
              className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
            />
            {joinInfoPaste.trim() && !newAgeRecipient && (
              <p className="text-xs text-amber-300">
                That doesn't look like a join-info blob — make sure you pasted everything they
                copied from their own "Generate my Team Vault ID" step.
              </p>
            )}
            {newRecipientId && newAgeRecipient && (
              <div className="space-y-0.5 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2">
                <p data-testid="parsed-join-info-recipient-id" className="text-xs font-medium text-emerald-300">
                  {newRecipientId}
                </p>
                <p data-testid="parsed-join-info-age-recipient" className="break-all text-xs text-txt-muted">
                  {newAgeRecipient}
                </p>
              </div>
            )}
            <select
              aria-label="Role for the new member"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as TeamVaultRole)}
              className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              onClick={() => void handleAddMember()}
              disabled={addingMember || !newRecipientId.trim() || !newAgeRecipient.trim()}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
            >
              {addingMember && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Add member
            </button>
          </div>

          <div className="space-y-2 rounded-lg border border-border-subtle bg-app-surface p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-txt-secondary">
              <Cloud className="h-3.5 w-3.5 text-sky-400" />
              Remote sync (S3)
            </p>

            {!editingTarget ? (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-txt-muted">
                    {status.remoteConfigured ? 'S3 target configured' : 'No S3 target configured yet'}
                  </span>
                  <button
                    type="button"
                    onClick={openEditTarget}
                    className="flex items-center gap-1 rounded-lg border border-border-subtle px-2 py-1 text-txt-secondary hover:bg-app-surface-hover"
                  >
                    <Pencil className="h-3 w-3" />
                    {status.remoteConfigured ? 'Edit target' : 'Configure target'}
                  </button>
                </div>
                {status.remoteConfigured && (
                  <>
                    <div className="flex items-center justify-between text-xs text-txt-muted">
                      <span>Last synced</span>
                      <span>{status.lastSyncAt ? formatDateTime(status.lastSyncAt) : 'Never'}</span>
                    </div>
                    {syncPreview && (
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-txt-muted">Status</span>
                        {syncPreview.remoteChanged ? (
                          <span className="text-amber-400">Remote has a newer version — pull first</span>
                        ) : syncPreview.hasUnpushedLocalChanges ? (
                          <span className="text-sky-400">Local changes not pushed</span>
                        ) : (
                          <span className="text-emerald-400">Up to date</span>
                        )}
                      </div>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handlePush()}
                        disabled={pushing}
                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 disabled:opacity-50 ${
                          syncPreview?.hasUnpushedLocalChanges && !syncPreview.remoteChanged
                            ? 'border-sky-500 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20'
                            : 'border-border-subtle text-txt-secondary hover:bg-app-surface-hover'
                        }`}
                      >
                        {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                        Push
                      </button>
                      <button
                        type="button"
                        onClick={() => void handlePull()}
                        disabled={pulling || !status.unlocked}
                        title={!status.unlocked ? 'Unlock the Team Vault first — pulling needs the Vault Key to verify the update' : undefined}
                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 disabled:opacity-50 ${
                          syncPreview?.remoteChanged
                            ? 'border-amber-500 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                            : 'border-border-subtle text-txt-secondary hover:bg-app-surface-hover'
                        }`}
                      >
                        {pulling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
                        Pull
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <div className="space-y-3">
                {targetError && (
                  <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                    {targetError}
                  </div>
                )}
                {status?.targetConfig?.s3Config.hasSecretAccessKey && (
                  <p className="text-2xs text-txt-muted">
                    A secret access key is already saved. Leave "Secret Access Key" blank to keep it, or type a new one to replace it.
                  </p>
                )}
                <SyncTargetForm
                  draft={targetDraft}
                  onChange={setTargetDraft}
                  disabled={savingTarget}
                  onTestS3Connection={(config) => window.multissh.teamVaultTestTarget(vaultId, config)}
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingTarget(false)}
                    disabled={savingTarget}
                    className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveTarget()}
                    disabled={savingTarget}
                    className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {savingTarget && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Save target
                  </button>
                </div>
              </div>
            )}
          </div>

          {status.unlocked && isAdmin && (
            <div className="space-y-2 rounded-lg border border-red-900/60 bg-red-950/20 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-red-300">
                <ShieldOff className="h-3.5 w-3.5" />
                Danger zone
              </p>
              <p className="text-xs text-txt-muted">
                Forgets this Team Vault on this machine only. The remote S3 copy (if any) is not
                touched, and other members keep their access.
              </p>
              <button
                type="button"
                onClick={() => void handleDeleteVault()}
                disabled={deletingVault}
                className="flex items-center gap-1.5 rounded-lg border border-red-900/60 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-950/40 disabled:opacity-50"
              >
                {deletingVault ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Remove vault from this machine
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
