import React, { useEffect, useState, useRef } from 'react';
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
import { createRendererLogger } from '../../lib/log';
const log = createRendererLogger('SSHTunnelsModal');

interface SSHTunnelsModalProps {
  connection: SSHConnectionConfig;
  open: boolean;
  onClose: () => void;
  /** Called whenever the connection's saved tunnels change, so the caller's profile cache stays in sync. */
  onProfileUpdated?: (config: SSHConnectionConfig) => void;
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

export const SSHTunnelsModal: React.FC<SSHTunnelsModalProps> = ({
  connection,
  open,
  onClose,
  onProfileUpdated,
}) => {
  const [conn, setConn] = useState(connection);
  const [activeTunnels, setActiveTunnels] = useState<SSHActiveTunnel[]>([]);
  // 'new' opens the wizard for a fresh tunnel; a string edits the saved tunnel with that id.
  const [wizardTarget, setWizardTarget] = useState<'new' | string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    setConn(connection);
  }, [connection]);

  useEffect(() => {
    if (!open) return;
    window.multissh
      .sshTunnelList()
      .then(setActiveTunnels)
      .catch((err) => log.error('Failed to list active tunnels:', err));

    const unsubscribe = window.multissh.onSshTunnelEvent(setActiveTunnels);
    return () => unsubscribe();
  }, [open]);

  const activeForConnection = activeTunnels.filter((t) => t.connectionId === conn.id);
  const findActive = (tunnelId: string) => activeForConnection.find((t) => t.tunnel.id === tunnelId);
  const editingTunnel =
    wizardTarget && wizardTarget !== 'new' ? (conn.tunnels || []).find((t) => t.id === wizardTarget) : undefined;
  const adHoc = activeForConnection.filter(
    (t) => !(conn.tunnels || []).some((saved) => saved.id === t.tunnel.id)
  );

  const persist = async (nextTunnels: SSHTunnelConfig[]) => {
    const updated: SSHConnectionConfig = { ...conn, tunnels: nextTunnels };
    await window.multissh.profilesSaveSSH(updated);
    setConn(updated);
    onProfileUpdated?.(updated);
  };

  const handleStart = async (tunnel: SSHTunnelConfig) => {
    setBusyId(tunnel.id);
    setError(null);
    try {
      const result = await window.multissh.sshTunnelStart(conn, tunnel);
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

  // A temporary tunnel is not saved: stopping it drops its configuration, so it asks first.
  const handleStopTemporary = async (activeId: string, label: string) => {
    const confirmed = await confirm({
      title: 'Stop temporary tunnel',
      message: `Stop the temporary tunnel ${label}? It is not saved, so you would have to set it up again.`,
      confirmLabel: 'Stop tunnel',
    });
    if (confirmed) await handleStop(activeId);
  };

  const handleDelete = async (tunnel: SSHTunnelConfig) => {
    if (!(await confirm({ title: 'Delete tunnel', message: `Delete the saved tunnel "${tunnel.name}"?` })))
      return;
    const active = findActive(tunnel.id);
    if (active) {
      await window.multissh.sshTunnelStop(active.id).catch(() => {});
    }
    try {
      await persist((conn.tunnels || []).filter((t) => t.id !== tunnel.id));
    } catch (err) {
      setError(describeIpcError(err, 'Failed to delete the tunnel'));
    }
  };

  useEscapeToClose(onClose, open, !wizardTarget);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);

  if (!open) return null;

  const savedTunnels = conn.tunnels || [];

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="SSH Tunnels"
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
              <p className="text-xs text-txt-muted">
                {conn.name} ({conn.username}@{conn.host})
              </p>
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

          {wizardTarget ? (
            <SSHTunnelWizard
              connection={conn}
              existingTunnel={editingTunnel}
              activeTunnelId={editingTunnel ? findActive(editingTunnel.id)?.id : undefined}
              onCancel={() => setWizardTarget(null)}
              onDone={(updated) => {
                setConn(updated);
                onProfileUpdated?.(updated);
                setWizardTarget(null);
                window.multissh
                  .sshTunnelList()
                  .then(setActiveTunnels)
                  .catch(() => {});
              }}
            />
          ) : (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setWizardTarget('new')}
                className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 shadow-sm transition-colors"
              >
                <Plus className="h-3.5 w-3.5" />
                New Tunnel
              </button>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-txt-primary">Saved Tunnels ({savedTunnels.length})</h3>
            {savedTunnels.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border-subtle py-8 text-center text-xs text-txt-muted">
                No tunnels saved on this connection yet.
              </div>
            ) : (
              <div className="divide-y divide-divider rounded-xl border border-border-subtle bg-app-surface overflow-hidden">
                {savedTunnels.map((tunnel) => {
                  const active = findActive(tunnel.id);
                  const { icon, text } = tunnelLabel(tunnel);
                  const isBusy = busyId === tunnel.id || busyId === active?.id;
                  return (
                    <div key={tunnel.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`flex h-2 w-2 rounded-full ${
                              active?.status === 'error' ? 'bg-rose-500' : active ? 'bg-emerald-500 animate-pulse' : 'bg-txt-muted/40'
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
                            onClick={() => handleStart(tunnel)}
                            className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors disabled:opacity-50"
                          >
                            {isBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Start'}
                          </button>
                        )}
                        <button
                          aria-label="Edit tunnel"
                          type="button"
                          title="Edit tunnel"
                          onClick={() => setWizardTarget(tunnel.id)}
                          className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          aria-label="Delete saved tunnel"
                          type="button"
                          title="Delete saved tunnel"
                          onClick={() => void handleDelete(tunnel)}
                          className="rounded-lg p-1.5 text-red-400 hover:bg-app-surface-hover transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {adHoc.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-txt-primary">Temporary Tunnels (not saved)</h3>
              <div className="divide-y divide-divider rounded-xl border border-border-subtle bg-app-surface overflow-hidden">
                {adHoc.map((t) => {
                  const { icon, text } = tunnelLabel(t.tunnel);
                  return (
                    <div key={t.id} className="flex flex-wrap items-center justify-between gap-3 p-3.5">
                      <div className="min-w-0 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className={`flex h-2 w-2 rounded-full ${t.status === 'error' ? 'bg-rose-500' : 'bg-emerald-500 animate-pulse'}`} />
                          {icon}
                          <span className="font-mono text-xs text-txt-primary">{text}</span>
                        </div>
                        <div className="text-xs text-txt-muted">Started: {formatDateTime(t.startedAt)}</div>
                      </div>
                      <button
                        type="button"
                        disabled={busyId === t.id}
                        onClick={() => void handleStopTemporary(t.id, text)}
                        className="flex items-center gap-1 rounded-lg border border-rose-900/60 bg-rose-950/40 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-900/50 transition-colors disabled:opacity-50"
                      >
                        {busyId === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                        Stop
                      </button>
                    </div>
                  );
                })}
              </div>
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

export default SSHTunnelsModal;
