import React, { useEffect, useState } from 'react';
import {
  Cloud,
  Server,
  Loader2,
  UploadCloud,
  DownloadCloud,
  ShieldAlert,
  CheckCircle2,
  Pencil,
  RefreshCw,
  ArrowUpCircle,
  ArrowDownCircle,
  GitCompare,
  ChevronDown,
  ChevronUp,
  KeyRound,
  Trash2,
  AlertTriangle,
  Lock,
} from 'lucide-react';
import type { ProfileSyncStatus, SyncComparisonResult, KnownHostsConflict } from '@shared/types/sync';
import type { DetectedSmartcardLib } from '@shared/types/ssh';
import {
  SyncTargetForm,
  emptySyncTargetDraft,
  draftFromTargetConfig,
  buildSyncTarget,
  validateSyncTargetDraft,
  type SyncTargetDraft,
} from './SyncTargetForm';
import { MasterPasswordDialog } from './MasterPasswordDialog';
import { Button } from '../ui/Button';
import { useConfirm } from '../ConfirmDialog';
import { formatSyncError } from '../../lib/syncErrors';
import { formatDateTime as formatDateTimeCanonical } from '../../lib/dateFormat';
import { formatRelativeTime } from '../../lib/relativeTime';
import { createRendererLogger } from '../../lib/log';
const log = createRendererLogger('SyncSettingsPanel');

function formatRelative(iso?: string): string {
  if (!iso) return 'Never';
  return formatRelativeTime(iso, { dateAfterDays: Infinity }) || iso;
}

// Thin wrapper for this panel's own "Never" fallback (LOW finding, code
// review — the actual date formatting now lives in one place, lib/dateFormat.ts).
function formatDateTime(iso?: string): string {
  if (!iso) return 'Never';
  return formatDateTimeCanonical(iso);
}

function formatTimestampWithRelative(iso?: string): string {
  if (!iso) return 'Never';
  const rel = formatRelative(iso);
  const dt = formatDateTime(iso);
  return `${dt} (${rel})`;
}

