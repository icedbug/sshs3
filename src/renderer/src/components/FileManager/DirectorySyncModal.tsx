import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Check,
  CheckSquare,
  Cloud,
  FileDiff,
  Folder,
  FolderSync,
  HardDrive,
  Loader2,
  Maximize2,
  Minimize2,
  Save,
  Server,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { SFTPConfig, S3Config, TransferProgress } from '@shared/types/storage';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type {
  DirectoryDiffEntry,
  DirectoryDiffResult,
  DirectorySyncApplyResult,
  DirectorySyncProfile,
} from '@shared/types/dirsync';
import { ConnectionManagerModal } from '../ConnectionModal/ConnectionManagerModal';
import { FolderBrowserModal } from './FolderBrowserModal';
import { FileDiffModal } from './FileDiffModal';
import { DirSyncSavedProfilesModal } from './DirSyncSavedProfilesModal';
import { classNames, formatBytes, formatDateTime, describeIpcError } from '../../lib/format';
import type { SourceType } from './types';
import { useEscapeToClose } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

/** Last path segment, used to preview the nested sync root under the chosen target parent. */
function baseName(path: string): string {
  const normalized = (path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

/**
 * Summarizes what actually differs for a 'changed' entry as one line per
 * side, and flags when the *target* is the newer side — that's the
 * dangerous case, since running the sync (source -> target) would silently
 * overwrite a more recent edit made on the target with the older source
 * version.
 */
function describeChange(
  entry: DirectoryDiffEntry
): { source: string; target: string; targetIsNewer: boolean } | null {
  const src = entry.sourceEntry;
  const tgt = entry.targetEntry;
  if (!src || !tgt) return null;

  const targetIsNewer =
    src.mtimeMs !== undefined && tgt.mtimeMs !== undefined && tgt.mtimeMs > src.mtimeMs;

  const describe = (e: typeof src) => {
    const bits = [formatBytes(e.size)];
    if (e.mtimeMs !== undefined) bits.push(formatDateTime(e.mtimeMs));
    return bits.join(', ');
  };

  return { source: describe(src), target: describe(tgt), targetIsNewer };
}

interface EndpointState {
  providerId: string;
  sourceType: SourceType;
  label: string;
  sublabel?: string;
  path: string;
}

function EndpointIcon({ type }: { type: SourceType | string }) {
  switch (type) {
    case 'local':
      return <HardDrive className="h-4 w-4 text-emerald-400 shrink-0" />;
    case 'sftp':
      return <Server className="h-4 w-4 text-sky-400 shrink-0" />;
    case 's3':
      return <Cloud className="h-4 w-4 text-amber-400 shrink-0" />;
    case 'k8s':
      return <Boxes className="h-4 w-4 text-indigo-400 shrink-0" />;
    default:
      return <Folder className="h-4 w-4 text-txt-muted shrink-0" />;
  }
}

function getEndpointSubtitle(
  endpoint: EndpointState | null,
  sshProfiles: SSHConnectionConfig[],
  s3Profiles: S3Config[]
): string {
  if (!endpoint) return '';
  if (endpoint.sublabel) return endpoint.sublabel;
  if (endpoint.sourceType === 'local' || endpoint.providerId === 'local') {
    return 'This computer (Local)';
  }
  if (endpoint.providerId.startsWith('sftp-')) {
    const id = endpoint.providerId.slice('sftp-'.length);
    const cfg = sshProfiles.find((p) => p.id === id);
    if (cfg) {
      const userHost = cfg.username ? `${cfg.username}@${cfg.host}` : cfg.host;
      const portPart = cfg.port && cfg.port !== 22 ? `:${cfg.port}` : '';
      return `SFTP · ${userHost}${portPart}`;
    }
    return 'SFTP Server';
  }
  if (endpoint.providerId.startsWith('s3-')) {
    const id = endpoint.providerId.slice('s3-'.length);
    const cfg = s3Profiles.find((p) => p.id === id);
    if (cfg) {
      return `S3 · ${cfg.endpoint || 'AWS S3'} (${cfg.region})`;
    }
    return 'S3 Bucket';
  }
  if (endpoint.providerId.startsWith('k8s-')) {
    return `Kubernetes · ${endpoint.providerId.replace(/^k8s-/, '')}`;
  }
  return endpoint.sourceType.toUpperCase();
}

export interface DirectorySyncModalSource {
  providerId: string;
  sourceType: SourceType;
  label: string;
  sublabel?: string;
  path: string;
}

interface DirectorySyncModalProps {
  open: boolean;
  onClose: () => void;
  /** Pre-filled source: the folder that was right-clicked, or resolved from a saved profile. */
  initialSource?: DirectorySyncModalSource | null;
  /** The other pane's connection + path, offered as a one-click target option. */
  otherPane?: DirectorySyncModalSource | null;
  /**
   * When opened by "Run" from the saved-profiles list: resolves source/target
   * from the profile and jumps straight to computing a fresh diff — never
   * straight to applying, so a stale/dangerous profile (e.g. with delete
   * enabled) is always reviewed before it can run.
   */
  runProfile?: DirectorySyncProfile | null;
}

type Step = 'setup' | 'diff' | 'apply';

/** Connects (or reuses) the storage provider referenced by a providerId, following
 * the app-wide convention: 'local', or 'sftp-<sshProfileId>' / 's3-<s3ProfileId>'. */
async function resolveProviderRef(ref: string): Promise<EndpointState> {
  if (!ref || ref === 'local') {
    await window.multissh.connectStorage({ id: 'local', name: 'Local Disk', type: 'local' });
    return { providerId: 'local', sourceType: 'local', label: 'Local Disk', path: '' };
  }
  if (ref.startsWith('sftp-')) {
    const id = ref.slice('sftp-'.length);
    const profiles = await window.multissh.profilesGet();
    const cfg = profiles.ssh.find((p) => p.id === id);
    if (!cfg) throw new Error(`Saved SSH profile not found (${id})`);
    const sftpConfig: SFTPConfig = {
      id: cfg.id,
      name: cfg.name,
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
      authType: cfg.authType,
      password: cfg.password,
      privateKeyPath: cfg.privateKeyPath,
      passphrase: cfg.passphrase,
      agentPath: cfg.agentPath,
      pkcs11LibPath: cfg.pkcs11LibPath,
      fido2Resident: cfg.fido2Resident,
      initialPath: cfg.initialPath,
      proxy: cfg.proxy,
      proxyJump: cfg.proxyJump,
      proxyJumpProfileId: cfg.proxyJumpProfileId,
    };
    await window.multissh.connectStorage({ id: ref, name: cfg.name, type: 'sftp', sftpConfig });
    return { providerId: ref, sourceType: 'sftp', label: cfg.name, path: cfg.initialPath?.trim() || '/' };
  }
  if (ref.startsWith('s3-')) {
    const id = ref.slice('s3-'.length);
    const profiles = await window.multissh.profilesGet();
    const cfg = profiles.s3.find((p) => p.id === id);
    if (!cfg) throw new Error(`Saved S3 profile not found (${id})`);
    await window.multissh.connectStorage({ id: ref, name: cfg.name, type: 's3', s3Config: cfg });
    return { providerId: ref, sourceType: 's3', label: cfg.name, path: cfg.initialPath?.trim() || '/' };
  }
  throw new Error(`Unknown provider reference: ${ref}`);
}

export const DirectorySyncModal: React.FC<DirectorySyncModalProps> = ({
  open,
  onClose,
  initialSource,
  otherPane,
  runProfile,
}) => {
  const [step, setStep] = useState<Step>('setup');
  const [source, setSource] = useState<EndpointState | null>(null);
  const [target, setTarget] = useState<EndpointState | null>(null);
  const [deleteExtraneous, setDeleteExtraneous] = useState(false);
  const [connectionPickerOpen, setConnectionPickerOpen] = useState(false);
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  const [diff, setDiff] = useState<DirectoryDiffResult | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [compareEntry, setCompareEntry] = useState<DirectoryDiffEntry | null>(null);
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);

  const [applyProgress, setApplyProgress] = useState<TransferProgress | null>(null);
  const [applyResult, setApplyResult] = useState<DirectorySyncApplyResult | null>(null);

  const [saveProfileName, setSaveProfileName] = useState('');
  const [showSaveProfile, setShowSaveProfile] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [sshProfiles, setSshProfiles] = useState<SSHConnectionConfig[]>([]);
  const [s3Profiles, setS3Profiles] = useState<S3Config[]>([]);

  useEffect(() => {
    if (open) {
      window.multissh.profilesGet?.().then((data) => {
        setSshProfiles(data?.ssh || []);
        setS3Profiles(data?.s3 || []);
      }).catch(() => {});
    }
  }, [open]);

  const toCopyCount = useMemo(() => {
    if (!diff) return 0;
    return diff.entries.filter(
      (e) => (e.status === 'new' || e.status === 'changed') && included[e.relativePath]
    ).length;
  }, [diff, included]);

  const toDeleteCount = useMemo(() => {
    if (!diff || !deleteExtraneous) return 0;
    return diff.entries.filter(
      (e) => e.status === 'only-target' && included[e.relativePath]
    ).length;
  }, [diff, included, deleteExtraneous]);

  useEscapeToClose(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  // Reset + prefill only on the rising edge of `open` (closed -> open), not
  // on every re-render while already open — otherwise an unrelated prop
  // change (e.g. initialSource going null because a background refresh
  // cleared the file manager's selection) would wipe out an in-progress or
  // just-finished sync.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!justOpened) return;
    setStep('setup');
    setError(null);
    setDiff(null);
    setIncluded({});
    setApplyProgress(null);
    setApplyResult(null);
    setShowSaveProfile(false);
    setSaveProfileName('');

    if (runProfile) {
      setDeleteExtraneous(runProfile.deleteExtraneous);
      setBusy(true);
      Promise.all([
        resolveProviderRef(runProfile.source.providerConfigRef),
        resolveProviderRef(runProfile.target.providerConfigRef),
      ])
        .then(([src, tgt]) => {
          const resolvedSource = { ...src, path: runProfile.source.path };
          const resolvedTarget = { ...tgt, path: runProfile.target.path };
          setSource(resolvedSource);
          setTarget(resolvedTarget);
          return runDiff(resolvedSource, resolvedTarget);
        })
        .catch((err) => setError(describeIpcError(err, String(err))))
        .finally(() => setBusy(false));
      return;
    }

    if (initialSource) {
      setSource({ ...initialSource });
    } else {
      setSource(null);
    }
    // Default the target to the sibling pane's connection + path when opened
    // from a folder's context menu — it's the most likely intent, but every
    // other way to pick a target (browse, saved connection, manual edit)
    // stays available and overrides this.
    setTarget(otherPane ? { ...otherPane } : null);
    setDeleteExtraneous(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, runProfile, initialSource, otherPane]);

  const runDiff = useCallback(async (src: EndpointState, tgt: EndpointState) => {
    setError(null);
    setScanStatus('Scanning source and target...');
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.multissh.onDirSyncScanProgress?.((event) => {
        setScanStatus(
          `Scanning ${event.side === 'source' ? 'source' : 'target'} (${event.filesCount} items)... ${event.currentItem}`
        );
      });
      const result = await window.multissh.dirSyncComputeDiff({
        sourceProviderId: src.providerId,
        sourcePath: src.path,
        targetProviderId: tgt.providerId,
        targetPath: tgt.path,
      });
      setDiff(result);
      const initialIncluded: Record<string, boolean> = {};
      for (const entry of result.entries) {
        initialIncluded[entry.relativePath] = entry.status !== 'only-target' && entry.status !== 'conflict';
      }
      setIncluded(initialIncluded);
      setStep('diff');
    } finally {
      unsubscribe?.();
      setScanStatus(null);
    }
  }, []);

  const loadProfile = useCallback(
    async (profile: DirectorySyncProfile) => {
      setError(null);
      setDeleteExtraneous(profile.deleteExtraneous);
      setBusy(true);
      try {
        const [src, tgt] = await Promise.all([
          resolveProviderRef(profile.source.providerConfigRef),
          resolveProviderRef(profile.target.providerConfigRef),
        ]);
        const resolvedSource = { ...src, path: profile.source.path };
        const resolvedTarget = { ...tgt, path: profile.target.path };
        setSource(resolvedSource);
        setTarget(resolvedTarget);
        await runDiff(resolvedSource, resolvedTarget);
      } catch (err) {
        setError(describeIpcError(err, String(err)));
      } finally {
        setBusy(false);
      }
    },
    [runDiff]
  );

  const handleComputeDiff = async () => {
    if (!source || !target) {
      setError('Specify both a source and a target');
      return;
    }
    setBusy(true);
    try {
      await runDiff(source, target);
    } catch (err) {
      setError(describeIpcError(err, String(err)));
    } finally {
      setBusy(false);
    }
  };

  const handleUseOtherPaneAsTarget = () => {
    if (otherPane) {
      setTarget({ ...otherPane });
    }
  };

  const handlePickConnectionTarget = () => {
    setConnectionPickerOpen(true);
  };

  const handleConnectTargetSSH = async (config: SSHConnectionConfig) => {
    setConnectionPickerOpen(false);
    setBusy(true);
    setError(null);
    try {
      const providerId = `sftp-${config.id}`;
      const sftpConfig: SFTPConfig = {
        id: config.id,
        name: config.name,
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        authType: config.authType,
        password: config.password,
        privateKeyPath: config.privateKeyPath,
        passphrase: config.passphrase,
        agentPath: config.agentPath,
        pkcs11LibPath: config.pkcs11LibPath,
        fido2Resident: config.fido2Resident,
        initialPath: config.initialPath,
        proxy: config.proxy,
        proxyJump: config.proxyJump,
        proxyJumpProfileId: config.proxyJumpProfileId,
      };
      await window.multissh.connectStorage({ id: providerId, name: config.name, type: 'sftp', sftpConfig });
      setTarget({ providerId, sourceType: 'sftp', label: config.name, path: config.initialPath?.trim() || '/' });
    } catch (err) {
      setError(describeIpcError(err, 'Could not connect to the target server'));
    } finally {
      setBusy(false);
    }
  };

  const handleConnectTargetS3 = async (config: S3Config) => {
    setConnectionPickerOpen(false);
    setBusy(true);
    setError(null);
    try {
      const providerId = `s3-${config.id}`;
      await window.multissh.connectStorage({ id: providerId, name: config.name, type: 's3', s3Config: config });
      setTarget({ providerId, sourceType: 's3', label: config.name, path: config.initialPath?.trim() || '/' });
    } catch (err) {
      setError(describeIpcError(err, 'Could not connect to the S3 target'));
    } finally {
      setBusy(false);
    }
  };

  const toggleIncluded = (relativePath: string) => {
    setIncluded((prev) => ({ ...prev, [relativePath]: !prev[relativePath] }));
  };

  const setCategoryIncluded = (status: DirectoryDiffEntry['status'], value: boolean) => {
    if (!diff) return;
    setIncluded((prev) => {
      const next = { ...prev };
      for (const entry of diff.entries) {
        if (entry.status === status) {
          next[entry.relativePath] = value;
        }
      }
      return next;
    });
  };

  const grouped = useMemo(() => {
    if (!diff) return { new: [], changed: [], onlyTarget: [], conflict: [] } as Record<string, DirectoryDiffEntry[]>;
    return {
      conflict: diff.entries.filter((e) => e.status === 'conflict'),
      new: diff.entries.filter((e) => e.status === 'new'),
      changed: diff.entries.filter((e) => e.status === 'changed'),
      onlyTarget: diff.entries.filter((e) => e.status === 'only-target'),
    };
  }, [diff]);

  const handleSaveProfile = async () => {
    if (!source || !target || !saveProfileName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const profile: DirectorySyncProfile = {
        id: runProfile?.id ?? crypto.randomUUID(),
        name: saveProfileName.trim(),
        source: { providerConfigRef: source.providerId, path: source.path },
        target: { providerConfigRef: target.providerId, path: target.path },
        deleteExtraneous,
        createdAt: runProfile?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await window.multissh.dirSyncProfileSave(profile);
      setShowSaveProfile(false);
      setSaveProfileName('');
    } catch (err) {
      setError(describeIpcError(err, 'Could not save the profile'));
    } finally {
      setBusy(false);
    }
  };

  const handleRunSync = async () => {
    if (!diff || !source || !target) return;
    const selectedEntries = diff.entries.filter((e) => included[e.relativePath]);
    setStep('apply');
    setBusy(true);
    setError(null);
    setApplyProgress(null);
    setApplyResult(null);

    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = window.multissh.onDirSyncApplyProgress?.((progress) => {
        setApplyProgress(progress);
      });
      const result = await window.multissh.dirSyncApply({
        entries: selectedEntries,
        sourceProviderId: source.providerId,
        sourcePath: source.path,
        targetProviderId: target.providerId,
        targetPath: target.path,
        deleteExtraneous,
      });
      setApplyResult(result);
    } catch (err) {
      setError(describeIpcError(err, 'The sync failed'));
    } finally {
      unsubscribe?.();
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Sync Directory"
        className={classNames(
          'flex flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden transition-all duration-150',
          isMaximized ? 'w-[98vw] h-[96vh] max-w-none' : 'w-[94vw] max-w-[1400px] h-[88vh]'
        )}
      >
        <div
          onDoubleClick={() => setIsMaximized((m) => !m)}
          title="Double-click header to maximize / restore"
          className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3 select-none cursor-default shrink-0"
        >
          <div className="flex items-center gap-2">
            <FolderSync className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Sync Directory</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={isMaximized ? 'Restore size' : 'Maximize window'}
              onClick={() => setIsMaximized((m) => !m)}
              className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
            <button
              aria-label="Close (Esc)"
              type="button"
              title="Close (Esc)"
              onClick={onClose}
              className="rounded-lg p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 text-xs text-txt-secondary">
          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-xs text-red-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {step === 'setup' && (
            <>
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-txt-primary">Source</span>
                {source ? (
                  <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-2xs font-semibold text-emerald-400 uppercase tracking-wider">
                        Source (From)
                      </span>
                      <EndpointIcon type={source.sourceType} />
                    </div>
                    <div className="font-semibold text-xs text-txt-primary truncate mt-1">{source.label}</div>
                    <div className="text-xs text-txt-muted truncate">
                      {getEndpointSubtitle(source, sshProfiles, s3Profiles)}
                    </div>
                    <input
                      value={source.path}
                      onChange={(e) => setSource({ ...source, path: e.target.value })}
                      className="mt-1.5 w-full rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 font-mono text-txt-primary outline-none focus:border-sky-500"
                    />
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border-subtle p-3 text-txt-muted">
                    No source selected. Right-click a folder in the file manager and choose &quot;Sync
                    to...&quot;, or load a saved profile below.
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setProfilePickerOpen(true)}
                  className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                >
                  Load saved profile...
                </button>
              </div>

              <div className="flex items-center justify-center text-txt-muted">
                <ArrowRight className="h-4 w-4" />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-txt-primary">Target (parent folder)</span>
                {target ? (
                  <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 text-2xs font-semibold text-sky-400 uppercase tracking-wider">
                        Target (To)
                      </span>
                      <EndpointIcon type={target.sourceType} />
                    </div>
                    <div className="font-semibold text-xs text-txt-primary truncate mt-1">{target.label}</div>
                    <div className="text-xs text-txt-muted truncate">
                      {getEndpointSubtitle(target, sshProfiles, s3Profiles)}
                    </div>
                    <div className="mt-1.5 flex gap-1.5">
                      <input
                        value={target.path}
                        onChange={(e) => setTarget({ ...target, path: e.target.value })}
                        className="flex-1 min-w-0 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 font-mono text-txt-primary outline-none focus:border-sky-500"
                      />
                      <button
                        type="button"
                        onClick={() => setFolderBrowserOpen(true)}
                        className="shrink-0 rounded-lg border border-border-subtle px-2.5 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                      >
                        Browse...
                      </button>
                    </div>
                    {source?.path && (
                      <div className="mt-1.5 text-xs text-txt-muted">
                        Will sync to:{' '}
                        <span className="font-mono text-txt-secondary">
                          {target.path.replace(/\/$/, '')}/{baseName(source.path) || '…'}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-border-subtle p-3 text-txt-muted">
                    No target selected.
                  </div>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  {otherPane && (
                    <button
                      type="button"
                      onClick={handleUseOtherPaneAsTarget}
                      className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                    >
                      Use other pane ({otherPane.label})
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handlePickConnectionTarget}
                    className="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                  >
                    Choose saved connection profile...
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-border-subtle bg-app-surface p-3 space-y-1.5">
                <label className="flex items-center gap-2 cursor-pointer text-txt-primary font-medium select-none">
                  <input
                    type="checkbox"
                    checked={deleteExtraneous}
                    onChange={(e) => setDeleteExtraneous(e.target.checked)}
                    className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                  />
                  <span>Mirror mode: Delete extraneous files in target</span>
                </label>
                <p className="text-xs text-txt-muted ml-6">
                  {deleteExtraneous
                    ? 'Files that exist in target but missing from source will be deleted to create an exact mirror.'
                    : 'Safe sync (recommended): Extraneous files existing in target are preserved and never deleted.'}
                </p>
              </div>

              {scanStatus && (
                <div className="flex items-center gap-2 text-txt-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="truncate">{scanStatus}</span>
                </div>
              )}
            </>
          )}

          {source && target && step !== 'setup' && (
            <div className="grid grid-cols-1 sm:grid-cols-[1fr,auto,1fr] items-center gap-3 bg-app-surface rounded-xl p-3 border border-border-subtle shadow-sm">
              {/* Source box */}
              <div className="flex flex-col gap-1 rounded-lg bg-app-card p-2.5 border border-border-subtle/80 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-2xs font-semibold text-emerald-400 uppercase tracking-wider">
                    Source (From)
                  </span>
                  <EndpointIcon type={source.sourceType} />
                </div>
                <div className="font-semibold text-xs text-txt-primary truncate mt-0.5">{source.label}</div>
                <div className="text-xs text-txt-muted truncate">
                  {getEndpointSubtitle(source, sshProfiles, s3Profiles)}
                </div>
                <div className="flex items-center gap-1.5 font-mono text-xs text-txt-primary bg-app-input px-2 py-1 rounded border border-border-subtle/60 mt-1 truncate">
                  <Folder className="h-3 w-3 shrink-0 text-amber-400" />
                  <span className="truncate">{source.path}</span>
                </div>
              </div>

              {/* Direction Indicator */}
              <div className="flex flex-col items-center justify-center gap-1 px-1 py-1">
                <div className="flex items-center justify-center w-8 h-8 rounded-md bg-sky-500/15 border border-sky-500/30 text-sky-400">
                  <ArrowRight className="h-4 w-4" />
                </div>
                <span className="text-2xs font-semibold text-txt-muted uppercase tracking-wider whitespace-nowrap">
                  Syncs to
                </span>
              </div>

              {/* Target box */}
              <div className="flex flex-col gap-1 rounded-lg bg-app-card p-2.5 border border-border-subtle/80 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 text-2xs font-semibold text-sky-400 uppercase tracking-wider">
                    Target (To)
                  </span>
                  <EndpointIcon type={target.sourceType} />
                </div>
                <div className="font-semibold text-xs text-txt-primary truncate mt-0.5">{target.label}</div>
                <div className="text-xs text-txt-muted truncate">
                  {getEndpointSubtitle(target, sshProfiles, s3Profiles)}
                </div>
                <div className="flex items-center gap-1.5 font-mono text-xs text-txt-primary bg-app-input px-2 py-1 rounded border border-border-subtle/60 mt-1 truncate">
                  <Folder className="h-3 w-3 shrink-0 text-amber-400" />
                  <span className="truncate">{target.path}</span>
                </div>
              </div>
            </div>
          )}

          {step === 'diff' && diff && (
            <>
              {(diff.skippedPaths.source.length > 0 || diff.skippedPaths.target.length > 0) && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
                  {diff.skippedPaths.source.length > 0 && (
                    <div>
                      {diff.skippedPaths.source.length} folder(s) in the source could not be read (e.g. permission denied) and were excluded: {diff.skippedPaths.source.slice(0, 5).join(', ')}
                      {diff.skippedPaths.source.length > 5 ? ', …' : ''}
                    </div>
                  )}
                  {diff.skippedPaths.target.length > 0 && (
                    <div>
                      {diff.skippedPaths.target.length} folder(s) in the target could not be read (e.g. permission denied) and were excluded: {diff.skippedPaths.target.slice(0, 5).join(', ')}
                      {diff.skippedPaths.target.length > 5 ? ', …' : ''}
                    </div>
                  )}
                </div>
              )}

              {(diff.skippedSymlinks.source.length > 0 || diff.skippedSymlinks.target.length > 0) && (
                <div className="rounded-lg border border-border-subtle bg-app-surface p-2 text-xs text-txt-muted">
                  {(['source', 'target'] as const).map((side) =>
                    diff.skippedSymlinks[side].length > 0 ? (
                      <div key={side}>
                        {diff.skippedSymlinks[side].length} symbolic link(s) in the {side} are not synced:{' '}
                        {diff.skippedSymlinks[side].slice(0, 5).join(', ')}
                        {diff.skippedSymlinks[side].length > 5 ? ', …' : ''}
                      </div>
                    ) : null
                  )}
                </div>
              )}

              {/* Mirror / Safe Sync policy banner & toggle */}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle bg-app-surface px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  {deleteExtraneous ? (
                    <div className="flex items-center gap-1.5 text-amber-400 font-medium">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>Mirror mode: Files only in target will be deleted if selected</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
                      <ShieldCheck className="h-4 w-4 shrink-0" />
                      <span>Safe sync: Files existing only in target are preserved</span>
                    </div>
                  )}
                </div>
                <label className="flex items-center gap-2 cursor-pointer text-txt-secondary hover:text-txt-primary select-none text-xs">
                  <input
                    type="checkbox"
                    checked={deleteExtraneous}
                    onChange={(e) => setDeleteExtraneous(e.target.checked)}
                    className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                  />
                  <span>Enable mirror (delete extraneous files in target)</span>
                </label>
              </div>

              {diff.counts.conflict > 0 && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-amber-800/80 bg-amber-950/40 p-2.5 text-xs text-amber-300"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    {diff.counts.conflict === 1
                      ? '1 path is a file on one side and a folder on the other.'
                      : `${diff.counts.conflict} paths are a file on one side and a folder on the other.`}{' '}
                    They are not copied or deleted, and nothing below them is compared. Rename or remove one side, then scan again.
                  </span>
                </div>
              )}

              {/* Stat Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
                  <div className="text-lg font-semibold text-emerald-400">{diff.counts.new}</div>
                  <div className="text-xs font-medium text-txt-primary">New on source</div>
                  <div className="text-2xs text-txt-muted">Will copy to target</div>
                </div>
                <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
                  <div className="text-lg font-semibold text-amber-400">{diff.counts.changed}</div>
                  <div className="text-xs font-medium text-txt-primary">Modified</div>
                  <div className="text-2xs text-txt-muted">Will overwrite target</div>
                </div>
                <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
                  <div className={`text-lg font-semibold ${deleteExtraneous ? 'text-red-400' : 'text-sky-400'}`}>
                    {diff.counts.onlyTarget}
                  </div>
                  <div className="text-xs font-medium text-txt-primary">Only in target</div>
                  <div className="text-2xs text-txt-muted">
                    {deleteExtraneous ? 'Deletes if selected' : 'Kept (safe sync)'}
                  </div>
                </div>
                <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5">
                  <div className="text-lg font-semibold text-txt-muted">{diff.counts.same}</div>
                  <div className="text-xs font-medium text-txt-primary">Identical</div>
                  <div className="text-2xs text-txt-muted">Already in sync</div>
                </div>
              </div>

              {diff.entries.length === 0 ? (
                <div className="rounded-lg border border-border-subtle bg-app-surface p-4 text-center text-txt-muted">
                  No differences found. Source and target are already in sync.
                </div>
              ) : (
                <div className="rounded-lg border border-border-subtle bg-app-surface overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-divider text-xs text-txt-muted uppercase tracking-wider">
                        <th className="p-2 font-semibold w-8" />
                        <th className="p-2 font-semibold">Path</th>
                        <th className="p-2 font-semibold w-44 text-right pr-3">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-divider">
                      {grouped.conflict.length > 0 && (
                        <React.Fragment key="conflict">
                          <tr className="bg-app-surface-hover/50">
                            <td colSpan={3} className="px-2 py-1.5">
                              <span className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                File and folder with the same name ({grouped.conflict.length}) — skipped
                              </span>
                            </td>
                          </tr>
                          {grouped.conflict.map((entry) => (
                            <tr key={entry.relativePath}>
                              <td className="px-2 py-1.5 align-top">
                                <span title="Skipped: file on one side, folder on the other" className="inline-flex">
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5" />
                                </span>
                              </td>
                              <td className="px-2 py-1.5 align-top max-w-0">
                                <div className="font-mono text-txt-primary truncate">{entry.relativePath}</div>
                                <div className="mt-1 space-y-0.5 text-xs leading-snug text-txt-muted">
                                  <div>
                                    <span className="text-txt-secondary font-medium">Source:</span>{' '}
                                    {entry.sourceEntry?.isDirectory ? 'folder' : 'file'}
                                  </div>
                                  <div>
                                    <span className="text-txt-secondary font-medium">Target:</span>{' '}
                                    {entry.targetEntry?.isDirectory ? 'folder' : 'file'}
                                  </div>
                                </div>
                              </td>
                              <td className="px-2 py-1.5 align-top text-right pr-3">
                                <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-xs font-medium text-amber-400 whitespace-nowrap">
                                  Skipped (type conflict)
                                </span>
                              </td>
                            </tr>
                          ))}
                        </React.Fragment>
                      )}
                      {(['new', 'changed', 'only-target'] as const).map((status) => {
                        const entries =
                          status === 'new' ? grouped.new : status === 'changed' ? grouped.changed : grouped.onlyTarget;
                        if (entries.length === 0) return null;
                        const isOnlyTarget = status === 'only-target';
                        const canSelectOnlyTarget = !isOnlyTarget || deleteExtraneous;

                        return (
                          <React.Fragment key={status}>
                            <tr className="bg-app-surface-hover/50">
                              <td colSpan={3} className="px-2 py-1.5">
                                <div className="flex items-center justify-between">
                                  <button
                                    type="button"
                                    disabled={!canSelectOnlyTarget}
                                    onClick={() =>
                                      setCategoryIncluded(status, !entries.every((e) => included[e.relativePath]))
                                    }
                                    className={`flex items-center gap-1.5 text-xs font-semibold transition-colors ${
                                      !canSelectOnlyTarget
                                        ? 'text-txt-muted cursor-default'
                                        : 'text-txt-secondary hover:text-txt-primary'
                                    }`}
                                  >
                                    {canSelectOnlyTarget ? (
                                      entries.every((e) => included[e.relativePath]) ? (
                                        <CheckSquare className="h-3.5 w-3.5" />
                                      ) : (
                                        <Square className="h-3.5 w-3.5" />
                                      )
                                    ) : (
                                      <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                                    )}
                                    {status === 'new' && (
                                      <span>New on source ({entries.length}) — select all to copy</span>
                                    )}
                                    {status === 'changed' && (
                                      <span>Modified on source ({entries.length}) — select all to overwrite</span>
                                    )}
                                    {status === 'only-target' && (
                                      <span>
                                        {deleteExtraneous
                                          ? `Only in target (${entries.length}) — select all to delete`
                                          : `Only in target (${entries.length}) — preserved in target (safe sync)`}
                                      </span>
                                    )}
                                  </button>
                                  {status === 'only-target' && !deleteExtraneous && (
                                    <span className="text-2xs text-txt-muted">Enable mirror mode above to delete</span>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {entries.map((entry) => {
                              const change = entry.status === 'changed' ? describeChange(entry) : null;
                              return (
                                <tr key={entry.relativePath}>
                                  <td className="px-2 py-1.5 align-top">
                                    {canSelectOnlyTarget ? (
                                      <input
                                        type="checkbox"
                                        checked={Boolean(included[entry.relativePath])}
                                        onChange={() => toggleIncluded(entry.relativePath)}
                                        className="rounded border-border-subtle bg-app-input text-sky-600 focus:ring-sky-500"
                                      />
                                    ) : (
                                      <span title="Preserved: will not be deleted in safe sync mode" className="inline-flex">
                                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500/60 mt-0.5" />
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 align-top max-w-0">
                                    <div className="font-mono text-txt-primary truncate">{entry.relativePath}</div>
                                    {change && (
                                      <div className="mt-1 space-y-0.5 text-xs leading-snug">
                                        <div className="text-txt-muted">
                                          <span className="text-txt-secondary font-medium">Source:</span>{' '}
                                          {change.source}
                                        </div>
                                        <div className={change.targetIsNewer ? 'text-red-400' : 'text-txt-muted'}>
                                          <span
                                            className={
                                              change.targetIsNewer
                                                ? 'text-red-400 font-medium'
                                                : 'text-txt-secondary font-medium'
                                            }
                                          >
                                            Target:
                                          </span>{' '}
                                          {change.target}
                                          {change.targetIsNewer && (
                                            <span className="font-medium"> — newer, will be overwritten</span>
                                          )}
                                        </div>
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 align-top text-right pr-3">
                                    {entry.status === 'new' && (
                                      <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-xs font-medium text-emerald-400 whitespace-nowrap">
                                        + Copy to target
                                      </span>
                                    )}
                                    {entry.status === 'changed' && (
                                      <div className="flex flex-col items-end gap-1">
                                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-xs font-medium text-amber-400 whitespace-nowrap">
                                          ↻ Overwrite target
                                        </span>
                                        {entry.sourceEntry?.path && entry.targetEntry?.path && (
                                          <button
                                            type="button"
                                            onClick={() => setCompareEntry(entry)}
                                            className="flex items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-2xs font-normal text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                                          >
                                            <FileDiff className="h-3 w-3" />
                                            Compare
                                          </button>
                                        )}
                                      </div>
                                    )}
                                    {entry.status === 'only-target' && (
                                      deleteExtraneous ? (
                                        <span className="inline-flex items-center gap-1 rounded bg-red-500/15 border border-red-500/30 px-2 py-0.5 text-xs font-medium text-red-400 whitespace-nowrap">
                                          <Trash2 className="h-3 w-3" />
                                          Delete from target
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1 rounded bg-slate-500/15 border border-border-subtle px-2 py-0.5 text-xs font-medium text-txt-muted whitespace-nowrap">
                                          <ShieldCheck className="h-3 w-3 text-emerald-400" />
                                          Kept in target
                                        </span>
                                      )
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {showSaveProfile && (
                <div className="rounded-lg border border-border-subtle bg-app-surface p-2.5 space-y-2">
                  <span className="text-xs font-medium text-txt-primary">Profile name</span>
                  <div className="flex gap-2">
                    <input
                      aria-label="Profile name"
                      value={saveProfileName}
                      onChange={(e) => setSaveProfileName(e.target.value)}
                      placeholder="e.g. Web server → backup"
                      className="flex-1 rounded-lg border border-border-subtle bg-app-input px-2.5 py-1.5 text-txt-primary outline-none focus:border-sky-500"
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveProfile()}
                      disabled={!saveProfileName.trim() || busy}
                      className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 transition-colors"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 'apply' && (
            <div className="space-y-3">
              {!applyResult ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-txt-secondary">
                    <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
                    <span>Syncing...</span>
                  </div>
                  {applyProgress && (
                    <div className="space-y-1">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-app-surface">
                        <div
                          className="h-full bg-sky-500 transition-all"
                          style={{ width: `${applyProgress.percentage}%` }}
                        />
                      </div>
                      <div className="truncate text-xs text-txt-muted">
                        {applyProgress.statusMessage || applyProgress.fileName}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg border border-border-subtle bg-app-surface p-2">
                      <div className="text-base font-semibold text-emerald-400">{applyResult.copied}</div>
                      <div className="text-xs text-txt-muted">Copied</div>
                    </div>
                    <div className="rounded-lg border border-border-subtle bg-app-surface p-2">
                      <div className="text-base font-semibold text-amber-400">{applyResult.deleted}</div>
                      <div className="text-xs text-txt-muted">Deleted</div>
                    </div>
                    <div className="rounded-lg border border-border-subtle bg-app-surface p-2">
                      <div className="text-base font-semibold text-red-400">{applyResult.failed}</div>
                      <div className="text-xs text-txt-muted">Failed</div>
                    </div>
                  </div>
                  {applyResult.errors.length > 0 && (
                    <div className="rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 space-y-1 max-h-40 overflow-y-auto">
                      {applyResult.errors.map((e, i) => (
                        <div key={i} className="text-xs text-red-300">
                          <span className="font-mono">{e.path}</span>: {e.error}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-divider bg-app-surface px-4 py-3">
          <div>
            {step === 'diff' && !showSaveProfile && (
              <button
                type="button"
                onClick={() => setShowSaveProfile(true)}
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <Save className="h-3.5 w-3.5" />
                Save as profile
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 'diff' && (
              <button
                type="button"
                onClick={() => setStep('setup')}
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to setup
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-border-subtle px-3.5 py-1.5 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              {step === 'apply' && applyResult ? 'Close' : 'Cancel'}
            </button>
            {step === 'setup' && (
              <button
                type="button"
                onClick={() => void handleComputeDiff()}
                disabled={!source || !target || busy}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-40 shadow-sm transition-colors"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Compute diff
              </button>
            )}
            {step === 'diff' && (
              <button
                type="button"
                onClick={() => void handleRunSync()}
                disabled={diff?.entries.length === 0 || (toCopyCount === 0 && toDeleteCount === 0) || busy}
                // Red, not the neutral sky used elsewhere, whenever this run
                // will delete files — it's an irreversible action, not a
                // plain copy (UX review #7 color semantics).
                className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-medium text-white shadow-sm transition-colors disabled:opacity-40 ${
                  toDeleteCount > 0 ? 'bg-red-600 hover:bg-red-500' : 'bg-sky-600 hover:bg-sky-500'
                }`}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Run sync ({toCopyCount} to copy{toDeleteCount > 0 ? `, ${toDeleteCount} to delete` : ''})
              </button>
            )}
          </div>
        </div>
      </div>

      <ConnectionManagerModal
        open={connectionPickerOpen}
        onClose={() => setConnectionPickerOpen(false)}
        onConnectSSH={(config) => void handleConnectTargetSSH(config)}
        onConnectS3={(config) => void handleConnectTargetS3(config)}
      />

      {target && (
        <FolderBrowserModal
          open={folderBrowserOpen}
          onClose={() => setFolderBrowserOpen(false)}
          onSelect={(path) => {
            setTarget({ ...target, path });
            setFolderBrowserOpen(false);
          }}
          providerId={target.providerId}
          providerLabel={target.label}
          initialPath={target.path || '/'}
        />
      )}

      {compareEntry && source && target && compareEntry.sourceEntry?.path && compareEntry.targetEntry?.path && (
        <FileDiffModal
          open={Boolean(compareEntry)}
          onClose={() => setCompareEntry(null)}
          relativePath={compareEntry.relativePath}
          sourceProviderId={source.providerId}
          sourcePath={compareEntry.sourceEntry.path}
          targetProviderId={target.providerId}
          targetPath={compareEntry.targetEntry.path}
        />
      )}

      <DirSyncSavedProfilesModal
        open={profilePickerOpen}
        onClose={() => setProfilePickerOpen(false)}
        onRun={(profile) => {
          setProfilePickerOpen(false);
          void loadProfile(profile);
        }}
      />
    </div>
  );
};

export default DirectorySyncModal;
