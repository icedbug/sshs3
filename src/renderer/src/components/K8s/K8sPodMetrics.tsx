import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertCircle, Cpu, HardDrive, Info, Loader2, RefreshCw } from 'lucide-react';
import type { PerfSample } from '@shared/types/perf';
import { computeK8sSample } from '../../lib/perfMetrics';
import { formatBytes } from '../../lib/format';

interface K8sPodMetricsProps {
  contextName: string;
  namespace: string;
  podName: string;
  containers: string[];
}

type MetricsStatus = 'loading' | 'ready' | 'no-metrics' | 'forbidden' | 'error';

function formatCpu(millicores: number | null | undefined): string {
  if (millicores === null || millicores === undefined) return '—';
  if (millicores < 1000) return `${millicores}m`;
  return `${(millicores / 1000).toFixed(2)} cores`;
}

function getProgressColor(pct: number): string {
  if (pct >= 90) return 'bg-rose-500';
  if (pct >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export const K8sPodMetrics: React.FC<K8sPodMetricsProps> = ({
  contextName,
  namespace,
  podName,
  containers,
}) => {
  const [selectedContainer, setSelectedContainer] = useState<string>(containers[0] || '');
  const [sample, setSample] = useState<PerfSample | null>(null);
  const [status, setStatus] = useState<MetricsStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (containers.length > 0 && (!selectedContainer || !containers.includes(selectedContainer))) {
      setSelectedContainer(containers[0]);
    }
  }, [containers, selectedContainer]);

  const fetchMetrics = useCallback(async () => {
    if (!selectedContainer) return;
    try {
      const res = await window.multissh.perfK8sSample({
        contextName,
        namespace,
        podName,
        containerName: selectedContainer,
      });

      if (res.ok) {
        setSample(computeK8sSample(res.raw));
        setStatus('ready');
      } else {
        setStatus(res.reason);
      }
    } catch {
      setStatus('error');
    }
  }, [contextName, namespace, podName, selectedContainer]);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 10000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    await fetchMetrics();
    setRefreshing(false);
  };

  const cpuUsed = sample?.cpuMillicores ?? null;
  const cpuLimit = sample?.cpuLimitMillicores ?? null;
  const cpuReq = sample?.cpuRequestMillicores ?? null;
  const cpuPct = sample?.cpuPct ?? (cpuLimit && cpuUsed ? Math.min(100, Math.round((cpuUsed / cpuLimit) * 100)) : null);

  const memUsed = sample?.memUsedBytes ?? null;
  const memLimit = sample?.memLimitBytes ?? null;
  const memReq = sample?.memRequestBytes ?? null;
  const memPct = sample?.memPct ?? (memLimit && memUsed ? Math.min(100, Math.round((memUsed / memLimit) * 100)) : null);

  return (
    <div className="rounded-xl border border-border-subtle bg-app-surface p-4 space-y-3.5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider pb-2.5">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-sky-400" />
          <span className="text-xs font-semibold text-txt-primary">Live Resource Metrics</span>
          {status === 'ready' && (
            <span className="flex items-center gap-1 text-2xs text-emerald-400">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live (10s)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {containers.length > 1 && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="k8s-metrics-container" className="text-2xs text-txt-muted">
                Container:
              </label>
              <select
                id="k8s-metrics-container"
                value={selectedContainer}
                onChange={(e) => setSelectedContainer(e.target.value)}
                className="rounded border border-border-subtle bg-app-surface-subtle px-2 py-0.5 text-xs text-txt-primary focus:outline-none focus:border-sky-500"
              >
                {containers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={refreshing}
            title="Refresh metrics now"
            className="flex items-center gap-1 rounded border border-border-subtle bg-app-surface-subtle px-2 py-0.5 text-2xs text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* States */}
      {status === 'loading' && !sample && (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-txt-muted">
          <Loader2 className="h-4 w-4 animate-spin text-sky-400" />
          Querying metrics.k8s.io...
        </div>
      )}

      {status === 'no-metrics' && (
        <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-app-surface-subtle/60 p-3 text-xs text-txt-muted">
          <Info className="h-4 w-4 shrink-0 text-sky-400 mt-0.5" />
          <div>
            <p className="font-medium text-txt-secondary">Metrics server not reporting</p>
            <p className="text-2xs text-txt-muted mt-0.5">
              Metrics are either unavailable or metrics-server is not installed on this cluster.
            </p>
          </div>
        </div>
      )}

      {status === 'forbidden' && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
          <div>
            <p className="font-medium">Metrics access denied</p>
            <p className="text-2xs text-amber-200/80 mt-0.5">
              Cluster RBAC forbids reading metrics from metrics.k8s.io for this namespace.
            </p>
          </div>
        </div>
      )}

      {status === 'error' && !sample && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-900/60 bg-rose-950/30 p-3 text-xs text-rose-300">
          <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>Failed to query pod metrics</span>
        </div>
      )}

      {/* Metrics Cards */}
      {sample && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* CPU Card */}
          <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 font-medium text-txt-secondary">
                <Cpu className="h-3.5 w-3.5 text-indigo-400" />
                CPU Usage
              </div>
              <span className="font-mono font-semibold text-txt-primary">
                {formatCpu(cpuUsed)}
              </span>
            </div>

            {/* Progress Bar */}
            <div className="h-1.5 w-full rounded-full bg-app-card overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${getProgressColor(cpuPct ?? 10)}`}
                style={{ width: `${Math.min(100, Math.max(5, cpuPct ?? 10))}%` }}
              />
            </div>

            <div className="flex justify-between text-2xs text-txt-muted">
              <span>Request: {formatCpu(cpuReq)}</span>
              <span>Limit: {formatCpu(cpuLimit)}</span>
            </div>
            {cpuPct !== null && (
              <div className="text-2xs text-right font-medium text-txt-secondary">
                {cpuPct}% of limit
              </div>
            )}
          </div>

          {/* Memory Card */}
          <div className="rounded-lg border border-border-subtle bg-app-surface-subtle p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-1.5 font-medium text-txt-secondary">
                <HardDrive className="h-3.5 w-3.5 text-emerald-400" />
                Memory (Working Set)
              </div>
              <span className="font-mono font-semibold text-txt-primary">
                {formatBytes(memUsed ?? 0)}
              </span>
            </div>

            {/* Progress Bar */}
            <div className="h-1.5 w-full rounded-full bg-app-card overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${getProgressColor(memPct ?? 10)}`}
                style={{ width: `${Math.min(100, Math.max(5, memPct ?? 10))}%` }}
              />
            </div>

            <div className="flex justify-between text-2xs text-txt-muted">
              <span>Request: {memReq ? formatBytes(memReq) : '—'}</span>
              <span>Limit: {memLimit ? formatBytes(memLimit) : '—'}</span>
            </div>
            {memPct !== null && (
              <div className="text-2xs text-right font-medium text-txt-secondary">
                {memPct}% of limit
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
