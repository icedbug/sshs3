import type {
  MemoryEntry,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";

export function isDemoMode(): boolean {
  return (
    process.env.SSHS3_DEMO === "1" ||
    process.argv.includes("--demo")
  );
}

const now = Date.now();
const min = 60_000;

const initialDemoServers: WorkspaceServerSummary[] = [
  {
    id: "demo-prod-api-01",
    name: "prod-api-01",
    host: "10.20.1.10",
    port: 22,
    username: "deploy",
    folder: "Acme Cloud / Prod",
    group: "Acme Cloud / Prod",
    cluster: "Acme-Prod-Core",
    nodeRole: "ingress",
    role: "web",
    description:
      "Primär API-gateway och Nginx reverse proxy framför Node/Go-tjänsterna i /opt/acme-api. Hanterar TLS och SSE-strömmar.",
    tags: ["nginx", "docker", "prod", "tls", "edge-node"],
    shared: true,
    updatedAt: new Date(now - 12 * min).toISOString(),
    updatedBy: "erik@acme.se",
  },
  {
    id: "demo-prod-db-primary",
    name: "prod-db-primary",
    host: "10.20.1.25",
    port: 22,
    username: "postgres",
    folder: "Acme Cloud / Prod",
    group: "Acme Cloud / Prod",
    cluster: "Acme-Prod-Core",
    nodeRole: "primary-db",
    role: "database",
    description:
      "Primär PostgreSQL 16-databas med pgBackRest-backup till S3 och PgBouncer connection-pool på port 6432.",
    tags: ["postgresql", "pgbouncer", "s3-backup", "prod", "nvme"],
    shared: true,
    updatedAt: new Date(now - 45 * min).toISOString(),
    updatedBy: "sara@acme.se",
  },
  {
    id: "demo-worker-queue-02",
    name: "worker-queue-02",
    host: "10.20.1.42",
    port: 22,
    username: "ubuntu",
    folder: "Acme Cloud / Prod",
    group: "Acme Cloud / Prod",
    cluster: "Acme-Prod-Core",
    nodeRole: "worker-node",
    role: "worker",
    description:
      "Bakgrundsjobb, Redis-köer och schemalagda synk-workers (systemd: acme-worker.service).",
    tags: ["redis", "systemd", "worker", "queues"],
    shared: true,
    updatedAt: new Date(now - 180 * min).toISOString(),
    updatedBy: "jacob",
  },
  {
    id: "demo-k8s-eu-north",
    name: "k8s-eu-north-cp1",
    host: "10.20.2.100",
    port: 22,
    username: "ubuntu",
    folder: "Acme Cloud / Kubernetes",
    group: "Acme Cloud / Kubernetes",
    cluster: "k8s-eu-north-1",
    nodeRole: "control-plane",
    role: "k8s",
    description:
      "Kontrollplan & API-server för Kubernetes-klustret i Stockholm (eu-north-1). Kör etcd, ArgoCD, Ingress-Nginx och Prometheus.",
    tags: ["k8s", "control-plane", "etcd", "argocd", "prometheus"],
    shared: true,
    updatedAt: new Date(now - 110 * min).toISOString(),
    updatedBy: "erik@acme.se",
  },
  {
    id: "demo-k8s-gpu-worker-01",
    name: "k8s-gpu-worker-01",
    host: "10.20.2.114",
    port: 22,
    username: "ubuntu",
    folder: "Acme Cloud / Kubernetes",
    group: "Acme Cloud / Kubernetes",
    cluster: "k8s-eu-north-1",
    nodeRole: "gpu-node",
    role: "k8s",
    description:
      "Kubernetes GPU-workernod (2x NVIDIA L40S) för AI-inferens, embeddings och tunga batch-pods.",
    tags: ["k8s", "gpu-node", "nvidia", "containerd", "prod"],
    shared: true,
    updatedAt: new Date(now - 95 * min).toISOString(),
    updatedBy: "jacob",
  },
  {
    id: "demo-staging-bastion",
    name: "staging-bastion",
    host: "192.168.50.10",
    port: 22,
    username: "jacob",
    folder: "Staging & Lab",
    group: "Staging & Lab",
    cluster: "Staging-Lab",
    nodeRole: "bastion",
    role: "bastion",
    description:
      "Personlig jump-host och testmiljö för nya konfigurationer innan de rullas ut i Team Vault.",
    tags: ["bastion", "staging", "wireguard"],
    shared: false,
    updatedAt: new Date(now - 240 * min).toISOString(),
    updatedBy: "jacob",
  },
];

const initialDemoActivity: WorkspaceActivityEvent[] = [
  {
    id: "demo-act-1",
    profileId: "demo-prod-api-01",
    targetLabel: "prod-api-01",
    actor: "erik",
    kind: "config-edit",
    summary:
      "Edited file/config: /etc/nginx/sites-enabled/acme.conf (höjde proxy_read_timeout till 120s och slog av proxy_buffering för SSE)",
    detail: "sudo vim /etc/nginx/sites-enabled/acme.conf && sudo systemctl reload nginx",
    at: now - 12 * min,
  },
  {
    id: "demo-act-2",
    profileId: "demo-prod-db-primary",
    targetLabel: "prod-db-primary",
    actor: "sara",
    kind: "service",
    summary:
      "Service operation: systemctl reload postgresql (ökade max_connections från 150 till 300 i postgresql.conf)",
    detail: "sudo systemctl reload postgresql",
    at: now - 45 * min,
  },
  {
    id: "demo-act-3",
    profileId: "demo-k8s-eu-north",
    targetLabel: "k8s-eu-north-1",
    actor: "erik",
    kind: "deploy",
    summary:
      "Cluster/Infra deployment: kubectl rollout restart deployment/checkout-service -n prod",
    detail: "kubectl rollout restart deployment/checkout-service -n prod",
    at: now - 110 * min,
  },
  {
    id: "demo-act-4",
    profileId: "demo-worker-queue-02",
    targetLabel: "worker-queue-02",
    actor: "jacob (AI)",
    kind: "ai-action",
    summary:
      "Rensade roterade journalctl-loggar när /var/log nådde 88% och verifierade att acme-worker.service är active (running)",
    detail: "sudo journalctl --vacuum-size=500M && systemctl is-active acme-worker.service",
    at: now - 180 * min,
  },
];

const initialDemoMemories: MemoryEntry[] = [
  {
    id: "demo-mem-1",
    kind: "memory",
    scope: "workspace",
    title: "Nginx SSE & Timeout-konfiguration på prod-api-01",
    text: "Erik uppdaterade /etc/nginx/sites-enabled/acme.conf på prod-api-01 (10.20.1.10): proxy_read_timeout är nu 120s och proxy_buffering off för /api/stream så att AI- och event-strömmar inte klipps efter 60 sekunder.",
    author: "erik",
    updatedAt: now - 12 * min,
  },
  {
    id: "demo-mem-2",
    kind: "memory",
    scope: "workspace",
    title: "PostgreSQL max_connections & PgBouncer på prod-db-primary",
    text: "Sara höjde max_connections till 300 i /etc/postgresql/16/main/postgresql.conf på prod-db-primary (10.20.1.25). Applikationer ska ansluta via PgBouncer på port 6432.",
    author: "sara",
    updatedAt: now - 45 * min,
  },
  {
    id: "demo-skill-1",
    kind: "skill",
    scope: "workspace",
    title: "Runbook: Felsök 502 Bad Gateway på prod-api-01",
    text: "1. Kontrollera `sudo nginx -t` och `systemctl status nginx`.\n2. Inspektera `/var/log/nginx/error.log` (senaste 50 raderna).\n3. Verifiera att upstream-containrarna i `/opt/acme-api` körs via `docker compose ps`.\n4. Kontrollera om någon i teamet nyligen ändrat `/etc/nginx/sites-enabled/acme.conf` i aktivitetsloggen.",
    author: "jacob",
    updatedAt: now - 200 * min,
  },
];

const demoServersStore = new Map<string, WorkspaceServerSummary>(
  initialDemoServers.map((s) => [s.id, { ...s }]),
);
const demoActivityStore: WorkspaceActivityEvent[] = [...initialDemoActivity];
const demoMemoriesStore: MemoryEntry[] = [...initialDemoMemories];

export function getDemoServers(): WorkspaceServerSummary[] {
  return Array.from(demoServersStore.values());
}

export function updateDemoServer(input: {
  profileId: string;
  cluster?: string;
  nodeRole?: string;
  description?: string;
  role?: string;
  tags?: string[];
}): boolean {
  const existing = demoServersStore.get(input.profileId);
  if (!existing) return false;
  demoServersStore.set(input.profileId, {
    ...existing,
    cluster:
      input.cluster !== undefined
        ? input.cluster.trim() || undefined
        : existing.cluster,
    nodeRole:
      input.nodeRole !== undefined
        ? input.nodeRole.trim() || undefined
        : existing.nodeRole,
    description: input.description?.trim() || undefined,
    role: input.role?.trim() || undefined,
    tags: input.tags?.length ? input.tags : undefined,
    updatedAt: new Date().toISOString(),
    updatedBy: "jacob (demo)",
  });
  return true;
}

export function upsertDemoServer(input: {
  id: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  folder?: string;
  cluster?: string;
  nodeRole?: string;
  role?: string;
  description?: string;
  tags?: string[];
  shared?: boolean;
}): WorkspaceServerSummary {
  const existing = demoServersStore.get(input.id);
  const next: WorkspaceServerSummary = {
    ...existing,
    id: input.id,
    name: input.name.trim(),
    host: input.host.trim(),
    port: input.port || 22,
    username: input.username.trim() || "root",
    folder: input.folder?.trim() || input.cluster?.trim() || existing?.folder,
    group: input.folder?.trim() || input.cluster?.trim() || existing?.group,
    cluster: input.cluster?.trim() || undefined,
    nodeRole: input.nodeRole?.trim() || undefined,
    role: input.role?.trim() || undefined,
    description: input.description?.trim() || undefined,
    tags: input.tags?.length ? input.tags : undefined,
    shared: input.shared ?? true,
    updatedAt: new Date().toISOString(),
    updatedBy: "jacob",
  };
  demoServersStore.set(next.id, next);
  return next;
}

export function getDemoActivityLog(): WorkspaceActivityEvent[] {
  return [...demoActivityStore];
}

export function appendDemoActivity(event: WorkspaceActivityEvent): void {
  const idx = demoActivityStore.findIndex((e) => e.id === event.id);
  if (idx >= 0) demoActivityStore[idx] = event;
  else demoActivityStore.unshift(event);
}

export function getDemoMemories(): MemoryEntry[] {
  return [...demoMemoriesStore];
}

export function saveDemoMemory(entry: MemoryEntry): void {
  const idx = demoMemoriesStore.findIndex((m) => m.id === entry.id);
  if (idx >= 0) demoMemoriesStore[idx] = entry;
  else demoMemoriesStore.unshift(entry);
}

export function deleteDemoMemory(id: string): void {
  const idx = demoMemoriesStore.findIndex((m) => m.id === id);
  if (idx >= 0) demoMemoriesStore.splice(idx, 1);
}
