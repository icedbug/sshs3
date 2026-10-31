import net from "node:net";
import type {
  InfraGraphEdge,
  InventoryEntry,
  AgentTask,
  MemoryEntry,
  WorkforceRun,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import type { HubStore } from "./HubStore";
import type { TerminalRegistry } from "./TerminalRegistry";

export interface InventoryTarget {
  id: string;
  kind: InventoryEntry["kind"];
  label: string;
  address: string;
  port: number;
  blocked?: string;
}

export function scopedMemory(
  entries: MemoryEntry[],
  scope: string,
  skills: boolean,
): MemoryEntry[] {
  return entries.filter(
    (m) =>
      (m.scope === "personal" ||
        m.scope === "workspace" ||
        m.scope === "workspace:all" ||
        m.scope === scope ||
        (m.scope.startsWith("target:k8s:") &&
          scope.startsWith(m.scope + "/"))) &&
      (m.kind === "skill") === skills,
  );
}

export interface ExtraWorkspaceContext {
  workspaceServers?: WorkspaceServerSummary[];
  activityLog?: WorkspaceActivityEvent[];
  memories?: MemoryEntry[];
  folders?: string[];
  s3Profiles?: Array<{
    id: string;
    name: string;
    endpoint?: string;
    region?: string;
    bucket?: string;
    group?: string;
  }>;
  s3TeamWorkspace?: unknown;
  schedules?: unknown[];
  snippets?: unknown[];
  dotfilesPools?: unknown[];
  dirSyncProfiles?: unknown[];
  activeTunnels?: unknown[];
  appSettings?: Record<string, unknown>;
  agents?: unknown[];
  mcpServers?: unknown[];
  kbDocuments?: unknown[];
  infraEdges?: InfraGraphEdge[];
  workforceRuns?: WorkforceRun[];
  terminalContextChars?: number;
}

export class ContextService {
  private refreshing = false;
  constructor(
    private readonly store: HubStore,
    private readonly terminals: TerminalRegistry,
    private readonly targets: () => Promise<InventoryTarget[]>,
  ) {}

  read(
    task: AgentTask,
    query = "",
    sessionIdOverride?: string,
    extra?: ExtraWorkspaceContext,
  ): unknown {
    const q = query.toLowerCase().slice(0, 500);
    const id =
      sessionIdOverride ??
      task.target?.sessionId ??
      this.terminals.list()[0]?.id;
    const termChars = Math.max(
      1000,
      Math.min(64_000, extra?.terminalContextChars ?? 8000),
    );
    const allTerminals = this.terminals.list().map((t) => ({
      ...t,
      recentOutput: this.terminals.context(t.id).slice(-Math.min(termChars, 12_000)),
    }));
    const activitySource =
      extra?.activityLog ?? this.store.data.activityLog ?? [];
    const memorySource = extra?.memories ?? this.store.data.memories;
    const servers = extra?.workspaceServers ?? [];
    const clusterMap = new Map<string, string[]>();
    for (const s of servers) {
      if (s.cluster) {
        const list = clusterMap.get(s.cluster) ?? [];
        list.push(`${s.name} (${s.host}${s.nodeRole ? `, ${s.nodeRole}` : ""})`);
        clusterMap.set(s.cluster, list);
      }
    }
    const clusters = Array.from(clusterMap.entries()).map(([name, nodes]) => ({
      cluster: name,
      nodeCount: nodes.length,
      nodes,
    }));
    return {
      observedAt: Date.now(),
      terminals: allTerminals,
      clusters,
      folders: extra?.folders ?? [],
      s3Profiles: extra?.s3Profiles ?? [],
      s3TeamWorkspace: extra?.s3TeamWorkspace ?? null,
      schedules: extra?.schedules ?? this.store.data.schedules ?? [],
      snippets: extra?.snippets ?? [],
      dotfilesPools: extra?.dotfilesPools ?? [],
      dirSyncProfiles: extra?.dirSyncProfiles ?? [],
      activeTunnels: extra?.activeTunnels ?? [],
      appSettings: extra?.appSettings ?? {},
      agents: extra?.agents ?? this.store.data.agents ?? [],
      mcpServers: extra?.mcpServers ?? this.store.data.mcpServers ?? [],
      kbDocuments: extra?.kbDocuments ?? [],
      infraDependencyGraph: extra?.infraEdges ?? this.store.data.infraEdges ?? [],
      recentWorkforceRuns: (extra?.workforceRuns ?? this.store.data.workforceRuns ?? []).slice(0, 5),
      workspaceServers: servers.filter(
        (s) =>
          !q ||
          `${s.name} ${s.host} ${s.cluster ?? ""} ${s.nodeRole ?? ""} ${s.description ?? ""} ${s.role ?? ""} ${(s.tags ?? []).join(" ")}`
            .toLowerCase()
            .includes(q),
      ),
      recentTeamActivity: activitySource
        .filter(
          (a) =>
            !q ||
            `${a.targetLabel} ${a.actor} ${a.summary} ${a.detail ?? ""}`
              .toLowerCase()
              .includes(q),
        )
        .slice(-30),
      workspaceMemories: memorySource
        .filter(
          (m) =>
            !q ||
            `${m.title} ${m.text} ${m.scope}`.toLowerCase().includes(q),
        )
        .slice(-40),
      inventory: this.store.data.inventory,
      target: id
        ? {
            session: this.terminals.get(id),
            output: this.terminals.context(id).slice(-termChars),
            source: `terminal:${id}`,
            uncertainty:
              "Output may be incomplete; command results are the completion evidence.",
          }
        : null,
      attachments: task.sources
        .filter(
          (s) =>
            !s.imageDataUrl &&
            (!q || `${s.label} ${s.text}`.toLowerCase().includes(q)),
        )
        .map((s) => ({
          id: s.id,
          label: s.label,
          text: s.text,
          observedAt: s.observedAt,
        })),
      history: this.store.data.history
        .filter(
          (s) =>
            (!id || s.id === `terminal:${id}`) &&
            (!q || s.text.toLowerCase().includes(q)),
        )
        .slice(-10),
    };
  }

  async inventory(probe: boolean): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const targets = await this.targets();
      const results: InventoryEntry[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: 3 }, async () => {
          while (next < targets.length) {
            const target = targets[next++];
            const row: InventoryEntry = {
              id: target.id,
              kind: target.kind,
              label: target.label,
              address: target.address,
              status: "unknown",
              detail: "Not checked",
              observedAt: Date.now(),
            };
            if (target.blocked) {
              row.status = "blocked";
              row.detail = target.blocked;
            } else if (probe) {
              row.status = (await reachable(target.address, target.port))
                ? "reachable"
                : "unreachable";
              row.detail =
                row.status === "reachable"
                  ? "TCP endpoint responds; authentication and service health not verified."
                  : "TCP endpoint did not respond; cause unknown.";
            }
            results.push(row);
          }
        }),
      );
      this.store.data.inventory = results.sort((a, b) =>
        a.label.localeCompare(b.label),
      );
    } finally {
      this.refreshing = false;
    }
  }
}

function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }
    const socket = net.connect({ host, port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(3000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
