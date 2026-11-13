import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import {
  ArrowDown,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react';
import { registerTerminalLinks } from '../lib/terminalLinks';
import { formatDateTime } from '../lib/dateFormat';
import { K8sPodMetrics } from './K8s/K8sPodMetrics';
import { K8sLogHeader } from './K8s/K8sLogHeader';
import { useConfirm } from './ConfirmDialog';
import { createRequestGuard, startGuarded } from '../lib/requestGuard';
import {
  calculateReconnectDelay,
  formatReconnectCountdown,
  formatK8sLogError,
  isPodNotFoundError,
  findReplacementPod,
  type K8sLogStatus,
} from '../lib/k8sLogReconnect';
import type { K8sTerminalTarget } from '@shared/types/kubernetes';

export interface K8sLogViewProps {
  target: K8sTerminalTarget;
  isActive?: boolean;
  fontSize?: number;
  fontFamily?: string;
}

/**
 * Read-only follow view for a container's logs, rendered as a full terminal
 * pane (not a small modal): resizes with the pane, supports xterm's normal
 * scrollback/selection, and has a search bar (Ctrl+F) via @xterm/addon-search.
 *
 * Supports:
 * - Automatic reconnection with backoff on container restart or pod replacement
 * - Previous container logs toggle (kubectl logs -p) for crash analysis
 * - RFC3339 timestamps toggle
 * - Container switcher for multi-container pods
 * - Smart auto-scroll with "Scroll to bottom" button
 */
export const K8sLogView: React.FC<K8sLogViewProps> = ({
  target,
  isActive = true,
  fontSize = 13,
  fontFamily = 'Menlo, Monaco, "Courier New", monospace, Consolas',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const retryAttemptRef = useRef(0);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isDisposedRef = useRef(false);
  // Only the latest connect may take over the stream; an older one that finishes starting late is stopped (M10).
  const [startGuard] = useState(createRequestGuard);

  const [currentPodName, setCurrentPodName] = useState(target.podName);
  const currentPodNameRef = useRef(target.podName);
  useEffect(() => {
    setCurrentPodName(target.podName);
    currentPodNameRef.current = target.podName;
  }, [target.podName]);

  const [currentContainerName, setCurrentContainerName] = useState(target.containerName);
  const currentContainerNameRef = useRef(target.containerName);
  useEffect(() => {
    setCurrentContainerName(target.containerName);
    currentContainerNameRef.current = target.containerName;
  }, [target.containerName]);

  const [availableContainers, setAvailableContainers] = useState<string[]>([target.containerName]);
  const [showTimestamps, setShowTimestamps] = useState(false);
  const showTimestampsRef = useRef(false);

  const [showPrevious, setShowPrevious] = useState(false);
  const showPreviousRef = useRef(false);

  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [status, setStatus] = useState<K8sLogStatus>('connecting');
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [showMetrics, setShowMetrics] = useState(false);
  const [restartingPod, setRestartingPod] = useState(false);

  const autoReconnectRef = useRef(autoReconnect);
  useEffect(() => {
    autoReconnectRef.current = autoReconnect;
  }, [autoReconnect]);

  // Load sibling containers for multi-container pods
  useEffect(() => {
    if (window.multissh?.k8sListPods) {
      window.multissh
        .k8sListPods(target.contextName, target.namespace)
        .then((pods) => {
          const pod = pods.find((p) => p.name === target.podName);
          if (pod && pod.containers.length > 0) {
            setAvailableContainers(pod.containers.map((c) => c.name));
          }
        })
        .catch(() => {});
    }
  }, [target.contextName, target.namespace, target.podName]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      termRef.current.options.fontFamily = fontFamily;
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Ignore fit calculation error
      }
    }
  }, [fontSize, fontFamily]);

  useEffect(() => {
    if (isActive && searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [isActive, searchOpen]);

  const clearRetryTimer = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const stopActiveSession = useCallback(() => {
    const id = sessionIdRef.current;
    if (id) {
      sessionIdRef.current = null;
      window.multissh?.k8sLogStop(id);
    }
  }, []);

  const connectStream = useCallback(
    async (isInitial = false) => {
      clearRetryTimer();
      if (isDisposedRef.current) return;

      stopActiveSession();
      const token = startGuard.begin();
      setStatus(isInitial ? 'connecting' : 'reconnecting');

      const term = termRef.current;
      const activePodName = currentPodNameRef.current;
      const activeContainerName = currentContainerNameRef.current;
      const currentTarget: K8sTerminalTarget = {
        ...target,
        podName: activePodName,
        containerName: activeContainerName,
      };

      try {
        const tailLines = isInitial ? 1000 : 100;
        const started = await startGuarded(
          startGuard,
          token,
          () =>
            window.multissh.k8sLogStart(currentTarget, {
              tailLines,
              timestamps: showTimestampsRef.current,
              previous: showPreviousRef.current,
            }),
          ({ sessionId }) => window.multissh.k8sLogStop(sessionId)
        );
        // Disposed, or a newer connect has begun: whatever was started has been stopped above.
        if (!started) return;
        const id = started.value.sessionId;

        sessionIdRef.current = id;
        retryAttemptRef.current = 0;
        setStatus('connected');
        setRetryAttempt(0);
        setCountdown(0);
        setErrorMessage(null);

        if (!isInitial && term) {
          term.write(`\r\n\x1b[32m[Log stream reconnected at ${formatDateTime(new Date())}]\x1b[0m\r\n`);
        }
      } catch (err: unknown) {
        if (isDisposedRef.current) return;
        const friendlyError = formatK8sLogError(err);

        // Check if the pod was deleted and replaced
        if (isPodNotFoundError(err) && window.multissh?.k8sListPods) {
          try {
            const pods = await window.multissh.k8sListPods(target.contextName, target.namespace);
            if (!isDisposedRef.current && startGuard.isCurrent(token)) {
              const stillExists = pods.some((p) => p.name === activePodName);
              if (!stillExists) {
                const replacement = findReplacementPod(activePodName, activeContainerName, pods);
                if (replacement) {
                  if (term) {
                    term.write(
                      `\r\n\x1b[36m[Pod "${activePodName}" was deleted. Switching to replacement pod "${replacement.name}"]\x1b[0m\r\n`
                    );
                  }
                  currentPodNameRef.current = replacement.name;
                  setCurrentPodName(replacement.name);
                  // Connect immediately to the replacement pod
                  void connectStream(false);
                  return;
                } else if (!autoReconnectRef.current || retryAttemptRef.current >= 3) {
                  if (term) {
                    term.write(
                      `\r\n\x1b[33m[Pod "${activePodName}" was deleted and no replacement pod was found in namespace "${target.namespace}"]\x1b[0m\r\n`
                    );
                  }
                  clearRetryTimer();
                  setStatus('ended');
                  setErrorMessage(`Pod "${activePodName}" was deleted`);
                  return;
                }
              }
            }
          } catch {
            // Ignore listPods error and fall back to standard retry
          }
        }

        if (showPreviousRef.current) {
          clearRetryTimer();
          setStatus('ended');
          const isNoPrevious =
            /400|previous terminated container.*not found|no previous/i.test(friendlyError) ||
            /400|previous terminated container.*not found/i.test(String(err));
          const msg = isNoPrevious
            ? 'No previous terminated instance found'
            : friendlyError;
          setErrorMessage(msg);
          if (term) {
            if (isNoPrevious) {
              term.write(
                `\r\n\x1b[33mNo previous terminated instance found for container "${activeContainerName}".\x1b[0m\r\n` +
                `\x1b[90m(This container has not crashed or restarted since pod creation.)\x1b[0m\r\n`
              );
            } else {
              term.write(`\r\n\x1b[31mFailed to load previous logs: ${friendlyError}\x1b[0m\r\n`);
            }
          }
          return;
        }

        if (isInitial && term) {
          term.write(`\r\n\x1b[31mFailed to follow logs: ${friendlyError}\x1b[0m\r\n`);
        } else if (term) {
          term.write(`\r\n\x1b[90m[Reconnect attempt failed: ${friendlyError}]\x1b[0m\r\n`);
        }

        if (autoReconnectRef.current) {
          const nextAttempt = retryAttemptRef.current + 1;
          retryAttemptRef.current = nextAttempt;
          const delaySec = calculateReconnectDelay(nextAttempt);

          setStatus('reconnecting');
          setRetryAttempt(nextAttempt);
          setCountdown(delaySec);
          setErrorMessage(friendlyError);

          let remaining = delaySec;
          countdownTimerRef.current = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
              clearRetryTimer();
              setCountdown(0);
              void connectStream(false);
            } else {
              setCountdown(remaining);
            }
          }, 1000);
        } else {
          setStatus('ended');
          setErrorMessage(friendlyError);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target.contextName, target.namespace, clearRetryTimer, stopActiveSession]
  );

  const handleStreamEnded = useCallback(() => {
    sessionIdRef.current = null;
    const term = termRef.current;
    if (showPreviousRef.current) {
      setStatus('ended');
      if (term) {
        term.write('\r\n\x1b[90m[End of previous container logs]\x1b[0m\r\n');
      }
      return;
    }

    if (term) {
      term.write('\r\n\x1b[33m[Log stream ended]\x1b[0m\r\n');
      if (autoReconnectRef.current) {
        term.write('\x1b[90m[Waiting for container to restart...]\x1b[0m\r\n');
      }
    }

    if (autoReconnectRef.current) {
      const nextAttempt = 1;
      retryAttemptRef.current = nextAttempt;
      const delaySec = calculateReconnectDelay(nextAttempt);

      setStatus('reconnecting');
      setRetryAttempt(nextAttempt);
      setCountdown(delaySec);
      setErrorMessage(null);

      let remaining = delaySec;
      clearRetryTimer();
      countdownTimerRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearRetryTimer();
          setCountdown(0);
          void connectStream(false);
        } else {
          setCountdown(remaining);
        }
      }, 1000);
    } else {
      setStatus('ended');
    }
  }, [clearRetryTimer, connectStream]);

  const handleReconnectNow = useCallback(() => {
    clearRetryTimer();
    void connectStream(false);
  }, [clearRetryTimer, connectStream]);

  const handleCancelReconnect = useCallback(() => {
    clearRetryTimer();
    autoReconnectRef.current = false;
    setAutoReconnect(false);
    setStatus('ended');
  }, [clearRetryTimer]);

  const handleToggleAutoReconnect = useCallback(() => {
    const next = !autoReconnect;
    setAutoReconnect(next);
    autoReconnectRef.current = next;
    if (next && (status === 'ended' || status === 'reconnecting')) {
      clearRetryTimer();
      void connectStream(false);
    } else if (!next && status === 'reconnecting') {
      clearRetryTimer();
      setStatus('ended');
    }
  }, [autoReconnect, status, clearRetryTimer, connectStream]);

  const confirm = useConfirm();
  const handleRestartPod = useCallback(async () => {
    const activePodName = currentPodNameRef.current;
    const confirmed = await confirm({
      title: 'Restart pod',
      message: `Restart pod "${activePodName}" in namespace "${target.namespace}"? The pod will be deleted so that its controller (Deployment/StatefulSet) can schedule a fresh replacement.`,
      confirmLabel: 'Restart pod',
    });
    if (!confirmed) return;

    setRestartingPod(true);
    const term = termRef.current;
    if (term) {
      term.write(`\r\n\x1b[33m[Restart initiated: deleting pod "${activePodName}"...]\x1b[0m\r\n`);
    }

    try {
      await window.multissh.k8sDeletePod(target.contextName, target.namespace, activePodName);
      if (term) {
        term.write(`\x1b[36m[Pod deleted. Waiting for replacement pod to be scheduled...]\x1b[0m\r\n`);
      }
      void connectStream(false);
    } catch (err) {
      const errMsg = formatK8sLogError(err);
      if (term) {
        term.write(`\r\n\x1b[31m[Failed to delete pod: ${errMsg}]\x1b[0m\r\n`);
      }
    } finally {
      setRestartingPod(false);
    }
  }, [target.contextName, target.namespace, connectStream, confirm]);

  const handleSwitchContainer = useCallback(
    (newContainer: string) => {
      setCurrentContainerName(newContainer);
      currentContainerNameRef.current = newContainer;
      termRef.current?.clear();
      void connectStream(true);
    },
    [connectStream]
  );

  const handleTogglePrevious = useCallback(() => {
    const next = !showPrevious;
    setShowPrevious(next);
    showPreviousRef.current = next;
    const term = termRef.current;
    if (term) {
      term.clear();
      if (next) {
        term.write('\r\n\x1b[33m[Viewing previous container logs (terminated instance)]\x1b[0m\r\n');
      }
    }
    void connectStream(true);
  }, [showPrevious, connectStream]);

  const handleToggleTimestamps = useCallback(() => {
    const next = !showTimestamps;
    setShowTimestamps(next);
    showTimestampsRef.current = next;
    termRef.current?.clear();
    void connectStream(true);
  }, [showTimestamps, connectStream]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    isDisposedRef.current = false;

    const term = new Terminal({
      cursorBlink: false,
      disableStdin: true,
      convertEol: true,
      scrollback: 10000,
      fontSize,
      fontFamily,
      theme: { background: '#0f172a', foreground: '#f8fafc' },
      linkHandler: {
        activate: (_event, text) => {
          void window.multissh?.openExternal(text);
        },
      },
    });
    const fitAddon = new FitAddon();
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    registerTerminalLinks(term, { openUrl: (url) => void window.multissh.openExternal(url) });
    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // Ignore initial fit in a zero-size container
    }

    const scrollSub = term.onScroll(() => {
      const buffer = term.buffer.active;
      const isUp = buffer.viewportY < buffer.baseY - 1;
      setIsScrolledUp(isUp);
    });

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            try {
              fitAddon.fit();
            } catch {
              // Ignore resize on a hidden/zero-size element
            }
          })
        : null;
    resizeObserver?.observe(container);

    const unsubData = window.multissh.onK8sLogData((sessId, data) => {
      if (sessId === sessionIdRef.current) {
        term.write(data);
      }
    });

    const unsubEnd = window.multissh.onK8sLogEnd((sessId) => {
      if (sessId === sessionIdRef.current) {
        handleStreamEnded();
      }
    });

    void connectStream(true);

    return () => {
      isDisposedRef.current = true;
      startGuard.invalidate();
      clearRetryTimer();
      stopActiveSession();
      scrollSub.dispose();
      resizeObserver?.disconnect();
      unsubData();
      unsubEnd();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      if (container) container.innerHTML = '';
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.contextName, target.namespace, target.podName, target.containerName]);

  // Re-fit when the pane becomes visible/active again (same rationale as TerminalView).
  useEffect(() => {
    if (isActive) {
      // Give the layout a tick to settle (pane just became display:flex again).
      const id = requestAnimationFrame(() => {
        containerRef.current?.dispatchEvent(new Event('resize'));
      });
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [isActive]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // Ignore fit calculation
      }
    });
    return () => cancelAnimationFrame(id);
  }, [showMetrics]);

  const runSearch = (direction: 'next' | 'previous') => {
    if (!searchQuery) return;
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (direction === 'next') addon.findNext(searchQuery);
    else addon.findPrevious(searchQuery);
  };

  return (
    <div className="dark-surface relative flex h-full w-full flex-col overflow-hidden bg-[#0f172a]">
      <K8sLogHeader
        currentPodName={currentPodName}
        currentContainerName={currentContainerName}
        availableContainers={availableContainers}
        showPrevious={showPrevious}
        showTimestamps={showTimestamps}
        showMetrics={showMetrics}
        autoReconnect={autoReconnect}
        isReconnecting={status === 'reconnecting'}
        restartingPod={restartingPod}
        searchOpen={searchOpen}
        searchQuery={searchQuery}
        searchInputRef={searchInputRef}
        onSwitchContainer={handleSwitchContainer}
        onTogglePrevious={handleTogglePrevious}
        onToggleTimestamps={handleToggleTimestamps}
        onToggleMetrics={() => setShowMetrics((v) => !v)}
        onToggleAutoReconnect={handleToggleAutoReconnect}
        onRestartPod={handleRestartPod}
        onOpenSearch={() => setSearchOpen(true)}
        onCloseSearch={() => setSearchOpen(false)}
        onSearchChange={(q) => {
          setSearchQuery(q);
          if (q) searchAddonRef.current?.findNext(q);
        }}
        onRunSearch={runSearch}
      />

      {!searchOpen && (
        <button
          type="button"
          data-testid="k8s-log-analyze-ai-btn"
          title="Send the latest log lines from this Kubernetes pod to the assistant for troubleshooting"
          onClick={() => {
            const buf = termRef.current?.buffer?.active;
            const lines: string[] = [];
            if (buf) {
              const total = buf.length;
              const start = Math.max(0, total - 80);
              for (let i = start; i < total; i++) {
                const line = buf.getLine(i)?.translateToString(true);
                if (line && line.trim()) lines.push(line);
              }
            }
            const logText = lines.length > 0 ? lines.join('\n') : '(No log lines buffered yet)';
            window.dispatchEvent(
              new CustomEvent('sshs3:ai-attach', {
                detail: {
                  label: `@k8s-logs:${currentPodName}`,
                  text: `Kubernetes Container Logs (${target.contextName} · ns=${target.namespace} · pod=${currentPodName} · container=${currentContainerName}):\n\n${logText}`,
                  prompt: `Analyze the logs from @k8s-logs:${currentPodName} (${target.namespace}/${currentPodName}), explain any errors or warnings and suggest a fix.`,
                },
              })
            );
          }}
          className="absolute right-11 top-2 z-10 inline-flex items-center gap-1 rounded-lg border border-sky-500/40 bg-app-card/95 px-2.5 py-1 text-xs font-semibold text-sky-300 hover:bg-sky-500/20 shadow-sm transition-colors"
        >
          <span>✨ Ask the assistant</span>
        </button>
      )}
      {showMetrics && (
        <div className="border-b border-border-subtle bg-slate-900/95 p-3 shrink-0 max-h-64 overflow-y-auto z-20">
          <K8sPodMetrics
            contextName={target.contextName}
            namespace={target.namespace}
            podName={currentPodName}
            containers={availableContainers}
          />
        </div>
      )}

      {/* Padding on the wrapper so FitAddon measures a padding-free container (see TerminalView). */}
      <div className="min-h-0 flex-1 p-2">
        <div
          ref={containerRef}
          data-testid="k8s-log-container"
          role="log"
          aria-label={`Logs: ${currentPodName}/${currentContainerName}`}
          className="h-full w-full overflow-hidden"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
              e.preventDefault();
              setSearchOpen(true);
            } else if (e.key === 'Enter' && (status === 'reconnecting' || status === 'ended')) {
              e.preventDefault();
              handleReconnectNow();
            } else if (e.key === 'Escape' && status === 'reconnecting') {
              e.preventDefault();
              handleCancelReconnect();
            }
          }}
          tabIndex={-1}
        />
      </div>

      {isScrolledUp && (
        <button
          type="button"
          onClick={() => {
            termRef.current?.scrollToBottom();
            setIsScrolledUp(false);
          }}
          data-testid="scroll-to-bottom-button"
          title="Scroll to latest logs"
          className="absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded bg-sky-600 hover:bg-sky-500 text-white px-3 py-1.5 text-xs font-medium shadow-lg transition-all cursor-pointer animate-fade-in"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Scroll to bottom
        </button>
      )}

      {status === 'reconnecting' && (
        <div
          data-testid="reconnecting-banner"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2.5 rounded-lg bg-slate-900/95 border border-slate-700/80 px-3 py-1.5 text-xs text-slate-200 shadow-lg z-10"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400 shrink-0" />
          <span className="font-mono text-txt-muted">
            {errorMessage ? `${errorMessage} · ` : ''}
            {formatReconnectCountdown(countdown, retryAttempt)}
          </span>
          <button
            type="button"
            data-testid="reconnect-now-button"
            title="Retry immediately (Enter)"
            onClick={handleReconnectNow}
            className="flex items-center gap-1 rounded bg-sky-600 hover:bg-sky-500 text-white px-2 py-0.5 font-medium transition-colors cursor-pointer"
          >
            <RotateCcw className="h-3 w-3" />
            Reconnect Now
          </button>
          <button
            type="button"
            data-testid="cancel-reconnect-button"
            title="Stop auto-reconnect (Esc)"
            onClick={handleCancelReconnect}
            className="flex items-center gap-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white px-2 py-0.5 font-medium transition-colors cursor-pointer"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        </div>
      )}

      {status === 'ended' && (
        <div
          data-testid="stream-ended-banner"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2.5 rounded-lg bg-slate-900/95 border border-slate-700/80 px-3 py-1.5 text-xs text-amber-300 shadow-lg z-20"
        >
          {showPrevious ? (
            <>
              <span>{errorMessage || 'No previous container logs'}</span>
              <button
                type="button"
                data-testid="switch-to-live-logs-button"
                title="Switch back to live log stream"
                onClick={handleTogglePrevious}
                className="flex items-center gap-1 rounded bg-sky-600 hover:bg-sky-500 text-white px-2 py-0.5 font-medium transition-colors cursor-pointer"
              >
                <RefreshCw className="h-3 w-3" />
                Live Logs
              </button>
            </>
          ) : (
            <>
              <span>Log stream ended{errorMessage ? `: ${errorMessage}` : ''}</span>
              <button
                type="button"
                data-testid="reconnect-button"
                title="Reconnect log stream (Enter)"
                onClick={handleReconnectNow}
                className="flex items-center gap-1 rounded bg-sky-600 hover:bg-sky-500 text-white px-2 py-0.5 font-medium transition-colors cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                Reconnect
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default K8sLogView;
