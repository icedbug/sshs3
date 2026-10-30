import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Box,
  Bug,
  CheckCircle2,
  Clock,
  Copy,
  Check,
  Cpu,
  FileCode,
  Folder,
  Info,
  Loader2,
  Network,
  RefreshCw,
  ScrollText,
  Server,
  Tag,
  TerminalSquare,
  X,
  XCircle,
} from 'lucide-react';
import type {
  K8sPodDescription,
  K8sTerminalTarget,
} from '@shared/types/kubernetes';
import { formatDateTime } from '../../lib/dateFormat';
import { describeIpcError } from '../../lib/format';
import { useEscapeToClose } from '../../lib/useModalDismiss';

interface K8sPodDetailModalProps {
  contextName: string;
  namespace: string;
  podName: string;
  onClose: () => void;
  onExec?: (target: K8sTerminalTarget) => void;
  onViewLogs?: (target: K8sTerminalTarget) => void;
  onBrowseFiles?: (target: K8sTerminalTarget) => void;
  onPortForward?: (contextName: string, namespace: string, podName: string, containerPort?: number) => void;
  onDebug?: (contextName: string, namespace: string, podName: string, containers: string[]) => void;
}

type TabType = 'overview' | 'containers' | 'events' | 'yaml';

export const K8sPodDetailModal: React.FC<K8sPodDetailModalProps> = ({
  contextName,
  namespace,
  podName,
  onClose,
  onExec,
  onViewLogs,
  onBrowseFiles,
  onPortForward,
  onDebug,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pod, setPod] = useState<K8sPodDescription | null>(null);
  const [copied, setCopied] = useState(false);
  useEscapeToClose(onClose, true);

  const fetchPod = useCallback(() => {
    setLoading(true);
    setError(null);
    window.multissh
      .k8sDescribePod(contextName, namespace, podName)
      .then((data) => {
        setPod(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(describeIpcError(err, String(err)));
        setLoading(false);
      });
  }, [contextName, namespace, podName]);

  useEffect(() => {
    fetchPod();
  }, [fetchPod]);

  const handleCopyYaml = () => {
    if (!pod?.yaml) return;
    navigator.clipboard.writeText(pod.yaml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const phaseColorClass = (phase?: string) => {
    switch (phase?.toLowerCase()) {
      case 'running':
        return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400';
      case 'succeeded':
        return 'bg-sky-500/15 border-sky-500/30 text-sky-400';
      case 'pending':
        return 'bg-amber-500/15 border-amber-500/30 text-amber-400';
      case 'failed':
        return 'bg-rose-500/15 border-rose-500/30 text-rose-400';
      default:
        return 'bg-zinc-500/15 border-zinc-500/30 text-txt-muted';
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Pod ${podName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 animate-in fade-in duration-150"
    >
      <div className="flex h-[85vh] w-full max-w-4xl flex-col rounded-xl border border-border-subtle bg-app-card shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-divider bg-app-surface px-5 py-3.5">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/15 border border-indigo-500/30 text-indigo-400">
              <Box className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-semibold text-txt-primary">{podName}</h2>
                {pod?.phase && (
                  <span
                    className={`rounded border px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ${phaseColorClass(
                      pod.phase
                    )}`}
                  >
                    {pod.phase}
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-txt-muted">
                {namespace} · <span className="text-sky-400">{contextName}</span>
                {pod?.podIP && ` · IP: ${pod.podIP}`}
                {pod?.nodeName && ` · Node: ${pod.nodeName}`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {pod && (
              <button
                type="button"
                data-testid="k8s-pod-analyze-ai-btn"
                title="Bifoga poddens status, containers, events och YAML till AI Hub för diagnos"
                onClick={() => {
                  const eventsText = (pod.events ?? [])
                    .slice(0, 15)
                    .map((ev) => `- [${ev.type}] ${ev.reason}: ${ev.message}`)
                    .join('\n');
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-attach', {
                      detail: {
                        label: `@k8s-pod:${podName}`,
                        text: [
                          `Kubernetes Pod: ${namespace}/${podName} (context: ${contextName})`,
                          `Phase: ${pod.phase} · Node: ${pod.nodeName || 'N/A'} · IP: ${pod.podIP || 'N/A'}`,
                          `Containers: ${(pod.containers ?? []).map((c) => `${c.name} [ready=${c.ready}, restarts=${c.restartCount}, state=${c.state}]`).join(', ')}`,
                          ...(eventsText ? [`Recent Events:\n${eventsText}`] : []),
                          ...(pod.yaml ? [`\nYAML (excerpt):\n${pod.yaml.slice(0, 6000)}`] : []),
                        ].join('\n'),
                        prompt: `Analysera Kubernetes-podden @k8s-pod:${podName} i namespace ${namespace} och kontrollera PVC/CSI-volymer, events och container-status.`,
                      },
                    })
                  );
                  onClose();
                }}
                className="flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-2.5 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 transition-colors"
              >
                <span>✨ Analysera med AI</span>
              </button>
            )}
            {onDebug && (
              <button
                type="button"
                onClick={() => {
                  const containerNames = pod ? pod.containers.map((c) => c.name) : [];
                  onDebug(contextName, namespace, podName, containerNames);
                }}
                disabled={loading}
                title="Attach ephemeral debug container (kubectl debug)"
                className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-400 hover:bg-amber-500/20 hover:text-amber-300 transition-colors disabled:opacity-50"
              >
                <Bug className="h-3.5 w-3.5" />
                Debug
              </button>
            )}
            <button
              type="button"
              onClick={fetchPod}
              disabled={loading}
              title="Refresh pod details"
              className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1.5 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              title="Close modal"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tab navigation */}
        <div className="flex items-center gap-1 border-b border-divider bg-app-surface-subtle px-5 pt-2">
          <button
            type="button"
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeTab === 'overview'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-txt-muted hover:text-txt-primary'
            }`}
          >
            <Info className="h-3.5 w-3.5" />
            Overview
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('containers')}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeTab === 'containers'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-txt-muted hover:text-txt-primary'
            }`}
          >
            <Cpu className="h-3.5 w-3.5" />
            Containers ({pod?.containers.length ?? 0})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('events')}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeTab === 'events'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-txt-muted hover:text-txt-primary'
            }`}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Events ({pod?.events.length ?? 0})
            {pod?.events.some((e) => e.type === 'Warning') && (
              <span className="flex h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('yaml')}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
              activeTab === 'yaml'
                ? 'border-sky-500 text-sky-400'
                : 'border-transparent text-txt-muted hover:text-txt-primary'
            }`}
          >
            <FileCode className="h-3.5 w-3.5" />
            YAML
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading && !pod && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-txt-muted">
              <Loader2 className="h-6 w-6 animate-spin text-sky-400" />
              <p className="text-sm">Fetching pod status and events...</p>
            </div>
          )}

          {error && (
            <div className="rounded-xl border border-red-900/60 bg-red-950/40 p-4 text-xs text-red-300">
              <div className="flex items-center gap-2 font-semibold">
                <XCircle className="h-4 w-4" /> Failed to describe pod
              </div>
              <p className="mt-1 text-red-200">{error}</p>
            </div>
          )}

          {!loading && pod && (
            <>
              {/* TAB: Overview */}
              {activeTab === 'overview' && (
                <div className="space-y-5 text-xs">
                  {/* Summary grid */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-lg border border-border-subtle bg-app-surface p-3">
                      <div className="text-xs font-medium text-txt-muted flex items-center gap-1.5">
                        <Clock className="h-3 w-3" /> Started At
                      </div>
                      <div className="mt-1 font-semibold text-txt-primary">
                        {formatDateTime(pod.startTime)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border-subtle bg-app-surface p-3">
                      <div className="text-xs font-medium text-txt-muted flex items-center gap-1.5">
                        <Network className="h-3 w-3" /> Pod IP
                      </div>
                      <div className="mt-1 font-semibold text-txt-primary">{pod.podIP || '—'}</div>
                    </div>
                    <div className="rounded-lg border border-border-subtle bg-app-surface p-3">
                      <div className="text-xs font-medium text-txt-muted flex items-center gap-1.5">
                        <Server className="h-3 w-3" /> Host IP
                      </div>
                      <div className="mt-1 font-semibold text-txt-primary">{pod.hostIP || '—'}</div>
                    </div>
                    <div className="rounded-lg border border-border-subtle bg-app-surface p-3">
                      <div className="text-xs font-medium text-txt-muted flex items-center gap-1.5">
                        <Server className="h-3 w-3" /> Node
                      </div>
                      <div className="mt-1 font-semibold text-txt-primary truncate" title={pod.nodeName}>
                        {pod.nodeName || '—'}
                      </div>
                    </div>
                  </div>

                  {/* Conditions */}
                  <div className="space-y-2">
                    <h3 className="font-semibold text-txt-primary flex items-center gap-1.5">
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" /> Pod Conditions
                    </h3>
                    <div className="overflow-hidden rounded-lg border border-border-subtle bg-app-surface">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-divider bg-app-surface-subtle text-xs font-medium text-txt-muted">
                            <th className="px-3 py-2">Condition</th>
                            <th className="px-3 py-2">Status</th>
                            <th className="px-3 py-2">Updated</th>
                            <th className="px-3 py-2">Reason / Message</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-divider text-xs">
                          {pod.conditions.map((cond) => {
                            const isTrue = cond.status === 'True';
                            return (
                              <tr key={cond.type} className="hover:bg-app-surface-hover/50">
                                <td className="px-3 py-2 font-medium text-txt-primary">{cond.type}</td>
                                <td className="px-3 py-2">
                                  <span
                                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ${
                                      isTrue
                                        ? 'bg-emerald-500/15 text-emerald-400'
                                        : 'bg-rose-500/15 text-rose-400'
                                    }`}
                                  >
                                    {isTrue ? (
                                      <CheckCircle2 className="h-3 w-3" />
                                    ) : (
                                      <XCircle className="h-3 w-3" />
                                    )}
                                    {cond.status}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-txt-muted whitespace-nowrap">
                                  {formatDateTime(cond.lastTransitionTime)}
                                </td>
                                <td className="px-3 py-2 text-txt-muted">
                                  {cond.reason && <span className="font-medium text-txt-secondary mr-1">{cond.reason}:</span>}
                                  {cond.message || '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Labels */}
                  {Object.keys(pod.labels).length > 0 && (
                    <div className="space-y-2">
                      <h3 className="font-semibold text-txt-primary flex items-center gap-1.5">
                        <Tag className="h-4 w-4 text-sky-400" /> Labels
                      </h3>
                      <div className="flex flex-wrap gap-1.5">
                        {Object.entries(pod.labels).map(([k, v]) => (
                          <span
                            key={k}
                            className="inline-flex items-center rounded-md border border-border-subtle bg-app-surface px-2 py-1 text-xs text-txt-secondary font-mono"
                          >
                            <span className="text-sky-400">{k}</span>
                            <span className="mx-1 text-txt-muted">=</span>
                            <span className="text-txt-primary truncate max-w-[200px]">{v}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* TAB: Containers */}
              {activeTab === 'containers' && (
                <div className="space-y-4 text-xs">
                  {[...pod.containers, ...(pod.ephemeralContainers || [])].map((c) => (
                    <div
                      key={c.name}
                      className="rounded-xl border border-border-subtle bg-app-surface p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-divider pb-3">
                        <div className="flex items-center gap-2">
                          <Cpu className="h-4 w-4 text-indigo-400" />
                          <span className="text-sm font-semibold text-txt-primary">{c.name}</span>
                          {c.isEphemeral && (
                            <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-2xs text-amber-400 font-medium">
                              Ephemeral Debug
                            </span>
                          )}
                          <span
                            className={`rounded border px-2 py-0.5 text-2xs font-medium capitalize ${
                              c.state === 'running'
                                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                                : c.state === 'waiting'
                                ? 'bg-amber-500/15 border-amber-500/30 text-amber-400'
                                : 'bg-rose-500/15 border-rose-500/30 text-rose-400'
                            }`}
                          >
                            {c.state}
                          </span>
                          {c.ready && (
                            <span className="rounded bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 text-2xs text-emerald-400">
                              Ready
                            </span>
                          )}
                        </div>

                        {/* Actions for this container */}
                        <div className="flex items-center gap-1.5">
                          {c.ports && c.ports.length > 0 && onPortForward && (
                            <button
                              type="button"
                              onClick={() =>
                                onPortForward(contextName, namespace, podName, c.ports![0].containerPort)
                              }
                              className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                            >
                              <ArrowUpRight className="h-3 w-3 text-sky-400" />
                              Port Forward ({c.ports[0].containerPort})
                            </button>
                          )}
                           {onBrowseFiles && (
                            <button
                              type="button"
                              onClick={() =>
                                onBrowseFiles({
                                  contextName,
                                  namespace,
                                  podName,
                                  containerName: c.name,
                                })
                              }
                              title="Browse container filesystem"
                              className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                            >
                              <Folder className="h-3 w-3 text-amber-400" />
                              Files
                            </button>
                          )}
                          {onViewLogs && (
                            <button
                              type="button"
                              onClick={() =>
                                onViewLogs({
                                  contextName,
                                  namespace,
                                  podName,
                                  containerName: c.name,
                                })
                              }
                              className="flex items-center gap-1 rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                            >
                              <ScrollText className="h-3 w-3" />
                              Logs
                            </button>
                          )}
                          {onExec && (
                            <button
                              type="button"
                              onClick={() =>
                                onExec({
                                  contextName,
                                  namespace,
                                  podName,
                                  containerName: c.name,
                                })
                              }
                              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 transition-colors"
                            >
                              <TerminalSquare className="h-3 w-3" />
                              Exec
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 text-xs">
                        <div>
                          <span className="text-txt-muted">Image: </span>
                          <span className="font-mono text-txt-primary break-all">{c.image}</span>
                        </div>
                        <div>
                          <span className="text-txt-muted">Restarts: </span>
                          <span
                            className={`font-semibold ${
                              c.restartCount > 0 ? 'text-amber-400' : 'text-txt-primary'
                            }`}
                          >
                            {c.restartCount}
                          </span>
                        </div>

                        {c.stateDetails?.startedAt && (
                          <div>
                            <span className="text-txt-muted">Started: </span>
                            <span className="text-txt-primary">
                              {formatDateTime(c.stateDetails.startedAt)}
                            </span>
                          </div>
                        )}
                        {c.stateDetails?.exitCode !== undefined && (
                          <div>
                            <span className="text-txt-muted">Exit Code: </span>
                            <span
                              className={`font-bold font-mono ${
                                c.stateDetails.exitCode === 0 ? 'text-emerald-400' : 'text-rose-400'
                              }`}
                            >
                              {c.stateDetails.exitCode}
                            </span>
                          </div>
                        )}
                        {c.stateDetails?.reason && (
                          <div className="sm:col-span-2">
                            <span className="text-txt-muted">Reason: </span>
                            <span className="font-semibold text-amber-400">
                              {c.stateDetails.reason}
                            </span>
                          </div>
                        )}
                        {c.stateDetails?.message && (
                          <div className="sm:col-span-2 rounded bg-app-surface-subtle p-2 text-rose-300 font-mono text-2xs">
                            {c.stateDetails.message}
                          </div>
                        )}

                        {c.ports && c.ports.length > 0 && (
                          <div className="sm:col-span-2 pt-1">
                            <span className="text-txt-muted">Exposed Ports: </span>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {c.ports.map((p) => (
                                <span
                                  key={p.containerPort}
                                  className="rounded border border-border-subtle bg-app-surface-subtle px-2 py-0.5 text-2xs font-mono text-sky-400"
                                >
                                  {p.containerPort}
                                  {p.protocol ? `/${p.protocol}` : ''}
                                  {p.name ? ` (${p.name})` : ''}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* TAB: Events */}
              {activeTab === 'events' && (
                <div className="space-y-2 text-xs">
                  {pod.events.length === 0 ? (
                    <div className="py-12 text-center text-txt-muted">
                      <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-400/50 mb-2" />
                      <p>No events recorded for this pod.</p>
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-border-subtle bg-app-surface">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-divider bg-app-surface-subtle text-xs font-medium text-txt-muted">
                            <th className="px-3 py-2 w-24">Type</th>
                            <th className="px-3 py-2 w-36">Reason</th>
                            <th className="px-3 py-2">Message</th>
                            <th className="px-3 py-2 w-32 whitespace-nowrap">Last Seen</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-divider text-xs">
                          {pod.events.map((evt, idx) => {
                            const isWarning = evt.type === 'Warning';
                            return (
                              <tr
                                key={idx}
                                className={`hover:bg-app-surface-hover/50 ${
                                  isWarning ? 'bg-amber-500/5' : ''
                                }`}
                              >
                                <td className="px-3 py-2">
                                  <span
                                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-semibold ${
                                      isWarning
                                        ? 'bg-rose-500/15 border border-rose-500/30 text-rose-400'
                                        : 'bg-sky-500/15 border border-sky-500/30 text-sky-400'
                                    }`}
                                  >
                                    {evt.type}
                                  </span>
                                </td>
                                <td className="px-3 py-2 font-medium text-txt-primary">
                                  {evt.reason}
                                  {evt.count && evt.count > 1 && (
                                    <span className="ml-1 text-2xs text-txt-muted font-normal">
                                      (x{evt.count})
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-txt-secondary leading-relaxed">
                                  {evt.message}
                                </td>
                                <td className="px-3 py-2 text-txt-muted whitespace-nowrap font-mono text-2xs">
                                  {formatDateTime(evt.lastTimestamp || evt.firstTimestamp)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* TAB: YAML */}
              {activeTab === 'yaml' && (
                <div className="space-y-2">
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleCopyYaml}
                      className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
                    >
                      {copied ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" />
                          Copy YAML
                        </>
                      )}
                    </button>
                  </div>
                  <pre className="max-h-[500px] overflow-auto rounded-xl border border-border-subtle bg-app-surface-subtle p-4 font-mono text-xs leading-relaxed text-txt-secondary">
                    {pod.yaml}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-divider bg-app-surface px-5 py-3">
          <div className="flex items-center gap-2">
            {onPortForward && (
              <button
                type="button"
                onClick={() => onPortForward(contextName, namespace, podName)}
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <ArrowUpRight className="h-3.5 w-3.5 text-sky-400" />
                Port Forward
              </button>
            )}
             {onBrowseFiles && pod?.containers[0] && (
              <button
                type="button"
                onClick={() =>
                  onBrowseFiles({
                    contextName,
                    namespace,
                    podName,
                    containerName: pod.containers[0].name,
                  })
                }
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <Folder className="h-3.5 w-3.5 text-amber-400" />
                Browse Files
              </button>
            )}
            {onViewLogs && pod?.containers[0] && (
              <button
                type="button"
                onClick={() =>
                  onViewLogs({
                    contextName,
                    namespace,
                    podName,
                    containerName: pod.containers[0].name,
                  })
                }
                className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface-subtle px-3 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
              >
                <ScrollText className="h-3.5 w-3.5" />
                View Logs
              </button>
            )}
            {onExec && pod?.containers[0] && (
              <button
                type="button"
                onClick={() =>
                  onExec({
                    contextName,
                    namespace,
                    podName,
                    containerName: pod.containers[0].name,
                  })
                }
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 transition-colors"
              >
                <TerminalSquare className="h-3.5 w-3.5" />
                Exec Shell
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-subtle bg-app-surface-subtle px-4 py-1.5 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default K8sPodDetailModal;
