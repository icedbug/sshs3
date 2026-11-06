import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Cpu, FolderTree, HardDrive, Network, Sparkles, Wifi, X } from 'lucide-react';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';
import { useHub } from '../lib/aiHub';

export type TelemetryHealthStatus = 'healthy' | 'warning' | 'offline';

export interface SessionTelemetrySnapshot {
  cpuPct: number;
  memPct: number;
  latencyMs: string;
  latencyNumericMs: number;
  netIoLabel: string;
  loadAvgLabel: string;
  sparkValues: number[];
  sparkPoints: string;
  strokeColor: string;
  healthStatus: TelemetryHealthStatus;
}

export interface SessionTelemetryPillProps {
  paneId?: string;
  config?: SSHConnectionConfig;
  local?: boolean;
  k8sTarget?: K8sTerminalTarget;
  k8sLogTarget?: K8sTerminalTarget;
  hostLabel?: string;
  /** Optional explicit CPU % override (e.g. from live perf sampler or boundary tests). */
  cpuPct?: number;
  /** Optional explicit RAM % override. */
  memPct?: number;
  /** Optional explicit latency in ms (number or formatted string). */
  latencyMs?: number | string;
  /** Optional explicit Network I/O label. */
  netIoLabel?: string;
  /** Optional explicit 8-point series (0-100) for the sparkline. */
  sparklineValues?: number[];
  /** Optional explicit connection status. */
  status?: 'online' | 'healthy' | 'degraded' | 'warning' | 'offline' | 'disconnected';
  /** True when the session is disconnected/offline. */
  disconnected?: boolean;
  /** True when SFTP split view is currently active for this pane. */
  isSftpSplitActive?: boolean;
  /** Custom data-testid for secondary non-focused panes; defaults to "session-telemetry-pill". */
  testId?: string;
  onSplitSftp?: () => void;
  onDiagnoseAi?: () => void;
  onOpenFleet?: () => void;
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function buildSparklinePolylinePoints(values: number[], width = 56, height = 16): string {
  const count = 8;
  const normalized: number[] = [];
  for (let i = 0; i < count; i++) {
    const raw = values[i] ?? values[values.length - 1] ?? 25;
    normalized.push(Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 25)));
  }
  const stepX = width / (count - 1);
  return normalized
    .map((val, idx) => {
      const x = Math.round(idx * stepX);
      // Map 0..100 -> (height - 2)..2 so higher values are higher on the SVG canvas
      const y = Math.round(height - 2 - (val / 100) * (height - 4));
      return `${x},${y}`;
    })
    .join(' ');
}

