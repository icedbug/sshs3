import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Clock,
  Cloud,
  Columns2,
  Copy,
  Edit3,
  Folder,
  Key,
  Plus,
  RefreshCw,
  Search,
  Server,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { SftpButton } from './SftpButton';
import { Kbd } from './ui/Kbd';
import type { SSHConnectionConfig } from '@shared/types/ssh';
import type { WorkspaceActivityEvent, WorkspaceServerSummary } from '@shared/types/aiHub';
import type { TabType } from './TabBar';
import {
  FOCUSABLE_OVERLAY_SELECTOR,
  isElementVisible,
  navigateInOverlay,
  type NavigationDirection,
} from '../lib/spatialNavigation';
import { hubRequest, useHub } from '../lib/aiHub';
import { isWebBrowserMode } from '../lib/webClientBridge';

export interface LandingViewProps {
  recentSSH: SSHConnectionConfig[];
  allSSH?: SSHConnectionConfig[];
  onConnectRecentSSH: (profile: SSHConnectionConfig) => void;
  onConnectSFTP: (profile: SSHConnectionConfig) => void;
  onQuickStartTerminal: () => void;
  onNewTab: (type: TabType) => void;
  onOpenProfiles: () => void;
  onNewProfile: () => void;
  onOpenSyncBootstrap: () => void;
  onNavigateToTabBar: () => void;
  onQuickConnectSSH?: (config: SSHConnectionConfig) => void;
  shortcuts?: Record<string, string>;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return '';
  const diffSec = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'nyss';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m sedan`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h sedan`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d sedan`;
}

interface NodeTelemetry {
  latencyMs: string;
  cpuPct: number;
  memPct: number;
  iopsLabel: string;
  sparkPoints: string;
  strokeColor: string;
  badgeClass: string;
  barClass: string;
}

function getNodeTelemetry(server: WorkspaceServerSummary): NodeTelemetry {
  let hash = 0;
  const seed = `${server.id}-${server.name}-${server.cluster ?? ''}`;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const c = (server.cluster || server.role || server.name || '').toLowerCase();
  const isOntap = c.includes('ontap') || c.includes('netapp');
  const isS3 = c.includes('storagegrid') || c.includes('minio') || c.includes('s3');
  const isCeph = c.includes('ceph') || c.includes('san');

  const latencyVal = isOntap
    ? 0.24 + (hash % 22) * 0.01
    : isS3
      ? 0.42 + (hash % 35) * 0.01
      : isCeph
        ? 0.55 + (hash % 40) * 0.01
        : 0.31 + (hash % 30) * 0.01;
  const cpuPct = 18 + (hash % 48);
  const memPct = 34 + ((hash >> 3) % 44);
  const iopsVal = isOntap
    ? `${(32 + (hash % 28)).toFixed(1)}k IOPS`
    : isS3
      ? `${(14 + (hash % 19)).toFixed(1)}k obj/s`
      : `${(18 + (hash % 24)).toFixed(1)}k ops/s`;

  const pts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const x = i * 8;
    const y = 14 - (((hash >> (i * 2)) % 9) + 3);
    pts.push(`${x},${y}`);
  }

  if (isOntap) {
    return {
      latencyMs: `${latencyVal.toFixed(2)} ms`,
      cpuPct,
      memPct,
      iopsLabel: iopsVal,
      sparkPoints: pts.join(' '),
      strokeColor: '#38bdf8',
      badgeClass: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
      barClass: 'from-sky-500 to-cyan-300',
    };
  }
  if (isS3) {
    return {
      latencyMs: `${latencyVal.toFixed(2)} ms`,
      cpuPct,
      memPct,
      iopsLabel: iopsVal,
      sparkPoints: pts.join(' '),
      strokeColor: '#10b981',
      badgeClass: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
      barClass: 'from-emerald-500 to-teal-300',
    };
  }
  if (isCeph) {
    return {
      latencyMs: `${latencyVal.toFixed(2)} ms`,
      cpuPct,
      memPct,
      iopsLabel: iopsVal,
      sparkPoints: pts.join(' '),
      strokeColor: '#f59e0b',
      badgeClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      barClass: 'from-amber-500 to-yellow-300',
    };
  }
  return {
    latencyMs: `${latencyVal.toFixed(2)} ms`,
    cpuPct,
    memPct,
    iopsLabel: iopsVal,
    sparkPoints: pts.join(' '),
    strokeColor: '#2dd4bf',
    badgeClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
    barClass: 'from-teal-500 to-emerald-300',
  };
}

export const LandingView: React.FC<LandingViewProps> = ({
  recentSSH,
  allSSH = [],
  onConnectRecentSSH,
  onConnectSFTP,
  onQuickStartTerminal,
  onNewTab,
  onOpenProfiles,
  onNewProfile,
  onOpenSyncBootstrap,
  onNavigateToTabBar,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hub = useHub();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFolder] = useState<string>('ALL');
  const [selectedCluster, setSelectedCluster] = useState<string>('ALL');
  const [selectedTag] = useState<string>('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'shared' | 'personal'>('all');
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [inspectedServerId, setInspectedServerId] = useState<string | null>(null);
  const [editCluster, setEditCluster] = useState('');
  const [editNodeRole, setEditNodeRole] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editLocalUser, setEditLocalUser] = useState('');
  const [editLocalKeyPath, setEditLocalKeyPath] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);

  // Add Cluster / Node builder state
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [newNodeName, setNewNodeName] = useState('');
  const [newNodeHost, setNewNodeHost] = useState('');
  const [newNodePort] = useState('22');
  const [newNodeUser, setNewNodeUser] = useState('ubuntu');
  const [newNodeCluster, setNewNodeCluster] = useState('');
  const [newNodeRole] = useState('worker-node');
  const [newInfraRole] = useState('k8s');
  const [newNodeTags] = useState('k8s, prod');
  const [newNodeDesc, setNewNodeDesc] = useState('');
  const [newNodeShared] = useState(true);
  const [creatingNode, setCreatingNode] = useState(false);

  // S3 Team Bucket setup state
  const [s3SetupOpen, setS3SetupOpen] = useState(false);
  const [s3InviteCode, setS3InviteCode] = useState('');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Region, setS3Region] = useState('eu-north-1');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Prefix, setS3Prefix] = useState('sshs3-team');
  const [s3AccessKeyId, setS3AccessKeyId] = useState('');
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState('');
  const [s3ActorName, setS3ActorName] = useState('');
  const [s3Saving, setS3Saving] = useState(false);
  const [s3Syncing, setS3Syncing] = useState(false);
  const [s3CopyFeedback, setS3CopyFeedback] = useState(false);
  const [s3StatusMsg, setS3StatusMsg] = useState<string | null>(null);

  const [noteTarget] = useState('');
  const [noteSummary, setNoteSummary] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  // Workspace & Right Column state
  const [showClusterTopology, setShowClusterTopology] = useState(false);
  const [rightColTab, setRightColTab] = useState<'activity' | 'memory' | 'kb' | 'workforce'>('activity');
  const [memTitle, setMemTitle] = useState('');
  const [memText, setMemText] = useState('');
  const [memKind] = useState<'memory' | 'skill'>('memory');
  const [memTier] = useState<'core' | 'archival' | 'episodic'>('archival');
  const [addingMemory, setAddingMemory] = useState(false);
  const [runningDashboardSwarm, setRunningDashboardSwarm] = useState(false);

  // Auto-focus the first actionable element on mount so keyboard navigation is immediately active
  useEffect(() => {
    const timer = setTimeout(() => {
      const firstBtn = containerRef.current?.querySelector<HTMLElement>(FOCUSABLE_OVERLAY_SELECTOR);
      firstBtn?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Allow typing normally in inputs/textareas/selects
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return;
      }
      e.preventDefault();
      const dir: NavigationDirection =
        e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowLeft' ? 'left' : 'right';

      if (dir === 'up' && containerRef.current) {
        const candidates = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_OVERLAY_SELECTOR)
        ).filter(isElementVisible);
        const active = document.activeElement as HTMLElement | null;

        // If the topmost element is already focused, jumping up moves to TabBar
        if (active && candidates.length > 0 && onNavigateToTabBar) {
          if (candidates[0] === active) {
            onNavigateToTabBar();
            return;
          }
          if (
            candidates[1] === active &&
            candidates[0]?.closest?.('.recent-card') === candidates[1]?.closest?.('.recent-card')
          ) {
            onNavigateToTabBar();
            return;
          }
        }
      }

      if (containerRef.current) {
        navigateInOverlay(containerRef.current, dir);
      }
    } else if (e.key === 'Escape') {
      if (editingServerId) {
        setEditingServerId(null);
        return;
      }
      e.preventDefault();
      onNavigateToTabBar();
    }
  };

  // Merge SSH profiles from props and workspaceServers from AI Hub
  const profileMap = useMemo(() => {
    const map = new Map<string, SSHConnectionConfig>();
    for (const p of recentSSH) map.set(p.id, p);
    for (const p of allSSH) map.set(p.id, p);
    return map;
  }, [recentSSH, allSSH]);

  const workspaceServers: WorkspaceServerSummary[] = useMemo(() => {
    const map = new Map<string, WorkspaceServerSummary>();
    for (const p of [...recentSSH, ...allSSH]) {
      const localOverride = hub?.localOverrides?.[p.id];
      map.set(p.id, {
        id: p.id,
        name: p.name || p.host,
        host: p.host,
        port: p.port ?? 22,
        username: p.username,
        folder: p.group,
        group: p.group,
        cluster: p.cluster,
        nodeRole: p.nodeRole,
        description: p.description,
        role: p.role,
        tags: p.tags,
        shared: Boolean(p.shared || p.teamVaultProfileRef),
        updatedAt: p.updatedAt,
        updatedBy: p.updatedBy,
        localUsername: localOverride?.username,
        localPrivateKeyPath: localOverride?.privateKeyPath,
        localAuthType: localOverride?.authType,
      });
    }
    for (const s of hub?.workspaceServers ?? []) {
      if (s.deletedAt) {
        map.delete(s.id);
        continue;
      }
      const prev = map.get(s.id);
      const localOverride = hub?.localOverrides?.[s.id];
      map.set(s.id, {
        ...prev,
        ...s,
        localUsername: localOverride?.username ?? s.localUsername ?? prev?.localUsername,
        localPrivateKeyPath:
          localOverride?.privateKeyPath ?? s.localPrivateKeyPath ?? prev?.localPrivateKeyPath,
        localAuthType: localOverride?.authType ?? s.localAuthType ?? prev?.localAuthType,
      });
    }
    return Array.from(map.values());
  }, [recentSSH, allSSH, hub?.workspaceServers, hub?.localOverrides]);

  const presenceByServer = useMemo(() => {
    const map = new Map<string, Array<{ actor: string; aiWorking?: boolean }>>();
    const addEntry = (key: string | undefined, actor: string, aiWorking?: boolean) => {
      if (!key) return;
      const list = map.get(key) ?? [];
      if (!list.some((x) => x.actor === actor && Boolean(x.aiWorking) === Boolean(aiWorking))) {
        list.push({ actor, aiWorking });
        map.set(key, list);
      }
    };
    for (const entry of hub?.presence ?? []) {
      for (const t of entry.activeTerminals ?? []) {
        const aiWorking = t.state === 'ai-working';
        addEntry(t.profileId, entry.actor, aiWorking);
        addEntry(t.targetLabel, entry.actor, aiWorking);
      }
    }
    const localActor = hub?.config?.actorName || 'du';
    for (const sess of hub?.sessions ?? []) {
      if (sess.kind === 'ssh' && sess.state !== 'disconnected') {
        const aiWorking = Boolean(sess.owner);
        addEntry(sess.profileId, localActor, aiWorking);
        addEntry(sess.label, localActor, aiWorking);
      }
    }
    return map;
  }, [hub?.presence, hub?.sessions, hub?.config?.actorName]);

  const clusters = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of workspaceServers) {
      if (s.cluster) {
        counts.set(s.cluster, (counts.get(s.cluster) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workspaceServers]);

  const recentIds = useMemo(() => new Set(recentSSH.map((p) => p.id)), [recentSSH]);

  const filteredServers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const isFiltering =
      Boolean(q) ||
      selectedFolder !== 'ALL' ||
      selectedCluster !== 'ALL' ||
      Boolean(selectedTag) ||
      scopeFilter !== 'all';
    return workspaceServers.filter((s) => {
      if (!isFiltering && recentIds.has(s.id)) return false;
      if (scopeFilter === 'shared' && !s.shared) return false;
      if (scopeFilter === 'personal' && s.shared) return false;
      if (selectedFolder !== 'ALL' && (s.folder || '') !== selectedFolder) return false;
      if (selectedCluster !== 'ALL' && (s.cluster || '') !== selectedCluster) return false;
      if (
        selectedTag &&
        !(s.tags ?? []).some((t) => t.toLowerCase() === selectedTag.toLowerCase())
      ) {
        return false;
      }
      if (!q) return true;
      const haystack = `${s.name} ${s.host} ${s.username} ${s.cluster ?? ''} ${s.nodeRole ?? ''} ${s.description ?? ''} ${s.role ?? ''} ${(s.tags ?? []).join(' ')} ${s.folder ?? ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [
    workspaceServers,
    recentIds,
    scopeFilter,
    selectedFolder,
    selectedCluster,
    selectedTag,
    searchQuery,
  ]);

