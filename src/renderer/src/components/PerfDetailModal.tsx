import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { PERF_HISTORY_MS, type PerfSample } from '@shared/types/perf';
import { useModalDismiss } from '../lib/useModalDismiss';
import {
  chartDefs,
  cpuSplit,
  formatBytes1,
  formatChartValue,
  formatPct,
  formatUptime,
  levelColor,
  ramSplit,
  seriesPeak,
  tooltipText,
  type PerfChartDef,
} from '../lib/perfMetrics';
import { CoreChart, Donut, DualBars, HBars, PerfCard, StatTile, type HBarRow } from './PerfGraphics';

const W = 560;
const H = 110;
const PAD_L = 52;
const PAD_B = 14;

const Chart: React.FC<{ def: PerfChartDef; history: PerfSample[]; now: number }> = ({ def, history, now }) => {
  const all = def.series.flatMap((s) => history.map(s.get)).filter((v): v is number => v !== null);
  if (all.length === 0) return null;
  const max = def.unit === 'pct' ? 100 : Math.max(...all, def.unit === 'load' ? 1 : 1) * 1.1;
  const x = (t: number): number => PAD_L + ((t - (now - PERF_HISTORY_MS)) / PERF_HISTORY_MS) * (W - PAD_L - 4);
  const y = (v: number): number => 4 + (1 - v / max) * (H - PAD_B - 8);
  const latest = history[history.length - 1];
  return (
    <figure className="space-y-1" data-testid={`perf-chart-${def.id}`}>
      <figcaption className="flex flex-wrap items-baseline gap-x-3 text-xs text-txt-primary">
        <span className="font-medium">{def.title}</span>
        {def.series.map((s) => {
          const v = s.get(latest);
          return (
            <span key={s.name} className="text-txt-muted">
              <span style={{ color: s.color }}>●</span> {s.name} {v === null ? '–' : formatChartValue(def.unit, v)}
            </span>
          );
        })}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-md bg-app-input" role="img" aria-label={`${def.title} history`}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_L} x2={W - 4} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" opacity={0.12} />
            <text x={PAD_L - 4} y={y(max * f) + 3} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.6}>
              {formatChartValue(def.unit, def.unit === 'pct' ? 100 * f : max * f)}
            </text>
          </g>
        ))}
        <text x={PAD_L} y={H - 2} fontSize={9} fill="currentColor" opacity={0.6}>
          −15 min
        </text>
        <text x={W - 4} y={H - 2} textAnchor="end" fontSize={9} fill="currentColor" opacity={0.6}>
          now
        </text>
        {def.series.map((s) => {
          // Break the line at gaps (null samples) instead of bridging them.
          const segments: string[][] = [[]];
          for (const p of history) {
            const v = s.get(p);
            if (v === null) {
              if (segments[segments.length - 1].length) segments.push([]);
            } else {
              segments[segments.length - 1].push(`${x(p.t).toFixed(1)},${y(v).toFixed(1)}`);
            }
          }
          return segments
            .filter((seg) => seg.length > 0)
            .map((seg, i) => (
              <polyline key={`${s.name}-${i}`} points={seg.join(' ')} fill="none" stroke={s.color} strokeWidth={1.5} strokeLinejoin="round" />
            ));
        })}
      </svg>
    </figure>
  );
};