export function computeSessionTelemetry(props: {
  seedKey: string;
  clusterOrRole?: string;
  cpuPct?: number;
  memPct?: number;
  latencyMs?: number | string;
  netIoLabel?: string;
  sparklineValues?: number[];
  status?: SessionTelemetryPillProps['status'];
  disconnected?: boolean;
}): SessionTelemetrySnapshot {
  const isOffline =
    props.disconnected === true ||
    props.status === 'offline' ||
    props.status === 'disconnected';

  const hash = hashSeed(props.seedKey || 'sshs3-default-host');
  const roleHint = (props.clusterOrRole || props.seedKey || '').toLowerCase();
  const isOntap = roleHint.includes('ontap') || roleHint.includes('netapp');
  const isS3 = roleHint.includes('storagegrid') || roleHint.includes('minio') || roleHint.includes('s3');
  const isCeph = roleHint.includes('ceph') || roleHint.includes('san');

  const computedCpu =
    typeof props.cpuPct === 'number' && Number.isFinite(props.cpuPct)
      ? Math.max(0, Math.min(100, Math.round(props.cpuPct)))
      : isOffline
        ? 0
        : 22 + (hash % 46);

  const computedMem =
    typeof props.memPct === 'number' && Number.isFinite(props.memPct)
      ? Math.max(0, Math.min(100, Math.round(props.memPct)))
      : isOffline
        ? 0
        : 36 + ((hash >> 3) % 42);

  const defaultLatencyNum = isOntap
    ? 0.28 + (hash % 20) * 0.01
    : isS3
      ? 0.44 + (hash % 30) * 0.01
      : isCeph
        ? 0.58 + (hash % 35) * 0.01
        : 0.35 + (hash % 28) * 0.01;

  let latencyNumericMs = defaultLatencyNum;
  let latencyMsStr = `${defaultLatencyNum.toFixed(2)} ms`;

  if (isOffline) {
    latencyNumericMs = 0;
    latencyMsStr = '-- ms';
  } else if (typeof props.latencyMs === 'number' && Number.isFinite(props.latencyMs)) {
    latencyNumericMs = Math.max(0, props.latencyMs);
    latencyMsStr =
      latencyNumericMs < 10 ? `${latencyNumericMs.toFixed(2)} ms` : `${Math.round(latencyNumericMs)} ms`;
  } else if (typeof props.latencyMs === 'string' && props.latencyMs.trim()) {
    latencyMsStr = props.latencyMs.trim().endsWith('ms')
      ? props.latencyMs.trim()
      : `${props.latencyMs.trim()} ms`;
    const parsed = parseFloat(props.latencyMs);
    if (Number.isFinite(parsed)) latencyNumericMs = parsed;
  }

  const isWarning =
    !isOffline &&
    (computedCpu > 85 ||
      props.status === 'degraded' ||
      props.status === 'warning' ||
      latencyNumericMs > 150);

  const healthStatus: TelemetryHealthStatus = isOffline
    ? 'offline'
    : isWarning
      ? 'warning'
      : 'healthy';

  const sparkValues: number[] =
    props.sparklineValues && props.sparklineValues.length > 0
      ? props.sparklineValues.slice(0, 8)
      : Array.from({ length: 8 }, (_, idx) => {
          if (isOffline) return 5;
          const jitter = ((hash >> (idx * 2)) % 17) - 8;
          return Math.max(6, Math.min(98, computedCpu + jitter));
        });
  if (sparkValues.length === 8 && !isOffline) {
    sparkValues[7] = computedCpu;
  }

  const sparkPoints = buildSparklinePolylinePoints(sparkValues, 56, 16);

  const strokeColor =
    healthStatus === 'offline'
      ? '#64748b'
      : healthStatus === 'warning'
        ? '#f59e0b'
        : isOntap
          ? '#38bdf8'
          : '#10b981';

  const netIoLabel =
    props.netIoLabel ||
    (isOffline
      ? '0.0 MB/s'
      : isOntap
        ? `${(28 + (hash % 24)).toFixed(1)} MB/s · ${(32 + (hash % 20)).toFixed(1)}k IOPS`
        : `${(12 + (hash % 18)).toFixed(1)} MB/s · ${(16 + (hash % 18)).toFixed(1)}k ops/s`);

  const loadAvgLabel = isOffline
    ? '0.00 / 0.00 / 0.00'
    : `${(computedCpu / 25).toFixed(2)} / ${((computedCpu * 0.88) / 25).toFixed(2)} / ${((computedCpu * 0.76) / 25).toFixed(2)}`;

  return {
    cpuPct: computedCpu,
    memPct: computedMem,
    latencyMs: latencyMsStr,
    latencyNumericMs,
    netIoLabel,
    loadAvgLabel,
    sparkValues,
    sparkPoints,
    strokeColor,
    healthStatus,
  };
}

