import React from 'react';
import type { PerfLayout, PerfMetricId } from '@shared/types/perf';
import { usePerfSamples } from '../lib/usePerfSamples';
import { PerfBar } from './PerfBar';

/** The one perf bar shared by all local-shell panes of a tab, shown in the split-view header. */
export const LocalPerfBar: React.FC<{
  layout: PerfLayout;
  items: PerfMetricId[];
  intervalSec?: number;
  active: boolean;
}> = ({ layout, items, intervalSec, active }) => {
  const state = usePerfSamples({ local: true, intervalSec, active });
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-2xs font-medium uppercase tracking-wide text-txt-muted">Local</span>
      <PerfBar kind="ssh" state={state} layout={layout} items={items} title="Local shell" local embedded />
    </div>
  );
};
