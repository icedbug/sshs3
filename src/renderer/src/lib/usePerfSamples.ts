import { useEffect, useRef, useState } from 'react';
import type { PerfK8sTarget, PerfSample, PerfSshRaw } from '@shared/types/perf';
import { computeK8sSample, computeSshSample, pushHistory, resolveIntervalMs } from './perfMetrics';

export type PerfStatus = 'loading' | 'ok' | 'unavailable';

export interface PerfSamplesState {
  history: PerfSample[];
  status: PerfStatus;
  /** Short human-readable reason when status is 'unavailable'. */
  reason?: string;
}

interface Options {
  /** Sample the local machine (local shell panes) instead of an SSH session or pod. */
  local?: boolean;
  /** SSH session id (from terminalCreate). */
  sshSessionId?: string | null;
  k8sTarget?: PerfK8sTarget;
  intervalSec?: number;
  /** Polling only runs while true (pane visible and feature enabled). */
  active: boolean;
}

const REASONS: Record<string, string> = {
  unsupported: 'Metrics need a Linux host',
  'auth-unsupported': 'Not available for this login method on Windows',
  'no-metrics': 'metrics-server not available',
  forbidden: 'No permission to read pod metrics',
};

/**
 * Local metrics describe this machine whichever pane samples them, so the history is kept outside the hook:
 * when the tab's layout moves the sampler between a pane bar and the shared header bar, the graph carries over.
 * Stale entries are dropped so a long-closed pane does not resurface old data.
 */
const LOCAL_HISTORY_MAX_AGE_MS = 120_000;
let localHistory: PerfSample[] = [];

const recentLocalHistory = (): PerfSample[] => {
  const last = localHistory[localHistory.length - 1];
  return last && Date.now() - last.t <= LOCAL_HISTORY_MAX_AGE_MS ? localHistory : [];
};

/** Test hook: forget the shared local history. */
export function resetLocalPerfHistory(): void {
  localHistory = [];
}

/**
 * Polls the main process for performance samples. Main is stateless (raw counters only); deltas and the history
 * ring buffer live here. Chained timeouts rather than setInterval so a slow ssh round-trip can never overlap itself.
 */
export function usePerfSamples({ local, sshSessionId, k8sTarget, intervalSec, active }: Options): PerfSamplesState {
  const isLocal = Boolean(local) && !k8sTarget;
  const [state, setState] = useState<PerfSamplesState>(() => {
    const history = isLocal ? recentLocalHistory() : [];
    return { history, status: history.length ? 'ok' : 'loading' };
  });
  const k8sKey = k8sTarget
    ? `${k8sTarget.contextName}\n${k8sTarget.namespace}\n${k8sTarget.podName}\n${k8sTarget.containerName}`
    : '';
  const kind = k8sTarget ? 'k8s' : 'ssh';
  const target = sshSessionId ?? null;
  const targetRef = useRef(k8sTarget);
  targetRef.current = k8sTarget;

  // History belongs to the session, not to the pane being visible: reset only when the target changes, so switching
  // tabs (which pauses polling) keeps the graph.
  useEffect(() => {
    const history = isLocal ? recentLocalHistory() : [];
    setState({ history, status: history.length ? 'ok' : 'loading' });
  }, [kind, local, isLocal, target, k8sKey]);

  useEffect(() => {
    if (!active || (kind === 'ssh' && !local && !target) || !window.multissh) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let prev: PerfSshRaw | null = null;
    const delay = resolveIntervalMs(kind, intervalSec, !local && /Windows/i.test(navigator.userAgent));

    const tick = async (): Promise<void> => {
      let next = delay;
      if (!document.hidden) {
        try {
          if (kind === 'k8s') {
            const res = await window.multissh.perfK8sSample(targetRef.current as PerfK8sTarget);
            if (cancelled) return;
            if (res.ok) {
              const sample = computeK8sSample(res.raw);
              setState((s) => ({ history: pushHistory(s.history, sample), status: 'ok' }));
            } else {
              setState((s) => ({ history: s.history, status: 'unavailable', reason: REASONS[res.reason] ?? 'Metrics unavailable' }));
            }
          } else {
            const res = local ? await window.multissh.perfLocalSample() : await window.multissh.perfSshSample(target as string);
            if (cancelled) return;
            if (res.ok) {
              const sample = computeSshSample(prev, res.raw);
              prev = res.raw;
              setState((s) => {
                const history = pushHistory(s.history, sample);
                if (local) localHistory = history;
                return { history, status: 'ok' };
              });
            } else if (res.reason === 'unsupported' || res.reason === 'auth-unsupported') {
              setState({ history: [], status: 'unavailable', reason: REASONS[res.reason] });
              return; // permanent for this session: stop polling
            } else {
              prev = null; // a gap would corrupt the next delta
              setState((s) => ({ history: s.history, status: s.history.length ? 'ok' : 'unavailable', reason: 'Not connected' }));
            }
          }
        } catch {
          if (cancelled) return;
          next = delay * 2;
        }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), next);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, kind, local, target, k8sKey, intervalSec]);

  return state;
}
