import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  DownloadCloud,
  Fingerprint,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Shield,
  Trash2,
  Unlock,
  UserPlus,
} from 'lucide-react';
import type { TeamVaultStatus, TeamVaultSyncPreview } from '@shared/types/teamVault';
import type { StorageConnectConfig } from '@shared/types/ipc';
import { TeamVaultDetailPanel } from './TeamVaultDetailPanel';
import { SyncTargetForm, emptySyncTargetDraft, buildSyncTarget, type SyncTargetDraft } from './SyncTargetForm';
import { describeIpcError } from '../../lib/format';
import { buildTeamVaultJoinInfo } from '../../lib/teamVaultJoinInfo';
import { useConfirm } from '../ConfirmDialog';
import { useEscapeToClose } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

function emptyS3TargetDraft(): SyncTargetDraft {
  return { ...emptySyncTargetDraft(), type: 's3' };
}

type ListMode = { kind: 'list' } | { kind: 'create' } | { kind: 'join' };

/**
 * Team list/switcher (docs/team-vault-plan.md's multi-team plan §7) — every team this device
 * knows about (`teamVaultList()`), each row showing its name/id, this device's role, and
 * locked/unlocked state. Selecting a row mounts `TeamVaultDetailPanel` with `key={vaultId}`
 * (resets that panel's own per-team draft state on every switch, same as the plan calls for).
 *
 * Creating a brand-new vault and generating a join-request identity both live here, not in the
 * detail panel — neither has a real `vaultId` to scope itself by yet (`createVault` mints one;
 * joining requires the admin to hand the real `vaultId` to the joiner out of band first — see
 * `handleJoinExistingVault`'s doc comment for why that's required now).
 */
