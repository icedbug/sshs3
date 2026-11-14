import { sanitizeServerForS3 } from "./S3WorkspaceSyncService";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../storage/atomicFile";
import type {
  AgentSchedule,
  AgentTask,
  ContextSource,
  HubPreferences,
  InfraGraphEdge,
  InventoryEntry,
  KbDocument,
  LocalServerAuthOverride,
  MemoryDistillStatus,
  MemoryProposal,
  McpServerConfig,
  MemoryEntry,
  MissionAgent,
  SafetyPolicyConfig,
  SelfLearningEvent,
  WorkforceRun,
  WorkGoal,
  WorkTicket,
  AgentUsage,
  EvalCase,
  ExternalRunner,
  KbFinding,
  KbGap,
  KbPage,
  KbPageUse,
  WorkspaceActivityEvent,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import { maskContext } from "./privacy";
import {
  decryptSecretValue,
  encryptSecretValue,
} from "../../crypto/SecretFieldCrypto";

/**
 * Parts of the store that the user wrote as configuration or documents. They
 * are saved as written: masking them would rewrite a runbook that mentions
 * `password=…` and replace an MCP server's `Bearer` token with `[redacted]`,
 * so it no longer authenticates after a restart. Everything else in the store
 * is captured context (terminal output, messages, command results) and is
 * masked on its way to disk. All of it is masked again before it reaches a
 * model or a teammate (boundedContext, the sync payloads).
 */
const SAVED_AS_WRITTEN = new Set<keyof HubData>([
  "kbDocuments",
  "mcpServers",
  "agents",
]);

/** An MCP server's credentials: its header and environment values, and a URL that may carry a password. */
function mapMcpSecrets(
  servers: McpServerConfig[] | undefined,
  transform: (value: string) => string,
): McpServerConfig[] | undefined {
  const values = (
    record: Record<string, string> | undefined,
  ): Record<string, string> | undefined =>
    record &&
    Object.fromEntries(
      Object.entries(record).map(([k, v]) => [
        k,
        typeof v === "string" ? transform(v) : v,
      ]),
    );
  return servers?.map((server) => ({
    ...server,
    ...(server.headers ? { headers: values(server.headers) } : {}),
    ...(server.env ? { env: values(server.env) } : {}),
    ...(server.url ? { url: transform(server.url) } : {}),
  }));
}

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

export interface PersistedSelfLearningState {
  recentEvents?: SelfLearningEvent[];
  failureToFixCount?: number;
  consolidatedCount?: number;
  autoDiscoveredEdgeCount?: number;
  lastReflectionAt?: number;
}

export interface HubData {
  version: 1;
  preferences: HubPreferences;
  tasks: AgentTask[];
  memories: MemoryEntry[];
  /** Suggested memories awaiting a person's decision; local, never synced. */
  memoryProposals?: MemoryProposal[];
  /** Ids of records already read for proposals, newest last, so none is read twice. */
  distilledSourceIds?: string[];
  lastMemoryDistill?: MemoryDistillStatus;
  /** Ids of records uploaded to the team's learning queue, so none is uploaded twice. */
  queuedSourceIds?: string[];
  /** When this user's own activity was last read for memories. */
  lastActivityDistillAt?: number;
  schedules: AgentSchedule[];
  inventory: InventoryEntry[];
  history: ContextSource[];
  activityLog: WorkspaceActivityEvent[];
  agents?: MissionAgent[];
  mcpServers?: McpServerConfig[];
  kbDocuments?: KbDocument[];
  infraEdges?: InfraGraphEdge[];
  workforceRuns?: WorkforceRun[];
  /** The board: goals and tickets, removals included so they reach teammates. */
  workGoals?: WorkGoal[];
  workTickets?: WorkTicket[];
  agentUsage?: Record<string, AgentUsage>;
  /** Removals of shared agents, runbooks and dependencies (id → when), so they reach teammates. */
  sharedRemoved?: Partial<Record<"agents" | "kb" | "edges" | "pages" | "evals", Record<string, number>>>;
  /** The secret alerts are posted with (only its hash), and what came in. */
  alertHook?: { hash: string; createdAt: number; lastAt?: number; received: number };
  alertRules?: { match: string; agentId: string }[];
  dailyReport?: { day: string; at: number; text: string; readAt?: number };
  /** The day (local, YYYY-MM-DD) the nightly upkeep last ran. */
  lastNightlyDay?: string;
  /** Reading facts from the servers: off unless switched on. */
  factsSettings?: { enabled?: boolean; intervalHours?: number; exclude?: string[]; watchPaths?: string[] };
  /** Test cases for the agents, with their recordings and latest runs. */
  evalCases?: EvalCase[];
  /** The pages agents read, written from the sources and from finished work. */
  kbPages?: KbPage[];
  /** Questions agents asked the knowledge base that found nothing. */
  kbGaps?: KbGap[];
  kbContradictions?: KbFinding[];
  kbDismissedFindings?: string[];
  /** How this installation's runs used the pages; shared per installation and added up (see `KbPageUse`). */
  kbUse?: Record<string, KbPageUse>;
  /** Set once the counts earlier versions kept on the pages themselves were moved to `kbUse`. */
  kbUseMoved?: boolean;
  /** Where the next comparison of pages starts, so that successive ones get through all pairs. */
  kbPairOffset?: number;
  /** External coding agents as they are started on this computer. Never shared. */
  externalRunners?: ExternalRunner[];
  /** Names this installation in ticket claims. */
  clientId?: string;
  safetyPolicy?: SafetyPolicyConfig;
  /** Who last changed the safety policy here, and when. */
  safetyPolicyChanged?: { by: string; at: number };
  selfLearningState?: PersistedSelfLearningState;
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
  selfLearningState: {
    recentEvents: [],
    failureToFixCount: 0,
    consolidatedCount: 0,
    autoDiscoveredEdgeCount: 0,
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
      this.data.mcpServers = mapMcpSecrets(
        this.data.mcpServers,
        decryptSecretValue,
      );
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
      // A workforce run cannot outlive the process that was running its specialists.
      for (const run of this.data.workforceRuns ?? []) {
        if (run.status !== "running") continue;
        run.status = "failed";
        run.error = "The application stopped before this run finished.";
        for (const step of run.steps)
          if (step.status === "queued" || step.status === "running") {
            step.status = "failed";
            step.error = run.error;
          }
      }
      this.prune();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      // Only a file that was read and is not a store is replaced, and only once it is kept aside. A file
      // that could not be read at all (locked by antivirus or a sync client, too many open files) is not
      // known to be broken: nothing is written over it, and the hub says so instead of starting empty.
      const unreadable = !(error instanceof SyntaxError) && (error as Error).message !== "Unsupported AI Hub store";
      if (unreadable) {
        this.writable = false;
        throw new Error(`The AI hub's data could not be read (${(error as Error).message}); nothing was changed. Close what holds the file open and start again.`, { cause: error });
      }
      try {
        await fs.copyFile(this.file, `${this.file}.corrupt-${Date.now()}`);
      } catch (copyError) {
        // Not kept aside, so not replaced either.
        this.writable = false;
        throw new Error(`The AI hub's data is not readable as a store, and could not be kept aside (${(copyError as Error).message}); nothing was changed.`, { cause: copyError });
      }
      this.data = defaultHubData();
    }
  }

  /** False after a load that could not read the file: a save would write over data that was never read. */
  private writable = true;

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
    if (!this.writable) return Promise.resolve();
    this.prune();
    // Serialize a detached, redacted copy; never mutate live state during an asynchronous write.
    // Image data is masked by nobody: base64 holds no secret a mask could find, and masking megabytes
    // of it froze the app for a second and a half per image on every save.
    const clean = (value: unknown): unknown =>
      typeof value === "string"
        ? value.startsWith("data:image/")
          ? value
          : maskContext(value)
        : Array.isArray(value)
          ? value.map(clean)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [k, clean(v)]),
              )
            : value;
    const content = JSON.stringify({
      ...Object.fromEntries(
        Object.entries(this.data).map(([key, value]) => [
          key,
          SAVED_AS_WRITTEN.has(key as keyof HubData) ? value : clean(value),
        ]),
      ),
      // Encrypted with the OS keyring where one exists (plain otherwise, as for saved profiles).
      mcpServers: mapMcpSecrets(this.data.mcpServers, encryptSecretValue),
    });
    const write = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, this.file).catch(async (error: unknown) => {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      });
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
      // A removal is of the team's copy: a server a person keeps to themselves is neither hidden by it nor takes it back.
      if (ls.shared === false) {
        if (!srvMap.has(ls.id)) srvMap.set(ls.id, ls);
        continue;
      }
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
        // A server's topology only, through the same allow-list the team bucket uses: never a key path,
        // a jump host, extra ssh options or tunnels (those are each person's own), nor a vault's servers.
        servers: mergedServers.filter((s) => s.shared !== false && !s.fromVault).map(sanitizeServerForS3),
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
      // Written only when what it says differs from what is there: reading the hub (every snapshot comes
      // here) rewrote the team's file, with a new date, every time anybody looked.
      const content = clean(payload) as SharedWorkspaceFilePayload;
      const same = (a: Partial<SharedWorkspaceFilePayload>, b: Partial<SharedWorkspaceFilePayload>): boolean =>
        JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
      // Several accounts' hubs write this one file: a rename that fails (Windows holds a file a reader
      // has open) is tried again, and its temporary file never stays behind.
      if (!same(content, remote)) await writeFileAtomic(targetPath, JSON.stringify(content, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal if shared path is temporarily read-only or unavailable
    }

    return { servers: mergedServers, changed };
  }
}
