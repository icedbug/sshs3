import React, { useEffect, useMemo, useState, useRef } from 'react';
import {
  ArrowRight,
  Cable,
  Home,
  Loader2,
  Pencil,
  Plus,
  Shuffle,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import type { SSHActiveTunnel, SSHConnectionConfig, SSHTunnelConfig } from '@shared/types/ssh';
import { formatDateTime, describeIpcError } from '../../lib/format';
import { SSHTunnelWizard } from './SSHTunnelWizard';
import { useConfirm } from '../ConfirmDialog';
import { useEscapeToClose } from '../../lib/useModalDismiss';
import { useDialogFocus } from '../../lib/useDialogFocus';

interface SSHGlobalTunnelsModalProps {
  open: boolean;
  onClose: () => void;
}

function tunnelLabel(tunnel: SSHTunnelConfig): { icon: React.ReactNode; text: string } {
  if (tunnel.type === 'dynamic') {
    return { icon: <Shuffle className="h-3.5 w-3.5 text-indigo-400" />, text: `SOCKS on 127.0.0.1:${tunnel.localPort}` };
  }
  if (tunnel.type === 'remote') {
    return {
      icon: <Home className="h-3.5 w-3.5 text-amber-400" />,
      text: `Remote port ${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}`,
    };
  }
  return {
    icon: <ArrowRight className="h-3.5 w-3.5 text-sky-400" />,
    text: `127.0.0.1:${tunnel.localPort} → ${tunnel.remoteHost}:${tunnel.remotePort}`,
  };
}

export const SSHGlobalTunnelsModal: React.FC<SSHGlobalTunnelsModalProps> = ({ open, onClose }) => {
  const [profiles, setProfiles] = useState<SSHConnectionConfig[]>([]);
  const [activeTunnels, setActiveTunnels] = useState<SSHActiveTunnel[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTunnelConnectionId, setNewTunnelConnectionId] = useState('');
  const [wizardTarget, setWizardTarget] = useState<{ connectionId: string; tunnelId?: string } | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([window.multissh.profilesGet(), window.multissh.sshTunnelList()])
      .then(([{ ssh }, active]) => {
        setProfiles(ssh);
        setActiveTunnels(active);
      })
      .catch((err) => setError(describeIpcError(err, 'Failed to load tunnels')))
      .finally(() => setLoading(false));

    const unsubscribe = window.multissh.onSshTunnelEvent(setActiveTunnels);
    return () => unsubscribe();
  }, [open]);

  const profilesWithTunnels = useMemo(() => profiles.filter((p) => (p.tunnels || []).length > 0), [profiles]);
  const wizardConnection = profiles.find((p) => p.id === wizardTarget?.connectionId) || null;
  const wizardExistingTunnel = wizardConnection?.tunnels?.find((t) => t.id === wizardTarget?.tunnelId);

  const findActive = (tunnelId: string) => activeTunnels.find((t) => t.tunnel.id === tunnelId);

  const handleStart = async (connection: SSHConnectionConfig, tunnel: SSHTunnelConfig) => {
    setBusyId(tunnel.id);
    setError(null);
    try {
      const result = await window.multissh.sshTunnelStart(connection, tunnel);
      setActiveTunnels((prev) => [...prev.filter((t) => t.id !== result.id), result]);
    } catch (err) {
      setError(describeIpcError(err, 'Failed to start the tunnel'));
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (activeId: string) => {
    setBusyId(activeId);
    try {
      await window.multissh.sshTunnelStop(activeId);
      setActiveTunnels((prev) => prev.filter((t) => t.id !== activeId));
    } catch (err) {
      setError(describeIpcError(err, 'Failed to stop the tunnel'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (connection: SSHConnectionConfig, tunnel: SSHTunnelConfig) => {
    if (!(await confirm({ title: 'Delete tunnel', message: `Delete the saved tunnel "${tunnel.name}"?` }))) return;
    setBusyId(tunnel.id);
    setError(null);
    try {
      const active = findActive(tunnel.id);
      if (active) {
        await window.multissh.sshTunnelStop(active.id).catch(() => {});
        setActiveTunnels((prev) => prev.filter((t) => t.id !== active.id));
      }
      const updated: SSHConnectionConfig = {
        ...connection,
        tunnels: (connection.tunnels || []).filter((t) => t.id !== tunnel.id),
      };
      await window.multissh.profilesSaveSSH(updated);
      setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete the tunnel'));
    } finally {
      setBusyId(null);
    }
  };

  useEscapeToClose(onClose, open, !wizardTarget);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="All SSH tunnels"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
              <Cable className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-txt-primary">SSH Tunnels</h2>
              <p className="text-xs text-txt-muted">All connections</p>
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && (
            <div role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 p-2.5 text-xs text-red-300 flex items-center gap-2">
              <XCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-txt-muted">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading tunnels...
            </div>
          )}

          {!loading && wizardConnection && (
            <SSHTunnelWizard
              connection={wizardConnection}
              existingTunnel={wizardExistingTunnel}
              activeTunnelId={wizardExistingTunnel ? findActive(wizardExistingTunnel.id)?.id : undefined}
              onCancel={() => setWizardTarget(null)}
              onDone={(updated) => {
                setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
                setWizardTarget(null);
                window.multissh
                  .sshTunnelList()
                  .then(setActiveTunnels)
                  .catch(() => {});
              }}
            />
          )}

          {!loading && !wizardConnection && (
            <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-app-surface p-3">
              <select
                aria-label="Connection for the new tunnel"
                value={newTunnelConnectionId}
                onChange={(e) => setNewTunnelConnectionId(e.target.value)}
                className="flex-1 rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1.5 text-sm text-txt-primary focus:border-sky-500/50 focus:outline-none"
              >
                <option value="">Select a connection...</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.username}@{p.host})
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!newTunnelConnectionId}
                onClick={() => setWizardTarget({ connectionId: newTunnelConnectionId })}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                New Tunnel
              </button>
            </div>
          )}

          {!loading && !wizardConnection && (
            <div className="space-y-4">
              {profilesWithTunnels.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border-subtle py-8 text-center text-xs text-txt-muted">
                  No tunnels saved on any connection yet.
                </div>
              ) : (
                profilesWithTunnels.map((profile) => (
                  <div key={profile.id} className="space-y-2">
                    <h3 className="text-sm font-semibold text-txt-primary">{profile.name}</h3>
                    <div className="divide-y divide-divider rounded-xl border border-border-subtle bg-app-surface overflow-hidden">
                      {(profile.tunnels || []).map((tunnel) => {
                        const active = findActive(tunnel.id);
                        const { icon, text } = tunnelLabel(tunnel);
                        const isBusy = busyId === tunnel.id || busyId === active?.id;
                        return (
                          <div key={tunnel.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5">
                            <div className="min-w-0 space-y-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`flex h-2 w-2 rounded-full ${
                                    active?.status === 'error'
                                      ? 'bg-rose-500'
                                      : active
                                        ? 'bg-emerald-500 animate-pulse'
                                        : 'bg-txt-muted/40'
                                  }`}
                                />
                                {icon}
                                <span className="text-xs font-semibold text-txt-primary">{tunnel.name}</span>
                              </div>
                              <div className="text-xs text-txt-muted flex flex-wrap items-center gap-2">
                                <span className="font-mono">{text}</span>
                                {tunnel.description && (
                          <span className="truncate text-txt-secondary" title={tunnel.description}>
                            · {tunnel.description}
                          </span>
                        )}
                                {active && <span>Started: {formatDateTime(active.startedAt)}</span>}
                              </div>
                              {active?.error && (
                                <div className="flex items-center gap-1.5 text-xs text-rose-400">
                                  <XCircle className="h-3 w-3 shrink-0" />
                                  <span className="break-all">{active.error}</span>
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                aria-label="Edit tunnel"
                                type="button"
                                title="Edit tunnel"
                                onClick={() => setWizardTarget({ connectionId: profile.id, tunnelId: tunnel.id })}
                                className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                title="Delete tunnel"
                                aria-label={`Delete tunnel ${tunnel.name}`}
                                disabled={isBusy}
                                onClick={() => handleDelete(profile, tunnel)}
                                className="rounded-lg p-1.5 text-txt-muted hover:bg-rose-950/40 hover:text-rose-300 transition-colors disabled:opacity-50"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                              {active ? (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleStop(active.id)}
                                  className="flex items-center gap-1 rounded-lg border border-rose-900/60 bg-rose-950/40 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-900/50 transition-colors disabled:opacity-50"
                                >
                                  {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                                  Stop
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleStart(profile, tunnel)}
                                  className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors disabled:opacity-50"
                                >
                                  {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Start'}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end border-t border-divider bg-app-surface px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-subtle bg-app-surface-subtle px-4 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default SSHGlobalTunnelsModal;
