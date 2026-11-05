import React, { useEffect, useState, useRef } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Cloud,
  Folder,
  FolderSync,
  HardDrive,
  Loader2,
  Play,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import type { DirectorySyncProfile } from '@shared/types/dirsync';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { S3Config } from '@shared/types/storage';
import { formatDateTime, describeIpcError } from '../../lib/format';
import { useModalDismiss } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useConfirm } from '../ConfirmDialog';

interface DirSyncSavedProfilesModalProps {
  open: boolean;
  onClose: () => void;
  onRun: (profile: DirectorySyncProfile) => void;
}

interface EndpointDisplayInfo {
  type: 'local' | 'sftp' | 's3' | 'k8s' | 'other';
  title: string;
  subtitle: string;
  path: string;
}

function resolveEndpoint(
  ref: string,
  rawPath: string,
  sshProfiles: SSHConnectionConfig[],
  s3Profiles: S3Config[]
): EndpointDisplayInfo {
  const path = rawPath || '/';
  if (!ref || ref === 'local') {
    return {
      type: 'local',
      title: 'Local Disk',
      subtitle: 'This computer (Local)',
      path,
    };
  }

  if (ref.startsWith('sftp-')) {
    const id = ref.slice('sftp-'.length);
    const cfg = sshProfiles.find((p) => p.id === id);
    if (cfg) {
      const userHost = cfg.username ? `${cfg.username}@${cfg.host}` : cfg.host;
      const portPart = cfg.port && cfg.port !== 22 ? `:${cfg.port}` : '';
      return {
        type: 'sftp',
        title: cfg.name,
        subtitle: `SFTP · ${userHost}${portPart}`,
        path,
      };
    }
    return {
      type: 'sftp',
      title: 'SFTP Server',
      subtitle: `Profile ID: ${id.slice(0, 8)}…`,
      path,
    };
  }

  if (ref.startsWith('s3-')) {
    const id = ref.slice('s3-'.length);
    const cfg = s3Profiles.find((p) => p.id === id);
    if (cfg) {
      return {
        type: 's3',
        title: cfg.name,
        subtitle: `S3 · ${cfg.endpoint || 'AWS S3'} (${cfg.region})`,
        path,
      };
    }
    return {
      type: 's3',
      title: 'S3 Bucket',
      subtitle: `Profile ID: ${id.slice(0, 8)}…`,
      path,
    };
  }

  if (ref.startsWith('k8s-')) {
    return {
      type: 'k8s',
      title: 'Kubernetes Pod',
      subtitle: ref.replace(/^k8s-/, ''),
      path,
    };
  }

  return {
    type: 'other',
    title: ref,
    subtitle: 'Remote Storage',
    path,
  };
}