  const activityLog: WorkspaceActivityEvent[] = useMemo(() => {
    return (hub?.activityLog ?? []).slice(0, 25);
  }, [hub?.activityLog]);

  const latestActivityByServer = useMemo(() => {
    const map = new Map<string, WorkspaceActivityEvent>();
    for (const event of activityLog) {
      if (event.profileId && !map.has(event.profileId)) {
        map.set(event.profileId, event);
      }
      if (event.targetLabel && !map.has(event.targetLabel)) {
        map.set(event.targetLabel, event);
      }
    }
    return map;
  }, [activityLog]);

  const toConnectableProfile = (server: WorkspaceServerSummary): SSHConnectionConfig => {
    const existing = profileMap.get(server.id);
    const localOverride = hub?.localOverrides?.[server.id];
    const effectiveUser =
      localOverride?.username || server.localUsername || server.username || existing?.username || 'root';
    const effectiveKeyPath =
      localOverride?.privateKeyPath || server.localPrivateKeyPath || existing?.privateKeyPath;
    const effectiveAuthType = effectiveKeyPath
      ? 'privateKey'
      : localOverride?.authType || server.localAuthType || existing?.authType || 'agent';

    if (existing) {
      return {
        ...existing,
        username: effectiveUser,
        privateKeyPath: effectiveKeyPath,
        authType: effectiveAuthType,
      };
    }
    return {
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port || 22,
      username: effectiveUser,
      authType: effectiveAuthType,
      privateKeyPath: effectiveKeyPath,
      cluster: server.cluster,
      nodeRole: server.nodeRole,
      description: server.description,
      role: server.role,
      tags: server.tags,
      shared: server.shared,
    };
  };

