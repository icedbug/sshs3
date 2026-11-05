import React, { useState } from 'react';
import { Globe, ExternalLink, X, Loader2 } from 'lucide-react';
import type { PortDetectionResult } from '../lib/portDetection';

export interface TerminalPortPillProps {
  ports: PortDetectionResult[];
  isRemote: boolean;
  onForwardAndOpen: (port: number, protocol: 'http' | 'https') => Promise<void>;
  onDismiss: (port: number) => void;
}

export const TerminalPortPill: React.FC<TerminalPortPillProps> = ({
  ports,
  isRemote,
  onForwardAndOpen,
  onDismiss,
}) => {
  const [busyPort, setBusyPort] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<{ port: number; text: string } | null>(null);

  if (!ports || ports.length === 0) return null;

  // Show up to 2 detected ports at once to prevent clutter
  const visiblePorts = ports.slice(0, 2);

  const handleAction = async (item: PortDetectionResult) => {
    setBusyPort(item.port);
    setErrorMessage(null);
    try {
      await onForwardAndOpen(item.port, item.protocol);
    } catch (err: any) {
      setErrorMessage({ port: item.port, text: err?.message || 'Failed to open port' });
    } finally {
      setBusyPort(null);
    }
  };

  return (
    <div
      data-testid="terminal-port-pill-container"
      className="absolute bottom-4 right-4 z-20 flex flex-col items-end gap-2 pointer-events-none"
    >
      {visiblePorts.map((item) => {
        const isBusy = busyPort === item.port;
        const err = errorMessage?.port === item.port ? errorMessage.text : null;

        return (
          <div
            key={item.port}
            data-testid={`terminal-port-pill-${item.port}`}
            className="pointer-events-auto dark-surface flex items-center gap-2.5 rounded-xl border border-sky-500/30 bg-slate-900/95 px-3 py-2 text-xs text-slate-200 shadow-xl backdrop-blur-md transition-all animate-fade-in"
          >
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-lg bg-sky-500/20 text-sky-400">
                <Globe className="h-3.5 w-3.5" />
              </span>
              <span className="font-medium text-slate-200">
                Port <span className="font-mono font-semibold text-sky-400">{item.port}</span> detected
              </span>
            </div>

            {err && (
              <span role="alert" className="text-[11px] text-rose-400 max-w-[200px] truncate" title={err}>
                {err}
              </span>
            )}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleAction(item)}
              data-testid={`port-pill-action-${item.port}`}
              className="flex items-center gap-1 rounded-lg bg-sky-600 px-2.5 py-1 text-[11px] font-semibold text-white shadow-sm hover:bg-sky-500 active:bg-sky-700 disabled:opacity-50 cursor-pointer transition-colors"
            >
              {isBusy ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <>
                  <ExternalLink className="h-3 w-3" />
                  <span>{err ? 'Retry' : isRemote ? 'Forward & Open' : 'Open in Browser'}</span>
                </>
              )}
            </button>

            <button
              type="button"
              aria-label={`Dismiss port ${item.port}`}
              title="Dismiss"
              onClick={() => onDismiss(item.port)}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200 cursor-pointer transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