function EndpointIcon({ type }: { type: EndpointDisplayInfo['type'] }) {
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

export const DirSyncSavedProfilesModal: React.FC<DirSyncSavedProfilesModalProps> = ({ open, onClose, onRun }) => {
  const [profiles, setProfiles] = useState<DirectorySyncProfile[]>([]);
  const [sshProfiles, setSshProfiles] = useState<SSHConnectionConfig[]>([]);
  const [s3Profiles, setS3Profiles] = useState<S3Config[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([window.multissh.dirSyncProfileList(), window.multissh.profilesGet()])
      .then(([syncList, connectionData]) => {
        setProfiles(syncList || []);
        setSshProfiles(connectionData.ssh || []);
        setS3Profiles(connectionData.s3 || []);
      })
      .catch((err) => setError(describeIpcError(err, String(err))))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirm({ title: 'Delete sync profile', message: `Delete the sync profile "${name}"?` }))) return;
    try {
      await window.multissh.dirSyncProfileDelete(id);
      load();
    } catch (err) {
      setError(describeIpcError(err, 'Could not delete the profile'));
    }
  };

  const handleBackdropClick = useModalDismiss(onClose, open);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
      onClick={handleBackdropClick}
    >
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Saved sync profiles" className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <FolderSync className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-txt-primary">Saved Sync Profiles</h2>
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

        {/* Profiles List */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 text-xs text-txt-secondary">
          {error && (
            <div role="alert" className="rounded-lg border border-red-800/80 bg-red-950/40 p-2.5 text-red-300">{error}</div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-10 text-txt-muted gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading sync profiles...</span>
            </div>
          ) : profiles.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border-subtle p-8 text-center text-txt-muted space-y-1.5">
              <FolderSync className="h-6 w-6 text-txt-muted mx-auto opacity-50" />
              <p className="font-medium text-txt-primary">No saved sync profiles yet</p>
              <p className="text-xs text-txt-muted">
                Open Directory Sync from the file manager, select source and target folders, and click &quot;Save as profile&quot;.
              </p>
            </div>
          ) : (
            profiles.map((profile) => {
              const sourceInfo = resolveEndpoint(
                profile.source.providerConfigRef,
                profile.source.path,
                sshProfiles,
                s3Profiles
              );
              const targetInfo = resolveEndpoint(
                profile.target.providerConfigRef,
                profile.target.path,
                sshProfiles,
                s3Profiles
              );

              return (
                <div
                  key={profile.id}
                  className="rounded-xl border border-border-subtle bg-app-surface p-3.5 flex flex-col gap-3 hover:border-border-strong transition-all shadow-sm"
                >
                  {/* Card Header */}
                  <div className="flex items-center justify-between gap-3 border-b border-divider pb-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderSync className="h-4 w-4 text-sky-400 shrink-0" />
                      <span className="font-semibold text-sm text-txt-primary truncate">{profile.name}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onRun(profile)}
                        title="Compute diff and run sync"
                        className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
                      >
                        <Play className="h-3.5 w-3.5 fill-white" />
                        Run Sync
                      </button>
                      <button
                        aria-label="Delete profile"
                        type="button"
                        onClick={() => void handleDelete(profile.id, profile.name)}
                        title="Delete profile"
                        className="rounded-lg p-1.5 text-txt-muted hover:bg-red-500/10 hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {/* Flow Comparison: Source (From) -> Target (To) */}
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr,auto,1fr] items-center gap-3 bg-app-card rounded-lg p-3 border border-border-subtle/40">
                    {/* Source box (Source) */}
                    <div className="flex flex-col gap-1 rounded-md bg-app-surface p-2.5 border border-border-subtle min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 text-2xs font-semibold text-emerald-400 uppercase tracking-wider">
                          Source (From)
                        </span>
                        <EndpointIcon type={sourceInfo.type} />
                      </div>
                      <div className="font-medium text-xs text-txt-primary truncate mt-0.5">{sourceInfo.title}</div>
                      <div className="text-xs text-txt-muted truncate">{sourceInfo.subtitle}</div>
                      <div className="flex items-center gap-1.5 font-mono text-xs text-txt-primary bg-app-input px-2 py-1 rounded border border-border-subtle/60 mt-1 truncate">
                        <Folder className="h-3 w-3 shrink-0 text-amber-400" />
                        <span className="truncate">{sourceInfo.path}</span>
                      </div>
                    </div>

                    {/* Direction Indicator */}
                    <div className="flex flex-col items-center justify-center gap-1 px-1 py-1">
                      <div className="flex items-center justify-center w-7 h-7 rounded-md bg-sky-500/15 border border-sky-500/30 text-sky-400">
                        <ArrowRight className="h-3.5 w-3.5" />
                      </div>
                      <span className="text-2xs font-medium text-txt-muted uppercase tracking-wider whitespace-nowrap">
                        Syncs to
                      </span>
                    </div>

                    {/* Target box (Target) */}
                    <div className="flex flex-col gap-1 rounded-md bg-app-surface p-2.5 border border-border-subtle min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 text-2xs font-semibold text-sky-400 uppercase tracking-wider">
                          Target (To)
                        </span>
                        <EndpointIcon type={targetInfo.type} />
                      </div>
                      <div className="font-medium text-xs text-txt-primary truncate mt-0.5">{targetInfo.title}</div>
                      <div className="text-xs text-txt-muted truncate">{targetInfo.subtitle}</div>
                      <div className="flex items-center gap-1.5 font-mono text-xs text-txt-primary bg-app-input px-2 py-1 rounded border border-border-subtle/60 mt-1 truncate">
                        <Folder className="h-3 w-3 shrink-0 text-amber-400" />
                        <span className="truncate">{targetInfo.path}</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Footer: Mirroring info & Timestamps */}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-0.5">
                    {profile.deleteExtraneous ? (
                      <div className="flex items-center gap-1.5 text-amber-400 font-medium">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>Mirror: Files in target missing from source will be deleted</span>
                      </div>
                    ) : (
                      <div className="text-txt-muted">
                        Safe sync: Files in target are preserved
                      </div>
                    )}

                    <div className="text-txt-muted ml-auto">
                      {profile.lastRunAt
                        ? `Last run: ${formatDateTime(profile.lastRunAt)}`
                        : `Created: ${formatDateTime(profile.createdAt)}`}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

export default DirSyncSavedProfilesModal;
