import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentSchedule,
  AgentTask,
  ContextSource,
  HubPreferences,
  InfraGraphEdge,
  InventoryEntry,
  KbDocument,
  LocalServerAuthOverride,
  McpServerConfig,
  MemoryEntry,
  MissionAgent,
  SafetyPolicyConfig,
  WorkforceRun,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import { maskContext } from "./privacy";

export interface SharedWorkspaceFilePayload {
  version: 1;
  updatedAt: number;
  servers: WorkspaceServerSummary[];
  memories: MemoryEntry[];
  activityLog: WorkspaceActivityEvent[];
  agents?: MissionAgent[];
  kbDocuments?: KbDocument[];
  infraEdges?: InfraGraphEdge[];
  deletedServerIds?: Record<string, string>;
  deletedMemoryIds?: Record<string, number>;
}

export interface HubData {
  version: 1;
  preferences: HubPreferences;
  tasks: AgentTask[];
  memories: MemoryEntry[];
  schedules: AgentSchedule[];
  inventory: InventoryEntry[];
  history: ContextSource[];
  activityLog: WorkspaceActivityEvent[];
  agents?: MissionAgent[];
  mcpServers?: McpServerConfig[];
  kbDocuments?: KbDocument[];
  infraEdges?: InfraGraphEdge[];
  workforceRuns?: WorkforceRun[];
  safetyPolicy?: SafetyPolicyConfig;
  localOverrides?: Record<string, LocalServerAuthOverride>;
  deletedServerIds?: Record<string, string>;
  deletedMemoryIds?: Record<string, number>;
  s3SyncedServers?: WorkspaceServerSummary[];
}
export const defaultHubData = (): HubData => ({
  version: 1,
  preferences: {
    background: false,
    autoStart: false,
    inventory: false,
    retentionDays: 30,
  },
  tasks: [],
  memories: [],
  schedules: [],
  inventory: [],
  history: [],
  activityLog: [],
  agents: [],
  mcpServers: [],
  kbDocuments: [],
  infraEdges: [],
  workforceRuns: [],
  safetyPolicy: {
    autoApproveSafeReadOnly: true,
    requireApprovalOnProdTags: true,
    blockDestructiveWithoutConfirm: true,
  },
  localOverrides: {},
  deletedServerIds: {},
  deletedMemoryIds: {},
  s3SyncedServers: [],
});

/** One process owns the store. Serial atomic replacements preserve the last valid snapshot. */
export class HubStore {
  data = defaultHubData();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = (await fs.readFile(this.file, "utf8")).replace(/^\uFEFF/, "").trim();
      if (!raw) {
        this.data = defaultHubData();
        return;
      }
      const value = JSON.parse(raw) as HubData;
      if (
        value.version !== 1 ||
        !Array.isArray(value.tasks) ||
        !Array.isArray(value.memories) ||
        !Array.isArray(value.schedules) ||
        !Array.isArray(value.history) ||
        !Array.isArray(value.inventory)
      ) {
        throw new Error("Unsupported AI Hub store");
      }
      this.data = {
        ...defaultHubData(),
        ...value,
        preferences: { ...defaultHubData().preferences, ...value.preferences },
      };
      for (const task of this.data.tasks) {
        if (["running", "queued", "waiting"].includes(task.status)) {
          task.status = "interrupted";
          task.error =
            "The application stopped. Inspect the terminal before resuming; no command was replayed.";
          task.verification = "incomplete";
          for (const change of task.changes) {
            if (["running", "approved"].includes(change.status))
              change.status = "uncertain";
            if (change.status === "pending") change.status = "denied";
          }
        }
      }
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      try {
        await fs.copyFile(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch {
        // Ignore backup failure
      }
      this.data = defaultHubData();
    }
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.data.preferences.retentionDays * 86_400_000;
    const historyById = new Map<string, ContextSource>();
    for (const entry of this.data.history) {
      if (entry.observedAt >= cutoff) {
        const prev = historyById.get(entry.id);
        if (!prev || entry.observedAt >= prev.observedAt) {
          historyById.set(entry.id, entry);
        }
      }
    }
    this.data.history = Array.from(historyById.values()).slice(-200);
    this.data.activityLog = (this.data.activityLog ?? [])
      .filter((x) => x.at >= cutoff)
      .slice(-500);
    this.data.tasks = this.data.tasks.filter(
      (x) =>
        x.updatedAt >= cutoff ||
        ["queued", "running", "waiting"].includes(x.status),
    );
    for (const task of this.data.tasks)
      task.sources = task.sources.filter((s) => s.observedAt >= cutoff);
  }