/** The "right now" section: donuts, bars and tiles instead of a wall of text. */
const NowCards: React.FC<{ kind: 'ssh' | 'k8s'; history: PerfSample[]; latest: PerfSample }> = ({
  kind,
  history,
  latest,
}) => {
  const cpu = cpuSplit(latest);
  const ram = ramSplit(latest);
  const tiles: Array<{ id: string; label: string; value: string }> = [];
  const add = (id: string, label: string, value: string | null): void => {
    if (value !== null) tiles.push({ id, label, value });
  };
  if (kind === 'ssh') {
    add('uptime', 'Uptime', latest.uptimeSec === null ? null : formatUptime(latest.uptimeSec));
    add('ping', 'Ping', latest.latencyMs === null ? null : `${Math.round(latest.latencyMs)} ms`);
    add('procs', 'Procs run/total', latest.procsRunning === null ? null : `${latest.procsRunning}/${latest.procsTotal}`);
    add('cores', 'Cores', latest.cores === null ? null : String(latest.cores));
  } else {
    add('phase', 'Phase', latest.phase);
    add('ready', 'Ready', latest.ready === null ? null : latest.ready ? 'yes' : 'no');
    add('restarts', 'Restarts', latest.restarts === null ? null : String(latest.restarts));
    add('age', 'Age', latest.ageSec === null ? null : formatUptime(latest.ageSec));
    add('node', 'Node', latest.nodeName);
  }

  const resRows: HBarRow[] = [];
  if (kind === 'k8s') {
    const scale = (usage: number | null, req: number | null, lim: number | null): number =>
      Math.max(usage ?? 0, req ?? 0, lim ?? 0) || 1;
    const cpuScale = scale(latest.cpuMillicores, latest.cpuRequestMillicores, latest.cpuLimitMillicores);
    if (latest.cpuMillicores !== null) {
      resRows.push({
        label: 'CPU',
        pct: (100 * latest.cpuMillicores) / cpuScale,
        right: `${Math.round(latest.cpuMillicores)}m · req ${latest.cpuRequestMillicores ?? '–'}m · lim ${latest.cpuLimitMillicores ?? '–'}m`,
        color: levelColor(latest.cpuPct),
        marks: [
          ...(latest.cpuRequestMillicores !== null ? [{ pct: (100 * latest.cpuRequestMillicores) / cpuScale, label: 'request' }] : []),
          ...(latest.cpuLimitMillicores !== null ? [{ pct: (100 * latest.cpuLimitMillicores) / cpuScale, label: 'limit' }] : []),
        ],
      });
    }
    const memScale = scale(latest.memUsedBytes, latest.memRequestBytes, latest.memLimitBytes);
    if (latest.memUsedBytes !== null) {
      resRows.push({
        label: 'RAM',
        pct: (100 * latest.memUsedBytes) / memScale,
        right: `${formatBytes1(latest.memUsedBytes)} · req ${latest.memRequestBytes === null ? '–' : formatBytes1(latest.memRequestBytes)} · lim ${latest.memLimitBytes === null ? '–' : formatBytes1(latest.memLimitBytes)}`,
        color: levelColor(latest.memPct),
        marks: [
          ...(latest.memRequestBytes !== null ? [{ pct: (100 * latest.memRequestBytes) / memScale, label: 'request' }] : []),
          ...(latest.memLimitBytes !== null ? [{ pct: (100 * latest.memLimitBytes) / memScale, label: 'limit' }] : []),
        ],
      });
    }
  }

  const loadScale = latest.load && latest.cores ? Math.max(latest.cores * 1.5, ...latest.load) : 1;
  return (
    <div className="grid grid-cols-1 gap-3 md:col-span-2 md:grid-cols-2" data-testid="perf-now">
      {cpu && (
        <PerfCard title="CPU time" testId="perf-card-cpu">
          <Donut segments={cpu} center={formatPct(latest.cpuPct)} sub="busy" label="CPU time split" />
        </PerfCard>
      )}
      {ram && (
        <PerfCard title="Memory" testId="perf-card-ram">
          <Donut
            segments={ram}
            center={formatPct(latest.memPct)}
            sub={latest.memTotalBytes === null ? undefined : `of ${formatBytes1(latest.memTotalBytes)}`}
            format={formatBytes1}
            label="Memory split"
          />
        </PerfCard>
      )}
      {kind === 'ssh' && latest.load && latest.cores && (
        <PerfCard title={`Load average (${latest.cores} cores)`} testId="perf-card-load">
          <HBars
            rows={['1 min', '5 min', '15 min'].map((label, i) => ({
              label,
              pct: (100 * latest.load![i]) / loadScale,
              right: latest.load![i].toFixed(1),
              color: levelColor((100 * latest.load![i]) / latest.cores!),
              marks: [{ pct: (100 * latest.cores!) / loadScale, label: 'all cores busy' }],
            }))}
          />
        </PerfCard>
      )}
      {latest.disks && latest.disks.length > 0 && (
        <PerfCard title="Disks" testId="perf-card-disks">
          <HBars
            rows={latest.disks.map((d) => ({
              label: d.mount,
              pct: d.usedPct,
              right: `${d.usedPct}% of ${formatBytes1(d.sizeKb * 1024)}`,
            }))}
          />
        </PerfCard>
      )}
      {latest.corePcts && latest.corePcts.length > 1 && (
        <PerfCard title="CPU per core" testId="perf-card-cores">
          <CoreChart pcts={latest.corePcts} />
        </PerfCard>
      )}
      {latest.rxBps !== null && latest.txBps !== null && (
        <PerfCard title="Network" testId="perf-card-net">
          <DualBars
            a={{ label: '↓ receive', value: latest.rxBps, color: '#38bdf8' }}
            b={{ label: '↑ send', value: latest.txBps, color: '#f59e0b' }}
            peak={Math.max(seriesPeak(history, (s) => s.rxBps), seriesPeak(history, (s) => s.txBps))}
          />
        </PerfCard>
      )}
      {latest.diskReadBps !== null && latest.diskWriteBps !== null && (
        <PerfCard title="Disk I/O" testId="perf-card-diskio">
          <DualBars
            a={{ label: 'read', value: latest.diskReadBps, color: '#34d399' }}
            b={{ label: 'write', value: latest.diskWriteBps, color: '#f472b6' }}
            peak={Math.max(seriesPeak(history, (s) => s.diskReadBps), seriesPeak(history, (s) => s.diskWriteBps))}
          />
        </PerfCard>
      )}
      {latest.swapPct !== null && (
        <PerfCard title="Swap" testId="perf-card-swap">
          <Donut
            segments={[
              { label: 'used', value: latest.swapPct, color: levelColor(latest.swapPct) },
              { label: 'free', value: 100 - latest.swapPct, color: '#334155' },
            ]}
            center={formatPct(latest.swapPct)}
            label="Swap usage"
          />
        </PerfCard>
      )}
      {resRows.length > 0 && (
        <PerfCard title="Resources (usage vs request / limit)" testId="perf-card-resources">
          <HBars rows={resRows} />
          <p className="text-2xs text-txt-muted">The vertical ticks mark request and limit.</p>
        </PerfCard>
      )}
      {tiles.length > 0 && (
        <div className="grid grid-cols-2 gap-2 md:col-span-2 md:grid-cols-4" data-testid="perf-card-tiles">
          {tiles.map((t) => (
            <StatTile key={t.id} label={t.label} value={t.value} testId={`perf-tile-${t.id}`} />
          ))}
        </div>
      )}
    </div>
  );
};

