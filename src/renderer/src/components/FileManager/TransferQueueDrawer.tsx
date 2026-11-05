import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2, Pause, Play, Trash2, X } from 'lucide-react';
import type { TransferProgress } from '@shared/types/storage';
import { classNames, formatBytes, formatSpeed } from '../../lib/format';

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

export const TransferQueueDrawer: React.FC = () => {
  const [jobs, setJobs] = useState<TransferProgress[]>([]);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let mounted = true;
    void window.multissh.transferGetJobs().then((initial) => {
      if (mounted) setJobs(initial);
    });

    const unsubscribe = window.multissh.onTransferProgress((progress) => {
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
      unsubscribe();
    };
  }, []);

  const activeCount = jobs.filter((j) => j.status === 'running' || j.status === 'pending').length;
  const failedCount = jobs.filter((j) => j.status === 'failed').length;

  return (
    <div className="flex flex-col border-t border-divider bg-app-surface text-txt-primary">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="flex items-center justify-between px-3 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <span>
            Transfers {activeCount > 0 ? `(${activeCount} active)` : jobs.length === 0 ? '· none active' : ''}
          </span>
          {failedCount > 0 && (
            <span className="rounded bg-red-500/20 border border-red-500/30 px-2 py-0.5 text-2xs font-semibold text-red-400">
              {failedCount} failed
            </span>
          )}
        </div>
        <span className="flex items-center gap-2">
          {jobs.some((j) => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled') && (
            <button
              type="button"
              title="Clear completed"
              aria-label="Clear completed"
              onClick={(e) => {
                e.stopPropagation();
                void window.multissh.transferClearCompleted().then(() =>
                  setJobs((prev) => prev.filter((j) => j.status === 'running' || j.status === 'pending' || j.status === 'paused'))
                );
              }}
              className="rounded p-0.5 text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-txt-muted" /> : <ChevronUp className="h-3.5 w-3.5 text-txt-muted" />}
        </span>
      </div>

      {expanded && jobs.length > 0 && (
        <div className="max-h-48 overflow-y-auto px-3 pb-2">
          {[...jobs].reverse().map((job) => (
            <div key={job.jobId} className="flex items-center gap-2 border-b border-divider py-1.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-txt-primary">{job.fileName}</span>
                  <span className="shrink-0 text-txt-muted text-xs">
                    {job.totalBytes > 0
                      ? `${formatBytes(job.transferredBytes)} / ${formatBytes(job.totalBytes)}`
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
                    style={job.totalBytes ? { width: `${Math.min(100, Math.max(0, job.percentage))}%` } : undefined}
                  />
                </div>
                <div className="mt-0.5 flex items-center justify-between text-xs text-txt-muted">
                  <span className="flex items-center gap-1.5 truncate">
                    {job.status === 'running' && !job.totalBytes && (
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin text-sky-400" />
                    )}
                    <span className="truncate">
                      {job.statusMessage || STATUS_LABEL[job.status]}
                      {job.error ? `: ${job.error}` : ''}
                    </span>
                  </span>
                  {job.status === 'running' && job.bytesPerSecond > 0 && <span>{formatSpeed(job.bytesPerSecond)}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {job.status === 'running' && (
                  <button
                    type="button"
                    title="Pause"
                    aria-label="Pause"
                    onClick={() => void window.multissh.transferPause(job.jobId)}
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
                    onClick={() => void window.multissh.transferResume(job.jobId)}
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
                    onClick={() => void window.multissh.transferCancel(job.jobId)}
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
  );
};

export default TransferQueueDrawer;