export const TeamVaultListPanel: React.FC = () => {
  const confirm = useConfirm();
  const [vaults, setVaults] = useState<TeamVaultStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVaultId, setSelectedVaultId] = useState<string | null>(null);
  // Set right after `teamVaultCreate` succeeds, but not navigated to until the recovery-key
  // modal below is dismissed — opening the detail panel immediately would unmount this list
  // (and the modal that must still block on "I have printed/saved this recovery key").
  const [pendingVaultId, setPendingVaultId] = useState<string | null>(null);
  const [mode, setMode] = useState<ListMode>({ kind: 'list' });
  const [busyVaultId, setBusyVaultId] = useState<string | null>(null);
  const [syncPreviews, setSyncPreviews] = useState<Record<string, TeamVaultSyncPreview>>({});

  // "Generate my Team Vault ID" — produces the age1yubikey1... recipient this device's PIV card
  // will use, either to create a brand-new vault as its first admin, or to send to an existing
  // team's admin so they can add this device as a member.
  const [enrolling, setEnrolling] = useState(false);
  const [myRecipient, setMyRecipient] = useState<{ recipient: string; identityFilePath: string } | null>(null);
  const [selfRecipientId, setSelfRecipientId] = useState('');
  const [joinInfoCopied, setJoinInfoCopied] = useState(false);

  // Create a new vault
  const [creating, setCreating] = useState(false);
  const [vaultNameDraft, setVaultNameDraft] = useState('');
  const [recoveryIdentity, setRecoveryIdentity] = useState<string | null>(null);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  // The recovery key is shown once and Done stays disabled until it is saved, so Escape is swallowed here
  // (enabled = false) instead of reaching the Settings modal underneath and closing it with the key on screen.
  useEscapeToClose(() => undefined, recoveryIdentity !== null, false);
  const recoveryDialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(recoveryDialogRef, recoveryIdentity !== null);

  // Join an existing vault: needs the team's real vaultId (the remote object path is keyed by
  // it — see handleJoinExistingVault's doc comment) plus the S3 target it lives at, then pulls.
  const [joinVaultId, setJoinVaultId] = useState('');
  const [joinTargetDraft, setJoinTargetDraft] = useState<SyncTargetDraft>(emptyS3TargetDraft());
  const [joinTargetError, setJoinTargetError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  // Default join path (§A of the join-flow plan): paste an age-encrypted invite blob from the
  // admin instead of typing the S3 target in by hand. The old manual form (joinVaultId +
  // joinTargetDraft above) stays as a collapsed "...or configure manually" fallback.
  const [inviteText, setInviteText] = useState('');
  const [showManualJoin, setShowManualJoin] = useState(false);
  // Decoding an invite only decrypts and parses it — it never implicitly configures/connects to
  // anything. `age -r <recipient>` encryption proves the blob was encrypted to THIS device's own
  // identity, but proves nothing about who encrypted it (no sender authentication) — the same
  // trust model the join-info blob and the manual-entry fallback already rely on (the human
  // verifies the sender out of band). Surfacing the decoded target here, gated behind an explicit
  // second click, gives that same human-verification chance instead of silently reconfiguring the
  // S3 target and connecting to it the instant decryption succeeds.
  const [decodedInvite, setDecodedInvite] = useState<{
    vaultId: string;
    target: StorageConnectConfig;
    remoteBasePath?: string;
  } | null>(null);
  const [decoding, setDecoding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const statuses = await window.multissh.teamVaultList();
      setVaults(statuses);
      // Shown per-row (§15) — best-effort, so a failed preview for one team never blocks the
      // rest of the list from loading. Fetched one at a time, not via Promise.all: several
      // vaults can share the same S3 target, and firing concurrent HEAD requests through it hit
      // real-world "SignatureDoesNotMatch" failures against at least one S3-compatible endpoint.
      const remoteConfigured = statuses.filter((v) => v.remoteConfigured && v.vaultId);
      const previews: Array<readonly [string, TeamVaultSyncPreview]> = [];
      for (const v of remoteConfigured) {
        try {
          previews.push([v.vaultId!, await window.multissh.teamVaultGetSyncPreview(v.vaultId!)]);
        } catch {
          previews.push([v.vaultId!, { hasUnpushedLocalChanges: false, remoteChanged: false }]);
        }
      }
      setSyncPreviews(Object.fromEntries(previews));
    } catch (err) {
      setError(describeIpcError(err, 'Failed to load the list of teams'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetJoinCreateState = () => {
    setMyRecipient(null);
    setSelfRecipientId('');
    setJoinInfoCopied(false);
    setVaultNameDraft('');
    setJoinVaultId('');
    setJoinTargetDraft(emptyS3TargetDraft());
    setJoinTargetError(null);
    setInviteText('');
    setShowManualJoin(false);
    setDecodedInvite(null);
  };

  const handleEnroll = async () => {
    setEnrolling(true);
    setError(null);
    try {
      // No vaultId: this identity is for a vault that doesn't exist locally yet, either because
      // we're about to create it or because we're about to ask an existing team's admin to add
      // us — see TeamVaultService.enrollOwnPivRecipient's doc comment.
      const result = await window.multissh.teamVaultEnrollRecipient();
      setMyRecipient(result);
      if (result.suggestedLabel) {
        setSelfRecipientId((prev) => prev || result.suggestedLabel || '');
      }
    } catch (err) {
      setError(describeIpcError(err, 'Failed to generate a recipient from this PIV card'));
    } finally {
      setEnrolling(false);
    }
  };

  const handleCreateVault = async () => {
    if (!myRecipient || !selfRecipientId.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const { vaultId, recoveryIdentity: identity } = await window.multissh.teamVaultCreate(
        selfRecipientId.trim(),
        myRecipient.recipient,
        vaultNameDraft.trim(),
        myRecipient.identityFilePath
      );
      setRecoveryIdentity(identity);
      setRecoverySaved(false);
      setRecoveryCopied(false);
      setPendingVaultId(vaultId);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to create the Team Vault'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopyJoinInfo = async () => {
    if (!myRecipient || !selfRecipientId.trim()) return;
    try {
      await navigator.clipboard.writeText(buildTeamVaultJoinInfo(selfRecipientId.trim(), myRecipient.recipient));
      setJoinInfoCopied(true);
      setTimeout(() => setJoinInfoCopied(false), 3000);
    } catch {
      setError('Failed to copy join info to clipboard');
    }
  };

  const handleCopyRecovery = async () => {
    if (!recoveryIdentity) return;
    try {
      await navigator.clipboard.writeText(recoveryIdentity);
      setRecoveryCopied(true);
      setTimeout(() => setRecoveryCopied(false), 3000);
    } catch {
      setError('Failed to copy recovery key to clipboard');
    }
  };

  /** The remote vault file's object path is keyed by `vaultId` (`team-vault/<vaultId>/vault.json`
   * — see `TeamVaultService.remoteVaultPath`'s doc comment: this is what lets two teams safely
   * share one bucket/prefix without colliding). That means a joiner can't discover the vault
   * blind by just pointing at a bucket the way a single-team install used to — the real `vaultId`
   * has to come from the team's admin out of band (they copy it from their own team's detail view
   * — see `TeamVaultDetailPanel`'s "Team ID" row — alongside however they already share the S3
   * target/credentials). `teamVaultSetTarget`/`teamVaultPull` are called with that real id
   * directly, never a placeholder — there's nothing to "promote" to it afterwards. */
  const handleJoinExistingVault = async () => {
    const vaultId = joinVaultId.trim();
    if (!vaultId) {
      setJoinTargetError("The team's Team ID is required (ask its admin — see their Team Vault detail view).");
      return;
    }
    if (joinTargetDraft.type !== 's3') {
      setJoinTargetError('The Team Vault only supports an S3-compatible target.');
      return;
    }
    if (!joinTargetDraft.remoteBasePath.trim()) {
      setJoinTargetError('A bucket (optionally "bucket/prefix") is required.');
      return;
    }
    if (!joinTargetDraft.accessKeyId?.trim() || !joinTargetDraft.secretAccessKey) {
      setJoinTargetError('Access key ID and secret access key are required.');
      return;
    }
    setJoinTargetError(null);
    setJoining(true);
    setError(null);
    try {
      const target = buildSyncTarget(joinTargetDraft);
      await window.multissh.teamVaultSetTarget(vaultId, target, joinTargetDraft.remoteBasePath);
      const hasRemote = await window.multissh.teamVaultHasRemoteVault(vaultId);
      if (!hasRemote) {
        setJoinTargetError('No Team Vault found at that location — check the Team ID, bucket/prefix, and credentials.');
        return;
      }
      const status = await window.multissh.teamVaultPull(vaultId);
      await load();
      setSelectedVaultId(vaultId || status.vaultId || null);
      setMode({ kind: 'list' });
      resetJoinCreateState();
    } catch (err) {
      setJoinTargetError(describeIpcError(err, 'Failed to join the existing Team Vault'));
    } finally {
      setJoining(false);
    }
  };

  /**
   * Default join path (§A), step one of two: decrypts the admin's pasted invite blob with the
   * identity generated in step 1 (`myRecipient.identityFilePath`) to recover the S3 target.
   * Deliberately does NOT act on it yet — `age -r <recipient>` encryption proves this blob was
   * encrypted to this device's own identity, but proves nothing about who encrypted it. Stops
   * here and hands the decoded target to `handleConfirmJoin` below, which only runs on an
   * explicit second click, so the human gets a chance to notice an unexpected team/endpoint
   * before the app connects to it — same human-verification step the manual-entry fallback
   * already requires implicitly (the admin reads the values out loud/in chat, the joiner types
   * them in and can compare).
   */
  const handleDecodeInvite = async () => {
    if (!myRecipient || !selfRecipientId.trim() || !inviteText.trim()) return;
    setJoinTargetError(null);
    setDecoding(true);
    setError(null);
    try {
      const decoded = await window.multissh.teamVaultDecodeInvite(inviteText, myRecipient.identityFilePath);
      setDecodedInvite(decoded);
    } catch (err) {
      setJoinTargetError(
        describeIpcError(
          err,
          'Could not read this invite — check it was pasted completely, or that it matches your identity.'
        )
      );
    } finally {
      setDecoding(false);
    }
  };

  /** Step two: the human has reviewed `decodedInvite`'s team id/endpoint/bucket below and
   * confirmed it's the team they expected — now actually sets the target, pulls, and
   * auto-unlocks with the identity from step 1. */
  const handleConfirmJoin = async () => {
    if (!decodedInvite || !myRecipient || !selfRecipientId.trim()) return;
    const { vaultId, target, remoteBasePath } = decodedInvite;
    setJoinTargetError(null);
    setJoining(true);
    setError(null);
    try {
      await window.multissh.teamVaultSetTarget(vaultId, target, remoteBasePath);
      const hasRemote = await window.multissh.teamVaultHasRemoteVault(vaultId);
      if (!hasRemote) {
        setJoinTargetError('No Team Vault found at that location — check the invite with your admin.');
        return;
      }
      await window.multissh.teamVaultPull(vaultId);
      await window.multissh.teamVaultUnlock(vaultId, selfRecipientId.trim(), myRecipient.identityFilePath);
      await load();
      setSelectedVaultId(vaultId);
      setMode({ kind: 'list' });
      resetJoinCreateState();
    } catch (err) {
      setJoinTargetError(describeIpcError(err, 'Failed to join the existing Team Vault'));
    } finally {
      setJoining(false);
    }
  };

  // Quick Lock/Unlock from the list row (§15), without opening the detail view. Unlock only
  // fires when a prefilled identity is already available (same gate the Connection Manager's own
  // quick "Unlock as <id>" button uses) — a vault needing a manually-entered identity still has
  // to be unlocked from its detail view's full form.
  const handleQuickLock = async (vaultId: string) => {
    setBusyVaultId(vaultId);
    setError(null);
    try {
      await window.multissh.teamVaultLock(vaultId);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to lock this team'));
    } finally {
      setBusyVaultId(null);
    }
  };

  const handleQuickUnlock = async (v: TeamVaultStatus) => {
    if (!v.vaultId || !v.selfRecipientId || !v.selfIdentityFilePath) return;
    setBusyVaultId(v.vaultId);
    setError(null);
    try {
      await window.multissh.teamVaultUnlock(v.vaultId, v.selfRecipientId, v.selfIdentityFilePath);
      await load();
    } catch (err) {
      setError(describeIpcError(err, 'Failed to unlock this team'));
    } finally {
      setBusyVaultId(null);
    }
  };

  const handleForget = async (vaultId: string) => {
    if (
      !(await confirm({
        title: 'Remove team from this device',
        message: 'Removes this team\'s local file, identity, and configuration from this device. Lock it first if it\'s currently unlocked.',
      }))
    ) {
      return;
    }
    setBusyVaultId(vaultId);
    setError(null);
    try {
      await window.multissh.teamVaultForget(vaultId);
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        message.includes('Lock this Team Vault')
          ? 'Lock this team first (open it and lock it), then try removing it again.'
          : describeIpcError(err, 'Failed to remove this team from this device')
      );
    } finally {
      setBusyVaultId(null);
    }
  };

  if (selectedVaultId) {
    return (
      <TeamVaultDetailPanel
        key={selectedVaultId}
        vaultId={selectedVaultId}
        onBack={() => {
          setSelectedVaultId(null);
          void load();
        }}
        onVaultRemoved={() => {
          setSelectedVaultId(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold text-txt-primary">
          <Shield className="h-4 w-4 text-sky-400" />
          Team Vault
        </h3>
        <p className="mt-1 text-xs text-txt-muted">
          Share connection profiles and system credentials with your team, unlocked per-member by
          PIV hardware key instead of a shared password. You can belong to more than one team.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {mode.kind === 'list' && (
        <>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                resetJoinCreateState();
                setMode({ kind: 'create' });
              }}
              className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Create a new team
            </button>
            <button
              type="button"
              onClick={() => {
                resetJoinCreateState();
                setMode({ kind: 'join' });
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Join an existing team
            </button>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading teams...
            </div>
          ) : vaults.length === 0 ? (
            <p className="py-6 text-center text-xs text-txt-muted">
              No Team Vault has been set up on this machine yet. Create one, or join a team that
              already has one.
            </p>
          ) : (
            <div className="space-y-1.5">
              {vaults.map((v) => (
                <div
                  key={v.vaultId}
                  className="flex items-center gap-2 rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs"
                >
                  <button
                    type="button"
                    onClick={() => setSelectedVaultId(v.vaultId!)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-sky-400"
                  >
                    {v.unlocked ? (
                      <Unlock className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                    ) : (
                      <Lock className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-txt-primary">
                        {v.vaultName || v.vaultId}
                      </span>
                      <span className="block text-txt-muted">
                        {(v.members?.length ?? 0)} member{(v.members?.length ?? 0) === 1 ? '' : 's'}
                        {v.selfRole ? ` · ${v.selfRole}` : ''}
                      </span>
                      {v.vaultId && syncPreviews[v.vaultId] && (
                        <span
                          className={
                            syncPreviews[v.vaultId].remoteChanged
                              ? 'block text-amber-400'
                              : syncPreviews[v.vaultId].hasUnpushedLocalChanges
                                ? 'block text-sky-400'
                                : 'block text-emerald-400'
                          }
                        >
                          {syncPreviews[v.vaultId].remoteChanged
                            ? 'Remote has a newer version'
                            : syncPreviews[v.vaultId].hasUnpushedLocalChanges
                              ? 'Local changes not pushed'
                              : 'Up to date'}
                        </span>
                      )}
                    </span>
                  </button>
                  {v.unlocked ? (
                    <button
                      type="button"
                      onClick={() => void handleQuickLock(v.vaultId!)}
                      disabled={busyVaultId === v.vaultId}
                      title="Lock this team now"
                      className="shrink-0 rounded-lg border border-border-subtle p-1.5 text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                    >
                      {busyVaultId === v.vaultId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                    </button>
                  ) : (
                    v.selfRecipientId &&
                    v.selfIdentityFilePath && (
                      <button
                        type="button"
                        onClick={() => void handleQuickUnlock(v)}
                        disabled={busyVaultId === v.vaultId}
                        title={`Unlock as ${v.selfRecipientId}`}
                        className="shrink-0 rounded-lg border border-border-subtle p-1.5 text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                      >
                        {busyVaultId === v.vaultId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Unlock className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )
                  )}
                  {!v.unlocked && (
                    <button
                      type="button"
                      onClick={() => void handleForget(v.vaultId!)}
                      disabled={busyVaultId === v.vaultId}
                      title="Remove this team from this device"
                      className="shrink-0 rounded-lg border border-red-900/60 p-1.5 text-red-300 hover:bg-red-950/40 disabled:opacity-50"
                    >
                      {busyVaultId === v.vaultId ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {mode.kind === 'create' && (
        <div className="space-y-3 rounded-lg border border-border-subtle bg-app-surface p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-txt-secondary">Create a new team</p>
            <button
              type="button"
              onClick={() => {
                setMode({ kind: 'list' });
                resetJoinCreateState();
              }}
              className="text-xs text-txt-muted underline hover:text-txt-secondary"
            >
              Cancel
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleEnroll()}
            disabled={enrolling}
            className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
          >
            {enrolling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5 text-sky-400" />}
            Generate my Team Vault ID
          </button>

          {myRecipient && (
            <div className="space-y-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-3">
              <p className="break-all text-xs text-emerald-300">{myRecipient.recipient}</p>
              <div>
                <label htmlFor="team-create-recipient-id" className="mb-1 block text-xs font-medium text-txt-secondary">Your recipient id</label>
                <input
                  id="team-create-recipient-id"
                  type="text"
                  value={selfRecipientId}
                  onChange={(e) => setSelfRecipientId(e.target.value)}
                  placeholder="e.g. alice@piv:yubikey-1"
                  className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                />
              </div>
              <div>
                <label htmlFor="team-create-name" className="mb-1 block text-xs font-medium text-txt-secondary">Team name (optional)</label>
                <input
                  id="team-create-name"
                  type="text"
                  value={vaultNameDraft}
                  onChange={(e) => setVaultNameDraft(e.target.value)}
                  placeholder="e.g. Acme Infra Team"
                  maxLength={200}
                  className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleCreateVault()}
                disabled={creating || !selfRecipientId.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Create team
              </button>
            </div>
          )}
        </div>
      )}

      {mode.kind === 'join' && (
        <div className="space-y-3 rounded-lg border border-border-subtle bg-app-surface p-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-txt-secondary">Join an existing team</p>
            <button
              type="button"
              onClick={() => {
                setMode({ kind: 'list' });
                resetJoinCreateState();
              }}
              className="text-xs text-txt-muted underline hover:text-txt-secondary"
            >
              Cancel
            </button>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-txt-secondary">
              Step 1 — generate your recipient and send it to that team's admin.
            </p>
            <button
              type="button"
              onClick={() => void handleEnroll()}
              disabled={enrolling}
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
            >
              {enrolling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Fingerprint className="h-3.5 w-3.5 text-sky-400" />}
              Generate my Team Vault ID
            </button>
            {myRecipient && (
              <div className="space-y-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-3">
                <p className="break-all text-xs text-emerald-300">{myRecipient.recipient}</p>
                <div>
                  <label htmlFor="team-join-recipient-id" className="mb-1 block text-xs font-medium text-txt-secondary">Your recipient id</label>
                  <input
                    id="team-join-recipient-id"
                    type="text"
                    value={selfRecipientId}
                    onChange={(e) => setSelfRecipientId(e.target.value)}
                    placeholder="e.g. alice@piv:yubikey-1"
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyJoinInfo()}
                  disabled={!selfRecipientId.trim()}
                  title="Copy a join-info blob to send to that team's admin"
                  className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                >
                  {joinInfoCopied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {joinInfoCopied ? 'Copied' : 'Copy join info'}
                </button>
              </div>
            )}
          </div>

          <div className="space-y-2 border-t border-border-subtle pt-3">
            <p className="text-xs text-txt-secondary">
              Step 2 — once their admin has added you as a member, ask them for an{' '}
              <strong>invite</strong> (copied from their Team Vault detail view's "Copy invite"
              next to your name) and paste it below. It carries the team's S3 target, so you don't
              need to type it in by hand.
            </p>
            {joinTargetError && (
              <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {joinTargetError}
              </div>
            )}
            {decodedInvite ? (
              <div className="space-y-2 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                <p className="text-xs font-medium text-amber-200">
                  Check this matches the team your admin told you about before continuing — this
                  invite was readable with your identity, but that only proves who it's addressed
                  to, not who sent it.
                </p>
                <dl className="space-y-1 text-xs">
                  <div className="flex gap-2">
                    <dt className="text-txt-muted">Team ID</dt>
                    <dd className="break-all font-mono text-txt-secondary">{decodedInvite.vaultId}</dd>
                  </div>
                  {decodedInvite.target.s3Config?.endpoint && (
                    <div className="flex gap-2">
                      <dt className="text-txt-muted">Endpoint</dt>
                      <dd className="break-all text-txt-secondary">{decodedInvite.target.s3Config.endpoint}</dd>
                    </div>
                  )}
                  {decodedInvite.target.s3Config?.region && (
                    <div className="flex gap-2">
                      <dt className="text-txt-muted">Region</dt>
                      <dd className="text-txt-secondary">{decodedInvite.target.s3Config.region}</dd>
                    </div>
                  )}
                  {decodedInvite.remoteBasePath && (
                    <div className="flex gap-2">
                      <dt className="text-txt-muted">Path</dt>
                      <dd className="break-all text-txt-secondary">{decodedInvite.remoteBasePath}</dd>
                    </div>
                  )}
                </dl>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleConfirmJoin()}
                    disabled={joining}
                    className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                  >
                    {joining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
                    This is my team — join
                  </button>
                  <button
                    type="button"
                    onClick={() => setDecodedInvite(null)}
                    disabled={joining}
                    className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                  >
                    Not my team — discard
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label htmlFor="team-join-invite" className="mb-1 block text-xs font-medium text-txt-secondary">Paste invite from your admin</label>
                  <textarea
                    id="team-join-invite"
                    value={inviteText}
                    onChange={(e) => setInviteText(e.target.value)}
                    placeholder="sshs3 Team Vault invite for ..."
                    rows={4}
                    disabled={decoding || !myRecipient}
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted disabled:opacity-50"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void handleDecodeInvite()}
                  disabled={decoding || !myRecipient || !selfRecipientId.trim() || !inviteText.trim()}
                  title={
                    !myRecipient || !selfRecipientId.trim() ? 'Generate your Team Vault ID first (step 1)' : undefined
                  }
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {decoding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
                  Read invite
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => setShowManualJoin((prev) => !prev)}
              className="text-xs text-txt-muted underline hover:text-txt-secondary"
            >
              {showManualJoin ? 'Hide manual setup' : '...or configure manually'}
            </button>
            {showManualJoin && (
              <div className="space-y-2 rounded-lg border border-border-subtle bg-app-input/40 p-3">
                <p className="text-xs text-txt-muted">
                  Fallback for a broken invite or a special case: enter the team's{' '}
                  <strong>Team ID</strong> (shown in their Team Vault detail view) and its S3
                  target by hand.
                </p>
                <div>
                  <label htmlFor="team-join-vault-id" className="mb-1 block text-xs font-medium text-txt-secondary">Team ID</label>
                  <input
                    id="team-join-vault-id"
                    type="text"
                    value={joinVaultId}
                    onChange={(e) => setJoinVaultId(e.target.value)}
                    placeholder="vlt_..."
                    disabled={joining}
                    className="w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 font-mono text-xs text-txt-primary outline-none focus:border-sky-500 placeholder-txt-muted disabled:opacity-50"
                  />
                </div>
                <SyncTargetForm draft={joinTargetDraft} onChange={setJoinTargetDraft} disabled={joining} />
                <button
                  type="button"
                  onClick={() => void handleJoinExistingVault()}
                  disabled={joining || !joinVaultId.trim()}
                  className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover disabled:opacity-50"
                >
                  {joining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
                  Pull and join
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {recoveryIdentity && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4">
          <div
            ref={recoveryDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Save your recovery key"
            className="w-full max-w-lg space-y-3 rounded-xl border border-amber-500/40 bg-app-surface p-4 shadow-2xl"
          >
            <div className="flex items-center gap-2 text-amber-400">
              <KeyRound className="h-4 w-4" />
              <h4 className="text-sm font-semibold">Save your recovery key now</h4>
            </div>
            <p className="text-xs text-txt-secondary">
              This is the Team Vault's recovery identity. It is shown <strong>once</strong> and
              never saved by the app — print it and store it somewhere safe (e.g. a safe), per
              docs/team-vault-plan.md §4.1. Anyone who recovers this text can decrypt the vault.
            </p>
            <div className="relative">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border-subtle bg-app-input p-3 pr-20 text-xs text-txt-primary">
                {recoveryIdentity}
              </pre>
              <button
                type="button"
                onClick={() => void handleCopyRecovery()}
                className="absolute right-2 top-2 flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2 py-1 text-2xs font-medium text-txt-secondary hover:bg-app-surface-hover"
              >
                {recoveryCopied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {recoveryCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <label className="flex items-center gap-2 text-xs text-txt-secondary">
              <input
                type="checkbox"
                checked={recoverySaved}
                onChange={(e) => setRecoverySaved(e.target.checked)}
              />
              I have printed/saved this recovery key
            </label>
            <div className="flex justify-end">
              <button
                type="button"
                disabled={!recoverySaved}
                onClick={() => {
                  setRecoveryIdentity(null);
                  setMode({ kind: 'list' });
                  resetJoinCreateState();
                  if (pendingVaultId) {
                    setSelectedVaultId(pendingVaultId);
                    setPendingVaultId(null);
                  }
                }}
                className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
