import React, { useEffect, useState } from 'react';
import { ArrowUpDown, AlertTriangle, CheckCircle2, ChevronUp, ChevronDown, Loader2, Pause, Play, Trash2, X } from 'lucide-react';
import type { TransferProgress } from '@shared/types/storage';
import { classNames, formatBytes, formatSpeed } from '../lib/format';

export interface GlobalTransferHudProps {
  /** Controlled drawer open state, or unmanaged internal state when omitted. */
  drawerOpen?: boolean;
  onToggleDrawer?: () => void;
}

const STATUS_LABEL: Record<TransferProgress['status'], string> = {
  pending: 'Queued',
  running: 'Transferring',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLOR: Record<TransferProgress['status'], string> = {
  pending: 'bg-slate-500',
  running: 'bg-sky-500',
  paused: 'bg-amber-500',
  completed: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-slate-600',
};

/**
 * Global Transfer HUD mounted in BottomStatusBar.
 * Subscribes globally to `window.multissh.transferGetJobs` / `transferList` and `window.multissh.onTransferProgress`
 * so active SFTP/S3 transfers, aggregate throughput speed, and queue progress are visible across ALL tabs,
 * with a 1-click toggle for the expandable transfer queue drawer (`data-testid="global-transfer-drawer"`).
 */
export const GlobalTransferHud: React.FC<GlobalTransferHudProps> = ({
  drawerOpen: controlledOpen,
  onToggleDrawer,
}) => {
  const [jobs, setJobs] = useState<TransferProgress[]>([]);
  const [internalOpen, setInternalOpen] = useState(false);

  const isDrawerOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const toggleDrawer = () => {
    if (onToggleDrawer) onToggleDrawer();
    else setInternalOpen((v) => !v);
  };

  useEffect(() => {
    let mounted = true;
    const api = window.multissh as typeof window.multissh & {
      transferList?: () => Promise<TransferProgress[]>;
    };
    const fetchInitial = api?.transferGetJobs ?? api?.transferList;
    if (typeof fetchInitial === 'function') {
      void fetchInitial
        .call(api)
        ?.then((initial) => {
          if (mounted && Array.isArray(initial)) setJobs(initial);
        })
        ?.catch(() => {});
    }

    const unsubscribe = api?.onTransferProgress?.((progress) => {
      if (!mounted) return;
      setJobs((prev) => {
        const idx = prev.findIndex((j) => j.jobId === progress.jobId);
        if (idx === -1) return [...prev, progress];
        const next = [...prev];
        next[idx] = progress;
        return next;
      });
    });

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const runningJobs = jobs.filter((j) => j.status === 'running');
  const pendingJobs = jobs.filter((j) => j.status === 'pending');
  const pausedJobs = jobs.filter((j) => j.status === 'paused');
  const failedJobs = jobs.filter((j) => j.status === 'failed');
  const completedJobs = jobs.filter((j) => j.status === 'completed');

  const activeCount = runningJobs.length + pendingJobs.length;
  const totalSpeedBps = runningJobs.reduce((sum, j) => sum + (j.bytesPerSecond || 0), 0);

  // Aggregate progress across active/running jobs
  const activeWithBytes = [...runningJobs, ...pendingJobs].filter((j) => j.totalBytes > 0);
  const totalBytes = activeWithBytes.reduce((sum, j) => sum + j.totalBytes, 0);
  const transferredBytes = activeWithBytes.reduce((sum, j) => sum + j.transferredBytes, 0);
  const aggregatePercent =
    totalBytes > 0
      ? Math.round((transferredBytes / totalBytes) * 100)
      : runningJobs.length > 0
        ? Math.round(runningJobs.reduce((sum, j) => sum + (j.percentage || 0), 0) / runningJobs.length)
        : 0;

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        data-testid="global-transfer-hud"
        aria-expanded={isDrawerOpen}
        aria-label="Global Transfer Queue"
        title="Show / hide global file transfer queue (SFTP & S3)"
        onClick={toggleDrawer}
        className={`flex items-center gap-2 rounded-md px-2 py-0.5 text-2xs font-medium transition-colors ${
          activeCount > 0
            ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30 hover:bg-sky-500/25'
            : failedJobs.length > 0
              ? 'bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25'
              : pausedJobs.length > 0
                ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30 hover:bg-amber-500/25'
                : 'text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary'
        }`}
      >
        {activeCount > 0 ? (
          <Loader2 className="h-3 w-3 animate-spin text-sky-400 shrink-0" />
        ) : failedJobs.length > 0 ? (
          <AlertTriangle className="h-3 w-3 text-red-400 shrink-0" />
        ) : completedJobs.length > 0 && jobs.length > 0 ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />
        ) : (
          <ArrowUpDown className="h-3 w-3 shrink-0" />
        )}

        {activeCount > 0 ? (
          <span className="flex items-center gap-1.5 font-mono">
            <span>{activeCount} active</span>
            <span>·</span>
            <span>{aggregatePercent}%</span>
            {totalSpeedBps > 0 && (
              <>
                <span>·</span>
                <span data-testid="global-transfer-speed">{formatSpeed(totalSpeedBps)}</span>
              </>
            )}
          </span>
        ) : pausedJobs.length > 0 ? (
          <span className="font-mono">{pausedJobs.length} paused</span>
        ) : (
          <span>0 active · Inga aktiva överföringar</span>
        )}

        {failedJobs.length > 0 && (
          <span
            data-testid="global-transfer-failed-badge"
            className="rounded bg-red-500/20 border border-red-500/40 px-1.5 py-0.2 text-[10px] font-semibold text-red-300"
          >
            {failedJobs.length} failed
          </span>
        )}

        {isDrawerOpen ? (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-75" />
        ) : (
          <ChevronUp className="h-3 w-3 shrink-0 opacity-75" />
        )}
      </button>

      {isDrawerOpen && (
        <div
          data-testid="global-transfer-drawer"
          role="region"
          aria-label="Global Transfer Queue Drawer"
          className="sshs3-glass-panel sshs3-drawer-anim fixed bottom-8 left-1/2 z-50 w-full max-w-xl -translate-x-1/2 rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-divider bg-app-surface px-3.5 py-2 text-xs">
            <div className="flex items-center gap-2 font-semibold text-txt-primary">
              <ArrowUpDown className="h-3.5 w-3.5 text-sky-400" />
              <span>
                Global Transfer Queue{' '}
                {activeCount > 0 ? `(${activeCount} active)` : jobs.length === 0 ? '· none active' : `(${jobs.length})`}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {jobs.some((j) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') && (
                <button
                  type="button"
                  data-testid="global-transfer-clear-completed"
                  title="Clear completed"
                  aria-label="Clear completed"
                  onClick={() => {
                    void window.multissh?.transferClearCompleted?.().then(() =>
                      setJobs((prev) =>
                        prev.filter((j) => j.status === 'running' || j.status === 'pending' || j.status === 'paused')
                      )
                    );
                  }}
                  className="flex items-center gap-1 rounded px-2 py-0.5 text-2xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>Clear</span>
                </button>
              )}
              <button
                type="button"
                aria-label="Close transfer queue"
                onClick={toggleDrawer}
                className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {jobs.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-txt-muted">
              No active SFTP or S3 transfers in queue.
            </div>
          ) : (
            <div className="max-h-60 overflow-y-auto divide-y divide-divider px-3.5 py-1">
              {[...jobs].reverse().map((job) => (
                <div key={job.jobId} className="flex items-center gap-2.5 py-2 text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-txt-primary">{job.fileName}</span>
                      <span className="shrink-0 font-mono text-2xs text-txt-muted">
                        {job.totalBytes > 0
                          ? `${formatBytes(job.transferredBytes)} / ${formatBytes(job.totalBytes)} (${Math.round(job.percentage)}%)`
                          : job.status === 'running'
                            ? 'Calculating size...'
                            : formatBytes(job.transferredBytes)}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-app-surface-subtle">
                      <div
                        className={classNames(
                          'h-full rounded-full transition-all',
                          STATUS_COLOR[job.status],
                          job.status === 'running' && !job.totalBytes ? 'w-full animate-pulse opacity-75' : ''
                        )}
                        style={
                          job.totalBytes ? { width: `${Math.min(100, Math.max(0, job.percentage))}%` } : undefined
                        }
                      />
                    </div>
                    <div className="mt-0.5 flex items-center justify-between text-2xs text-txt-muted">
                      <span className="flex items-center gap-1.5 truncate">
                        {job.status === 'running' && !job.totalBytes && (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-400" />
                        )}
                        <span className="truncate">
                          {job.statusMessage || STATUS_LABEL[job.status]}
                          {job.error ? `: ${job.error}` : ''}
                        </span>
                      </span>
                      {job.status === 'running' && job.bytesPerSecond > 0 && (
                        <span className="font-mono">{formatSpeed(job.bytesPerSecond)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {job.status === 'running' && (
                      <button
                        type="button"
                        title="Pause"
                        aria-label="Pause"
                        onClick={() => void window.multissh?.transferPause?.(job.jobId)}
                        className="rounded p-1 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                      >
                        <Pause className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {job.status === 'paused' && (
                      <button
                        type="button"
                        title="Resume"
                        aria-label="Resume"
                        onClick={() => void window.multissh?.transferResume?.(job.jobId)}
                        className="rounded p-1 text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {(job.status === 'running' || job.status === 'pending' || job.status === 'paused') && (
                      <button
                        type="button"
                        title="Cancel"
                        aria-label="Cancel"
                        onClick={() => void window.multissh?.transferCancel?.(job.jobId)}
                        className="rounded p-1 text-red-400 hover:bg-app-surface-hover transition-colors"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default GlobalTransferHud;
