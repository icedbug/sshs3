import React, { useState } from 'react';
import type { PerfLayout, PerfMetricId } from '@shared/types/perf';
import {
  metricApplies,
  metricPercent,
  metricValue,
  PERF_METRIC_LABELS,
  PERF_SPARK_POINTS,
  tooltipText,
} from '../lib/perfMetrics';
import type { PerfSamplesState } from '../lib/usePerfSamples';
import { PerfDetailModal } from './PerfDetailModal';

export interface PerfBarProps {
  kind: 'ssh' | 'k8s';
  state: PerfSamplesState;
  layout: PerfLayout;
  items: PerfMetricId[];
  /** Shown in the tooltip and the detail view header, e.g. the host or pod name. */
  title?: string;
  /** Local shell pane: there is no remote host to ping, so the Ping cell is hidden. */
  local?: boolean;
  /** Sits inside another bar (the split-view header): no own background, border or full width. */
  embedded?: boolean;
}

const levelClass = (pct: number | null): string =>
  pct === null ? 'bg-slate-500' : pct < 60 ? 'bg-emerald-500' : pct < 85 ? 'bg-amber-500' : 'bg-rose-500';

const levelStroke = (pct: number | null): string =>
  pct === null ? '#64748b' : pct < 60 ? '#10b981' : pct < 85 ? '#f59e0b' : '#f43f5e';

const Sparkline: React.FC<{ values: Array<number | null>; stroke: string }> = ({ values, stroke }) => {
  const w = 60;
  const h = 16;
  const step = w / (PERF_SPARK_POINTS - 1);
  const offset = (PERF_SPARK_POINTS - values.length) * step;
  const points = values
    .map((v, i) => (v === null ? null : `${(offset + i * step).toFixed(1)},${(h - 1 - (v / 100) * (h - 2)).toFixed(1)}`))
    .filter((p): p is string => p !== null)
    .join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="shrink-0">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" />
    </svg>
  );
};

/** One thin vertical bar per core, for the graphical layouts. */
const CoreBars: React.FC<{ pcts: number[] }> = ({ pcts }) => (
  <span className="flex items-end gap-px h-4" aria-hidden="true">
    {pcts.map((p, i) => (
      <span key={i} className="flex h-full w-1 items-end bg-border-strong/50">
        <span className={`block w-full ${levelClass(p)}`} style={{ height: `${Math.max(p, 4)}%` }} />
      </span>
    ))}
  </span>
);

/** One-row performance bar rendered above a terminal. Layout, metrics and polling are decided by the caller. */
export const PerfBar: React.FC<PerfBarProps> = ({ kind, state, layout, items, title, local, embedded }) => {
  const [detailOpen, setDetailOpen] = useState(false);
  const latest = state.history[state.history.length - 1];
  const shown = items.filter((id) => metricApplies(kind, id) && !(local && id === 'latency'));
  const recent = state.history.slice(-PERF_SPARK_POINTS);
  // Theme tokens (not fixed slate shades) so the bar matches the pane header in dark, light and breeze alike.
  const base = embedded
    ? 'flex items-center gap-2.5 h-6 min-w-0 overflow-hidden whitespace-nowrap text-2xs font-mono tabular-nums text-left text-txt-secondary'
    : 'flex items-center gap-2.5 px-2.5 h-6 shrink-0 overflow-hidden whitespace-nowrap text-2xs font-mono tabular-nums border-b w-full text-left bg-app-surface-subtle text-txt-secondary border-border-subtle';

  if (!latest) {
    return (
      <div data-testid="perf-bar" className={base}>
        <span className="opacity-70">
          {state.status === 'unavailable' ? (state.reason ?? 'Metrics unavailable') : 'Reading metrics…'}
        </span>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        data-testid="perf-bar"
        data-layout={layout}
        title={tooltipText(kind, latest, title)}
        aria-label="Performance metrics, click for history"
        onClick={() => setDetailOpen(true)}
        className={`${base} cursor-pointer ${
          embedded
            ? 'rounded px-1.5 hover:bg-app-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500'
            : 'hover:brightness-125'
        }`}
      >
        {shown.map((id, idx) => {
          const sep = idx > 0 ? ' border-l border-border-strong pl-2.5' : '';
          const labelCls = 'text-txt-muted';
          const valueCls = 'text-txt-primary';
          const label = PERF_METRIC_LABELS[id];
          const value = metricValue(kind, id, latest);
          const pct = metricPercent(kind, id, latest);
          if (id === 'cores' && layout !== 'text' && latest.corePcts) {
            return (
              <span key={id} className={`flex items-center gap-1.5${sep}`}>
                <span className={labelCls}>{label}</span>
                <CoreBars pcts={latest.corePcts} />
              </span>
            );
          }
          if (layout === 'bars' && pct !== null) {
            return (
              <span key={id} className={`flex items-center gap-1.5${sep}`}>
                <span className={labelCls}>{label}</span>
                <span className="h-1.5 w-12 rounded-full overflow-hidden bg-border-strong">
                  <span className={`block h-full ${levelClass(pct)}`} style={{ width: `${pct}%` }} />
                </span>
                <span className={valueCls}>{value}</span>
              </span>
            );
          }
          if (layout === 'sparklines' && pct !== null) {
            return (
              <span key={id} className={`flex items-center gap-1.5${sep}`}>
                <span className={labelCls}>{label}</span>
                <Sparkline values={recent.map((s) => metricPercent(kind, id, s))} stroke={levelStroke(pct)} />
                <span className={valueCls}>{value}</span>
              </span>
            );
          }
          return (
            <span key={id} className={sep.trim()}>
              <span className={labelCls}>{label}</span> <span className={valueCls}>{value}</span>
            </span>
          );
        })}
        {state.status === 'unavailable' && <span className="opacity-60">· {state.reason}</span>}
      </button>
      {detailOpen && (
        <PerfDetailModal kind={kind} history={state.history} title={title} onClose={() => setDetailOpen(false)} />
      )}
    </>
  );
};
