import { expireTerminalSources } from "../../../shared/answerSources";
import { sharedMemoryRemovals } from "./memory/sharedMemoryRemovals";
import { dropCommandRating } from "./olderStores";
import { sanitizeServerForS3 } from "./S3WorkspaceSyncService";
import { teamActivity } from "./personalServers";
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
import { maskContext, safeError } from "./privacy";
import {
  encryptSecretValue,
  openSecretValue,
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

/**
 * An MCP server's credentials: its header and environment values, and a URL that may carry a password.
 * `transform` is told which field of which server a value is (`where`), so that a value that could not
 * be read is known again when the store is written.
 */
function mapMcpSecrets(
  servers: McpServerConfig[] | undefined,
  transform: (value: string, where: string) => string,
): McpServerConfig[] | undefined {
  const values = (
    record: Record<string, string> | undefined,
    where: string,
  ): Record<string, string> | undefined =>
    record &&
    Object.fromEntries(
      Object.entries(record).map(([k, v]) => [
        k,
        typeof v === "string" ? transform(v, `${where}\u0000${k}`) : v,
      ]),
    );
  return servers?.map((server) => ({
    ...server,
    ...(server.headers ? { headers: values(server.headers, `${server.id}\u0000headers`) } : {}),
    ...(server.env ? { env: values(server.env, `${server.id}\u0000env`) } : {}),
    // An address that could not be read is empty here and still has a place to be written back to.
    ...(typeof server.url === "string" ? { url: transform(server.url, `${server.id}\u0000url`) } : {}),
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
  /** Who removed a shared agent, by id: what a teammate who edits it is told. */
  sharedRemovedBy?: { agents?: Record<string, string> };
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
  /** Who removed a team server or memory, by id (with deletedServerIds / deletedMemoryIds). */
  deletedServerBy?: Record<string, string>;
  deletedMemoryBy?: Record<string, string>;
  /** Per team server: the `updatedAt` of the team's copy the last edit here started from (see WorkspaceServerSummary.baseAt). */
  serverEditBase?: Record<string, string>;
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
    requireApprovalOnProdTags: true,
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

/** What the hub writes beside its data file, and what a person calls it. */
const HUB_FILES_BESIDE: Array<[string, string]> = [
  ["audit", "the audit log"],
  ["recordings", "terminal recordings"],
  ["notify.json", "notification settings"],
  ["facts", "facts read from the servers"],
  ["chat", "chat settings"],
  ["kb-embeddings.json", "the knowledge base index"],
  ["kb-originals", "knowledge base files"],
  ["atlassian.json", "Atlassian settings"],
];

/** One process owns the store. Serial atomic replacements preserve the last valid snapshot. */
export class HubStore {
  data = defaultHubData();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  /** What went wrong when the file was read, for the person: said for as long as the app runs. */
  private loadProblem?: string;
  /** Why the last save did not go through. Gone again with the next save that does. */
  private saveProblem?: string;
  /**
   * Secrets of MCP servers that are stored encrypted and could not be read on this start, by server
   * and field: the ciphertext as it was stored. It is written back as it is, so that one start with a
   * key that is missing or broken does not replace the secret with nothing.
   */
  private keptSecrets = new Map<string, string>();

  /**
   * What a person has to know about the store's file, or nothing while all is well: it could not be
   * read (so nothing is saved), it was empty or broken (a copy was kept and the hub started fresh),
   * a secret could not be read, or the last save failed.
   */
  get problem(): string | undefined {
    const unread = this.keptSecrets.size
      ? `${this.keptSecrets.size === 1 ? "A secret of an MCP server" : `${this.keptSecrets.size} secrets of MCP servers`} could not be read on this start: the key that protects ${this.keptSecrets.size === 1 ? "it" : "them"} was not available. ${this.keptSecrets.size === 1 ? "It is" : "They are"} kept as stored. Fix the key and start sshs3 again, or enter ${this.keptSecrets.size === 1 ? "it" : "them"} again.`
      : undefined;
    const parts = [this.loadProblem, unread, this.saveProblem].filter(Boolean);
    return parts.length ? parts.join(" ") : undefined;
  }

  /** Keeps the file as it is beside itself, before the hub starts fresh. Returns the copy's name. */
  private async keepAside(): Promise<string> {
    const copy = `${this.file}.corrupt-${Date.now()}`;
    await fs.copyFile(this.file, copy);
    return path.basename(copy);
  }

  async load(): Promise<void> {
    this.loadProblem = undefined;
    this.keptSecrets.clear();
    try {
      const raw = (await fs.readFile(this.file, "utf8")).replace(/^\uFEFF/, "").trim();
      if (!raw) {
        // An empty file is not a first start: something emptied it (a full disk, a write that was cut
        // short). There is nothing to read, so the hub starts fresh, but not without a word.
        const copy = await this.keepAside();
        this.data = defaultHubData();
        this.loadProblem = `The AI hub's data file was empty, so the hub started fresh: conversations, memory, settings and safety rules are at their defaults. The empty file was kept as ${copy}.`;
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
      // What an older version stored about a rating of commands that no longer exists.
      dropCommandRating(this.data);
      this.data.mcpServers = mapMcpSecrets(this.data.mcpServers, (stored, where) => {
        const opened = openSecretValue(stored);
        if (opened.kept) this.keptSecrets.set(where, opened.kept);
        return opened.value;
      });
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // No file is a first start, unless the folder still holds what the hub wrote beside it: then the
        // file was moved or deleted, and starting fresh is said, as for a file that could not be read.
        const others = await this.otherHubFiles();
        if (others.length)
          this.loadProblem = `The AI hub's data file is missing, though its folder still holds ${others.join(", ")}: it was moved or deleted. The hub started fresh: conversations, memory, settings and safety rules are at their defaults. If you have a copy, close sshs3, put it back as ${this.file} and start sshs3 again.`;
        return;
      }
      // Only a file that was read and is not a store is replaced, and only once it is kept aside. A file
      // that could not be read at all (locked by antivirus or a sync client, too many open files) is not
      // known to be broken: nothing is written over it, and the hub says so instead of starting empty.
      const unreadable = !(error instanceof SyntaxError) && (error as Error).message !== "Unsupported AI Hub store";
      const runsOnDefaults = "The hub runs with default settings and safety rules, and saves nothing until this is fixed.";
      if (unreadable) {
        this.writable = false;
        this.data = defaultHubData();
        this.loadProblem = `The AI hub's data could not be read (${safeError(error)}). ${runsOnDefaults} Close what holds the file open and start sshs3 again.`;
        throw new Error(`The AI hub's data could not be read (${(error as Error).message}); nothing was changed. Close what holds the file open and start again.`, { cause: error });
      }
      let copy: string;
      try {
        copy = await this.keepAside();
      } catch (copyError) {
        // Not kept aside, so not replaced either.
        this.writable = false;
        this.data = defaultHubData();
        this.loadProblem = `The AI hub's data file is not readable as a store, and a copy of it could not be kept (${safeError(copyError)}). ${runsOnDefaults}`;
        throw new Error(`The AI hub's data is not readable as a store, and could not be kept aside (${(copyError as Error).message}); nothing was changed.`, { cause: copyError });
      }
      this.data = defaultHubData();
      this.loadProblem = `The AI hub's data file could not be understood, so the hub started fresh: conversations, memory, settings and safety rules are at their defaults. The file was kept as ${copy}.`;
    }
  }

  /** What the hub keeps beside its data file that is there now, in words: a sign that the hub ran here before. */
  private async otherHubFiles(): Promise<string[]> {
    const dir = path.dirname(this.file);
    const found: string[] = [];
    for (const [name, what] of HUB_FILES_BESIDE) {
      const entry = await fs.stat(path.join(dir, name)).catch(() => undefined);
      const filled = entry?.isDirectory() ? (await fs.readdir(path.join(dir, name)).catch(() => [])).length > 0 : Boolean(entry);
      if (filled) found.push(what);
    }
    const copies = (await fs.readdir(dir).catch(() => [] as string[])).some((f) => f.startsWith(`${path.basename(this.file)}.corrupt-`));
    if (copies) found.push("copies of an earlier data file kept aside");
    return found;
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
    for (const task of this.data.tasks) {
      task.sources = task.sources.filter((s) => s.observedAt >= cutoff);
      for (const message of task.messages) if (message.sourceCalls) message.sourceCalls = expireTerminalSources(message.sourceCalls, cutoff);
    }
  }

  /**
   * Writes the store. Never throws: what goes wrong (a secret that cannot be encrypted, a full disk)
   * comes back as a rejected promise and is said in `problem`, so a save started from a timer cannot
   * take the app down.
   */
  save(): Promise<void> {
    if (!this.writable) return Promise.resolve();
    let content: string;
    try {
      content = this.serialize();
    } catch (error) {
      this.saveProblem = `The AI hub's data could not be saved (${safeError(error)}). What changes now is lost when sshs3 closes.`;
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const write = async (): Promise<void> => {
      try {
        // The hub's folder is the owner's alone, as it always was when the store made it.
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        // The same helper the rest of the app writes its files with: a temporary file, synced, then renamed.
        await writeFileAtomic(this.file, content, { mode: 0o600 });
        if (!this.unsavedSecret) this.saveProblem = undefined;
      } catch (error) {
        this.saveProblem = `The AI hub's data could not be saved (${safeError(error)}). What changes now is lost when sshs3 closes.`;
        throw error;
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  /** Set while a secret that was entered could not be encrypted and so was left out of the file. */
  private unsavedSecret = false;

  private serialize(): string {
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
      mcpServers: this.sealMcpSecrets(),
    });
    return content;
  }

  /**
   * The MCP servers as they are written. A secret that could not be read on this start and was not
   * entered again goes back as the ciphertext it was stored as. One that cannot be encrypted now
   * (the web server's key is broken) is left out, with a word to the person, and the rest of the
   * store is still saved: one field must not stop every save.
   */
  private sealMcpSecrets(): McpServerConfig[] | undefined {
    let failed: unknown;
    const live = new Set<string>();
    const sealed = mapMcpSecrets(this.data.mcpServers, (value, where) => {
      live.add(where);
      const kept = this.keptSecrets.get(where);
      if (!value) return kept ?? value;
      try {
        const encrypted = encryptSecretValue(value);
        // Entered again and stored: the old ciphertext is not needed any more.
        this.keptSecrets.delete(where);
        return encrypted;
      } catch (error) {
        failed = error;
        return kept ?? "";
      }
    });
    // A server or a field that was removed takes its unread secret with it.
    for (const where of [...this.keptSecrets.keys()]) if (!live.has(where)) this.keptSecrets.delete(where);
    this.unsavedSecret = failed !== undefined;
    if (failed !== undefined)
      this.saveProblem = `A secret of an MCP server could not be saved (${safeError(failed)}). The rest was saved. Enter it again once this is fixed.`;
    return sealed;
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

    const removals = sharedMemoryRemovals(this.data, remote);
    const deletedMemoryIds = removals.deleted;
    this.data.deletedMemoryIds = deletedMemoryIds;
    changed ||= removals.changed;

    // 1. Merge memories by id, preserving local personal entries outside team sync.
    const memMap = new Map<string, MemoryEntry>();
    for (const m of this.data.memories) {
      if (m.scope !== "personal" && removals.removed(m)) {
        changed = true;
        continue;
      }
      memMap.set(m.id, m);
    }
    for (const rm of Array.isArray(remote.memories) ? remote.memories : []) {
      if (!rm || typeof rm.id !== "string") continue;
      if (rm.scope === "personal" || removals.removed(rm)) continue;
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
        // What was done on a server a person keeps to themselves stays on this computer.
        activityLog: teamActivity(this.data.activityLog ?? [], localServers),
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