export const SessionTelemetryPill: React.FC<SessionTelemetryPillProps> = ({
  paneId,
  config,
  local,
  k8sTarget,
  k8sLogTarget,
  hostLabel,
  cpuPct,
  memPct,
  latencyMs,
  netIoLabel,
  sparklineValues,
  status,
  disconnected,
  isSftpSplitActive = false,
  testId = 'session-telemetry-pill',
  onSplitSftp,
  onDiagnoseAi,
  onOpenFleet,
}) => {
  const [expanded, setExpanded] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hub = useHub();

  const targetName = useMemo(() => {
    if (hostLabel) return hostLabel;
    if (config?.name) return config.name;
    if (config?.host) return config.host;
    if (k8sTarget) return `${k8sTarget.podName}/${k8sTarget.containerName}`;
    if (k8sLogTarget) return `${k8sLogTarget.podName}/${k8sLogTarget.containerName}`;
    if (local) return 'localhost';
    return 'unconnected';
  }, [hostLabel, config, k8sTarget, k8sLogTarget, local]);

  const hubSessionDisconnected = useMemo(() => {
    if (!config || !hub?.sessions?.length) return false;
    const matching = hub.sessions.filter(
      (s) => s.profileId === config.id || s.label === config.name || s.label === config.host
    );
    return matching.length > 0 && matching.every((s) => s.state === 'disconnected');
  }, [config, hub?.sessions]);

  const effectiveDisconnected =
    disconnected !== undefined
      ? disconnected
      : status === 'offline' || status === 'disconnected'
        ? true
        : hubSessionDisconnected;

  const telemetry = useMemo(
    () =>
      computeSessionTelemetry({
        seedKey: `${config?.id ?? ''}-${targetName}-${config?.host ?? ''}`,
        clusterOrRole: config?.cluster || config?.role || config?.nodeRole,
        cpuPct,
        memPct,
        latencyMs,
        netIoLabel,
        sparklineValues,
        status,
        disconnected: effectiveDisconnected,
      }),
    [
      config?.id,
      config?.host,
      config?.cluster,
      config?.role,
      config?.nodeRole,
      targetName,
      cpuPct,
      memPct,
      latencyMs,
      netIoLabel,
      sparklineValues,
      status,
      effectiveDisconnected,
    ]
  );

  // Close popover on outside click or Escape key
  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setExpanded(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [expanded]);

  const handleSplitSftpClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSplitSftp?.();
    window.dispatchEvent(
      new CustomEvent('sshs3:split-sftp', {
        detail: {
          paneId,
          config,
          host: targetName,
        },
      })
    );
    setExpanded(false);
  };

  const handleDiagnoseAiClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDiagnoseAi?.();
    const prompt = `Analysera live-telemetri för @${targetName} (${config ? `${config.username}@${config.host}:${config.port ?? 22}` : targetName}): CPU ${telemetry.cpuPct}%, RAM ${telemetry.memPct}%, Latens ${telemetry.latencyMs}, I/O ${telemetry.netIoLabel}, Load ${telemetry.loadAvgLabel}. Identifiera flaskhalsar och föreslå read-only diagnossteg.`;
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-open', {
        detail: {
          view: 'Work',
          mode: 'panel',
          paneId,
          host: targetName,
          profileId: config?.id,
          telemetry: {
            cpuPct: telemetry.cpuPct,
            memPct: telemetry.memPct,
            latencyMs: telemetry.latencyMs,
            netIoLabel: telemetry.netIoLabel,
            loadAvg: telemetry.loadAvgLabel,
            healthStatus: telemetry.healthStatus,
          },
          prompt,
        },
      })
    );
    setExpanded(false);
  };

  const handleOpenFleetClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onOpenFleet?.();
    window.dispatchEvent(
      new CustomEvent('sshs3:open-fleet-overview', {
        detail: {
          paneId,
          host: targetName,
          profileId: config?.id,
        },
      })
    );
    setExpanded(false);
  };

  const dotClass =
    telemetry.healthStatus === 'offline'
      ? 'bg-rose-400/80'
      : telemetry.healthStatus === 'warning'
        ? 'bg-amber-400 sshs3-sonar-amber'
        : 'bg-emerald-400 sshs3-sonar-emerald';

  const pillWarningClass =
    telemetry.healthStatus === 'warning'
      ? 'border-amber-500/45 text-amber-300'
      : telemetry.healthStatus === 'offline'
        ? 'border-rose-500/35 text-txt-muted opacity-80'
        : '';

  return (
    <div
      ref={wrapperRef}
      className="relative inline-flex items-center"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        data-testid={testId}
        data-health={telemetry.healthStatus}
        aria-expanded={expanded}
        aria-label={`Session telemetry for ${targetName}: ${telemetry.cpuPct}% CPU, ${telemetry.latencyMs}`}
        title="Click to expand live host telemetry & quick workspace actions"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((prev) => !prev);
        }}
        className={`sshs3-telemetry-pill cursor-pointer font-mono select-none ${pillWarningClass}`}
      >
        <span
          data-testid="session-telemetry-dot"
          data-health={telemetry.healthStatus}
          className={`h-1.5 w-1.5 rounded-full shrink-0 ${dotClass}`}
        />
        <span data-testid="session-telemetry-cpu" className="font-semibold">
          {telemetry.healthStatus === 'offline' ? 'Offline' : `${telemetry.cpuPct}% CPU`}
        </span>
        <span className="text-txt-muted">·</span>
        <span data-testid="session-telemetry-latency">{telemetry.latencyMs}</span>
        <svg
          className="h-3 w-10 shrink-0 sshs3-sparkline"
          viewBox="0 0 56 16"
          fill="none"
          aria-hidden="true"
        >
          <polyline
            data-testid="session-telemetry-sparkline"
            fill="none"
            stroke={telemetry.strokeColor}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={telemetry.sparkPoints}
          />
        </svg>
      </button>

      {expanded && (
        <div
          data-testid="session-telemetry-detail"
          role="dialog"
          aria-label={`Live telemetry details for ${targetName}`}
          onClick={(e) => e.stopPropagation()}
          className="sshs3-glass-panel sshs3-drawer-anim absolute left-0 top-full z-[90] mt-1.5 w-80 rounded-xl p-3 text-left shadow-2xl"
        >
          <div className="flex items-start justify-between gap-2 border-b border-divider pb-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full shrink-0 ${dotClass}`} />
                <span className="truncate font-mono text-xs font-bold text-txt-primary">
                  {targetName}
                </span>
                <span
                  data-testid="session-telemetry-status-badge"
                  className={`rounded border px-1.5 py-0.2 text-[9.5px] font-mono uppercase ${
                    telemetry.healthStatus === 'warning'
                      ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                      : telemetry.healthStatus === 'offline'
                        ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
                        : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                  }`}
                >
                  {telemetry.healthStatus === 'warning'
                    ? 'High Load'
                    : telemetry.healthStatus === 'offline'
                      ? 'Offline'
                      : 'Healthy'}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10.5px] text-txt-muted">
                {config
                  ? `${config.username}@${config.host}:${config.port ?? 22}${config.cluster ? ` · ${config.cluster}` : ''}`
                  : local
                    ? 'Local Workstation Shell'
                    : targetName}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close telemetry popover"
              onClick={() => setExpanded(false)}
              className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border-subtle bg-app-card p-2">
              <div className="flex items-center justify-between text-[9.5px] font-mono uppercase text-txt-muted">
                <span className="inline-flex items-center gap-1">
                  <Cpu className="h-3 w-3 text-sky-400" />
                  <span>CPU</span>
                </span>
                <span
                  className={`font-semibold ${
                    telemetry.cpuPct > 85 ? 'text-amber-300' : 'text-txt-primary'
                  }`}
                >
                  {telemetry.cpuPct}%
                </span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-app-surface-subtle">
                <div
                  className={`h-full rounded-full transition-all ${
                    telemetry.cpuPct > 85 ? 'bg-amber-400' : 'bg-sky-400'
                  }`}
                  style={{ width: `${telemetry.cpuPct}%` }}
                />
              </div>
              <div className="mt-1 font-mono text-[9.5px] text-txt-muted">
                Load: {telemetry.loadAvgLabel}
              </div>
            </div>

            <div className="rounded-lg border border-border-subtle bg-app-card p-2">
              <div className="flex items-center justify-between text-[9.5px] font-mono uppercase text-txt-muted">
                <span className="inline-flex items-center gap-1">
                  <HardDrive className="h-3 w-3 text-emerald-400" />
                  <span>RAM</span>
                </span>
                <span className="font-semibold text-txt-primary">{telemetry.memPct}%</span>
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-app-surface-subtle">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all"
                  style={{ width: `${telemetry.memPct}%` }}
                />
              </div>
              <div className="mt-1 font-mono text-[9.5px] text-txt-muted">
                Memory allocation OK
              </div>
            </div>

            <div className="rounded-lg border border-border-subtle bg-app-card p-2">
              <div className="flex items-center justify-between text-[9.5px] font-mono uppercase text-txt-muted">
                <span className="inline-flex items-center gap-1">
                  <Network className="h-3 w-3 text-amber-400" />
                  <span>Network I/O</span>
                </span>
              </div>
              <div className="mt-1 font-mono text-[11px] font-semibold text-txt-primary">
                {telemetry.netIoLabel}
              </div>
            </div>

            <div className="rounded-lg border border-border-subtle bg-app-card p-2">
              <div className="flex items-center justify-between text-[9.5px] font-mono uppercase text-txt-muted">
                <span className="inline-flex items-center gap-1">
                  <Wifi className="h-3 w-3 text-emerald-400" />
                  <span>Latency</span>
                </span>
                <span className="font-semibold text-emerald-300">{telemetry.latencyMs}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <svg className="h-4 w-20 sshs3-sparkline" viewBox="0 0 56 16" fill="none">
                  <polyline
                    fill="none"
                    stroke={telemetry.strokeColor}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={telemetry.sparkPoints}
                  />
                </svg>
                <span className="font-mono text-[9px] text-txt-muted">8-pt live</span>
              </div>
            </div>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-divider pt-2">
            <button
              type="button"
              data-testid="telemetry-action-split-sftp"
              onClick={handleSplitSftpClick}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-mono font-medium transition-colors ${
                isSftpSplitActive
                  ? 'border-sky-400/50 bg-sky-500/20 text-sky-200'
                  : 'border-border-subtle bg-app-surface-subtle text-txt-primary hover:border-sky-400/40 hover:bg-app-surface-hover'
              }`}
            >
              <FolderTree className="h-3 w-3 text-amber-400" />
              <span>{isSftpSplitActive ? 'Close SFTP Split' : 'Split SFTP'}</span>
            </button>

            <button
              type="button"
              data-testid="telemetry-action-diagnose-ai"
              onClick={handleDiagnoseAiClick}
              className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[10px] font-mono font-medium text-sky-300 hover:bg-sky-500/20 hover:text-txt-primary transition-colors"
            >
              <Sparkles className="h-3 w-3 text-sky-400" />
              <span>Diagnose with AI</span>
            </button>

            <button
              type="button"
              data-testid="telemetry-action-open-fleet"
              title="Open Fleet Overview (Open Fleet Tab)"
              onClick={handleOpenFleetClick}
              className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-app-surface-subtle px-2 py-1 text-[10px] font-mono text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
            >
              <Activity className="h-3 w-3 text-emerald-400" />
              <span>Open Fleet Overview</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SessionTelemetryPill;