  save(): Promise<void> {
    this.prune();
    // Serialize a detached, redacted copy; never mutate live state during an asynchronous write.
    const clean = (value: unknown): unknown =>
      typeof value === "string"
        ? maskContext(value)
        : Array.isArray(value)
          ? value.map(clean)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [k, clean(v)]),
              )
            : value;
    const content = JSON.stringify(clean(this.data));
    const write = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, this.file);
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /**
   * Synchronizes and merges shared workspace state (servers/clusters, memories/skills,
   * and terminal activity log) with a shared JSON file on disk (e.g., Git repo,
   * OneDrive/Dropbox, or SMB/NFS team folder).
   */
  async syncSharedFile(
    sharedPath?: string,
    localServers: WorkspaceServerSummary[] = [],
  ): Promise<{ servers: WorkspaceServerSummary[]; changed: boolean }> {
    const targetPath = (
      sharedPath ||
      this.data.preferences.sharedWorkspacePath ||
      process.env.SSHS3_SHARED_WORKSPACE_FILE ||
      ""
    ).trim();
    if (!targetPath) return { servers: localServers, changed: false };

    let remote: Partial<SharedWorkspaceFilePayload> = {};
    try {
      const raw = (await fs.readFile(targetPath, "utf8")).replace(/^\uFEFF/, "");
      remote = JSON.parse(raw) as Partial<SharedWorkspaceFilePayload>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return { servers: localServers, changed: false };
      }
    }

    let changed = false;

    const parseTimeMs = (v: unknown): number => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim()) {
        const asNum = Number(v);
        if (Number.isFinite(asNum)) return asNum;
        const parsed = Date.parse(v);
        if (Number.isFinite(parsed)) return parsed;
      }
      return 0;
    };

    // 0. Merge tombstones (deletedServerIds & deletedMemoryIds)
    const deletedServerIds: Record<string, string> = {
      ...(this.data.deletedServerIds ?? {}),
    };
    if (remote.deletedServerIds && typeof remote.deletedServerIds === "object") {
      for (const [id, iso] of Object.entries(remote.deletedServerIds)) {
        if (!id || !iso) continue;
        const curMs = parseTimeMs(deletedServerIds[id]);
        const remMs = parseTimeMs(iso);
        if (remMs > curMs) {
          deletedServerIds[id] = String(iso);
          changed = true;
        }
      }
    }
    this.data.deletedServerIds = deletedServerIds;

    const deletedMemoryIds: Record<string, number> = {
      ...(this.data.deletedMemoryIds ?? {}),
    };
    if (remote.deletedMemoryIds && typeof remote.deletedMemoryIds === "object") {
      for (const [id, ts] of Object.entries(remote.deletedMemoryIds)) {
        if (!id || typeof ts !== "number") continue;
        if (ts > (deletedMemoryIds[id] ?? 0)) {
          deletedMemoryIds[id] = ts;
          changed = true;
        }
      }
    }
    this.data.deletedMemoryIds = deletedMemoryIds;

    // 1. Merge memories by id (latest updatedAt wins, respecting tombstones)
    const memMap = new Map<string, MemoryEntry>();
    for (const m of this.data.memories) {
      if ((deletedMemoryIds[m.id] ?? 0) >= (m.updatedAt ?? 0)) continue;
      memMap.set(m.id, m);
    }
    for (const rm of Array.isArray(remote.memories) ? remote.memories : []) {
      if (!rm || typeof rm.id !== "string") continue;
      if ((deletedMemoryIds[rm.id] ?? 0) >= (rm.updatedAt ?? 0)) continue;
      const prev = memMap.get(rm.id);
      if (!prev || (rm.updatedAt ?? 0) > (prev.updatedAt ?? 0)) {
        memMap.set(rm.id, rm);
        changed = true;
      }
    }
    this.data.memories = Array.from(memMap.values());

    // 2. Merge activityLog by id
    const actMap = new Map<string, WorkspaceActivityEvent>();
    for (const a of this.data.activityLog ?? []) actMap.set(a.id, a);
    for (const ra of Array.isArray(remote.activityLog) ? remote.activityLog : []) {
      if (!ra || typeof ra.id !== "string") continue;
      if (!actMap.has(ra.id)) {
        actMap.set(ra.id, ra);
        changed = true;
      }
    }
    this.data.activityLog = Array.from(actMap.values())
      .sort((a, b) => a.at - b.at)
      .slice(-500);

    // 3. Merge servers by id (latest updatedAt wins, respecting tombstones)
    const srvMap = new Map<string, WorkspaceServerSummary>();
    for (const rs of Array.isArray(remote.servers) ? remote.servers : []) {
      if (rs && typeof rs.id === "string" && rs.host && rs.shared !== false) {
        const delMs = Math.max(
          parseTimeMs(deletedServerIds[rs.id]),
          parseTimeMs(rs.deletedAt),
        );
        const updMs = parseTimeMs(rs.updatedAt);
        if (delMs > 0 && delMs >= updMs) continue;
        if (delMs > 0 && updMs > delMs) {
          delete deletedServerIds[rs.id];
        }
        srvMap.set(rs.id, { ...rs, shared: true });
      }
    }
    for (const ls of localServers) {
      const delMs = Math.max(
        parseTimeMs(deletedServerIds[ls.id]),
        parseTimeMs(ls.deletedAt),
      );
      const updMs = parseTimeMs(ls.updatedAt);
      if (delMs > 0 && delMs >= updMs) continue;
      if (delMs > 0 && updMs > delMs) {
        delete deletedServerIds[ls.id];
      }
      const prev = srvMap.get(ls.id);
      if (!prev) {
        srvMap.set(ls.id, ls);
      } else {
        const tPrev = parseTimeMs(prev.updatedAt);
        if (updMs >= tPrev) {
          srvMap.set(ls.id, ls);
        }
      }
    }
    const mergedServers = Array.from(srvMap.values());

    // Persist redacted shared payload back to targetPath (excluding personal servers)
    try {
      const payload: SharedWorkspaceFilePayload = {
        version: 1,
        updatedAt: Date.now(),
        servers: mergedServers.filter((s) => s.shared !== false),
        memories: this.data.memories.filter((m) => m.scope !== "personal"),
        activityLog: this.data.activityLog,
        deletedServerIds,
        deletedMemoryIds,
      };
      const clean = (value: unknown): unknown =>
        typeof value === "string"
          ? maskContext(value)
          : Array.isArray(value)
            ? value.map(clean)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value).map(([k, v]) => [k, clean(v)]),
                )
              : value;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      const tmp = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(tmp, JSON.stringify(clean(payload), null, 2), "utf8");
      await fs.rename(tmp, targetPath);
    } catch {
      // Non-fatal if shared path is temporarily read-only or unavailable
    }

    return { servers: mergedServers, changed };
  }
}
