import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  Check,
  Clock,
  Cloud,
  Copy,
  Edit3,
  Folder,
  Key,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shield,
  Sparkles,
  Tag,
  Terminal,
  Trash2,
  Users,
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
}

const ROLE_OPTIONS = [
  { value: '', label: 'Ingen roll vald' },
  { value: 'web', label: 'Web / Frontend' },
  { value: 'database', label: 'Database' },
  { value: 'k8s', label: 'Kubernetes / Cluster' },
  { value: 'proxy', label: 'Proxy / Load Balancer' },
  { value: 'worker', label: 'Worker / Queue' },
  { value: 'bastion', label: 'Bastion / Jump Host' },
  { value: 'storage', label: 'Storage / Backup' },
];

const NODE_ROLE_OPTIONS = [
  { value: '', label: 'Ingen specifik nod-roll' },
  { value: 'control-plane', label: 'Control Plane / Master' },
  { value: 'worker-node', label: 'Worker Node' },
  { value: 'gpu-node', label: 'GPU / AI Node' },
  { value: 'ingress', label: 'Ingress / Edge Proxy' },
  { value: 'primary-db', label: 'Primary Database' },
  { value: 'replica-db', label: 'Replica / Read Node' },
  { value: 'storage-node', label: 'Storage / Ceph / NVMe' },
  { value: 'bastion', label: 'Bastion / Jump Node' },
];

const QUICK_TAG_PRESETS = [
  'k8s',
  'control-plane',
  'worker',
  'gpu-node',
  'nvidia',
  'docker',
  'nginx',
  'postgresql',
  'redis',
  'nvme',
  'prod',
  'staging',
  'wireguard',
];

function roleBadgeStyle(role?: string): string {
  const r = (role || '').toLowerCase();
  if (r.includes('ontap') || r.includes('netapp') || r.includes('svm')) {
    return 'border-sky-500/45 bg-sky-500/15 text-sky-300';
  }
  if (r.includes('storagegrid') || r.includes('minio') || r.includes('s3') || r.includes('ilm')) {
    return 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300';
  }
  if (r.includes('ceph') || r.includes('osd') || r.includes('mon') || r.includes('rados')) {
    return 'border-amber-500/45 bg-amber-500/15 text-amber-300';
  }
  if (r.includes('truenas') || r.includes('zfs') || r.includes('backup') || r.includes('snapmirror')) {
    return 'border-teal-500/45 bg-teal-500/15 text-teal-300';
  }
  if (r.includes('k8s') || r.includes('control-plane') || r.includes('csi') || r.includes('trident')) {
    return 'border-indigo-500/45 bg-indigo-500/15 text-indigo-300';
  }
  if (r.includes('gpu') || r.includes('worker') || r.includes('nvme')) {
    return 'border-purple-500/45 bg-purple-500/15 text-purple-300';
  }
  if (r.includes('bastion') || r.includes('jump')) {
    return 'border-rose-500/45 bg-rose-500/15 text-rose-300';
  }
  if (r.includes('database') || r.includes('db') || r.includes('storage')) {
    return 'border-cyan-500/45 bg-cyan-500/15 text-cyan-300';
  }
  if (r.includes('web') || r.includes('ingress') || r.includes('proxy')) {
    return 'border-blue-500/45 bg-blue-500/15 text-blue-300';
  }
  return 'border-border-subtle bg-app-surface-subtle text-txt-muted';
}

