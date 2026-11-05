import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Box,
  Bug,
  ChevronDown,
  ChevronRight,
  Cpu,
  Folder,
  Info,
  Loader2,
  LogIn,
  Network,
  RefreshCw,
  ScrollText,
  Search,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react';
import type { K8sClusterNode, K8sNamespaceNode, K8sPodNode, K8sProfile, K8sTerminalTarget } from '@shared/types/kubernetes';
import { useConfirm } from '../ConfirmDialog';
import { K8sPodDetailModal } from '../K8s/K8sPodDetailModal';
import { K8sPortForwardModal } from '../K8s/K8sPortForwardModal';
import { K8sDebugModal } from '../K8s/K8sDebugModal';
import { K8sLoginModal } from '../K8s/K8sLoginModal';
import { K8sProfileActions, K8sUnattachedProfileRow } from '../K8s/K8sProfileRow';
import { K8sSharePicker, K8sTeamVaultSection } from '../K8s/K8sTeamVaultSection';
import { K8sTeamProfileForm } from '../K8s/K8sTeamProfileForm';
import { describeError } from '../../lib/k8sErrors';
import {
  personalProfileFromTemplate,
  profileForContext,
  restrictedNamespaces,
  templateFromProfile,
  unattachedProfiles,
} from '../../lib/k8sProfiles';
import { useK8sTeamProfiles, type TeamK8sGroup } from '../../lib/useK8sTeamProfiles';

type Loadable<T> = { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; data: T };

const stateDotClass: Record<string, string> = {
  running: 'bg-emerald-500',
  waiting: 'bg-amber-500',
  terminated: 'bg-txt-muted',
  unknown: 'bg-txt-muted',
};

/**
 * Warns that a kubeconfig change picked up while the app was running
 * introduced a new exec-auth (credential plugin) user — see the H8
 * code-review finding and K8sDiscoveryService.checkExecAuthChange.
 */
const ExecAuthWarningBanner: React.FC<{ warning: string; onDismiss: () => void }> = ({ warning, onDismiss }) => (
  <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
    <span className="flex-1">{warning}</span>
    <button
      type="button"
      onClick={onDismiss}
      aria-label="Dismiss warning"
      className="shrink-0 rounded p-0.5 hover:bg-amber-900/40"
    >
      <X className="h-3.5 w-3.5" />
    </button>
  </div>
);

interface K8sConnectionTreeProps {
  /** Invoked when the user clicks "Exec" on a container. */
  onExec?: (target: K8sTerminalTarget) => void;
  /** Invoked when the user clicks "Logs" on a container. */
  onViewLogs?: (target: K8sTerminalTarget) => void;
  /** Invoked when the user clicks "Files" to browse container filesystem. */
  onBrowseFiles?: (target: K8sTerminalTarget) => void;
  /** Master switch for OpenShift support and tools (e.g. oc login, oc CLI shim). Off by default. */
  enableOpenShift?: boolean;
}