export interface PerfDetailModalProps {
  kind: 'ssh' | 'k8s';
  history: PerfSample[];
  title?: string;
  onClose: () => void;
}

/** Larger view of the performance history (up to the last 15 minutes) plus every current value. */
export const PerfDetailModal: React.FC<PerfDetailModalProps> = ({ kind, history, title, onClose }) => {
  const onBackdrop = useModalDismiss(onClose, true);
  const latest = history[history.length - 1];
  const now = latest?.t ?? 0;
  const spanMin = history.length > 1 ? Math.round((now - history[0].t) / 60000) : 0;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onBackdrop}
      data-testid="perf-detail"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Performance history"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-border-subtle bg-app-surface shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-txt-primary">Performance{title ? ` · ${title}` : ''}</h2>
            <p className="text-xs text-txt-muted">
              {history.length} samples{spanMin > 0 ? ` over the last ${spanMin} min` : ''} (kept up to 15 min while this tab is active)
            </p>
          </div>
          <div className="flex items-center gap-2">
            {latest && (
              <button
                type="button"
                data-testid="perf-analyze-ai-btn"
                title="Skicka aktuell systemlast (CPU, RAM, Disk, I/O, Nätverk) till AI Hub för diagnos"
                onClick={() => {
                  const summary = tooltipText(kind, latest, title).replace(/\nClick for history$/, '');
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-attach', {
                      detail: {
                        label: `@perf:${title || kind}`,
                        text: `Live Performance Telemetry (${title || kind}, ${history.length} samples):\n${summary}`,
                        prompt: `Analysera aktuell prestanda och resursförbrukning för @perf:${title || kind} och identifiera eventuella flaskhalsar i CPU, minne, disk eller I/O.`,
                      },
                    })
                  );
                  onClose();
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 transition-colors"
              >
                <span>✨ Analysera med AI</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="rounded-md p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2">
          {latest ? (
            chartDefs(kind).map((def) => <Chart key={def.id} def={def} history={history} now={now} />)
          ) : (
            <p className="text-xs text-txt-muted">No samples yet.</p>
          )}
          {latest && <NowCards kind={kind} history={history} latest={latest} />}
          {latest && (
            <details className="md:col-span-2 text-xs text-txt-secondary">
              <summary className="cursor-pointer select-none">All values as text</summary>
              <pre
                className="mt-2 whitespace-pre-wrap rounded-md bg-app-input p-3 text-2xs leading-5"
                data-testid="perf-detail-values"
              >
                {tooltipText(kind, latest).replace(/\nClick for history$/, '')}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