function toggleCommaTag(current: string, tag: string): string {
  const list = current
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const exists = list.some((t) => t.toLowerCase() === tag.toLowerCase());
  const next = exists
    ? list.filter((t) => t.toLowerCase() !== tag.toLowerCase())
    : [...list, tag];
  return next.join(', ');
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
  const [selectedFolder, setSelectedFolder] = useState<string>('ALL');
  const [selectedCluster, setSelectedCluster] = useState<string>('ALL');
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [scopeFilter, setScopeFilter] = useState<'all' | 'shared' | 'personal'>('all');
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
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
  const [newNodePort, setNewNodePort] = useState('22');
  const [newNodeUser, setNewNodeUser] = useState('ubuntu');
  const [newNodeCluster, setNewNodeCluster] = useState('');
  const [newNodeRole, setNewNodeRole] = useState('worker-node');
  const [newInfraRole, setNewInfraRole] = useState('k8s');
  const [newNodeTags, setNewNodeTags] = useState('k8s, prod');
  const [newNodeDesc, setNewNodeDesc] = useState('');
  const [newNodeShared, setNewNodeShared] = useState(true);
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

  const [noteTarget, setNoteTarget] = useState('');
  const [noteSummary, setNoteSummary] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  // AI Workspace Command Center & Right Column state
  const [aiQuickPrompt, setAiQuickPrompt] = useState('');
  const [aiQuickAgentId, setAiQuickAgentId] = useState('');
  const [showClusterTopology, setShowClusterTopology] = useState(true);
  const [rightColTab, setRightColTab] = useState<'activity' | 'memory' | 'kb'>('activity');
  const [memTitle, setMemTitle] = useState('');
  const [memText, setMemText] = useState('');
  const [memKind, setMemKind] = useState<'memory' | 'skill'>('memory');
  const [addingMemory, setAddingMemory] = useState(false);

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

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const s of workspaceServers) {
      if (s.folder) set.add(s.folder);
    }
    return Array.from(set).sort();
  }, [workspaceServers]);

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

  const handleDisconnectS3 = async () => {
    setS3Saving(true);
    try {
      await hubRequest({ action: 'workspace-s3-disconnect' });
      setS3SetupOpen(false);
    } catch {
      // ignore
    } finally {
      setS3Saving(false);
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
    const promptToSend = (customPrompt ?? aiQuickPrompt).trim();
    const agentToUse = customAgentId !== undefined ? customAgentId : aiQuickAgentId;
    window.dispatchEvent(
      new CustomEvent('sshs3:ai-open', {
        detail: {
          view: 'Work',
          mode: 'panel',
          agentId: agentToUse || undefined,
          prompt: promptToSend || undefined,
        },
      })
    );
    if (!customPrompt) {
      setAiQuickPrompt('');
    }
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
      className="flex flex-1 flex-col items-center overflow-y-auto p-6 text-txt-secondary animate-in fade-in duration-200 outline-none"
    >
      <div className="w-full max-w-5xl flex flex-col items-center text-center space-y-6 my-auto">
        {/* Brand Header */}
        <div className="flex flex-col items-center space-y-2">
          <BrandLogo className={recentSSH.length > 0 || showWorkspaceSection ? 'h-14 w-auto' : 'h-28 w-auto'} />
          <div className="flex items-center gap-2">
            <h1
              className={
                recentSSH.length > 0 || showWorkspaceSection
                  ? 'text-lg font-bold tracking-tight'
                  : 'text-3xl font-extrabold tracking-tight'
              }
            >
              <span className="text-txt-primary">ssh</span>
              <span className="text-brand-s3">S3</span>
            </h1>
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
              AI Workspace
            </span>
          </div>
          {recentSSH.length === 0 && !showWorkspaceSection && (
            <p className="text-xs text-txt-muted max-w-md">
              Delat projekt-workspace för VMs, kluster och SFTP med djup terminal-AI och gemensamt teamminne.
            </p>
          )}
        </div>

        {/* Recent Connections (kept first in DOM order so keyboard focus tests hit recent-connect-* first) */}
        {recentSSH.length > 0 && (
          <div className="w-full rounded-xl border border-border-subtle bg-app-surface-subtle p-3 text-left shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-400">
                <Clock className="h-3.5 w-3.5" />
                <span>Recent Connections</span>
              </div>
              <span className="text-[11px] text-txt-muted">Snabbanslut eller fråga AI om en maskin</span>
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
                const isEditing = editingServerId === profile.id;
                const description = summary.description ?? profile.description;
                const role = summary.role ?? profile.role;
                const tags = summary.tags ?? profile.tags;
                const latestAct =
                  latestActivityByServer.get(profile.id) || latestActivityByServer.get(profile.name);
                return (
                  <div
                    key={profile.id}
                    className="recent-card flex flex-col justify-between gap-2 rounded-lg border border-border-subtle bg-app-card px-3 py-2.5 hover:border-border-strong transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="truncate text-xs font-semibold text-txt-primary">
                            {profile.name}
                          </span>
                          {role && (
                            <span
                              className={`rounded border px-1.5 py-0.2 text-[10px] font-medium ${roleBadgeStyle(role)}`}
                            >
                              {role}
                            </span>
                          )}
                          {profile.teamVaultProfileRef && (
                            <span className="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[10px] text-emerald-300">
                              <Users className="h-2.5 w-2.5" /> Team
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-txt-muted font-mono">
                          {profile.username}@{profile.host}:{profile.port ?? 22}
                        </div>
                        {description && !isEditing && (
                          <div className="mt-1 line-clamp-2 text-[11px] text-txt-secondary">
                            {description}
                          </div>
                        )}
                        {tags && tags.length > 0 && !isEditing && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {tags.map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center gap-0.5 rounded bg-app-surface-subtle px-1.5 py-0.2 text-[10px] text-txt-muted"
                              >
                                <Tag className="h-2.5 w-2.5" />
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                        {latestAct && !isEditing && (
                          <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-300/90 truncate">
                            <Activity className="h-2.5 w-2.5 shrink-0" />
                            <span className="truncate">
                              {latestAct.actor}: {latestAct.summary} ({formatRelativeTime(latestAct.at)})
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          data-testid={`recent-connect-${profile.id}`}
                          onClick={() => onConnectRecentSSH(profile)}
                          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 shadow-sm transition-colors"
                        >
                          Connect
                        </button>
                        <SftpButton authType={profile.authType} onOpen={() => onConnectSFTP(profile)} />
                        <button
                          type="button"
                          title="Fråga AI om denna server"
                          onClick={() => handleAskAiAboutServer(summary)}
                          className="inline-flex items-center gap-1 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/20 transition-colors"
                        >
                          <Sparkles className="h-3 w-3" />
                          AI
                        </button>
                        <button
                          type="button"
                          title="Redigera beskrivning & roll"
                          onClick={() => (isEditing ? setEditingServerId(null) : openEditServer(summary))}
                          className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
                        >
                          {isEditing ? <X className="h-3.5 w-3.5" /> : <Edit3 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    </div>
                    {isEditing && (
                      <div className="mt-2 space-y-2 rounded-lg border border-border-subtle bg-app-surface p-2.5">
                        <div>
                          <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                            Roll i infrastrukturen
                          </label>
                          <select
                            value={editRole}
                            onChange={(e) => setEditRole(e.target.value)}
                            className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                          >
                            {ROLE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                            Vad gör denna VM / server?
                          </label>
                          <textarea
                            rows={2}
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            placeholder="T.ex. Primär API-server, kör Docker Compose i /opt/app…"
                            className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                            Taggar (kommaseparerade)
                          </label>
                          <input
                            type="text"
                            value={editTags}
                            onChange={(e) => setEditTags(e.target.value)}
                            placeholder="nginx, prod, postgres"
                            className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                          />
                        </div>
                        <div className="flex justify-end gap-1.5 pt-1">
                          <button
                            type="button"
                            onClick={() => setEditingServerId(null)}
                            className="rounded px-2 py-1 text-[11px] text-txt-muted hover:text-txt-primary"
                          >
                            Avbryt
                          </button>
                          <button
                            type="button"
                            disabled={savingMeta}
                            onClick={() => void handleSaveServerMeta(summary)}
                            className="rounded bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500"
                          >
                            Spara
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Action Cards */}
        {recentSSH.length > 0 ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2 w-full text-left">
            <button
              type="button"
              data-testid="landing-new-terminal-btn"
              onClick={onQuickStartTerminal}
              className="flex items-center gap-2 rounded-lg border border-border-subtle bg-app-card px-2.5 py-2 hover:border-sky-500/40 hover:bg-app-surface-hover transition-all"
            >
              <Terminal className="h-4 w-4 text-sky-400 shrink-0" />
              <span className="truncate text-xs font-medium text-txt-primary">New Terminal</span>
            </button>
            <button
              type="button"
              data-testid="landing-file-manager-btn"
              onClick={() => onNewTab('filemanager')}
              className="flex items-center gap-2 rounded-lg border border-border-subtle bg-app-card px-2.5 py-2 hover:border-amber-500/40 hover:bg-app-surface-hover transition-all"
            >
              <Folder className="h-4 w-4 text-amber-400 shrink-0" />
              <span className="truncate text-xs font-medium text-txt-primary">File Manager</span>
            </button>
            <button
              type="button"
              data-testid="landing-connections-btn"
              onClick={onOpenProfiles}
              className="flex items-center gap-2 rounded-lg border border-border-subtle bg-app-card px-2.5 py-2 hover:border-emerald-500/40 hover:bg-app-surface-hover transition-all"
            >
              <Server className="h-4 w-4 text-emerald-400 shrink-0" />
              <span className="truncate text-xs font-medium text-txt-primary">Connections</span>
            </button>
            <button
              type="button"
              data-testid="landing-cloud-sync-btn"
              onClick={onOpenSyncBootstrap}
              className="flex items-center gap-2 rounded-lg border border-border-subtle bg-app-card px-2.5 py-2 hover:border-purple-500/40 hover:bg-app-surface-hover transition-all"
            >
              <Cloud className="h-4 w-4 text-purple-400 shrink-0" />
              <span className="truncate text-xs font-medium text-txt-primary">Cloud Sync</span>
            </button>
            <button
              type="button"
              data-testid="landing-new-profile-btn"
              onClick={onNewProfile}
              className="flex items-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-2.5 py-2 hover:bg-sky-500/20 transition-all"
            >
              <Plus className="h-4 w-4 text-sky-400 shrink-0" />
              <span className="truncate text-xs font-medium text-txt-primary">New Profile</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full text-left">
            <button
              type="button"
              data-testid="landing-new-terminal-btn"
              onClick={onQuickStartTerminal}
              className="group flex flex-col justify-between rounded-xl border border-border-subtle bg-app-card p-4 hover:border-sky-500/40 hover:bg-app-surface-hover transition-all shadow-sm"
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/15 text-sky-400 group-hover:bg-sky-500/25 group-hover:scale-105 transition-all">
                  <Terminal className="h-5 w-5" />
                </div>
                <Kbd>Ctrl+Shift+T</Kbd>
              </div>
              <div className="mt-3">
                <div className="text-xs font-semibold text-txt-primary group-hover:text-sky-400 transition-colors">
                  Open New Terminal
                </div>
                <div className="text-xs text-txt-muted mt-0.5">
                  Launch a local shell — pick a saved connection or type user@host for SSH
                </div>
              </div>
            </button>

            <button
              type="button"
              data-testid="landing-file-manager-btn"
              onClick={() => onNewTab('filemanager')}
              className="group flex flex-col justify-between rounded-xl border border-border-subtle bg-app-card p-4 hover:border-amber-500/40 hover:bg-app-surface-hover transition-all shadow-sm"
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400 group-hover:bg-amber-500/25 group-hover:scale-105 transition-all">
                  <Folder className="h-5 w-5" />
                </div>
                <Kbd>Ctrl+Shift+F</Kbd>
              </div>
              <div className="mt-3">
                <div className="text-xs font-semibold text-txt-primary group-hover:text-amber-400 transition-colors">
                  New File Manager
                </div>
                <div className="text-xs text-txt-muted mt-0.5">
                  Dual-pane explorer for SFTP, S3 and local drives
                </div>
              </div>
            </button>

            <button
              type="button"
              data-testid="landing-connections-btn"
              onClick={onOpenProfiles}
              className="group flex flex-col justify-between rounded-xl border border-border-subtle bg-app-card p-4 hover:border-emerald-500/40 hover:bg-app-surface-hover transition-all shadow-sm"
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 group-hover:bg-emerald-500/25 group-hover:scale-105 transition-all">
                  <Server className="h-5 w-5" />
                </div>
                <Kbd>Ctrl+Shift+P</Kbd>
              </div>
              <div className="mt-3">
                <div className="text-xs font-semibold text-txt-primary group-hover:text-emerald-400 transition-colors">
                  Saved Connections
                </div>
                <div className="text-xs text-txt-muted mt-0.5">
                  Manage profiles, SSH keys and credentials
                </div>
              </div>
            </button>

            <button
              type="button"
              data-testid="landing-cloud-sync-btn"
              onClick={onOpenSyncBootstrap}
              className="group flex flex-col justify-between rounded-xl border border-border-subtle bg-app-card p-4 hover:border-purple-500/40 hover:bg-app-surface-hover transition-all shadow-sm"
            >
              <div className="flex items-start justify-between w-full">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500/15 text-purple-400 group-hover:bg-purple-500/25 group-hover:scale-105 transition-all">
                  <Cloud className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-3">
                <div className="text-xs font-semibold text-txt-primary group-hover:text-purple-400 transition-colors">
                  Encrypted Cloud Sync
                </div>
                <div className="text-xs text-txt-muted mt-0.5">
                  Sync connection profiles and dotfiles across your devices
                </div>
              </div>
            </button>

            <button
              type="button"
              data-testid="landing-new-profile-btn"
              onClick={onNewProfile}
              className="sm:col-span-2 flex items-center justify-center gap-2 rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-xs font-semibold text-txt-primary hover:bg-sky-500/20 transition-all"
            >
              <Plus className="h-4 w-4 text-sky-400" />
              New Profile
            </button>
          </div>
        )}

        {/* Termius-style Shared Workspace Dashboard & Team Activity Feed */}
        {showWorkspaceSection && (
          <div
            data-testid="workspace-dashboard"
            className="grid grid-cols-1 lg:grid-cols-3 gap-4 w-full text-left"
          >
            {/* Executive Infrastructure Telemetry & KPI Ribbon */}
            <div
              data-testid="workspace-kpi-ribbon"
              className="lg:col-span-3 grid grid-cols-2 sm:grid-cols-4 gap-2.5"
            >
              <div className="rounded-xl border border-sky-500/30 bg-gradient-to-br from-sky-500/10 via-app-card to-app-card p-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">
                    🖥️ Noder & VMs
                  </span>
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-emerald-300">
                    {activeSessionCount > 0 ? `${activeSessionCount} live` : 'Redo'}
                  </span>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-extrabold text-txt-primary">
                    {workspaceServers.length}
                  </span>
                  <span className="text-[11px] text-txt-muted">
                    ({workspaceServers.filter((s) => s.shared).length} delade i S3)
                  </span>
                </div>
              </div>

              <div className="rounded-xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/10 via-app-card to-app-card p-3 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">
                    🧩 Infrastruktur-kluster
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowClusterTopology((v) => !v)}
                    className="rounded border border-indigo-500/30 bg-indigo-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-indigo-300 hover:bg-indigo-500/20"
                  >
                    {showClusterTopology ? 'Dölj topologi' : 'Visa topologi'}
                  </button>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-extrabold text-txt-primary">
                    {clusters.length}
                  </span>
                  <span className="truncate text-[11px] text-txt-muted">
                    {selectedCluster !== 'ALL' ? `Aktivt: ${selectedCluster}` : 'ONTAP, Ceph, S3, K8s'}
                  </span>
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
                className="rounded-xl border border-purple-500/30 bg-gradient-to-br from-purple-500/10 via-app-card to-app-card p-3 text-left shadow-sm hover:border-purple-400/50 transition-all"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-purple-300">
                    🤖 Mission Agents & MCP
                  </span>
                  <span className="rounded-full border border-purple-500/30 bg-purple-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-purple-200">
                    {totalMcpTools} MCP-verktyg
                  </span>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-extrabold text-txt-primary">
                    {(hub?.agents ?? []).length}
                  </span>
                  <span className="text-[11px] text-txt-muted">
                    agenter · {(hub?.mcpServers ?? []).length} MCP-servrar
                  </span>
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
                className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-app-card to-app-card p-3 text-left shadow-sm hover:border-emerald-400/50 transition-all"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                    📚 Knowledge Base & Minne
                  </span>
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-emerald-200">
                    BM25 + S3
                  </span>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-extrabold text-txt-primary">
                    {(hub?.kbDocuments ?? []).length}
                  </span>
                  <span className="text-[11px] text-txt-muted">
                    runbooks · {(hub?.memories ?? []).length} team-minnen
                  </span>
                </div>
              </button>
            </div>

            {/* AI Workspace Command Center (Omnibar + Agent Selector + Quick Ops Chips) */}
            <div
              data-testid="workspace-ai-command-bar"
              className="lg:col-span-3 rounded-xl border border-sky-500/40 bg-gradient-to-r from-sky-500/10 via-indigo-500/10 to-purple-500/10 p-3.5 shadow-md space-y-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg border border-sky-400/40 bg-sky-500/20 text-sky-300">
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                  <div>
                    <span className="text-xs font-bold text-txt-primary">
                      AI Workspace Command Center
                    </span>
                    <span className="ml-2 hidden sm:inline text-[11px] text-txt-muted">
                      Styr kluster, kör parallella diagnoser, diffa filer eller be AI:n konfigurera hela sshS3
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setAiQuickAgentId('')}
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold transition-all ${
                      !aiQuickAgentId
                        ? 'border border-sky-400/50 bg-sky-500/20 text-sky-200'
                        : 'border border-border-subtle bg-app-card text-txt-muted hover:text-txt-primary'
                    }`}
                  >
                    ✨ Standard AI
                  </button>
                  {(hub?.agents ?? []).slice(0, 4).map((ag) => (
                    <button
                      key={ag.id}
                      type="button"
                      title={`${ag.role}: ${ag.mission}`}
                      onClick={() =>
                        setAiQuickAgentId(aiQuickAgentId === ag.id ? '' : ag.id)
                      }
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold transition-all ${
                        aiQuickAgentId === ag.id
                          ? 'border border-sky-400/60 bg-sky-500/25 text-sky-200 shadow-sm'
                          : 'border border-border-subtle bg-app-card text-txt-secondary hover:border-sky-500/40 hover:text-sky-200'
                      }`}
                    >
                      <span>{ag.icon || '🤖'}</span>
                      <span className="truncate max-w-[130px]">{ag.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleLaunchAiCommand();
                }}
                className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2"
              >
                <div className="relative flex-1">
                  <Bot className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-sky-400" />
                  <input
                    type="text"
                    data-testid="workspace-ai-prompt-input"
                    value={aiQuickPrompt}
                    onChange={(e) => setAiQuickPrompt(e.target.value)}
                    placeholder="Fråga eller be AI:n utföra något… (t.ex. 'Kör hälsokontroll på @cluster:NetApp-ONTAP-Prod-SE' eller 'Skapa en SSH-tunnel på port 8443')"
                    className="w-full rounded-lg border border-sky-500/35 bg-app/95 pl-9 pr-3 py-2 text-xs text-txt-primary placeholder:text-txt-muted outline-none focus:border-sky-400"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="submit"
                    data-testid="workspace-ai-submit-btn"
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-sky-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-sky-500 shadow-sm transition-colors"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Kör med AI</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('sshs3:ai-open', {
                          detail: { view: 'Work', mode: 'hub' },
                        })
                      )
                    }
                    className="inline-flex items-center justify-center gap-1 rounded-lg border border-border-subtle bg-app-card px-2.5 py-2 text-xs font-medium text-txt-secondary hover:border-sky-500/40 hover:text-txt-primary transition-colors"
                  >
                    <span>Full AI Hub ↗</span>
                  </button>
                </div>
              </form>

              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="text-[10px] font-bold uppercase tracking-wider text-txt-muted mr-1">
                  Snabbuppdrag:
                </span>
                <button
                  type="button"
                  onClick={() =>
                    handleLaunchAiCommand(
                      'Kör en parallell hälsokontroll över alla noder i @cluster:NetApp-ONTAP-Prod-SE med sshs3_cluster_exec och sammanställ WAFL/NVMe-latens, aggregat och SnapMirror-status.'
                    )
                  }
                  className="rounded-md border border-sky-500/30 bg-app-card/90 px-2 py-0.5 text-[10.5px] font-medium text-sky-300 hover:bg-sky-500/15 transition-colors"
                >
                  ⚡ Kluster-hälsokontroll
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleLaunchAiCommand(
                      'Öppna en 2x2 Konsole split-view för alla noder i @cluster:NetApp-ONTAP-Prod-SE med sshs3_workspace_layout.'
                    )
                  }
                  className="rounded-md border border-emerald-500/30 bg-app-card/90 px-2 py-0.5 text-[10.5px] font-medium text-emerald-300 hover:bg-emerald-500/15 transition-colors"
                >
                  🪟 2×2 Kluster Split-View
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleLaunchAiCommand(
                      'Diffa /etc/multipath.conf mellan k8s-storage-cp-01 och k8s-gpu-io-worker-01 med sshs3_storage_ops och validera mot vår KB-runbook.'
                    )
                  }
                  className="rounded-md border border-indigo-500/30 bg-app-card/90 px-2 py-0.5 text-[10.5px] font-medium text-indigo-300 hover:bg-indigo-500/15 transition-colors"
                >
                  🔍 Cross-Server Config Diff
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleLaunchAiCommand(
                      'Visa alla mina inställningar i sshS3 med sshs3_manage_app_and_settings och hjälp mig optimera SSH-tunnlar, dotfiles-pool, prestandabar och kortkommandon.'
                    )
                  }
                  className="rounded-md border border-purple-500/30 bg-app-card/90 px-2 py-0.5 text-[10.5px] font-medium text-purple-300 hover:bg-purple-500/15 transition-colors"
                >
                  🛠️ Konfigurera sshS3 med AI
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleLaunchAiCommand(
                      'Sök i vår Knowledge Base (@kb) efter ONTAP Adaptive QoS och hämta aktuell telemetri via NetApp Harvest MCP.'
                    )
                  }
                  className="rounded-md border border-amber-500/30 bg-app-card/90 px-2 py-0.5 text-[10.5px] font-medium text-amber-300 hover:bg-amber-500/15 transition-colors"
                >
                  📚 Sök i Runbooks & MCP
                </button>
              </div>
            </div>

            {/* Full-width S3 Team Bucket Sync & Presence Bar */}
            <div className="lg:col-span-3 rounded-xl border border-sky-500/30 bg-app-surface-subtle p-3 shadow-sm space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <Cloud className="h-4 w-4 text-sky-400" />
                    <span className="text-xs font-bold text-txt-primary">
                      S3 Team Workspace
                    </span>
                  </div>
                  {hub?.s3Workspace?.configured ? (
                    <span
                      data-testid="s3-workspace-status-badge"
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        hub.s3Workspace.error
                          ? 'border-rose-500/40 bg-rose-500/15 text-rose-300'
                          : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      }`}
                    >
                      <span>
                        {hub.s3Workspace.error ? '⚠️' : '🟢'} s3://{hub.s3Workspace.bucket}/
                        {hub.s3Workspace.prefix || 'sshs3-team'}
                      </span>
                      {hub.s3Workspace.syncing ? (
                        <span className="text-sky-300">· Synkar…</span>
                      ) : hub.s3Workspace.lastSyncAt ? (
                        <span className="text-txt-muted">
                          · Synkad {formatRelativeTime(hub.s3Workspace.lastSyncAt)}
                        </span>
                      ) : null}
                    </span>
                  ) : isWebBrowserMode() ? (
                    <span
                      data-testid="s3-workspace-status-badge"
                      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300"
                    >
                      🟢 VM Team-delning aktiv på denna Web-server — alla inloggade användare delar VMs, kluster & AI-minnen direkt (S3-bucket är valfri molnbackup)
                    </span>
                  ) : (
                    <span
                      data-testid="s3-workspace-status-badge"
                      className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-app-card px-2 py-0.5 text-[10px] text-txt-muted"
                    >
                      Ej kopplad — dela VMs, kluster & AI-minne med dina kompisar via en S3-bucket (endast S3-nycklar krävs)
                    </span>
                  )}

                  {/* Online Teammates Presence */}
                  {(hub?.presence ?? []).length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {(hub?.presence ?? []).map((p) => (
                        <span
                          key={p.actor}
                          title={
                            (p.activeTerminals ?? []).length > 0
                              ? `${p.actor}: ${(p.activeTerminals ?? []).map((t) => t.targetLabel).join(', ')}`
                              : `${p.actor} är online`
                          }
                          className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span>{p.actor}</span>
                          {(p.activeTerminals ?? []).length > 0 && (
                            <span className="text-[9px] text-emerald-200/80">
                              ({(p.activeTerminals ?? []).length} term)
                            </span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  {hub?.s3Workspace?.configured && hub.s3Workspace.inviteCode && (
                    <button
                      type="button"
                      data-testid="copy-s3-invite-btn"
                      onClick={handleCopyS3Invite}
                      title="Kopiera 1-klicks S3 Invite-kod (sshs3-s3://...) att skicka till dina kompisar"
                      className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-300 hover:bg-sky-500/25 transition-colors"
                    >
                      {s3CopyFeedback ? (
                        <>
                          <Check className="h-3 w-3 text-emerald-400" />
                          <span>Kopierad!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3" />
                          <span>Kopiera Invite-kod</span>
                        </>
                      )}
                    </button>
                  )}
                  {hub?.s3Workspace?.configured && (
                    <button
                      type="button"
                      data-testid="s3-sync-now-btn"
                      disabled={s3Syncing || hub.s3Workspace.syncing}
                      onClick={() => void handleSyncS3Now()}
                      className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-app-card px-2 py-1 text-[11px] font-medium text-txt-primary hover:bg-app-surface-hover disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${s3Syncing || hub.s3Workspace.syncing ? 'animate-spin text-sky-400' : ''}`}
                      />
                      <span>Synka nu</span>
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="toggle-s3-bucket-setup-btn"
                    onClick={openS3BucketSetup}
                    className="inline-flex items-center gap-1 rounded-md border border-purple-500/40 bg-purple-500/15 px-2.5 py-1 text-[11px] font-semibold text-purple-300 hover:bg-purple-500/25 transition-colors"
                  >
                    <Key className="h-3 w-3" />
                    <span>
                      {s3SetupOpen
                        ? 'Stäng S3-inställning'
                        : hub?.s3Workspace?.configured
                          ? 'S3-nycklar'
                          : 'Koppla S3 Team Bucket'}
                    </span>
                  </button>
                </div>
              </div>

              {hub?.s3Workspace?.error && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300">
                  S3-synkfel: {hub.s3Workspace.error}
                </div>
              )}

              {s3SetupOpen && (
                <form
                  data-testid="s3-bucket-setup-form"
                  onSubmit={handleSaveS3Bucket}
                  className="space-y-3 rounded-xl border border-purple-500/35 bg-app-card p-3.5 shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-xs font-bold text-purple-300">
                        Dela Workspace med kompisar via S3 Bucket (AWS S3, Cloudflare R2, MinIO, Hetzner)
                      </div>
                      <p className="text-[11px] text-txt-muted mt-0.5">
                        Endast IP/host, port, standard-användare, kluster, roller, taggar, AI-minnen och live-presence synkas i S3. Varje kompis loggar in med sin egen lokala SSH-nyckel (<code className="text-sky-300">~/.ssh</code>) som aldrig lämnar datorn.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setS3SetupOpen(false)}
                      className="rounded p-0.5 text-txt-muted hover:text-txt-primary"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {/* 1-Click Invite Code Paste */}
                  <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-2.5">
                    <label className="block text-[10px] font-bold uppercase tracking-wider text-sky-300 mb-1">
                      Snabb-gå med: Klistra in Invite-kod från en kompis (sshs3-s3://…)
                    </label>
                    <input
                      type="text"
                      data-testid="s3-invite-code-input"
                      value={s3InviteCode}
                      onChange={(e) => setS3InviteCode(e.target.value)}
                      placeholder="sshs3-s3://eyJidWNrZXQiOi..."
                      className="w-full rounded border border-border-subtle bg-app px-2.5 py-1 text-xs font-mono text-txt-primary placeholder:text-txt-muted"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        S3 Bucket {!s3InviteCode.trim() && '*'}
                      </label>
                      <input
                        type="text"
                        data-testid="s3-bucket-input"
                        value={s3Bucket}
                        onChange={(e) => setS3Bucket(e.target.value)}
                        placeholder="t.ex. my-team-infra"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Region
                      </label>
                      <input
                        type="text"
                        value={s3Region}
                        onChange={(e) => setS3Region(e.target.value)}
                        placeholder="eu-north-1 / auto"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Endpoint (valfri, t.ex. R2 / MinIO)
                      </label>
                      <input
                        type="text"
                        value={s3Endpoint}
                        onChange={(e) => setS3Endpoint(e.target.value)}
                        placeholder="https://<id>.r2.cloudflarestorage.com"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Prefix / Mapp i bucket
                      </label>
                      <input
                        type="text"
                        value={s3Prefix}
                        onChange={(e) => setS3Prefix(e.target.value)}
                        placeholder="sshs3-team"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Access Key ID {!s3InviteCode.trim() && '*'}
                      </label>
                      <input
                        type="text"
                        data-testid="s3-access-key-input"
                        value={s3AccessKeyId}
                        onChange={(e) => setS3AccessKeyId(e.target.value)}
                        placeholder="AKIA..."
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs font-mono text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Secret Access Key {!s3InviteCode.trim() && !hub?.s3Workspace?.configured && '*'}
                      </label>
                      <input
                        type="password"
                        data-testid="s3-secret-key-input"
                        value={s3SecretAccessKey}
                        onChange={(e) => setS3SecretAccessKey(e.target.value)}
                        placeholder={
                          hub?.s3Workspace?.configured
                            ? '•••••••• (lämna tom för att behålla)'
                            : 'Din S3 Secret Access Key'
                        }
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs font-mono text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Ditt namn i teamet (visas vid ändringar & terminal)
                      </label>
                      <input
                        type="text"
                        data-testid="s3-actor-name-input"
                        value={s3ActorName}
                        onChange={(e) => setS3ActorName(e.target.value)}
                        placeholder="t.ex. jacob"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                  </div>

                  {s3StatusMsg && (
                    <div className="text-[11px] text-rose-400">{s3StatusMsg}</div>
                  )}

                  <div className="flex items-center justify-between pt-1">
                    <div>
                      {hub?.s3Workspace?.configured && (
                        <button
                          type="button"
                          onClick={() => void handleDisconnectS3()}
                          className="rounded px-2 py-1 text-[11px] text-rose-400 hover:bg-rose-500/10"
                        >
                          Koppla från S3 Bucket
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setS3SetupOpen(false)}
                        className="rounded px-2.5 py-1 text-xs text-txt-muted hover:text-txt-primary"
                      >
                        Avbryt
                      </button>
                      <button
                        type="submit"
                        data-testid="s3-save-connect-btn"
                        disabled={s3Saving}
                        className="rounded-lg bg-purple-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-purple-500 disabled:opacity-40"
                      >
                        {s3Saving ? 'Ansluter & synkar…' : 'Spara & Synka S3 Bucket'}
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </div>

            {/* Left 2 Columns: Termius-style Server, Cluster & Node Cards */}
            <div className="lg:col-span-2 flex flex-col gap-3 rounded-xl border border-border-subtle bg-app-surface-subtle p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-emerald-400" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-txt-primary">
                    Workspace VMs & Kluster ({filteredServers.length})
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    data-testid="add-cluster-node-btn"
                    onClick={() => setAddNodeOpen((prev) => !prev)}
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    {addNodeOpen ? 'Stäng' : '+ Kluster / Nod'}
                  </button>
                  {(['all', 'shared', 'personal'] as const).map((scope) => (
                    <button
                      key={scope}
                      type="button"
                      onClick={() => setScopeFilter(scope)}
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                        scopeFilter === scope
                          ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                          : 'text-txt-muted hover:text-txt-primary border border-transparent'
                      }`}
                    >
                      {scope === 'all' ? 'Alla' : scope === 'shared' ? 'Delade (S3)' : 'Personliga'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Inline Add Cluster / Node Builder */}
              {addNodeOpen && (
                <form
                  data-testid="add-cluster-node-form"
                  onSubmit={handleCreateClusterNode}
                  className="space-y-2.5 rounded-xl border border-emerald-500/35 bg-app-card p-3 shadow-md"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-300">
                      Lägg till nytt Kluster eller Nod / VM i Workspace
                    </span>
                    <button
                      type="button"
                      onClick={() => setAddNodeOpen(false)}
                      className="rounded p-0.5 text-txt-muted hover:text-txt-primary"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Kluster (välj eller skriv nytt!)
                      </label>
                      <input
                        type="text"
                        list="workspace-clusters-list"
                        value={newNodeCluster}
                        onChange={(e) => setNewNodeCluster(e.target.value)}
                        placeholder="t.ex. k8s-eu-north-1, Proxmox-01…"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                      <datalist id="workspace-clusters-list">
                        {clusters.map((c) => (
                          <option key={c.name} value={c.name} />
                        ))}
                      </datalist>
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Nodnamn / Host-alias *
                      </label>
                      <input
                        type="text"
                        required
                        value={newNodeName}
                        onChange={(e) => setNewNodeName(e.target.value)}
                        placeholder="t.ex. k8s-worker-02"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        IP / Hostname *
                      </label>
                      <input
                        type="text"
                        required
                        value={newNodeHost}
                        onChange={(e) => setNewNodeHost(e.target.value)}
                        placeholder="t.ex. 10.20.2.115"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        SSH-användare
                      </label>
                      <input
                        type="text"
                        value={newNodeUser}
                        onChange={(e) => setNewNodeUser(e.target.value)}
                        placeholder="ubuntu"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Port
                      </label>
                      <input
                        type="number"
                        value={newNodePort}
                        onChange={(e) => setNewNodePort(e.target.value)}
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Nod-roll i klustret
                      </label>
                      <select
                        value={newNodeRole}
                        onChange={(e) => setNewNodeRole(e.target.value)}
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      >
                        {NODE_ROLE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Infrastruktur-roll
                      </label>
                      <select
                        value={newInfraRole}
                        onChange={(e) => setNewInfraRole(e.target.value)}
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      >
                        {ROLE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                      Tagga noden (klicka på snabb-taggar eller skriv egna)
                    </label>
                    <input
                      type="text"
                      value={newNodeTags}
                      onChange={(e) => setNewNodeTags(e.target.value)}
                      placeholder="k8s, worker, gpu-node, prod"
                      className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary mb-1"
                    />
                    <div className="flex flex-wrap gap-1">
                      {QUICK_TAG_PRESETS.map((preset) => {
                        const activeTag = newNodeTags
                          .split(',')
                          .map((t) => t.trim().toLowerCase())
                          .includes(preset.toLowerCase());
                        return (
                          <button
                            key={preset}
                            type="button"
                            onClick={() =>
                              setNewNodeTags((prev) => toggleCommaTag(prev, preset))
                            }
                            className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                              activeTag
                                ? 'bg-sky-500/25 text-sky-300 border border-sky-500/40'
                                : 'bg-app-surface text-txt-muted hover:text-txt-primary border border-border-subtle'
                            }`}
                          >
                            #{preset}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                        Vad gör denna nod / detta kluster?
                      </label>
                      <input
                        type="text"
                        value={newNodeDesc}
                        onChange={(e) => setNewNodeDesc(e.target.value)}
                        placeholder="Beskrivning som delas med teamet och AI-minnet…"
                        className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                      />
                    </div>
                    <div className="flex items-center justify-between sm:justify-end gap-2">
                      <label className="inline-flex items-center gap-1 text-[11px] text-txt-secondary cursor-pointer">
                        <input
                          type="checkbox"
                          checked={newNodeShared}
                          onChange={(e) => setNewNodeShared(e.target.checked)}
                        />
                        Dela i S3 Team Bucket
                      </label>
                      <button
                        type="submit"
                        disabled={creatingNode || !newNodeName.trim() || !newNodeHost.trim()}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
                      >
                        Spara Nod
                      </button>
                    </div>
                  </div>
                </form>
              )}

              {/* Next-Gen AI Hub Quick Bar: Mission Agents, MCP Servers & Knowledge Base */}
              {(hub?.agents?.length ?? 0) > 0 && (
                <div
                  data-testid="landing-ai-agents-bar"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-2.5 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-sky-400 mr-1">
                      <Sparkles className="h-3 w-3" />
                      Mission Agents:
                    </span>
                    {(hub?.agents ?? []).slice(0, 4).map((ag) => (
                      <button
                        key={ag.id}
                        type="button"
                        title={`${ag.role}\nUppdrag: ${ag.mission}\nKlicka för att aktivera och köra i AI Hub`}
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent('sshs3:ai-open', {
                              detail: {
                                view: 'Work',
                                mode: 'panel',
                                agentId: ag.id,
                                prompt: `Kör ditt uppdrag som ${ag.name}: ${ag.mission}`,
                              },
                            })
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-app-card px-2 py-0.5 text-[11px] font-medium text-txt-secondary hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-sky-200 transition-all"
                      >
                        <span>{ag.icon || '🤖'}</span>
                        <span className="truncate max-w-[140px]">{ag.name}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent('sshs3:ai-open', {
                            detail: { view: 'Agents & MCP', mode: 'hub' },
                          })
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-300 hover:bg-indigo-500/25"
                    >
                      <span>🔌 MCP ({hub?.mcpServers?.length ?? 0})</span>
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
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/25"
                    >
                      <span>📚 KB ({hub?.kbDocuments?.length ?? 0})</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Cluster Filter Bar */}
              {clusters.length > 0 && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-app-card/60 px-2.5 py-1.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-txt-muted mr-1">
                        Kluster:
                      </span>
                      <button
                        type="button"
                        onClick={() => setSelectedCluster('ALL')}
                        className={`rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                          selectedCluster === 'ALL'
                            ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/40'
                            : 'text-txt-muted hover:text-txt-primary'
                        }`}
                      >
                        Alla kluster ({workspaceServers.length})
                      </button>
                      {clusters.map((c) => (
                        <button
                          key={c.name}
                          type="button"
                          onClick={() =>
                            setSelectedCluster(selectedCluster === c.name ? 'ALL' : c.name)
                          }
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors ${
                            selectedCluster === c.name
                              ? 'bg-indigo-500/25 text-indigo-200 border border-indigo-500/50'
                              : 'text-txt-muted hover:text-txt-primary border border-transparent'
                          }`}
                        >
                          <span>🧩 {c.name}</span>
                          <span className="rounded-full bg-app px-1.5 text-[10px] text-txt-muted">
                            {c.count}
                          </span>
                        </button>
                      ))}
                    </div>
                    {selectedCluster !== 'ALL' && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          data-testid="cluster-open-split-btn"
                          title={`Öppna alla noder i ${selectedCluster} i en 2×2 Konsole Split-View`}
                          onClick={() => handleOpenClusterSplitView(selectedCluster)}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/25"
                        >
                          <span>🪟 Split-View ({selectedCluster})</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleAskAiAboutCluster(selectedCluster)}
                          className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-300 hover:bg-sky-500/25"
                        >
                          <Sparkles className="h-3 w-3" />
                          Fråga AI om @{selectedCluster}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Interactive Cluster Topology Cards */}
                  {showClusterTopology && (
                    <div
                      data-testid="workspace-cluster-topology"
                      className="grid grid-cols-1 sm:grid-cols-2 gap-2"
                    >
                      {clusters.slice(0, 6).map((c) => {
                        const members = workspaceServers.filter((s) => s.cluster === c.name);
                        const isSelected = selectedCluster === c.name;
                        const matchingAgent = (hub?.agents ?? []).find(
                          (ag) => ag.targetCluster === c.name
                        );
                        return (
                          <div
                            key={c.name}
                            className={`rounded-xl border p-2.5 transition-all ${
                              isSelected
                                ? 'border-indigo-400/60 bg-indigo-500/10 shadow-sm'
                                : 'border-border-subtle bg-app-card/85 hover:border-indigo-500/40'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="text-xs font-bold text-txt-primary truncate">
                                    🧩 {c.name}
                                  </span>
                                  <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.2 text-[9.5px] font-semibold text-emerald-300">
                                    🟢 {members.length} noder
                                  </span>
                                </div>
                                {matchingAgent && (
                                  <div className="mt-0.5 text-[10px] text-sky-300 truncate">
                                    {matchingAgent.icon || '🤖'} Agent: {matchingAgent.name}
                                  </div>
                                )}
                              </div>
                              <div className="flex shrink-0 items-center gap-1">
                                <button
                                  type="button"
                                  title={`Öppna 2×2 Split-View för ${c.name}`}
                                  onClick={() => handleOpenClusterSplitView(c.name)}
                                  className="rounded border border-emerald-500/35 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/25"
                                >
                                  🪟 Split
                                </button>
                                <button
                                  type="button"
                                  title={`Kör parallell AI-diagnos på @cluster:${c.name}`}
                                  onClick={() => handleAskAiAboutCluster(c.name)}
                                  className="rounded border border-sky-500/35 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300 hover:bg-sky-500/25"
                                >
                                  ⚡ AI
                                </button>
                              </div>
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {members.slice(0, 4).map((m) => (
                                <span
                                  key={m.id}
                                  className="inline-flex items-center gap-1 rounded border border-border-subtle bg-app px-1.5 py-0.2 text-[10px] font-mono text-txt-secondary"
                                >
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                  <span className="truncate max-w-[115px]">{m.name}</span>
                                </span>
                              ))}
                              {members.length > 4 && (
                                <span className="rounded bg-app px-1.5 py-0.2 text-[10px] text-txt-muted">
                                  +{members.length - 4} till
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Search, Active Tag & Folder Filter Bar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-txt-muted" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Sök kluster, nod, roll, IP, tagg eller beskrivning…"
                    className="w-full rounded-lg border border-border-subtle bg-app-card pl-8 pr-3 py-1.5 text-xs text-txt-primary placeholder:text-txt-muted outline-none focus:border-sky-500/50"
                  />
                </div>
                {selectedTag && (
                  <button
                    type="button"
                    onClick={() => setSelectedTag('')}
                    className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/15 px-2 py-1 text-[11px] font-medium text-sky-300"
                  >
                    <Tag className="h-3 w-3" />
                    <span>#{selectedTag}</span>
                    <X className="h-3 w-3" />
                  </button>
                )}
                {folders.length > 0 && (
                  <div className="flex items-center gap-1 overflow-x-auto">
                    <button
                      type="button"
                      onClick={() => setSelectedFolder('ALL')}
                      className={`rounded-md px-2 py-1 text-[11px] font-medium ${
                        selectedFolder === 'ALL'
                          ? 'bg-app-card text-txt-primary border border-border-strong'
                          : 'text-txt-muted hover:text-txt-primary'
                      }`}
                    >
                      Alla mappar
                    </button>
                    {folders.map((folder) => (
                      <button
                        key={folder}
                        type="button"
                        onClick={() => setSelectedFolder(folder)}
                        className={`rounded-md px-2 py-1 text-[11px] font-medium ${
                          selectedFolder === folder
                            ? 'bg-app-card text-txt-primary border border-border-strong'
                            : 'text-txt-muted hover:text-txt-primary'
                        }`}
                      >
                        {folder}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Server Cards Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[580px] overflow-y-auto pr-1">
                {filteredServers.map((server) => {
                  const isEditing = editingServerId === server.id;
                  const latestEvent =
                    latestActivityByServer.get(server.id) ||
                    latestActivityByServer.get(server.name);
                  const connectable = toConnectableProfile(server);
                  const livePresence =
                    presenceByServer.get(server.id) ||
                    presenceByServer.get(server.host) ||
                    presenceByServer.get(server.name) ||
                    [];
                  const hasLocalOverride = Boolean(
                    server.localUsername || server.localPrivateKeyPath
                  );

                  return (
                    <div
                      key={`${server.shared ? 'shared' : 'personal'}-${server.id}`}
                      data-testid={`workspace-server-card-${server.id}`}
                      className="flex flex-col justify-between rounded-xl border border-border-subtle bg-app-card p-3 hover:border-sky-500/40 transition-all shadow-sm"
                    >
                      <div>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Server className="h-3.5 w-3.5 text-sky-400 shrink-0" />
                              <span className="truncate text-xs font-bold text-txt-primary">
                                {server.name}
                              </span>
                              {server.cluster && (
                                <button
                                  type="button"
                                  title={`Filtrera på kluster: ${server.cluster}`}
                                  onClick={() =>
                                    setSelectedCluster(
                                      selectedCluster === server.cluster ? 'ALL' : server.cluster!
                                    )
                                  }
                                  className="inline-flex items-center gap-0.5 rounded border border-indigo-500/40 bg-indigo-500/15 px-1.5 py-0.2 text-[10px] font-semibold text-indigo-300 hover:bg-indigo-500/25"
                                >
                                  🧩 {server.cluster}
                                </button>
                              )}
                              {server.nodeRole && (
                                <span
                                  className={`rounded border px-1.5 py-0.2 text-[10px] font-medium ${roleBadgeStyle(server.nodeRole)}`}
                                >
                                  {server.nodeRole}
                                </span>
                              )}
                              {server.role && server.role !== server.nodeRole && (
                                <span
                                  className={`rounded border px-1.5 py-0.2 text-[10px] font-medium ${roleBadgeStyle(server.role)}`}
                                >
                                  {server.role}
                                </span>
                              )}
                              {server.shared ? (
                                <span className="inline-flex items-center gap-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.2 text-[10px] text-emerald-300">
                                  <Users className="h-2.5 w-2.5" /> Delad (S3)
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-app-surface-subtle px-1.5 py-0.2 text-[10px] text-txt-muted">
                                  <Shield className="h-2.5 w-2.5" /> Privat
                                </span>
                              )}
                              {livePresence.map((p, idx) => (
                                <span
                                  key={`${p.actor}-${idx}`}
                                  data-testid={`server-presence-${server.id}-${p.actor}`}
                                  className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.2 text-[10px] font-semibold text-emerald-300"
                                >
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                  <span>
                                    {p.aiWorking ? `🤖 ${p.actor} (AI)` : `${p.actor} (Terminal)`}
                                  </span>
                                </span>
                              ))}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] font-mono text-txt-muted">
                              {connectable.username}@{server.host}:{server.port}
                              {server.folder ? ` · ${server.folder}` : ''}
                              {hasLocalOverride && (
                                <span
                                  title="Lokal ~/.ssh-override sparad på din dator"
                                  className="ml-1.5 rounded bg-purple-500/15 px-1 py-0.2 text-[9.5px] font-sans text-purple-300"
                                >
                                  🔑 Lokal ~/.ssh
                                </span>
                              )}
                            </div>
                          </div>

                          <button
                            type="button"
                            title="Redigera kluster, nod-roll, taggar, beskrivning & lokal ~/.ssh"
                            onClick={() =>
                              isEditing ? setEditingServerId(null) : openEditServer(server)
                            }
                            className="rounded p-1 text-txt-muted hover:bg-app-surface-hover hover:text-txt-primary"
                          >
                            {isEditing ? <X className="h-3.5 w-3.5" /> : <Edit3 className="h-3.5 w-3.5" />}
                          </button>
                        </div>

                        {isEditing ? (
                          <div className="mt-2 space-y-2 rounded-lg border border-border-subtle bg-app-surface p-2.5">
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                              <div>
                                <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                                  Kluster (valfritt namn)
                                </label>
                                <input
                                  type="text"
                                  list="workspace-clusters-list"
                                  value={editCluster}
                                  onChange={(e) => setEditCluster(e.target.value)}
                                  placeholder="t.ex. k8s-eu-north-1"
                                  className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                                />
                              </div>
                              <div>
                                <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                                  Nod-roll i klustret
                                </label>
                                <select
                                  value={editNodeRole}
                                  onChange={(e) => setEditNodeRole(e.target.value)}
                                  className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                                >
                                  {NODE_ROLE_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                      {opt.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                                Roll i infrastrukturen
                              </label>
                              <select
                                value={editRole}
                                onChange={(e) => setEditRole(e.target.value)}
                                className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                              >
                                {ROLE_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                                Vad gör denna VM / nod?
                              </label>
                              <textarea
                                rows={2}
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                placeholder="T.ex. Primär API-server, kör Docker Compose i /opt/app…"
                                className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold text-txt-muted mb-0.5">
                                Taggar (klicka eller skriv kommaseparerat)
                              </label>
                              <input
                                type="text"
                                value={editTags}
                                onChange={(e) => setEditTags(e.target.value)}
                                placeholder="nginx, prod, postgres"
                                className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs text-txt-primary mb-1"
                              />
                              <div className="flex flex-wrap gap-1">
                                {QUICK_TAG_PRESETS.slice(0, 8).map((preset) => {
                                  const activeTag = editTags
                                    .split(',')
                                    .map((t) => t.trim().toLowerCase())
                                    .includes(preset.toLowerCase());
                                  return (
                                    <button
                                      key={preset}
                                      type="button"
                                      onClick={() =>
                                        setEditTags((prev) => toggleCommaTag(prev, preset))
                                      }
                                      className={`rounded px-1.5 py-0.5 text-[9.5px] ${
                                        activeTag
                                          ? 'bg-sky-500/25 text-sky-300 border border-sky-500/40'
                                          : 'bg-app text-txt-muted hover:text-txt-primary border border-border-subtle'
                                      }`}
                                    >
                                      #{preset}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                            {/* Per-user local ~/.ssh override (never uploaded to S3) */}
                            <div className="rounded-md border border-purple-500/25 bg-purple-500/5 p-2 space-y-1.5">
                              <div className="flex items-center gap-1 text-[10px] font-semibold text-purple-300">
                                <Key className="h-3 w-3" />
                                <span>Min lokala SSH-inloggning (~/.ssh — delas aldrig i S3)</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                <div>
                                  <label className="block text-[9.5px] text-txt-muted mb-0.5">
                                    Mitt SSH-användarnamn (om annat än {server.username})
                                  </label>
                                  <input
                                    type="text"
                                    value={editLocalUser}
                                    onChange={(e) => setEditLocalUser(e.target.value)}
                                    placeholder={server.username}
                                    className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs font-mono text-txt-primary"
                                  />
                                </div>
                                <div>
                                  <label className="block text-[9.5px] text-txt-muted mb-0.5">
                                    Lokal SSH-nyckel (valfri sökväg)
                                  </label>
                                  <input
                                    type="text"
                                    value={editLocalKeyPath}
                                    onChange={(e) => setEditLocalKeyPath(e.target.value)}
                                    placeholder="~/.ssh/id_ed25519 (tom = SSH-agent)"
                                    className="w-full rounded border border-border-subtle bg-app px-2 py-1 text-xs font-mono text-txt-primary"
                                  />
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center justify-between pt-1">
                              <button
                                type="button"
                                data-testid={`delete-server-btn-${server.id}`}
                                disabled={savingMeta}
                                onClick={() => void handleDeleteServer(server)}
                                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-rose-400 hover:bg-rose-500/10"
                              >
                                <Trash2 className="h-3 w-3" />
                                <span>Ta bort nod</span>
                              </button>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setEditingServerId(null)}
                                  className="rounded px-2 py-1 text-[11px] text-txt-muted hover:text-txt-primary"
                                >
                                  Avbryt
                                </button>
                                <button
                                  type="button"
                                  disabled={savingMeta}
                                  onClick={() => void handleSaveServerMeta(server)}
                                  className="rounded bg-sky-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-sky-500"
                                >
                                  Spara
                                </button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className="mt-2 text-xs text-txt-secondary line-clamp-2 min-h-[2rem]">
                              {server.description || (
                                <span className="italic text-txt-muted">
                                  Ingen beskrivning ännu — klicka på pennan för att beskriva vad denna nod gör.
                                </span>
                              )}
                            </p>
                            {server.tags && server.tags.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {server.tags.map((tag) => (
                                  <button
                                    key={tag}
                                    type="button"
                                    title={`Filtrera på tagg #${tag}`}
                                    onClick={() =>
                                      setSelectedTag(selectedTag === tag ? '' : tag)
                                    }
                                    className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                                      selectedTag.toLowerCase() === tag.toLowerCase()
                                        ? 'bg-sky-500/25 text-sky-300 border border-sky-500/40'
                                        : 'bg-app-surface-subtle text-txt-muted hover:text-txt-primary'
                                    }`}
                                  >
                                    <Tag className="h-2.5 w-2.5" />
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            )}
                            {latestEvent && (
                              <div className="mt-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-200/90">
                                <span className="font-semibold">{latestEvent.actor}:</span>{' '}
                                {latestEvent.summary}{' '}
                                <span className="text-txt-muted">
                                  ({formatRelativeTime(latestEvent.at)})
                                </span>
                              </div>
                            )}
                          </>
                        )}
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-1.5 border-t border-border-subtle pt-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onConnectRecentSSH(connectable)}
                            className="rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 transition-colors"
                          >
                            Terminal
                          </button>
                          <SftpButton
                            authType={connectable.authType}
                            onOpen={() => onConnectSFTP(connectable)}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => handleAskAiAboutServer(server)}
                          className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/20 transition-colors"
                        >
                          <Sparkles className="h-3 w-3" />
                          Fråga AI
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right Column: Team Activity, Shared AI Memory & Runbooks (KB) */}
            <div
              data-testid="workspace-right-column"
              className="flex flex-col justify-between gap-3 rounded-xl border border-border-subtle bg-app-surface-subtle p-3.5"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Activity className="h-4 w-4 text-amber-400" />
                    <h2 className="text-xs font-bold uppercase tracking-wider text-txt-primary">
                      Teamets Aktivitet & AI-Minne
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new CustomEvent('sshs3:ai-open'))}
                    className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-300 hover:bg-sky-500/20"
                  >
                    <Bot className="h-3 w-3" /> Öppna AI
                  </button>
                </div>

                {/* 3-Tab Switcher: Aktivitet / Team Memory / Runbooks (KB) */}
                <div
                  data-testid="workspace-right-tabs"
                  className="grid grid-cols-3 gap-1 rounded-lg border border-border-subtle bg-app-card p-1"
                >
                  <button
                    type="button"
                    data-testid="right-tab-activity"
                    onClick={() => setRightColTab('activity')}
                    className={`rounded-md px-2 py-1 text-[10.5px] font-semibold transition-all ${
                      rightColTab === 'activity'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                        : 'text-txt-muted hover:text-txt-primary'
                    }`}
                  >
                    📡 Aktivitet ({activityLog.length})
                  </button>
                  <button
                    type="button"
                    data-testid="right-tab-memory"
                    onClick={() => setRightColTab('memory')}
                    className={`rounded-md px-2 py-1 text-[10.5px] font-semibold transition-all ${
                      rightColTab === 'memory'
                        ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                        : 'text-txt-muted hover:text-txt-primary'
                    }`}
                  >
                    🧠 Minne ({hub?.memories?.length ?? 0})
                  </button>
                  <button
                    type="button"
                    data-testid="right-tab-kb"
                    onClick={() => setRightColTab('kb')}
                    className={`rounded-md px-2 py-1 text-[10.5px] font-semibold transition-all ${
                      rightColTab === 'kb'
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                        : 'text-txt-muted hover:text-txt-primary'
                    }`}
                  >
                    📚 Runbooks ({hub?.kbDocuments?.length ?? 0})
                  </button>
                </div>

                {rightColTab === 'activity' && (
                  <>
                    <p className="text-[11px] text-txt-muted">
                      Ändringar i konfiguration, tjänster och paket över alla VMs loggas här så både du, dina kompisar och AI:n har full koll.
                    </p>

                    {/* Quick Note Form */}
                    <form onSubmit={handleRecordTeamNote} className="space-y-1.5 rounded-lg border border-border-subtle bg-app-card p-2">
                      <div className="flex gap-1.5">
                        <select
                          value={noteTarget}
                          onChange={(e) => setNoteTarget(e.target.value)}
                          className="w-28 rounded border border-border-subtle bg-app px-1.5 py-1 text-[11px] text-txt-primary"
                        >
                          <option value="">Allmänt</option>
                          {workspaceServers.map((s) => (
                            <option key={s.id} value={s.name}>
                              {`${s.name} (${s.host})`}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={noteSummary}
                          onChange={(e) => setNoteSummary(e.target.value)}
                          placeholder="Logga en team-notis (t.ex. bytte port i nginx)…"
                          className="flex-1 rounded border border-border-subtle bg-app px-2 py-1 text-[11px] text-txt-primary placeholder:text-txt-muted outline-none"
                        />
                        <button
                          type="submit"
                          disabled={addingNote || !noteSummary.trim()}
                          className="rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                        >
                          Logga
                        </button>
                      </div>
                    </form>

                    {/* Activity List */}
                    <div className="space-y-2 max-h-[290px] overflow-y-auto pr-1">
                      {activityLog.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-txt-muted">
                          Inga loggade ändringar ännu. När någon i teamet ändrar konfiguration eller startar om en tjänst i terminalen dyker det upp här automatiskt.
                        </div>
                      ) : (
                        activityLog.map((ev) => (
                          <div
                            key={ev.id}
                            className="rounded-lg border border-border-subtle bg-app-card p-2.5 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-semibold text-txt-primary truncate">
                                {ev.actor}{' '}
                                <span className="font-normal text-txt-muted">på</span>{' '}
                                <span className="text-sky-400">{ev.targetLabel}</span>
                              </span>
                              <span className="shrink-0 text-[10px] text-txt-muted">
                                {formatRelativeTime(ev.at)}
                              </span>
                            </div>
                            <p className="text-[11px] text-txt-secondary">{ev.summary}</p>
                            {ev.detail && (
                              <pre className="rounded bg-app px-2 py-1 text-[10px] font-mono text-txt-muted overflow-x-auto">
                                {ev.detail}
                              </pre>
                            )}
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() => handleAskAiAboutActivity(ev)}
                                className="inline-flex items-center gap-1 text-[10px] text-sky-400 hover:underline"
                              >
                                <Sparkles className="h-2.5 w-2.5" /> Fråga AI om denna ändring
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )}

                {rightColTab === 'memory' && (
                  <div data-testid="right-panel-memory" className="space-y-2.5">
                    <p className="text-[11px] text-txt-muted">
                      Delat AI-minne &amp; Skills synkas i ert S3 Team Workspace och injiceras automatiskt i AI:ns kontext.
                    </p>

                    <form
                      onSubmit={handleSaveTeamMemory}
                      className="space-y-1.5 rounded-lg border border-sky-500/30 bg-app-card p-2"
                    >
                      <div className="flex gap-1.5">
                        <select
                          value={memKind}
                          onChange={(e) => setMemKind(e.target.value as 'memory' | 'skill')}
                          className="rounded border border-border-subtle bg-app px-1.5 py-1 text-[10.5px] text-txt-primary"
                        >
                          <option value="memory">🧠 Minne</option>
                          <option value="skill">⚡ Skill</option>
                        </select>
                        <input
                          type="text"
                          value={memTitle}
                          onChange={(e) => setMemTitle(e.target.value)}
                          placeholder="Titel (t.ex. Nginx reload-rutin)…"
                          className="flex-1 rounded border border-border-subtle bg-app px-2 py-1 text-[11px] text-txt-primary placeholder:text-txt-muted outline-none"
                        />
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={memText}
                          onChange={(e) => setMemText(e.target.value)}
                          placeholder="Innehåll / kommando som AI:n ska minnas…"
                          className="flex-1 rounded border border-border-subtle bg-app px-2 py-1 text-[11px] text-txt-primary placeholder:text-txt-muted outline-none"
                        />
                        <button
                          type="submit"
                          disabled={addingMemory || !memTitle.trim() || !memText.trim()}
                          className="rounded bg-sky-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-sky-500 disabled:opacity-40"
                        >
                          Spara
                        </button>
                      </div>
                    </form>

                    <div className="space-y-2 max-h-[270px] overflow-y-auto pr-1">
                      {(hub?.memories ?? []).length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-txt-muted">
                          Inga sparade team-minnen ännu. Lägg till ett minne eller en skill ovan!
                        </div>
                      ) : (
                        (hub?.memories ?? []).map((mem) => (
                          <div
                            key={mem.id}
                            className="rounded-lg border border-border-subtle bg-app-card p-2.5 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-semibold text-txt-primary truncate">
                                {mem.kind === 'skill' ? '⚡' : '🧠'} {mem.title}
                              </span>
                              <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-sky-300">
                                {mem.scope === 'workspace' ? 'Team S3' : mem.scope}
                              </span>
                            </div>
                            <p className="text-[11px] text-txt-secondary line-clamp-2">{mem.text}</p>
                            <div className="flex justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  window.dispatchEvent(
                                    new CustomEvent('sshs3:ai-open', {
                                      detail: {
                                        view: 'Work',
                                        mode: 'panel',
                                        prompt: `Använd vårt team-minne "${mem.title}" (${mem.text}) och hjälp mig applicera det.`,
                                      },
                                    })
                                  )
                                }
                                className="inline-flex items-center gap-1 text-[10px] text-sky-400 hover:underline"
                              >
                                <Sparkles className="h-2.5 w-2.5" /> Kör i AI med detta minne
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}

                {rightColTab === 'kb' && (
                  <div data-testid="right-panel-kb" className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] text-txt-muted">
                        Runbooks, arkitekturdokument och post-mortems i Knowledge Base (`@kb`).
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent('sshs3:ai-open', {
                              detail: { view: 'Knowledge Base', mode: 'hub' },
                            })
                          )
                        }
                        className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 hover:bg-emerald-500/25"
                      >
                        Hantera KB ↗
                      </button>
                    </div>

                    <div className="space-y-2 max-h-[310px] overflow-y-auto pr-1">
                      {(hub?.kbDocuments ?? []).length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border-subtle p-4 text-center text-xs text-txt-muted">
                          Inga Runbooks i Knowledge Base ännu. Öppna KB i AI Hub för att lägga till dokumentation.
                        </div>
                      ) : (
                        (hub?.kbDocuments ?? []).map((doc) => (
                          <div
                            key={doc.id}
                            className="rounded-lg border border-border-subtle bg-app-card p-2.5 text-xs space-y-1.5"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="font-semibold text-txt-primary truncate">
                                📘 {doc.title}
                              </span>
                              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9.5px] font-semibold text-emerald-300">
                                {doc.collection}
                              </span>
                            </div>
                            <p className="text-[11px] text-txt-secondary line-clamp-2">
                              {doc.content}
                            </p>
                            <div className="flex items-center justify-between pt-0.5">
                              <div className="flex flex-wrap gap-1">
                                {(doc.tags ?? []).slice(0, 3).map((t) => (
                                  <span
                                    key={t}
                                    className="rounded bg-app px-1.5 py-0.2 text-[9.5px] text-txt-muted"
                                  >
                                    #{t}
                                  </span>
                                ))}
                              </div>
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
                                className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-300 hover:underline"
                              >
                                <Sparkles className="h-2.5 w-2.5" /> Kör Runbook med AI
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Keyboard hints footer */}
        <div className="pt-2 text-2xs text-txt-muted flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
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