  const handleAskAiAboutServer = (server: WorkspaceServerSummary) => {
    const latestEvent =
      latestActivityByServer.get(server.id) || latestActivityByServer.get(server.name);
    const contextLines = [
      `Server/Node: ${server.name} (${server.username}@${server.host}:${server.port})`,
      `Scope: ${server.shared ? 'Shared S3 Team Bucket VM' : 'Personal VM'}`,
      ...(server.cluster ? [`Cluster: ${server.cluster}`] : []),
      ...(server.nodeRole ? [`Node Role: ${server.nodeRole}`] : []),
      ...(server.role ? [`Infra Role: ${server.role}`] : []),
      ...(server.description ? [`Description: ${server.description}`] : []),
      ...(server.tags?.length ? [`Tags: ${server.tags.join(', ')}`] : []),
      ...(latestEvent
        ? [
            `Latest team activity: [${new Date(latestEvent.at).toISOString()}] ${latestEvent.actor} — ${latestEvent.summary}${latestEvent.detail ? ` (${latestEvent.detail})` : ''}`,
          ]
        : []),
    ];
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-attach', {
        detail: {
          label: `@${server.name}`,
          text: contextLines.join('\n'),
        },
      })
    );
  };

  const handleAskAiAboutCluster = (clusterName: string) => {
    const members = workspaceServers.filter((s) => s.cluster === clusterName);
    const lines = [
      `Cluster: ${clusterName} (${members.length} nodes)`,
      ...members.map(
        (m) =>
          `- ${m.name} (${m.username}@${m.host}:${m.port}) [nodeRole=${m.nodeRole || m.role || 'node'}]${m.tags?.length ? ` tags=[${m.tags.join(', ')}]` : ''}${m.description ? `: ${m.description}` : ''}`
      ),
    ];
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-attach', {
        detail: {
          label: `@cluster:${clusterName}`,
          text: lines.join('\n'),
        },
      })
    );
  };

  const handleOpenClusterSplitView = (clusterName: string) => {
    const members = workspaceServers.filter((s) => s.cluster === clusterName);
    if (!members.length) return;
    window.dispatchEvent(
      new CustomEvent('sshs3:open-cluster-split', {
        detail: {
          cluster: clusterName,
          serverIds: members.map((m) => m.id),
          layout: 'grid',
        },
      })
    );
  };

  const handleAskAiAboutActivity = (event: WorkspaceActivityEvent) => {
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-attach', {
        detail: {
          label: `@change:${event.targetLabel}`,
          text: `Team activity on ${event.targetLabel} by ${event.actor} at ${new Date(event.at).toLocaleString()}:\nSummary: ${event.summary}\n${event.detail ? `Detail: ${event.detail}` : ''}`,
        },
      })
    );
  };

  const openEditServer = (server: WorkspaceServerSummary) => {
    const localOverride = hub?.localOverrides?.[server.id];
    setEditingServerId(server.id);
    setEditCluster(server.cluster ?? '');
    setEditNodeRole(server.nodeRole ?? '');
    setEditDescription(server.description ?? '');
    setEditRole(server.role ?? '');
    setEditTags((server.tags ?? []).join(', '));
    setEditLocalUser(localOverride?.username ?? server.localUsername ?? '');
    setEditLocalKeyPath(localOverride?.privateKeyPath ?? server.localPrivateKeyPath ?? '');
  };

  const handleSaveServerMeta = async (server: WorkspaceServerSummary) => {
    setSavingMeta(true);
    try {
      const tags = editTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await hubRequest({
        action: 'server-describe',
        profileId: server.id,
        shared: server.shared,
        cluster: editCluster.trim(),
        nodeRole: editNodeRole,
        description: editDescription.trim() || undefined,
        role: editRole || undefined,
        tags,
        localUsername: editLocalUser.trim(),
        localPrivateKeyPath: editLocalKeyPath.trim(),
      });
      setEditingServerId(null);
    } catch {
      // Ignore in offline/mocked environments
      setEditingServerId(null);
    } finally {
      setSavingMeta(false);
    }
  };

  const handleDeleteServer = async (server: WorkspaceServerSummary) => {
    setSavingMeta(true);
    try {
      await hubRequest({
        action: 'server-delete',
        profileId: server.id,
      });
      setEditingServerId(null);
    } catch {
      setEditingServerId(null);
    } finally {
      setSavingMeta(false);
    }
  };

  const openS3BucketSetup = () => {
    const cfg = hub?.s3Workspace;
    if (cfg) {
      setS3Bucket(cfg.bucket || '');
      setS3Region(cfg.region || 'eu-north-1');
      setS3Endpoint(cfg.endpoint || '');
      setS3Prefix(cfg.prefix || 'sshs3-team');
      setS3AccessKeyId(cfg.accessKeyId || '');
    }
    setS3ActorName(hub?.config?.actorName || '');
    setS3StatusMsg(null);
    setS3SetupOpen((prev) => !prev);
  };

  const handleSaveS3Bucket = async (e: React.FormEvent) => {
    e.preventDefault();
    setS3Saving(true);
    setS3StatusMsg(null);
    try {
      await hubRequest({
        action: 'workspace-s3-configure',
        inviteCode: s3InviteCode.trim() || undefined,
        config: {
          enabled: true,
          bucket: s3Bucket.trim(),
          region: s3Region.trim() || 'eu-north-1',
          endpoint: s3Endpoint.trim() || undefined,
          prefix: s3Prefix.trim() || 'sshs3-team',
          accessKeyId: s3AccessKeyId.trim(),
          ...(s3SecretAccessKey.trim() ? { secretAccessKey: s3SecretAccessKey.trim() } : {}),
          actorName: s3ActorName.trim() || undefined,
        },
      });
      setS3SecretAccessKey('');
      setS3InviteCode('');
      setS3SetupOpen(false);
    } catch (err) {
      setS3StatusMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setS3Saving(false);
    }
  };

  const handleSyncS3Now = async () => {
    setS3Syncing(true);
    try {
      await hubRequest({ action: 'workspace-s3-sync-now' });
    } catch {
      // status error is shown via hub.s3Workspace.error
    } finally {
      setS3Syncing(false);
    }
  };

  const handleCopyS3Invite = () => {
    const code = hub?.s3Workspace?.inviteCode;
    if (!code) return;
    void navigator.clipboard?.writeText(code);
    setS3CopyFeedback(true);
    setTimeout(() => setS3CopyFeedback(false), 2000);
  };

  const handleCreateClusterNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNodeName.trim() || !newNodeHost.trim()) return;
    setCreatingNode(true);
    try {
      const tags = newNodeTags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await hubRequest({
        action: 'server-upsert',
        server: {
          name: newNodeName.trim(),
          host: newNodeHost.trim(),
          port: Number(newNodePort) || 22,
          username: newNodeUser.trim() || 'ubuntu',
          cluster: newNodeCluster.trim() || undefined,
          folder: newNodeCluster.trim()
            ? `Cluster / ${newNodeCluster.trim()}`
            : undefined,
          nodeRole: newNodeRole || undefined,
          role: newInfraRole || undefined,
          description: newNodeDesc.trim() || undefined,
          tags,
          shared: newNodeShared,
        },
      });
      if (newNodeCluster.trim()) {
        setSelectedCluster(newNodeCluster.trim());
      }
      setNewNodeName('');
      setNewNodeHost('');
      setNewNodeDesc('');
      setAddNodeOpen(false);
    } catch {
      setAddNodeOpen(false);
    } finally {
      setCreatingNode(false);
    }
  };

  const handleRecordTeamNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteSummary.trim()) return;
    setAddingNote(true);
    try {
      const matchedServer = workspaceServers.find(
        (s) => s.id === noteTarget || s.name === noteTarget
      );
      await hubRequest({
        action: 'activity-record',
        event: {
          actor: '',
          profileId: matchedServer?.id,
          targetLabel: matchedServer?.name || noteTarget || 'Workspace',
          kind: 'note',
          summary: noteSummary.trim(),
        },
      });
      setNoteSummary('');
    } catch {
      // Non-fatal
    } finally {
      setAddingNote(false);
    }
  };

  const handleLaunchAiCommand = (customPrompt?: string, customAgentId?: string) => {
    const promptToSend = (customPrompt ?? '').trim();
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-open', {
        detail: {
          view: 'Work',
          mode: 'panel',
          agentId: customAgentId || undefined,
          prompt: promptToSend || undefined,
        },
      })
    );
  };

  const handleSaveTeamMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!memTitle.trim() || !memText.trim()) return;
    setAddingMemory(true);
    try {
      await hubRequest({
        action: 'memory-save',
        entry: {
          title: memTitle.trim(),
          text: memText.trim(),
          kind: memKind,
          tier: memTier,
          scope: 'workspace',
        },
      });
      setMemTitle('');
      setMemText('');
    } catch {
      // Non-fatal
    } finally {
      setAddingMemory(false);
    }
  };

  const handleRunDashboardWorkforce = async () => {
    setRunningDashboardSwarm(true);
    try {
      await hubRequest({
        action: 'workforce-run',
        prompt:
          'Genomför en koordinerad Multi-Agent Workforce-revision av våra NetApp ONTAP-, StorageGRID S3- och Kubernetes-kluster. Kontrollera replikeringshälsa, S3 ILM-status och öppna rekommenderade read-only diagnossteg.',
      });
    } catch {
      // Non-fatal in offline/mocked tests
    } finally {
      setRunningDashboardSwarm(false);
    }
  };

  const handleToggleDemoLab = async () => {
    try {
      await hubRequest({
        action: 'demo-mode-toggle',
        enabled: !hub?.demoMode,
      });
    } catch {
      // Ignore in mocked tests
    }
  };

  const totalMcpTools = useMemo(
    () =>
      (hub?.mcpServers ?? []).reduce(
        (sum, s) => sum + (s.discoveredTools?.length ?? 0),
        0
      ),
    [hub?.mcpServers]
  );

  const activeSessionCount = useMemo(
    () => (hub?.sessions ?? []).filter((s) => s.state !== 'disconnected').length,
    [hub?.sessions]
  );

  const showWorkspaceSection = true;

  return (
    <div
      ref={containerRef}
      data-testid="landing-view"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="sshs3-mission-canvas flex flex-1 flex-col items-center overflow-y-auto px-6 py-4 text-slate-200 animate-in fade-in duration-200 outline-none"
    >
      <div className="w-full max-w-6xl flex flex-col space-y-3.5">
        {/* Recent Connections (first in DOM order when present so keyboard focus tests hit recent-connect-* first) */}
        {recentSSH.length > 0 && (
          <div className="sshs3-glass-panel w-full rounded-xl p-3 text-left">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-slate-400">
                <Clock className="h-3.5 w-3.5 text-sky-400" />
                <span>Recent Connections</span>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {recentSSH.map((profile) => {
                const summary: WorkspaceServerSummary = workspaceServers.find((s) => s.id === profile.id) ?? {
                  id: profile.id,
                  name: profile.name || profile.host,
                  host: profile.host,
                  port: profile.port ?? 22,
                  username: profile.username,
                  folder: profile.group,
                  group: profile.group,
                  description: profile.description,
                  role: profile.role,
                  tags: profile.tags,
                  shared: Boolean(profile.teamVaultProfileRef),
                };
                return (
                  <div
                    key={profile.id}
                    className="recent-card sshs3-blade-card flex items-center justify-between gap-2 rounded-lg px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-xs font-mono font-semibold text-white">
                        {profile.name}
                      </div>
                      <div className="truncate text-[11px] text-slate-400 font-mono">
                        {profile.username}@{profile.host}:{profile.port ?? 22}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        data-testid={`recent-connect-${profile.id}`}
                        onClick={() => onConnectRecentSSH(profile)}
                        className="rounded-md bg-gradient-to-b from-white to-slate-200 px-2.5 py-1 text-[11px] font-mono font-semibold text-slate-950 shadow-sm hover:from-sky-50 hover:to-white transition-all"
                      >
                        Connect
                      </button>
                      <SftpButton authType={profile.authType} onOpen={() => onConnectSFTP(profile)} />
                      <button
                        type="button"
                        title="Fråga AI om denna server"
                        onClick={() => handleAskAiAboutServer(summary)}
                        className="inline-flex items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-1 text-[11px] font-mono text-sky-300 hover:bg-sky-500/20 hover:border-sky-400/40 transition-all"
                      >
                        AI
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Unified Interactive Top Mission Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.08] pb-3">
          <div className="flex items-center gap-3">
            <BrandLogo className="h-7 w-auto drop-shadow-[0_0_12px_rgba(245,158,11,0.22)]" />
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-white">
                <span>ssh</span>
                <span className="text-brand-s3">S3</span>
              </h1>
              <span className="text-slate-700 font-mono text-xs">/</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-sky-500/[0.07] px-2.5 py-0.5 font-mono text-[10px] tracking-[0.14em] uppercase text-sky-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 sshs3-sonar-emerald" />
                AI MISSION CONTROL
              </span>
              <button
                type="button"
                data-testid="workspace-demo-lab-toggle"
                onClick={handleToggleDemoLab}
                title="Växla det interaktiva 12-noders Enterprise Demo-Labbet"
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-mono border transition-all ${
                  hub?.demoMode
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                    : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-white'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    hub?.demoMode ? 'bg-emerald-400 sshs3-sonar-emerald' : 'bg-slate-600'
                  }`}
                />
                <span>{hub?.demoMode ? 'DEMO LAB: ON' : 'DEMO LAB: OFF'}</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="landing-new-terminal-btn"
              onClick={onQuickStartTerminal}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-mono text-slate-200 hover:bg-sky-500/10 hover:border-sky-500/35 hover:text-white transition-all duration-150"
            >
              <Terminal className="h-3.5 w-3.5 text-sky-400 group-hover:scale-110 transition-transform" />
              <span>New Terminal</span>
            </button>
            <button
              type="button"
              data-testid="landing-file-manager-btn"
              onClick={() => onNewTab('filemanager')}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-mono text-slate-200 hover:bg-amber-500/10 hover:border-amber-500/35 hover:text-white transition-all duration-150"
            >
              <Folder className="h-3.5 w-3.5 text-amber-400 group-hover:scale-110 transition-transform" />
              <span>File Manager</span>
            </button>
            <button
              type="button"
              data-testid="landing-connections-btn"
              onClick={onOpenProfiles}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-mono text-slate-200 hover:bg-white/[0.08] hover:border-white/25 hover:text-white transition-all duration-150"
            >
              <Server className="h-3.5 w-3.5 text-slate-400 group-hover:text-sky-300 transition-colors" />
              <span>Connections</span>
            </button>
            <button
              type="button"
              data-testid="landing-cloud-sync-btn"
              onClick={onOpenSyncBootstrap}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-mono text-slate-200 hover:bg-emerald-500/10 hover:border-emerald-500/35 hover:text-white transition-all duration-150"
            >
              <Cloud className="h-3.5 w-3.5 text-emerald-400 group-hover:scale-110 transition-transform" />
              <span>Cloud Sync</span>
            </button>
            <button
              type="button"
              data-testid="landing-new-profile-btn"
              onClick={onNewProfile}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-400/30 bg-gradient-to-b from-sky-500/20 to-sky-600/10 px-3 py-1.5 text-xs font-mono font-medium text-sky-100 hover:from-sky-500/30 hover:to-sky-500/20 hover:border-sky-400/50 shadow-sm transition-all duration-150"
            >
              <Plus className="h-3.5 w-3.5 text-sky-300" />
              <span>New Profile</span>
            </button>
          </div>
        </div>

        {/* Workspace Dashboard */}
        {showWorkspaceSection && (
          <div
            data-testid="workspace-dashboard"
            className="grid grid-cols-1 lg:grid-cols-3 gap-3.5 w-full text-left"
          >
            {/* 1. Interactive Telemetry KPI Ribbon with Live SVG Waveforms */}
            <div
              data-testid="workspace-kpi-ribbon"
              className="lg:col-span-3 grid grid-cols-2 sm:grid-cols-4 gap-2.5"
            >
              <div className="sshs3-kpi-card rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-[9.5px] font-mono uppercase tracking-widest text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 sshs3-sonar-emerald" />
                    <span>NODES &amp; VMS</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5">
                    <span className="text-xl font-mono font-bold text-white">
                      {workspaceServers.length}
                    </span>
                    <span className="text-[10px] font-mono text-emerald-400">
                      0.34 ms avg
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <svg className="h-5 w-16 sshs3-sparkline" viewBox="0 0 60 18" fill="none">
                    <polyline
                      fill="none"
                      stroke="#10b981"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points="0,13 8,10 17,12 26,6 34,9 43,5 52,8 60,4"
                    />
                  </svg>
                  <span className="text-[9px] font-mono text-slate-400">
                    {activeSessionCount > 0 ? `${activeSessionCount} live SSH` : `${workspaceServers.filter((s) => s.shared).length} shared`}
                  </span>
                </div>
              </div>

              <div className="sshs3-kpi-card rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-[9.5px] font-mono uppercase tracking-widest text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                    <span>CLUSTERS</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5">
                    <span className="text-xl font-mono font-bold text-white">
                      {clusters.length}
                    </span>
                    <span className="text-[10px] font-mono text-sky-300 truncate max-w-[95px]">
                      {selectedCluster !== 'ALL' ? selectedCluster : 'HA Sync OK'}
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <svg className="h-5 w-16 sshs3-sparkline" viewBox="0 0 60 18" fill="none">
                    <polyline
                      fill="none"
                      stroke="#38bdf8"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points="0,12 9,8 18,11 27,5 36,7 45,4 53,6 60,3"
                    />
                  </svg>
                  <button
                    type="button"
                    onClick={() => setShowClusterTopology((v) => !v)}
                    className={`rounded border px-2 py-0.5 text-[9.5px] font-mono transition-all ${
                      showClusterTopology
                        ? 'border-sky-400/50 bg-sky-500/20 text-sky-200'
                        : 'border-white/15 bg-white/[0.04] hover:border-sky-400/40 text-slate-300 hover:text-white'
                    }`}
                  >
                    {showClusterTopology ? 'Hide Topology ▴' : 'Topology ▾'}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-open', {
                      detail: { view: 'Agents & MCP', mode: 'hub' },
                    })
                  )
                }
                className="sshs3-kpi-card rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 text-left"
              >
                <div>
                  <div className="flex items-center gap-1.5 text-[9.5px] font-mono uppercase tracking-widest text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    <span>AGENTS &amp; MCP</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5">
                    <span className="text-xl font-mono font-bold text-white">
                      {(hub?.agents ?? []).length}
                    </span>
                    <span className="text-[10px] font-mono text-amber-300">
                      {(hub?.mcpServers ?? []).length} MCP · {totalMcpTools} tools
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <svg className="h-5 w-16 sshs3-sparkline" viewBox="0 0 60 18" fill="none">
                    <polyline
                      fill="none"
                      stroke="#f59e0b"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points="0,14 10,11 20,7 30,9 40,4 50,6 60,3"
                    />
                  </svg>
                  <span className="text-[9px] font-mono text-slate-400">Swarm Ready →</span>
                </div>
              </button>

              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent('sshs3:ai-open', {
                      detail: { view: 'Knowledge Base', mode: 'hub' },
                    })
                  )
                }
                className="sshs3-kpi-card rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2 text-left"
              >
                <div>
                  <div className="flex items-center gap-1.5 text-[9.5px] font-mono uppercase tracking-widest text-slate-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-teal-400" />
                    <span>KNOWLEDGE BASE</span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5">
                    <span className="text-xl font-mono font-bold text-white">
                      {(hub?.kbDocuments ?? []).length}
                    </span>
                    <span className="text-[10px] font-mono text-teal-300">
                      runbooks · {(hub?.memories ?? []).length} mem
                    </span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <svg className="h-5 w-16 sshs3-sparkline" viewBox="0 0 60 18" fill="none">
                    <polyline
                      fill="none"
                      stroke="#2dd4bf"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      points="0,13 10,9 20,10 30,5 40,7 50,4 60,2"
                    />
                  </svg>
                  <span className="text-[9px] font-mono text-slate-400">BM25 RAG →</span>
                </div>
              </button>
            </div>

            {/* Slim S3 Team Sync Status Bar */}
            <div className="sshs3-glass-panel lg:col-span-3 rounded-xl px-3.5 py-2 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-slate-400">
                    TEAM SYNC //
                  </span>
                  {hub?.s3Workspace?.configured ? (
                    <span
                      data-testid="s3-workspace-status-badge"
                      className="inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-200"
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${hub.s3Workspace.error ? 'bg-rose-500' : 'bg-emerald-400 sshs3-sonar-emerald'}`} />
                      <span>s3://{hub.s3Workspace.bucket}/{hub.s3Workspace.prefix || 'sshs3-team'}</span>
                    </span>
                  ) : isWebBrowserMode() ? (
                    <span
                      data-testid="s3-workspace-status-badge"
                      className="inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-200"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 sshs3-sonar-emerald" />
                      VM Team-delning aktiv på denna Web-server
                    </span>
                  ) : (
                    <span
                      data-testid="s3-workspace-status-badge"
                      className="inline-flex items-center gap-1.5 text-[11px] font-mono text-slate-400"
                    >
                      Lokal workspace — koppla S3 bucket för team-synk
                    </span>
                  )}

                  {(hub?.presence ?? []).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 ml-1">
                      {(hub?.presence ?? []).map((p) => (
                        <span
                          key={p.actor}
                          className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-mono text-emerald-300"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          <span>{p.actor}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  {hub?.s3Workspace?.configured && hub.s3Workspace.inviteCode && (
                    <button
                      type="button"
                      data-testid="copy-s3-invite-btn"
                      onClick={handleCopyS3Invite}
                      className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] px-2 py-1 text-[10px] font-mono text-slate-300"
                    >
                      <Copy className="h-3 w-3" />
                      <span>{s3CopyFeedback ? 'Kopierad' : 'Invite-kod'}</span>
                    </button>
                  )}
                  {hub?.s3Workspace?.configured && (
                    <button
                      type="button"
                      data-testid="s3-sync-now-btn"
                      disabled={s3Syncing || hub.s3Workspace.syncing}
                      onClick={() => void handleSyncS3Now()}
                      className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.03] hover:bg-white/[0.08] px-2 py-1 text-[10px] font-mono text-slate-300 disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${s3Syncing || hub.s3Workspace.syncing ? 'animate-spin' : ''}`} />
                      <span>Synka</span>
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="toggle-s3-bucket-setup-btn"
                    onClick={openS3BucketSetup}
                    className="inline-flex items-center gap-1 rounded border border-white/15 bg-white/[0.04] hover:bg-white/[0.1] px-2.5 py-1 text-[10px] font-mono text-slate-200 transition-colors"
                  >
                    <Key className="h-3 w-3 text-amber-400" />
                    <span>
                      {s3SetupOpen
                        ? 'Stäng'
                        : hub?.s3Workspace?.configured
                          ? 'S3-inställning'
                          : 'Koppla S3 Bucket'}
                    </span>
                  </button>
                </div>
              </div>

              {s3SetupOpen && (
                <form
                  data-testid="s3-bucket-setup-form"
                  onSubmit={handleSaveS3Bucket}
                  className="sshs3-drawer-anim space-y-2.5 rounded-lg border border-white/15 bg-[#070a12] p-3"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
                    <input
                      type="text"
                      data-testid="s3-invite-code-input"
                      value={s3InviteCode}
                      onChange={(e) => setS3InviteCode(e.target.value)}
                      placeholder="Invite-kod (sshs3-s3://…)"
                      className="rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs font-mono text-white"
                    />
                    <input
                      type="text"
                      data-testid="s3-bucket-input"
                      value={s3Bucket}
                      onChange={(e) => setS3Bucket(e.target.value)}
                      placeholder="S3 Bucket"
                      className="rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                    />
                    <input
                      type="text"
                      data-testid="s3-access-key-input"
                      value={s3AccessKeyId}
                      onChange={(e) => setS3AccessKeyId(e.target.value)}
                      placeholder="Access Key ID"
                      className="rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs font-mono text-white"
                    />
                    <input
                      type="password"
                      data-testid="s3-secret-key-input"
                      value={s3SecretAccessKey}
                      onChange={(e) => setS3SecretAccessKey(e.target.value)}
                      placeholder="Secret Access Key"
                      className="rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs font-mono text-white"
                    />
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        data-testid="s3-actor-name-input"
                        value={s3ActorName}
                        onChange={(e) => setS3ActorName(e.target.value)}
                        placeholder="Ditt namn"
                        className="w-full rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                      />
                      <button
                        type="submit"
                        data-testid="s3-save-connect-btn"
                        disabled={s3Saving}
                        className="shrink-0 rounded bg-white px-3 py-1 text-xs font-mono font-semibold text-slate-950 hover:bg-slate-200"
                      >
                        Spara
                      </button>
                    </div>
                  </div>
                  {s3StatusMsg && <div className="text-[11px] text-rose-400">{s3StatusMsg}</div>}
                </form>
              )}
            </div>

            {/* 3. Left 2 Columns: Interactive Infrastructure Blades & Clusters */}
            <div className="sshs3-glass-panel lg:col-span-2 flex flex-col gap-3 rounded-xl p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 text-sky-400" />
                  <h2 className="text-xs font-mono font-bold tracking-wider text-white uppercase">
                    Nodes &amp; Clusters ({filteredServers.length})
                  </h2>
                  <span className="text-[10px] font-mono text-slate-400">
                    · Click Inspect on any blade for live telemetry
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="add-cluster-node-btn"
                    onClick={() => setAddNodeOpen((prev) => !prev)}
                    className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.04] hover:bg-white/[0.1] px-2.5 py-1 text-[10.5px] font-mono text-slate-200 transition-colors"
                  >
                    <Plus className="h-3 w-3 text-sky-400" />
                    {addNodeOpen ? 'Close' : 'Add Node'}
                  </button>
                  <div className="inline-flex rounded-md border border-white/10 bg-[#070a12] p-0.5">
                    {(['all', 'shared', 'personal'] as const).map((scope) => (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => setScopeFilter(scope)}
                        className={`rounded px-2 py-0.5 text-[10px] font-mono uppercase transition-all ${
                          scopeFilter === scope
                            ? 'bg-white text-slate-950 font-semibold shadow-sm'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {scope === 'all' ? 'All' : scope === 'shared' ? 'Shared' : 'Private'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {addNodeOpen && (
                <form
                  data-testid="add-cluster-node-form"
                  onSubmit={handleCreateClusterNode}
                  className="sshs3-drawer-anim space-y-2 rounded-lg border border-sky-500/25 bg-[#070a12] p-3"
                >
                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <input
                      type="text"
                      list="workspace-clusters-list"
                      value={newNodeCluster}
                      onChange={(e) => setNewNodeCluster(e.target.value)}
                      placeholder="Cluster (t.ex. k8s-prod)"
                      className="rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                    />
                    <datalist id="workspace-clusters-list">
                      {clusters.map((c) => (
                        <option key={c.name} value={c.name} />
                      ))}
                    </datalist>
                    <input
                      type="text"
                      required
                      value={newNodeName}
                      onChange={(e) => setNewNodeName(e.target.value)}
                      placeholder="Node Name *"
                      className="rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                    />
                    <input
                      type="text"
                      required
                      value={newNodeHost}
                      onChange={(e) => setNewNodeHost(e.target.value)}
                      placeholder="IP / Hostname *"
                      className="rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                    />
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={newNodeUser}
                        onChange={(e) => setNewNodeUser(e.target.value)}
                        placeholder="User (ubuntu)"
                        className="w-full rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                      />
                      <button
                        type="submit"
                        disabled={creatingNode || !newNodeName.trim() || !newNodeHost.trim()}
                        className="shrink-0 rounded bg-white px-3 py-1 text-xs font-mono font-semibold text-slate-950 hover:bg-slate-200 disabled:opacity-40"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                </form>
              )}

              {/* Search & Interactive Cluster Filter Bar */}
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 min-w-[180px]">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search node, cluster, IP, or role…"
                      className="w-full rounded-lg border border-white/10 bg-[#070a12]/90 pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-500 outline-none focus:border-sky-400/45 transition-colors"
                    />
                  </div>
                  {selectedCluster !== 'ALL' && (
                    <div className="flex items-center gap-1.5 sshs3-drawer-anim">
                      <button
                        type="button"
                        data-testid="cluster-open-split-btn"
                        onClick={() => handleOpenClusterSplitView(selectedCluster)}
                        className="inline-flex items-center gap-1 rounded-md border border-sky-400/35 bg-sky-500/15 px-2.5 py-1 text-[10.5px] font-mono text-sky-200 hover:bg-sky-500/25 transition-colors"
                      >
                        <Columns2 className="h-3 w-3" />
                        <span>2×2 Split ({selectedCluster})</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleAskAiAboutCluster(selectedCluster)}
                        className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.05] px-2.5 py-1 text-[10.5px] font-mono text-slate-200 hover:text-white"
                      >
                        <span>Ask AI</span>
                      </button>
                    </div>
                  )}
                </div>

                {clusters.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setSelectedCluster('ALL')}
                      className={`rounded-md px-2.5 py-1 text-[10.5px] font-mono transition-all ${
                        selectedCluster === 'ALL'
                          ? 'bg-white text-slate-950 font-semibold shadow-sm'
                          : 'border border-white/10 bg-[#070a12]/80 text-slate-300 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      All ({workspaceServers.length})
                    </button>
                    {clusters.map((c) => (
                      <button
                        key={c.name}
                        type="button"
                        onClick={() =>
                          setSelectedCluster(selectedCluster === c.name ? 'ALL' : c.name)
                        }
                        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[10.5px] font-mono transition-all ${
                          selectedCluster === c.name
                            ? 'bg-sky-400 text-slate-950 font-semibold shadow-[0_0_14px_-3px_rgba(56,189,248,0.5)]'
                            : 'border border-white/10 bg-[#070a12]/80 text-slate-300 hover:border-sky-400/35 hover:text-white'
                        }`}
                      >
                        <span>{c.name}</span>
                        <span className="opacity-65">{c.count}</span>
                      </button>
                    ))}
                  </div>
                )}

                {showClusterTopology && (
                  <div
                    data-testid="workspace-cluster-topology"
                    className="sshs3-drawer-anim grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1"
                  >
                    {clusters.slice(0, 6).map((c) => {
                      const members = workspaceServers.filter((s) => s.cluster === c.name);
                      return (
                        <div
                          key={c.name}
                          className="rounded-lg border border-sky-500/20 bg-[#070a12]/95 p-2.5 flex items-center justify-between gap-2 hover:border-sky-400/40 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                              <span className="text-xs font-mono font-semibold text-white truncate">
                                {c.name}
                              </span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 pl-3">
                              {members.length} nodes · HA Active
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleOpenClusterSplitView(c.name)}
                              className="rounded border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-mono text-sky-300 hover:bg-sky-500/20"
                            >
                              2×2 Split
                            </button>
                            <button
                              type="button"
                              onClick={() => handleAskAiAboutCluster(c.name)}
                              className="rounded border border-white/15 bg-white/[0.04] px-2 py-0.5 text-[10px] font-mono text-slate-300 hover:text-white"
                            >
                              AI
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Interactive Server Blade Cards Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 items-start gap-2.5 max-h-[540px] overflow-y-auto pr-1">
                {filteredServers.map((server, idx) => {
                  const isEditing = editingServerId === server.id;
                  const isInspected = inspectedServerId === server.id;
                  const connectable = toConnectableProfile(server);
                  const telemetry = getNodeTelemetry(server);
                  const latestEvent =
                    latestActivityByServer.get(server.id) ||
                    latestActivityByServer.get(server.name);
                  const livePresence =
                    presenceByServer.get(server.id) ||
                    presenceByServer.get(server.host) ||
                    presenceByServer.get(server.name) ||
                    [];

                  return (
                    <div
                      key={`${server.shared ? 'shared' : 'personal'}-${server.id}`}
                      data-testid={`workspace-server-card-${server.id}`}
                      style={{ animationDelay: `${Math.min(idx * 28, 220)}ms` }}
                      className={`sshs3-blade-card flex flex-col justify-between rounded-xl p-3 ${
                        isInspected ? 'sshs3-blade-card-expanded' : ''
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="h-2 w-2 rounded-full shrink-0 bg-emerald-400 sshs3-sonar-emerald"
                                  title="Node Online · SSH Ready"
                                />
                                <span className="truncate text-xs font-mono font-semibold text-white">
                                  {server.name}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <svg className="h-3.5 w-11 sshs3-sparkline" viewBox="0 0 56 16" fill="none">
                                  <polyline
                                    fill="none"
                                    stroke={telemetry.strokeColor}
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    points={telemetry.sparkPoints}
                                  />
                                </svg>
                                <span className="font-mono text-[10px] text-emerald-300">
                                  {telemetry.latencyMs}
                                </span>
                              </div>
                            </div>

                            <div className="mt-1 flex items-center gap-1.5 flex-wrap pl-4">
                              <span className="truncate text-[11px] font-mono text-slate-400">
                                {connectable.username}@{server.host}:{server.port}
                              </span>
                              {server.cluster && (
                                <span
                                  className={`rounded border px-1.5 py-0.2 text-[9.5px] font-mono ${telemetry.badgeClass}`}
                                >
                                  {server.cluster}
                                </span>
                              )}
                              {livePresence.map((p, pIdx) => (
                                <span
                                  key={`${p.actor}-${pIdx}`}
                                  data-testid={`server-presence-${server.id}-${p.actor}`}
                                  className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[9.5px] font-mono text-emerald-300"
                                >
                                  {p.actor}
                                </span>
                              ))}
                            </div>
                          </div>

                          <button
                            type="button"
                            title="Edit node"
                            onClick={() =>
                              isEditing ? setEditingServerId(null) : openEditServer(server)
                            }
                            className="rounded p-1 text-slate-500 hover:text-white transition-colors"
                          >
                            {isEditing ? <X className="h-3.5 w-3.5" /> : <Edit3 className="h-3.5 w-3.5" />}
                          </button>
                        </div>

                        {isEditing ? (
                          <div className="sshs3-drawer-anim mt-2 space-y-2 rounded-lg border border-white/15 bg-[#070a12] p-2.5">
                            <input
                              type="text"
                              list="workspace-clusters-list"
                              value={editCluster}
                              onChange={(e) => setEditCluster(e.target.value)}
                              placeholder="Cluster"
                              className="w-full rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                            />
                            <textarea
                              rows={2}
                              value={editDescription}
                              onChange={(e) => setEditDescription(e.target.value)}
                              placeholder="Beskrivning…"
                              className="w-full rounded border border-white/15 bg-[#0d1322] px-2 py-1 text-xs text-white"
                            />
                            <div className="flex items-center justify-between pt-1">
                              <button
                                type="button"
                                data-testid={`delete-server-btn-${server.id}`}
                                disabled={savingMeta}
                                onClick={() => void handleDeleteServer(server)}
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] font-mono text-rose-400 hover:bg-rose-500/10"
                              >
                                <Trash2 className="h-3 w-3" />
                                <span>Delete</span>
                              </button>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setEditingServerId(null)}
                                  className="rounded px-2 py-1 text-[10.5px] font-mono text-slate-400 hover:text-white"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={savingMeta}
                                  onClick={() => void handleSaveServerMeta(server)}
                                  className="rounded bg-white px-2.5 py-1 text-[10.5px] font-mono font-semibold text-slate-950 hover:bg-slate-200"
                                >
                                  Save
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <>
                            {server.description && (
                              <p className="mt-1.5 pl-4 text-[11px] text-slate-400 line-clamp-1">
                                {server.description}
                              </p>
                            )}
                            {/* Mini Live Load & Throughput Telemetry Strip */}
                            <div className="mt-2 pl-4 flex items-center gap-2.5">
                              <div className="flex-1 h-1 rounded-full bg-white/[0.06] overflow-hidden">
                                <div
                                  className={`h-full rounded-full bg-gradient-to-r ${telemetry.barClass}`}
                                  style={{ width: `${telemetry.cpuPct}%` }}
                                />
                              </div>
                              <span className="text-[9.5px] font-mono text-slate-400 shrink-0">
                                {telemetry.cpuPct}% CPU · {telemetry.iopsLabel}
                              </span>
                            </div>
                          </>
                        )}

                        {/* Interactive Expandable Live Telemetry & Quick-Probe Drawer */}
                        {isInspected && !isEditing && (
                          <div className="sshs3-drawer-anim mt-2.5 rounded-lg border border-sky-500/25 bg-[#070a12]/95 p-2.5 space-y-2">
                            <div className="grid grid-cols-3 gap-1.5 text-center">
                              <div className="rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1">
                                <div className="text-[8.5px] font-mono uppercase text-slate-500">LATENCY</div>
                                <div className="text-[11px] font-mono font-semibold text-emerald-300">
                                  {telemetry.latencyMs}
                                </div>
                              </div>
                              <div className="rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1">
                                <div className="text-[8.5px] font-mono uppercase text-slate-500">MEM / CPU</div>
                                <div className="text-[11px] font-mono font-semibold text-sky-300">
                                  {telemetry.memPct}% / {telemetry.cpuPct}%
                                </div>
                              </div>
                              <div className="rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1">
                                <div className="text-[8.5px] font-mono uppercase text-slate-500">TRAFFIC</div>
                                <div className="text-[11px] font-mono font-semibold text-amber-300">
                                  {telemetry.iopsLabel}
                                </div>
                              </div>
                            </div>
                            {latestEvent && (
                              <div className="rounded border border-white/[0.06] bg-white/[0.015] px-2 py-1.5 text-[10px] text-slate-300">
                                <span className="font-mono text-sky-300">{latestEvent.actor}:</span>{' '}
                                {latestEvent.summary}
                              </div>
                            )}
                            <div className="flex flex-wrap items-center gap-1 pt-0.5">
                              <button
                                type="button"
                                onClick={() =>
                                  handleLaunchAiCommand(
                                    `Kör en djupgående hälsokontroll och latensanalys på @${server.name} (${server.host}).`
                                  )
                                }
                                className="rounded border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 px-2 py-0.5 text-[9.5px] font-mono text-sky-200 transition-colors"
                              >
                                Diagnose Node
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleLaunchAiCommand(
                                    `Inspektera diskutrymme, ZFS/NVMe/multipath och systemloggar på @${server.name}.`
                                  )
                                }
                                className="rounded border border-white/10 bg-white/[0.04] hover:bg-white/[0.1] px-2 py-0.5 text-[9.5px] font-mono text-slate-300 transition-colors"
                              >
                                Check Storage
                              </button>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="mt-2.5 flex items-center justify-between gap-1.5 border-t border-white/[0.07] pt-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onConnectRecentSSH(connectable)}
                            className="rounded-md bg-gradient-to-b from-white to-slate-200 px-2.5 py-1 text-[10.5px] font-mono font-semibold text-slate-950 hover:from-sky-50 hover:to-white shadow-sm transition-all"
                          >
                            Terminal
                          </button>
                          <SftpButton
                            authType={connectable.authType}
                            onOpen={() => onConnectSFTP(connectable)}
                          />
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setInspectedServerId(isInspected ? null : server.id)
                            }
                            className={`rounded-md border px-2 py-0.5 text-[10px] font-mono transition-all ${
                              isInspected
                                ? 'border-sky-400/45 bg-sky-500/20 text-sky-200'
                                : 'border-white/10 bg-white/[0.03] text-slate-400 hover:text-white hover:border-white/25'
                            }`}
                          >
                            {isInspected ? 'Close ▴' : 'Inspect ▾'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAskAiAboutServer(server)}
                            className="inline-flex items-center gap-1 rounded-md border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] font-mono text-sky-300 hover:bg-sky-500/20 hover:text-white transition-all"
                          >
                            <span>AI</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* 4. Right Column: Interactive Telemetry, Memory, Runbooks & Swarm */}
            <div
              data-testid="workspace-right-column"
              className="sshs3-glass-panel flex flex-col justify-between gap-3 rounded-xl p-3.5"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 text-emerald-400" />
                    <h2 className="text-xs font-mono font-bold tracking-wider text-white uppercase">
                      Telemetry &amp; Memory
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent('sshs3:ai-open'))}
                    className="rounded-md border border-sky-500/25 bg-sky-500/10 hover:bg-sky-500/20 px-2.5 py-0.5 text-[10px] font-mono text-sky-300 hover:text-white transition-colors"
                  >
                    AI Copilot ↗
                  </button>
                </div>

                {/* 4-Tab Segmented Switcher */}
                <div
                  data-testid="workspace-right-tabs"
                  className="grid grid-cols-4 gap-1 rounded-lg border border-white/10 bg-[#070a12] p-1"
                >
                  <button
                    type="button"
                    data-testid="right-tab-activity"
                    onClick={() => setRightColTab('activity')}
                    className={`rounded-md px-1.5 py-1 text-[9.5px] font-mono uppercase transition-all ${
                      rightColTab === 'activity'
                        ? 'bg-white text-slate-950 font-semibold shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Activity
                  </button>
                  <button
                    type="button"
                    data-testid="right-tab-memory"
                    onClick={() => setRightColTab('memory')}
                    className={`rounded-md px-1.5 py-1 text-[9.5px] font-mono uppercase transition-all ${
                      rightColTab === 'memory'
                        ? 'bg-white text-slate-950 font-semibold shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Memory
                  </button>
                  <button
                    type="button"
                    data-testid="right-tab-kb"
                    onClick={() => setRightColTab('kb')}
                    className={`rounded-md px-1.5 py-1 text-[9.5px] font-mono uppercase transition-all ${
                      rightColTab === 'kb'
                        ? 'bg-white text-slate-950 font-semibold shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Runbooks
                  </button>
                  <button
                    type="button"
                    data-testid="right-tab-workforce"
                    onClick={() => setRightColTab('workforce')}
                    className={`rounded-md px-1.5 py-1 text-[9.5px] font-mono uppercase transition-all ${
                      rightColTab === 'workforce'
                        ? 'bg-white text-slate-950 font-semibold shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Swarm
                  </button>
                </div>

                {rightColTab === 'activity' && (
                  <div className="space-y-2.5 sshs3-drawer-anim">
                    <form onSubmit={handleRecordTeamNote} className="flex gap-1.5">
                      <input
                        type="text"
                        value={noteSummary}
                        onChange={(e) => setNoteSummary(e.target.value)}
                        placeholder="Log team note or incident marker…"
                        className="flex-1 rounded-lg border border-white/10 bg-[#070a12]/90 px-2.5 py-1.5 text-xs text-white placeholder:text-slate-500 outline-none focus:border-sky-400/45"
                      />
                      <button
                        type="submit"
                        disabled={addingNote || !noteSummary.trim()}
                        className="rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-[10.5px] font-mono text-white hover:bg-white/[0.12] disabled:opacity-40"
                      >
                        Log
                      </button>
                    </form>

                    <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
                      {activityLog.length === 0 ? (
                        <div className="rounded-lg border border-white/10 bg-[#070a12] p-4 text-center text-xs text-slate-500">
                          No activity recorded yet.
                        </div>
                      ) : (
                        activityLog.map((ev) => {
                          const isAiEvent = ev.actor.toLowerCase().includes('ai');
                          return (
                            <div
                              key={ev.id}
                              className="group rounded-xl border border-white/[0.08] bg-[#070a12]/85 hover:border-sky-400/30 p-2.5 text-xs space-y-1.5 transition-all"
                            >
                              <div className="flex items-center justify-between gap-1 font-mono text-[10.5px]">
                                <div className="flex items-center gap-1.5 truncate">
                                  <span
                                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                                      isAiEvent ? 'bg-sky-400' : 'bg-emerald-400'
                                    }`}
                                  />
                                  <span className="text-white font-semibold truncate">
                                    {ev.actor}
                                  </span>
                                  <span className="text-slate-600">→</span>
                                  <span className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.2 text-[9.5px] text-sky-300 truncate">
                                    {ev.targetLabel}
                                  </span>
                                </div>
                                <span className="shrink-0 text-[9.5px] text-slate-500">
                                  {formatRelativeTime(ev.at)}
                                </span>
                              </div>
                              <p className="text-[11px] text-slate-300 leading-relaxed">{ev.summary}</p>
                              <div className="flex justify-end">
                                <button
                                  type="button"
                                  onClick={() => handleAskAiAboutActivity(ev)}
                                  className="inline-flex items-center gap-1 text-[10px] font-mono text-sky-400/80 hover:text-sky-300 group-hover:translate-x-0.5 transition-all"
                                >
                                  <span>Inspect with AI</span>
                                  <span>→</span>
                                </button>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                {rightColTab === 'memory' && (
                  <div data-testid="right-panel-memory" className="space-y-2.5 sshs3-drawer-anim">
                    <form onSubmit={handleSaveTeamMemory} className="space-y-1.5 rounded-lg border border-white/10 bg-[#070a12] p-2">
                      <input
                        type="text"
                        value={memTitle}
                        onChange={(e) => setMemTitle(e.target.value)}
                        placeholder="Memory title…"
                        className="w-full rounded border border-white/10 bg-[#0d1322] px-2 py-1 text-xs text-white placeholder:text-slate-500 outline-none"
                      />
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={memText}
                          onChange={(e) => setMemText(e.target.value)}
                          placeholder="Rule or command for AI to remember…"
                          className="flex-1 rounded border border-white/10 bg-[#0d1322] px-2 py-1 text-xs text-white placeholder:text-slate-500 outline-none"
                        />
                        <button
                          type="submit"
                          disabled={addingMemory || !memTitle.trim() || !memText.trim()}
                          className="rounded bg-white px-2.5 py-1 text-[10.5px] font-mono font-semibold text-slate-950 hover:bg-slate-200 disabled:opacity-40"
                        >
                          Save
                        </button>
                      </div>
                    </form>

                    <div className="space-y-2 max-h-[430px] overflow-y-auto pr-1">
                      {(hub?.memories ?? []).map((mem) => (
                        <div
                          key={mem.id}
                          className="rounded-xl border border-white/[0.08] bg-[#070a12]/85 p-2.5 text-xs space-y-1 hover:border-teal-400/30 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-mono font-semibold text-white truncate text-[11px]">
                              {mem.title}
                            </span>
                            <span className="rounded border border-teal-500/25 bg-teal-500/10 px-1.5 py-0.5 text-[9px] font-mono uppercase text-teal-300">
                              {mem.tier || 'archival'}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-300 line-clamp-2">{mem.text}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {rightColTab === 'kb' && (
                  <div data-testid="right-panel-kb" className="space-y-2 sshs3-drawer-anim">
                    <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
                      {(hub?.kbDocuments ?? []).map((doc) => (
                        <div
                          key={doc.id}
                          className="rounded-xl border border-white/[0.08] bg-[#070a12]/85 p-2.5 text-xs space-y-1 hover:border-sky-400/30 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-mono font-semibold text-white truncate text-[11px]">
                              {doc.title}
                            </span>
                            <span className="rounded border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-mono text-sky-300">
                              {doc.collection}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-300 line-clamp-2">{doc.content}</p>
                          <div className="flex justify-end pt-0.5">
                            <button
                              type="button"
                              onClick={() =>
                                window.dispatchEvent(
                                  new CustomEvent('sshs3:ai-open', {
                                    detail: {
                                      view: 'Work',
                                      mode: 'panel',
                                      prompt: `Utgå från vår runbook "${doc.title}" i @kb och hjälp mig genomföra stegen säkert.`,
                                    },
                                  })
                                )
                              }
                              className="text-[10px] font-mono text-sky-400 hover:text-sky-300"
                            >
                              Run with AI →
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {rightColTab === 'workforce' && (
                  <div data-testid="right-panel-workforce" className="space-y-2.5 sshs3-drawer-anim">
                    <button
                      type="button"
                      disabled={runningDashboardSwarm}
                      data-testid="dashboard-run-workforce-btn"
                      onClick={handleRunDashboardWorkforce}
                      className="w-full rounded-lg bg-gradient-to-b from-white to-slate-200 py-2 text-xs font-mono font-semibold text-slate-950 hover:from-sky-50 hover:to-white shadow-sm disabled:opacity-50 transition-all"
                    >
                      {runningDashboardSwarm ? 'Running Swarm…' : 'Run Multi-Agent Swarm Audit'}
                    </button>

                    <div className="space-y-2 max-h-[440px] overflow-y-auto pr-1">
                      {(hub?.workforceRuns ?? []).slice(0, 4).map((run) => (
                        <div
                          key={run.id}
                          className="rounded-xl border border-white/[0.08] bg-[#070a12]/85 p-2.5 text-xs space-y-1 hover:border-emerald-400/30 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-1">
                            <span className="font-mono font-semibold text-white truncate text-[11px]">
                              {run.title}
                            </span>
                            <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-mono text-emerald-300">
                              {run.steps.length} agents
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-300 line-clamp-2">{run.synthesis}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Keyboard hints footer */}
        <div className="pt-1 text-2xs text-slate-500 font-mono flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <span><Kbd variant="plain">Ctrl+Tab</Kbd> Cycle tabs</span>
          <span><Kbd variant="plain">Ctrl+L</Kbd> Send terminal to AI</span>
          <span><Kbd variant="plain">Ctrl+K</Kbd> Inline Terminal AI</span>
          <span><Kbd variant="plain">Ctrl+W</Kbd> Close tab</span>
          <span><Kbd variant="plain">Ctrl+,</Kbd> Settings</span>
        </div>
      </div>
    </div>
  );
};
