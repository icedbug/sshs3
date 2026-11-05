import React from 'react';
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Clock,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';

export interface K8sLogHeaderProps {
  currentPodName: string;
  currentContainerName: string;
  availableContainers: string[];
  showPrevious: boolean;
  showTimestamps: boolean;
  showMetrics: boolean;
  autoReconnect: boolean;
  isReconnecting: boolean;
  restartingPod: boolean;
  searchOpen: boolean;
  searchQuery: string;
  searchInputRef: React.RefObject<HTMLInputElement>;
  onSwitchContainer: (name: string) => void;
  onTogglePrevious: () => void;
  onToggleTimestamps: () => void;
  onToggleMetrics: () => void;
  onToggleAutoReconnect: () => void;
  onRestartPod: () => void;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onSearchChange: (query: string) => void;
  onRunSearch: (direction: 'next' | 'previous') => void;
}

export const K8sLogHeader: React.FC<K8sLogHeaderProps> = ({
  currentPodName,
  currentContainerName,
  availableContainers,
  showPrevious,
  showTimestamps,
  showMetrics,
  autoReconnect,
  isReconnecting,
  restartingPod,
  searchOpen,
  searchQuery,
  searchInputRef,
  onSwitchContainer,
  onTogglePrevious,
  onToggleTimestamps,
  onToggleMetrics,
  onToggleAutoReconnect,
  onRestartPod,
  onOpenSearch,
  onCloseSearch,
  onSearchChange,
  onRunSearch,
}) => {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle bg-slate-900/90 px-3 py-1.5 shrink-0 z-30">
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-mono text-xs font-semibold text-txt-primary">
          {currentPodName}
        </span>
        <span className="text-txt-muted text-xs">/</span>
        <span className="truncate font-mono text-xs text-sky-400">
          {currentContainerName}
        </span>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {availableContainers.length > 1 && (
          <select
            value={currentContainerName}
            onChange={(e) => onSwitchContainer(e.target.value)}
            className="rounded-lg border border-border-subtle bg-app-card px-2 py-1 text-xs text-txt-primary outline-none cursor-pointer hover:bg-app-surface-hover shadow-sm transition-colors"
            aria-label="Select container"
            title="Switch container"
          >
            {availableContainers.map((c) => (
              <option key={c} value={c} className="bg-slate-900 text-txt-primary">
                {c}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          title={
            showPrevious
              ? 'Showing previous container logs (click for live)'
              : 'Show previous container logs (terminated instance)'
          }
          aria-label="Toggle previous logs"
          onClick={onTogglePrevious}
          data-testid="toggle-previous-logs"
          className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium shadow-sm transition-colors cursor-pointer ${
            showPrevious
              ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
              : 'border-border-subtle bg-app-card text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover'
          }`}
        >
          <History className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Previous</span>
        </button>

        <button
          type="button"
          title={showTimestamps ? 'Timestamps: ON' : 'Timestamps: OFF'}
          aria-label="Toggle timestamps"
          onClick={onToggleTimestamps}
          data-testid="toggle-timestamps"
          className={`rounded-lg border border-border-subtle bg-app-card p-1.5 shadow-sm transition-colors cursor-pointer ${
            showTimestamps
              ? 'text-sky-400 hover:text-sky-300 hover:bg-app-surface-hover'
              : 'text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover'
          }`}
        >
          <Clock className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          title={autoReconnect ? 'Auto-reconnect is enabled' : 'Auto-reconnect is paused'}
          aria-label={autoReconnect ? 'Disable auto-reconnect' : 'Enable auto-reconnect'}
          onClick={onToggleAutoReconnect}
          data-testid="toggle-auto-reconnect"
          className={`rounded-lg border border-border-subtle bg-app-card p-1.5 shadow-sm transition-colors cursor-pointer ${
            autoReconnect
              ? 'text-sky-400 hover:text-sky-300 hover:bg-app-surface-hover'
              : 'text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover'
          }`}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isReconnecting ? 'animate-spin' : ''}`} />
        </button>

        <button
          type="button"
          title={showMetrics ? 'Hide resource metrics' : 'Show live CPU & Memory metrics'}
          aria-label="Toggle metrics"
          onClick={onToggleMetrics}
          data-testid="toggle-metrics-button"
          className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium shadow-sm transition-colors cursor-pointer ${
            showMetrics
              ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300'
              : 'border-border-subtle bg-app-card text-txt-muted hover:text-txt-primary hover:bg-app-surface-hover'
          }`}
        >
          <Activity className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Metrics</span>
        </button>

        <button
          type="button"
          title="Restart pod (deletes pod to trigger replacement)"
          aria-label="Restart pod"
          onClick={onRestartPod}
          disabled={restartingPod}
          data-testid="restart-pod-button"
          className="flex items-center gap-1 rounded-lg border border-rose-500/30 bg-app-card px-2 py-1 text-xs font-medium text-rose-400 hover:bg-rose-500/15 hover:text-rose-300 shadow-sm transition-colors cursor-pointer disabled:opacity-50"
        >
          {restartingPod ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          <span className="hidden sm:inline">Restart Pod</span>
        </button>

        {searchOpen ? (
          <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-card px-2 py-1 shadow-lg">
            <Search className="h-3.5 w-3.5 text-txt-muted" />
            <input
              aria-label="Search logs"
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onRunSearch(e.shiftKey ? 'previous' : 'next');
                if (e.key === 'Escape') onCloseSearch();
              }}
              placeholder="Search logs..."
              className="w-40 bg-transparent text-xs text-txt-primary outline-none placeholder-txt-muted"
            />
            <button
              aria-label="Previous match (Shift+Enter)"
              type="button"
              title="Previous match (Shift+Enter)"
              onClick={() => onRunSearch('previous')}
              className="rounded p-0.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors cursor-pointer"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              aria-label="Next match (Enter)"
              type="button"
              title="Next match (Enter)"
              onClick={() => onRunSearch('next')}
              className="rounded p-0.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors cursor-pointer"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            <button
              aria-label="Close search (Esc)"
              type="button"
              title="Close search (Esc)"
              onClick={onCloseSearch}
              className="rounded p-0.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            title="Search logs (Ctrl+F)"
            aria-label="Search logs"
            onClick={onOpenSearch}
            className="rounded-lg border border-border-subtle bg-app-card p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary shadow-sm transition-colors cursor-pointer"
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};