export const SyncSettingsPanel: React.FC = () => {
  const [status, setStatus] = useState<ProfileSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [comparison, setComparison] = useState<SyncComparisonResult | null>(null);
  const [checkingSync, setCheckingSync] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState<SyncTargetDraft>(emptySyncTargetDraft());
  const [targetError, setTargetError] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);

  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<KnownHostsConflict[]>([]);

  const [togglingAutoSync, setTogglingAutoSync] = useState(false);
  const [unlockingSmartcard, setUnlockingSmartcard] = useState(false);
  const [linkingSmartcard, setLinkingSmartcard] = useState(false);
  const [unlinkingSmartcard, setUnlinkingSmartcard] = useState(false);
  const confirm = useConfirm();
  const [isLinkingDialog, setIsLinkingDialog] = useState(false);
  const [detectedLibs, setDetectedLibs] = useState<DetectedSmartcardLib[]>([]);
  const [selectedLibPath, setSelectedLibPath] = useState('');

  // Which PKCS#11 module to link is the user's call when several are installed (e.g. OpenSC and
  // Yubico's libykcs11) — the first detected one is not necessarily the card they actually use.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.multissh?.smartcardDetect?.(), window.multissh?.settingsGet?.()]).then(([libs, settings]) => {
      if (cancelled || !libs) return;
      setDetectedLibs(libs);
      // Prefer the driver chosen under Settings > Security (if it's still installed) over the first detected one.
      const preferred = libs.find((l) => l.path === settings?.smartcardLibPath)?.path;
      setSelectedLibPath((prev) => prev || preferred || libs[0]?.path || '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState<string | null>(null);
  const [wipeWarnings, setWipeWarnings] = useState<string[]>([]);

  const checkSync = async () => {
    setCheckingSync(true);
    setCheckError(null);
    try {
      const res = await window.multissh?.profileSyncCompare?.();
      if (res) {
        setComparison(res);
      }
    } catch (err: any) {
      setCheckError(formatSyncError(err, 'Failed to check sync status.').message);
    } finally {
      setCheckingSync(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const s = await window.multissh?.profileSyncStatus?.();
      if (s) {
        setStatus(s);
        if (s.targetConfig) {
          setTargetDraft(draftFromTargetConfig(s.targetConfig, s.remoteBasePath ?? ''));
        }
        if (s.comparison) {
          setComparison(s.comparison);
        }
        if (!s.configured) {
          setEditingTarget(true);
        } else if (s.topologyUnlocked && s.credentialsUnlocked) {
          void checkSync();
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const unsub = window.multissh?.onProfileSyncStatus?.((updatedStatus) => {
      setStatus(updatedStatus);
      if (updatedStatus.comparison) {
        setComparison(updatedStatus.comparison);
      }
    });
    return () => {
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only on initial mount to load sync configuration
  }, []);

  const handleToggleAutoSync = async (enabled: boolean) => {
    setTogglingAutoSync(true);
    try {
      const updated = await window.multissh?.profileSyncSetAutoSync?.(enabled);
      if (updated) {
        setStatus(updated);
      }
      setActionMessage(enabled ? 'Automatic synchronization enabled.' : 'Automatic synchronization disabled.');
    } catch (err: any) {
      setActionError(formatSyncError(err, 'Failed to update auto-sync setting.').message);
    } finally {
      setTogglingAutoSync(false);
    }
  };

  const handleSaveTarget = async () => {
    const validationError = validateSyncTargetDraft(targetDraft);
    if (validationError) {
      setTargetError(validationError);
      return;
    }
    setTargetError(null);
    setSavingTarget(true);
    try {
      await window.multissh?.profileSyncSetup?.({
        target: buildSyncTarget(targetDraft),
        remoteBasePath: targetDraft.remoteBasePath,
      });
      setEditingTarget(false);
      setActionMessage('Sync target saved.');
      await load();
    } catch (err: any) {
      setTargetError(formatSyncError(err, 'Failed to save the sync target.').message);
    } finally {
      setSavingTarget(false);
    }
  };

  const handleSmartcardUnlock = async () => {
    setUnlockingSmartcard(true);
    setEnableError(null);
    setActionError(null);
    setActionMessage(null);
    try {
      const s = await window.multissh?.profileSyncUnlockSmartcard?.();
      if (s) {
        setStatus(s);
        if (s.comparison) {
          setComparison(s.comparison);
        } else {
          void checkSync();
        }
      }
      setPasswordDialogOpen(false);
      setIsLinkingDialog(false);
      setActionMessage('Sync unlocked with smartcard.');
    } catch (err: any) {
      const formatted = formatSyncError(err, 'Failed to unlock sync with smartcard.').message;
      setEnableError(formatted);
      setActionError(formatted);
    } finally {
      setUnlockingSmartcard(false);
    }
  };

  const handleLinkSmartcard = async (passwords?: { topologyPassword: string; credentialsPassword: string }) => {
    setLinkingSmartcard(true);
    setActionError(null);
    setActionMessage(null);
    try {
      let libPath = selectedLibPath || status?.smartcardLibPath;
      if (!libPath) {
        const detected = await window.multissh?.smartcardDetect?.();
        libPath = detected?.[0]?.path;
      }
      if (!libPath) {
        throw new Error('No smartcard PKCS#11 library found. Make sure your card or reader is connected.');
      }
      const s = await window.multissh?.profileSyncLinkSmartcard?.({
        pkcs11LibPath: libPath,
        passwords,
      });
      if (s) setStatus(s);
      setActionMessage('Smartcard linked to sync.');
    } catch (err: any) {
      setActionError(formatSyncError(err, 'Failed to link smartcard.').message);
      throw err;
    } finally {
      setLinkingSmartcard(false);
    }
  };

  const handleUnlinkSmartcard = async () => {
    const confirmed = await confirm({
      title: 'Unlink smartcard',
      message:
        'Remove the smartcard from profile sync? Sync will ask for the master password instead of the card until you link a card again.',
      confirmLabel: 'Unlink card',
    });
    if (!confirmed) return;
    setUnlinkingSmartcard(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const s = await window.multissh?.profileSyncUnlinkSmartcard?.();
      if (s) setStatus(s);
      setActionMessage('Smartcard unlinked from sync.');
    } catch (err: any) {
      setActionError(formatSyncError(err, 'Failed to unlink smartcard.').message);
    } finally {
      setUnlinkingSmartcard(false);
    }
  };

  const handlePasswordSubmit = async (
    passwords: { topologyPassword: string; credentialsPassword: string },
    options?: { linkSmartcard?: boolean }
  ) => {
    setEnabling(true);
    setEnableError(null);
    try {
      if (isLinkingDialog) {
        await handleLinkSmartcard(passwords);
        setPasswordDialogOpen(false);
        setIsLinkingDialog(false);
        return;
      }

      const s = await window.multissh?.profileSyncEnable?.(passwords);
      setStatus(s);
      if (s?.comparison) {
        setComparison(s.comparison);
      } else {
        void checkSync();
      }

      if (options?.linkSmartcard) {
        try {
          await handleLinkSmartcard(passwords);
        } catch (linkErr: any) {
          log.error('Failed to link smartcard after enabling sync:', linkErr);
        }
      }

      setPasswordDialogOpen(false);
      setActionMessage('Sync unlocked and up to date.');
    } catch (err: any) {
      setEnableError(formatSyncError(err, 'Failed to unlock sync.').message);
    } finally {
      setEnabling(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const s = await window.multissh?.profileSyncPush?.();
      setStatus(s);
      if (s?.comparison) {
        setComparison(s.comparison);
      } else {
        void checkSync();
      }
      setActionMessage('Pushed local changes to the remote.');
    } catch (err: any) {
      setActionError(formatSyncError(err, 'Push failed.').message);
    } finally {
      setPushing(false);
    }
  };

  const handlePull = async () => {
    setPulling(true);
    setActionError(null);
    setActionMessage(null);
    setConflicts([]);
    try {
      const result = await window.multissh?.profileSyncPull?.();
      setStatus(result);
      if (result?.comparison) {
        setComparison(result.comparison);
      } else {
        void checkSync();
      }
      setConflicts(result.sshNativeConflicts ?? []);
      setActionMessage(
        result.changedCategories.length > 0
          ? `Pulled changes: ${result.changedCategories.join(', ')}.`
          : 'Already up to date.'
      );
    } catch (err: any) {
      setActionError(formatSyncError(err, 'Pull failed.').message);
    } finally {
      setPulling(false);
    }
  };

  const handleWipe = async () => {
    setWiping(true);
    setWipeError(null);
    setWipeWarnings([]);
    try {
      const result = await window.multissh?.profileSyncWipe?.();
      if (result) {
        setStatus(result);
        if (result.remoteWipeErrors?.length) {
          setWipeWarnings(result.remoteWipeErrors);
        }
      }
      setComparison(null);
      setConflicts([]);
      setActionMessage(null);
      setActionError(null);
      setConfirmingWipe(false);
      setEditingTarget(true);
      setTargetDraft(emptySyncTargetDraft());
    } catch (err: any) {
      setWipeError(formatSyncError(err, 'Failed to delete sync data.').message);
    } finally {
      setWiping(false);
    }
  };

  if (loading) {
    return <div className="py-10 text-center text-xs text-txt-muted">Loading sync status...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-xs text-txt-muted leading-relaxed">
          Back up and sync your connection profiles, dotfile pools, and settings to your own S3 bucket or SFTP
          server. Everything is client-side encrypted before leaving your device using your master password.
        </p>
      </div>

      {status?.configured && !editingTarget && (
        <div className="rounded-lg border border-border-subtle bg-app-surface p-3.5 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-txt-primary font-medium">
              {status.target?.type === 's3' ? <Cloud className="h-4 w-4 text-sky-400" /> : <Server className="h-4 w-4 text-sky-400" />}
              <span>{status.target?.type === 's3' ? 'S3 bucket' : 'SFTP server'}</span>
            </div>
            <button
              type="button"
              onClick={() => {
                setEditingTarget(true);
                if (status.targetConfig) {
                  setTargetDraft(draftFromTargetConfig(status.targetConfig, status.remoteBasePath ?? ''));
                } else {
                  setTargetDraft((prev) => ({ ...prev, remoteBasePath: status.remoteBasePath ?? prev.remoteBasePath }));
                }
              }}
              className="flex items-center gap-1 text-xs text-sky-400 hover:underline"
            >
              <Pencil className="h-3 w-3" />
              Change target
            </button>
          </div>
          {status.remoteBasePath && <div className="font-mono text-xs text-txt-muted">{status.remoteBasePath}</div>}

          <div className="pt-1 text-xs">
            {status.topologyUnlocked && status.credentialsUnlocked ? (
              <div className="flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span className="font-medium">Sync unlocked</span>
                <span className="text-2xs text-txt-muted">(Profiles & credentials ready)</span>
              </div>
            ) : !status.topologyUnlocked && !status.credentialsUnlocked ? (
              <div className="flex items-center gap-1.5 text-amber-400">
                <Lock className="h-3.5 w-3.5" />
                <span className="font-medium">Sync locked</span>
                <span className="text-2xs text-txt-muted">(Profiles & credentials encrypted — unlock below)</span>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="flex items-center gap-1.5">
                  {status.topologyUnlocked ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
                  )}
                  <span className="text-txt-secondary">
                    Profiles {status.topologyUnlocked ? 'unlocked' : 'locked'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  {status.credentialsUnlocked ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
                  )}
                  <span className="text-txt-secondary">
                    Credentials {status.credentialsUnlocked ? 'unlocked' : 'locked'}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div className="text-xs text-txt-muted pt-1 border-t border-divider">
            Last sync: {formatTimestampWithRelative(status.lastSyncAt)}
            {status.autoSyncError && (
              <div role="alert" className="text-red-400 pt-1">
                Automatic sync failed: {status.autoSyncError}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-divider">
            <div className="space-y-0.5">
              <div className="text-xs font-medium text-txt-primary flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5 text-sky-400" />
                <span>Auto-sync changes</span>
              </div>
              <p className="text-2xs text-txt-muted">
                Automatically pushes changes to remote when profiles or dotfiles are modified (when unlocked).
              </p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                aria-label="Auto-sync changes"
                checked={Boolean(status.autoSync)}
                onChange={(e) => void handleToggleAutoSync(e.target.checked)}
                disabled={togglingAutoSync}
                className="peer sr-only"
              />
              <div className="peer h-5 w-9 rounded-full bg-app-input border border-border-subtle after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-txt-muted after:transition-all after:content-[''] peer-checked:bg-sky-600 peer-checked:after:translate-x-full peer-checked:after:bg-white peer-focus-visible:ring-2 peer-focus-visible:ring-sky-500 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-app-surface" />
            </label>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-divider">
            <div className="space-y-0.5">
              <div className="text-xs font-medium text-txt-primary flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-sky-400" />
                <span>Smartcard / Hardware token</span>
              </div>
              <p className="text-2xs text-txt-muted">
                {status.smartcardLinked
                  ? `Linked to smartcard (${status.smartcardLibPath ? status.smartcardLibPath.split(/[\\/]/).pop() : 'PKCS#11'}). You can unlock sync with your card PIN.`
                  : status.smartcardAvailable
                    ? 'Card reader detected. Link your smartcard to unlock sync without typing master passwords.'
                    : 'No smartcard PKCS#11 module detected.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!status.smartcardLinked && detectedLibs.length > 1 && (
                <select
                  value={selectedLibPath}
                  onChange={(e) => setSelectedLibPath(e.target.value)}
                  disabled={linkingSmartcard}
                  title={selectedLibPath}
                  aria-label="Smartcard PKCS#11 library"
                  className="max-w-[180px] rounded border border-border-subtle bg-app px-1.5 py-1 text-2xs text-txt-primary"
                >
                  {detectedLibs.map((lib) => (
                    <option key={lib.path} value={lib.path}>
                      {lib.name} — {lib.path.split(/[\\/]/).pop()}
                    </option>
                  ))}
                </select>
              )}
              {status.smartcardLinked ? (
                <button
                  type="button"
                  onClick={handleUnlinkSmartcard}
                  disabled={unlinkingSmartcard}
                  className="rounded px-2.5 py-1 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                >
                  {unlinkingSmartcard ? 'Unlinking...' : 'Unlink card'}
                </button>
              ) : status.smartcardAvailable ? (
                <button
                  type="button"
                  onClick={() => {
                    setIsLinkingDialog(true);
                    setPasswordDialogOpen(true);
                  }}
                  disabled={linkingSmartcard}
                  className="rounded px-2.5 py-1 text-xs font-medium text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 transition-colors disabled:opacity-50"
                >
                  {linkingSmartcard ? 'Linking...' : 'Link card'}
                </button>
              ) : null}
            </div>
          </div>

          {status.topologyUnlocked && status.credentialsUnlocked && (
            <div className="rounded-lg border border-border-subtle bg-app/50 p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {checkingSync ? (
                    <div className="flex items-center gap-1.5 text-txt-muted text-xs">
                      <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                      <span>Checking remote sync state...</span>
                    </div>
                  ) : comparison ? (
                    <div className="flex items-center gap-2">
                      {comparison.state === 'in_sync' && (
                        <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-xs font-medium text-emerald-400">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          In sync with remote
                        </span>
                      )}
                      {comparison.state === 'ahead' && (
                        <span className="inline-flex items-center gap-1.5 rounded bg-sky-500/10 border border-sky-500/20 px-2.5 py-0.5 text-xs font-medium text-sky-400">
                          <ArrowUpCircle className="h-3.5 w-3.5" />
                          Client ahead ({comparison.aheadCount} unpushed {comparison.aheadCount === 1 ? 'change' : 'changes'})
                        </span>
                      )}
                      {comparison.state === 'behind' && (
                        <span className="inline-flex items-center gap-1.5 rounded bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-xs font-medium text-amber-400">
                          <ArrowDownCircle className="h-3.5 w-3.5" />
                          Client behind ({comparison.behindCount} remote {comparison.behindCount === 1 ? 'change' : 'changes'})
                        </span>
                      )}
                      {comparison.state === 'diverged' && (
                        <span className="inline-flex items-center gap-1.5 rounded bg-purple-500/10 border border-purple-500/20 px-2.5 py-0.5 text-xs font-medium text-purple-400">
                          <GitCompare className="h-3.5 w-3.5" />
                          Diverged ({comparison.aheadCount} ahead, {comparison.behindCount} behind)
                        </span>
                      )}
                      {comparison.state === 'not_initialized' && (
                        <span className="inline-flex items-center gap-1.5 rounded bg-indigo-500/10 border border-indigo-500/20 px-2.5 py-0.5 text-xs font-medium text-indigo-400">
                          <UploadCloud className="h-3.5 w-3.5" />
                          Remote not initialized ({comparison.aheadCount} {comparison.aheadCount === 1 ? 'item' : 'items'} to push)
                        </span>
                      )}
                      {comparison.state === 'error' && (
                        <span className="inline-flex items-center gap-1.5 rounded bg-red-500/10 border border-red-500/20 px-2.5 py-0.5 text-xs font-medium text-red-400">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Sync check failed
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-txt-muted">Sync status not checked yet</span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void checkSync()}
                  disabled={checkingSync || pushing || pulling}
                  title="Check status against remote"
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-txt-muted hover:text-txt-primary hover:bg-app-surface transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${checkingSync ? 'animate-spin' : ''}`} />
                  <span>Check</span>
                </button>
              </div>

              {comparison && comparison.checkedAt && (
                <div className="flex items-center justify-between text-2xs text-txt-muted">
                  <span>Checked: {formatDateTime(comparison.checkedAt)}</span>
                  {(comparison.aheadCount > 0 || comparison.behindCount > 0) && (
                    <button
                      type="button"
                      onClick={() => setShowDetails((prev) => !prev)}
                      className="flex items-center gap-0.5 text-sky-400 hover:underline"
                    >
                      <span>{showDetails ? 'Hide details' : 'Show details'}</span>
                      {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                    </button>
                  )}
                </div>
              )}

              {showDetails && comparison && (comparison.aheadCount > 0 || comparison.behindCount > 0) && (
                <div className="space-y-1.5 pt-1.5 border-t border-divider text-xs">
                  {comparison.categories.map((cat) => {
                    if (cat.state === 'in_sync' && cat.ahead === 0 && cat.behind === 0) return null;
                    return (
                      <div key={cat.category} className="flex items-start justify-between gap-2 text-txt-secondary">
                        <span className="font-medium capitalize">{cat.category.replace('-', ' ')}:</span>
                        <span className="text-txt-muted text-right">
                          {cat.state === 'ahead' && `${cat.ahead} to push`}
                          {cat.state === 'behind' && `${cat.behind} to pull`}
                          {cat.state === 'diverged' && `${cat.ahead} to push, ${cat.behind} to pull`}
                          {cat.details && cat.details.length > 0 && (
                            <span className="block text-2xs text-txt-muted/80">{cat.details.join(', ')}</span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {checkError && <p role="alert" className="text-xs text-red-400">{checkError}</p>}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {(!status.topologyUnlocked || !status.credentialsUnlocked) && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setIsLinkingDialog(false);
                    setPasswordDialogOpen(true);
                  }}
                  className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
                >
                  {status.hasLocalSalts ? 'Unlock sync' : 'Set up master passwords'}
                </button>
                {(status.smartcardAvailable || status.smartcardLinked) && (
                  <button
                    type="button"
                    onClick={handleSmartcardUnlock}
                    disabled={unlockingSmartcard || enabling}
                    className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/20 transition-colors disabled:opacity-50"
                  >
                    {unlockingSmartcard ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <KeyRound className="h-3.5 w-3.5 text-sky-400" />
                    )}
                    <span>Unlock with Smartcard</span>
                  </button>
                )}
              </>
            )}
            {status.topologyUnlocked && status.credentialsUnlocked && (
              <>
                <button
                  type="button"
                  onClick={handlePush}
                  disabled={pushing || checkingSync}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    comparison?.aheadCount && comparison.aheadCount > 0
                      ? 'border-sky-500/50 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20'
                      : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                  }`}
                >
                  {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                  <span>Push</span>
                  {comparison?.aheadCount && comparison.aheadCount > 0 ? (
                    <span className="rounded bg-sky-500/20 px-1.5 py-0.2 text-2xs font-semibold text-sky-300">
                      {comparison.aheadCount}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={handlePull}
                  disabled={pulling || checkingSync}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                    comparison?.behindCount && comparison.behindCount > 0
                      ? 'border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
                      : 'border-border-subtle bg-app-surface text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary'
                  }`}
                >
                  {pulling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <DownloadCloud className="h-3.5 w-3.5" />}
                  <span>Pull</span>
                  {comparison?.behindCount && comparison.behindCount > 0 ? (
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.2 text-2xs font-semibold text-amber-300">
                      {comparison.behindCount}
                    </span>
                  ) : null}
                </button>
              </>
            )}
          </div>

          {actionMessage && <p className="text-xs text-emerald-400">{actionMessage}</p>}
          {actionError && <p role="alert" className="text-xs text-red-400">{actionError}</p>}

          {conflicts.length > 0 && (
            <div className="space-y-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
              <div className="flex items-center gap-1.5 text-amber-300 font-medium text-xs">
                <ShieldAlert className="h-3.5 w-3.5" />
                {conflicts.length} known_hosts conflict{conflicts.length > 1 ? 's' : ''} — not applied automatically
              </div>
              {conflicts.map((c) => (
                <div key={c.hostPatternField} className="font-mono text-2xs text-amber-200 leading-relaxed">
                  <div>{c.hostPatternField}</div>
                  <div className="pl-2 text-amber-300/80">local: {c.localFingerprint}</div>
                  <div className="pl-2 text-amber-300/80">remote: {c.remoteFingerprint}</div>
                </div>
              ))}
              <p className="text-2xs text-amber-200/80 leading-relaxed">
                This host has a different key locally than on the remote — a possible sign of a rotated or spoofed
                key. Review it yourself (e.g. with <code>ssh-keygen -R</code>) before trusting either one; sync will
                never overwrite a local known_hosts entry automatically.
              </p>
            </div>
          )}

          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-red-400 font-medium text-xs">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>Danger zone</span>
            </div>

            {!confirmingWipe ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-2xs text-txt-muted leading-relaxed">
                  Permanently delete this sync setup and its remote backup.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingWipe(true);
                    setWipeError(null);
                    setWipeWarnings([]);
                  }}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-500/40 px-2.5 py-1.5 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete sync data...
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className="text-xs text-red-200/90 leading-relaxed space-y-1.5">
                  <p className="font-medium text-red-300">This will:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>
                      Permanently delete the encrypted sync files (topology, credentials, dotfile pools, settings,
                      SSH config/known_hosts data) from{' '}
                      <span className="font-mono">{status.target?.name ?? 'the configured target'}</span>.
                    </li>
                    <li>Remove the sync target, master password salts, and any linked smartcard from this device.</li>
                    <li>Lock sync on this device — you'll need to set it up again to use it here.</li>
                  </ul>
                  <p className="font-medium text-emerald-300/90 pt-1">This will NOT:</p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>Delete or change your local SSH/S3 profiles, dotfile pools, or settings on this device.</li>
                    <li>Affect any other machine already synced — until it next tries to push or pull.</li>
                  </ul>
                </div>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setConfirmingWipe(false)}
                    disabled={wiping}
                    className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleWipe()}
                    disabled={wiping}
                    className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 shadow-sm transition-colors disabled:opacity-50"
                  >
                    {wiping && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Yes, delete everything
                  </button>
                </div>
                {wipeError && <p role="alert" className="text-xs text-red-400">{wipeError}</p>}
              </div>
            )}

            {wipeWarnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-2xs text-amber-200 leading-relaxed">
                Sync configuration was cleared on this device, but some remote files could not be deleted — you may
                want to remove them manually:
                <ul className="list-disc pl-4 pt-1 space-y-0.5">
                  {wipeWarnings.map((w, i) => (
                    <li key={i} className="font-mono">{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {editingTarget && (
        <div className="space-y-3 rounded-lg border border-border-subtle bg-app-surface p-3.5">
          <SyncTargetForm draft={targetDraft} onChange={setTargetDraft} disabled={savingTarget} />
          {targetError && <p role="alert" className="text-xs text-red-400">{targetError}</p>}
          <div className="flex items-center justify-end gap-2">
            {status?.configured && (
              <button
                type="button"
                onClick={() => {
                  setEditingTarget(false);
                  if (status?.targetConfig) {
                    setTargetDraft(draftFromTargetConfig(status.targetConfig, status.remoteBasePath ?? ''));
                  }
                }}
                className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                Cancel
              </button>
            )}
            <Button
              variant="secondary"
              onClick={handleSaveTarget}
              disabled={savingTarget}
              title="Saves only this sync target — it does not save the rest of Settings"
            >
              {savingTarget && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save Sync Target
            </Button>
          </div>
        </div>
      )}

      <MasterPasswordDialog
        open={passwordDialogOpen}
        mode={isLinkingDialog ? 'unlock' : status?.hasLocalSalts ? 'unlock' : 'setup'}
        title={
          isLinkingDialog
            ? 'Link smartcard to sync'
            : status?.hasLocalSalts
              ? 'Unlock sync'
              : 'Set up master passwords'
        }
        description={
          isLinkingDialog
            ? 'Enter your master password to authorize linking your smartcard to remote sync. It will be encrypted with your card certificate and never saved in plaintext.'
            : status?.hasLocalSalts
              ? 'Enter your existing master passwords to unlock sync for this session.'
              : 'Choose the master password that will encrypt your synced data. It is never sent anywhere or stored on disk.'
        }
        submitLabel={isLinkingDialog ? 'Link smartcard' : status?.hasLocalSalts ? 'Unlock' : 'Activate sync'}
        submitting={enabling || linkingSmartcard}
        error={enableError}
        canLinkSmartcard={!isLinkingDialog && Boolean(status?.smartcardAvailable && !status?.smartcardLinked)}
        onUnlockWithSmartcard={
          !isLinkingDialog && (status?.smartcardAvailable || status?.smartcardLinked)
            ? handleSmartcardUnlock
            : undefined
        }
        onCancel={() => {
          setPasswordDialogOpen(false);
          setEnableError(null);
          setIsLinkingDialog(false);
        }}
        onSubmit={handlePasswordSubmit}
      />
    </div>
  );
};

export default SyncSettingsPanel;