export const K8sConnectionTree: React.FC<K8sConnectionTreeProps> = ({
  onExec,
  onViewLogs,
  onBrowseFiles,
  enableOpenShift: enableOpenShiftProp,
}) => {
  const [enableOpenShift, setEnableOpenShift] = useState<boolean>(enableOpenShiftProp ?? false);

  useEffect(() => {
    if (enableOpenShiftProp !== undefined) {
      setEnableOpenShift(enableOpenShiftProp);
    } else {
      window.multissh?.settingsGet?.().then((settings) => {
        if (settings && typeof settings.enableOpenShift === 'boolean') {
          setEnableOpenShift(settings.enableOpenShift);
        }
      }).catch(() => {});
    }
  }, [enableOpenShiftProp]);
  const [contexts, setContexts] = useState<Loadable<K8sClusterNode[]>>({ status: 'loading' });
  const [execAuthWarning, setExecAuthWarning] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [expandedContexts, setExpandedContexts] = useState<Set<string>>(new Set());
  const [namespacesByContext, setNamespacesByContext] = useState<Record<string, Loadable<K8sNamespaceNode[]>>>({});
  const [expandedNamespaces, setExpandedNamespaces] = useState<Set<string>>(new Set());
  const [podsByNamespace, setPodsByNamespace] = useState<Record<string, Loadable<K8sPodNode[]>>>({});
  const [expandedPods, setExpandedPods] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [describeTarget, setDescribeTarget] = useState<{
    contextName: string;
    namespace: string;
    podName: string;
  } | null>(null);
  const [portForwardTarget, setPortForwardTarget] = useState<{
    contextName: string;
    namespace: string;
    podName: string;
    containerPort?: number;
  } | null>(null);
  const [portForwardModalOpen, setPortForwardModalOpen] = useState(false);
  const [debugTarget, setDebugTarget] = useState<{
    contextName: string;
    namespace: string;
    podName: string;
    containers?: string[];
  } | null>(null);
  const [debugModalOpen, setDebugModalOpen] = useState(false);
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<K8sProfile[]>([]);
  const [loginProfile, setLoginProfile] = useState<K8sProfile | null>(null);
  const teamK8s = useK8sTeamProfiles(enableOpenShift);
  const [teamForm, setTeamForm] = useState<{ group: TeamK8sGroup; template: K8sProfile | null } | null>(null);
  const [sharing, setSharing] = useState<K8sProfile | null>(null);
  const [activePortForwardsCount, setActivePortForwardsCount] = useState(0);

  useEffect(() => {
    window.multissh
      .k8sListPortForwards()
      .then((list) => setActivePortForwardsCount(list.length))
      .catch(() => {});

    const unsubscribe = window.multissh.onK8sPortForwardEvent((list) => {
      setActivePortForwardsCount(list.length);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const loadContexts = () => {
    setContexts({ status: 'loading' });
    window.multissh
      .k8sListContexts()
      .then((data) => setContexts({ status: 'ready', data }))
      .catch((err) => setContexts({ status: 'error', error: describeError(err) }));
  };

  useEffect(() => {
    loadContexts();

    const unsubscribe = window.multissh.onK8sConfigChanged?.((warning) => {
      if (warning) setExecAuthWarning(warning);
      loadContexts();
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const loadProfiles = async (): Promise<K8sProfile[]> => {
    try {
      const list = (await window.multissh.k8sProfilesList?.()) ?? [];
      setProfiles(list);
      return list;
    } catch {
      return [];
    }
  };

  useEffect(() => {
    void loadProfiles();
  }, []);

  const openLogin = (profile: K8sProfile | null) => {
    setLoginProfile(profile);
    setLoginModalOpen(true);
  };

  const handleRefresh = async () => {
    try {
      await window.multissh.k8sReload();
    } catch {
      // Ignored
    }
    void loadProfiles();
    void teamK8s.reload();
    setNamespacesByContext({});
    setPodsByNamespace({});
    setExpandedContexts(new Set());
    setExpandedNamespaces(new Set());
    setExpandedPods(new Set());
    loadContexts();
  };

  /** A profile limited to one project shows just that project, so the cluster-wide list is never requested. */
  const loadNamespaces = (contextName: string, knownProfiles: K8sProfile[] = profiles) => {
    const restricted = restrictedNamespaces(profileForContext(knownProfiles, contextName));
    if (restricted) {
      setNamespacesByContext((p) => ({ ...p, [contextName]: { status: 'ready', data: restricted } }));
      return;
    }
    setNamespacesByContext((p) => ({ ...p, [contextName]: { status: 'loading' } }));
    window.multissh
      .k8sListNamespaces(contextName)
      .then((data) => setNamespacesByContext((p) => ({ ...p, [contextName]: { status: 'ready', data } })))
      .catch((err) =>
        setNamespacesByContext((p) => ({
          ...p,
          [contextName]: { status: 'error', error: describeError(err) },
        }))
      );
  };

  const toggleContext = (contextName: string) => {
    const opening = !expandedContexts.has(contextName);
    setExpandedContexts((prev) => {
      const next = new Set(prev);
      if (next.has(contextName)) next.delete(contextName);
      else next.add(contextName);
      return next;
    });
    // Outside the updater: a state updater must be pure (StrictMode runs it twice, which sent the request twice).
    if (opening && !namespacesByContext[contextName]) loadNamespaces(contextName);
  };

  const confirm = useConfirm();

  const refreshPods = (contextName: string, namespace: string) => {
    const key = `${contextName}/${namespace}`;
    window.multissh
      .k8sListPods(contextName, namespace)
      .then((data) => setPodsByNamespace((p) => ({ ...p, [key]: { status: 'ready', data } })))
      .catch((err) =>
        setPodsByNamespace((p) => ({
          ...p,
          [key]: { status: 'error', error: describeError(err) },
        }))
      );
  };

  const handleDeletePod = async (contextName: string, namespace: string, podName: string) => {
    const confirmed = await confirm({
      title: 'Delete Pod',
      message: (
        <span>
          Delete pod <strong className="text-txt-primary">{podName}</strong>?
          If managed by a controller, a replacement will start automatically.
        </span>
      ),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await window.multissh.k8sDeletePod(contextName, namespace, podName);
      refreshPods(contextName, namespace);
    } catch {
      refreshPods(contextName, namespace);
    }
  };

  const handleRemoveProfile = async (profile: K8sProfile) => {
    const confirmed = await confirm({
      title: 'Remove profile',
      message: (
        <span>
          Remove the saved cluster <strong className="text-txt-primary">{profile.name}</strong>? Its entry in your
          kubeconfig (and any stored token) is kept.
        </span>
      ),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await window.multissh.k8sProfilesDelete(profile.id);
    } catch {
      // The reload below shows the actual state.
    }
    const list = await loadProfiles();
    // A context that was limited to one project goes back to listing the whole cluster.
    if (profile.contextName && !profileForContext(list, profile.contextName)) {
      setNamespacesByContext((p) => {
        const { [profile.contextName as string]: _dropped, ...rest } = p;
        return rest;
      });
      setExpandedContexts((prev) => {
        const next = new Set(prev);
        next.delete(profile.contextName as string);
        return next;
      });
    }
  };

  const loginSuccess = async (result?: { contextName?: string }) => {
    await handleRefresh();
    const list = await loadProfiles();
    if (result?.contextName) {
      setExpandedContexts((prev) => new Set(prev).add(result.contextName as string));
      loadNamespaces(result.contextName, list);
    }
  };

  const saveTeamTemplate = async (group: TeamK8sGroup, template: K8sProfile) => {
    await window.multissh.teamVaultSaveK8sProfile(group.vaultId, template);
    await teamK8s.reload();
  };

  const removeTeamTemplate = async (group: TeamK8sGroup, template: K8sProfile) => {
    const confirmed = await confirm({
      title: 'Remove shared cluster',
      message: (
        <span>
          Remove <strong className="text-txt-primary">{template.name}</strong> from {group.vaultName} for everyone on the
          team? Members keep their own profiles and kubeconfig entries.
        </span>
      ),
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!confirmed) return;
    try {
      await window.multissh.teamVaultDeleteK8sProfile(group.vaultId, template.id);
    } catch {
      // The reload below shows the actual state.
    }
    await teamK8s.reload();
  };

  /** Sharing is started from a button with nothing waiting for the result, so a failure is shown here. */
  const shareTemplate = async (group: TeamK8sGroup, template: K8sProfile) => {
    setShareError(null);
    try {
      await saveTeamTemplate(group, template);
    } catch (err) {
      setShareError(describeError(err));
    }
  };

  const shareProfile = (profile: K8sProfile) => {
    if (teamK8s.groups.length === 1) void shareTemplate(teamK8s.groups[0], templateFromProfile(profile));
    else setSharing(profile);
  };
  const onShare = teamK8s.groups.length > 0 ? shareProfile : undefined;

  const teamSection = enableOpenShift ? (
    <K8sTeamVaultSection
      groups={teamK8s.groups}
      lockedCount={teamK8s.lockedCount}
      onSignIn={(template) => openLogin(personalProfileFromTemplate(profiles, template))}
      onAdd={(group) => setTeamForm({ group, template: null })}
      onEdit={(group, template) => setTeamForm({ group, template })}
      onRemove={(group, template) => void removeTeamTemplate(group, template)}
    />
  ) : null;

  const teamModals = enableOpenShift ? (
    <>
      <K8sTeamProfileForm
        open={teamForm !== null}
        vaultName={teamForm?.group.vaultName ?? ''}
        initial={teamForm?.template ?? null}
        onSave={(template) => saveTeamTemplate(teamForm!.group, template)}
        onClose={() => setTeamForm(null)}
      />
      <K8sSharePicker
        profile={sharing}
        groups={teamK8s.groups}
        onPick={(group) => {
          if (sharing) void shareTemplate(group, templateFromProfile(sharing));
          setSharing(null);
        }}
        onClose={() => setSharing(null)}
      />
    </>
  ) : null;

  const toggleNamespace = (contextName: string, namespace: string) => {
    const key = `${contextName}/${namespace}`;
    const opening = !expandedNamespaces.has(key);
    setExpandedNamespaces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (opening && !podsByNamespace[key]) {
      setPodsByNamespace((p) => ({ ...p, [key]: { status: 'loading' } }));
      refreshPods(contextName, namespace);
    }
  };

  const togglePod = (podKey: string) => {
    setExpandedPods((prev) => {
      const next = new Set(prev);
      if (next.has(podKey)) next.delete(podKey);
      else next.add(podKey);
      return next;
    });
  };

  if (contexts.status === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-sm text-txt-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading kubeconfig...
      </div>
    );
  }

  if (contexts.status === 'error') {
    return (
      <>
        {execAuthWarning && (
          <ExecAuthWarningBanner warning={execAuthWarning} onDismiss={() => setExecAuthWarning(null)} />
        )}
        <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {contexts.error}
        </div>
      </>
    );
  }

  if (contexts.data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center space-y-4">
        <p className="text-sm text-txt-muted">No contexts found in ~/.kube/config</p>
        {enableOpenShift && (
          <>
            <button
              type="button"
              onClick={() => openLogin(null)}
              className="flex items-center gap-2 rounded-lg bg-red-600 hover:bg-red-500 text-white px-4 py-2 text-xs font-medium shadow-sm transition-colors"
            >
              <LogIn className="h-4 w-4" />
              OpenShift / Kubernetes Login
            </button>
            <K8sLoginModal
              open={loginModalOpen}
              initialProfile={loginProfile}
              onClose={() => setLoginModalOpen(false)}
              onSuccess={(result) => void loginSuccess(result)}
            />
            {unattachedProfiles(profiles, []).length > 0 && (
              <div className="w-full space-y-1 text-left">
                {unattachedProfiles(profiles, []).map((profile) => (
                  <K8sUnattachedProfileRow
                    key={profile.id}
                    profile={profile}
                    onSignIn={openLogin}
                    onRemove={(p) => void handleRemoveProfile(p)}
                    onShare={onShare}
                  />
                ))}
              </div>
            )}
            <div className="w-full text-left">{teamSection}</div>
            {teamModals}
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {execAuthWarning && (
        <ExecAuthWarningBanner warning={execAuthWarning} onDismiss={() => setExecAuthWarning(null)} />
      )}
      {shareError && (
        <div
          role="alert"
          className="mb-2 flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300"
        >
          <span className="flex-1">Could not share the cluster with the team: {shareError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            title="Dismiss"
            onClick={() => setShareError(null)}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-red-500/20"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="space-y-2">
      <p className="text-2xs text-txt-muted">
        Clusters below are read from your local kubeconfig. Clusters you sign in to from here are also saved as
        profiles, so you can sign in again later.
      </p>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-txt-muted pointer-events-none" />
          <input
            aria-label="Filter clusters, projects and pods"
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter clusters, projects, pods..."
            className="w-full rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1 pl-8 pr-7 text-xs text-txt-primary placeholder:text-txt-muted focus:border-sky-500/50 focus:outline-none transition-colors"
          />
          {filter && (
            <button
              aria-label="Clear filter"
              type="button"
              onClick={() => setFilter('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-txt-muted hover:text-txt-primary p-0.5 rounded transition-colors"
              title="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {enableOpenShift && (
          <button
            type="button"
            onClick={() => openLogin(null)}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs text-red-300 hover:bg-red-500/20 hover:text-red-200 transition-colors"
            title="Log in to OpenShift or Kubernetes with token"
          >
            <LogIn className="h-3.5 w-3.5 text-red-400" />
            OpenShift Login
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            setPortForwardTarget(null);
            setPortForwardModalOpen(true);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-app-surface-subtle px-2.5 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
          title="Manage active port forwards"
        >
          <Network className="h-3.5 w-3.5 text-sky-400" />
          Port Forwards
          {activePortForwardsCount > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded bg-emerald-500/20 text-2xs font-bold text-emerald-400 px-1">
              {activePortForwardsCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={handleRefresh}
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      {enableOpenShift &&
        unattachedProfiles(profiles, contexts.data)
          .filter((profile) => {
            const q = filter.trim().toLowerCase();
            return !q || profile.name.toLowerCase().includes(q) || profile.server.toLowerCase().includes(q);
          })
          .map((profile) => (
            <K8sUnattachedProfileRow
              key={profile.id}
              profile={profile}
              onSignIn={openLogin}
              onRemove={(p) => void handleRemoveProfile(p)}
              onShare={onShare}
            />
          ))}

      {teamSection}

      {contexts.data
        .filter((ctx) => {
          if (!filter.trim()) return true;
          const q = filter.trim().toLowerCase();
          const profileName = profileForContext(profiles, ctx.contextName)?.name.toLowerCase();
          if (ctx.contextName.toLowerCase().includes(q) || ctx.server.toLowerCase().includes(q)) return true;
          if (profileName?.includes(q)) return true;
          const nsState = namespacesByContext[ctx.contextName];
          if (nsState?.status === 'ready') {
            return nsState.data.some(
              (ns) =>
                ns.name.toLowerCase().includes(q) ||
                (ns.displayName && ns.displayName.toLowerCase().includes(q))
            );
          }
          return false;
        })
        .map((ctx) => {
        const isExpanded = expandedContexts.has(ctx.contextName);
        const nsState = namespacesByContext[ctx.contextName];
        const profile = profileForContext(profiles, ctx.contextName);
        return (
          <div key={ctx.contextName} className="space-y-1">
            <div className="group flex items-center gap-1 rounded-lg hover:bg-app-surface-hover transition-colors">
            <button
              type="button"
              onClick={() => toggleContext(ctx.contextName)}
              title={profile ? ctx.contextName : undefined}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs font-semibold text-txt-secondary"
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-txt-muted" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-txt-muted" />
              )}
              <Network className="h-3.5 w-3.5 text-sky-400" />
              <span className="truncate">{profile?.name ?? ctx.contextName}</span>
              {profile?.namespace && (
                <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-2xs text-amber-400">
                  {profile.namespace}
                </span>
              )}
              {ctx.isOpenShift && (
                <span className="rounded bg-rose-500/15 border border-rose-500/30 px-1.5 py-0.2 text-2xs font-medium text-rose-400">
                  OpenShift
                </span>
              )}
              {ctx.isCurrent && (
                <span className="rounded bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.2 text-2xs text-sky-400">
                  current
                </span>
              )}
              <span className="truncate text-xs font-normal text-txt-muted">{ctx.server}</span>
            </button>
            {profile && enableOpenShift && (
              <K8sProfileActions
                profile={profile}
                onSignIn={openLogin}
                onRemove={(p) => void handleRemoveProfile(p)}
                onShare={onShare}
              />
            )}
            </div>

            {isExpanded && (
              <div className="flex flex-col gap-1 pl-5">
                {!nsState || nsState.status === 'loading' ? (
                  <div className="flex items-center gap-2 py-1.5 text-xs text-txt-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading namespaces...
                  </div>
                ) : nsState.status === 'error' ? (
                  <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-xs text-red-300">
                    {nsState.error}
                  </div>
                ) : (
                  (() => {
                    const visibleNamespaces = nsState.data.filter((ns) => {
                      if (!filter.trim()) return true;
                      const q = filter.trim().toLowerCase();
                      return (
                        ns.name.toLowerCase().includes(q) ||
                        (ns.displayName && ns.displayName.toLowerCase().includes(q))
                      );
                    });

                    if (visibleNamespaces.length === 0) {
                      return <p className="py-1 text-xs text-txt-muted">No matching namespaces or projects</p>;
                    }

                    return visibleNamespaces.map((ns) => {
                      const nsKey = `${ctx.contextName}/${ns.name}`;
                      const nsExpanded = expandedNamespaces.has(nsKey);
                      const podState = podsByNamespace[nsKey];
                      return (
                        <div key={nsKey} className="space-y-1">
                          <button
                            type="button"
                            onClick={() => toggleNamespace(ctx.contextName, ns.name)}
                            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover transition-colors"
                          >
                            {nsExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-txt-muted" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-txt-muted" />
                            )}
                            <Folder className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                            <span className="truncate">{ns.name}</span>
                            {ns.displayName && (
                              <span className="truncate text-xs font-normal text-txt-muted">
                                ({ns.displayName})
                              </span>
                            )}
                          </button>

                        {nsExpanded && (
                          <div className="flex flex-col gap-1 pl-5">
                            {!podState || podState.status === 'loading' ? (
                              <div className="flex items-center gap-2 py-1.5 text-xs text-txt-muted">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading pods...
                              </div>
                            ) : podState.status === 'error' ? (
                              <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-2.5 py-1.5 text-xs text-red-300">
                                {podState.error}
                              </div>
                            ) : podState.data.length === 0 ? (
                              <p className="py-1 text-xs text-txt-muted">No pods in this namespace</p>
                            ) : (
                              podState.data.map((pod) => {
                                const podKey = `${nsKey}/${pod.name}`;
                                const podExpanded = expandedPods.has(podKey);
                                return (
                                  <div key={podKey} className="space-y-1">
                                    <div className="group flex items-center justify-between gap-1 rounded-lg px-2 py-1 text-xs text-txt-secondary hover:bg-app-surface-hover transition-colors">
                                      <button
                                        type="button"
                                        onClick={() => togglePod(podKey)}
                                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                                      >
                                        {podExpanded ? (
                                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-txt-muted" />
                                        ) : (
                                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-txt-muted" />
                                        )}
                                        <Box className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
                                        <span className="truncate">{pod.name}</span>
                                        <span className="truncate text-2xs text-txt-muted">{pod.phase}</span>
                                      </button>
                                      <div className="flex shrink-0 items-center gap-1 opacity-75 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setDescribeTarget({
                                              contextName: ctx.contextName,
                                              namespace: ns.name,
                                              podName: pod.name,
                                            });
                                          }}
                                          title="View pod metrics, details & events"
                                          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-txt-muted hover:bg-app-surface hover:text-txt-primary border border-transparent hover:border-border-subtle transition-colors"
                                        >
                                          <Info className="h-3 w-3" />
                                          <span className="hidden sm:inline">Metrics</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            const firstPort = pod.containers.find((c) => c.ports && c.ports.length > 0)?.ports?.[0];
                                            setPortForwardTarget({
                                              contextName: ctx.contextName,
                                              namespace: ns.name,
                                              podName: pod.name,
                                              containerPort: firstPort?.containerPort,
                                            });
                                            setPortForwardModalOpen(true);
                                          }}
                                          title="Port Forward into pod"
                                          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-txt-muted hover:bg-app-surface hover:text-txt-primary border border-transparent hover:border-border-subtle transition-colors"
                                        >
                                          <ArrowUpRight className="h-3 w-3" />
                                          <span className="hidden sm:inline">Forward</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setDebugTarget({
                                              contextName: ctx.contextName,
                                              namespace: ns.name,
                                              podName: pod.name,
                                              containers: pod.containers.map((c) => c.name),
                                            });
                                            setDebugModalOpen(true);
                                          }}
                                          title="Attach ephemeral debug container (kubectl debug)"
                                          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-amber-400 hover:bg-app-surface hover:text-amber-300 border border-transparent hover:border-amber-500/30 transition-colors"
                                        >
                                          <Bug className="h-3 w-3" />
                                          <span className="hidden sm:inline">Debug</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeletePod(ctx.contextName, ns.name, pod.name);
                                          }}
                                          title="Delete or restart pod"
                                          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-rose-400 hover:bg-app-surface hover:text-rose-300 border border-transparent hover:border-rose-500/30 transition-colors"
                                        >
                                          <Trash2 className="h-3 w-3" />
                                          <span className="hidden sm:inline">Delete</span>
                                        </button>
                                      </div>
                                    </div>

                                    {podExpanded && (
                                      <div className="flex flex-col gap-1 pl-5">
                                        {pod.containers.map((container) => (
                                          <div
                                            key={container.name}
                                            className="flex items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-surface px-2.5 py-1.5"
                                          >
                                            <div className="flex min-w-0 items-center gap-1.5">
                                              <Cpu className="h-3.5 w-3.5 shrink-0 text-txt-muted" />
                                              <span
                                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                                  stateDotClass[container.state] || stateDotClass.unknown
                                                }`}
                                                title={container.state}
                                              />
                                              <div className="min-w-0">
                                                <div className="flex items-center gap-1.5">
                                                  <span className="truncate text-xs font-medium text-txt-primary">
                                                    {container.name}
                                                  </span>
                                                  {container.isEphemeral && (
                                                    <span className="rounded bg-amber-500/15 border border-amber-500/30 px-1 py-0.5 text-2xs text-amber-400 font-medium">
                                                      debug
                                                    </span>
                                                  )}
                                                </div>
                                                <div className="truncate text-2xs text-txt-muted">{container.image}</div>
                                              </div>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1.5">
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  const port = container.ports?.[0];
                                                  setPortForwardTarget({
                                                    contextName: ctx.contextName,
                                                    namespace: ns.name,
                                                    podName: pod.name,
                                                    containerPort: port?.containerPort,
                                                  });
                                                  setPortForwardModalOpen(true);
                                                }}
                                                title="Port Forward to this container"
                                                className="flex items-center gap-1 rounded-lg border border-border-subtle px-2 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
                                              >
                                                <ArrowUpRight className="h-3 w-3" />
                                                Forward
                                              </button>
                                              {onBrowseFiles && (
                                                <button
                                                  type="button"
                                                  onClick={() =>
                                                    onBrowseFiles({
                                                      contextName: ctx.contextName,
                                                      namespace: ns.name,
                                                      podName: pod.name,
                                                      containerName: container.name,
                                                    })
                                                  }
                                                  title="Browse container filesystem"
                                                  className="flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover hover:text-txt-primary transition-colors"
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
                                                      contextName: ctx.contextName,
                                                      namespace: ns.name,
                                                      podName: pod.name,
                                                      containerName: container.name,
                                                    })
                                                  }
                                                  className="flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-medium text-txt-secondary hover:bg-app-surface-hover transition-colors"
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
                                                      contextName: ctx.contextName,
                                                      namespace: ns.name,
                                                      podName: pod.name,
                                                      containerName: container.name,
                                                    })
                                                  }
                                                  className="flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
                                                >
                                                  <TerminalSquare className="h-3 w-3" />
                                                  Exec
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })
                            )}
                          </div>
                        )}
                      </div>
                    );
                  });
                })())}
              </div>
            )}
          </div>
        );
      })}
      </div>

      {describeTarget && (
        <K8sPodDetailModal
          contextName={describeTarget.contextName}
          namespace={describeTarget.namespace}
          podName={describeTarget.podName}
          onClose={() => setDescribeTarget(null)}
          onDeleted={() => refreshPods(describeTarget.contextName, describeTarget.namespace)}
          onExec={onExec}
          onViewLogs={onViewLogs}
          onBrowseFiles={onBrowseFiles}
          onPortForward={(cName, nName, pName, cPort) => {
            setPortForwardTarget({
              contextName: cName,
              namespace: nName,
              podName: pName,
              containerPort: cPort,
            });
            setPortForwardModalOpen(true);
          }}
          onDebug={(cName, nName, pName, containers) => {
            setDebugTarget({
              contextName: cName,
              namespace: nName,
              podName: pName,
              containers,
            });
            setDebugModalOpen(true);
          }}
        />
      )}

      <K8sPortForwardModal
        open={portForwardModalOpen}
        initialTarget={portForwardTarget ?? undefined}
        onClose={() => setPortForwardModalOpen(false)}
      />

      <K8sDebugModal
        open={debugModalOpen}
        target={debugTarget}
        onClose={() => {
          setDebugModalOpen(false);
          setDebugTarget(null);
        }}
        onAttachSuccess={(target) => {
          onExec?.(target);
        }}
      />

      {enableOpenShift && (
        <K8sLoginModal
          open={loginModalOpen}
          initialProfile={loginProfile}
          onClose={() => setLoginModalOpen(false)}
          onSuccess={(result) => void loginSuccess(result)}
        />
      )}
      {teamModals}
    </>
  );
};

export default K8sConnectionTree;
