import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app, Notification, powerMonitor } from "electron";
import type {
  AgentMode,
  SafetyPolicyConfig,
  AgentChange,
  AgentPlan,
  AgentUsage,
  EvalCase,
  EvalRun,
  ExternalRunner,
  HubReply,
  KbPage,
  KbPageSource,
  KbPageUse,
  AgentSchedule,
  AgentTask,
  HubRequest,
  HubSnapshot,
  InfraGraphEdge,
  InlineCommandSuggestion,
  KbDocument,
  LocalServerAuthOverride,
  McpServerConfig,
  MemoryDistillStatus,
  MemoryEntry,
  MemoryProposal,
  MissionAgent,
  S3WorkspaceConfig,
  StartAgentTask,
  TerminalSession,
  WorkforceRun,
  WorkGoal,
  WorkTicket,
  WorkTicketStatus,
  WorkforceStep,
  WorkspaceActivityEvent,
  WorkspaceLayoutEvent,
  WorkspacePresenceTerminal,
  WorkspaceServerSummary,
  NotifyEventKind,
  FactProblem,
  ServerFacts,
  ServerFactsView,
  FactChange,
} from "../../../shared/types/aiHub";
import type { IStorageProvider } from "../../../shared/types/storage";
import { SHELL_KINDS } from "../../../shared/types/aiHub";
import { DEFAULT_AI_MODELS } from "../../../shared/types/ai";
import { AiConfigStore } from "../AiConfigStore";
import { CodexAuthProvider } from "../CodexAuthProvider";
import { HermesManager, type HermesModelConfig } from "../HermesManager";
import { HubStore } from "./HubStore";
import { S3WorkspaceSyncService, mergeMemoryCopies } from "./S3WorkspaceSyncService";
import { McpClientManager } from "./McpClientManager";
import { MAX_MEMORY_TEXT, KnowledgeBaseService } from "./KnowledgeBaseService";
import { SelfLearningService } from "./SelfLearningService";
import {
  DEFAULT_SAFETY_POLICY,
  analyzeCommandSafety,
  isProdTag,
  shouldRequireCommandApproval,
} from "./CommandSafetyService";
import { AcpRuntime, EXTERNAL_RUNNER_PRESETS } from "./AcpRuntime";
import {
  MAX_UPLOAD_BYTES,
  contentHash,
  extractText,
  fetchUrl,
  firstHeading,
  splitLongText,
  titleFromName,
  type Extracted,
} from "./KbExtract";
import { buildReadingPrompt, parseReading } from "./KbEnrich";
import {
  applyPageOps,
  buildCompilePrompt,
  buildLearnPrompt,
  buildRebuildPrompt,
  candidatePages,
  cleanKeys,
  markHeldAgainst,
  parsePageOps,
  savePageByPerson,
  searchPages,
  sourceParts,
  sumPageUse,
  undoPageChange,
  withUse,
  MAX_NEW_PAGES_PER_SOURCE,
  PAGE_KINDS,
  mergePageCopies,
} from "./KbCompile";
import { buildDailyReport } from "./DailyReport";
import { lowerMode } from "./AppGuard";
import { inboxItems, type InboxItem } from "../../../shared/aiHubInbox";
import {
  NOTIFY_KINDS,
  channelWants,
  deliver,
  diffInbox,
  guardUrl,
  hostOf,
  renderNotification,
  type GuardOptions,
  type NotifyChannel,
  type NotifyItem,
} from "./Notifier";
import { NotifyStore } from "./NotifyStore";
import { FactsStore, type FactsRecord } from "./FactsStore";
import { buildScript, diffFacts, factsHash, factsSummary, isWatchPath, parseFacts, problems } from "./ServerFacts";
import { demoFactsOutput } from "./demoFacts";
import {
  Replay,
  caseFromTask,
  evalRun,
  judgePrompt,
  normalizeExpectation,
  parseJudgement,
  ruleChecks,
} from "./EvalSuite";
import {
  alertTarget,
  alertName,
  alertTicketText,
  hookSecretMatches,
  newHookSecret,
  parseAlerts,
  parsePastedAlert,
  routeAlert,
  type IncomingAlert,
} from "./AlertIntake";
import {
  buildContradictionPrompt,
  lintKnowledgeBase,
  noteGap,
  pairsToCompare,
  parseContradictions,
} from "./KbLint";
import { sectionsOf } from "./KnowledgeBaseService";
import {
  deleteDemoAgent,
  deleteDemoInfraEdge,
  deleteDemoKbDocument,
  deleteDemoMcpServer,
  getBuiltinAgents,
  getBuiltinKbDocuments,
  getBuiltinSkillsAndMemories,
  getBuiltinSnippets,
  getDemoInfraEdges,
  getDemoMcpServers,
  getDemoMemories,
  getDemoSchedules,
  getDemoServers,
  getDemoTasks,
  getDemoWorkforceRuns,
  isDemoMode,
  mcpCatalog,
  saveDemoAgent,
  saveDemoInfraEdge,
  saveDemoKbDocument,
  saveDemoMcpServer,
  saveDemoMemory,
  saveDemoWorkforceRun,
} from "./demoWorkspace";
import { isDemoTarget } from "../../demo/demoMode";
import {
  TerminalRegistry,
  type DetectedCommandActivity,
} from "./TerminalRegistry";
import { ToolBroker, type ToolDependencies } from "./ToolBroker";
import {
  HermesRuntime,
  type AgentRuntime,
  type RunEvent,
} from "./AgentRuntime";
import {
  ContextService,
  scopedMemory,
  type ExtraWorkspaceContext,
  type InventoryTarget,
} from "./ContextService";
import { AuditLog } from "./AuditLog";
import { LocalMcpServer } from "./LocalMcpServer";
import { SessionRecorder } from "./SessionRecorder";
import { McpTokenStore } from "../../web/McpTokenStore";
import { boundedContext, boundedPrompt, clip, HUB_PROMPT_MAX, maskContext, maskStrings, PERSON_PROMPT_MAX, safeError } from "./privacy";
import { createLogger } from "../../log";
import { runWorkforce } from "./WorkforceRunner";
import { LearningQueue } from "./LearningQueue";
import { WorkSync } from "./WorkSync";
import {
  TICKET_CLAIM_TTL_MS,
  TICKET_STATUSES,
  WORKFORCE_TEMPLATES,
  mergeItems,
  mergeTicketCopies,
  addUsage,
  withComment,
  claimIsFresh,
  live,
  nextForHeartbeat,
  splitRemovals,
  sumUsage,
  tokensLeft,
  templateSummaries,
  ticketAfterRun,
  withRemovals,
  ticketPrompt,
  whyNotRunnable,
  wouldCycle,
} from "./WorkBoard";
import {
  approvalMessage,
  parseReview,
  rejectionMessage,
  reviewerPrompt,
  todosFromPlan,
} from "./PlanMode";
import { firstActivityCursor, nextActivityBatch } from "./ActivityBatcher";
import {
  EmbeddingIndex,
  openAiCompatibleEmbedder,
  type Embedder,
} from "./EmbeddingIndex";
import {
  MAX_STORED_PROPOSALS,
  activityTranscript,
  buildDistillPrompt,
  parseDistillAnswer,
  confirmedSomething,
  mayLearnUnreviewed,
  replacesPersonMemory,
  taskTranscript,
  worthDistilling,
  type DistillSource,
} from "./MemoryDistiller";

import {
  insideDataDirectory,
  keepSecrets,
  requiredText,
  integer,
  extractResponseTextFromRaw,
  extractResponseText,
  parseInlineCommandJson,
  buildInstantCommandSuggestion,
} from "./hubHelpers";
import { handleAppAction } from "./AppActions";

const log = createLogger("ai-hub");
/**
 * Requests that only read. They answer in `reply` and change nothing, so the
 * store is not rewritten and no window is told to refetch: a search that runs
 * as a person types must not cost a save and a broadcast per keystroke.
 */
const READ_ONLY_ACTIONS: ReadonlySet<HubRequest["action"]> = new Set<HubRequest["action"]>([
  "audit-read",
  "audit-export",
  "recording-read",
  "kb-search",
  "kb-read",
  "kb-page-read",
  "kb-original",
  "server-facts-read",
  "inline-suggest",
]);
/**
 * An agent as it arrives from the team bucket, made safe to take: whoever can
 * write to the bucket must not be able to make an agent on this computer freer
 * than a person here made it. A known agent keeps the stricter of the two
 * modes, and its tool and MCP lists cannot widen; a new one arrives at most
 * assisted (a person here raises it); a date in the future is not believed;
 * and its texts are bounded as a person's save would bound them.
 */
export const incomingAgentForTesting = (remote: MissionAgent, local: MissionAgent | undefined): MissionAgent => incomingAgent(remote, local);

function incomingAgent(remote: MissionAgent, local: MissionAgent | undefined, now = Date.now()): MissionAgent {
  const modes: AgentMode[] = ["advice", "assisted", "autonomous"];
  const mode = modes.includes(remote.defaultMode) ? remote.defaultMode : "assisted";
  const narrower = (mine: string[] | undefined, theirs: string[] | undefined): string[] | undefined =>
    mine === undefined ? (theirs ? theirs.slice(0, 40) : undefined) : (theirs ?? mine).filter((x) => mine.includes(x));
  return {
    ...remote,
    name: clip(remote.name ?? "Agent", 120),
    role: clip(remote.role ?? "", 160),
    mission: clip(remote.mission ?? "", 4000),
    systemPrompt: clip(remote.systemPrompt ?? "", 8000),
    defaultMode: local ? lowerMode(local.defaultMode, mode) : lowerMode("assisted", mode),
    allowedTools: local ? narrower(local.allowedTools, remote.allowedTools) : remote.allowedTools?.slice(0, 40),
    mcpServerIds: local ? narrower(local.mcpServerIds, remote.mcpServerIds) : remote.mcpServerIds?.slice(0, 40),
    updatedAt: Math.min(remote.updatedAt, now + 5 * 60_000),
  };
}

/** The safety policy's switches as the screen names them. */
const POLICY_NAMES: Record<keyof SafetyPolicyConfig, string> = {
  autoApproveSafeReadOnly: "run read-only commands without asking",
  requireApprovalOnProdTags: "always ask before a change on production",
  blockDestructiveWithoutConfirm: "stop destructive commands until a person says yes",
};
/**
 * A suggested command made fit to put in a terminal. Text from a model is not
 * trusted to be one command: control characters (an escape that ends a
 * bracketed paste early) are taken out, a second line is not run by
 * pressing Enter on the first, and the command is classified like any other.
 * Only a single-line command classified read-only may run with one key; the
 * rest is pasted for the person to read and press Enter themselves.
 */
export const checkedSuggestionForTesting = (s: InlineCommandSuggestion): InlineCommandSuggestion => checkedSuggestion(s);

function checkedSuggestion(s: InlineCommandSuggestion): InlineCommandSuggestion {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = s.command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, 4000);
  const lines = cleaned.split("\n").filter((l) => l.trim());
  const safety = analyzeCommandSafety(cleaned);
  return {
    ...s,
    command: lines.join("\n"),
    riskLevel: safety.riskLevel,
    riskReason: safety.riskReason,
    multiline: lines.length > 1 || undefined,
    runnable: safety.riskLevel === "safe" && lines.length === 1,
  };
}

/** How a change was let through or stopped when no person decided it, said for the log. */
const DECIDED_HOW: Record<NonNullable<AgentChange["decidedHow"]>, string> = {
  person: "a person",
  policy: "the safety policy, without asking",
  plan: "an approved plan that lists it",
  timeout: "nobody: the question timed out",
  stopped: "nobody: the run was stopped",
};
const active = (t: AgentTask): boolean =>
  ["queued", "running", "waiting"].includes(t.status);
/** The line a conversation ends with when its run used its command or time budget. */
export function budgetStopLine(stop: NonNullable<AgentTask["budgetStop"]>): string {
  const n = stop.limit;
  return stop.kind === "commands"
    ? `Stopped after ${n} ${n === 1 ? "command" : "commands"}, the limit for this conversation. Continue to give it ${n} more.`
    : `Stopped after ${n} ${n === 1 ? "minute" : "minutes"}, the time limit for this conversation. Continue to give it ${n} more.`;
}
/**
 * How long the model is given for a one-line command suggestion. Five seconds
 * was less than a reasoning model takes, so the answer was always the canned
 * one, after a five-second wait.
 */
const INLINE_SUGGEST_TIMEOUT_MS = 15_000;
/** How long a stopped run is given to end by itself before the hub lets go of it. */
const RUN_STOP_GRACE_MS = 10_000;
/** A run the hub started itself (workforce specialist, memory proposals). */
const isBackgroundRun = (t: AgentTask | undefined): boolean =>
  Boolean(t?.workforceRunId || t?.distillSourceId || t?.evalCaseId);
export interface HubHost {
  changed(): void;
  inventoryTargets(): Promise<InventoryTarget[]>;
  /**
   * Opens a terminal of the hub's own on a saved target (or "local") and
   * registers it under `label`. It is not connected to yet: the hub does that
   * once the prompt is there (`openUnattendedTerminal`).
   */
  openSchedule(target: Pick<AgentSchedule, "profileId" | "shell">, label: string): Promise<string>;
  /** Closes a terminal the hub opened for itself (an investigator's). */
  closeSession?(sessionId: string): void;
  backgroundChanged(background: boolean, autoStart: boolean): Promise<void>;
  show(): void;
  /**
   * Desktop only: asks the user to confirm, then restarts sshs3 with demo mode on or off (demo mode never
   * changes inside a running process). Resolves false when the user declines. Absent in web mode, where
   * demo mode is fixed when the server starts.
   */
  relaunchForDemoMode?(demoMode: boolean): Promise<boolean>;
  file?: ToolDependencies["file"];
  workspaceServers?(): Promise<WorkspaceServerSummary[]>;
  getTeamWorkspaceData?(): Promise<{
    memories: MemoryEntry[];
    activityLog: WorkspaceActivityEvent[];
    actor?: string;
  }>;
  recordWorkspaceActivity?(event: WorkspaceActivityEvent): Promise<void>;
  saveWorkspaceMemory?(entry: MemoryEntry): Promise<void>;
  deleteWorkspaceMemory?(id: string): Promise<void>;
  describeServer?(input: {
    profileId: string;
    shared?: boolean;
    cluster?: string;
    nodeRole?: string;
    description?: string;
    role?: string;
    tags?: string[];
    /** Who makes the change: stored with the server as "updated by". */
    updatedBy?: string;
  }): Promise<void>;
  upsertServer?(input: {
    id?: string;
    name: string;
    host: string;
    port?: number;
    username: string;
    authType?: WorkspaceServerSummary["authType"];
    privateKeyPath?: string;
    pkcs11LibPath?: string;
    fido2Resident?: boolean;
    proxyJump?: string;
    proxyJumpProfileId?: string;
    forwardAgent?: boolean;
    x11Forwarding?: boolean;
    x11Display?: string;
    compression?: boolean;
    serverAliveInterval?: number;
    initialPath?: string;
    poolId?: string;
    dotfilesSyncPolicy?: "ask" | "always";
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectDelayMs?: number;
    extraOptions?: Record<string, string>;
    tunnels?: WorkspaceServerSummary["tunnels"];
    folder?: string;
    cluster?: string;
    nodeRole?: string;
    role?: string;
    description?: string;
    tags?: string[];
    shared?: boolean;
    /** Who makes the change: stored with the server as "updated by". */
    updatedBy?: string;
  }): Promise<WorkspaceServerSummary>;
  deleteServer?(profileId: string): Promise<void>;
  syncSharedServersFromS3?(
    servers: WorkspaceServerSummary[],
    deletedServerIds: Record<string, string>,
  ): Promise<void>;
  s3ProviderFactory?: (cfg: S3WorkspaceConfig) => IStorageProvider;
  aiConfigFilePath?: string;
  s3ConfigFilePath?: string;
  defaultActorName?: string;
  /** On the web server: the user id that goes in front of the alert hook's secret in its address. */
  alertHookOwner?: string;
  /** On the web server: whether this user administers it. Absent on the desktop, where the one user does. */
  teamAdmin?: () => boolean;
  /** On the web server: whether this user's account is the only one there is, and administers it. */
  soleUser?: () => boolean;
  peerPresenceProvider?: () => import("../../../shared/types/aiHub").WorkspacePresenceEntry[];
  onSharedWorkspaceChanged?: () => void;
  extraAppContext?(): Promise<{
    folders: string[];
    s3Profiles: Array<{
      id: string;
      name: string;
      endpoint?: string;
      region?: string;
      bucket?: string;
      group?: string;
      authMethod?: string;
      awsProfile?: string;
    }>;
    snippets: unknown[];
    dotfilesPools?: unknown[];
    dirSyncProfiles?: unknown[];
    activeTunnels?: unknown[];
    appSettings: Record<string, unknown>;
  }>;
  manageFolders?(input: {
    operation: "create_folder" | "rename_folder" | "delete_folder";
    folderName: string;
    newFolderName?: string;
  }): Promise<unknown>;
  manageS3Profile?(input: {
    operation:
      | "upsert_s3_profile"
      | "delete_s3_profile"
      | "list_dir_sync_profiles"
      | "save_dir_sync_profile"
      | "delete_dir_sync_profile";
    idOrName?: string;
    name?: string;
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
    group?: string;
    authMethod?: "accessKey" | "awsProfile" | "awsSso";
    awsProfile?: string;
    sourceProviderId?: string;
    sourcePath?: string;
    targetProviderId?: string;
    targetPath?: string;
    deleteExtraneous?: boolean;
  }): Promise<unknown>;
  manageAppSettings?(input: {
    operation:
      | "get_state"
      | "update_settings"
      | "update_shortcuts"
      | "list_dotfiles"
      | "save_dotfile"
      | "delete_dotfile"
      | "list_snippets"
      | "save_snippet"
      | "delete_snippet"
      | "open_local_terminal";
    settings?: Record<string, unknown>;
    shortcuts?: Record<string, string>;
    resetShortcuts?: boolean;
    dotfile?: {
      poolId?: string;
      poolName?: string;
      remotePath?: string;
      content?: string;
      mode?: string;
      deletePool?: boolean;
    };
    snippet?: {
      id?: string;
      name?: string;
      command?: string;
      category?: string;
    };
  }): Promise<unknown>;
  openServerTerminal?(profileId: string): Promise<string>;
  /**
   * Runs a script on a server and returns what it printed, without a terminal:
   * over the connection of an open tab where there is one, otherwise over a
   * connection of its own that never prompts. "local" is this computer.
   */
  execOnServer?(
    profileId: string,
    script: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; stdout: string; error?: string; via: "open-tab" | "own-connection" | "local" }>;
  resolveStorageProvider?(targetRef: string): Promise<IStorageProvider | undefined>;
  storageOps?(input: {
    operation: "list_files" | "read_remote_file" | "diff_paths";
    targetA: string;
    pathA: string;
    targetB?: string;
    pathB?: string;
  }): Promise<unknown>;
}

/** The Electron main process is the per-user background owner; renderer lifetimes confer no authority. */
/** The hub members the agent tool handlers use (see HubService.appActionHost). */
export type AppActionHost = ReturnType<HubService["appActionHost"]>;

export class HubService {
  // On Windows the terminals run in a pseudo console that delivers a command's markers ahead of its text.
  readonly terminals = new TerminalRegistry({ lateOutput: process.platform === "win32" });
  readonly store: HubStore;
  readonly config: AiConfigStore;
  readonly context: ContextService;
  readonly broker: ToolBroker;
  readonly s3Workspace: S3WorkspaceSyncService;
  readonly mcp = new McpClientManager(fetch, (server) => this.assertMcpReach(server));
  readonly kb = new KnowledgeBaseService();
  readonly selfLearning = new SelfLearningService(this.kb);
  private runtimes = new Map<string, AgentRuntime>();
  private launches = new Map<string, symbol>();
  /** Resolvers for callers waiting on a task's run to end (see whenSettled). */
  private settleWaiters = new Map<string, Array<() => void>>();
  /** Workforce run id → the conversation task that shows it. */
  private workforceLeads = new Map<string, string>();
  /** Records being read for memory proposals right now. */
  private distilling = new Set<string>();
  private readonly embeddings: EmbeddingIndex;
  private learningQueue?: LearningQueue;
  private workSyncStore?: WorkSync;
  private lastWorkSync = 0;
  private workSyncing = false;
  private workSyncAt?: number;
  private workSyncError?: string;
  /** What other installations' runs have spent, as last read from the bucket. */
  private othersUsage: Record<string, AgentUsage>[] = [];
  private uploadedUsage = "";
  /** Recordings that answer the tool calls of test-case runs, by task id. */
  private evalReplays = new Map<string, Replay>();
  private evalRunningId?: string;
  private kbReadingId?: string;
  private kbRetryAt = 0;
  private kbNeedsModel = false;
  /** Documents another installation is reading: left alone until this time. */
  private kbSkipUntil = new Map<string, number>();
  private readingQueue = false;
  private lastQueueCheck = 0;
  private lastActivityCheck = 0;
  private recoveredSessions = false;
  private initialized?: Promise<void>;
  private tickTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private lastInventory = 0;
  private previewId?: string;
  private pendingLayoutEvent?: WorkspaceLayoutEvent;
  private cachedWorkspaceServers: WorkspaceServerSummary[] = [];
  private ticking = false;
  /** When the previous pass over the schedules began: a job that fell due after it is late, not missed. */
  private lastScheduleLoopAt = 0;
  /** For a recording that is being made: the recording its conversation pointed to before. */
  private readonly recordingBefore = new Map<string, string | undefined>();
  /** The terminal each scheduled run was given, so it is closed when the run ends. */
  private readonly scheduleSessions = new Map<string, string>();
  /** Terminals the hub opened for a run while it ran (another server of the cluster, a ticket's target). */
  private readonly runTerminals = new Map<string, Set<string>>();

  /**
   * A terminal the hub opened for this run is closed when the run ends: it is
   * nobody's tab, and left open it reads to the team as a person connected to
   * that server.
   */
  closeWhenRunEnds(taskId: string, sessionId: string): void {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task || (!active(task) && !this.runtimes.has(taskId) && !this.launches.has(taskId))) {
      this.host.closeSession?.(sessionId);
      return;
    }
    const set = this.runTerminals.get(taskId) ?? new Set<string>();
    set.add(sessionId);
    this.runTerminals.set(taskId, set);
  }

  /**
   * A scheduled run has ended: its schedule says how (not just "Started"),
   * a failure is told to the person, and the terminal opened for it is closed.
   */
  private scheduledRunEnded(taskId: string): void {
    const sessionId = this.scheduleSessions.get(taskId);
    if (sessionId) {
      this.scheduleSessions.delete(taskId);
      this.host.closeSession?.(sessionId);
    }
    for (const opened of this.runTerminals.get(taskId) ?? []) this.host.closeSession?.(opened);
    this.runTerminals.delete(taskId);
    const schedule = this.store.data.schedules.find((s) => s.lastTaskId === taskId);
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!schedule || !task || active(task)) return;
    const at = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    schedule.lastStatus =
      task.status === "completed"
        ? `Completed at ${at}${task.verification === "verified" ? ", verified" : ""}`
        : `${task.status === "failed" ? "Failed" : "Stopped"} at ${at}${task.error ? `: ${clip(task.error, 160)}` : ""}`;
    if (task.status !== "completed") this.notify("Scheduled task did not finish", schedule.title);
  }
  private disposed = false;
  private resume = (): void => {
    const now = Date.now();
    for (const schedule of this.store.data.schedules)
      if (schedule.enabled && schedule.nextRunAt <= now) {
        schedule.lastStatus = "Missed while unavailable; not replayed.";
        schedule.nextRunAt = now + schedule.intervalMinutes * 60_000;
      }
    this.changed();
  };
  private suspend = (): void => {
    for (const t of this.store.data.tasks.filter(active))
      void this.stop(
        t,
        "Computer suspended; inspect the target before continuing.",
      );
  };

  constructor(
    private readonly host: HubHost,
    private readonly directory = path.join(app.getPath("userData"), "ai-hub"),
  ) {
    this.store = new HubStore(path.join(directory, "hub.json"));
    this.notifyStore = new NotifyStore(path.join(directory, "notify.json"));
    this.factsStore = new FactsStore(path.join(directory, "facts"));
    this.embeddings = new EmbeddingIndex(
      path.join(directory, "kb-embeddings.json"),
    );
    this.selfLearning.bindStore(this.store);
    this.config = new AiConfigStore(host.aiConfigFilePath);
    this.context = new ContextService(
      this.store,
      this.terminals,
      host.inventoryTargets,
      this.kb,
    );
    this.broker = new ToolBroker(this.terminals, {
      context: async (task, query, sessionId) => {
        const extra = await this.collectExtraContext();
        return this.context.read(task, query, sessionId, this.asOfEvalCase(task, extra));
      },
      memory: async (task, request) => {
        if (request.action === "memory-save") {
          const out = await this.rememberFromRun(task, {
            kind: request.kind === "skill" ? "skill" : "memory",
            scope: request.scope || "workspace",
            title: request.title || "Workspace note",
            text: request.text || "",
          });
          return out.proposal
            ? { saved: false, proposed: true, note: "A person reviews it under Memory & skills before it is used or shared." }
            : { saved: true, entry: out.entry };
        }
        const extra = await this.collectExtraContext();
        const terminal =
          task.target && this.terminals.get(task.target.sessionId);
        const targetLabel = terminal?.label ?? task.target?.label;
        const matchedSrv = (extra.workspaceServers ?? []).find(
          (s) =>
            (terminal?.profileId && s.id === terminal.profileId) ||
            (targetLabel &&
              (s.name.toLowerCase() === targetLabel.toLowerCase() ||
                s.id.toLowerCase() === targetLabel.toLowerCase())),
        );
        return scopedMemory(
          extra.memories ?? this.store.data.memories,
          this.scope(task),
          request.action === "skills",
          {
            targetLabel,
            serverName: matchedSrv?.name,
            serverHost: matchedSrv?.host,
            cluster: matchedSrv?.cluster,
          },
        );
      },
      file: (...args) => {
        if (!this.host.file) throw new Error("File tools unavailable");
        return this.host.file(...args);
      },
      appAction: (task, request, authorize) =>
        handleAppAction(this.appActionHost(), task, request, authorize),
      openLocalTerminal: async () => {
        const res = (await this.host.manageAppSettings?.({
          operation: "open_local_terminal",
        })) as { sessionId?: string } | undefined;
        if (!res?.sessionId) {
          throw new Error("Could not open a local terminal session");
        }
        return res.sessionId;
      },
      activity: (task, change, sessionId) => {
        void this.recordAgentChangeActivity(task, change, sessionId);
      },
      approvalWaitMs: () => this.approvalWaitMinutes() * 60_000,
      // Time spent waiting for a person is not the run's: its budget moves by as much.
      waited: (task, ms) => {
        const armed = this.runTimers.get(task.id);
        if (armed) this.armRunTimer(task, armed.endsAt + ms);
      },
      // Told its budget is spent, the agent asked for more anyway: the run ends here.
      budgetSpent: (task) => void this.stop(task, "Command budget exhausted"),
      safetyContext: (task, targetLabel) => {
        const rawLabel = (targetLabel || task.target?.label || "").trim();
        const label = rawLabel.toLowerCase();
        const session = task.target
          ? this.terminals.get(task.target.sessionId)
          : undefined;
        const knownServers = this.getKnownServers();
        const clusterMatch = /^cluster\s+([^\s(]+)/i
          .exec(rawLabel)?.[1]
          ?.toLowerCase();
        const matchedServers = knownServers.filter((s) => {
          const sName = s.name.toLowerCase();
          const sId = s.id.toLowerCase();
          const sCluster = s.cluster?.toLowerCase();
          if (session?.profileId && s.id === session.profileId) return true;
          if (!label) return false;
          if (
            sName === label ||
            sId === label ||
            s.host.toLowerCase() === label
          ) {
            return true;
          }
          if (
            sCluster &&
            (sCluster === label ||
              (clusterMatch &&
                (sCluster === clusterMatch ||
                  sCluster.includes(clusterMatch))))
          ) {
            return true;
          }
          if (
            (rawLabel.includes(",") || rawLabel.includes("(")) &&
            sName.length >= 2 &&
            label.includes(sName)
          ) {
            return true;
          }
          return false;
        });
        const aggregatedTags = Array.from(
          new Set(matchedServers.flatMap((s) => s.tags ?? [])),
        );
        return {
          policy: this.safetyPolicy(),
          targetTags: aggregatedTags.length > 0 ? aggregatedTags : undefined,
        };
      },
      changed: () => this.changed(),
    });
    this.s3Workspace = new S3WorkspaceSyncService(
      host.s3ConfigFilePath ?? path.join(directory, "s3-workspace.json"),
      {
        getLocalState: async () => {
          const actor = await this.resolveActorName();
          const hostServers =
            (await this.host.workspaceServers?.().catch(() => [])) ?? [];
          const deletedServerIds = {
            ...(this.store.data.deletedServerIds ?? {}),
          };
          const srvMap = new Map<string, WorkspaceServerSummary>();
          for (const s of this.store.data.s3SyncedServers ?? []) {
            if (s?.id && s.shared !== false) {
              srvMap.set(s.id, { ...s, shared: true });
            }
          }
          for (const s of hostServers) {
            if (s?.id && s.shared !== false && !s.fromVault) {
              const delVal = deletedServerIds[s.id];
              const delMs =
                typeof delVal === "number"
                  ? delVal
                  : Date.parse(String(delVal || "")) || Number(delVal) || 0;
              const tNext = Date.parse(s.updatedAt || "") || 0;
              if (delMs > 0 && delMs >= tNext) continue;
              const prev = srvMap.get(s.id);
              const tPrev = Date.parse(prev?.updatedAt || "") || 0;
              if (!prev || tNext >= tPrev) {
                srvMap.set(s.id, { ...s, shared: true });
              }
            }
          }
          const activeTerminals: WorkspacePresenceTerminal[] = this.terminals
            .list()
            .filter((t) => t.state !== "disconnected" && t.kind === "ssh")
            .map((t) => ({
              profileId: t.profileId,
              targetLabel: t.label,
              state: t.owner ? "ai-working" : "connected",
              since: t.updatedAt,
            }));

          return {
            actor,
            servers: Array.from(srvMap.values()),
            memories: this.store.data.memories.filter(
              (m) => m.scope !== "personal",
            ),
            activityLog: this.store.data.activityLog ?? [],
            deletedServerIds,
            deletedMemoryIds: { ...(this.store.data.deletedMemoryIds ?? {}) },
            activeTerminals,
          };
        },
        applyMergedState: async (state) => {
          this.store.data.deletedServerIds = state.deletedServerIds;
          this.store.data.deletedMemoryIds = state.deletedMemoryIds;
          this.store.data.s3SyncedServers = state.activeServers;

          const personalMemories = this.store.data.memories.filter(
            (m) => m.scope === "personal",
          );
          const sharedMemMap = new Map<string, MemoryEntry>();
          for (const m of this.store.data.memories) {
            if (m.scope !== "personal") {
              if ((state.deletedMemoryIds[m.id] ?? 0) < (m.updatedAt ?? 0)) {
                sharedMemMap.set(m.id, m);
              }
            }
          }
          for (const m of state.memories) {
            if ((state.deletedMemoryIds[m.id] ?? 0) >= (m.updatedAt ?? 0))
              continue;
            const prev = sharedMemMap.get(m.id);
            // The newer copy decides, also about what it no longer has; votes are kept from both.
            sharedMemMap.set(m.id, prev ? mergeMemoryCopies(prev, m) : m);
          }
          this.store.data.memories = [
            ...personalMemories,
            ...Array.from(sharedMemMap.values()),
          ];

          const actMap = new Map<string, WorkspaceActivityEvent>();
          for (const a of this.store.data.activityLog ?? [])
            actMap.set(a.id, a);
          for (const a of state.activityLog) actMap.set(a.id, a);
          this.store.data.activityLog = Array.from(actMap.values())
            .sort((a, b) => a.at - b.at)
            .slice(-500);

          await this.host
            .syncSharedServersFromS3?.(
              state.activeServers,
              state.deletedServerIds,
            )
            .catch((e) =>
              log.warn("Failed syncing S3 servers to ProfileStore", safeError(e)),
            );

          if (state.changed) {
            this.changed();
          }
        },
        onStateChanged: () => {
          if (!this.disposed) this.host.changed();
        },
      },
      {
        providerFactory: host.s3ProviderFactory,
      },
    );
    this.terminals.on("changed", () => {
      this.changed();
      this.s3Workspace.schedulePresenceUpdate();
    });
    this.terminals.on(
      "commandLine",
      (
        session: TerminalSession,
        commandLine: string,
        classified: DetectedCommandActivity,
      ) => {
        void this.recordTerminalCommandActivity(session, commandLine, classified);
      },
    );
    this.terminals.on("invalidated", (owner: string, reason: string) => {
      const task = this.store.data.tasks.find((t) => t.id === owner);
      if (task && active(task)) void this.stop(task, reason);
    });
    // A terminal an agent's run owns is recorded while it owns it: what the terminal
    // showed, masked, with a marker per command. What a person types is never recorded.
    this.terminals.on("claimed", (session: TerminalSession, owner: string) => {
      const task = this.store.data.tasks.find((t) => t.id === owner);
      if (!task || isBackgroundRun(task) || isDemoMode() || this.store.data.preferences.recordSessions === false) return;
      void this.recordings()
        .start({ sessionId: session.id, taskId: task.id, label: session.label, ...this.terminals.size(session.id) })
        .then((info) => {
          // Kept, so that a recording in which nothing ran can give the conversation its earlier one back.
          if (task.recordingId !== info.id) this.recordingBefore.set(info.id, task.recordingId);
          task.recordingId = info.id;
        })
        .catch((e) => log.warn("Could not start recording a terminal", safeError(e)));
    });
    this.terminals.on("output", (sessionId: string, text: string) => {
      this.recorder?.output(sessionId, text);
    });
    this.terminals.on("executing", (sessionId: string, command: string) => {
      this.recorder?.marker(sessionId, command);
    });
    this.terminals.on("executed", (sessionId: string, exitCode: number) => {
      this.recorder?.exit(sessionId, exitCode);
    });
    this.terminals.on("resized", (sessionId: string, cols: number, rows: number) => {
      this.recorder?.resize(sessionId, cols, rows);
    });
    // A finished recording is sealed into the audit log: its hash there shows later that it was not changed.
    this.terminals.on("released", (session: TerminalSession) => {
      void this.recorder
        ?.stop(session.id)
        .then(async (info) => {
          if (!info || isDemoMode()) return;
          const task = this.store.data.tasks.find((t) => t.id === info.taskId);
          const before = this.recordingBefore.get(info.id);
          this.recordingBefore.delete(info.id);
          // A run that held the terminal and ran nothing recorded nothing worth keeping: no file, no
          // "0 s, 0 commands" line in the audit log for every resume, and the conversation's
          // recording stays the one in which something happened.
          if (info.markers === 0) {
            await this.recordings().discard(info.id);
            if (task?.recordingId === info.id) {
              task.recordingId = before;
              this.changed();
            }
            return;
          }
          const digest = await this.recordings().digest(info.id);
          if (!digest) return;
          await this.audit().append({
            kind: "recording",
            actor: `${task?.agentName ?? "Assistant"} (run ${info.taskId.slice(0, 8)})`,
            target: info.label,
            what: `Terminal recording, ${Math.round((info.endedAt! - info.startedAt) / 1000)} s, ${info.markers} command${info.markers === 1 ? "" : "s"}`,
            taskId: info.taskId,
            changeId: info.id,
            detail: `sha256 ${digest}`,
          });
        })
        .catch(() => undefined);
    });
  }

  initialize(): Promise<void> {
    return (this.initialized ??= (async () => {
      await this.store.load().catch((e) =>
        log.warn("HubStore load failed; using default store", safeError(e)),
      );
      this.selfLearning.bindStore(this.store);
      await this.notifyStore.load();
      await this.factsStore.load();
      const initServers = await this.host.workspaceServers?.().catch(() => []);
      if (Array.isArray(initServers) && initServers.length > 0) {
        this.cachedWorkspaceServers = initServers;
      }
      // Demo mode is decided once at launch (demo/demoMode.ts) and is never stored: drop the Demo-Lab
      // preference that older builds persisted, so it is neither read nor written back.
      Reflect.deleteProperty(this.store.data.preferences, "demoLabEnabled");
      await this.s3Workspace.start().catch((e) =>
        log.warn("S3 workspace start failed", safeError(e)),
      );
      this.resume();
      if (process.env.SSHS3_NATIVE_HERMES === '1') {
        // Native Hermes owns conversations, profiles, schedules and persistent memory.
        // Keep only sshs3's terminal/tool authority; do not revive legacy agent jobs.
        this.terminals.observe(true);
        return;
      }
      const config = await this.config.getView().catch((e) => {
        log.warn("AiConfigStore getView failed during init", safeError(e));
        return { enabled: true } as Awaited<ReturnType<typeof this.config.getView>>;
      });
      this.terminals.observe(config.enabled);
      void this.context
        .inventory(false)
        .then(() => {
          if (!this.disposed) this.changed();
        })
        .catch((e) => log.warn("Initial inventory failed", safeError(e)));
      this.tickTimer = setInterval(() => {
        void this.tick().catch((e) =>
          log.warn("Background tick failed", safeError(e)),
        );
      }, 15_000);
      this.tickTimer.unref();
      powerMonitor?.on("suspend", this.suspend);
      powerMonitor?.on("resume", this.resume);
      await this.host
        .backgroundChanged?.(
          this.store.data.preferences.background,
          this.store.data.preferences.autoStart,
        )
        ?.catch((e) => log.warn("Background setting apply failed", safeError(e)));
      // On again if it was on when the app last closed. Off is the default and needs nothing.
      if (this.store.data.preferences.localMcp?.enabled)
        await this.applyLocalMcp().catch((e) => log.warn("The local MCP listener did not start", safeError(e)));
      await this.store
        .save()
        .catch((e) => log.warn("Initial store save failed", safeError(e)));
    })().catch((err) => {
      this.initialized = undefined;
      throw err;
    }));
  }

  get background(): boolean {
    return this.store.data.preferences.background;
  }

  // Built-ins depend on the mode (demoWorkspace getBuiltin*): the demo workspace's fixtures in demo mode,
  // otherwise the neutral defaults of builtins.ts. They are merged in here, never stored.
  private getAgentsList(): MissionAgent[] {
    const stored = this.store.data.agents ?? [];
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    const builtins = getBuiltinAgents();
    return [
      ...stored,
      ...builtins.filter(
        (ba) => !dismissed.has(ba.id) && !stored.some((a) => a.id === ba.id),
      ),
    ];
  }

  /**
   * The MCP servers as they may leave the hub (to the interface, to a model):
   * with the names of their environment variables and headers, and no values.
   * An empty value means "set, not shown".
   */
  private mcpServersShown(): McpServerConfig[] {
    const names = (values?: Record<string, string>): Record<string, string> | undefined =>
      values && Object.keys(values).length ? Object.fromEntries(Object.keys(values).map((k) => [k, ""])) : undefined;
    return this.getMcpServersList().map((s) => ({ ...s, env: names(s.env), headers: names(s.headers) }));
  }

  private getMcpServersList(): McpServerConfig[] {
    const stored = this.store.data.mcpServers ?? [];
    if (!isDemoMode()) return stored;
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    return [
      ...stored,
      ...getDemoMcpServers().filter(
        (dm) => !dismissed.has(dm.id) && !stored.some((m) => m.id === dm.id),
      ),
    ];
  }

  private getKbDocumentsList(): KbDocument[] {
    const stored = this.store.data.kbDocuments ?? [];
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    const builtins = getBuiltinKbDocuments();
    return [
      ...stored,
      ...builtins.filter(
        (bk) => !dismissed.has(bk.id) && !stored.some((k) => k.id === bk.id),
      ),
    ];
  }

  /**
   * Remembers that the user deleted one of `builtins` (this mode's), so it stays hidden until
   * restore-builtins. Any other id is the user's own item, which the delete already removed.
   */
  private markBuiltinDismissed(id: string, builtins: readonly { id: string }[]): void {
    if (!builtins.some((b) => b.id === id)) return;
    const list = this.store.data.preferences.dismissedBuiltinIds ?? [];
    if (!list.includes(id)) {
      this.store.data.preferences.dismissedBuiltinIds = [...list, id];
    }
  }

  private getInfraEdgesList(): InfraGraphEdge[] {
    const stored = this.store.data.infraEdges ?? [];
    if (!isDemoMode()) return stored;
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    return [
      ...stored,
      ...getDemoInfraEdges().filter(
        (de) => !dismissed.has(de.id) && !stored.some((e) => e.id === de.id),
      ),
    ];
  }

  private getWorkforceRunsList(): WorkforceRun[] {
    const stored = this.store.data.workforceRuns ?? [];
    if (!isDemoMode()) return stored;
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    return [
      ...stored,
      ...getDemoWorkforceRuns().filter(
        (dw) => !dismissed.has(dw.id) && !stored.some((w) => w.id === dw.id),
      ),
    ];
  }

  /** The Mission Agents a workforce request addresses (ids/names, else the cluster's, else all enabled). */
  private selectWorkforceAgents(opts: {
    agentIds?: string[];
    targetCluster?: string;
  }): MissionAgent[] {
    const allAgents = this.getAgentsList().filter((a) => a.enabled !== false);
    if (opts.agentIds && opts.agentIds.length > 0) {
      const qList = opts.agentIds.map((x) => x.toLowerCase());
      const filtered = allAgents.filter((a) =>
        qList.some(
          (q) =>
            // By id or exact name only: "db" must not also start "db-backup".
            a.id.toLowerCase() === q || a.name.toLowerCase() === q,
        ),
      );
      // Named agents that are all paused or unknown: nobody runs, rather than everybody.
      if (filtered.length === 0)
        throw new Error(`None of ${opts.agentIds.join(", ")} can run: they are paused, or there is no agent by that name.`);
      return filtered.filter((a) => tokensLeft(a, this.usageTotal()) > 0);
    } else if (opts.targetCluster && opts.targetCluster !== "ALL") {
      const cl = opts.targetCluster.toLowerCase();
      const clusterMatched = allAgents.filter(
        (a) => a.targetCluster && a.targetCluster.toLowerCase().includes(cl),
      );
      if (clusterMatched.length > 0) {
        return [
          ...clusterMatched,
          ...allAgents.filter((a) => !clusterMatched.includes(a)).slice(0, 2),
        ];
      }
    }
    return allAgents.filter((a) => tokensLeft(a, this.usageTotal()) > 0);
  }

  /** The conversation changes hands. A notice, not an answer: it is never written over by a run's text. */
  private applyHandoff(task: AgentTask, toAgent: MissionAgent, reason?: string): void {
    const prevAgentName = task.agentName || "Default Assistant";
    // Who answered the first question: a test case made of this conversation replays that agent.
    task.startedAs ??= { agentId: task.agentId, mode: task.mode };
    task.agentId = toAgent.id;
    task.agentName = toAgent.name;
    task.handoffTo = undefined;
    // Handing over never gives more freedom: the conversation keeps the more careful of the two modes.
    task.mode = lowerMode(task.mode, toAgent.defaultMode);
    task.updatedAt = Date.now();
    task.messages.push({
      id: crypto.randomUUID(),
      role: "system",
      text: `**Handed over: ${prevAgentName} → ${toAgent.name}**\n${reason ? `Reason: *${clip(reason, 400)}*\n` : ""}Mission: ${toAgent.mission}`,
      at: Date.now(),
    });
  }

  /**
   * A stdio MCP server is a program started on this machine as the app's own account. On a shared
   * server that account holds every user's keys and sign-ins, so only an administrator adds or starts one.
   */
  private assertMcpProgramAllowed(server: Pick<McpServerConfig, "transport">): void {
    if (server.transport !== "http" && this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("An MCP server that runs as a program runs on the shared server itself. Only an administrator of this server adds or starts one. Use one with an address (HTTP) instead.");
  }

  /**
   * An external agent's runner is a program started on this machine as the app's own account, like a
   * stdio MCP server: on a shared server only an administrator adds or starts one. Asked on save and on every start.
   */
  private assertRunnerAllowed(): void {
    if (this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("An external agent runs as a program on the shared server itself. Only an administrator of this server adds or starts one.");
  }

  /** Asked each time an MCP server is about to be started or called: see McpClientManager. */
  private async assertMcpReach(server: McpServerConfig): Promise<void> {
    this.assertMcpProgramAllowed(server);
    if (server.transport !== "http") return;
    const url = server.url?.trim();
    if (!url) return;
    // The person's own machine may talk to a plain-http server on its own network; a shared server may not be sent anywhere.
    await guardUrl(url, { ...this.outboundGuard(), allowPlainHttp: !this.sharedServer(), ...(this.kbNetwork ? { lookup: this.kbNetwork.lookup } : {}) });
  }

  /**
   * On a shared server, a storage target whose address a user typed is checked like a link they
   * typed: reading a bucket into the knowledge base must not be a way to make the server call
   * its own loopback or the network around it.
   */
  private async assertStorageReach(targetRef: string): Promise<void> {
    if (!this.sharedServer()) return;
    const q = targetRef.trim().replace(/^@/, "").toLowerCase();
    const profiles = (await this.host.extraAppContext?.().catch(() => undefined))?.s3Profiles ?? [];
    // Every profile the name could stand for: the storage is resolved by id, by name and by part of a name.
    const meant = profiles.filter((s) => {
      const id = s.id.toLowerCase();
      return id === q || `s3-${id}` === q || s.name.toLowerCase().includes(q);
    });
    for (const profile of meant) {
      const endpoint = profile.endpoint?.trim();
      if (!endpoint) continue;
      await guardUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`, {
        ...this.outboundGuard(),
        allowPlainHttp: true,
        lookup: this.kbNetwork?.lookup,
      });
    }
  }

  /** The server as the team shares it, when it is one: not a person's own server, and not a vault's (the vault has its own roles). */
  private async teamServerCopy(profileId: string | undefined): Promise<WorkspaceServerSummary | undefined> {
    if (!profileId) return undefined;
    const found = await this.knownServer(profileId);
    return found && found.shared !== false && !found.fromVault ? found : undefined;
  }

  private async knownServer(profileId: string): Promise<WorkspaceServerSummary | undefined> {
    const extra = await this.collectExtraContext().catch(() => undefined);
    return (extra?.workspaceServers ?? []).find((s) => s.id === profileId);
  }

  /**
   * On a shared server, where a server the team shares leads is the administrator's to decide:
   * a member who points it somewhere else, renames it, takes it out of the team or lifts its
   * "prod" tag changes what every teammate and every teammate's agent connects to and is asked about.
   * A member still describes it, tags it, and sets their own user name and key for it.
   */
  private assertMayChangeTeamServer(
    known: WorkspaceServerSummary | undefined,
    next: { name?: string; host?: string; port?: number; username?: string; shared?: boolean; tags?: string[] },
  ): void {
    if (!known || !this.sharedServer() || this.host.teamAdmin?.()) return;
    const who = "Only an administrator of this server";
    if (next.shared === false) throw new Error(`${who} takes a server out of the team's list.`);
    const moved =
      (next.name !== undefined && next.name.trim() !== known.name) ||
      (next.host !== undefined && next.host.trim() !== known.host) ||
      (next.port !== undefined && next.port !== (known.port || 22)) ||
      (next.username !== undefined && next.username !== (known.username || "root"));
    if (moved)
      throw new Error(
        `${who} changes the name, address, port or user name of a server the team shares. Your own user name and key for it are set under "only for me".`,
      );
    const lifted = (known.tags ?? []).filter(isProdTag).filter((t) => !(next.tags ?? known.tags ?? []).some((x) => x.trim().toLowerCase() === t.toLowerCase()));
    if (lifted.length) throw new Error(`${who} takes the tag "${lifted[0]}" off a server the team shares: it is what makes changes there wait for a person.`);
  }

  /**
   * The safety rules a run is held to. On a shared server a member's own rules may be stricter than
   * the team's, never looser: one stored before that rule (switched off by a member) counts as on.
   */
  private safetyPolicy(): SafetyPolicyConfig {
    const own = this.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY;
    if (!this.sharedServer() || this.host.teamAdmin?.()) return own;
    return { ...own, requireApprovalOnProdTags: true, blockDestructiveWithoutConfirm: true };
  }

  /**
   * The model's address is called on every run with the person's prompt and key. On a shared server it
   * is held to the same rule as any other address a user gives: not the server itself, not its private
   * network (unless the administrator allows it). Asked when it is set and again when a run starts.
   */
  private async assertModelEndpointReach(baseUrl: string | undefined): Promise<void> {
    if (!baseUrl || !this.sharedServer()) return;
    await guardUrl(baseUrl, { ...this.outboundGuard(), allowPlainHttp: true, ...(this.kbNetwork ? { lookup: this.kbNetwork.lookup } : {}) });
  }

  private assertMayRemoveTeamServer(known: WorkspaceServerSummary | undefined): void {
    if (known && this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("Only an administrator of this server removes a server the team shares.");
  }

  /**
   * The ordinary connection editor (`profiles:save-ssh`, `profiles:delete-ssh`, a folder removed with
   * its servers) is held to the same rule as the hub's own server actions: one rule for both doors.
   */
  async assertMayChangeServerProfile(next: { id: string; name?: string; host?: string; port?: number; username?: string; shared?: boolean; tags?: string[] }): Promise<void> {
    if (!this.sharedServer() || this.host.teamAdmin?.()) return;
    this.assertMayChangeTeamServer(await this.teamServerCopy(next.id), { ...next, port: next.port || 22, username: next.username?.trim() || "root", tags: next.tags ?? [] });
  }

  async assertMayRemoveServerProfile(id: string): Promise<void> {
    if (!this.sharedServer() || this.host.teamAdmin?.()) return;
    this.assertMayRemoveTeamServer(await this.teamServerCopy(id));
  }

  /** On a shared server, the team's bucket is the administrator's to set up, change or disconnect: one member's change is everyone's. */
  private assertTeamAdmin(): void {
    if (this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("Only an administrator of this server sets up, changes or disconnects the team's bucket.");
  }

  /**
   * The team bucket as this user sees it. Its invite code carries the bucket's secret key, so on a
   * shared server only an administrator is given it.
   */
  private teamBucketView(): ReturnType<S3WorkspaceSyncService["getStatus"]> {
    const status = this.s3Workspace.getStatus();
    return this.sharedServer() && !this.host.teamAdmin?.() ? { ...status, inviteCode: undefined } : status;
  }

  /**
   * A test case is replayed against the question as it was asked. What tells about the present
   * moment is left out of what the replay is given: activity after the case was made, how the
   * servers stand now, what changed on them lately and what the open terminals show. Otherwise a
   * case made before a fix fails after it, whatever the agent does: it is told the fault is over.
   * Memory and the pages stay: they are what a test is run to try.
   */
  private asOfEvalCase(task: AgentTask, extra: ExtraWorkspaceContext): ExtraWorkspaceContext {
    if (!task.evalCaseId) return extra;
    const found = (this.store.data.evalCases ?? []).find((c) => c.id === task.evalCaseId);
    const asOf = found?.createdAt ?? 0;
    return {
      ...extra,
      asOf,
      activityLog: (extra.activityLog ?? this.store.data.activityLog ?? []).filter((a) => a.at <= asOf),
      recentServerChanges: [],
      serverFactsNow: [],
      workforceRuns: [],
    };
  }

  /** Paused means paused, and a spent budget is spent: however an agent is started. */
  private assertMayRun(agent: MissionAgent): void {
    if (agent.enabled === false) throw new Error(`${agent.name} is paused. Switch it on again before starting it.`);
    if (tokensLeft(agent, this.usageTotal()) <= 0)
      throw new Error(`${agent.name} has used its token budget for this month. Raise it or wait for the new month.`);
  }

  private storeWorkforceRun(run: WorkforceRun): void {
    this.store.data.workforceRuns = [
      run,
      ...(this.store.data.workforceRuns ?? []).filter((r) => r.id !== run.id),
    ].slice(0, 25);
  }

  /** Resolves when the task's model run has ended and its runtime is released. */
  private whenSettled(task: AgentTask): Promise<void> {
    if (
      !active(task) &&
      !this.runtimes.has(task.id) &&
      !this.launches.has(task.id)
    )
      return Promise.resolve();
    return new Promise((resolve) => {
      const list = this.settleWaiters.get(task.id) ?? [];
      list.push(resolve);
      this.settleWaiters.set(task.id, list);
    });
  }

  private settled(taskId: string): void {
    this.scheduledRunEnded(taskId);
    const list = this.settleWaiters.get(taskId);
    if (!list) return;
    this.settleWaiters.delete(taskId);
    for (const resolve of list) resolve();
  }

  /**
   * Starts a workforce run: every selected Mission Agent investigates the
   * objective in its own read-only model run, then one more run combines the
   * reports. `run` is the live record (already stored); `done` settles when the
   * whole run has ended. Without a reachable model the specialists fail with the
   * provider's error — nothing is written on their behalf.
   *
   * Demo mode alone plays the scripted demo run instead (marked `simulated`).
   */
  private async beginWorkforceRun(opts: {
    prompt: string;
    agentIds?: string[];
    targetCluster?: string;
    createTask?: boolean;
  }): Promise<{ run: WorkforceRun; done: Promise<WorkforceRun> }> {
    if (isDemoMode()) {
      const run = await this.simulateDemoWorkforceRun(opts);
      return { run, done: Promise.resolve(run) };
    }
    if (!(await this.config.getConfig()).enabled)
      throw new Error("Enable AI and configure a model in Hub settings first");

    let lead: AgentTask | undefined;
    if (opts.createTask) {
      const now = Date.now();
      lead = {
        id: crypto.randomUUID(),
        title: `Workforce: ${clip(opts.prompt, 90)}`,
        agentName: "Workforce lead",
        mode: "advice",
        status: "running",
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            text: boundedPrompt(opts.prompt, PERSON_PROMPT_MAX),
            at: now,
          },
          { id: crypto.randomUUID(), role: "assistant", text: "", at: now },
        ],
        changes: [],
        sources: [],
        createdAt: now,
        updatedAt: now,
        maxCommands: 1,
        maxMinutes: 30,
        verification: "not-verified",
      };
      this.store.data.tasks.push(lead);
    }

    let current: WorkforceRun | undefined;
    const done = runWorkforce(
      {
        prompt: opts.prompt,
        agents: this.selectWorkforceAgents(opts),
        targetCluster: opts.targetCluster,
      },
      {
        cancelled: () => this.disposed || (lead ? !active(lead) : false),
        runSpecialist: (input) => this.runReadOnlySpecialist(input),
        onProgress: (run) => {
          current = run;
          this.storeWorkforceRun(run);
          if (lead) {
            this.workforceLeads.set(run.id, lead.id);
            // A lead the user stopped keeps its "interrupted" state.
            if (active(lead)) {
              lead.messages[1].text = renderWorkforceProgress(run);
              lead.updatedAt = Date.now();
              if (run.status !== "running") {
                lead.status = run.status;
                lead.error = run.error;
                if (run.status === "failed") lead.verification = "incomplete";
              }
            }
          }
          if (run.status !== "running") this.workforceLeads.delete(run.id);
          this.changed();
        },
      },
    );
    // runWorkforce reports its initial state before its first await.
    return { run: current!, done };
  }

  /**
   * Starts one of the hub's own background runs and waits for it to end. A
   * run that fails on the fast model (not served by this endpoint, overloaded,
   * declined) is run once more on the main model, so setting a fast model can
   * make background work cheaper but not make it fail.
   */
  private async runBackground(
    input: StartAgentTask,
    tag: {
      workforceRunId?: string;
      distillSourceId?: string;
      title: string;
      mainModel?: boolean;
      investigator?: boolean;
    },
  ): Promise<AgentTask> {
    const task = await this.start(input, undefined, tag);
    await this.whenSettled(task);
    if (task.status !== "failed") return task;
    const fast = (await this.config.getConfig().catch(() => undefined))?.fastModel;
    if (!fast || task.model !== fast) return task;
    log.warn("Background run failed on the fast model; trying the main model", safeError(task.error));
    const again = await this.start(input, undefined, { ...tag, mainModel: true });
    await this.whenSettled(again);
    return again;
  }

  /**
   * One read-only model run to its end (context, knowledge base, remote files;
   * no terminal, no management tool), and what it answered. Used by workforce
   * reviews and by an agent's own investigations.
   */
  private async runReadOnlySpecialist(input: {
    runId: string;
    prompt: string;
    agent?: MissionAgent;
    agentName: string;
    /** A terminal of the run's own: it may then run read-only commands there. */
    sessionId?: string;
    /** Work that needs the main model's judgment even when a fast model is set. */
    mainModel?: boolean;
  }): Promise<{
    taskId?: string;
    status: "completed" | "failed";
    text: string;
    error?: string;
  }> {
    const task = await this.runBackground(
      {
        prompt: input.prompt,
        mode: "advice",
        agentId: input.agent?.id,
        agentName: input.agentName,
        sessionId: input.sessionId,
        maxCommands: input.sessionId ? 15 : 1,
        maxMinutes: 10,
      },
      {
        workforceRunId: input.runId,
        investigator: Boolean(input.sessionId),
        title: `${input.agentName} · read-only`,
        ...(input.mainModel ? { mainModel: true } : {}),
      },
    );
    const text =
      task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
    return task.status === "completed"
      ? { taskId: task.id, status: "completed", text }
      : {
          taskId: task.id,
          status: "failed",
          text,
          error: task.error ?? `The run ended as ${task.status}.`,
        };
  }

  /**
   * Has a plan reviewed by a second, read-only run before the user sees it.
   * The reviewer has none of the planning agent's conversation, only the plan
   * and the request, and checks it against the workspace. It runs on the main
   * model: this is judgment, not reading. A review that cannot be had is
   * reported as `unreviewed`, never as an approval.
   */
  async reviewPlan(
    task: AgentTask,
    plan: Parameters<typeof reviewerPrompt>[0],
  ): Promise<AgentPlan["review"]> {
    const request =
      task.messages.filter((m) => m.role === "user").at(-1)?.text ?? task.title;
    try {
      const result = await this.runReadOnlySpecialist({
        runId: `plan-${crypto.randomUUID().slice(0, 8)}`,
        prompt: reviewerPrompt(plan, request),
        agentName: "Plan reviewer",
        mainModel: true,
      });
      if (result.status !== "completed" || !result.text.trim())
        return {
          verdict: "unreviewed",
          findings: [
            `The review could not be done: ${result.error ?? "the reviewer gave no answer"}. This plan has not been reviewed.`,
          ],
        };
      return parseReview(result.text);
    } catch (error) {
      return {
        verdict: "unreviewed",
        findings: [
          `The review could not be done: ${safeError(error)}. This plan has not been reviewed.`,
        ],
      };
    }
  }

  /**
   * An agent hands questions to read-only investigators that look in
   * parallel (at most four questions, three at a time) and gets their reports
   * back together. Each investigator is a model run of its own with a fresh
   * context, so the asking agent's context is spent on the answers, not on the
   * reading. A question whose investigator fails comes back with the error.
   */
  async investigate(
    parent: AgentTask,
    questions: Array<{ question: string; scope?: string }>,
  ): Promise<
    Array<{ question: string; status: "answered" | "failed"; report: string }>
  > {
    const asked = questions.slice(0, MAX_INVESTIGATIONS);
    const runId = `inv-${crypto.randomUUID().slice(0, 8)}`;
    const results = new Array<{
      question: string;
      status: "answered" | "failed";
      report: string;
    }>(asked.length);
    let next = 0;
    // Its investigators belong to the asking run: stopping it stops them (stop() follows workforceLeads).
    this.workforceLeads.set(runId, parent.id);
    const worker = async (): Promise<void> => {
      while (next < asked.length) {
        const index = next++;
        const { question, scope } = asked[index];
        if (this.disposed || !active(parent)) {
          results[index] = {
            question,
            status: "failed",
            report: "Not started: the asking run was stopped.",
          };
          continue;
        }
        // A terminal of its own on the same target, so it can look for itself. Where
        // one cannot be opened (the target needs an interactive login) it works from what is known.
        const sessionId = await this.openInvestigatorTerminal(parent);
        try {
          const result = await this.runReadOnlySpecialist({
            runId,
            prompt:
              investigatorPrompt(question, scope, parent.title) +
              (sessionId
                ? "\n\nYou have a terminal of your own on the target. You may run read-only commands there (looking at state, logs, configuration); anything that would change the system is refused. Say which command showed what."
                : "\n\nNo terminal could be opened for you on the target, so you cannot run commands: work from the workspace's context and the knowledge base, and say what would have to be checked on the system."),
            agentName: `Investigator ${index + 1}`,
            sessionId,
          }).finally(() => {
            if (sessionId) this.host.closeSession?.(sessionId);
          });
          results[index] =
            result.status === "completed" && result.text.trim()
              ? {
                  question,
                  status: "answered",
                  report: clip(result.text, 12_000),
                }
              : {
                  question,
                  status: "failed",
                  report: result.error ?? "The investigator ended without a report.",
                };
        } catch (error) {
          results[index] = { question, status: "failed", report: safeError(error) };
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(3, asked.length) }, () => worker()),
      );
    } finally {
      this.workforceLeads.delete(runId);
      // What the investigators spent is the asking agent's spending.
      if (parent.agentId) {
        const used = this.store.data.tasks
          .filter((t) => t.workforceRunId === runId)
          .reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0), 0);
        if (used > 0) this.store.data.agentUsage = addUsage(this.store.data.agentUsage ?? {}, parent.agentId, used);
      }
    }
    return results;
  }

  /**
   * Opens a terminal of the hub's own on a saved target and connects to it at
   * its prompt: for a run nobody is sitting at (a schedule, a ticket the
   * heartbeat took, an investigator). The one way such a terminal is made
   * ready, so that a run is never started on one that cannot run anything.
   * A terminal that does not get to a prompt is closed again, and the error
   * says what it last showed.
   */
  private async openUnattendedTerminal(
    target: { profileId: string; shell: AgentSchedule["shell"] },
    label: string,
  ): Promise<string> {
    const id = await this.host.openSchedule({ profileId: target.profileId, shell: target.shell }, label);
    try {
      await this.terminals.armAtPrompt(id, target.shell);
    } catch (error) {
      this.host.closeSession?.(id);
      throw error;
    }
    return id;
  }

  /** Opens a terminal for an investigator on the parent's target. Undefined when that is not possible. */
  private async openInvestigatorTerminal(parent: AgentTask): Promise<string | undefined> {
    if (isDemoMode() || !parent.target || !this.host.closeSession) return undefined;
    const session = this.terminals.get(parent.target.sessionId);
    if (!session || session.kind === "k8s" || !session.shell) return undefined;
    try {
      return await this.openUnattendedTerminal(
        { profileId: session.kind === "local" ? "local" : (session.profileId ?? ""), shell: session.shell },
        `Investigator: ${clip(parent.target.label.replace(/^(?:Investigator|Schedule|Ticket): /, ""), 80)}`,
      );
    } catch (error) {
      log.info("No terminal for an investigator", safeError(error));
      return undefined;
    }
  }

  /** The scripted demo-mode workforce run. No model is called; the run says so. */
  private async simulateDemoWorkforceRun(opts: {
    prompt: string;
    agentIds?: string[];
    targetCluster?: string;
    createTask?: boolean;
  }): Promise<WorkforceRun> {
    const extra = await this.collectExtraContext();
    const allServers = extra.workspaceServers ?? [];
    const kbDocs = this.getKbDocumentsList();

    let selectedAgents = this.selectWorkforceAgents(opts);

    if (selectedAgents.length === 0) {
      selectedAgents = [
        {
          id: "default-sre-specialist",
          name: "General Infrastructure SRE",
          role: "Linux, SSH & S3 Specialist",
          icon: "🤖",
          mission: "Inspect cluster nodes, services, and storage health.",
          systemPrompt: "",
          defaultMode: "assisted",
          updatedAt: Date.now(),
        },
      ];
    }

    const allMemories = extra.memories ?? this.store.data.memories;
    const allEdges = this.getInfraEdgesList();

    const steps: WorkforceStep[] = selectedAgents.slice(0, 4).map((ag, idx) => {
      const cluster = ag.targetCluster || opts.targetCluster || "Workspace";
      const clusterNodes = allServers.filter(
        (s) =>
          cluster === "Workspace" ||
          (s.cluster && s.cluster.toLowerCase() === cluster.toLowerCase()),
      );
      const kbMatches = this.kb.search(kbDocs, {
        query: `${opts.prompt} ${ag.role} ${cluster}`,
        cluster,
        limit: 2,
      });
      const rankedSkills = this.kb
        .rankMemories(allMemories, `${opts.prompt} ${ag.role}`, cluster, 2)
        .filter((m) => m.kind === "skill");
      const relatedEdges = allEdges.filter((e) =>
        clusterNodes.some(
          (n) =>
            n.name.toLowerCase() === e.from.toLowerCase() ||
            n.name.toLowerCase() === e.to.toLowerCase(),
        ),
      );
      const nodeNames =
        clusterNodes.slice(0, 3).map((n) => n.name).join(", ") || cluster;
      const kbHint =
        kbMatches.length > 0
          ? `From the knowledge base, "${kbMatches[0].title}": ${kbMatches[0].snippet.slice(0, 160)}…`
          : `Looked at ${clusterNodes.length || 1} node${(clusterNodes.length || 1) === 1 ? "" : "s"} (${nodeNames}) for the mission "${ag.mission.slice(0, 90)}".`;
      const skillHint =
        rankedSkills.length > 0
          ? ` [Skill: ${rankedSkills[0].title}]`
          : "";
      const edgeHint =
        relatedEdges.length > 0
          ? ` [Depends: ${relatedEdges[0].from} → ${relatedEdges[0].to} (${relatedEdges[0].relation})]`
          : "";

      const recCmds = [
        ...(rankedSkills
          .map((s) => s.sourceCommand)
          .filter((c): c is string => Boolean(c))),
        ...(cluster.toLowerCase().includes("ontap")
          ? [
              "qos statistics volume latency show -iterations 1",
              "snapmirror show",
            ]
          : cluster.toLowerCase().includes("ceph")
            ? ["ceph status && ceph osd df tree", "zpool status -v"]
            : cluster.toLowerCase().includes("k8s") ||
                cluster.toLowerCase().includes("trident")
              ? [
                  "kubectl get pvc,volumeattachment -A -o wide",
                  "multipath -ll",
                ]
              : ["uptime && df -h && systemctl --failed"]),
      ].slice(0, 3);

      return {
        id: `wf-step-${Date.now()}-${idx}`,
        agentId: ag.id,
        agentName: ag.name,
        agentIcon: ag.icon || "🤖",
        role: ag.role,
        targetCluster: cluster,
        subTask: `Part for ${ag.name} (${cluster}): ${opts.prompt.slice(0, 140)}`,
        status: "completed",
        findings: `Covered ${nodeNames}. ${kbHint}${skillHint}${edgeHint}`,
        recommendedCommands: recCmds,
      };
    });

    const synthesis = [
      `### Workforce summary (${steps.length} specialist agents, in parallel)`,
      "> **Demo mode:** this is a scripted run. No model was called and nothing was checked.",
      `Mission: **${opts.prompt}**`,
      "",
      ...steps.map(
        (s, i) =>
          `${i + 1}. **${s.agentName}** (*${s.targetCluster || s.role}*): ${s.findings}`,
      ),
      "",
      "**Next:** go through the suggested checks per cluster, or run them on every node at once with `sshs3_cluster_exec`.",
    ].join("\n");

    const run: WorkforceRun = {
      id: `wf-${crypto.randomUUID().slice(0, 8)}`,
      title: clip(opts.prompt, 90),
      prompt: boundedContext(opts.prompt, 2000),
      leadAgentName: "Lead SRE Workforce Orchestrator",
      targetCluster: opts.targetCluster || "ALL",
      status: "completed",
      steps,
      synthesis,
      simulated: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.storeWorkforceRun(run);
    saveDemoWorkforceRun(run);

    if (opts.createTask) {
      const now = Date.now();
      const wfTask: AgentTask = {
        id: crypto.randomUUID(),
        title: `Workforce: ${run.title}`,
        agentName: run.leadAgentName,
        mode: "assisted",
        status: "completed",
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            text: `[Multi-Agent Workforce] ${opts.prompt}`,
            at: now - 1000,
          },
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: synthesis,
            at: now,
          },
        ],
        changes: [],
        sources: [],
        createdAt: now - 1000,
        updatedAt: now,
        maxCommands: 20,
        maxMinutes: 15,
        verification: "not-verified",
      };
      this.store.data.tasks.push(wfTask);
    }

    return run;
  }

  async snapshot(): Promise<HubSnapshot> {
    await this.initialize();
    const manifest = await new HermesManager().getManifest();
    const preview = this.previewId && this.terminals.get(this.previewId);
    const extra = await this.collectExtraContext();
    const configView: import("../../../shared/types/ai").AiConfigView =
      await this.config.getView().catch((e) => {
        log.warn("Config view read failed in snapshot, using fallback", safeError(e));
        return {
          enabled: false,
          provider: "openai-codex" as const,
          model: "gpt-6.1-sol",
          useHermes: false,
          hasApiKey: false,
          keyStorage: "encrypted" as const,
        };
      });
    const contextWindowTokens = configView.contextWindowTokens ?? 128000;
    const terminalContextChars = configView.terminalContextChars ?? 8000;
    const maxOutputTokens = configView.maxOutputTokens ?? 8192;
    const maxToolTurns = configView.maxToolTurns ?? 20;
    const reasoningEffort = configView.reasoningEffort ?? "medium";
    const temperature = configView.temperature ?? 0.2;
    const kbDocs = this.getKbDocumentsList();
    const kbUse = this.pageUse();
    const kbPagesUsed = withUse(this.store.data.kbPages ?? [], kbUse);
    const dismissedIds = new Set(
      this.store.data.preferences.dismissedBuiltinIds ?? [],
    );
    const allTasks = isDemoMode()
      ? [
          ...getDemoTasks().filter(
            (dt) =>
              !dismissedIds.has(dt.id) &&
              !this.store.data.tasks.some((t) => t.id === dt.id),
          ),
          ...this.store.data.tasks,
        ]
      : this.store.data.tasks;
    const allMemories = extra.memories ?? this.store.data.memories;
    const allInfraEdges = this.getInfraEdgesList();
    const allMcpServers = this.mcpServersShown();

    return {
      preview: preview
        ? {
            id: "terminal:" + preview.id,
            sessionId: preview.id,
            label: preview.label,
            text: this.terminals.context(preview.id),
            observedAt: Date.now(),
          }
        : undefined,
      config: configView,
      preferences: this.store.data.preferences,
      demoMode: isDemoMode(),
      runtime: {
        bundled: true,
        version: manifest?.tag ?? "native-ts-1.0",
      },
      sessions: this.terminals.list(),
      // The tool log is for the model's next run; the UI shows changes and messages.
      tasks: allTasks.map(({ toolLog: _toolLog, ...task }) => task),
      memories: allMemories,
      memoryProposals: this.store.data.memoryProposals ?? [],
      memoryDistillRunning: this.distilling.size > 0,
      lastMemoryDistill: this.store.data.lastMemoryDistill,
      schedules: isDemoMode()
        ? [
            ...this.store.data.schedules,
            ...getDemoSchedules().filter(
              (ds) =>
                !dismissedIds.has(ds.id) &&
                !this.store.data.schedules.some((s) => s.id === ds.id),
            ),
          ]
        : this.store.data.schedules,
      inventory: this.store.data.inventory,
      activityLog: extra.activityLog ?? this.store.data.activityLog ?? [],
      workspaceServers: extra.workspaceServers ?? [],
      s3Workspace: this.teamBucketView(),
      presence: this.mergePresence(
        this.s3Workspace.getPresence(),
        this.host.peerPresenceProvider?.() ?? [],
      ),
      localOverrides: { ...(this.store.data.localOverrides ?? {}) },
      agents: this.getAgentsList(),
      mcpServers: allMcpServers,
      mcpCatalog: mcpCatalog(),
      externalRunners: [...(this.store.data.externalRunners ?? [])],
      externalRunnerPresets: EXTERNAL_RUNNER_PRESETS,
      workGoals: live(this.store.data.workGoals),
      workTickets: live(this.store.data.workTickets),
      agentUsage: this.usageTotal(),
      workforceTemplates: templateSummaries(),
      workBoardSync: {
        shared: this.s3Workspace.canUseBucket(),
        lastSyncAt: this.workSyncAt,
        error: this.workSyncError,
      },
      // The list carries the beginning of each text; the whole comes with kb-read.
      kbDocuments: kbDocs.map((d) => ({
        ...d,
        content: d.content.slice(0, 700),
        contentLength: d.content.length,
        chunks: [],
        chunkCount: Math.max(1, d.chunks?.length ?? d.chunkCount ?? 1),
      })),
      evalCases: (this.store.data.evalCases ?? []).map(({ recorded, ...rest }) => ({ ...rest, recordedCalls: recorded.length })),
      evalRunning: this.evalRunningId,
      dailyReport: this.store.data.dailyReport,
      kbWork: {
        rebuilding: [...this.rebuildingPages],
        checkingContradictions: this.checkingContradictions,
        lastCheck: this.lastContradictionCheck,
        rebuilt: Object.fromEntries(this.lastRebuilds),
      },
      notifications: this.notificationsView(),
      serverFacts: this.factsView(),
      alertIntake: {
        canReceive: Boolean(this.host.alertHookOwner),
        enabled: Boolean(this.store.data.alertHook),
        lastAt: this.store.data.alertHook?.lastAt,
        received: this.store.data.alertHook?.received ?? 0,
        rules: this.store.data.alertRules ?? [],
      },
      // History keeps what a change replaced; the list does not carry those texts.
      localMcp: this.localMcpView(),
      kbPages: kbPagesUsed.map((p) => ({
        ...p,
        body: p.body.slice(0, 500),
        history: p.history.map((h) => ({ at: h.at, by: h.by, summary: h.summary, ...(h.previous ? { previous: { title: "", when: "", body: "", targets: [], sources: [] } } : {}) })),
      })),
      kbFindings: lintKnowledgeBase({
        pages: kbPagesUsed,
        docs: kbDocs,
        known: (extra.workspaceServers ?? []).flatMap((x) => [x.name, x.cluster]).filter((x): x is string => Boolean(x)),
        gaps: this.store.data.kbGaps ?? [],
        contradictions: this.store.data.kbContradictions,
        use: kbUse,
        dismissed: this.store.data.kbDismissedFindings,
      }),
      kbReading: {
        waiting: kbDocs.filter((d) => d.reading?.state === "queued" || d.reading?.state === "reading").length,
        reading: kbDocs.find((d) => d.id === this.kbReadingId)?.title,
        failed: kbDocs.filter((d) => d.reading?.state === "failed").length,
        needsModel: this.kbNeedsModel || undefined,
      },
      workforceRuns: this.getWorkforceRunsList(),
      infraEdges: allInfraEdges,
      safetyPolicy: this.safetyPolicy(),
      safetyPolicyChanged: this.store.data.safetyPolicyChanged,
      pendingLayoutEvent: this.pendingLayoutEvent,
      selfLearning: this.selfLearning.getStatus({
        memories: allMemories,
        tasks: allTasks,
        kbDocuments: kbDocs,
        infraEdges: allInfraEdges,
        mcpServerCount: allMcpServers.length,
      }),
      contextBudget: {
        contextWindowTokens,
        terminalContextChars,
        maxOutputTokens,
        maxToolTurns,
        reasoningEffort,
        temperature,
      },
    };
  }

  private mergePresence(
    s3Presence: import("../../../shared/types/aiHub").WorkspacePresenceEntry[],
    peerPresence: import("../../../shared/types/aiHub").WorkspacePresenceEntry[],
  ): import("../../../shared/types/aiHub").WorkspacePresenceEntry[] {
    const map = new Map<
      string,
      import("../../../shared/types/aiHub").WorkspacePresenceEntry
    >();
    for (const p of s3Presence) {
      if (p?.actor) map.set(p.actor, p);
    }
    for (const p of peerPresence) {
      if (!p?.actor) continue;
      const existing = map.get(p.actor);
      if (!existing || p.updatedAt >= existing.updatedAt) {
        map.set(p.actor, p);
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.actor.localeCompare(b.actor),
    );
  }

  async request(request: HubRequest): Promise<HubSnapshot> {
    await this.initialize();
    // What this request returns beside the snapshot. Local to the call: requests overlap.
    let reply: HubReply | undefined;
    if (this.disposed) throw new Error("Application is shutting down");
    if (!request || typeof request.action !== "string")
      throw new Error("Invalid AI request");
    if (process.env.SSHS3_NATIVE_HERMES === '1' && ['start', 'reply', 'resume', 'schedule-save'].includes(request.action))
      throw new Error('This installation uses native Hermes. Open the Hermes chat to start or schedule work.');
    switch (request.action) {
      case "snapshot":
        return this.snapshot();
      case "inspect":
        this.previewId = request.sessionId;
        break;
      case "resume": {
        const task = this.task(request.taskId);
        if (active(task)) throw new Error("Task is still active");
        await this.reviveOwnTerminal(task);
        if (task.target) {
          const session = this.terminals.get(task.target.sessionId);
          if (!session || session.state === "disconnected") {
            if (task.mode === "advice") {
              task.target = undefined;
            } else {
              throw new Error("Target terminal is no longer connected");
            }
          } else {
            task.target = {
              sessionId: session.id,
              generation: session.generation,
              label: session.label,
            };
          }
        }
        // After a spent budget, resuming is "Continue": the run gets the same budget again.
        const spent = task.budgetStop;
        const more = spent
          ? `You have ${task.maxCommands} more commands and ${task.maxMinutes} more minutes. Continue where you stopped. `
          : "";
        task.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          text: task.target
            ? `${more}Resume on this terminal. Recheck the current state; do not replay any uncertain command.`
            : spent
              ? more.trim()
              : "Resume the conversation.",
          at: Date.now(),
        });
        await this.launch(task);
        break;
      }
      case "configure": {
        // The preferences are worked out on a copy and checked first: a request that is refused
        // changes nothing, neither the preferences nor the AI settings sent with them.
        const next = { ...this.store.data.preferences };
        if (request.preferences) {
          const p = request.preferences;
          if (p.retentionDays !== undefined)
            next.retentionDays = integer(
              p.retentionDays,
              1,
              365,
            );
          for (const key of ["background", "autoStart", "inventory"] as const)
            if (p[key] !== undefined)
              next[key] = p[key] === true;
          if (p.proposeMemories !== undefined)
            next.proposeMemories =
              p.proposeMemories === true;
          if (p.autoSaveMemories !== undefined)
            next.autoSaveMemories =
              p.autoSaveMemories === true;
          if (p.workforceAutopilot !== undefined)
            next.workforceAutopilot =
              p.workforceAutopilot === true;
          if (p.approvalWaitMinutes !== undefined)
            next.approvalWaitMinutes = integer(p.approvalWaitMinutes, 1, 60);
          // On a shared server the path is the server's own and set by its administrator: not by whoever is signed in.
          if (p.sharedWorkspacePath !== undefined && !this.hosted()) {
            const cleanedPath = p.sharedWorkspacePath.trim();
            if (cleanedPath) {
              next.sharedWorkspacePath = cleanedPath;
            } else {
              delete next.sharedWorkspacePath;
            }
          }
          if (
            next.autoStart &&
            !next.background
          )
            throw new Error("Autostart requires background mode");
        }
        // Preferences can be changed on their own: the AI settings are touched only when they were sent.
        if (request.config?.baseUrl?.trim()) await this.assertModelEndpointReach(request.config.baseUrl.trim());
        if (request.config) await this.config.update(request.config);
        if (request.preferences) {
          if (!("sharedWorkspacePath" in next)) delete this.store.data.preferences.sharedWorkspacePath;
          Object.assign(this.store.data.preferences, next);
          await this.host.backgroundChanged(
            this.background,
            this.store.data.preferences.autoStart,
          );
        }
        const config = await this.config.getView();
        this.terminals.observe(config.enabled);
        if (!config.enabled)
          for (const task of this.store.data.tasks.filter(active))
            await this.stop(task, "AI disabled");
        break;
      }
      case "start": {
        // Chatting with an agent runs that agent: its pause and its budget hold here too.
        const as = request.task.agentId ? this.getAgentsList().find((a) => a.id === request.task.agentId) : undefined;
        if (as) this.assertMayRun(as);
        reply = { started: { taskId: (await this.start(request.task)).id } };
        break;
      }
      case "reply": {
        const task = this.task(request.taskId);
        const rawAttachments = (request.attachments ?? []).slice(0, 10);
        const replyImages = rawAttachments
          .filter(
            (s) =>
              typeof s.imageDataUrl === "string" &&
              s.imageDataUrl.startsWith("data:image/"),
          )
          .map((s) => ({
            label: clip(s.label || "image", 200),
            dataUrl: s.imageDataUrl!.slice(0, 6_000_000),
            mimeType: s.mimeType,
          }));
        for (const s of rawAttachments) {
          if (!s.imageDataUrl && s.text?.trim()) {
            task.sources.push({
              id: crypto.randomUUID(),
              label: clip(s.label || "attachment", 200),
              text: boundedContext(s.text),
              observedAt: Date.now(),
            });
          }
        }
        const rawText =
          request.text?.trim() ||
          (replyImages.length > 0 ? "Analyze the attached image(s)." : "");
        // A message is read from its start: what a person says first (or an approval's instruction) is kept.
        const text = clip(requiredText(rawText), 16_000);
        if (active(task)) {
          await this.runtimes.get(task.id)?.steer(text);
          task.messages.push({
            id: crypto.randomUUID(),
            role: "user",
            text,
            ...(replyImages.length > 0 ? { images: replyImages } : {}),
            at: Date.now(),
          });
        } else {
          // The run has ended but may still be releasing its runtime: a reply
          // sent in that instant must not fail with "Task already running".
          await this.whenSettled(task);
          if (request.sessionId) {
            const explicitTerminal = this.terminals.get(request.sessionId);
            if (explicitTerminal && explicitTerminal.state !== "disconnected") {
              task.target = {
                sessionId: explicitTerminal.id,
                generation: explicitTerminal.generation,
                label: explicitTerminal.label,
              };
            }
          } else if (task.target) {
            await this.reviveOwnTerminal(task);
            const terminal = this.terminals.get(task.target.sessionId);
            if (terminal && terminal.state !== "disconnected") {
              task.target = {
                sessionId: terminal.id,
                generation: terminal.generation,
                label: terminal.label,
              };
            } else {
              task.target = undefined;
            }
          }
          task.messages.push({
            id: crypto.randomUUID(),
            role: "user",
            text,
            ...(replyImages.length > 0 ? { images: replyImages } : {}),
            at: Date.now(),
          });
          await this.launch(task);
        }
        break;
      }
      case "stop":
        await this.stop(this.task(request.taskId), "Stopped by user");
        break;
      case "takeover":
        this.terminals.takeover(request.sessionId);
        break;
      case "arm":
        if (!SHELL_KINDS.includes(request.shell))
          throw new Error("Unsupported shell");
        await this.terminals.arm(request.sessionId, request.shell);
        break;
      case "approve": {
        // Who answered is written down where the answer is given, before anything runs on it.
        const change = this.store.data.tasks
          .find((t) => t.id === request.taskId)
          ?.changes.find((c) => c.id === request.changeId);
        if (change && change.status === "pending")
          change.decidedBy = { name: await this.resolveActorName(), at: Date.now(), allowed: request.approved === true };
        const approvalNote = typeof request.note === "string" && request.note.trim() ? clip(request.note.trim(), 1000) : undefined;
        this.broker.approve(
          request.taskId,
          request.changeId,
          request.approved === true,
          approvalNote,
        );
        break;
      }
      case "memory-save": {
        const entry = request.entry;
        if (!["memory", "skill"].includes(entry.kind))
          throw new Error("Invalid memory type");
        const scope = requiredText(entry.scope);
        if (
          scope !== "personal" &&
          scope !== "workspace" &&
          !scope.startsWith("target:") &&
          !scope.startsWith("workspace:") &&
          !scope.startsWith("server:") &&
          !scope.startsWith("cluster:")
        )
          throw new Error("Invalid memory scope");
        const savedMemory = await this.saveMemoryInternal({
          id: entry.id,
          kind: entry.kind,
          tier: entry.tier,
          cluster: entry.cluster,
          scope,
          title: requiredText(entry.title),
          text: requiredText(entry.text),
          // On a server with accounts the memory is the signed-in person's: nobody writes one in a teammate's name.
          author: this.hosted() ? await this.resolveActorName() : entry.author,
          sourceCommand: entry.sourceCommand,
          confidence: entry.confidence,
        });
        // A teammate's memory changed by somebody else keeps its author, and the change is in the team's activity.
        if (savedMemory.editedBy && savedMemory.scope !== "personal") {
          const event: WorkspaceActivityEvent = {
            id: crypto.randomUUID(),
            at: Date.now(),
            actor: savedMemory.editedBy,
            targetLabel: savedMemory.title,
            kind: "note",
            summary: `Changed ${savedMemory.author}'s memory "${clip(savedMemory.title, 120)}"`,
          };
          this.appendActivityEvent(event);
          await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        }
        break;
      }
      case "memory-delete": {
        // A server card is written again from the server list every time the memories are read:
        // answering "deleted" would not be true. The card of a server that is gone is not written again.
        if (request.id.startsWith("auto-node:") || request.id.startsWith("auto-cluster:")) {
          const servers = (await this.collectExtraContext().catch(() => undefined))?.workspaceServers ?? [];
          const [kind, rest] = [request.id.slice(0, request.id.indexOf(":")), request.id.slice(request.id.indexOf(":") + 1)];
          const stillThere = kind === "auto-node" ? servers.some((s) => s.id === rest) : servers.some((s) => s.cluster && rest.includes(s.cluster));
          if (stillThere || !this.store.data.memories.some((m) => m.id === request.id))
            throw new Error("This card is written by sshs3 from the server list, so it cannot be forgotten: it would be written again. Remove the server, or correct what it says with a memory of your own.");
        }
        // On a shared server a team memory is forgotten by the person who wrote it or by an administrator.
        const target = this.store.data.memories.find((m) => m.id === request.id);
        if (target && target.scope !== "personal" && target.author && !target.id.startsWith("auto-") && this.sharedServer() && !this.host.teamAdmin?.() && target.author !== (await this.resolveActorName()))
          throw new Error(`Only ${target.author}, who wrote it, or an administrator of this server forgets a memory the team shares. Correct it instead: the change is saved with your name.`);
        // Forgetting a memory forgets the history it replaced too.
        const gone = new Set([request.id]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const m of this.store.data.memories)
            if (m.supersededBy && gone.has(m.supersededBy) && !gone.has(m.id)) {
              gone.add(m.id);
              grew = true;
            }
        }
        this.store.data.memories = this.store.data.memories.filter(
          (m) => !gone.has(m.id),
        );
        this.markBuiltinDismissed(request.id, getBuiltinSkillsAndMemories());
        this.store.data.deletedMemoryIds ??= {};
        for (const id of gone) {
          this.store.data.deletedMemoryIds[id] = Date.now();
          await this.host.deleteWorkspaceMemory?.(id).catch(() => {});
        }
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "memory-feedback": {
        const storedIds = new Set(this.store.data.memories.map((m) => m.id));
        const builtinOrDemoIds = new Set([
          ...getBuiltinSkillsAndMemories().map((m) => m.id),
          ...(isDemoMode() ? getDemoMemories().map((m) => m.id) : []),
        ]);
        const extra = await this.collectExtraContext();
        const combined = [...this.store.data.memories];
        for (const m of extra.memories ?? []) {
          if (!combined.some((x) => x.id === m.id)) combined.push(m);
        }
        const { memories, updated } = this.selfLearning.applyMemoryFeedback(
          combined,
          request.id,
          request.delta,
          // One vote per signed-in person on a server with accounts: a made-up voter is not a person.
          (!this.hosted() && request.voter?.trim()) || (await this.resolveActorName()),
        );
        if (
          updated &&
          isDemoMode() &&
          (builtinOrDemoIds.has(updated.id) || isDemoTarget(updated.id))
        ) {
          saveDemoMemory(updated);
        }
        if (!updated) throw new Error("Memory not found");
        this.store.data.memories = memories.filter((m) => {
          if (storedIds.has(m.id)) return true;
          if (
            m.id === request.id &&
            !m.id.startsWith("auto-node:") &&
            !m.id.startsWith("auto-cluster:") &&
            !m.id.startsWith("builtin-") &&
            !m.id.startsWith("demo-") &&
            !builtinOrDemoIds.has(m.id) &&
            !isDemoTarget(m.id)
          ) {
            return true;
          }
          return false;
        });
        if (
          updated &&
          updated.scope !== "personal" &&
          !updated.id.startsWith("auto-node:") &&
          !updated.id.startsWith("auto-cluster:") &&
          !builtinOrDemoIds.has(updated.id) &&
          !isDemoTarget(updated.id)
        ) {
          await this.host.saveWorkspaceMemory?.(updated).catch(() => {});
          this.s3Workspace.schedulePush(400);
        }
        break;
      }
      case "self-learn-reflect": {
        const storedMemoryIds = new Set(
          this.store.data.memories.map((m) => m.id),
        );
        const builtinOrDemoMemoryIds = new Set([
          ...getBuiltinSkillsAndMemories().map((m) => m.id),
          ...(isDemoMode() ? getDemoMemories().map((m) => m.id) : []),
        ]);
        const storedEdgeIds = new Set(
          (this.store.data.infraEdges ?? []).map((e) => e.id),
        );
        const demoEdgeIds = new Set(
          isDemoMode() ? getDemoInfraEdges().map((e) => e.id) : [],
        );
        const extra = await this.collectExtraContext();
        const dismissedReflect = new Set(
          this.store.data.preferences.dismissedBuiltinIds ?? [],
        );
        const allTasks = isDemoMode()
          ? [
              ...getDemoTasks().filter(
                (dt) =>
                  !dismissedReflect.has(dt.id) &&
                  !this.store.data.tasks.some((t) => t.id === dt.id),
              ),
              ...this.store.data.tasks,
            ]
          : this.store.data.tasks;
        const combinedMemories = [...this.store.data.memories];
        for (const m of extra.memories ?? []) {
          if (
            !m.id.startsWith("auto-node:") &&
            !m.id.startsWith("auto-cluster:") &&
            !combinedMemories.some((x) => x.id === m.id)
          ) {
            combinedMemories.push(m);
          }
        }
        const reflected = this.selfLearning.runReflectionCycle({
          memories: combinedMemories,
          tasks: allTasks,
          activityLog: extra.activityLog ?? this.store.data.activityLog ?? [],
          infraEdges: this.getInfraEdgesList(),
          servers: extra.workspaceServers ?? [],
          lastFailures: this.terminals.failures(),
          targetCluster: request.targetCluster,
        });
        this.store.data.memories = reflected.memories.filter(
          (m) =>
            storedMemoryIds.has(m.id) ||
            (!m.id.startsWith("auto-node:") &&
              !m.id.startsWith("auto-cluster:") &&
              !m.id.startsWith("builtin-") &&
              !m.id.startsWith("demo-") &&
              !builtinOrDemoMemoryIds.has(m.id) &&
              !isDemoTarget(m.id)),
        );
        this.store.data.infraEdges = reflected.infraEdges.filter(
          (e) =>
            storedEdgeIds.has(e.id) ||
            (!demoEdgeIds.has(e.id) && !isDemoTarget(e.id)),
        );
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "activity-record": {
        // On a shared server the entry is the signed-in person's: nobody writes the team's log as another.
        const actor = (!this.hosted() && request.event.actor?.trim()) || (await this.resolveActorName());
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor: clip(actor, 80),
          profileId: request.event.profileId,
          targetLabel: clip(
            requiredText(request.event.targetLabel),
            200,
          ),
          // One of the kinds the log knows; anything else is a note.
          kind: (["config-edit", "service-action", "service", "package-change", "deploy", "command", "ai-action", "profile-update", "note"] as const).includes(
            request.event.kind as never,
          )
            ? request.event.kind
            : "note",
          summary: clip(requiredText(request.event.summary), 400),
          detail: request.event.detail
            ? boundedContext(request.event.detail, 2000)
            : undefined,
        };
        this.appendActivityEvent(event);
        await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "plan-decide": {
        const task = this.task(request.taskId);
        const plan = task.plan;
        if (!plan || plan.status !== "proposed")
          throw new Error("There is no plan waiting for a decision in this conversation");
        if (active(task))
          throw new Error("The agent is still working; decide when it has stopped");
        const note = request.note?.trim();
        plan.decidedAt = Date.now();
        if (request.approved) {
          plan.status = "approved";
          // The agent is held to the plan: its steps become its task list.
          task.todos = todosFromPlan(plan);
          this.changed();
          return this.request({
            action: "reply",
            taskId: task.id,
            text: approvalMessage(plan, note),
          });
        }
        plan.status = "rejected";
        if (note) {
          plan.decisionNote = boundedContext(note, 2000);
          this.changed();
          return this.request({
            action: "reply",
            taskId: task.id,
            text: rejectionMessage(note),
          });
        }
        break;
      }
      case "memory-proposal-accept": {
        const proposal = (this.store.data.memoryProposals ?? []).find(
          (p) => p.id === request.id,
        );
        if (!proposal) throw new Error("Proposal not found");
        if (!proposal.appliedMemoryId)
          await this.applyMemoryProposal(proposal, {
            title: request.title,
            text: request.text,
          });
        this.store.data.memoryProposals = (
          this.store.data.memoryProposals ?? []
        ).filter((p) => p.id !== proposal.id);
        break;
      }
      case "memory-proposal-undo": {
        const proposal = (this.store.data.memoryProposals ?? []).find(
          (p) => p.id === request.id,
        );
        if (!proposal?.appliedMemoryId)
          throw new Error("There is nothing to undo for this entry");
        const memoryId = proposal.appliedMemoryId;
        const current = this.store.data.memories.find((m) => m.id === memoryId);
        const replaced = this.store.data.memories.find((m) => m.supersededBy === memoryId);
        if (proposal.op === "update" && replaced) {
          // The update was saved as a new memory: forget it and bring back the one it replaced.
          if (current && current.text !== proposal.text)
            throw new Error(
              "This memory has been changed since; edit it in the list instead",
            );
          delete replaced.supersededBy;
          delete replaced.supersededAt;
          replaced.updatedAt = Date.now();
          await this.request({ action: "memory-delete", id: memoryId });
          if (replaced.scope !== "personal")
            await this.host.saveWorkspaceMemory?.(replaced).catch(() => {});
          this.s3Workspace.schedulePush();
        } else if (proposal.op === "update") {
          // Put the earlier text back, unless somebody has edited it since.
          if (current && current.text === proposal.text && proposal.previousText)
            await this.saveMemoryInternal({
              id: current.id,
              kind: current.kind,
              tier: current.tier,
              cluster: current.cluster,
              scope: current.scope,
              title: current.title,
              text: proposal.previousText,
            });
          else if (current)
            throw new Error(
              "This memory has been changed since; edit it in the list instead",
            );
        } else if (current) {
          await this.request({ action: "memory-delete", id: memoryId });
        }
        this.store.data.memoryProposals = (
          this.store.data.memoryProposals ?? []
        ).filter((p) => p.id !== proposal.id);
        break;
      }
      case "memory-proposal-reject": {
        if (!(this.store.data.memoryProposals ?? []).some((p) => p.id === request.id))
          throw new Error("Proposal not found");
        this.store.data.memoryProposals = (
          this.store.data.memoryProposals ?? []
        ).filter((p) => p.id !== request.id);
        break;
      }
      case "memory-distill-activity": {
        const events = (this.store.data.activityLog ?? []).slice(-80);
        const last = events.at(-1);
        if (!last) throw new Error("There is no team activity to read yet");
        const status = await this.proposeMemoriesFrom(
          {
            id: `activity:${last.id}`,
            title: "Recent team activity",
            transcript: activityTranscript(events),
          },
          events
            .slice(-20)
            .map((e) => `${e.targetLabel} ${e.summary}`)
            .join(" "),
          { again: true },
        );
        if (status?.error) throw new Error(status.error);
        break;
      }
      case "server-describe": {
        const pid = requiredText(request.profileId);
        // An id nobody here has describes nothing (and writes nothing into the team's activity).
        if (this.sharedServer() && !(await this.knownServer(pid))) throw new Error("Server not found");
        this.assertMayChangeTeamServer(await this.teamServerCopy(pid), { shared: request.shared, tags: request.tags });
        if (
          request.localUsername !== undefined ||
          request.localPrivateKeyPath !== undefined ||
          request.localAuthType !== undefined
        ) {
          this.applyLocalOverride({
            profileId: pid,
            username: request.localUsername,
            privateKeyPath: request.localPrivateKeyPath,
            authType: request.localAuthType,
          });
        }
        await this.host.describeServer?.({
          profileId: pid,
          shared: request.shared,
          cluster: request.cluster,
          nodeRole: request.nodeRole,
          description: request.description,
          role: request.role,
          tags: request.tags,
          updatedBy: await this.resolveActorName(),
        });
        const actor = await this.resolveActorName();
        const nowIso = new Date().toISOString();
        const allServers =
          (await this.host.workspaceServers?.().catch(() => [])) ?? [];
        const matchedServer =
          allServers.find((s) => s.id === pid) ||
          (this.store.data.s3SyncedServers ?? []).find((s) => s.id === pid);
        if (matchedServer) {
          const updatedSrv: WorkspaceServerSummary = {
            ...matchedServer,
            shared: request.shared ?? matchedServer.shared,
            cluster:
              request.cluster !== undefined
                ? request.cluster.trim() || undefined
                : matchedServer.cluster,
            nodeRole:
              request.nodeRole !== undefined
                ? request.nodeRole.trim() || undefined
                : matchedServer.nodeRole,
            description:
              request.description !== undefined
                ? request.description.trim() || undefined
                : matchedServer.description,
            role:
              request.role !== undefined
                ? request.role.trim() || undefined
                : matchedServer.role,
            tags: request.tags ?? matchedServer.tags,
            updatedAt: nowIso,
            updatedBy: actor,
          };
          if (updatedSrv.shared !== false) {
            this.upsertLocalS3ServerCache(updatedSrv);
          } else {
            this.store.data.s3SyncedServers = (
              this.store.data.s3SyncedServers ?? []
            ).filter((s) => s.id !== pid);
          }
        }
        const humanLabel = matchedServer?.name || pid;
        const roleInfo = [request.cluster, request.nodeRole, request.role]
          .filter(Boolean)
          .join(" / ");
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor,
          profileId: pid,
          targetLabel: humanLabel,
          kind: "note",
          summary: `Updated node metadata on ${humanLabel}${roleInfo ? ` (${roleInfo})` : ""}`,
          detail: request.description
            ? boundedContext(request.description, 400)
            : undefined,
        };
        // The activity log is the team's. A server a person keeps to themselves is not written into it.
        if ((request.shared ?? matchedServer?.shared) !== false) {
          this.appendActivityEvent(event);
          await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        }
        await this.syncAutoMemoryForTarget(pid, humanLabel);
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "server-upsert": {
        const s = request.server;
        const name = requiredText(s.name);
        const host = requiredText(s.host);
        const actor = await this.resolveActorName();
        const nowIso = new Date().toISOString();
        // On a shared server an id names a server this person has, or none: a teammate's own server
        // is not taken over by sending its id (nobody is shown it, but an id can be learnt elsewhere).
        if (s.id?.trim() && this.sharedServer() && !this.host.teamAdmin?.() && !(await this.knownServer(s.id.trim())))
          throw new Error("Server not found. Leave the id out to add a new server.");
        // What the request leaves out is saved as its default (port 22, root, no tags), so that is what is compared.
        this.assertMayChangeTeamServer(await this.teamServerCopy(s.id), {
          name,
          host,
          port: s.port || 22,
          username: s.username?.trim() || "root",
          shared: s.shared,
          tags: s.tags ?? [],
        });
        const saved = await this.host.upsertServer?.({
          id: s.id,
          name,
          host,
          port: s.port,
          username: s.username?.trim() || "root",
          authType: s.authType,
          privateKeyPath: s.privateKeyPath,
          pkcs11LibPath: s.pkcs11LibPath,
          fido2Resident: s.fido2Resident,
          proxyJump: s.proxyJump,
          proxyJumpProfileId: s.proxyJumpProfileId,
          forwardAgent: s.forwardAgent,
          x11Forwarding: s.x11Forwarding,
          x11Display: s.x11Display,
          compression: s.compression,
          serverAliveInterval: s.serverAliveInterval,
          initialPath: s.initialPath,
          poolId: s.poolId,
          dotfilesSyncPolicy: s.dotfilesSyncPolicy,
          autoReconnect: s.autoReconnect,
          maxReconnectAttempts: s.maxReconnectAttempts,
          reconnectDelayMs: s.reconnectDelayMs,
          extraOptions: s.extraOptions,
          tunnels: s.tunnels,
          folder: s.folder,
          cluster: s.cluster,
          nodeRole: s.nodeRole,
          role: s.role,
          description: s.description,
          tags: s.tags,
          shared: s.shared ?? true,
          updatedBy: actor,
        });
        const targetId = saved?.id ?? s.id ?? crypto.randomUUID();
        if (this.store.data.deletedServerIds?.[targetId]) {
          const nextDeleted = { ...this.store.data.deletedServerIds };
          delete nextDeleted[targetId];
          this.store.data.deletedServerIds = nextDeleted;
        }
        if (
          s.localUsername !== undefined ||
          s.localPrivateKeyPath !== undefined ||
          s.localAuthType !== undefined
        ) {
          this.applyLocalOverride({
            profileId: targetId,
            username: s.localUsername,
            privateKeyPath: s.localPrivateKeyPath,
            authType: s.localAuthType,
          });
        }
        const summary: WorkspaceServerSummary = {
          id: targetId,
          name: name.trim(),
          host: host.trim(),
          port: s.port || 22,
          username: s.username?.trim() || "root",
          authType: s.authType ?? saved?.authType,
          privateKeyPath: s.privateKeyPath ?? saved?.privateKeyPath,
          pkcs11LibPath: s.pkcs11LibPath ?? saved?.pkcs11LibPath,
          fido2Resident: s.fido2Resident ?? saved?.fido2Resident,
          proxyJump: s.proxyJump ?? saved?.proxyJump,
          proxyJumpProfileId: s.proxyJumpProfileId ?? saved?.proxyJumpProfileId,
          forwardAgent: s.forwardAgent ?? saved?.forwardAgent,
          x11Forwarding: s.x11Forwarding ?? saved?.x11Forwarding,
          x11Display: s.x11Display ?? saved?.x11Display,
          compression: s.compression ?? saved?.compression,
          serverAliveInterval: s.serverAliveInterval ?? saved?.serverAliveInterval,
          initialPath: s.initialPath ?? saved?.initialPath,
          poolId: s.poolId ?? saved?.poolId,
          dotfilesSyncPolicy: s.dotfilesSyncPolicy ?? saved?.dotfilesSyncPolicy,
          autoReconnect: s.autoReconnect ?? saved?.autoReconnect,
          maxReconnectAttempts: s.maxReconnectAttempts ?? saved?.maxReconnectAttempts,
          reconnectDelayMs: s.reconnectDelayMs ?? saved?.reconnectDelayMs,
          extraOptions: s.extraOptions ?? saved?.extraOptions,
          tunnels: s.tunnels ?? saved?.tunnels,
          folder: s.folder?.trim() || s.cluster?.trim() || undefined,
          group: s.folder?.trim() || s.cluster?.trim() || undefined,
          cluster: s.cluster?.trim() || undefined,
          nodeRole: s.nodeRole?.trim() || undefined,
          role: s.role?.trim() || undefined,
          description: s.description?.trim() || undefined,
          tags: s.tags?.map((t) => t.trim()).filter(Boolean),
          shared: s.shared ?? true,
          updatedAt: nowIso,
          updatedBy: actor,
        };
        if (summary.shared) {
          this.upsertLocalS3ServerCache(summary);
        } else {
          this.store.data.s3SyncedServers = (
            this.store.data.s3SyncedServers ?? []
          ).filter((srv) => srv.id !== targetId);
        }
        const clusterBadge = s.cluster?.trim()
          ? ` in cluster ${s.cluster.trim()}`
          : "";
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor,
          profileId: targetId,
          targetLabel: name,
          kind: "note",
          summary: `Added/updated node ${name} (${host})${clusterBadge}${s.nodeRole ? ` [${s.nodeRole}]` : ""}`,
          detail: s.description
            ? boundedContext(s.description, 400)
            : undefined,
        };
        // The activity log is the team's. A server a person keeps to themselves is not written into it.
        if (summary.shared) {
          this.appendActivityEvent(event);
          await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        }
        await this.syncAutoMemoryForTarget(targetId, name);
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "server-local-override": {
        const pid = requiredText(request.override.profileId);
        if (this.sharedServer() && !(await this.knownServer(pid))) throw new Error("Server not found");
        this.applyLocalOverride({
          profileId: pid,
          username: request.override.username,
          privateKeyPath: request.override.privateKeyPath,
          authType: request.override.authType,
        });
        break;
      }
      case "server-delete": {
        const pid = requiredText(request.profileId);
        const actor = await this.resolveActorName();
        // Only a server this person has can be removed by them: an id alone (a teammate's own server, a guess) removes nothing.
        const mine = await this.knownServer(pid);
        if (!mine) throw new Error("Server not found");
        this.assertMayRemoveTeamServer(await this.teamServerCopy(pid));
        if (mine.shared === false) {
          // A person's own server: gone here, and nothing about it goes to the team (no removal mark, no log entry).
          await this.host.deleteServer?.(pid).catch(() => {});
          break;
        }
        const existing = (this.store.data.s3SyncedServers ?? []).find(
          (s) => s.id === pid,
        ) ?? mine;
        const delIso = new Date().toISOString();
        this.store.data.deletedServerIds ??= {};
        this.store.data.deletedServerIds[pid] = delIso;
        this.store.data.s3SyncedServers = (
          this.store.data.s3SyncedServers ?? []
        ).filter((s) => s.id !== pid);
        await this.host.deleteServer?.(pid).catch(() => {});
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor,
          profileId: pid,
          targetLabel: existing?.name || pid,
          kind: "profile-update",
          summary: `Removed node ${existing?.name || pid} from workspace`,
        };
        this.appendActivityEvent(event);
        await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "workspace-s3-configure": {
        // On a shared server the name is the account's: nobody signs the team's records as somebody else.
        if (request.config?.actorName !== undefined && !this.hosted()) {
          await this.config.update({ actorName: request.config.actorName.trim() });
        }
        const asked = { ...request.config };
        delete (asked as { actorName?: string }).actorName;
        if (Object.values(asked).some((v) => v !== undefined) || request.inviteCode) {
          this.assertTeamAdmin();
          await this.s3Workspace.configure(request.config, request.inviteCode);
        }
        break;
      }
      case "workspace-s3-sync-now": {
        await this.s3Workspace.syncNow({ forcePush: true });
        break;
      }
      case "workspace-s3-disconnect": {
        this.assertTeamAdmin();
        await this.s3Workspace.disconnect();
        break;
      }
      case "inline-suggest": {
        reply = {
          inlineSuggestion: checkedSuggestion(
            await this.generateInlineSuggestion(
              requiredText(request.prompt),
              request.sessionId,
              request.context,
              request.shell,
            ),
          ),
        };
        break;
      }
      case "schedule-save": {
        const s = request.schedule;
        if (
          !SHELL_KINDS.includes(s.shell) ||
          !["advice", "assisted", "autonomous"].includes(s.mode) ||
          !["anthropic", "openai-compatible", "openai-codex"].includes(
            s.provider,
          )
        )
          throw new Error("Invalid schedule");
        const id = s.id || crypto.randomUUID();
        const schedule: AgentSchedule = {
          ...s,
          id,
          title: clip(requiredText(s.title), 200),
          prompt: boundedPrompt(requiredText(s.prompt), PERSON_PROMPT_MAX),
          profileId: requiredText(s.profileId),
          model: requiredText(s.model),
          intervalMinutes: integer(s.intervalMinutes, 1, 525600),
          maxCommands: integer(s.maxCommands, 1, 100),
          maxMinutes: integer(s.maxMinutes, 1, 120),
          nextRunAt: Number.isFinite(s.nextRunAt)
            ? s.nextRunAt
            : Date.now() + 60_000,
        };
        this.store.data.schedules = this.store.data.schedules.filter(
          (x) => x.id !== id,
        );
        this.store.data.schedules.push(schedule);
        break;
      }
      case "schedule-delete":
        this.store.data.schedules = this.store.data.schedules.filter(
          (s) => s.id !== request.id,
        );
        if (isDemoMode()) {
          this.markBuiltinDismissed(request.id, getDemoSchedules());
        }
        break;
      case "demo-mode-toggle": {
        // Demo mode never changes inside a running process (demo/demoMode.ts): switching it means a
        // restart, which only the desktop host offers, and only after the user has confirmed it there.
        const demoMode = Boolean(request.enabled);
        if (demoMode !== isDemoMode()) {
          if (!this.host.relaunchForDemoMode)
            throw new Error(
              "Demo mode is set when the sshs3 server starts (--demo or SSHS3_DEMO=1) and can't be changed here.",
            );
          await this.host.relaunchForDemoMode(demoMode);
        }
        return this.snapshot();
      }
      case "restore-builtins": {
        this.store.data.preferences.dismissedBuiltinIds = [];
        for (const bm of getBuiltinSkillsAndMemories()) {
          if (this.store.data.deletedMemoryIds?.[bm.id]) {
            delete this.store.data.deletedMemoryIds[bm.id];
          }
        }
        break;
      }
      case "agent-save": {
        const a = request.agent;
        const id = a.id?.trim() || crypto.randomUUID();
        // Three code paths look an agent up by name. Two agents of one name would make
        // which one they find a matter of order.
        const clash = this.getAgentsList().find(
          (x) => x.id !== id && x.name.trim().toLowerCase() === (a.name ?? "").trim().toLowerCase(),
        );
        if (clash) throw new Error(`There is already an agent called "${clash.name}". Give this one another name.`);
        const actor = a.author?.trim() || (await this.resolveActorName());
        const boss = a.reportsTo && a.reportsTo !== id ? this.getAgentsList().find((x) => x.id === a.reportsTo) : undefined;
        const circle = Boolean(boss) && wouldCycle(this.getAgentsList(), id, boss!.id);
        if (a.reportsTo && (!boss || circle))
          reply = {
            notes: [
              a.reportsTo === id
                ? "An agent cannot report to itself, so no reporting line was saved."
                : !boss
                  ? "The agent this one should report to does not exist, so no reporting line was saved."
                  : `${boss.name} already reports to this agent, directly or through others. The reporting line was not saved, because it would close a circle.`,
            ],
          };
        const saved: MissionAgent = {
          id,
          name: clip(requiredText(a.name), 120),
          role: clip(a.role?.trim() || "Infrastructure Specialist", 160),
          icon: boundedContext(a.icon?.trim() || "", 16),
          mission: boundedContext(requiredText(a.mission), 2000),
          systemPrompt: boundedContext(a.systemPrompt?.trim() || a.mission, 8000),
          targetCluster: a.targetCluster?.trim() || undefined,
          defaultMode: ["advice", "assisted", "autonomous"].includes(a.defaultMode)
            ? a.defaultMode
            : "assisted",
          allowedTools: a.allowedTools?.length ? a.allowedTools : ["all"],
          kbDocIds: a.kbDocIds?.filter(Boolean),
          mcpServerIds: a.mcpServerIds?.filter(Boolean),
          modelOverride: a.modelOverride?.trim() || undefined,
          // Which endpoint it was chosen for, so that a change of provider lets it go
          // instead of sending one provider's model name to another's address.
          modelProvider: a.modelOverride?.trim()
            ? (a.modelProvider ?? (await this.config.getConfig().catch(() => undefined))?.provider)
            : undefined,
          enabled: a.enabled ?? true,
          runnerId: a.runnerId?.trim() || undefined,
          reportsTo: boss && !circle ? boss.id : undefined,
          monthlyTokenBudget:
            a.monthlyTokenBudget && a.monthlyTokenBudget > 0
              ? integer(a.monthlyTokenBudget, 1000, 2_000_000_000)
              : undefined,
          updatedAt: Date.now(),
          author: actor,
        };
        this.store.data.agents = [
          ...(this.store.data.agents ?? []).filter((x) => x.id !== id),
          saved,
        ];
        if (isDemoMode()) saveDemoAgent(saved);
        this.lastWorkSync = 0;
        break;
      }
      case "agent-delete": {
        const gone = this.getAgentsList().find((a) => a.id === request.id);
        this.store.data.agents = (this.store.data.agents ?? []).filter(
          (a) => a.id !== request.id,
        );
        this.markSharedRemoved("agents", request.id);
        // A ticket that was this agent's is free again, and says so. Left as it was it
        // would sit for ever: nothing would run it, and the board would say it has no assignee.
        for (const ticket of live(this.store.data.workTickets))
          if (ticket.assigneeAgentId === request.id)
            this.putTicket({
              ...withComment(
                ticket,
                "sshS3",
                `${gone?.name ?? "The agent"} was removed, so this ticket has nobody. Assign it to another agent or do it by hand.`,
              ),
              assigneeAgentId: undefined,
              assigneeName: undefined,
            });
        // An agent that reported to it reports to nobody now, rather than to a gap.
        this.store.data.agents = (this.store.data.agents ?? []).map((a) =>
          a.reportsTo === request.id ? { ...a, reportsTo: undefined, updatedAt: Date.now() } : a,
        );
        this.store.data.alertRules = (this.store.data.alertRules ?? []).filter((r) => r.agentId !== request.id);
        // Before deleteDemoAgent: in demo mode the built-ins are the demo store's agents.
        this.markBuiltinDismissed(request.id, getBuiltinAgents());
        if (isDemoMode()) deleteDemoAgent(request.id);
        break;
      }
      case "agent-pause": {
        const agent = this.getAgentsList().find((a) => a.id === request.id);
        if (!agent) throw new Error("Agent not found");
        const saved = { ...agent, enabled: !request.paused, updatedAt: Date.now() };
        this.store.data.agents = [
          ...(this.store.data.agents ?? []).filter((x) => x.id !== saved.id),
          saved,
        ];
        if (isDemoMode()) saveDemoAgent(saved);
        break;
      }
      case "alert-hook-create": {
        const { secret, hash } = newHookSecret();
        this.store.data.alertHook = { hash, createdAt: Date.now(), received: 0 };
        // Shown this once. On the web server the address names the user; the desktop app has no address to post to.
        reply = {
          alertHook: { path: this.host.alertHookOwner ? `/api/hooks/${this.host.alertHookOwner}.${secret}` : "" },
        };
        break;
      }
      case "eval-case-save": {
        const cases = this.store.data.evalCases ?? [];
        const existing = cases.find((c) => c.id === request.id);
        if (existing) {
          existing.title = boundedContext(request.title?.trim() || existing.title, 160);
          // Only the parts that were sent: the others stay as they are.
          if (request.expect) existing.expect = normalizeExpectation({ ...existing.expect, ...request.expect });
          existing.updatedAt = Date.now();
        } else {
          const from = this.store.data.tasks.find((t) => t.id === request.fromTaskId);
          if (!from) throw new Error("That conversation is not on this computer any more.");
          if (active(from)) throw new Error("Wait until the conversation has ended.");
          this.store.data.evalCases = [
            ...cases,
            caseFromTask(from, { title: request.title, expect: request.expect }, await this.resolveActorName()),
          ];
        }
        this.lastWorkSync = 0;
        break;
      }
      case "eval-case-delete":
        this.store.data.evalCases = (this.store.data.evalCases ?? []).filter((c) => c.id !== request.id);
        this.markSharedRemoved("evals", request.id);
        break;
      case "eval-run": {
        const ids = (this.store.data.evalCases ?? []).filter((c) => !request.id || c.id === request.id).map((c) => c.id);
        if (ids.length === 0) throw new Error("There is no such test case.");
        if (this.evalRunningId) throw new Error("Test cases are already running.");
        void this.runEvalCases(ids).catch((e) => log.warn("Running test cases failed", safeError(e)));
        break;
      }
      case "daily-report-read":
        if (this.store.data.dailyReport) this.store.data.dailyReport.readAt = Date.now();
        break;
      case "alert-hook-disable":
        this.store.data.alertHook = undefined;
        break;
      case "alert-rules-save": {
        const asked = (request.rules ?? []).map((r) => ({
          match: boundedContext(String(r.match ?? "").trim(), 80),
          agentId: String(r.agentId ?? ""),
        }));
        const known = (r: { agentId: string }): boolean => this.getAgentsList().some((a) => a.id === r.agentId);
        const kept = asked.filter((r) => r.match && known(r));
        this.store.data.alertRules = kept.slice(0, 40);
        const notes: string[] = [];
        const noAgent = asked.filter((r) => r.match && !known(r));
        if (noAgent.length)
          notes.push(`Not saved, because the agent does not exist: ${noAgent.map((r) => `"${r.match}"`).join(", ")}.`);
        const empty = asked.filter((r) => !r.match).length;
        if (empty) notes.push(`${empty} rule${empty === 1 ? "" : "s"} with no text to match ${empty === 1 ? "was" : "were"} left out.`);
        if (kept.length > 40) notes.push("Only the first 40 rules were saved.");
        if (notes.length) reply = { notes };
        break;
      }
      case "alert-paste": {
        const alerts = parsePastedAlert(requiredText(request.text));
        if (alerts.length === 0) throw new Error("No alert could be made of that.");
        reply = { alerts: await this.takeAlerts(alerts) };
        break;
      }
      case "runner-save": {
        this.assertRunnerAllowed();
        const r = request.runner;
        const asked = requiredText(r.id);
        const id = asked.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
        // An agent names its runner by this id: one that was typed differently would never match.
        if (id !== asked)
          reply = {
            notes: [
              `The id was saved as "${id}": an id is lowercase letters, digits and "-", at most 40 characters. An agent that uses this runner has to name it "${id}".`,
            ],
          };
        const saved: ExternalRunner = {
          id,
          name: clip(requiredText(r.name), 80),
          command: requiredText(r.command),
          args: (r.args ?? []).map((x) => String(x)).filter(Boolean).slice(0, 40),
          cwd: r.cwd?.trim() || undefined,
          updatedAt: Date.now(),
        };
        this.store.data.externalRunners = [
          ...(this.store.data.externalRunners ?? []).filter((x) => x.id !== id),
          saved,
        ];
        break;
      }
      case "runner-delete":
        this.store.data.externalRunners = (this.store.data.externalRunners ?? []).filter(
          (x) => x.id !== request.id,
        );
        break;
      case "goal-save": {
        const g = request.goal;
        const existing = (this.store.data.workGoals ?? []).find((x) => x.id === g.id);
        const now = Date.now();
        this.putGoal({
          id: existing?.id ?? crypto.randomUUID(),
          title: clip(requiredText(g.title), 200),
          description: g.description?.trim() ? boundedContext(g.description.trim(), 4000) : undefined,
          status: g.status === "done" ? "done" : "active",
          author: existing?.author ?? (await this.resolveActorName()),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        break;
      }
      case "goal-delete": {
        const goal = (this.store.data.workGoals ?? []).find((x) => x.id === request.id);
        if (goal) this.putGoal({ ...goal, deleted: true, updatedAt: Date.now() });
        break;
      }
      case "ticket-save": {
        const notes: string[] = [];
        await this.saveTicketFrom(request.ticket, undefined, false, notes);
        if (notes.length) reply = { notes };
        break;
      }
      case "ticket-move": {
        if (!TICKET_STATUSES.includes(request.status)) throw new Error("Unknown ticket status");
        if (request.status === "in_progress")
          throw new Error("A ticket is in progress while an agent runs it: start it instead.");
        const running = await this.ticketRunsNow(this.ticket(request.id));
        if (running) throw new Error(running);
        // Read again: the check asked the bucket, and the board may have moved meanwhile.
        this.putTicket({ ...this.ticket(request.id), status: request.status, claim: undefined, updatedAt: Date.now() });
        break;
      }
      case "ticket-delete": {
        // Removing a ticket from under its run would leave the run's result with nowhere to go.
        const running = await this.ticketRunsNow(this.ticket(request.id));
        if (running) throw new Error(running);
        this.putTicket({ ...this.ticket(request.id), deleted: true, claim: undefined, updatedAt: Date.now() });
        break;
      }
      case "ticket-comment": {
        const ticket = this.ticket(request.id);
        this.putTicket(
          withComment(ticket, await this.resolveActorName(), requiredText(request.text)),
        );
        break;
      }
      case "ticket-start":
        reply = { started: { taskId: (await this.startTicket(request.id, request.sessionId)).id } };
        break;
      case "ticket-review": {
        const ticket = this.ticket(request.id);
        if (ticket.status !== "review" && ticket.status !== "blocked")
          throw new Error("Only a ticket in review or blocked can be decided.");
        const running = await this.ticketRunsNow(ticket);
        if (running) throw new Error(running);
        // "Done" would be said of work that has not started: the agent's plan still waits for its answer.
        if (request.approve && this.store.data.tasks.find((t) => t.id === ticket.taskId)?.plan?.status === "proposed")
          throw new Error(
            "The agent proposed a plan and has not carried it out. Approve or reject the plan in the conversation first, or send the ticket back.",
          );
        const who = await this.resolveActorName();
        const note = request.note?.trim();
        const decided = note
          ? withComment(ticket, who, `${request.approve ? "Approved" : "Sent back"}: ${note}`)
          : ticket;
        this.putTicket({
          ...decided,
          status: request.approve ? "done" : "todo",
          claim: undefined,
          updatedAt: Date.now(),
        });
        break;
      }
      case "workforce-template-apply": {
        const kept = await this.applyWorkforceTemplate(request.templateId, request.goalTitle);
        if (kept.length)
          reply = {
            notes: [
              `${kept.join(", ")} already existed and ${kept.length === 1 ? "was" : "were"} kept as ${kept.length === 1 ? "it is" : "they are"}: the new goal and tickets use ${kept.length === 1 ? "it" : "them"}.`,
            ],
          };
        break;
      }
      case "agent-run-mission": {
        const targetAgentId = request.agentId || request.id;
        const agent = this.getAgentsList().find((a) => a.id === targetAgentId);
        if (!agent) throw new Error("Mission Agent not found");
        // Paused means paused. It used to hold only for the tickets the heartbeat picks up,
        // so "Run mission" started an agent a person had switched off.
        this.assertMayRun(agent);
        const clusterTag = agent.targetCluster
          ? ` (cluster: @cluster:${agent.targetCluster})`
          : "";
        const missionPrompt =
          request.promptOverride?.trim() ||
          `[Mission for ${agent.name}${clusterTag}]\n${agent.mission}`;
        reply = {
          started: {
            taskId: (
              await this.start({
                prompt: missionPrompt,
                sessionId: request.sessionId,
                mode: agent.defaultMode,
                agentId: agent.id,
                agentName: agent.name,
              })
            ).id,
          },
        };
        break;
      }
      case "workforce-run": {
        // The snapshot returns with the run in progress; its steps fill in as
        // the specialists finish (each change is announced through changed()).
        const { done } = await this.beginWorkforceRun({
          prompt: requiredText(request.prompt),
          agentIds: request.agentIds,
          targetCluster: request.targetCluster,
          createTask: request.createTask ?? true,
        });
        void done.catch((e) => log.warn("Workforce run failed", safeError(e)));
        break;
      }
      case "agent-handoff": {
        const task = this.task(request.taskId);
        const toAgent = this.getAgentsList().find(
          (a) =>
            a.id === request.toAgentId ||
            a.name.toLowerCase() === request.toAgentId.toLowerCase(),
        );
        if (!toAgent) throw new Error("Target Mission Agent not found for handoff");
        this.assertMayRun(toAgent);
        // During a run, the run finishes as the agent it started as (its instructions and tools were set
        // then, and what it spends is that agent's); the conversation changes hands when it ends.
        if (active(task)) {
          task.handoffTo = { agentId: toAgent.id, reason: request.reason };
          task.messages.push({
            id: crypto.randomUUID(),
            role: "system",
            text: `Hands over to ${toAgent.name} when this run ends.`,
            at: Date.now(),
          });
          break;
        }
        this.applyHandoff(task, toAgent, request.reason);
        break;
      }
      case "mcp-install-preset": {
        const preset = mcpCatalog().find(
          (p) =>
            p.id === request.presetId ||
            p.name.toLowerCase() === request.presetId.toLowerCase(),
        );
        if (!preset) throw new Error(`MCP preset "${request.presetId}" not found`);
        // In the demo lab a preset is a scripted fixture: nothing is started for it.
        if (!isDemoMode()) this.assertMcpProgramAllowed(preset);
        const installed: McpServerConfig = {
          id: preset.id,
          name: preset.name,
          transport: preset.transport,
          command: preset.command,
          args: preset.args,
          url: preset.url,
          enabled: true,
          status: "unknown",
          discoveredTools: [],
          updatedAt: Date.now(),
        };
        if (isDemoMode()) {
          // The demo lab's servers are scripted; there is nothing to start.
          installed.status = "connected";
          installed.lastTestedAt = Date.now();
          installed.discoveredTools = preset.defaultTools;
        } else if (!preset.needs) {
          // Connected, and its tools, are what the server itself answered.
          const result = await this.mcp.testAndDiscover(installed);
          installed.status = result.ok ? "connected" : "error";
          installed.lastError = result.error;
          installed.lastTestedAt = Date.now();
          installed.discoveredTools = result.tools;
        }
        this.store.data.mcpServers = [
          ...(this.store.data.mcpServers ?? []).filter((x) => x.id !== installed.id),
          installed,
        ];
        if (isDemoMode()) saveDemoMcpServer(installed);
        break;
      }
      case "infra-edge-save": {
        const e = request.edge;
        const savedEdge: InfraGraphEdge = {
          id: e.id?.trim() || crypto.randomUUID(),
          from: boundedContext(requiredText(e.from), 120),
          to: boundedContext(requiredText(e.to), 120),
          relation: e.relation || "depends_on",
          label: e.label ? boundedContext(e.label, 240) : undefined,
          ...(e.proposed
            ? {
                proposed: true,
                evidence: e.evidence ? boundedContext(e.evidence, 300) : undefined,
                proposedBy: e.proposedBy ? boundedContext(e.proposedBy, 80) : undefined,
              }
            : {}),
          updatedAt: Date.now(),
        };
        // A link a person already has is not turned back into a suggestion.
        const known = (this.store.data.infraEdges ?? []).find(
          (x) => !x.proposed && x.from === savedEdge.from && x.to === savedEdge.to && x.relation === savedEdge.relation,
        );
        if (known && savedEdge.proposed) break;
        this.store.data.infraEdges = [
          savedEdge,
          ...(this.store.data.infraEdges ?? []).filter((x) => x.id !== savedEdge.id),
        ];
        if (isDemoMode()) saveDemoInfraEdge(savedEdge);
        break;
      }
      case "facts-configure": {
        const current = (this.store.data.factsSettings ??= {});
        if (request.enabled !== undefined) current.enabled = request.enabled === true;
        if (request.intervalHours !== undefined) current.intervalHours = integer(request.intervalHours, 1, 168);
        if (request.exclude !== undefined) current.exclude = request.exclude.filter((id) => typeof id === "string").slice(0, 500);
        if (request.watchPaths !== undefined) {
          const bad = request.watchPaths.map((p) => p.trim()).filter((p) => p && !isWatchPath(p));
          if (bad.length) throw new Error(`Not a path that can be watched: ${bad[0]}. Use an absolute path of plain characters; * is allowed.`);
          current.watchPaths = request.watchPaths.map((p) => p.trim()).filter(Boolean).slice(0, 40);
        }
        // Switched on: read what is due now, not at the next round.
        this.lastFactsTick = 0;
        if (current.enabled) void this.factsTick().catch((e) => log.warn("Reading server facts failed", safeError(e)));
        break;
      }
      case "facts-collect-now": {
        if (request.serverId) {
          const server = this.getKnownServers().find((x) => x.id === request.serverId);
          if (!server) throw new Error("Server not found");
          await this.collectFacts(server, Date.now(), true);
        } else {
          this.lastFactsTick = 0;
          await this.factsTick(Date.now(), true);
        }
        break;
      }
      case "server-facts-read": {
        const record = this.factsStore.get(request.serverId);
        reply = { serverFacts: { serverId: request.serverId, facts: record?.facts, changes: record?.changes ?? [] } };
        break;
      }
      case "facts-problem-dismiss": {
        const record = this.factsStore.get(request.serverId);
        if (record) {
          // One problem, or everything this server has right now.
          const keys = request.key ? [request.key] : this.factsProblems(record).map((p) => p.key);
          const at = Date.now();
          await this.factsStore.put({ ...record, dismissed: { ...(record.dismissed ?? {}), ...Object.fromEntries(keys.map((k) => [k, at])) } });
        }
        break;
      }
      case "notify-channel-save": {
        const input = request.channel;
        const channels = this.notifyStore.data.channels;
        const existing = input.id ? channels.find((c) => c.id === input.id) : undefined;
        if (input.id && !existing) throw new Error("Channel not found");
        if (!["slack", "teams", "ntfy", "webhook"].includes(input.kind)) throw new Error("Unknown kind of channel");
        const url = (input.url ?? "").trim() || existing?.url || "";
        if (!url) throw new Error("The channel needs an address to post to");
        // Checked now so a wrong address is said at once, and again each time something is sent.
        const target = await guardUrl(url, this.outboundGuard());
        if (input.kind === "ntfy" && !target.url.pathname.split("/").filter(Boolean).length)
          throw new Error("An ntfy address ends with the topic, like https://ntfy.sh/my-topic");
        const events = (input.events ?? []).filter((e) => NOTIFY_KINDS.includes(e));
        const saved: NotifyChannel = {
          id: existing?.id ?? crypto.randomUUID(),
          kind: input.kind,
          name: requiredText(input.name).slice(0, 80),
          url,
          // undefined keeps what is there; an empty text removes it.
          secret: input.secret === undefined ? existing?.secret : input.secret.trim() || undefined,
          enabled: input.enabled !== false,
          events: events.length ? events : ["approval", "plan", "question", "blocked", "alert"],
          includeCommand: input.includeCommand !== false,
          alertMinSeverity: ["info", "warning", "critical"].includes(input.alertMinSeverity ?? "") ? input.alertMinSeverity : undefined,
          last: existing?.url === url ? existing?.last : undefined,
        };
        this.notifyStore.data.channels = [...channels.filter((c) => c.id !== saved.id), saved];
        // What already waits is not news to a channel that was just added.
        for (const item of this.inboxNow()) this.notifyStore.data.seen[item.id] ??= Date.now();
        await this.notifyStore.save();
        break;
      }
      case "notify-channel-delete":
        this.notifyStore.data.channels = this.notifyStore.data.channels.filter((c) => c.id !== request.id);
        await this.notifyStore.save();
        break;
      case "notify-channel-test": {
        const channel = this.notifyStore.data.channels.find((c) => c.id === request.id);
        if (!channel) throw new Error("Channel not found");
        const link = this.inboxLink();
        const result = await deliver(
          renderNotification(
            channel,
            [{ id: "test", kind: "report", headline: "A test from sshs3", title: "If you can read this, the channel works.", link }],
            { inboxLink: link },
          ),
          this.outboundGuard(),
          { waits: [] },
        );
        channel.last = { at: Date.now(), ...result };
        await this.notifyStore.save();
        reply = { notifyTest: result };
        break;
      }
      case "notify-settings-save": {
        if (request.publicUrl !== undefined && !process.env.SSHS3_PUBLIC_URL) {
          const raw = request.publicUrl.trim();
          if (raw) {
            let parsed: URL;
            try {
              parsed = new URL(raw);
            } catch {
              throw new Error("That is not an address. It should look like https://sshs3.example.com");
            }
            if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
              throw new Error("The address has to be http or https, without a user name in it");
            this.notifyStore.data.publicUrl = `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
          } else this.notifyStore.data.publicUrl = "";
        }
        if (request.reminderMinutes !== undefined) this.notifyStore.data.reminderMinutes = integer(request.reminderMinutes, 0, 60);
        await this.notifyStore.save();
        break;
      }
      case "infra-edge-confirm": {
        const edge = (this.store.data.infraEdges ?? []).find((x) => x.id === request.id);
        if (!edge) throw new Error("Link not found");
        edge.proposed = undefined;
        edge.updatedAt = Date.now();
        this.lastWorkSync = 0;
        break;
      }
      case "infra-edge-delete": {
        this.store.data.infraEdges = (this.store.data.infraEdges ?? []).filter(
          (x) => x.id !== request.id,
        );
        this.markSharedRemoved("edges", request.id);
        if (isDemoMode()) {
          this.markBuiltinDismissed(request.id, getDemoInfraEdges());
          deleteDemoInfraEdge(request.id);
        }
        break;
      }
      case "safety-policy-save": {
        const stored = this.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY;
        const asked: Partial<Record<keyof SafetyPolicyConfig, unknown>> =
          request.policy && typeof request.policy === "object" ? request.policy : {};
        // A rule is on or off. "no", 0 or null is not an answer: stored as sent it would switch a rule
        // off, or leave it on while looking like something else, so the whole request is refused.
        for (const key of Object.keys(POLICY_NAMES) as (keyof SafetyPolicyConfig)[])
          if (asked[key] !== undefined && typeof asked[key] !== "boolean")
            throw new Error(`"${POLICY_NAMES[key]}" is either on (true) or off (false).`);
        // On a shared server the team's rules are a floor: a member switches on what makes changes wait
        // for a person, never off. Only an administrator loosens them.
        if (this.sharedServer() && !this.host.teamAdmin?.())
          for (const key of ["requireApprovalOnProdTags", "blockDestructiveWithoutConfirm"] as const)
            if (asked[key] === false)
              throw new Error(`Only an administrator of this server switches off "${POLICY_NAMES[key]}": on a shared server it is the team's rule.`);
        // What an earlier version stored as something else counts as what it did: anything but an explicit off kept the rule on.
        const current: SafetyPolicyConfig = {
          autoApproveSafeReadOnly: Boolean(stored.autoApproveSafeReadOnly),
          requireApprovalOnProdTags: Boolean(stored.requireApprovalOnProdTags),
          blockDestructiveWithoutConfirm: Boolean(stored.blockDestructiveWithoutConfirm),
        };
        this.store.data.safetyPolicy = {
          autoApproveSafeReadOnly:
            (asked.autoApproveSafeReadOnly as boolean | undefined) ?? current.autoApproveSafeReadOnly,
          requireApprovalOnProdTags:
            (asked.requireApprovalOnProdTags as boolean | undefined) ?? current.requireApprovalOnProdTags,
          blockDestructiveWithoutConfirm:
            (asked.blockDestructiveWithoutConfirm as boolean | undefined) ??
            current.blockDestructiveWithoutConfirm,
        };
        // Who loosened or tightened the rules, and from what to what, goes into the audit log.
        const next = this.store.data.safetyPolicy;
        const moved = (Object.keys(next) as (keyof SafetyPolicyConfig)[])
          .filter((k) => next[k] !== current[k])
          .map((k) => `${POLICY_NAMES[k]}: ${current[k] ? "on" : "off"} → ${next[k] ? "on" : "off"}`);
        if (moved.length && !isDemoMode()) {
          this.store.data.safetyPolicyChanged = { by: await this.resolveActorName(), at: Date.now() };
          void this.audit()
            .append({ kind: "setting", actor: await this.resolveActorName(), target: "sshs3 on this computer", what: `Safety policy: ${moved.join("; ")}`, outcome: "completed" })
            .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        }
        break;
      }
      case "mcp-save": {
        const s = request.server;
        const id = s.id?.trim() || crypto.randomUUID();
        const existing = this.getMcpServersList().find((x) => x.id === id);
        const saved: McpServerConfig = {
          id,
          name: clip(requiredText(s.name), 120),
          transport: s.transport === "http" ? "http" : "stdio",
          command: s.command?.trim() || undefined,
          args: s.args?.map((x) => x.trim()).filter(Boolean),
          env: keepSecrets(existing?.env, s.env),
          url: s.url?.trim() || undefined,
          headers: keepSecrets(existing?.headers, s.headers),
          // Editing a server does not switch it back on.
          enabled: s.enabled ?? existing?.enabled ?? true,
          discoveredTools: s.discoveredTools ?? existing?.discoveredTools ?? [],
          status: existing?.status ?? "unknown",
          lastError: existing?.lastError,
          lastTestedAt: existing?.lastTestedAt,
        };
        this.assertMcpProgramAllowed(saved);
        const reach = (x: McpServerConfig): string =>
          JSON.stringify([x.transport, x.command, x.args ?? [], x.url]);
        if (existing && reach(existing) !== reach(saved)) {
          // It is a different server now: what the old one answered no longer holds.
          saved.discoveredTools = [];
          saved.status = "unknown";
          saved.lastError = undefined;
          saved.lastTestedAt = undefined;
        }
        this.store.data.mcpServers = [
          ...(this.store.data.mcpServers ?? []).filter((x) => x.id !== id),
          saved,
        ];
        if (isDemoMode()) saveDemoMcpServer(saved);
        break;
      }
      case "mcp-delete": {
        this.store.data.mcpServers = (this.store.data.mcpServers ?? []).filter(
          (s) => s.id !== request.id,
        );
        if (isDemoMode()) {
          this.markBuiltinDismissed(request.id, getDemoMcpServers());
          deleteDemoMcpServer(request.id);
        }
        break;
      }
      case "mcp-test": {
        const srv = this.getMcpServersList().find((s) => s.id === request.id);
        if (!srv) throw new Error("MCP server not found");
        if (isDemoTarget(srv.id)) {
          // A demo MCP fixture is scripted (simulateDemoMcpTool): there is no server to start or reach.
          srv.status = "connected";
          srv.lastError = undefined;
          srv.lastTestedAt = Date.now();
        } else {
          const result = await this.mcp.testAndDiscover(srv);
          srv.status = result.ok ? "connected" : "error";
          srv.lastError = result.error;
          srv.lastTestedAt = Date.now();
          // What it answered, including an empty list: a server that no longer offers a tool
          // must not keep offering it here, and a name that cannot be resolved is not offered.
          if (result.ok) srv.discoveredTools = result.tools;
        }
        this.store.data.mcpServers = [
          ...(this.store.data.mcpServers ?? []).filter((x) => x.id !== srv.id),
          srv,
        ];
        if (isDemoMode()) saveDemoMcpServer(srv);
        break;
      }
      case "kb-save": {
        const d = request.doc;
        const doc = this.kb.createDocument({
          id: d.id,
          collection: d.collection,
          title: requiredText(d.title),
          sourceType: d.sourceType || "note",
          sourceRef: d.sourceRef,
          cluster: d.cluster,
          tags: d.tags,
          content: requiredText(d.content),
          shared: d.shared ?? true,
          author: await this.resolveActorName(),
        });
        const before = this.getKbDocumentsList().find((x) => x.id === doc.id);
        if (before) {
          // Whoever brought it in stays its author; an edit does not take the document over.
          if (before.author) doc.author = before.author;
          // An edit keeps what the reading and the upload gave the document.
          doc.summary = before.summary;
          doc.kind = before.kind;
          doc.original = before.original;
          doc.pages = before.pages;
          doc.reading = before.reading;
          doc.compiled = before.compiled;
          doc.sourceCheck = before.sourceCheck;
          // A person set the title: the reading does not replace it any more.
          doc.titleFromSource = before.title === doc.title ? before.titleFromSource : false;
        }
        doc.contentHash = contentHash(doc.content);
        // What it says now has to reach the pages agents read: a new text is worked in, a changed one
        // brings the pages resting on it in line. (The demo lab has no model to do it with.)
        if (!isDemoMode() && (!before || (before.contentHash ?? contentHash(before.content)) !== doc.contentHash)) {
          doc.reading = { state: "queued", at: Date.now(), revised: this.pagesRestOn(doc.id) };
          this.kbRetryAt = 0;
          queueMicrotask(() => void this.readNextKb());
        }
        this.store.data.kbDocuments = [
          ...(this.store.data.kbDocuments ?? []).filter((x) => x.id !== doc.id),
          doc,
        ];
        if (isDemoMode()) saveDemoKbDocument(doc);
        this.lastWorkSync = 0;
        break;
      }
      case "kb-delete": {
        if (!this.getKbDocumentsList().some((d) => d.id === request.id)) throw new Error("Document not found");
        this.store.data.kbDocuments = (this.store.data.kbDocuments ?? []).filter(
          (d) => d.id !== request.id,
        );
        this.markSharedRemoved("kb", request.id);
        this.forgetKbSource(request.id);
        void this.removeKbOriginal(request.id);
        // Before deleteDemoKbDocument: in demo mode the built-ins are the demo store's documents.
        this.markBuiltinDismissed(request.id, getBuiltinKbDocuments());
        if (isDemoMode()) deleteDemoKbDocument(request.id);
        break;
      }
      case "kb-ingest-file": {
        const data = Buffer.from(String(request.dataBase64 ?? ""), "base64");
        const name = boundedContext(requiredText(request.name), 200);
        if (data.length > MAX_UPLOAD_BYTES)
          throw new Error(`"${name}" is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
        const extracted = await extractText({ name, mime: request.mime, data });
        // A file that is dropped in may hold a password (a .env, a configuration file). Its text is masked
        // here, as it is on its way to the team, so that this computer and the teammates keep the same text.
        const masked = maskContext(extracted.text);
        reply = {
          ingest: await this.ingestExtracted(
            { ...extracted, text: masked },
            {
              name,
              sourceType: "upload",
              sourceRef: name,
              // The file itself cannot be masked. One whose text needed masking stays on this computer.
              original: { name, mime: request.mime, data, keptLocal: masked !== extracted.text },
            },
          ),
        };
        break;
      }
      case "kb-ingest-text": {
        // A file out of an editor may hold a password; a note somebody wrote for the team is kept as written.
        const text = request.mask ? maskContext(requiredText(request.text)) : requiredText(request.text);
        const title = request.title?.trim() || firstHeading(text);
        reply = {
          ingest: await this.ingestExtracted(
            { text, format: "text", title },
            {
              name: title || text.trim().split("\n")[0].replace(/^[#>*\s-]+/, "").slice(0, 80) || "Pasted note",
              sourceType: "paste",
              sourceRef: request.sourceRef ? boundedContext(request.sourceRef, 300) : undefined,
            },
          ),
        };
        break;
      }
      case "kb-ingest-url": {
        const fetched = await fetchUrl(requiredText(request.url), this.kbNetwork?.fetchImpl, {
          ...this.outboundGuard(),
          allowPlainHttp: true,
          lookup: this.kbNetwork?.lookup,
        });
        reply = {
          ingest: await this.ingestExtracted(fetched, {
            name: fetched.title || fetched.url,
            sourceType: "url",
            sourceRef: fetched.url,
          }),
        };
        break;
      }
      case "kb-read": {
        const found = this.getKbDocumentsList().find((d) => d.id === request.id);
        if (!found) throw new Error("Document not found");
        reply = { kbDocument: found };
        break;
      }
      case "kb-search": {
        const query = requiredText(request.query);
        const docs = this.getKbDocumentsList();
        const result = await this.kb.searchHybrid(
          docs,
          { query, limit: Math.max(1, Math.min(20, request.limit ?? 8)) },
          await this.kbEmbedder(),
          this.embeddings,
        );
        const byId = new Map(docs.map((d) => [d.id, d]));
        reply = {
          kbSearch: {
            query,
            byMeaning: result.retrieval === "hybrid",
            hits: [
              ...searchPages(this.store.data.kbPages ?? [], query).map((h) => ({
                pageId: h.page.id,
                docId: h.page.id,
                title: h.page.title,
                collection: h.page.kind,
                heading: h.page.when,
                snippet: boundedContext(h.snippet, 420),
                score: h.score,
              })),
              ...result.matches.map((m) => ({
              docId: m.docId,
              title: m.title,
              collection: m.collection,
              heading: byId.get(m.docId)?.chunks?.[m.chunkIndex]?.heading,
              snippet: boundedContext(m.snippet, 420),
              score: m.score,
            })),
            ],
          },
        };
        break;
      }
      case "kb-original": {
        const found = this.getKbDocumentsList().find((d) => d.id === request.id);
        if (!found?.original) throw new Error("This document has no original file.");
        const data = await this.readKbOriginal(found);
        if (!data && found.original.keptLocal)
          throw new Error(
            `The original file holds something that looks like a password or a key, so it was not shared with the team. ${found.author ? `${found.author} has it` : "The person who added it has it"}; the text here has those parts masked.`,
          );
        if (!data) throw new Error("The original file is not on this computer and could not be fetched from the team bucket.");
        reply = {
          download: {
            name: found.original.name,
            mime: found.original.mime || "application/octet-stream",
            dataBase64: data.toString("base64"),
          },
        };
        break;
      }
      case "kb-reread": {
        const found = (this.store.data.kbDocuments ?? []).find((d) => d.id === request.id);
        if (!found) throw new Error("Document not found");
        found.reading = { state: "queued", at: Date.now() };
        found.compiled = undefined;
        this.kbRetryAt = 0;
        void this.readNextKb();
        break;
      }
      case "kb-page-read": {
        const found = (this.store.data.kbPages ?? []).find((p) => p.id === request.id);
        if (!found) throw new Error("Page not found");
        reply = { kbPage: found };
        break;
      }
      case "kb-page-save": {
        const p = request.page;
        if (!PAGE_KINDS.includes(p.kind)) throw new Error("Unknown kind of page");
        const existing = (this.store.data.kbPages ?? []).find((x) => x.id === p.id);
        const saved = savePageByPerson(
          existing,
          { kind: p.kind, title: requiredText(p.title), when: requiredText(p.when), body: requiredText(p.body), targets: p.targets, keys: p.keys },
          await this.resolveActorName(),
        );
        if (p.alerts) saved.alerts = cleanKeys(p.alerts).length ? cleanKeys(p.alerts) : undefined;
        this.store.data.kbPages = [...(this.store.data.kbPages ?? []).filter((x) => x.id !== saved.id), saved];
        this.lastWorkSync = 0;
        reply = { kbPage: saved };
        break;
      }
      case "kb-page-delete":
        if (!(this.store.data.kbPages ?? []).some((p) => p.id === request.id)) throw new Error("Page not found");
        this.store.data.kbPages = (this.store.data.kbPages ?? []).filter((p) => p.id !== request.id);
        this.markSharedRemoved("pages", request.id);
        break;
      case "kb-page-undo": {
        const found = (this.store.data.kbPages ?? []).find((p) => p.id === request.id);
        if (!found) throw new Error("Page not found");
        const result = undoPageChange(found, await this.resolveActorName());
        if (!result.undone) throw new Error("The text this change replaced is no longer kept, so it cannot be undone.");
        // Undoing the creation of a page removes it. That is offered for a page the assistant created;
        // a page a person wrote has nothing to go back to, and is deleted only by deleting it.
        if (!result.page && found.history[0]?.by !== "assistant")
          throw new Error("This page has only its first version, so there is nothing to undo. To remove it, delete the page.");
        if (!result.page) reply = { kbPageRemoved: { id: found.id, title: found.title } };
        this.store.data.kbPages = (this.store.data.kbPages ?? []).flatMap((p) =>
          p.id === found.id ? (result.page ? [result.page] : []) : [p],
        );
        if (!result.page) this.markSharedRemoved("pages", found.id);
        this.lastWorkSync = 0;
        break;
      }
      case "kb-page-rebuild": {
        const found = (this.store.data.kbPages ?? []).find((p) => p.id === request.id);
        if (!found) throw new Error("Page not found");
        const docs = this.getKbDocumentsList().filter((d) => found.sources.some((s) => s.docId === d.id));
        if (docs.length === 0)
          throw new Error(
            found.sources.some((s) => !s.docId.startsWith("task:"))
              ? "None of this page's sources is in the knowledge base any more."
              : "This page rests on no source document (it was written by hand or learned from finished work), so there is nothing to update it from.",
          );
        this.rebuildingPages.add(found.id);
        this.lastRebuilds.delete(found.id);
        void this.rebuildPage(found.id, docs)
          .then((changed) => this.lastRebuilds.set(found.id, { at: Date.now(), changed: changed > 0 }))
          .catch((e) => {
            log.warn("Rebuilding a page failed", safeError(e));
            this.lastRebuilds.set(found.id, { at: Date.now(), changed: false, error: clip(safeError(e), 200) });
          })
          .finally(() => {
            this.rebuildingPages.delete(found.id);
            this.changed();
          });
        break;
      }
      case "kb-check-contradictions":
        void this.checkContradictions().catch((e) => log.warn("Contradiction check failed", safeError(e)));
        break;
      case "kb-finding-dismiss": {
        const id = requiredText(request.id);
        if (id.startsWith("gap:"))
          this.store.data.kbGaps = (this.store.data.kbGaps ?? []).filter((g) => `gap:${g.id}` !== id);
        else if (id.startsWith("contradiction:"))
          this.store.data.kbContradictions = (this.store.data.kbContradictions ?? []).filter((c) => c.id !== id);
        else if (id.startsWith("unverified:")) {
          // Not hidden: answered. A person says the lines are right, and the page stops calling them unverified.
          const pageId = id.split(":")[1];
          const by = await this.resolveActorName();
          this.store.data.kbPages = (this.store.data.kbPages ?? []).map((p) =>
            p.id === pageId && p.unverified
              ? {
                  ...p,
                  unverified: undefined,
                  updatedAt: Date.now(),
                  updatedBy: by,
                  history: [{ at: Date.now(), by, summary: "Checked the commands that were in none of the sources" }, ...p.history.map((h) => ({ at: h.at, by: h.by, summary: h.summary }))].slice(0, 12),
                }
              : p,
          );
          this.lastWorkSync = 0;
        } else this.store.data.kbDismissedFindings = [...(this.store.data.kbDismissedFindings ?? []), id].slice(-300);
        break;
      }
      case "audit-read": {
        const log = this.audit();
        reply = {
          audit: {
            entries: await log.recent(Math.max(1, Math.min(1000, request.limit ?? 200))),
            verification: await log.verify(),
          },
        };
        break;
      }
      case "audit-export": {
        const out = await this.audit().export();
        const day = new Date().toISOString().slice(0, 10);
        // The log as it is on disk, line for line, and what its check found, in one file a person can hand on.
        const text = `${out.jsonl}${JSON.stringify({ verification: out.verification, exportedAt: Date.now() })}\n`;
        reply = {
          download: { name: `sshs3-audit-${day}.jsonl`, mime: "application/x-ndjson", dataBase64: Buffer.from(text, "utf8").toString("base64") },
        };
        break;
      }
      case "recording-read": {
        const cast = await this.recordings().read(requiredText(request.id));
        if (!cast) {
          // "Not any more" only for one that is known to have been here: a run names it, or the audit log sealed it.
          const known =
            this.store.data.tasks.some((t) => t.recordingId === request.id) ||
            (await this.audit().recent(5000)).some((e) => e.kind === "recording" && e.changeId === request.id);
          throw new Error(known ? "That recording is not on this computer any more." : "There is no recording with that id.");
        }
        // Whether it is still what was sealed into the audit log when it was finished.
        const digest = await this.recordings().digest(request.id);
        const seal = (await this.audit().recent(5000)).find((e) => e.kind === "recording" && e.changeId === request.id);
        const sealed = seal ? seal.detail === `sha256 ${digest}` : undefined;
        reply = { recording: { id: request.id, cast, sealed } };
        break;
      }
      case "mcp-key-list":
        await this.mcpTokens().initialize();
        break;
      case "mcp-key-create": {
        const made = await this.mcpTokens().create({
          userId: "local",
          name: requiredText(request.name),
          createdBy: await this.resolveActorName(),
          scopes: (request.scopes ?? []).filter((x): x is "read" | "tickets" | "run" => ["read", "tickets", "run"].includes(x)),
          serverId: request.serverId,
          expiresInDays: request.expiresInDays,
          tools: request.tools,
        });
        // The only time the key itself leaves this process.
        reply = { mcpKey: { token: made.token, key: made.view } };
        break;
      }
      case "mcp-key-revoke":
        await this.mcpTokens().revoke("local", requiredText(request.id));
        break;
      case "mcp-local-set": {
        // The listener is a port on the machine sshs3 runs on. On a shared server that machine is not a member's to open ports on.
        if (request.enabled && this.sharedServer() && !this.host.teamAdmin?.())
          throw new Error("Only an administrator of this server switches on its local MCP listener. Outside agents reach your workspace through the server's own MCP address and a key from your account page.");
        const port = Math.max(0, Math.min(65535, request.port ?? this.store.data.preferences.localMcp?.port ?? 0));
        this.store.data.preferences.localMcp = { enabled: request.enabled, port };
        await this.applyLocalMcp();
        break;
      }
      case "kb-gap-answered": {
        const gap = (this.store.data.kbGaps ?? []).find((g) => `gap:${g.id}` === request.id || g.id === request.id);
        const page = (this.store.data.kbPages ?? []).find((p) => p.id === request.pageId);
        if (!gap) throw new Error("That question is no longer on the list.");
        if (!page) throw new Error("Page not found");
        // The words the agent used become one of the page's search phrases: the same question finds it next time.
        page.keys = cleanKeys([gap.query, ...(page.keys ?? [])]);
        page.updatedAt = Date.now();
        this.store.data.kbGaps = (this.store.data.kbGaps ?? []).filter((g) => g.id !== gap.id);
        this.lastWorkSync = 0;
        break;
      }
      case "kb-ingest-folder": {
        // A folder path here would be a folder on the server, readable by any signed-in user through the knowledge base.
        // Also in a demo on a shared server: the folder is still a folder of the machine it runs on.
        if (this.sharedServer()) throw new Error("A folder on the server cannot be read into the knowledge base from the browser. Drop the files in instead.");
        const docs = await this.kb.ingestLocalFolder(
          requiredText(request.folderPath),
          {
            collection: request.collection,
            cluster: request.cluster ?? request.targetCluster,
            tags: request.tags,
          },
        );
        reply = { ingest: this.addIngestedDocs(docs, await this.resolveActorName()) };
        break;
      }
      case "kb-ingest-s3": {
        const prefix = request.prefix?.trim() || "runbooks/";
        const targetCluster = request.cluster?.trim() || request.targetCluster?.trim() || undefined;
        const isDemoS3Target =
          (await this.isDemoTargetRef(request.s3ProfileId)) ||
          (isDemoMode() && request.s3ProfileId === "sg-fabricpool-dc1");

        if (this.host.resolveStorageProvider && !isDemoS3Target) {
          await this.assertStorageReach(request.s3ProfileId);
          const provider = await this.host.resolveStorageProvider(
            request.s3ProfileId,
          );
          if (!provider) {
            throw new Error(`S3 profile "${request.s3ProfileId}" not found`);
          }
          const left: { name: string; error: string }[] = [];
          const docs = await this.kb.ingestFromStorageProvider(
            provider,
            prefix,
            request.collection?.trim() || `S3:${request.s3ProfileId}`,
            targetCluster,
            undefined,
            { failed: left },
          );
          reply = { ingest: this.addIngestedDocs(docs, await this.resolveActorName(), left) };
          break;
        }

        if (!isDemoMode()) {
          throw new Error(`S3 profile "${request.s3ProfileId}" not found`);
        }

        const doc = this.kb.createDocument({
          title: `S3 KB Sync: ${request.s3ProfileId} (${prefix})`,
          sourceType: "s3",
          sourceRef: `s3://${request.s3ProfileId}/${prefix}`,
          cluster: targetCluster || "NetApp-StorageGRID-S3",
          tags: ["s3-kb", "runbook", request.s3ProfileId],
          content: [
            `# Knowledge base from S3 (${request.s3ProfileId}/${prefix})`,
            "",
            "Demo data: this stands in for the documents a real bucket prefix would hold (operations notes, runbooks, configuration standards).",
            "- Check the S3 ILM rules and the Object Lock (WORM) status at every release.",
            "- Check the FabricPool link between ONTAP (`aggr1_nvme_prod`, `aggr2_nvme_db`) and StorageGRID.",
          ].join("\n"),
          shared: true,
        });
        this.store.data.kbDocuments = [
          ...(this.store.data.kbDocuments ?? []).filter((x) => x.id !== doc.id),
          doc,
        ];
        saveDemoKbDocument(doc);
        break;
      }
      case "layout-event-ack": {
        if (this.pendingLayoutEvent?.id === request.id) {
          this.pendingLayoutEvent = undefined;
        }
        break;
      }
      case "inventory-refresh":
        await this.context.inventory(true);
        break;
      case "forget-history":
        if (this.store.data.tasks.some(active))
          throw new Error("Stop active tasks before deleting history");
        this.store.data.tasks = [];
        this.store.data.history = [];
        this.store.data.workforceRuns = [];
        if (isDemoMode()) {
          for (const dt of getDemoTasks()) {
            this.markBuiltinDismissed(dt.id, getDemoTasks());
          }
          for (const dw of getDemoWorkforceRuns()) {
            this.markBuiltinDismissed(dw.id, getDemoWorkforceRuns());
          }
        }
        this.terminals.observe(false);
        this.terminals.observe((await this.config.getView()).enabled);
        break;
      case "quit":
        app.quit();
        break;
      default: {
        // Every action in HubRequest has a case above: a new one that is typed but not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    // A request that only reads changes nothing: the store is not rewritten and the other windows are not told.
    const read = READ_ONLY_ACTIONS.has(request.action);
    if (!read) await this.store.save();
    const snap = await this.snapshot();
    if (reply) snap.reply = reply;
    if (!read) this.changed(true);
    return snap;
  }

  private async start(
    input: StartAgentTask,
    schedule?: AgentSchedule,
    readOnly?: {
      workforceRunId?: string;
      distillSourceId?: string;
      title: string;
      mainModel?: boolean;
      investigator?: boolean;
      evalCaseId?: string;
    },
    /** For a test-case run: what answers its tool calls. */
    replay?: Replay,
  ): Promise<AgentTask> {
    if (!["advice", "assisted", "autonomous"].includes(input.mode))
      throw new Error("Invalid autonomy mode");
    const terminal = input.sessionId
      ? this.terminals.get(input.sessionId)
      : undefined;
    if (input.sessionId && (!terminal || terminal.state === "disconnected"))
      throw new Error("Target unavailable");
    const now = Date.now();
    const rawAttachments = (input.attachments ?? []).slice(0, 10);
    const startImages = rawAttachments
      .filter(
        (s) =>
          typeof s.imageDataUrl === "string" &&
          s.imageDataUrl.startsWith("data:image/"),
      )
      .map((s) => ({
        label: clip(s.label || "image", 200),
        dataUrl: s.imageDataUrl!.slice(0, 6_000_000),
        mimeType: s.mimeType,
      }));
    const rawPrompt =
      input.prompt?.trim() ||
      (startImages.length > 0 ? "Analyze the attached image(s)." : "");
    // The hub's own prompts open with their instructions and quote bounded data after them:
    // they are passed whole. A person's message that is too long loses its middle, never its start.
    const prompt = boundedPrompt(requiredText(rawPrompt), readOnly ? HUB_PROMPT_MAX : PERSON_PROMPT_MAX);
    const matchedAgent = input.agentId
      ? this.getAgentsList().find((a) => a.id === input.agentId)
      : undefined;
    const task: AgentTask = {
      id: crypto.randomUUID(),
      title: readOnly?.title ?? prompt.slice(0, 100),
      ...(readOnly?.workforceRunId
        ? { workforceRunId: readOnly.workforceRunId }
        : {}),
      ...(readOnly?.distillSourceId
        ? { distillSourceId: readOnly.distillSourceId }
        : {}),
      ...(readOnly?.mainModel ? { mainModelOnly: true } : {}),
      ...(readOnly?.investigator ? { investigator: true } : {}),
      ...(readOnly?.evalCaseId ? { evalCaseId: readOnly.evalCaseId } : {}),
      mode: input.mode,
      agentId: matchedAgent?.id ?? input.agentId,
      agentName: matchedAgent?.name ?? input.agentName,
      status: "queued",
      target: terminal
        ? {
            sessionId: terminal.id,
            generation: terminal.generation,
            label: terminal.label,
          }
        : undefined,
      messages: [
        {
          id: crypto.randomUUID(),
          role: "user",
          text: prompt,
          ...(startImages.length > 0 ? { images: startImages } : {}),
          at: now,
        },
      ],
      changes: [],
      sources: rawAttachments
        .filter((s) => !s.imageDataUrl && s.text?.trim())
        .map((s) => ({
          id: crypto.randomUUID(),
          label: clip(requiredText(s.label), 200),
          text: boundedContext(requiredText(s.text)),
          observedAt: now,
        })),
      createdAt: now,
      updatedAt: now,
      maxCommands: integer(input.maxCommands ?? 20, 1, 100),
      maxMinutes: integer(input.maxMinutes ?? 15, 1, 120),
      verification: "not-verified",
    };
    this.store.data.tasks.push(task);
    if (replay) {
      this.evalReplays.set(task.id, replay);
      // The recording is only needed while the run lasts.
      void this.whenSettled(task).then(() => this.evalReplays.delete(task.id));
    }
    try {
      await this.launch(task, schedule);
    } catch (error) {
      // A person who stopped it while it started keeps the conversation they stopped. One that could
      // not be started at all (the terminal is taken, no model is set, three are running) was never
      // a conversation: the caller gets the error, and no failed, empty entry is left in the list.
      const neverStarted = active(task) || task.status === "failed";
      if (active(task)) {
        task.status = "failed";
        task.error = safeError(error);
      }
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
      if (neverStarted) this.store.data.tasks = this.store.data.tasks.filter((t) => t !== task);
      this.changed();
      throw error;
    }
    return task;
  }

  private async launch(
    task: AgentTask,
    schedule?: AgentSchedule,
  ): Promise<void> {
    if (this.runtimes.has(task.id) || this.launches.has(task.id))
      throw new Error("Task already running");
    // Every way into a run (a new message, a reply, resuming) holds an agent to its pause and its budget.
    // The hub's own background work is bounded by the run that asked for it.
    const as = task.agentId && !isBackgroundRun(task) ? this.getAgentsList().find((a) => a.id === task.agentId) : undefined;
    if (as) this.assertMayRun(as);
    // Workforce specialists are bounded by their run's own concurrency and do
    // not take one of the user's three slots.
    const ownRuns = [...this.runtimes.keys(), ...this.launches.keys()].filter(
      (id) =>
        !isBackgroundRun(this.store.data.tasks.find((t) => t.id === id)),
    ).length;
    if (!isBackgroundRun(task) && ownRuns >= 3)
      throw new Error(
        "Three tasks are already running; pause one before starting another",
      );
    const launchMarker = Symbol(task.id);
    this.launches.set(task.id, launchMarker);
    task.status = "queued";
    // Every run has the conversation's whole budget: what the last one used is not carried over.
    task.budgetStop = undefined;
    task.commandsUsed = 0;
    // What this run spends is its own to be counted: the earlier runs' share stays as it was put down.
    task.usageCountedTokens = this.usagePutDown(task, (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0));
    task.usageCounted = undefined;
    try {
      await this.reattachTicket(task);
      await this.launchReserved(task, launchMarker, schedule);
    } catch (error) {
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
      if (active(task)) {
        task.status = "failed";
        task.error = safeError(error);
      }
      if (task.ticketId) this.settleTickets();
      this.changed();
      throw error;
    } finally {
      if (this.launches.get(task.id) === launchMarker) this.launches.delete(task.id);
      // A launch that failed leaves a run that never ran. Whoever waits for it to
      // settle — a test case holding its recording, a ticket, the workforce — would
      // otherwise wait for ever.
      if (!this.runtimes.has(task.id) && !active(task)) this.settled(task.id);
    }
  }

  private async launchReserved(
    task: AgentTask,
    launchMarker: symbol,
    schedule?: AgentSchedule,
  ): Promise<void> {
    const assertLaunching = (): void => {
      if (
        this.disposed ||
        this.launches.get(task.id) !== launchMarker ||
        !active(task)
      )
        throw new Error("Task was stopped during startup");
    };
    const config = await this.config.getConfig();
    assertLaunching();
    if (!config.enabled)
      throw new Error("Enable AI and configure a model in Hub settings first");
    // An agent that is an external coding agent runs there, not on the configured model.
    const viaRunner = !isBackgroundRun(task) && this.getAgentsList().some((a) => a.id === task.agentId && a.runnerId);
    if (!viaRunner) await this.assertModelEndpointReach(config.baseUrl);
    const external = isBackgroundRun(task)
      ? undefined
      : this.getAgentsList().find((a) => a.id === task.agentId && a.runnerId);
    if (external) return this.launchExternal(task, external, assertLaunching);
    // A schedule runs on the endpoint that is configured now. It keeps a model
    // of its own only while it was saved for this same endpoint: after a change
    // of provider or address it follows the configured model instead of being
    // refused for ever.
    const pinned = Boolean(schedule && schedule.provider === config.provider && (schedule.baseUrl ?? "") === (config.baseUrl ?? ""));
    const provider = config.provider;
    let model = (pinned && schedule?.model) || config.model;
    let baseUrl = config.baseUrl;
    const configDir =
      typeof this.config.getFilePath === "function"
        ? path.dirname(this.config.getFilePath())
        : undefined;
    {
      // The team's conversations go to the provider it chose, or nowhere: a missing key or address is
      // reported as the step that is missing, never quietly made up for by a ChatGPT sign-in on this machine.
      if (provider === "openai-codex") {
        if (baseUrl && baseUrl.includes("openrouter.ai")) {
          baseUrl = undefined;
        }
        if (
          !model ||
          model === "gpt-sol-latest" ||
          model === "local" ||
          model === "gpt-5.3-codex" ||
          model === "gpt-5.4" ||
          model === "gpt-5.4-mini" ||
          model === "gpt-5.2-codex" ||
          model === "gpt-5.1-codex-max" ||
          model.startsWith("claude-")
        ) {
          const codex = await new CodexAuthProvider(configDir).getStatus();
          model = codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"];
        }
      }
    }
    if (!model) throw new Error("Choose a model");
    // The hub's own background work (investigators, reviews, reading for
    // memory) runs on the fast model when one is set for this provider.
    if (
      isBackgroundRun(task) &&
      !schedule &&
      !task.mainModelOnly &&
      config.fastModel &&
      provider === config.provider
    )
      model = config.fastModel;
    // An agent may be given a model of its own. It names a model of the endpoint that is
    // configured now; after a change of provider it follows the configured model instead
    // of being refused for ever — the same rule a schedule's own model follows.
    const runAgent = task.agentId ? this.getAgentsList().find((a) => a.id === task.agentId) : undefined;
    if (runAgent?.modelOverride?.trim() && (!runAgent.modelProvider || runAgent.modelProvider === provider))
      model = runAgent.modelOverride.trim();
    task.model = model;
    if (provider === "anthropic" && !config.apiKey)
      throw new Error("Anthropic API key missing");
    if (provider === "openai-compatible" && !baseUrl)
      throw new Error("Model endpoint missing");
    const modelConfig: HermesModelConfig =
      provider === "openai-codex"
        ? { kind: "openai-codex", model, baseUrl }
        : provider === "anthropic"
          ? { kind: "anthropic", model, apiKey: config.apiKey, baseUrl }
          : { kind: "custom", model, apiKey: config.apiKey, baseUrl: baseUrl! };
    if (task.target && task.mode !== "advice") {
      const live = this.terminals.get(task.target.sessionId);
      if (live && live.state === "ready" && live.shell) {
        this.terminals.claim(
          task.target.sessionId,
          live.generation,
          task.id,
        );
        task.target.generation = live.generation;
      }
    }
    task.status = "running";
    task.error = undefined;
    const capability = await this.broker.issue(task);
    assertLaunching();
    const runtime = new HermesRuntime(
      new HermesManager({
        homeDir: path.join(
          this.directory,
          "runtime",
          crypto.createHash("sha256").update(task.id).digest("hex"),
        ),
        toolEndpoint: capability,
      }),
      (req) => this.broker.invoke(capability.key, req),
      this.evalReplays.get(task.id)?.answer.bind(this.evalReplays.get(task.id)),
      this.evalReplays.get(task.id)?.isLive.bind(this.evalReplays.get(task.id)),
      // On a shared server or in the demo, only this workspace's own sign-in: never the host's ~/.codex.
      // The desktop app's own process may use the person's `codex login`.
      isDemoMode() || this.hosted() ? configDir : undefined,
    );
    this.runtimes.set(task.id, runtime);
    this.armRunTimer(task, Date.now() + task.maxMinutes * 60_000);
    this.changed();
    void runtime
      .start(task, modelConfig, (event) => this.event(task, event))
      .catch((error) => {
        if (active(task)) {
          task.status = "failed";
          task.error = safeError(error);
          task.verification = "incomplete";
        }
      })
      .finally(async () => {
        // A run that was let go of while it hung (see `releaseStuckRun`) ends here much later, perhaps
        // beside a new run of the same conversation: it has nothing left to end.
        if (this.runtimes.get(task.id) !== runtime) return;
        this.clearRunTimer(task.id);
        this.broker.revoke(task.id);
        this.terminals.release(task.id);
        if (active(task)) {
          task.status = "interrupted";
          task.error = "Model connection ended without a final result.";
        }
        await runtime.stop();
        // Hermes files are task-local. Erase runtime history: the redacted Hub store is authoritative.
        const fs = await import("node:fs/promises");
        await fs
          .rm(
            path.join(
              this.directory,
              "runtime",
              crypto.createHash("sha256").update(task.id).digest("hex"),
            ),
            { recursive: true, force: true },
          )
          .catch(() => {});
        if (this.runtimes.get(task.id) === runtime)
          this.runtimes.delete(task.id);
        this.settled(task.id);
        this.changed();
        // A specialist or a memory run is not a task of the user's own.
        if (!isBackgroundRun(task))
          this.notify(
            task.status === "completed"
              ? "Task finished"
              : "Task needs attention",
            task.title,
          );
      });
  }

  private event(task: AgentTask, event: RunEvent): void {
    if (!active(task)) {
      // A run that was already stopped still says what it spent when it ends: that counts too.
      if (/^run\./.test(event.type) && event.usage && !task.usageCounted) {
        task.usage = {
          inputTokens: (task.usage?.inputTokens ?? 0) + (event.usage.input_tokens ?? 0),
          outputTokens: (task.usage?.outputTokens ?? 0) + (event.usage.output_tokens ?? 0),
          costUsd: task.usage?.costUsd,
        };
        this.countAgentUsage(task);
        this.changed();
      }
      return;
    }
    if (event.type === "message.delta" && event.delta) {
      let message = task.messages.at(-1);
      if (!message || message.role !== "assistant") {
        message = {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          at: Date.now(),
        };
        task.messages.push(message);
      }
      message.text = boundedContext(message.text + event.delta, 128_000);
    }
    if (event.type === "todos.updated" && event.todos) task.todos = event.todos;
    if (event.type === "hypotheses.updated" && event.hypotheses) task.hypotheses = event.hypotheses;
    if (event.type === "tool.result" && event.tool) {
      task.toolLog = [
        ...(task.toolLog ?? []),
        { ...event.tool, at: Date.now() },
      ].slice(-60);
    }
    if (
      event.type === "message.interim" &&
      event.text &&
      !task.messages.some((m) => m.text === event.text)
    )
      task.messages.push({
        id: crypto.randomUUID(),
        role: "assistant",
        text: boundedContext(event.text),
        at: Date.now(),
      });
    if (/^run\.(completed|failed|cancelled|interrupted)$/.test(event.type)) {
      task.status = event.type.slice(4) as AgentTask["status"];
      if (event.usage?.context_tokens) task.contextTokens = event.usage.context_tokens;
      if (event.usage)
        task.usage = {
          inputTokens:
            (task.usage?.inputTokens ?? 0) + (event.usage.input_tokens ?? 0),
          outputTokens:
            (task.usage?.outputTokens ?? 0) + (event.usage.output_tokens ?? 0),
          costUsd:
            event.usage.cost_usd === undefined
              ? undefined
              : (task.usage?.costUsd ?? 0) + event.usage.cost_usd,
        };
      if (event.output) {
        const last = task.messages.at(-1);
        if (last?.role === "assistant")
          last.text = boundedContext(event.output, 128_000);
        else
          task.messages.push({
            id: crypto.randomUUID(),
            role: "assistant",
            text: boundedContext(event.output, 128_000),
            at: Date.now(),
          });
      }
      if (event.error) task.error = boundedContext(event.error);
      this.noteBudgetStop(task);
      if (task.status === "completed" || task.status === "failed") this.reflectTaskCompletion(task);
      // Whatever way it ended, what it spent is put down to the agent.
      this.countAgentUsage(task);
      // A handover asked for during the run happens now.
      const next = task.handoffTo && this.getAgentsList().find((a) => a.id === task.handoffTo!.agentId);
      if (next) this.applyHandoff(task, next, task.handoffTo!.reason);
      if (!isBackgroundRun(task)) this.notePageOutcome(task);
      if (
        !isBackgroundRun(task) &&
        this.store.data.preferences.proposeMemories !== false &&
        worthDistilling(task)
      )
        void this.queueForLearning(
          {
            id: `task:${task.id}`,
            title: `Session: ${task.title}`,
            transcript: taskTranscript(task),
          },
          `${task.title} ${task.target?.label ?? ""}`,
        ).catch((e) => log.warn("Memory proposal run failed", safeError(e)));
    }
    task.updatedAt = Date.now();
    if (task.ticketId && !active(task)) this.settleTickets();
    this.changed();
  }

  /**
   * A command asked for from outside sshs3, over MCP.
   *
   * The fence is in what this will not do. It runs on the one server the key
   * names and nowhere else, in a terminal that is already open for that
   * server — never "whichever terminal happens to be open", which is what the
   * ordinary path falls back to. It is always assisted: the change waits in
   * the inbox until a person approves it, in every mode, whatever the safety
   * policy says, because nobody is watching the agent that asked. And it
   * returns at once with the id of what is waiting; the agent asks again for
   * the outcome instead of holding a connection open.
   */
  async runForMcp(input: {
    serverId: string;
    command: string;
    description: string;
    by: string;
    check?: { command: string; expected: string };
    rollback?: string;
  }): Promise<{ changeId: string; taskId: string; status: AgentChange["status"] }> {
    if (isDemoMode()) throw new Error("This is the demo lab; nothing is run on a real server here.");
    const command = requiredText(input.command);
    const wanted = requiredText(input.serverId).toLowerCase();
    const server = this.getKnownServers().find((s) => s.id.toLowerCase() === wanted || s.name.toLowerCase() === wanted);
    if (!server) throw new Error(`No server called "${input.serverId}" in this workspace.`);
    // The one terminal of that server. Not any other, and not a new one: a command from
    // outside does not get to open a connection nobody asked for.
    const session = this.terminals
      .list()
      .find((t) => t.state !== "disconnected" && (t.profileId === server.id || t.label.toLowerCase() === server.name.toLowerCase()));
    if (!session)
      throw new Error(
        `Nothing is connected to ${server.name} in sshs3 right now. A command from outside runs in the terminal that is already open for that server; open one and ask again.`,
      );
    const task: AgentTask = {
      id: `mcp-${crypto.randomUUID()}`,
      title: clip(`From outside: ${input.description || command}`, 120),
      agentName: `${input.by}'s agent, through MCP`,
      // Assisted, whatever anything else says: a person approves every one of these.
      mode: "assisted",
      status: "running",
      // Nobody here is watching whoever asked: every command of this run is put to a person.
      fromOutside: true,
      target: { sessionId: session.id, generation: session.generation, label: session.label },
      messages: [{ id: crypto.randomUUID(), role: "user", text: clip(input.description || command, 2000), at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 1,
      maxMinutes: 30,
      verification: "not-verified",
    };
    this.store.data.tasks.push(task);
    const capability = await this.broker.issue(task);
    const request = input.check?.command
      ? {
          action: "change" as const,
          command,
          description: input.description || command,
          check: input.check,
          rollback: input.rollback ?? "",
          observeSeconds: 0,
          id: session.id,
        }
      : { action: "command" as const, command, description: input.description || command, id: session.id };
    // Not awaited: the answer is "it is waiting", and the agent asks again.
    let settled: { error?: unknown } | undefined;
    const running = this.broker
      .invoke(capability.key, request as never)
      .then(() => {
        // Done is not the same as worked: a change that failed its check, or was taken back, did not.
        task.status = task.changes[0]?.status === "completed" ? "completed" : "failed";
        settled = {};
      })
      .catch((error) => {
        task.status = "failed";
        task.error = safeError(error);
        settled = { error };
      })
      .finally(() => {
        task.updatedAt = Date.now();
        this.broker.revoke(task.id);
        // The terminal is the person's again: a command from outside holds it only while it runs.
        this.terminals.release(task.id);
        this.changed();
      });
    // The change the broker made for it, once it exists: getting the terminal ready can take a while.
    const until = Date.now() + 20_000;
    while (task.changes.length === 0 && !settled && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const change = task.changes[0];
    if (!change) {
      if (settled?.error) throw settled.error instanceof Error ? settled.error : new Error(String(settled.error));
      // Still not ready after this long: it is called off, so that asking again does not leave two behind.
      this.broker.revoke(task.id);
      await running;
      throw new Error("The terminal did not get ready in time. Nothing has run; ask again in a moment.");
    }
    this.changed();
    return { changeId: change.id, taskId: task.id, status: change.status };
  }

  /** What became of a command asked for over MCP. */
  mcpCommandStatus(changeId: string): { status: AgentChange["status"]; output?: string; exitCode?: number; check?: AgentChange["check"]; rollback?: AgentChange["rollback"]; target: string } | undefined {
    for (const task of this.store.data.tasks) {
      if (!task.id.startsWith("mcp-")) continue;
      const change = task.changes.find((c) => c.id === changeId);
      if (change)
        return {
          status: change.status,
          output: change.output,
          exitCode: change.exitCode,
          check: change.check,
          rollback: change.rollback,
          target: change.target,
        };
    }
    return undefined;
  }

  /**
   * What a run spent, put down to the agent it ran as. A ticket run was the
   * only one counted, so a mission run or a chat with an agent selected spent
   * nothing as far as the budget was concerned — and the budget is what the
   * screen calls "tokens this month".
   */
  private countAgentUsage(task: AgentTask, agentId = task.agentId): void {
    if (!agentId) return;
    const used = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0);
    // `task.usage` is the whole conversation's: every run of it (a reply, an approved plan, "Continue")
    // adds to it, and only what was not put down yet is added to the agent's month.
    const fresh = used - this.usagePutDown(task, used);
    // Nothing new reported yet (a stopped run says what it spent a moment later): not counted yet either.
    if (fresh <= 0) return;
    task.usageCounted = true;
    task.usageCountedTokens = used;
    this.store.data.agentUsage = addUsage(this.store.data.agentUsage ?? {}, agentId, fresh);
    this.lastWorkSync = 0;
  }

  /** How many of a conversation's tokens are already on an agent's month. A conversation counted before this was kept per run was counted whole. */
  private usagePutDown(task: AgentTask, used: number): number {
    return task.usageCountedTokens ?? (task.usageCounted ? used : 0);
  }

  private mcpTokenStore?: McpTokenStore;
  private localMcp?: LocalMcpServer;
  private localMcpError?: string;

  /** This installation's own MCP keys, kept beside the hub's other data. */
  private mcpTokens(): McpTokenStore {
    this.mcpTokenStore ??= new McpTokenStore(this.directory);
    return this.mcpTokenStore;
  }

  /**
   * Starts or stops the listener that lets this person's own agent reach this
   * app. It is off until they switch it on, and it listens on 127.0.0.1 only.
   */
  private async applyLocalMcp(): Promise<void> {
    const want = this.store.data.preferences.localMcp;
    this.localMcpError = undefined;
    if (!want?.enabled) {
      await this.localMcp?.stop();
      return;
    }
    await this.mcpTokens().initialize();
    this.localMcp ??= new LocalMcpServer({
      tokens: this.mcpTokens(),
      hubFor: async () => ({
        request: (r) => this.request(r),
        actor: await this.resolveActorName(),
        runCommand: (input) => this.runForMcp({ ...input, by: "your agent" }),
        commandStatus: (id) => this.mcpCommandStatus(id),
        audit: (entry) => this.audit().append(entry),
      }),
    });
    try {
      await this.localMcp.set(true, want.port ?? 0);
    } catch (error) {
      this.localMcpError = safeError(error);
    }
  }

  /** What the settings screen shows about the local listener. */
  private localMcpView(): { enabled: boolean; address?: string; keys: unknown[]; error?: string } {
    return {
      enabled: Boolean(this.store.data.preferences.localMcp?.enabled),
      address: this.localMcp?.address(),
      keys: this.mcpTokenStore?.list("local") ?? [],
      error: this.localMcpError,
    };
  }

  private auditLog?: AuditLog;
  private lastAnchorAt = 0;
  private lastRecordingPruneAt = 0;
  private recorder?: SessionRecorder;

  /** This installation's audit log, kept beside the hub's other data, anchored in the team bucket. */
  audit(): AuditLog {
    this.auditLog ??= new AuditLog(path.join(this.directory, "audit"), this.clientId(), () =>
      this.s3Workspace.canUseBucket() && !isDemoMode() ? this.s3Workspace.objects : undefined,
    );
    return this.auditLog;
  }

  /** Where the terminals an agent owned are recorded. */
  recordings(): SessionRecorder {
    this.recorder ??= new SessionRecorder(path.join(this.directory, "recordings"));
    return this.recorder;
  }

  /**
   * Every change that has reached the state it ends in goes into the audit
   * log once: what ran, where, as whose run, who allowed it, and how it ended.
   * Read off the changes themselves rather than from each place that makes
   * one, so a path that is added later is not a path that is left out.
   */
  private auditFinishedChanges(): void {
    if (isDemoMode()) return;
    const FINAL = new Set(["completed", "failed", "denied", "uncertain"]);
    for (const task of this.store.data.tasks) {
      if (task.distillSourceId) continue;
      for (const change of task.changes) {
        // A run that has ended leaves nothing half-way: what was never answered was not allowed,
        // and what was allowed but never reported back (an external agent's action) is not known.
        if (!active(task) && (change.status === "pending" || change.status === "approved" || change.status === "running")) {
          if (change.status === "pending") {
            change.status = "denied";
            change.decidedHow ??= "stopped";
          } else {
            change.status = "uncertain";
            change.output ??= "The run ended without saying how this went. Look at the target to know.";
          }
        }
        // A change that carries its own proof gets its final status only after its check (and rollback) had their say.
        if (change.audited || !FINAL.has(change.status)) continue;
        change.audited = true;
        const rolledBack = Boolean(change.rollback?.ran);
        void this.audit()
          .append({
            kind: change.kind === "setting" ? "setting" : change.kind === "file" ? "file-write" : change.check ? "change" : task.fromOutside ? "mcp" : "command",
            actor: `${task.agentName ?? "Assistant"} (${task.fromOutside ? "from outside" : `run ${task.id.slice(0, 8)}`}, ${task.mode})`,
            target: change.target,
            what: change.command || change.description,
            outcome: rolledBack ? "rolled-back" : change.status,
            exitCode: change.exitCode,
            approvedBy: change.decidedBy
              ? `${change.decidedBy.name} (${change.decidedBy.allowed ? "allowed" : "refused"})`
              : change.decidedHow && change.decidedHow !== "person"
                ? DECIDED_HOW[change.decidedHow]
                : undefined,
            taskId: task.id,
            changeId: change.id,
            detail: [
              change.riskLevel ? `risk: ${change.riskLevel}` : "",
              change.check
                ? `check ${change.check.after === true ? (change.check.before ? "passed (it already passed before)" : "passed") : change.check.after === false ? "failed" : `not looked at (${change.check.skipped ?? "unknown"})`}: ${change.check.command}`
                : "",
              rolledBack
                ? `taken back with: ${change.rollback!.command}${change.rollback!.restored === false ? " (the check does not read as before)" : ""}`
                : change.rollback?.skipped
                  ? `rollback not run: ${change.rollback.skipped}`
                  : "",
              change.hiddenValues ? "secrets in it were masked here" : "",
              change.ref ? `ref ${change.ref}` : "",
            ]
              .filter(Boolean)
              .join("; "),
          })
          .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
      }
    }
  }

  /** For tests: what a finished run did, put down to the pages it worked from. */
  notePageOutcomeForTesting(task: AgentTask): void {
    this.notePageOutcome(task);
  }

  reflectTaskCompletion(task: AgentTask): void {
    if (task.status !== "completed" && task.status !== "failed") return;
    try {
      const knownServers = this.getKnownServers();
      const session = task.target
        ? this.terminals.get(task.target.sessionId)
        : undefined;
      const targetSrv = knownServers.find(
        (s) =>
          (session?.profileId && s.id === session.profileId) ||
          s.name.toLowerCase() === (task.target?.label ?? "").toLowerCase(),
      );
      task.reflectedAt = Date.now();
      const reflected = this.selfLearning.reflectOnCompletedTask({
        task,
        memories: this.store.data.memories,
        infraEdges: this.store.data.infraEdges ?? [],
        servers: knownServers,
        cluster: targetSrv?.cluster,
      });
      this.store.data.memories = reflected.memories;
      this.store.data.infraEdges = reflected.infraEdges;
    } catch {
      // Never block task completion on self-reflection
    }
  }

  private async stop(task: AgentTask, reason: string): Promise<void> {
    if (!active(task)) return;
    this.launches.delete(task.id);
    task.status = "interrupted";
    // A spent budget is said in the conversation, with the way on: not as an error.
    if (task.budgetStop) this.noteBudgetStop(task);
    else task.error = reason;
    task.verification = "incomplete";
    task.updatedAt = Date.now();
    this.broker.revoke(task.id);
    this.terminals.release(task.id);
    if (task.ticketId) this.settleTickets();
    this.changed();
    const runtime = this.runtimes.get(task.id);
    await runtime?.stop();
    if (runtime) this.releaseStuckRun(task, runtime);
    // Stopping a workforce conversation stops its specialists too.
    for (const [runId, leadId] of this.workforceLeads) {
      if (leadId !== task.id) continue;
      for (const child of this.store.data.tasks.filter(
        (t) => t.workforceRunId === runId && active(t),
      ))
        await this.stop(child, reason);
    }
  }
  /**
   * A stopped run normally ends by itself a moment later. One that is blocked
   * inside a tool call that never returns (a connection that hangs) does not:
   * it would stay "running" for ever, whoever waits for it (a ticket, a
   * workforce run, the asking agent) would wait for ever, and "Continue"
   * would be refused. After a grace period the hub lets go of it: the
   * conversation is free again, and whatever the blocked call does later is
   * refused, because its capability is revoked.
   */
  private runStopGraceMs = RUN_STOP_GRACE_MS;
  private releaseStuckRun(task: AgentTask, runtime: { stop(): Promise<void> }): void {
    const timer = setTimeout(() => {
      if (this.disposed || this.runtimes.get(task.id) !== runtime) return;
      log.warn("A stopped run did not end by itself; letting go of it", task.id);
      this.clearRunTimer(task.id);
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
      this.runtimes.delete(task.id);
      task.updatedAt = Date.now();
      this.settled(task.id);
      if (task.ticketId) this.settleTickets();
      this.changed();
    }, this.runStopGraceMs);
    timer.unref?.();
  }
  /** Ends the conversation with the line that says its budget was used, once per run. */
  private noteBudgetStop(task: AgentTask): void {
    if (!task.budgetStop) return;
    const text = budgetStopLine(task.budgetStop);
    const last = task.messages.at(-1);
    if (last?.role === "system" && last.text === text) return;
    task.messages.push({ id: crypto.randomUUID(), role: "system", text, at: Date.now() });
  }
  private scope(task: AgentTask): string {
    const terminal = task.target && this.terminals.get(task.target.sessionId);
    return terminal
      ? `target:${terminal.profileId ?? terminal.id}`
      : "personal";
  }
  private task(id: string): AgentTask {
    const t = this.store.data.tasks.find((x) => x.id === id);
    if (t) return t;
    // A demo conversation is listed without being stored. The first time something is done to it, it becomes a real one.
    const demo = isDemoMode() ? getDemoTasks().find((x) => x.id === id) : undefined;
    if (!demo) throw new Error("Task not found");
    const copy = structuredClone(demo);
    this.store.data.tasks.push(copy);
    return copy;
  }
  /** `saved`: the store was just written; only tell the windows (a second save of the same data is not needed). */
  changed(saved = false): void {
    if (this.disposed) return;
    this.host.changed();
    // Before the early return below: a change while a save is pending must still reach the inbox.
    this.pokeInbox();
    this.auditFinishedChanges();
    if (saved || !this.initialized || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.store
        .save()
        .catch((e) => log.warn("Save failed", safeError(e)));
    }, 2000);
  }
  /**
   * Runs the task on an external coding agent over ACP. The agent works in
   * the folder its runner names, with its own tools; every action it asks
   * permission for is judged by the same rules as sshS3's own commands.
   */
  private async launchExternal(
    task: AgentTask,
    agent: MissionAgent,
    assertLaunching: () => void,
  ): Promise<void> {
    this.assertRunnerAllowed();
    const runner = (this.store.data.externalRunners ?? []).find((r) => r.id === agent.runnerId);
    if (!runner)
      throw new Error(
        `${agent.name} runs on the external agent "${agent.runnerId}", which is not set up on this computer. Add it under Agents & MCP.`,
      );
    const ticket = live(this.store.data.workTickets).find((t) => t.id === task.ticketId);
    // The change each of the agent's tool calls became, by the agent's id for the call: how it ended is written onto it.
    const changeOfCall = new Map<string, AgentChange>();
    let actions = 0;
    const runtime = new AcpRuntime(runner, {
      preface: [
        `You are working as "${agent.name}" (${agent.role}) for a team that uses sshS3.`,
        task.mode === "advice"
          ? "This conversation is advice only: do not change files, run commands or take any action; read and explain. Anything you ask permission for will be refused."
          : "",
        agent.systemPrompt?.trim() ? agent.systemPrompt.trim() : "",
        ticket
          ? "You were given one ticket from the team's board. Do that ticket and nothing beside it, and end with a report a person can review: what you did, what you verified and how, and what is left."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      settled: (callId, outcome) => {
        const change = changeOfCall.get(callId);
        if (!change || change.status !== "approved") return;
        change.status = outcome.failed ? "failed" : "completed";
        change.output = outcome.output ? maskContext(outcome.output) : change.output;
        changeOfCall.delete(callId);
        this.changed();
      },
      ask: async (question) => {
        const analysis = question.command
          ? analyzeCommandSafety(question.command)
          : {
              // What the agent calls its action is its own word, not a check: without a command to
              // read, nothing is taken to be read-only.
              riskLevel: (question.kind === "delete" ? "destructive" : "modify") as AgentChange["riskLevel"] & string,
              riskReason: `The agent asked to ${question.kind ?? "act"}, and gave no command that could be checked`,
              parsedSubcommands: [],
            };
        const change: AgentChange = {
          id: crypto.randomUUID(),
          kind: "command",
          target: `${runner.name} in ${runner.cwd ?? "?"}`,
          description: clip(question.title, 300),
          // The command, or else everything the agent said it would do: a person is not asked about a title alone.
          command: question.command ? maskContext(question.command) : question.rawInput ? maskContext(question.rawInput) : undefined,
          ...(question.command && maskContext(question.command) !== question.command ? { hiddenValues: true } : {}),
          status: "pending",
          riskLevel: analysis.riskLevel,
          riskReason: analysis.riskReason,
          at: Date.now(),
        };
        if (question.toolCallId) changeOfCall.set(question.toolCallId, change);
        if (task.mode === "advice") {
          change.status = "denied";
          change.decidedHow = "policy";
          task.changes.push(change);
          this.changed();
          return false;
        }
        // The run's command budget holds for an external agent's actions too.
        if (++actions > task.maxCommands) {
          task.commandsUsed = task.maxCommands;
          task.budgetStop ??= { kind: "commands", limit: task.maxCommands, at: Date.now() };
          change.status = "denied";
          change.decidedHow = "policy";
          change.output = `This run may take ${task.maxCommands} actions, and has.`;
          task.changes.push(change);
          this.changed();
          return false;
        }
        task.commandsUsed = actions;
        const needsApproval =
          // Without a command to read, a change to files or a deletion is always put to a person.
          (!question.command && ["edit", "delete", "execute", "move"].includes(question.kind ?? "execute")) ||
          shouldRequireCommandApproval({
            analysis,
            mode: task.mode,
            policy: this.safetyPolicy(),
          });
        if (!needsApproval) {
          change.status = "approved";
          change.decidedHow = "policy";
          task.changes.push(change);
          this.changed();
          return true;
        }
        return this.broker.askApproval(task, change);
      },
    });
    task.model = runner.name;
    task.status = "running";
    task.error = undefined;
    assertLaunching();
    this.runtimes.set(task.id, runtime);
    this.armRunTimer(task, Date.now() + task.maxMinutes * 60_000);
    this.changed();
    void runtime
      .start(task, undefined, (event) => this.event(task, event))
      .catch((error) => {
        if (active(task)) {
          task.status = "failed";
          task.error = safeError(error);
          task.verification = "incomplete";
        }
      })
      .finally(async () => {
        this.clearRunTimer(task.id);
        this.broker.revoke(task.id);
        if (active(task)) {
          task.status = "interrupted";
          task.error = "The external agent ended without a final result.";
        }
        await runtime.stop();
        if (this.runtimes.get(task.id) === runtime) this.runtimes.delete(task.id);
        if (task.ticketId) this.settleTickets();
        this.settled(task.id);
        this.changed();
        this.notify(task.status === "completed" ? "Task finished" : "Task needs attention", task.title);
      });
  }

  // ---- knowledge base: what is dropped in ----------------------------------

  private kbOriginalDir(docId: string): string {
    return path.join(this.directory, "kb-originals", docId.replace(/[^A-Za-z0-9._-]/g, "_"));
  }
  private kbOriginalKey(doc: Pick<KbDocument, "id" | "original">): string {
    const name = (doc.original?.name ?? "file").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
    return `kb/originals/${doc.id.replace(/[^A-Za-z0-9._-]/g, "_")}/${name}`;
  }

  /** The file a document was taken from: from this computer, else from the team bucket (and then kept here). */
  private async readKbOriginal(doc: KbDocument): Promise<Buffer | undefined> {
    const fsp = await import("node:fs/promises");
    const local = path.join(this.kbOriginalDir(doc.id), path.basename(this.kbOriginalKey(doc)));
    try {
      return await fsp.readFile(local);
    } catch {
      // Not here: a teammate added it.
    }
    if (doc.original?.keptLocal || !this.s3Workspace.canUseBucket()) return undefined;
    const remote = await this.s3Workspace.objects.read(this.kbOriginalKey(doc)).catch(() => undefined);
    if (remote) {
      await fsp.mkdir(path.dirname(local), { recursive: true }).catch(() => undefined);
      await fsp.writeFile(local, remote).catch(() => undefined);
    }
    return remote;
  }

  /** This computer's copy of a document's original file. Also called when a teammate removed the document. */
  private async removeLocalKbOriginal(docId: string): Promise<void> {
    const fsp = await import("node:fs/promises");
    await fsp.rm(this.kbOriginalDir(docId), { recursive: true, force: true }).catch(() => undefined);
  }

  private async removeKbOriginal(docId: string): Promise<void> {
    const doc = { id: docId };
    await this.removeLocalKbOriginal(docId);
    if (!this.s3Workspace.canUseBucket()) return;
    const dir = path.posix.dirname(this.kbOriginalKey(doc));
    const names = await this.s3Workspace.objects.list(dir).catch(() => [] as string[]);
    for (const name of names) await this.s3Workspace.objects.remove(`${dir}/${name}`).catch(() => undefined);
  }

  /**
   * Text that was taken out of a file, a link or a paste becomes one document
   * (or several, when it is very long), queued to be read for title, summary
   * and tags. Text that is already in the knowledge base is not added again.
   */
  private async ingestExtracted(
    extracted: Extracted,
    source: {
      name: string;
      sourceType: KbDocument["sourceType"];
      sourceRef?: string;
      original?: { name: string; mime?: string; data: Buffer; keptLocal?: boolean };
    },
  ): Promise<NonNullable<HubReply["ingest"]>> {
    const hash = contentHash(extracted.text);
    const all = this.getKbDocumentsList();
    const twin = all.find((d) => (d.contentHash ?? contentHash(d.content)) === hash);
    if (twin) return { added: [], duplicates: [twin.title], failed: [] };
    const baseTitle = extracted.title?.trim() || titleFromName(source.name);
    const parts = splitLongText(extracted.text);
    const author = await this.resolveActorName();
    const now = Date.now();
    // An address names one thing: fetched again with a new text, it is the same source revised, not a
    // second source that the pages would then have to reconcile with the first. (A file's name names nothing.)
    const earlier =
      source.sourceRef && parts.length === 1 && (source.sourceType === "url" || source.sourceType === "paste")
        ? (this.store.data.kbDocuments ?? []).find((d) => d.sourceRef === source.sourceRef && d.sourceType === source.sourceType)
        : undefined;
    if (earlier) {
      earlier.content = parts[0];
      earlier.chunks = sectionsOf(earlier.id, parts[0]);
      earlier.contentHash = hash;
      earlier.updatedAt = now;
      earlier.pages = extracted.pages;
      earlier.sourceCheck = { at: now };
      earlier.reading = { state: "queued", at: now, revised: this.pagesRestOn(earlier.id) };
      this.lastWorkSync = 0;
      this.kbRetryAt = 0;
      void this.readNextKb();
      return { added: [], duplicates: [], failed: [], updated: [earlier.title] };
    }
    const added: KbDocument[] = parts.map((text, i) => ({
      ...this.kb.createDocument({
        title: parts.length > 1 ? `${baseTitle} — part ${i + 1} of ${parts.length}` : baseTitle,
        sourceType: source.sourceType,
        sourceRef: source.sourceRef,
        content: text,
        author,
      }),
      contentHash: parts.length > 1 ? contentHash(text) : hash,
      titleFromSource: !extracted.title,
      pages: extracted.pages,
      reading: { state: "queued" as const, at: now + i },
    }));
    if (source.original) {
      const first = added[0];
      first.original = {
        name: source.original.name,
        mime: source.original.mime,
        size: source.original.data.length,
        ...(source.original.keptLocal ? { keptLocal: true as const } : {}),
      };
      const fsp = await import("node:fs/promises");
      const local = path.join(this.kbOriginalDir(first.id), path.basename(this.kbOriginalKey(first)));
      await fsp.mkdir(path.dirname(local), { recursive: true });
      await fsp.writeFile(local, source.original.data);
      if (!source.original.keptLocal && this.s3Workspace.canUseBucket())
        void this.s3Workspace.objects
          .write(this.kbOriginalKey(first), source.original.data)
          .catch((e) => log.warn("Could not upload a knowledge base original", safeError(e)));
    }
    this.store.data.kbDocuments = [...(this.store.data.kbDocuments ?? []), ...added];
    this.lastWorkSync = 0;
    void this.readNextKb();
    return { added: added.map((d) => d.title), duplicates: [], failed: [] };
  }

  // ---- knowledge base: the pages agents read --------------------------------

  private knownSystems(servers: WorkspaceServerSummary[]): { clusters: string[]; servers: string[] } {
    return {
      clusters: [...new Set(servers.map((s) => s.cluster).filter((c): c is string => Boolean(c)))],
      servers: servers.map((s) => s.name),
    };
  }

  /** How this installation's runs used the pages. Counts earlier versions kept on the pages are moved here once. */
  private myPageUse(): Record<string, KbPageUse> {
    const use = (this.store.data.kbUse ??= {});
    for (const page of this.store.data.kbPages ?? []) {
      if (page.opens === undefined && page.lastOpenedAt === undefined && page.proven === undefined && page.lastProvenAt === undefined) continue;
      if (!this.store.data.kbUseMoved && page.opens)
        use[page.id] = { ...use[page.id], opens: (use[page.id]?.opens ?? 0) + page.opens, lastOpenedAt: page.lastOpenedAt };
      // A page that came from an app that still counts on the page: the count is its app's, not this one's.
      delete page.opens;
      delete page.lastOpenedAt;
      delete page.proven;
      delete page.lastProvenAt;
    }
    this.store.data.kbUseMoved = true;
    return use;
  }

  private othersPageUse: Record<string, KbPageUse>[] = [];
  private uploadedPageUse = "";
  /** How the team's runs used the pages: this installation's count plus what the others reported. */
  private pageUse(): Record<string, KbPageUse> {
    return sumPageUse([this.myPageUse(), ...this.othersPageUse]);
  }

  /** The pages as agents and the review list see them: with how they were used. */
  private pagesWithUse(): KbPage[] {
    const use = this.pageUse();
    return withUse(this.store.data.kbPages ?? [], use);
  }

  /**
   * Sources that came from a link are fetched again at night. A text that
   * changed brings the pages resting on it in line with it (the same way as
   * dropping the link in again); one that cannot be fetched twice in a row is
   * put up for review, and the pages keep what it last said.
   */
  private async refetchWatchedSources(now = Date.now()): Promise<void> {
    const due = (this.store.data.kbDocuments ?? [])
      .filter(
        (d) =>
          d.sourceType === "url" &&
          d.sourceRef &&
          this.pagesRestOn(d.id) &&
          now - (d.sourceCheck?.at ?? 0) > 20 * 3_600_000,
      )
      .slice(0, 20);
    for (const doc of due) {
      if (this.disposed) return;
      try {
        const fetched = await fetchUrl(doc.sourceRef!, this.kbNetwork?.fetchImpl, {
          ...this.outboundGuard(),
          allowPlainHttp: true,
          lookup: this.kbNetwork?.lookup,
        });
        const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
        if (!current) continue;
        const fetchedHash = contentHash(fetched.text);
        if (fetchedHash === (current.contentHash ?? contentHash(current.content))) {
          current.sourceCheck = { at: now };
          continue;
        }
        current.content = fetched.text;
        current.chunks = sectionsOf(current.id, fetched.text);
        current.contentHash = fetchedHash;
        current.pages = fetched.pages;
        current.updatedAt = now;
        current.sourceCheck = { at: now };
        current.reading = { state: "queued", at: now, revised: true };
        this.lastWorkSync = 0;
        this.kbRetryAt = 0;
      } catch (error) {
        const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
        if (current)
          current.sourceCheck = {
            at: now,
            error: clip(safeError(error), 200),
            failures: (current.sourceCheck?.failures ?? 0) + 1,
          };
      }
    }
    await this.store.save().catch(() => undefined);
    void this.readNextKb();
  }

  private pagesRestOn(docId: string): boolean {
    return (this.store.data.kbPages ?? []).some((p) => p.sources.some((s) => s.docId === docId));
  }

  /** The questions that found nothing, as the model writing pages is shown them. */
  private openGaps(): string[] {
    return (this.store.data.kbGaps ?? []).map((g) => g.query);
  }

  /** A question that found nothing is closed when one of the pages just written answers it. */
  private closeAnsweredGaps(changedIds: string[]): void {
    const changed = (this.store.data.kbPages ?? []).filter((p) => changedIds.includes(p.id));
    if (!changed.length || !this.store.data.kbGaps?.length) return;
    this.store.data.kbGaps = this.store.data.kbGaps.filter((g) => searchPages(changed, g.query).length === 0);
  }

  /**
   * One model run that proposes page changes, applied at once (they can be
   * undone). What the pages then say is held against `sourceText`. Returns
   * how many pages changed.
   */
  private async runPageOps(
    prompt: string,
    shown: KbPage[],
    source: KbPageSource,
    run: { id: string; title: string },
    known: { clusters: string[]; servers: string[] },
    options: { sourceText: string; updatesOnly?: boolean; mayCreate?: number; correctPersonText?: boolean },
  ): Promise<number> {
    const task = await this.runBackground(
      { prompt, mode: "advice", agentName: "Knowledge base", maxCommands: 1, maxMinutes: 8 },
      // Pages are what agents act on: written on the main model, not the cheap one.
      { distillSourceId: run.id, title: clip(run.title, 100), mainModel: true },
    );
    if (task.status !== "completed") throw new Error(task.error || "The run did not finish.");
    const answer = task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
    // The pages the model was shown are the only ones it may update, and only as they are now.
    const now = this.store.data.kbPages ?? [];
    const stillShown = shown.flatMap((p) => now.filter((q) => q.id === p.id && q.revision === p.revision));
    const unusable = { count: 0 };
    const ops = parsePageOps(answer, stillShown, known, {
      allTitles: now.map((p) => p.title),
      updatesOnly: options.updatesOnly,
      mayCreate: options.mayCreate,
      unusable,
    });
    if (!ops) throw new Error("The model's answer could not be used.");
    // Pages that were answered but not in the format asked for are a failed run, not a run that found nothing to write.
    if (ops.length === 0 && unusable.count > 0)
      throw new Error(
        `The model answered with ${unusable.count} page${unusable.count === 1 ? "" : "s"} in a format that could not be read, so nothing was saved.`,
      );
    const applied = applyPageOps(now, ops, {
      by: "assistant",
      source,
      sourceText: options.sourceText,
      correctPersonText: options.correctPersonText,
    });
    // Shown and left as they were: held against the source all the same.
    this.store.data.kbPages = markHeldAgainst(applied.pages, stillShown.map((p) => p.id), source);
    if (applied.changed.length) this.closeAnsweredGaps(applied.changed.map((c) => c.id));
    this.lastWorkSync = 0;
    this.changed();
    return applied.changed.length;
  }

  /** Works a source into the pages, stretch by stretch when it is long. */
  private async compileSource(
    doc: KbDocument,
    known: { clusters: string[]; servers: string[] },
    revised = false,
  ): Promise<number> {
    const parts = sourceParts(doc);
    const source: KbPageSource = { docId: doc.id, title: doc.title, hash: doc.contentHash ?? contentHash(doc.content) };
    let touched = 0;
    for (let i = 0; i < parts.length; i++) {
      const pages = this.store.data.kbPages ?? [];
      // One source may not fill the knowledge base: new pages are counted over all its stretches.
      const mayCreate = MAX_NEW_PAGES_PER_SOURCE - pages.filter((p) => p.sources[0]?.docId === doc.id).length;
      touched += await this.runPageOps(
        buildCompilePrompt(doc, parts[i], pages, known, parts.length > 1 ? { index: i + 1, of: parts.length } : undefined, {
          revised,
          gaps: this.openGaps(),
          mayCreate,
        }),
        candidatePages(pages, `${doc.title} ${parts[i]}`, 6, doc.id),
        source,
        { id: `kbc:${doc.id}:${i}`, title: `Pages · ${doc.title}` },
        known,
        { sourceText: doc.content, mayCreate },
      );
    }
    return touched;
  }

  /** Has one page held against the sources it rests on and written again where it needs it. */
  private async rebuildPage(pageId: string, docs: KbDocument[]): Promise<number> {
    const known = this.knownSystems((await this.collectExtraContext()).workspaceServers ?? []);
    let changed = 0;
    for (const doc of docs) {
      const parts = sourceParts(doc);
      for (let i = 0; i < parts.length; i++) {
        const page = (this.store.data.kbPages ?? []).find((p) => p.id === pageId);
        if (!page) return changed;
        changed += await this.runPageOps(
          buildRebuildPrompt(page, doc, parts[i], known, parts.length > 1 ? { index: i + 1, of: parts.length } : undefined),
          [page],
          { docId: doc.id, title: doc.title, hash: doc.contentHash ?? contentHash(doc.content) },
          { id: `kbr:${pageId}:${doc.id}:${i}`, title: `Rebuilding · ${page.title}` },
          known,
          // A person asked for this page to be put right from its sources.
          { sourceText: doc.content, updatesOnly: true, correctPersonText: true },
        );
      }
    }
    await this.store.save().catch(() => undefined);
    return changed;
  }

  /**
   * What a finished conversation or ticket established, added to the pages:
   * a confirmed cause, a red herring, a procedure that was carried out. Only
   * from a record in which something was confirmed, and only while the
   * assistant may save what it learns without asking.
   */
  private async learnPagesFrom(source: DistillSource): Promise<void> {
    if (isDemoMode() || !source.id.startsWith("task:")) return;
    if (this.store.data.preferences.autoSaveMemories === false || !confirmedSomething(source.transcript)) return;
    const known = this.knownSystems((await this.collectExtraContext()).workspaceServers ?? []);
    const remembered = (this.store.data.memoryProposals ?? [])
      .filter((p) => p.sourceId === source.id)
      .map((p) => `${p.title}: ${p.text}`);
    const pages = this.store.data.kbPages ?? [];
    await this.runPageOps(
      buildLearnPrompt(source, pages, known, remembered, this.openGaps()),
      candidatePages(pages, `${source.title} ${source.transcript}`),
      { docId: source.id, title: source.title },
      { id: `kbl:${source.id}`, title: `Pages · ${source.title}` },
      known,
      { sourceText: source.transcript },
    );
  }

  private checkingContradictions = false;
  private readonly rebuildingPages = new Set<string>();
  /** How the latest "Update from its sources" of each page ended, until the app is closed. */
  private readonly lastRebuilds = new Map<string, { at: number; changed: boolean; error?: string }>();
  private lastContradictionCheck?: { at: number; found: number; compared?: number; of?: number; error?: string };
  /**
   * Compares pages about the same systems and keeps where they disagree, for
   * the review list. One run reads a dozen pairs; with more, each check takes
   * the next dozen, and what earlier checks found about the others is kept.
   */
  private async checkContradictions(): Promise<void> {
    if (this.checkingContradictions) return;
    const all = this.store.data.kbPages ?? [];
    const { pairs, total, next } = pairsToCompare(all, 12, this.store.data.kbPairOffset ?? 0);
    if (pairs.length === 0) {
      this.store.data.kbContradictions = [];
      this.lastContradictionCheck = { at: Date.now(), found: 0, compared: 0, of: 0 };
      return;
    }
    this.checkingContradictions = true;
    this.changed();
    try {
      const task = await this.runBackground(
        { prompt: buildContradictionPrompt(pairs), mode: "advice", agentName: "Knowledge base", maxCommands: 1, maxMinutes: 8 },
        { distillSourceId: `kbx:${Date.now()}`, title: "Checking pages for contradictions", mainModel: true },
      );
      const answer = task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
      const found = task.status === "completed" ? parseContradictions(answer, pairs) : undefined;
      if (found) {
        const compared = new Set(pairs.map(([a, b]) => `${a.id}:${b.id}`));
        const alive = new Set(all.map((p) => p.id));
        this.store.data.kbContradictions = [
          // What was found about pairs this run did not read still stands, as long as both pages exist.
          ...(this.store.data.kbContradictions ?? []).filter(
            (c) => !compared.has(`${c.pageId}:${c.otherPageId}`) && alive.has(c.pageId ?? "") && alive.has(c.otherPageId ?? ""),
          ),
          ...found,
        ];
        this.store.data.kbPairOffset = next;
      }
      this.lastContradictionCheck = found
        ? { at: Date.now(), found: found.length, compared: pairs.length, of: total }
        : { at: Date.now(), found: 0, error: clip(task.error || "The model gave no answer that could be read.", 200) };
      await this.store.save().catch(() => undefined);
    } catch (error) {
      this.lastContradictionCheck = { at: Date.now(), found: 0, error: safeError(error) };
      throw error;
    } finally {
      this.checkingContradictions = false;
      this.changed();
    }
  }

  /**
   * Documents read from a folder or a bucket take the same way in as anything
   * else: the same text is not added twice, an unchanged file is left alone,
   * and what is new is queued to be read and is shared at the next sync.
   */
  private addIngestedDocs(
    docs: KbDocument[],
    author?: string,
    failed: { name: string; error: string }[] = [],
  ): NonNullable<HubReply["ingest"]> {
    const map = new Map((this.store.data.kbDocuments ?? []).map((x) => [x.id, x]));
    const known = new Set([...map.values()].map((x) => x.contentHash).filter((h): h is string => Boolean(h)));
    const result = { added: [] as string[], duplicates: [] as string[], failed, updated: [] as string[] };
    for (const doc of docs) {
      doc.contentHash = contentHash(doc.content);
      const existing = map.get(doc.id);
      if (existing?.contentHash === doc.contentHash || (!existing && known.has(doc.contentHash))) {
        result.duplicates.push(doc.title);
        continue;
      }
      (existing ? result.updated : result.added).push(doc.title);
      known.add(doc.contentHash);
      doc.titleFromSource = true;
      doc.summary = existing?.summary;
      // Whoever read the folder or the bucket in is the author, as for a file dropped in.
      doc.author = existing?.author ?? doc.author ?? author;
      doc.reading = { state: "queued", at: Date.now() };
      map.set(doc.id, doc);
      if (isDemoMode()) saveDemoKbDocument(doc);
    }
    this.store.data.kbDocuments = Array.from(map.values());
    this.lastWorkSync = 0;
    void this.readNextKb();
    return result;
  }

  /**
   * An agent opened a page: counted, so pages nobody uses show up, and noted
   * on the conversation, so how the work ended can be put down to the page.
   * A test run counts nothing: it is not use.
   */
  private notePageOpened(id: string, task?: AgentTask): void {
    if (task?.evalCaseId) return;
    const use = this.myPageUse();
    use[id] = { ...use[id], opens: (use[id]?.opens ?? 0) + 1, lastOpenedAt: Date.now() };
    if (task && !task.kbPages?.includes(id)) task.kbPages = [...(task.kbPages ?? []), id].slice(-20);
  }

  /**
   * A run ended: what it did since the last time is put down to the pages it
   * worked from. A change that passed its own check counts for the page; a
   * change that had to be taken back counts against it, and is put up for
   * review with the run's name. On a ticket an alert made, the page is noted
   * as the one for that alert, so the next ticket for it names the page.
   */
  private notePageOutcome(task: AgentTask): void {
    const opened = (task.kbPages ?? []).filter((id) => (this.store.data.kbPages ?? []).some((p) => p.id === id));
    const fresh = task.changes.slice(task.kbCounted ?? 0);
    task.kbCounted = task.changes.length;
    if (!opened.length || isDemoMode()) return;
    const now = Date.now();
    const use = this.myPageUse();
    const rolledBack = fresh.some((c) => c.rollback?.ran);
    const proven = !rolledBack && fresh.some((c) => c.check?.after === true);
    for (const id of opened) {
      const have = use[id] ?? { opens: 0 };
      if (proven) use[id] = { ...have, proven: (have.proven ?? 0) + 1, lastProvenAt: now };
      if (rolledBack)
        use[id] = { ...have, rolledBack: [{ at: now, title: clip(task.title, 120) }, ...(have.rolledBack ?? [])].slice(0, 5) };
    }
    const ticket = task.ticketId ? live(this.store.data.workTickets).find((t) => t.id === task.ticketId) : undefined;
    const alert = ticket?.alert?.name;
    if (alert && task.status === "completed" && !rolledBack) {
      for (const page of this.store.data.kbPages ?? []) {
        if (!opened.includes(page.id) || page.kind === "system") continue;
        if ((page.alerts ?? []).some((a) => a.toLowerCase() === alert.toLowerCase())) continue;
        page.alerts = [...(page.alerts ?? []), alert].slice(-12);
        page.updatedAt = now;
        this.lastWorkSync = 0;
      }
    }
  }

  /** An agent's search found nothing: kept for the review list. */
  private noteKbGap(query: string, task: AgentTask): void {
    this.store.data.kbGaps = noteGap(this.store.data.kbGaps ?? [], {
      query,
      agent: task.agentName,
      target: task.target?.label,
    });
  }

  /**
   * Reads the next document that is waiting: one model run gives it a title,
   * a summary, tags and a place. With a team bucket the document is claimed
   * first, so the team's installations (a server included) share the queue
   * instead of all reading the same document.
   */
  private async readNextKb(now = Date.now()): Promise<void> {
    if (this.kbReadingId || this.disposed || isDemoMode() || now < this.kbRetryAt) return;
    const waiting = (this.store.data.kbDocuments ?? [])
      .filter(
        (d) =>
          d.reading &&
          (d.reading.state === "queued" ||
            (d.reading.state === "reading" && now - d.reading.at > 10 * 60_000)) &&
          (this.kbSkipUntil.get(d.id) ?? 0) < now,
      )
      .sort((a, b) => a.reading!.at - b.reading!.at);
    const doc = waiting[0];
    if (!doc) return;
    if (!(await this.config.getView().catch(() => ({ enabled: false }))).enabled) {
      this.kbNeedsModel = true;
      return;
    }
    this.kbReadingId = doc.id;
    const client = this.clientId();
    const sync = doc.shared !== false ? this.work() : undefined;
    let claimed = false;
    try {
      if (sync) {
        const held = await sync.claim(`kb-${doc.id}`, { by: await this.resolveActorName(), client }, now);
        if (held.client !== client) {
          this.kbSkipUntil.set(doc.id, now + 3 * 60_000);
          return;
        }
        claimed = true;
      }
      const revised = Boolean(doc.reading?.revised);
      doc.reading = { ...doc.reading!, state: "reading", at: now };
      this.changed();
      const extra = await this.collectExtraContext();
      const servers = extra.workspaceServers ?? [];
      const known = {
        clusters: [...new Set(servers.map((s) => s.cluster).filter((c): c is string => Boolean(c)))],
        servers: servers.map((s) => s.name),
        collections: [
          ...new Set(
            this.getKbDocumentsList()
              .map((d) => d.collection)
              .filter((c): c is string => Boolean(c) && c !== "General"),
          ),
        ],
      };
      const task = await this.runBackground(
        {
          prompt: buildReadingPrompt(doc, known),
          mode: "advice",
          agentName: "Knowledge base",
          maxCommands: 1,
          maxMinutes: 5,
        },
        { distillSourceId: `kb:${doc.id}`, title: `Reading · ${clip(doc.title, 80)}` },
      );
      const answer = task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
      if (task.status !== "completed") throw new Error(task.error || "The reading run did not finish.");
      const reading = parseReading(answer, known);
      if (!reading) throw new Error("The model's answer could not be used.");
      // The document may have been edited or removed while it was read.
      const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
      if (current) {
        if (current.titleFromSource && reading.title) current.title = reading.title;
        current.titleFromSource = false;
        current.summary = reading.summary;
        current.kind = reading.kind;
        current.tags = [...new Set([...(current.tags ?? []), ...reading.tags])].slice(0, 12);
        if (reading.cluster && !current.cluster) {
          current.cluster = reading.cluster;
          current.targetCluster = reading.cluster;
        }
        if (reading.collection && (!current.collection || current.collection === "General"))
          current.collection = reading.collection;
        current.reading = { state: "done", at: Date.now() };
        current.updatedAt = Date.now();
        this.lastWorkSync = 0;
        // Then what it says is worked into the pages agents read. A failure
        // here leaves the document read and searchable; it can be read again.
        try {
          const touched = await this.compileSource(current, known, revised);
          current.compiled = { at: Date.now(), pages: touched };
        } catch (error) {
          current.reading = { state: "done", at: Date.now(), error: `Not worked into the pages: ${boundedContext(safeError(error), 200)}` };
        }
        current.updatedAt = Date.now();
      }
      this.kbNeedsModel = false;
      // The model reads again. Documents whose reading failed may have failed only because it did
      // not then (a provider that was down, a setting it refused): they get another try, a bounded
      // number of times, so a document that cannot be read at all is not tried for ever.
      for (const other of this.store.data.kbDocuments ?? [])
        if (other.reading?.state === "failed" && (other.reading.attempts ?? 0) < 4)
          other.reading = { state: "queued", attempts: other.reading.attempts, at: Date.now() };
    } catch (error) {
      const reason = safeError(error);
      const current = (this.store.data.kbDocuments ?? []).find((d) => d.id === doc.id);
      if (/api key|choose a model|endpoint missing|enable ai|not signed in|oauth/i.test(reason)) {
        // Nothing is wrong with the document: there is no model to read it with yet.
        this.kbNeedsModel = true;
        this.kbRetryAt = Date.now() + 5 * 60_000;
        if (current) current.reading = { state: "queued", at: current.reading?.at ?? now };
      } else if (current) {
        const attempts = (current.reading?.attempts ?? 0) + 1;
        current.reading =
          attempts >= 2
            ? { state: "failed", attempts, error: boundedContext(reason, 300), at: Date.now() }
            : { state: "queued", attempts, at: Date.now() };
      }
    } finally {
      if (claimed) await sync?.release(`kb-${doc.id}`, client).catch(() => undefined);
      this.kbReadingId = undefined;
      await this.store.save().catch(() => undefined);
      this.changed();
    }
    if (!this.disposed) void this.readNextKb();
  }

  // ---- server facts ----------------------------------------------------------


  private readonly factsStore: FactsStore;
  private readonly factsCollecting = new Set<string>();
  private readonly factsInFlight = new Map<string, Promise<void>>();
  private lastFactsTick = 0;
  /** What the bucket says each server was last read as, by whichever installation read it. */
  private readonly factsHeads = new Map<string, { collectedAt: number; hash: string }>();

  private factsSettings(): { enabled: boolean; intervalHours: number; exclude: string[]; watchPaths: string[] } {
    const s = this.store.data.factsSettings ?? {};
    return {
      enabled: s.enabled === true,
      intervalHours: integer(s.intervalHours ?? 6, 1, 168),
      exclude: s.exclude ?? [],
      watchPaths: (s.watchPaths ?? []).filter(isWatchPath),
    };
  }

  /** Problems that are there now and were not dismissed since they appeared. */
  /**
   * The problems a server's last reading shows. A server that stopped
   * answering keeps them (a full disk does not empty itself because nobody can
   * look), said as last seen; one that has not answered three times running is
   * a problem of its own; and a reading older than twice the interval says how
   * old it is.
   */
  private factsProblems(record: FactsRecord, now = Date.now()): FactProblem[] {
    if (!record.facts) return [];
    const intervalMs = this.factsSettings().intervalHours * 3_600_000;
    const at = record.collectedAt ?? 0;
    const old = record.status !== "ok" || now - at > 2 * intervalMs;
    const when = new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const found: FactProblem[] = problems(record.facts, now)
      .filter((p) => (record.dismissed?.[p.key] ?? 0) < (record.problemsSince?.[p.key] ?? 1))
      .map((p) => ({
        ...p,
        since: record.problemsSince?.[p.key],
        ...(old ? { text: `${p.text} (last seen ${when}${record.status !== "ok" ? "; the server is not answering" : ""})` } : {}),
      }));
    if (record.status === "failed" && (record.failures ?? 0) >= 3)
      found.push({
        kind: "unreachable",
        key: "unreachable",
        severity: "warning",
        text: `Could not be read ${record.failures} times running${record.error ? `: ${clip(record.error, 120)}` : ""}`,
        since: at,
      });
    return found;
  }

  private factsView(): NonNullable<HubSnapshot["serverFacts"]> {
    const settings = this.factsSettings();
    const servers = this.getKnownServers().map((server): ServerFactsView => {
      const record = this.factsStore.get(server.id);
      if (!record) return { serverId: server.id, name: server.name, status: "never", problems: [], changes: [] };
      const summary = record.facts && !record.facts.unsupported ? factsSummary(record.facts) : undefined;
      return {
        serverId: server.id,
        name: server.name,
        status: record.status,
        error: record.error,
        collectedAt: record.collectedAt,
        via: record.via,
        os: summary?.os,
        kernel: summary?.kernel,
        bootAt: summary?.bootAt,
        rebootRequired: summary?.rebootRequired,
        packages: summary?.packages,
        listening: summary?.listening,
        services: summary?.services,
        disks: summary?.disks,
        problems: this.factsProblems(record),
        changes: record.changes.slice(0, 20),
      };
    });
    return { ...settings, servers, collecting: [...this.factsCollecting] };
  }

  private static changeLine(change: FactChange, name: string): string {
    return `${new Date(change.at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${name}: ${change.text}`;
  }

  /** What changed lately, per server, as lines that start with the time: handed to the agent's context, which picks the target's. */
  private recentServerChanges(withinMs: number, now = Date.now()): { name: string; cluster?: string; lines: string[] }[] {
    const clusters = new Map(this.getKnownServers().map((s) => [s.id, s.cluster]));
    return this.factsStore
      .all()
      .map((r) => ({
        name: r.name,
        cluster: clusters.get(r.serverId),
        lines: r.changes.filter((c) => now - c.at <= withinMs).slice(0, 20).map((c) => HubService.changeLine(c, r.name)),
      }))
      .filter((r) => r.lines.length);
  }

  /**
   * How each server stood when its facts were last read, in a few lines, with
   * how old that reading is: the agent knows the state it starts from, and
   * knows to look again before it acts on a reading that is hours old.
   */
  private serverFactsNow(now = Date.now()): { name: string; cluster?: string; collectedAt: number; age: string; lines: string[] }[] {
    const clusters = new Map(this.getKnownServers().map((s) => [s.id, s.cluster]));
    const ago = (ms: number): string =>
      ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / 86_400_000)} days`;
    return this.factsStore
      .all()
      .filter((r) => r.facts && r.collectedAt)
      .map((r) => {
        const f = r.facts!;
        const lines = [
          f.os?.pretty ? `OS: ${f.os.pretty}${f.kernel ? `, kernel ${f.kernel}` : ""}` : "",
          f.rebootRequired ? "A reboot is pending" : "",
          f.failedServices.length ? `Failed services: ${f.failedServices.slice(0, 10).join(", ")}` : "",
          ...f.disks.filter((d) => d.usedPct >= 80).slice(0, 5).map((d) => `Disk ${d.mount} is ${d.usedPct}% full`),
          ...f.certs
            .filter((c) => c.notAfter - now < 30 * 86_400_000)
            .slice(0, 5)
            .map((c) => (c.notAfter < now ? `Certificate ${c.path} has expired` : `Certificate ${c.path} expires in ${Math.ceil((c.notAfter - now) / 86_400_000)} days`)),
          f.listening.length ? `Listening: ${[...new Set(f.listening.map((l) => `${l.port}/${l.proto}${l.process ? ` (${l.process})` : ""}`))].slice(0, 15).join(", ")}` : "",
        ].filter(Boolean);
        return { name: r.name, cluster: clusters.get(r.serverId), collectedAt: r.collectedAt!, age: ago(now - r.collectedAt!), lines };
      });
  }

  /** The same for one server or cluster by name: what an alert's ticket is given. */
  private changesOn(name: string | undefined, withinMs: number, now = Date.now()): string[] {
    const wanted = (name ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return this.recentServerChanges(withinMs, now)
      .filter((r) => r.name.toLowerCase() === wanted || r.cluster?.toLowerCase() === wanted)
      .flatMap((r) => r.lines)
      .sort()
      .reverse()
      .slice(0, 20);
  }

  private factsDue(serverId: string, now: number, intervalHours: number): boolean {
    const record = this.factsStore.get(serverId);
    const head = this.factsHeads.get(serverId)?.collectedAt ?? 0;
    const last = Math.max(record?.attemptedAt ?? 0, head);
    if (!last) return true;
    // Spread over ten minutes so a fleet is not read in one burst.
    const jitter = (parseInt(crypto.createHash("sha256").update(serverId).digest("hex").slice(0, 6), 16) % 600) * 1000;
    // No answer twice in a row: once a day is enough, and does not look like someone trying passwords.
    // A system the collection does not know: once a week, in case it was replaced.
    const wait =
      record?.status === "unsupported" && head <= (record.attemptedAt ?? 0)
        ? 7 * 24 * 3_600_000
        : (record?.failures ?? 0) >= 2 && head <= (record?.attemptedAt ?? 0)
          ? 24 * 3_600_000
          : intervalHours * 3_600_000;
    return now - last >= wait + jitter;
  }

  /**
   * Takes over what another installation read since last time, so that no server is read twice.
   * True when a reading was taken over. This is the team's knowledge, not this person's schedule:
   * it runs with the board's sync whether or not readings are switched on here.
   */
  private async pullSharedFacts(): Promise<boolean> {
    if (!this.s3Workspace.canUseBucket() || isDemoMode()) return false;
    let taken = false;
    const objects = this.s3Workspace.objects;
    const names = (await objects.list("work/facts/heads")).filter((n) => n.endsWith(".json")).slice(0, 1000);
    // Only readings of servers this installation knows as shared: a teammate's personal server is not ours to see.
    const shared = new Set(this.getKnownServers().filter((s) => s.shared).map((s) => s.id));
    for (const name of names) {
      try {
        const head = JSON.parse((await objects.read(`work/facts/heads/${name}`))?.toString("utf8") ?? "null") as { serverId?: string; collectedAt?: number; hash?: string } | null;
        if (!head?.serverId || !head.collectedAt || !shared.has(head.serverId)) continue;
        this.factsHeads.set(head.serverId, { collectedAt: head.collectedAt, hash: head.hash ?? "" });
        const mine = this.factsStore.get(head.serverId);
        if ((mine?.collectedAt ?? 0) >= head.collectedAt) continue;
        const data = JSON.parse((await objects.read(`work/facts/data/${name}`))?.toString("utf8") ?? "null") as FactsRecord | null;
        // Stamped with the head's time: the data is written only when it changed, so it can be older than the reading.
        if (data?.serverId === head.serverId && data.facts) {
          await this.factsStore.put({ ...data, collectedAt: Math.max(data.collectedAt ?? 0, head.collectedAt), dismissed: mine?.dismissed, changes: data.changes ?? [] });
          taken = true;
        }
      } catch {
        // One unreadable object does not stop the rest.
      }
    }
    return taken;
  }

  private factsRound?: Promise<void>;
  /**
   * One round: every server that is due, three at a time, until none is left.
   * Rounds do not overlap; one that is asked for while another runs waits for
   * it and then reads what was asked.
   */
  private async factsTick(now = Date.now(), asked = false): Promise<void> {
    const settings = this.factsSettings();
    if (!settings.enabled && !asked) return;
    if (this.factsRound) {
      if (!asked) return;
      await this.factsRound.catch(() => undefined);
    } else if (!asked && now - this.lastFactsTick < 5 * 60_000) return;
    this.lastFactsTick = now;
    const round = (async () => {
      await this.pullSharedFacts().catch((e) => log.warn("Reading shared server facts failed", safeError(e)));
      const due = this.getKnownServers()
        .filter((s) => !settings.exclude.includes(s.id) && (asked || this.factsDue(s.id, now, settings.intervalHours)))
        .slice(0, 500);
      for (let i = 0; i < due.length && !this.disposed; i += 3) await Promise.all(due.slice(i, i + 3).map((s) => this.collectFacts(s, now, asked)));
    })();
    this.factsRound = round;
    try {
      await round;
    } finally {
      if (this.factsRound === round) this.factsRound = undefined;
    }
  }

  /** Reads one server: runs the script, compares with last time, keeps the difference. No model is involved. */
  private collectFacts(server: WorkspaceServerSummary, now = Date.now(), asked = false): Promise<void> {
    // A reading that is under way is the reading: whoever asks again waits for the same one.
    const running = this.factsInFlight.get(server.id);
    if (running) return running;
    const reading = this.readFacts(server, now, asked).finally(() => this.factsInFlight.delete(server.id));
    this.factsInFlight.set(server.id, reading);
    return reading;
  }

  private async readFacts(server: WorkspaceServerSummary, now: number, asked: boolean): Promise<void> {
    this.factsCollecting.add(server.id);
    this.host.changed();
    try {
      const settings = this.factsSettings();
      const sync = isDemoMode() ? undefined : this.work();
      const client = this.clientId();
      if (sync && !asked) {
        const held = await sync.claim(`facts-${server.id}`, { by: await this.resolveActorName(), client }, now).catch(() => undefined);
        if (held && held.client !== client) return; // Another installation is reading it.
      }
      const prev = this.factsStore.get(server.id);
      const base = { serverId: server.id, name: server.name, attemptedAt: now, dismissed: prev?.dismissed };
      const demo = isDemoMode();
      const result = demo
        ? { ok: true, stdout: demoFactsOutput(server, now, prev?.facts ? 1 : 0), via: "demo" as const, error: undefined }
        : this.host.execOnServer
          ? await this.host
              .execOnServer(server.id, buildScript(settings.watchPaths), 60_000)
              .catch((e) => ({ ok: false, stdout: "", error: safeError(e), via: "own-connection" as const }))
          : { ok: false, stdout: "", error: "Reading servers is not available in this installation", via: "own-connection" as const };
      if (!result.ok) {
        await this.factsStore.put({
          ...(prev ?? { changes: [] }),
          ...base,
          status: "failed",
          error: boundedContext(result.error ?? "No answer", 240),
          failures: (prev?.failures ?? 0) + 1,
        });
        return;
      }
      const facts = parseFacts(result.stdout, now);
      const fresh = prev?.facts && !prev.facts.unsupported ? diffFacts(prev.facts, facts) : [];
      const present = problems(facts, now);
      const record: FactsRecord = {
        ...base,
        status: facts.unsupported ? "unsupported" : "ok",
        collectedAt: now,
        via: result.via,
        hash: factsHash(facts),
        facts,
        failures: 0,
        changes: [...fresh, ...(prev?.changes ?? [])].filter((c) => now - c.at < 30 * 24 * 3_600_000).slice(0, 200),
        problemsSince: Object.fromEntries(present.map((p) => [p.key, prev?.problemsSince?.[p.key] ?? now])),
      };
      await this.factsStore.put(record);
      if (!facts.unsupported) this.proposeEdgesFrom(server, facts, now);
      // A personal server's reading stays on this computer: only shared servers are read for the team.
      if (sync && server.shared) {
        const objects = this.s3Workspace.objects;
        const name = `${server.id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.json`;
        // The whole record only when something is different; the small head every time, so others know it was read.
        if (record.hash !== prev?.hash || fresh.length)
          await objects.write(`work/facts/data/${name}`, Buffer.from(JSON.stringify({ ...record, dismissed: undefined }), "utf8")).catch(() => undefined);
        await objects
          .write(`work/facts/heads/${name}`, Buffer.from(JSON.stringify({ serverId: server.id, collectedAt: now, hash: record.hash, client }), "utf8"))
          .catch(() => undefined);
        this.factsHeads.set(server.id, { collectedAt: now, hash: record.hash ?? "" });
      }
    } finally {
      this.factsCollecting.delete(server.id);
      this.changed();
    }
  }

  /**
   * A connection this server holds to another server of the workspace is a
   * dependency somebody may want on the map. It is suggested with what was
   * seen; a person confirms it. A link that exists, or one that was removed,
   * is not suggested again.
   */
  private proposeEdgesFrom(server: WorkspaceServerSummary, facts: ServerFacts, now: number): void {
    const others = this.getKnownServers().filter((s) => s.id !== server.id && s.host);
    const edges = (this.store.data.infraEdges ??= []);
    let added = false;
    for (const peer of facts.peers) {
      const at = peer.lastIndexOf(":");
      const [address, port] = [peer.slice(0, at), peer.slice(at + 1)];
      const other = others.find((s) => s.host === address);
      if (!other) continue;
      const id = `edge-facts-${crypto.createHash("sha256").update(`${server.id}|${other.id}`).digest("hex").slice(0, 16)}`;
      if (this.store.data.sharedRemoved?.edges?.[id]) continue;
      if (edges.some((e) => e.id === id || (e.from === server.name && e.to === other.name))) continue;
      edges.push({
        id,
        from: server.name,
        to: other.name,
        relation: "depends_on",
        proposed: true,
        evidence: `${server.name} had a connection open to ${other.name} (${address}:${port}) when it was read.`,
        proposedBy: "Server facts",
        updatedAt: now,
      });
      added = true;
    }
    if (added) this.lastWorkSync = 0;
  }

  // ---- notifications out -----------------------------------------------------

  private readonly notifyStore: NotifyStore;
  private readonly runTimers = new Map<string, { timer: NodeJS.Timeout; endsAt: number }>();
  private inboxDirty = false;
  private inboxTimer?: NodeJS.Timeout;
  private flushingInbox = false;
  /** How long the bucket is given to settle before a shared item is told about. Replaced in tests. */
  private notifySettle = (): Promise<void> => new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
  private notifyWaits: number[] | undefined;

  private approvalWaitMinutes(): number {
    return integer(this.store.data.preferences.approvalWaitMinutes ?? 10, 1, 60);
  }

  private armRunTimer(task: AgentTask, endsAt: number): void {
    this.clearRunTimer(task.id);
    const timer = setTimeout(() => {
      // A run that is waiting for a person is not out of time: the wait is given back to it when
      // the answer comes (`waited`). Until then it looks again a little later, at the same end.
      if (this.broker.waitingOnPerson(task.id)) {
        const again = setTimeout(() => this.armRunTimer(task, endsAt), 15_000);
        this.runTimers.set(task.id, { timer: again, endsAt });
        return;
      }
      this.runTimers.delete(task.id);
      task.budgetStop ??= { kind: "minutes", limit: task.maxMinutes, at: Date.now() };
      void this.stop(task, "Run time budget exhausted");
    }, Math.max(0, endsAt - Date.now()));
    this.runTimers.set(task.id, { timer, endsAt });
  }

  private clearRunTimer(taskId: string): void {
    const armed = this.runTimers.get(taskId);
    if (armed) clearTimeout(armed.timer);
    this.runTimers.delete(taskId);
  }

  /** Stands in for the network when a page is fetched for the knowledge base. Set in tests only. */
  private kbNetwork?: { fetchImpl: typeof fetch; lookup: GuardOptions["lookup"] };

  /** The web server, where people sign in to accounts: a person's name and the server's own paths are the account's, not the request's. */
  private hosted(): boolean {
    return Boolean(this.host.alertHookOwner);
  }

  /**
   * A shared server with several users: what one of them types must not reach into the server itself.
   * A web server with one account, its administrator's, is that person's own machine like the desktop app.
   */
  private sharedServer(): boolean {
    return this.hosted() && !this.host.soleUser?.();
  }

  /** Where sshs3 may call out to on a user's word: a notification channel, a page for the knowledge base. */
  private outboundGuard(): GuardOptions {
    return { server: this.sharedServer(), allowPrivate: !this.sharedServer() || process.env.SSHS3_ALLOW_PRIVATE_ADDRESSES === "1" };
  }

  private publicUrl(): string {
    return (process.env.SSHS3_PUBLIC_URL?.trim() || this.notifyStore.data.publicUrl || "").replace(/\/+$/, "");
  }

  private inboxLink(itemId?: string): string | undefined {
    const base = this.publicUrl();
    return base ? `${base}/?view=Inbox${itemId ? `&item=${encodeURIComponent(itemId)}` : ""}` : undefined;
  }

  private notificationsView(): NonNullable<HubSnapshot["notifications"]> {
    return {
      channels: this.notifyStore.data.channels.map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        host: hostOf(c.url),
        hasSecret: Boolean(c.secret),
        enabled: c.enabled,
        events: c.events.filter((e): e is NotifyEventKind => e !== "knowledge"),
        includeCommand: c.includeCommand,
        alertMinSeverity: c.alertMinSeverity,
        last: c.last,
      })),
      publicUrl: this.publicUrl(),
      publicUrlFixed: Boolean(process.env.SSHS3_PUBLIC_URL?.trim()),
      reminderMinutes: this.notifyStore.data.reminderMinutes,
    };
  }

  /** What waits for a person right now, from the store itself: no snapshot is built for this. */
  private inboxNow(): InboxItem[] {
    return inboxItems({
      tasks: this.store.data.tasks,
      workTickets: live(this.store.data.workTickets),
      dailyReport: this.store.data.dailyReport,
      serverFacts: {
        // Only servers this installation still has and has not left alone: a deleted or excluded server reports nothing.
        servers: this.factsStore
          .all()
          .filter((r) => this.getKnownServers().some((s) => s.id === r.serverId) && !this.factsSettings().exclude.includes(r.serverId))
          .map((r) => ({ serverId: r.serverId, name: r.name, status: r.status, collectedAt: r.collectedAt, problems: this.factsProblems(r), changes: [] })),
      },
    }).filter((item) => NOTIFY_KINDS.includes(item.kind));
  }

  /** Something changed: look at the inbox shortly. Cheap, because every change in the hub comes through here. */
  private pokeInbox(): void {
    this.inboxDirty = true;
    if (this.inboxTimer || this.disposed || !this.initialized) return;
    this.inboxTimer = setTimeout(() => {
      this.inboxTimer = undefined;
      void this.flushInbox().catch((e) => log.warn("Notifications failed", safeError(e)));
    }, 3000);
    this.inboxTimer.unref?.();
  }

  /** The item with what a person needs to decide, from the run it belongs to. */
  private notifyItem(item: InboxItem): NotifyItem {
    const task = item.taskId ? this.store.data.tasks.find((t) => t.id === item.taskId) : undefined;
    const change = item.changeId ? task?.changes.find((c) => c.id === item.changeId) : undefined;
    return {
      id: item.id,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      from: item.kind === "approval" ? task?.agentName || "Assistant" : item.from,
      target: item.target,
      risk: item.risk,
      reason: change?.riskReason,
      command: change?.command,
      check: change?.check?.command,
      rollback: change?.rollback?.command,
      // What is left of the wait, not the whole of it: a reminder comes when part of it has gone.
      waitsMinutes:
        item.kind === "approval"
          ? Math.max(1, Math.round(this.approvalWaitMinutes() - (Date.now() - (item.since ?? item.at)) / 60_000))
          : undefined,
      link: this.inboxLink(item.id),
    };
  }

  /**
   * Tells the channels about what is new in the inbox, and reminds once about
   * an approval nobody answered. What blocks a running agent also gives a
   * desktop notification, which until now nothing did.
   */
  private async flushInbox(now = Date.now()): Promise<void> {
    if (this.flushingInbox || this.disposed || isDemoMode()) return;
    this.flushingInbox = true;
    this.inboxDirty = false;
    let out: NotifyItem[];
    let since: Map<string, number>;
    try {
      const data = this.notifyStore.data;
      const items = this.inboxNow();
      const before = JSON.stringify([data.seen, data.reminded]);
      const { fresh, seen } = diffInbox(items, data.seen, now);
      data.seen = seen;
      // A reminder comes before the agent stops waiting, or it would never come: at most a minute before the end.
      const remindAfter = Math.min(data.reminderMinutes, Math.max(1, this.approvalWaitMinutes() - 1)) * 60_000;
      const reminders =
        remindAfter > 0
          ? items.filter((i) => i.kind === "approval" && !fresh.includes(i) && !data.reminded[i.id] && now - (i.since ?? i.at) >= remindAfter)
          : [];
      data.reminded = Object.fromEntries(Object.entries(data.reminded).filter(([id]) => seen[id] !== undefined));
      for (const item of reminders) data.reminded[item.id] = now;
      const blocking = fresh.filter((i) => ["approval", "plan", "question"].includes(i.kind));
      if (blocking.length)
        this.notify(
          blocking.length === 1 ? (blocking[0].kind === "approval" ? "Approval needed" : "An agent is waiting for you") : `${blocking.length} things are waiting for you`,
          `${blocking[0].from ?? "Assistant"}: ${blocking[0].title}`,
        );
      out = [...fresh.map((i) => this.notifyItem(i)), ...reminders.map((i) => ({ ...this.notifyItem(i), reminder: true }))];
      since = new Map(items.map((i) => [i.id, i.since ?? i.at]));
      if (before !== JSON.stringify([data.seen, data.reminded])) await this.notifyStore.save();
    } finally {
      // Released before anything is sent: a channel that does not answer must not hold up what comes next.
      this.flushingInbox = false;
    }
    if (out.length) {
      await this.sendToChannels(out, since);
      await this.notifyStore.save();
    }
    if (this.inboxDirty) this.pokeInbox();
  }

  private async sendToChannels(items: NotifyItem[], since: Map<string, number>): Promise<void> {
    const channels = this.notifyStore.data.channels.filter((c) => c.enabled);
    if (!channels.length) return;
    // On a shared server only the person whose installation this is can answer: the message says who.
    const owner = this.host.alertHookOwner ? await this.resolveActorName() : undefined;
    const sync = this.work();
    const client = this.clientId();
    const hash = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
    await Promise.all(
      channels.map(async (channel) => {
        let mine = items.filter((item) => channelWants(channel, item));
        if (sync) {
          // A ticket is on every installation that shares the bucket: one of them tells the channel.
          const kept: NotifyItem[] = [];
          for (const item of mine) {
            const shared = ["review", "blocked", "alert", "health"].includes(item.kind);
            if (
              !shared ||
              (await sync
                .markOnce(hash(`${item.id}|${since.get(item.id) ?? 0}|${hash(channel.url).slice(0, 16)}`), client, this.notifySettle)
                .catch(() => true))
            )
              kept.push(item);
          }
          mine = kept;
        }
        if (!mine.length) return;
        const result = await deliver(renderNotification(channel, mine, { owner, inboxLink: this.inboxLink() }), this.outboundGuard(), {
          waits: this.notifyWaits,
        });
        channel.last = { at: Date.now(), ...result };
        if (!result.ok) log.warn("A notification was not delivered", `${channel.name}: ${result.error ?? result.status}`);
      }),
    );
    this.host.changed();
  }

  // ---- nightly upkeep --------------------------------------------------------

  private nightlyRunning = false;
  /**
   * Once a day, after three in the morning and while nothing of the user's is
   * running: memory is tidied, pages are compared for contradictions, and the
   * day's report is written. With a team bucket one installation does it for
   * the team.
   */
  private async nightly(now = Date.now()): Promise<void> {
    const at = new Date(now);
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    if (this.nightlyRunning || this.store.data.lastNightlyDay === day || at.getHours() < 3 || isDemoMode()) return;
    if (this.store.data.tasks.some((t) => active(t) && !isBackgroundRun(t))) return;
    this.nightlyRunning = true;
    try {
      const sync = this.work();
      const client = this.clientId();
      // The team's upkeep (tidying team memory, fetching the knowledge base's links again, looking for
      // contradictions) is done once a day by one installation: a mark that stays for the day, not a
      // lease that lapses after four minutes and lets the next one do it all again.
      const mine = sync ? await sync.markOnce(`nightly-${day}`, client, this.notifySettle, now).catch(() => false) : true;
      this.store.data.lastNightlyDay = day;
      if (mine) {
        await sync?.pruneMarks(14 * 24 * 60 * 60_000, now).catch(() => undefined);
        await this.request({ action: "self-learn-reflect" }).catch((e) => log.warn("Nightly tidy failed", safeError(e)));
        await this.refetchWatchedSources(now).catch((e) => log.warn("Fetching the knowledge base's links again failed", safeError(e)));
        await this.checkContradictions().catch((e) => log.warn("Nightly contradiction check failed", safeError(e)));
      }
      // The report is each installation's own: since its last one, however long the computer was off.
      const extra = await this.collectExtraContext();
      const snap = await this.snapshot();
      const since = this.store.data.dailyReport?.at ?? now - 24 * 60 * 60_000;
      this.store.data.dailyReport = {
        day,
        at: Date.now(),
        text: buildDailyReport({
          since,
          now,
          activity: extra.activityLog ?? this.store.data.activityLog ?? [],
          tickets: live(this.store.data.workTickets),
          tasks: this.store.data.tasks,
          pages: this.store.data.kbPages ?? [],
          memories: extra.memories ?? this.store.data.memories,
          findings: snap.kbFindings ?? [],
          serverChanges: this.recentServerChanges(Math.max(24 * 3_600_000, now - since), now).flatMap((r) => r.lines).sort().reverse(),
          serverProblems: this.factsStore.all().flatMap((r) => this.factsProblems(r, now).map((p) => `${r.name}: ${p.text}`)),
        }),
      };
      await this.store.save().catch(() => undefined);
      this.changed();
    } finally {
      this.nightlyRunning = false;
    }
  }

  // ---- tests for the agents --------------------------------------------------

  /**
   * Replays test cases one after the other. Each is the recorded question put
   * to the agent as it is now, with the tools answering from the recording;
   * the answer is checked against what a person said should happen.
   */
  private async runEvalCases(ids: string[]): Promise<void> {
    try {
      for (const id of ids) {
        const found = (this.store.data.evalCases ?? []).find((c) => c.id === id);
        if (!found || this.disposed) continue;
        this.evalRunningId = id;
        this.changed();
        const replay = new Replay(found.recorded);
        let run: EvalRun;
        try {
          const task = await this.start(
            { prompt: found.prompt, mode: found.mode, agentId: found.agentId, maxCommands: 40, maxMinutes: 10 },
            undefined,
            { evalCaseId: id, title: `Test · ${clip(found.title, 80)}`, mainModel: true },
            replay,
          );
          await this.whenSettled(task);
          const answer = [...task.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text ?? "";
          const checks = ruleChecks(found.expect, answer, task.toolLog ?? []);
          if (found.expect.conclusion && task.status === "completed" && answer) {
            const judge = await this.runBackground(
              { prompt: judgePrompt(found, answer), mode: "advice", agentName: "Tests", maxCommands: 1, maxMinutes: 5 },
              { distillSourceId: `eval:${id}:${Date.now()}`, title: `Judging · ${clip(found.title, 80)}`, mainModel: true },
            );
            const verdict = parseJudgement(judge.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "");
            checks.push(verdict ?? { name: "reaches the expected conclusion", passed: false, detail: "The judgement could not be read." });
          }
          run = evalRun({ task, checks, unrecorded: replay.unrecorded, live: replay.live });
        } catch (error) {
          run = {
            at: Date.now(),
            passed: false,
            // It never started: that says nothing about the agent.
            inconclusive: safeError(error),
            checks: [],
            answer: "",
            calls: [],
            unrecorded: replay.unrecorded,
            live: replay.live,
            tokens: 0,
          };
        }
        const current = (this.store.data.evalCases ?? []).find((c) => c.id === id);
        if (current) {
          current.runs = [run, ...current.runs].slice(0, 5);
          current.updatedAt = Date.now();
          this.lastWorkSync = 0;
        }
        await this.store.save().catch(() => undefined);
        this.changed();
      }
    } finally {
      this.evalRunningId = undefined;
      this.changed();
    }
  }

  // ---- alerts in -----------------------------------------------------------

  /**
   * A posted alert, from the web server. Returns undefined when the secret is
   * wrong or alerts are off: the caller answers as if nothing were there.
   */
  async receiveAlert(
    secret: string,
    body: unknown,
  ): Promise<{ created: string[]; updated: string[] } | undefined> {
    await this.initialize();
    const hook = this.store.data.alertHook;
    if (!hook || !hookSecretMatches(secret, hook.hash)) return undefined;
    const alerts = parseAlerts(body);
    hook.lastAt = Date.now();
    hook.received += 1;
    const result = await this.takeAlerts(alerts);
    await this.store.save().catch(() => undefined);
    this.changed();
    return result;
  }

  /**
   * The page for an alert: one a run on an earlier ticket for the same alert
   * worked from, else the troubleshooting page that best matches its words.
   * The ticket names it, so the agent opens it instead of starting from nothing.
   */
  private pagesForAlert(alert: IncomingAlert, target?: string): { id: string; title: string; known: boolean }[] {
    const pages = this.pagesWithUse();
    const name = alertName(alert).toLowerCase();
    const bound = pages.filter((p) => (p.alerts ?? []).some((a) => a.toLowerCase() === name));
    if (bound.length)
      return bound
        .sort((a, b) => (b.proven ?? 0) - (a.proven ?? 0))
        .slice(0, 2)
        .map((p) => ({ id: p.id, title: p.title, known: true }));
    return searchPages(
      pages.filter((p) => p.kind === "troubleshooting"),
      `${alert.title} ${target ?? ""}`,
      1,
    ).map((h) => ({ id: h.page.id, title: h.page.title, known: false }));
  }

  /**
   * Alerts become tickets. The same alert firing again raises the count on
   * its open ticket instead of making another; a resolved one is noted. A
   * closed ticket is not reopened: the alert firing again later is new work.
   */
  private async takeAlerts(alerts: IncomingAlert[]): Promise<{ created: string[]; updated: string[] }> {
    const servers = (await this.collectExtraContext()).workspaceServers ?? [];
    const agents = this.getAgentsList();
    const created: string[] = [];
    const updated: string[] = [];
    const now = Date.now();
    for (const alert of alerts.slice(0, 50)) {
      const open = live(this.store.data.workTickets).find(
        (t) => t.alert?.fingerprint === alert.fingerprint && t.status !== "done",
      );
      if (open) {
        const was = open.alert!;
        // What this post is: over, a new firing (after it had resolved, or with a new start), or only the
        // same firing sent again (Alertmanager re-sends a whole group on every change and every repeat
        // interval; PagerDuty sends acknowledgements and notes). Only the first two are news.
        const resolved = alert.status === "resolved";
        const refired =
          !resolved &&
          !alert.update &&
          (Boolean(was.resolvedAt) || (alert.startsAt !== undefined && was.startsAt !== undefined && alert.startsAt !== was.startsAt));
        const note = resolved
          ? was.resolvedAt
            ? undefined
            : `${alert.source} says this has resolved.`
          : refired
            ? `Fired again${was.resolvedAt ? " after it had resolved" : ""} (${was.count + 1} times).`
            : undefined;
        const alertNow = {
          ...was,
          lastAt: now,
          count: was.count + (refired ? 1 : 0),
          resolvedAt: resolved ? (was.resolvedAt ?? now) : refired || !was.resolvedAt ? undefined : was.resolvedAt,
          ...(refired && was.resolvedAt ? { firingSince: now } : {}),
          ...(alert.startsAt ? { startsAt: alert.startsAt } : {}),
        };
        // Over before anybody started on it: out of the heartbeat's way, and back when it fires again.
        const park = resolved && !was.resolvedAt && open.status === "todo";
        const unpark = refired && was.parked === true && open.status === "backlog";
        const text = park ? `${note} Moved to Backlog: nothing is firing. Move it back if it should still be looked at.` : note;
        this.putTicket({
          ...(text ? withComment(open, alert.source, text, now) : { ...open, updatedAt: now }),
          ...(park ? { status: "backlog" as const } : unpark ? { status: "todo" as const } : {}),
          alert: { ...alertNow, parked: park ? true : unpark || !resolved ? undefined : was.parked },
        });
        updated.push(open.id);
        continue;
      }
      // An alert that is already over when it arrives is nothing to work on.
      if (alert.status === "resolved") continue;
      const target = alertTarget(alert, servers);
      const agent = routeAlert(alert, target, this.store.data.alertRules ?? [], agents);
      const ticket = await this.saveTicketFrom(
        {
          title: clip(`${alert.severity === "critical" ? "Alert (critical)" : "Alert"}: ${alert.title}`, 200),
          description: alertTicketText(alert, this.changesOn(target, 24 * 3_600_000), this.pagesForAlert(alert, target)),
          assigneeAgentId: agent?.id,
          target,
          outside: `an alert from ${alert.source}`,
        },
        alert.source,
      );
      this.putTicket({
        ...ticket,
        alert: {
          fingerprint: alert.fingerprint,
          name: clip(alertName(alert), 160),
          source: alert.source,
          severity: alert.severity,
          firstAt: now,
          lastAt: now,
          count: 1,
          ...(alert.startsAt ? { startsAt: alert.startsAt } : {}),
        },
      });
      created.push(ticket.id);
    }
    if (created.length) this.notify("New alert", `${created.length} ticket${created.length === 1 ? "" : "s"} on the board`);
    return { created, updated };
  }

  // ---- the board ----------------------------------------------------------

  /** Names this installation in ticket claims; made once and kept. */
  private clientId(): string {
    this.store.data.clientId ??= crypto.randomUUID();
    return this.store.data.clientId;
  }

  /** The board in the team bucket, when one is in use. */
  private work(): WorkSync | undefined {
    if (!this.s3Workspace.canUseBucket()) return undefined;
    this.workSyncStore ??= new WorkSync(this.s3Workspace.objects);
    return this.workSyncStore;
  }

  /** This month's spending per agent: this installation's runs plus what teammates' apps reported. */
  private usageTotal(): Record<string, AgentUsage> {
    return sumUsage([this.store.data.agentUsage, ...this.othersUsage]);
  }

  /** Notes that a shared agent, runbook or dependency was removed here, and syncs soon. */
  private markSharedRemoved(collection: "agents" | "kb" | "edges" | "pages" | "evals", id: string): void {
    const all = (this.store.data.sharedRemoved ??= {});
    all[collection] = { ...(all[collection] ?? {}), [id]: Date.now() };
    this.lastWorkSync = 0;
  }

  /**
   * A removed document's pages: one written from it alone goes with it (a person may have removed the
   * document for what it says, and the page says the same); one that rests on other sources too
   * no longer names it. A page a person edited is kept, without the source.
   */
  private forgetKbSource(docId: string): void {
    const pages = this.store.data.kbPages ?? [];
    if (!pages.some((p) => p.sources.some((s) => s.docId === docId))) return;
    const now = Date.now();
    this.store.data.kbPages = pages.flatMap((p) => {
      if (!p.sources.some((s) => s.docId === docId)) return [p];
      const rest = p.sources.filter((s) => s.docId !== docId);
      if (!rest.length && !p.editedByPerson) {
        this.markSharedRemoved("pages", p.id);
        return [];
      }
      return [{ ...p, sources: rest, updatedAt: Math.max(now, p.updatedAt + 1) }];
    });
    this.changed();
  }

  /**
   * The team's setup beside the board: agents, shared runbooks and
   * dependencies. Each is merged per item with the bucket's copy. MCP servers
   * are left out on purpose (a server is a command that runs with the user's
   * rights, and may carry secrets), and so are schedules (they belong to the
   * installation that runs them). The demo lab's invented data is not shared.
   */
  private async syncSharedSetup(sync: WorkSync): Promise<boolean> {
    if (isDemoMode()) return false;
    const removed = (this.store.data.sharedRemoved ??= {});
    let changed = false;

    // What goes to the bucket is masked: a teammate (and every model their agents use) reads it.
    const agents = await sync.reconcile("agents", withRemovals(maskStrings(this.store.data.agents ?? []), removed.agents));
    const a = splitRemovals(agents.items);
    removed.agents = a.removed;
    if (agents.changed) {
      // The masked copy went to the bucket; an agent that did not change there stays as it is here.
      const ownAgents = new Map((this.store.data.agents ?? []).map((x) => [x.id, x]));
      this.store.data.agents = (a.alive as MissionAgent[]).map((x) => {
        const local = ownAgents.get(x.id);
        return local && local.updatedAt === x.updatedAt ? local : incomingAgent(x, local);
      });
      changed = true;
    }

    const docs = this.store.data.kbDocuments ?? [];
    const mine = new Map(docs.map((d) => [d.id, d]));
    // The pieces are made from the text, so they are not sent: a document travels once, not twice.
    const kb = await sync.reconcile(
      "kb",
      withRemovals(
        docs.filter((d) => d.shared !== false).map((d) => maskStrings({ ...d, chunks: [] })),
        removed.kb,
      ),
      // A document is never added back under its id (a new one gets a new id), so its removal is final:
      // a copy written later (a teammate's computer that finished reading it after it was removed) does
      // not bring it back. The removal is stamped newer than that copy, so the bucket keeps the removal.
      (local, remote) => {
        if (Boolean(local.deleted) === Boolean(remote.deleted)) return remote.updatedAt > local.updatedAt ? remote : local;
        const [gone, kept] = local.deleted ? [local, remote] : [remote, local];
        return gone.updatedAt > kept.updatedAt ? gone : { ...gone, updatedAt: kept.updatedAt + 1 };
      },
    );
    const k = splitRemovals(kb.items);
    removed.kb = k.removed;
    // A document a teammate removed takes its original file with it: the copy fetched to this computer is not kept behind.
    for (const d of docs) if (d.original && d.id in k.removed) void this.removeLocalKbOriginal(d.id);
    if (kb.changed) {
      this.store.data.kbDocuments = [
        ...docs.filter((d) => d.shared === false && !(d.id in k.removed)),
        ...(k.alive as KbDocument[]).map((d) => {
          const local = mine.get(d.id);
          return local && local.updatedAt === d.updatedAt
            ? local
            : { ...d, chunks: sectionsOf(d.id, d.content) };
        }),
      ];
      changed = true;
    }

    // A document that is gone takes the pages written only from it along, here as on the computer that removed it.
    for (const d of docs) if (d.id in k.removed) this.forgetKbSource(d.id);

    const pages = await sync.reconcile("pages", withRemovals(this.store.data.kbPages ?? [], removed.pages), mergePageCopies);
    // Merged into the pages as they are now: one that was compiled here while the bucket was read stays.
    const pagesNow = mergeItems(withRemovals(this.store.data.kbPages ?? [], removed.pages), pages.items, mergePageCopies);
    const pg = splitRemovals(pagesNow.items);
    removed.pages = pg.removed;
    if (pages.changed || pagesNow.changed) {
      this.store.data.kbPages = pg.alive as KbPage[];
      changed = true;
    }

    const evals = await sync.reconcile("evals", withRemovals(this.store.data.evalCases ?? [], removed.evals));
    const ev = splitRemovals(evals.items);
    removed.evals = ev.removed;
    if (evals.changed) {
      this.store.data.evalCases = ev.alive as EvalCase[];
      changed = true;
    }

    const edges = await sync.reconcile("edges", withRemovals(this.store.data.infraEdges ?? [], removed.edges));
    const e = splitRemovals(edges.items);
    removed.edges = e.removed;
    if (edges.changed) {
      this.store.data.infraEdges = e.alive as InfraGraphEdge[];
      changed = true;
    }
    return changed;
  }

  private ticket(id: string): WorkTicket {
    const found = live(this.store.data.workTickets).find((t) => t.id === id);
    if (!found) throw new Error("Ticket not found");
    return found;
  }

  /** Stores a ticket here and sends it to the team. The upload is not waited for. */
  private putTicket(ticket: WorkTicket): void {
    const had = (this.store.data.workTickets ?? []).find((t) => t.id === ticket.id);
    // When it came to this status: what tells a new "review" from an old one with a new comment.
    ticket = { ...ticket, statusAt: had && had.status === ticket.status ? (had.statusAt ?? ticket.statusAt) : Date.now() };
    this.store.data.workTickets = [
      ...(this.store.data.workTickets ?? []).filter((t) => t.id !== ticket.id),
      ticket,
    ];
    void this.work()
      ?.put("tickets", ticket)
      .catch((e) => (this.workSyncError = safeError(e)));
    this.changed();
  }

  private putGoal(goal: WorkGoal): void {
    this.store.data.workGoals = [
      ...(this.store.data.workGoals ?? []).filter((g) => g.id !== goal.id),
      goal,
    ];
    void this.work()
      ?.put("goals", goal)
      .catch((e) => (this.workSyncError = safeError(e)));
    this.changed();
  }

  /** Creates or changes a ticket from a form or from an agent's tool call. */
  async saveTicketFrom(
    input: {
      id?: string;
      title: string;
      description?: string;
      goalId?: string;
      status?: WorkTicketStatus;
      assigneeAgentId?: string;
      target?: string;
      blockedBy?: string[];
      parentId?: string;
      outside?: string;
    },
    createdBy?: string,
    /** Made by an agent's run, not by a person. */
    byAgent = false,
    /** Filled with what was saved differently from what was asked, for the reply. */
    notes: string[] = [],
  ): Promise<WorkTicket> {
    const known = input.id
      ? live(this.store.data.workTickets).find((t) => t.id === input.id)
      : undefined;
    // A ticket that an agent is running keeps its place on the board: its text can be changed, its status
    // belongs to the run. Asked of the bucket too, because this board can be behind another installation's.
    const running = known ? await this.ticketRunsNow(known) : undefined;
    // Read again after the question: the board may have moved while the bucket answered.
    const existing = known ? live(this.store.data.workTickets).find((t) => t.id === known.id) : undefined;
    const now = Date.now();
    const agent = input.assigneeAgentId
      ? this.getAgentsList().find((a) => a.id === input.assigneeAgentId)
      : undefined;
    if (input.assigneeAgentId && !agent) throw new Error("The assigned agent does not exist");
    const goals = live(this.store.data.workGoals);
    // Outside text travels: a ticket split off one that came from outside carries the mark too.
    const parent = input.parentId ? live(this.store.data.workTickets).find((t) => t.id === input.parentId) : undefined;
    const outside = existing?.outside ?? input.outside ?? (parent?.outside ? `split off "${clip(parent.title, 80)}" (${parent.outside})` : undefined);
    const wanted =
      input.status && TICKET_STATUSES.includes(input.status) && input.status !== "in_progress"
        ? input.status
        : (existing?.status ?? (agent ? "todo" : "backlog"));
    // An agent cannot put work that started outside the team in front of another agent: a person moves it.
    const status =
      running && existing ? existing.status : byAgent && outside && !existing && wanted === "todo" ? "backlog" : wanted;
    if (running && existing && input.status && input.status !== existing.status)
      notes.push(`The status was not changed. ${running}`);
    else if (input.status === "in_progress" && existing?.status !== "in_progress")
      notes.push("The status was not changed: a ticket is in progress while an agent runs it. Start it instead.");
    if (input.goalId && !goals.some((g) => g.id === input.goalId))
      notes.push("The goal does not exist, so the ticket was saved without one.");
    const id = existing?.id ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    const blockers = (input.blockedBy ?? existing?.blockedBy ?? []).filter(
      (b) => b !== id && live(this.store.data.workTickets).some((t) => t.id === b),
    );
    const dropped = (input.blockedBy ?? []).filter((b) => !blockers.includes(b));
    if (dropped.length)
      notes.push(
        `Left out of "waits for", because ${dropped.length === 1 ? "it is" : "they are"} not on the board${dropped.includes(id) ? " (a ticket cannot wait for itself)" : ""}: ${dropped.join(", ")}.`,
      );
    const ticket: WorkTicket = {
      ...existing,
      id,
      title: clip(requiredText(input.title), 200),
      description: clip(input.description?.trim() ?? existing?.description ?? "", 8000),
      goalId: goals.some((g) => g.id === input.goalId) ? input.goalId : undefined,
      status,
      assigneeAgentId: agent?.id,
      assigneeName: agent?.name,
      target: input.target?.trim() ? boundedContext(input.target.trim(), 200) : undefined,
      blockedBy: blockers,
      parentId: input.parentId ?? existing?.parentId,
      ...(outside ? { outside } : {}),
      createdBy: existing?.createdBy ?? createdBy ?? (await this.resolveActorName()),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.putTicket(ticket);
    return ticket;
  }

  /**
   * Checks the ticket out and wakes its agent for it. With a team bucket the
   * claim is taken there first, so a teammate's app that reaches for the same
   * ticket finds it taken.
   */
  private async startTicket(id: string, sessionId?: string): Promise<AgentTask> {
    const ticket = this.ticket(id);
    const agents = this.getAgentsList();
    const client = this.clientId();
    const reason = whyNotRunnable(ticket, {
      tickets: live(this.store.data.workTickets),
      agents,
      usage: this.usageTotal(),
      runners: (this.store.data.externalRunners ?? []).map((r) => r.id),
      client,
    });
    if (reason) throw new Error(reason);
    const agent = agents.find((a) => a.id === ticket.assigneeAgentId)!;
    const by = await this.resolveActorName();
    const now = Date.now();
    const sync = this.work();
    if (sync) {
      // The claim is decided only after the bucket has settled, and another installation's claim is
      // judged alive by this machine's own observation, not by that machine's clock.
      const held = await sync.claim(ticket.id, { by, client }, now, {
        fresh: (c) => this.claimAlive(ticket.id, c.seenAt, Date.now()),
        settle: this.notifySettle,
      });
      if (held.client !== client) throw new Error(`${held.by} is already running this ticket.`);
    }
    // Nobody sits at a terminal for a ticket the heartbeat takes (or one started without naming a
    // terminal): where the ticket names one of the workspace's servers, the run gets a terminal of its own there.
    const own = sessionId ? undefined : await this.openTicketTerminal(ticket, agent);
    let task: AgentTask;
    try {
      task = await this.start({
        prompt:
          ticketPrompt(
            ticket,
            live(this.store.data.workGoals).find((g) => g.id === ticket.goalId),
            { tickets: live(this.store.data.workTickets), agents, agent },
          ) + (own?.note ? `\n\n${own.note}` : ""),
        sessionId: sessionId ?? own?.sessionId,
        mode: agent.defaultMode,
        agentId: agent.id,
        agentName: agent.name,
      });
    } catch (e) {
      if (own?.sessionId) this.host.closeSession?.(own.sessionId);
      await sync?.release(ticket.id, client).catch(() => undefined);
      throw e;
    }
    if (own?.sessionId) {
      task.ownTerminal = own.terminal;
      this.closeWhenRunEnds(task.id, own.sessionId);
    }
    task.ticketId = ticket.id;
    task.title = clip(`Ticket: ${ticket.title}`, 100);
    this.putTicket({
      ...ticket,
      status: "in_progress",
      claim: { by, client, at: now, seenAt: now },
      taskId: task.id,
      result: undefined,
      updatedAt: now,
    });
    return task;
  }

  /**
   * Why the ticket cannot be moved, removed or decided right now: somebody's agent is running it. Asked
   * of the claim in the bucket, not only of this installation's copy of the ticket. The board here can
   * be most of a minute behind, and an edit made on that old view would take the ticket from under a
   * teammate's run. Undefined when nobody runs it.
   */
  private async ticketRunsNow(ticket: WorkTicket): Promise<string | undefined> {
    const client = this.clientId();
    const here = "An agent is running this ticket. Stop the run first.";
    if (
      ticket.status === "in_progress" &&
      ticket.claim?.client === client &&
      this.store.data.tasks.some((t) => t.id === ticket.taskId && active(t))
    )
      return here;
    const claim = await this.work()
      ?.readClaim(ticket.id)
      .catch(() => undefined);
    if (claim && claim.client !== client && this.claimAlive(ticket.id, claim.seenAt, Date.now()))
      return `${claim.by} is running this ticket on another computer. Stop the run there first.`;
    return ticket.status === "in_progress" && claimIsFresh(ticket) ? here : undefined;
  }

  /**
   * A ticket's conversation that goes on after its run ended (the agent's plan was approved, a person
   * answered it, "Continue") is the ticket's run again. The ticket is checked out once more, so that
   * what this run does and reports ends up on the ticket. Without this the ticket kept the report of
   * the run that only proposed the plan, also after the work was done.
   */
  private async reattachTicket(task: AgentTask): Promise<void> {
    if (!task.ticketId) return;
    const ticket = live(this.store.data.workTickets).find((t) => t.id === task.ticketId);
    // Only the ticket's latest conversation, and not one a person has already closed.
    if (!ticket || ticket.taskId !== task.id || ticket.status === "in_progress" || ticket.status === "done") return;
    const client = this.clientId();
    const by = await this.resolveActorName();
    const now = Date.now();
    const sync = this.work();
    if (sync) {
      const held = await sync
        .claim(ticket.id, { by, client }, now, { fresh: (c) => this.claimAlive(ticket.id, c.seenAt, Date.now()) })
        .catch(() => undefined);
      // Somebody else's app has taken the ticket meanwhile: the conversation goes on, the ticket is theirs.
      if (held && held.client !== client) return;
    }
    const current = live(this.store.data.workTickets).find((t) => t.id === ticket.id);
    if (!current || current.taskId !== task.id || current.status === "done") return;
    this.putTicket({ ...current, status: "in_progress", claim: { by, client, at: now, seenAt: now }, updatedAt: now });
  }

  /**
   * A terminal for a ticket's run on the server the ticket names. Undefined
   * when the ticket names none of the workspace's servers or the agent only
   * advises; a `note` instead of a session when the server is known and no
   * terminal could be opened on it (it needs a person to sign in, it is
   * down): the run is told, so that its report says so.
   */
  private async openTicketTerminal(
    ticket: WorkTicket,
    agent: MissionAgent,
  ): Promise<{ sessionId?: string; terminal?: NonNullable<AgentTask["ownTerminal"]>; note?: string } | undefined> {
    const name = ticket.target?.trim().toLowerCase();
    if (isDemoMode() || !name || agent.defaultMode === "advice" || agent.runnerId) return undefined;
    if (!this.host.openServerTerminal || !this.host.closeSession) return undefined;
    if (this.getKnownServers().length === 0) await this.collectExtraContext().catch(() => undefined);
    const server = this.getKnownServers().find(
      (s) => s.name.toLowerCase() === name || s.id.toLowerCase() === name || s.host?.toLowerCase() === name,
    );
    if (!server) return undefined;
    try {
      const sessionId = await this.host.openServerTerminal(server.id);
      return { sessionId, terminal: { via: "server", profileId: server.id, shell: "bash", label: server.name } };
    } catch (error) {
      log.info("No terminal for a ticket run", safeError(error));
      return {
        note: `No terminal could be opened on ${server.name} for this run (${clip(safeError(error), 300)}), so you cannot run commands there. Say so in your report, with what a person should check on the server.`,
      };
    }
  }

  /**
   * A conversation whose terminal the hub opened itself goes on: the terminal
   * was closed when its last run ended, and is opened again on the same
   * target. Left as it is when it cannot be opened; the caller then treats
   * the conversation as one without a terminal.
   */
  private async reviveOwnTerminal(task: AgentTask): Promise<void> {
    const own = task.ownTerminal;
    if (!own || isDemoMode()) return;
    const session = task.target && this.terminals.get(task.target.sessionId);
    if (session && session.state !== "disconnected") return;
    try {
      const id =
        own.via === "server"
          ? await this.host.openServerTerminal!(own.profileId)
          : await this.openUnattendedTerminal({ profileId: own.profileId, shell: own.shell }, own.label);
      const opened = this.terminals.get(id);
      if (!opened) return;
      task.target = { sessionId: opened.id, generation: opened.generation, label: opened.label };
      // Closed again when the run that is about to start ends (also when it fails to start).
      const set = this.runTerminals.get(task.id) ?? new Set<string>();
      set.add(id);
      this.runTerminals.set(task.id, set);
    } catch (error) {
      log.info("The run's own terminal could not be opened again", safeError(error));
    }
  }

  /**
   * Tickets this app is running whose run has ended: the report goes on the
   * ticket, the tokens on the agent's budget, and the ticket to review.
   */
  private settleTickets(): void {
    const client = this.clientId();
    for (const ticket of live(this.store.data.workTickets)) {
      if (ticket.status !== "in_progress" || ticket.claim?.client !== client) continue;
      const task = this.store.data.tasks.find((t) => t.id === ticket.taskId);
      if (task && active(task)) continue;
      if (!task) {
        // The conversation is gone (history was deleted): the ticket goes back.
        this.putTicket({ ...ticket, status: "todo", claim: undefined, updatedAt: Date.now() });
      } else {
        // Only what was not counted when the run ended (a run that carries the agent has been).
        this.countAgentUsage(task, ticket.assigneeAgentId ?? task.agentId);
        this.putTicket(ticketAfterRun(ticket, task));
      }
      void this.work()
        ?.release(ticket.id, client)
        .catch(() => undefined);
    }
  }

  /**
   * The board's share of the timer: finish what ended, keep this app's claims
   * alive, read the team's copy, free tickets whose runner went away, and, if
   * the heartbeat is on, take the next ticket.
   */
  /** When this machine last saw each other installation's claim move: its own clock, never theirs. */
  private readonly claimSeen = new Map<string, { seenAt: number; at: number }>();

  private observeClaim(ticketId: string, seenAt: number, now: number): void {
    const known = this.claimSeen.get(ticketId);
    if (!known || known.seenAt !== seenAt) this.claimSeen.set(ticketId, { seenAt, at: now });
  }

  /** Another installation's claim is alive while its seenAt keeps moving, as observed from here. */
  private claimAlive(ticketId: string, seenAt: number, now: number): boolean {
    this.observeClaim(ticketId, seenAt, now);
    return now - this.claimSeen.get(ticketId)!.at < TICKET_CLAIM_TTL_MS;
  }

  private async workTick(now = Date.now()): Promise<void> {
    this.settleTickets();
    const client = this.clientId();
    const sync = this.work();
    if (sync && !this.workSyncing && now - this.lastWorkSync >= 40_000) {
      this.workSyncing = true;
      this.lastWorkSync = now;
      try {
        // Liveness goes into the claim file only. Raising the ticket's own updatedAt would make this
        // copy win every merge, and wipe out what teammates wrote on it meanwhile.
        for (const t of live(this.store.data.workTickets))
          if (t.status === "in_progress" && t.claim?.client === client) {
            const still = await sync.refresh(t.id, client, now);
            const run = this.store.data.tasks.find((x) => x.id === t.taskId);
            if (!still && run && active(run)) void this.stop(run, "Another installation took this ticket over; this run stops so that only one works on it.");
          }
        const goals = await sync.reconcile("goals", this.store.data.workGoals ?? []);
        // A ticket this installation is running stays its own to settle: a teammate's edit on a view
        // that did not show the run yet must not take the ticket from under it.
        const runningHere = (t: WorkTicket): boolean =>
          !t.deleted &&
          t.status === "in_progress" &&
          t.claim?.client === client &&
          this.store.data.tasks.some((x) => x.id === t.taskId);
        const keepRun = (l: WorkTicket, r: WorkTicket): WorkTicket => mergeTicketCopies(l, r, runningHere);
        const tickets = await sync.reconcile("tickets", this.store.data.workTickets ?? [], keepRun);
        // Merged into the board as it is now, not over it: what changed here while the bucket was read stays.
        this.store.data.workGoals = mergeItems(this.store.data.workGoals ?? [], goals.items).items;
        this.store.data.workTickets = mergeItems(this.store.data.workTickets ?? [], tickets.items, keepRun).items;
        // Another installation's run is judged alive by its claim file, and by this machine's own clock:
        // a claim whose seenAt has not moved for the claim's lifetime, as seen from here, has lapsed.
        for (const t of live(this.store.data.workTickets))
          if (t.status === "in_progress" && t.claim && t.claim.client !== client) {
            const c = await sync.readClaim(t.id).catch(() => undefined);
            if (c) this.observeClaim(t.id, c.seenAt, now);
          }
        const shared = await this.syncSharedSetup(sync);
        // A teammate's reading of a shared server, also for somebody who has not switched readings on.
        const facts = await this.pullSharedFacts().catch((e) => {
          log.warn("Reading shared server facts failed", safeError(e));
          return false;
        });
        const mine = JSON.stringify(this.store.data.agentUsage ?? {});
        if (mine !== this.uploadedUsage && mine !== "{}") {
          await sync.putUsage(client, this.store.data.agentUsage ?? {});
          this.uploadedUsage = mine;
        }
        this.othersUsage = await sync.readOtherUsage(client);
        const pageUse = JSON.stringify(this.myPageUse());
        if (pageUse !== this.uploadedPageUse && pageUse !== "{}" && !isDemoMode()) {
          await sync.putPageUse(client, this.myPageUse());
          this.uploadedPageUse = pageUse;
        }
        this.othersPageUse = await sync.readOtherPageUse<Record<string, KbPageUse>>(client);
        this.workSyncAt = Date.now();
        this.workSyncError = undefined;
        if (goals.changed || tickets.changed || shared || facts) this.changed();
      } catch (e) {
        this.workSyncError = safeError(e);
      } finally {
        this.workSyncing = false;
      }
    }
    // A run that stopped reporting (closed laptop, crash) frees its ticket.
    for (const t of live(this.store.data.workTickets)) {
      if (t.status !== "in_progress") continue;
      if (t.claim?.client === client) {
        if (this.store.data.tasks.some((x) => x.id === t.taskId && active(x))) continue;
      } else if (t.claim && (sync ? this.claimAlive(t.id, t.claim.seenAt, now) : claimIsFresh(t, now))) continue;
      this.putTicket({
        ...withComment(t, "sshS3", `The run by ${t.claim?.by ?? "somebody"} stopped reporting; the ticket is free again.`),
        status: "todo",
        claim: undefined,
      });
    }
    if (this.store.data.preferences.workforceAutopilot !== true) return;
    const tickets = live(this.store.data.workTickets);
    if (tickets.some((t) => t.status === "in_progress" && t.claim?.client === client)) return;
    const next = nextForHeartbeat({
      tickets,
      agents: this.getAgentsList(),
      usage: this.usageTotal(),
      runners: (this.store.data.externalRunners ?? []).map((r) => r.id),
      client,
      now,
    });
    if (next)
      await this.startTicket(next.id).catch((e) =>
        log.warn("Heartbeat could not start a ticket", safeError(e)),
      );
  }

  /**
   * Creates a template's team (with its reporting lines), goal and first tickets. An agent of the
   * same name that is already there is used as it is and not made a second time: agents are looked
   * up by name, and two of one name would make which one is found a matter of order. Returns the
   * names of the agents that were kept.
   */
  private async applyWorkforceTemplate(templateId: string, goalTitle?: string): Promise<string[]> {
    const template = WORKFORCE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new Error("Unknown workforce template");
    const now = Date.now();
    const actor = await this.resolveActorName();
    const sameName = (name: string): MissionAgent | undefined =>
      this.getAgentsList().find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
    const there = new Map(template.team.flatMap((r) => (sameName(r.name) ? [[r.key, sameName(r.name)!] as const] : [])));
    const ids = new Map(
      template.team.map((r) => [r.key, there.get(r.key)?.id ?? `wf-${template.id}-${r.key}-${crypto.randomUUID().slice(0, 6)}`]),
    );
    const agents: MissionAgent[] = template.team.filter((r) => !there.has(r.key)).map((r) => ({
      id: ids.get(r.key)!,
      name: r.name,
      role: r.role,
      icon: "",
      mission: r.mission,
      systemPrompt: r.systemPrompt,
      defaultMode: r.defaultMode,
      reportsTo: r.reportsTo ? ids.get(r.reportsTo) : undefined,
      allowedTools: ["all"],
      enabled: true,
      author: actor,
      updatedAt: now,
    }));
    this.store.data.agents = [...(this.store.data.agents ?? []), ...agents];
    if (isDemoMode()) for (const a of agents) saveDemoAgent(a);
    const goalId = crypto.randomUUID();
    this.putGoal({
      id: goalId,
      title: clip(goalTitle?.trim() || template.goal.title, 200),
      description: template.goal.description,
      status: "active",
      author: actor,
      createdAt: now,
      updatedAt: now,
    });
    template.tickets.forEach((t, i) => {
      const agent = agents.find((a) => a.id === ids.get(t.role)) ?? there.get(t.role);
      this.putTicket({
        id: `t-${crypto.randomUUID().slice(0, 8)}`,
        title: t.title,
        description: t.description,
        goalId,
        status: t.status,
        assigneeAgentId: agent?.id,
        assigneeName: agent?.name,
        createdBy: actor,
        createdAt: now + i,
        updatedAt: now + i,
      });
    });
    if (agents.length) this.lastWorkSync = 0;
    return [...there.values()].map((a) => a.name);
  }

  private notify(title: string, body: string): void {
    // Absent where there is no desktop to notify (the web server's Electron stand-in).
    if (Notification?.isSupported?.()) {
      const notification = new Notification({
        title: `sshs3 · ${title}`,
        body: clip(body, 160),
      });
      notification.on("click", this.host.show);
      notification.show();
    }
  }
  private async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      if (!(await this.config.getView()).enabled) return;
      const now = Date.now();
      void (async () => {
        await this.recoverUnreadSessions(now);
        await this.maybeLearnFromOwnActivity(now);
        await this.queueTeamActivity(now);
        await this.readLearningQueue(now);
      })().catch((e) => log.warn("Learning failed", safeError(e)));
      void this.workTick(now).catch((e) => log.warn("Board tick failed", safeError(e)));
      if (now - this.lastAnchorAt > 10 * 60_000) {
        this.lastAnchorAt = now;
        void this.audit()
          .anchor(now)
          .catch((e) => log.warn("Could not anchor the audit log in the team bucket", safeError(e)));
      }
      // Recordings are this computer's own: each installation removes its old ones, once a day,
      // whichever installation does the team's nightly upkeep.
      if (now - this.lastRecordingPruneAt > 24 * 3600_000) {
        this.lastRecordingPruneAt = now;
        void this.recordings()
          .prune(this.store.data.preferences.retentionDays || 30, now)
          .catch((e) => log.warn("Removing old recordings failed", safeError(e)));
      }
      void this.readNextKb(now).catch((e) => log.warn("Knowledge base reading failed", safeError(e)));
      void this.nightly(now).catch((e) => log.warn("Nightly upkeep failed", safeError(e)));
      void this.flushInbox(now).catch((e) => log.warn("Notifications failed", safeError(e)));
      void this.factsTick(now).catch((e) => log.warn("Reading server facts failed", safeError(e)));
      let historyChanged = false;
      for (const session of this.terminals.list()) {
        const text = this.terminals.context(session.id);
        if (!text) continue;
        const sourceId = "terminal:" + session.id;
        const existingIdx = this.store.data.history.findIndex(
          (source) => source.id === sourceId,
        );
        if (existingIdx >= 0) {
          if (this.store.data.history[existingIdx].text !== text) {
            historyChanged = true;
            this.store.data.history[existingIdx] = {
              id: sourceId,
              label: session.label,
              text,
              observedAt: now,
            };
          }
        } else {
          historyChanged = true;
          this.store.data.history.push({
            id: sourceId,
            label: session.label,
            text,
            observedAt: now,
          });
        }
      }
      if (historyChanged) this.changed();
      if (
        this.store.data.preferences.inventory &&
        now - this.lastInventory > 300_000
      ) {
        this.lastInventory = now;
        const previous = new Map(
          this.store.data.inventory.map((entry) => [entry.id, entry.status]),
        );
        await this.context.inventory(true);
        for (const entry of this.store.data.inventory)
          if (
            entry.status === "unreachable" &&
            previous.get(entry.id) === "reachable"
          )
            this.notify("Endpoint became unreachable", entry.label);
        this.changed();
      }
      // Missed means the app was not there when it fell due: a job that fell due while the previous pass
      // was still busy (an inventory probe on a VPN that is down, a slow SSH open) is late, and runs.
      const previousLoop = this.lastScheduleLoopAt || now;
      this.lastScheduleLoopAt = now;
      for (const schedule of this.store.data.schedules) {
        if (!schedule.enabled || schedule.nextRunAt > now) continue;
        const dueAt = schedule.nextRunAt;
        const overdue = now - dueAt;
        schedule.nextRunAt = now + schedule.intervalMinutes * 60_000;
        if (overdue > 60_000 && dueAt < previousLoop - 60_000) {
          schedule.lastStatus = "Missed while unavailable; not replayed.";
          this.changed();
          continue;
        }
        if (
          schedule.lastTaskId &&
          this.store.data.tasks.some(
            (t) => t.id === schedule.lastTaskId && active(t),
          )
        ) {
          schedule.lastStatus = "Skipped: previous run still active";
          this.changed();
          continue;
        }
        let opened: string | undefined;
        try {
          const id = await this.openUnattendedTerminal(schedule, `Schedule: ${schedule.title}`);
          opened = id;
          const task = await this.start(
            {
              prompt: schedule.prompt,
              sessionId: id,
              mode: schedule.mode,
              maxCommands: schedule.maxCommands,
              maxMinutes: schedule.maxMinutes,
            },
            schedule,
          );
          task.ownTerminal = { via: "schedule", profileId: schedule.profileId, shell: schedule.shell, label: `Schedule: ${schedule.title}` };
          schedule.lastTaskId = task.id;
          schedule.lastStatus = "Running";
          this.scheduleSessions.set(task.id, id);
          opened = undefined;
        } catch (e) {
          schedule.lastStatus = `Blocked: ${safeError(e)}`;
          this.notify("Scheduled task blocked", schedule.title);
          // A run that never started leaves no terminal behind.
          if (opened) this.host.closeSession?.(opened);
        }
        this.changed();
      }
    } finally {
      this.ticking = false;
    }
  }

  private async resolveActorName(): Promise<string> {
    try {
      const view = await this.config.getView();
      if (view.actorName?.trim()) return view.actorName.trim();
      if (this.host.defaultActorName?.trim())
        return this.host.defaultActorName.trim();
      if (view.codexAccountEmail?.trim())
        return view.codexAccountEmail.split("@")[0];
    } catch {
      if (this.host.defaultActorName?.trim())
        return this.host.defaultActorName.trim();
    }
    try {
      const teamData = await this.host.getTeamWorkspaceData?.();
      if (teamData?.actor?.trim()) return teamData.actor.trim();
    } catch {
      // Fallback below
    }
    if (this.host.defaultActorName?.trim())
      return this.host.defaultActorName.trim();
    try {
      return os.userInfo().username || "user";
    } catch {
      return "user";
    }
  }

  private applyLocalOverride(override: LocalServerAuthOverride): void {
    this.store.data.localOverrides ??= {};
    const username = override.username?.trim() || undefined;
    const privateKeyPath = override.privateKeyPath?.trim() || undefined;
    const authType = override.authType;
    if (!username && !privateKeyPath && !authType) {
      delete this.store.data.localOverrides[override.profileId];
    } else {
      this.store.data.localOverrides[override.profileId] = {
        profileId: override.profileId,
        ...(username ? { username } : {}),
        ...(privateKeyPath ? { privateKeyPath } : {}),
        ...(authType ? { authType } : {}),
      };
    }
  }

  private upsertLocalS3ServerCache(server: WorkspaceServerSummary): void {
    this.store.data.s3SyncedServers ??= [];
    this.store.data.deletedServerIds ??= {};
    delete this.store.data.deletedServerIds[server.id];
    const clean: WorkspaceServerSummary = {
      id: server.id,
      name: server.name,
      host: server.host,
      port: server.port || 22,
      username: server.username || "root",
      authType: server.authType,
      privateKeyPath: server.privateKeyPath,
      pkcs11LibPath: server.pkcs11LibPath,
      fido2Resident: server.fido2Resident,
      proxyJump: server.proxyJump,
      proxyJumpProfileId: server.proxyJumpProfileId,
      forwardAgent: server.forwardAgent,
      x11Forwarding: server.x11Forwarding,
      x11Display: server.x11Display,
      compression: server.compression,
      serverAliveInterval: server.serverAliveInterval,
      initialPath: server.initialPath,
      poolId: server.poolId,
      dotfilesSyncPolicy: server.dotfilesSyncPolicy,
      autoReconnect: server.autoReconnect,
      maxReconnectAttempts: server.maxReconnectAttempts,
      reconnectDelayMs: server.reconnectDelayMs,
      extraOptions: server.extraOptions,
      tunnels: server.tunnels,
      folder: server.folder,
      group: server.group,
      cluster: server.cluster,
      nodeRole: server.nodeRole,
      description: server.description,
      role: server.role,
      tags: server.tags,
      shared: true,
      updatedAt: server.updatedAt || new Date().toISOString(),
      updatedBy: server.updatedBy,
    };
    this.store.data.s3SyncedServers = [
      ...this.store.data.s3SyncedServers.filter((s) => s.id !== server.id),
      clean,
    ];
  }

  /** Saves a proposal as a team memory, or applies its update to the memory it names. */
  private async applyMemoryProposal(
    proposal: MemoryProposal,
    edited: { title?: string; text?: string } = {},
  ): Promise<MemoryEntry> {
    const title = edited.title?.trim() || proposal.title;
    const text = edited.text?.trim() || proposal.text;
    if (proposal.op === "update") {
      const target = this.store.data.memories.find(
        (m) => m.id === proposal.targetId,
      );
      if (!target)
        throw new Error(
          "The memory this proposal updates no longer exists; reject the proposal or save it as a new memory",
        );
      return this.saveMemoryInternal({
        id: target.id,
        kind: target.kind,
        tier: target.tier,
        cluster: target.cluster,
        scope: target.scope,
        title,
        text,
        supersede: true,
      });
    }
    return this.saveMemoryInternal({
      kind: proposal.kind,
      tier: "archival",
      scope: proposal.scope,
      title,
      text,
      autoLearned: true,
    });
  }

  /** The team's queue of records waiting to be read for memory, when a bucket is in use. */
  private queue(): LearningQueue | undefined {
    if (!this.s3Workspace.canUseBucket()) return undefined;
    this.learningQueue ??= new LearningQueue(this.s3Workspace.objects);
    return this.learningQueue;
  }

  /**
   * Hands a record over to be read for team memory. With a team bucket it is
   * uploaded to the shared queue at once and read later by whichever
   * teammate's app is running (this one included), so closing this computer
   * right after the work does not lose it. Without a bucket, or when the
   * upload fails, this app reads it itself now.
   */
  private async queueForLearning(
    source: DistillSource,
    query: string,
  ): Promise<void> {
    if (this.store.data.preferences.proposeMemories === false) return;
    if (isDemoMode()) return;
    const queued = this.store.data.queuedSourceIds ?? [];
    const seen = this.store.data.distilledSourceIds ?? [];
    if (queued.includes(source.id) || seen.includes(source.id)) return;
    const queue = this.queue();
    if (queue) {
      try {
        await queue.enqueue({
          v: 1,
          id: source.id,
          title: source.title,
          transcript: source.transcript,
          query: boundedContext(query, 600),
          actor: await this.resolveActorName(),
          createdAt: Date.now(),
          attempts: 0,
        });
        this.store.data.queuedSourceIds = [...queued, source.id].slice(-300);
        this.changed();
        return;
      } catch (error) {
        log.warn("Could not queue a record for learning", safeError(error));
      }
    }
    await this.proposeMemoriesFrom(source, query);
  }

  /**
   * Reads one record from the team's queue with this app's model. Called
   * from the periodic tick, at most every twenty seconds and one record at a
   * time. A record whose reading fails goes back for another app to try.
   */
  private async readLearningQueue(now = Date.now()): Promise<void> {
    if (this.readingQueue || now - this.lastQueueCheck < 20_000) return;
    if (this.store.data.preferences.proposeMemories === false) return;
    const queue = this.queue();
    if (!queue) return;
    this.lastQueueCheck = now;
    this.readingQueue = true;
    try {
      const claimed = await queue.claimNext(await this.resolveActorName(), now);
      if (!claimed) return;
      const { record } = claimed;
      const status = await this.proposeMemoriesFrom(
        {
          id: record.id,
          title: clip(`${record.title} (${record.actor})`, 200),
          transcript: boundedContext(record.transcript, 24_000),
        },
        record.query,
        { again: true },
      );
      // No status: another run of this app is reading the same record right now.
      if (status && !status.error) await queue.complete(claimed.name);
      else await queue.release(claimed);
    } finally {
      this.readingQueue = false;
    }
  }

  /**
   * Hands the team's activity over for learning: everyone's changes since the
   * shared cursor, as one record in the queue (ActivityBatcher). Any running
   * app does this, so a colleague's changes are handed over although their
   * computer is closed. Checked at most every five minutes.
   */
  private async queueTeamActivity(now = Date.now()): Promise<void> {
    if (now - this.lastActivityCheck < 5 * 60_000) return;
    if (this.store.data.preferences.proposeMemories === false) return;
    const queue = this.queue();
    if (!queue) return;
    this.lastActivityCheck = now;
    const cursorPath = "learn/activity-cursor.json";
    const objects = this.s3Workspace.objects;
    let cursor = firstActivityCursor(now);
    try {
      const raw = await objects.read(cursorPath);
      const stored = raw
        ? (JSON.parse(raw.toString("utf8")) as { through?: unknown }).through
        : undefined;
      if (typeof stored === "number" && Number.isFinite(stored)) cursor = stored;
    } catch {
      // An unreadable cursor is treated as none: the first one is written below.
    }
    const batch = nextActivityBatch(this.store.data.activityLog ?? [], cursor, now);
    if (!batch) return;
    if (batch.events.length > 0) {
      const clock = (at: number): string =>
        new Date(at).toISOString().slice(0, 16).replace("T", " ");
      await queue.enqueue({
        v: 1,
        id: batch.id,
        title: `Team activity ${clock(batch.from)} – ${clock(batch.through)} UTC`,
        transcript: activityTranscript(batch.events),
        query: boundedContext(
          batch.events
            .slice(-20)
            .map((e) => `${e.targetLabel} ${e.summary}`)
            .join(" "),
          600,
        ),
        actor: "team",
        // The same for every app that cuts this batch, so the record's name is too.
        createdAt: batch.through,
        attempts: 0,
      });
    }
    // Never move the cursor back: another app may have handed over further meanwhile.
    try {
      const raw = await objects.read(cursorPath);
      const latest = raw
        ? (JSON.parse(raw.toString("utf8")) as { through?: unknown }).through
        : undefined;
      if (typeof latest === "number" && latest >= batch.through) return;
    } catch {
      // Unreadable: write ours.
    }
    await objects.write(
      cursorPath,
      Buffer.from(JSON.stringify({ through: batch.through }), "utf8"),
    );
  }

  /**
   * Finished sessions that were never handed over for learning, because the
   * app was closed before it got to them, are handed over now. Once per start.
   */
  private async recoverUnreadSessions(now = Date.now()): Promise<void> {
    if (this.recoveredSessions) return;
    this.recoveredSessions = true;
    const recent = this.store.data.tasks
      .filter(
        (t) =>
          !isBackgroundRun(t) &&
          worthDistilling(t) &&
          now - t.updatedAt < 7 * 86_400_000,
      )
      .slice(-10);
    for (const task of recent)
      await this.queueForLearning(
        {
          id: `task:${task.id}`,
          title: `Session: ${task.title}`,
          transcript: taskTranscript(task),
        },
        `${task.title} ${task.target?.label ?? ""}`,
      );
  }

  /**
   * Reads this user's own recent activity for memories, at most every six
   * hours and only when enough has happened. Each teammate's app reads its own
   * user's activity, so a change is read once, not once per teammate.
   */
  private async maybeLearnFromOwnActivity(now = Date.now()): Promise<void> {
    if (this.store.data.preferences.proposeMemories === false) return;
    // With a team bucket the whole team's activity is handed over together (queueTeamActivity).
    if (this.queue()) return;
    const last = this.store.data.lastActivityDistillAt ?? 0;
    if (now - last < 6 * 3_600_000) return;
    const actor = (await this.resolveActorName()).trim().toLowerCase();
    const own = (this.store.data.activityLog ?? []).filter(
      (e) => e.at > last && e.actor.trim().toLowerCase() === actor,
    );
    if (own.length < 8) return;
    this.store.data.lastActivityDistillAt = now;
    const events = own.slice(-80);
    await this.queueForLearning(
      {
        id: `activity:${events.at(-1)!.id}`,
        title: "My recent activity",
        transcript: activityTranscript(events),
      },
      events
        .slice(-20)
        .map((e) => `${e.targetLabel} ${e.summary}`)
        .join(" "),
    );
  }

  /**
   * Has the model read one record and stores what it proposes to remember
   * (MemoryDistiller). A record is read once unless `again` is set. Proposals
   * stay local and unused until a person accepts them. The outcome, including
   * a failed or unusable model answer, is kept as `lastMemoryDistill`.
   */
  private async proposeMemoriesFrom(
    source: DistillSource,
    query: string,
    opts: { again?: boolean } = {},
  ): Promise<MemoryDistillStatus | undefined> {
    const seen = this.store.data.distilledSourceIds ?? [];
    if (this.distilling.has(source.id)) return undefined;
    if (!opts.again && seen.includes(source.id)) return undefined;
    if (isDemoMode()) return undefined; // the demo copilot is scripted, it reads nothing
    this.distilling.add(source.id);
    this.changed();
    const finish = (
      proposed: number,
      error?: string,
      pagesError?: string,
    ): MemoryDistillStatus => {
      const status: MemoryDistillStatus = {
        at: Date.now(),
        sourceTitle: clip(source.title, 160),
        proposed,
        ...(error ? { error } : {}),
        ...(pagesError ? { pagesError } : {}),
      };
      this.store.data.lastMemoryDistill = status;
      this.store.data.distilledSourceIds = [
        ...(this.store.data.distilledSourceIds ?? []).filter(
          (id) => id !== source.id,
        ),
        source.id,
      ].slice(-300);
      return status;
    };
    try {
      // Only team memory is compared and proposed: a personal note stays private.
      const shared = this.store.data.memories.filter(
        (m) => m.scope !== "personal",
      );
      const existing = this.kb.rankMemories(shared, query, undefined, 10);
      const task = await this.runBackground(
        {
          prompt: buildDistillPrompt(source, existing),
          mode: "advice",
          agentName: "Memory",
          maxCommands: 1,
          maxMinutes: 5,
        },
        {
          distillSourceId: source.id,
          title: `Memory · ${clip(source.title, 80)}`,
        },
      );
      const answer =
        task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
      if (task.status !== "completed")
        return finish(0, task.error ?? `The run ended as ${task.status}.`);
      const proposals = parseDistillAnswer(answer, source, existing);
      if (!proposals)
        return finish(0, "The model did not answer in the requested format.");
      const pending = this.store.data.memoryProposals ?? [];
      const fresh = proposals.filter(
        (p) =>
          !pending.some(
            (q) =>
              q.text === p.text ||
              (p.op === "update" &&
                q.op === "update" &&
                !q.appliedMemoryId &&
                q.targetId === p.targetId),
          ),
      );
      // The default: what the assistant learned is saved and shared at once,
      // so the team's memory grows without anyone tending it. Each entry stays
      // in the list as a record that can be undone.
      // Not everything: what would take the place of a memory a person wrote, and what comes from a
      // conversation in which nothing was run and shown (the assistant's own answer), waits in the
      // list for a person to accept.
      if (this.store.data.preferences.autoSaveMemories !== false && mayLearnUnreviewed(source))
        for (const proposal of fresh) {
          if (replacesPersonMemory(proposal, this.store.data.memories)) continue;
          const saved = await this.applyMemoryProposal(proposal).catch(
            (e) => {
              log.warn("Could not save a learned memory", safeError(e));
              return undefined;
            },
          );
          if (saved) proposal.appliedMemoryId = saved.id;
        }
      this.store.data.memoryProposals = [...pending, ...fresh].slice(
        -MAX_STORED_PROPOSALS,
      );
      // The same record may also belong on a page: what was confirmed about a
      // symptom or a procedure. `learnPagesFrom` decides whether the record
      // confirmed anything; a chat about nothing teaches no page.
      // A page that could not be written is said where the outcome of this reading is shown, not only
      // logged. It is not the reading's own failure: the record is not read again because of it.
      const pagesError = await this.learnPagesFrom(source).then(
        () => undefined,
        (e) => {
          log.warn("Could not add what was learned to the pages", safeError(e));
          return clip(safeError(e), 200);
        },
      );
      return finish(fresh.length, undefined, pagesError);
    } catch (error) {
      return finish(0, safeError(error));
    } finally {
      this.distilling.delete(source.id);
      this.changed();
    }
  }

  /**
   * The embedder for knowledge base search: the configured OpenAI-compatible
   * endpoint with an embedding model set. Other providers have no embeddings
   * endpoint, and demo documents are never sent anywhere; search is then
   * lexical.
   */
  private async kbEmbedder(): Promise<Embedder | undefined> {
    if (isDemoMode()) return undefined;
    const config = await this.config.getConfig().catch(() => undefined);
    if (
      !config?.enabled ||
      config.provider !== "openai-compatible" ||
      !config.baseUrl ||
      !config.embeddingModel
    )
      return undefined;
    return openAiCompatibleEmbedder({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey || undefined,
      model: config.embeddingModel,
    });
  }

  private appendActivityEvent(event: WorkspaceActivityEvent): void {
    this.store.data.activityLog ??= [];
    this.store.data.activityLog = [
      ...this.store.data.activityLog.filter((x) => x.id !== event.id),
      event,
    ].slice(-500);
  }

  private async recordTerminalCommandActivity(
    session: TerminalSession,
    commandLine: string,
    classified: DetectedCommandActivity,
  ): Promise<void> {
    try {
      const activeFailure = classified.resolvedFailure;
      const actor = await this.resolveActorName();
      const event: WorkspaceActivityEvent = {
        id: crypto.randomUUID(),
        at: Date.now(),
        actor,
        profileId: session.profileId,
        targetLabel: session.label,
        kind: classified.kind,
        summary: clip(classified.summary, 400),
        detail: boundedContext(commandLine, 1000),
      };
      this.appendActivityEvent(event);

      // Voyager Failure->Fix Self-Learning: if this session resolved a prior failure with exitCode 0, capture the recovery command
      if (activeFailure && activeFailure.command.trim() !== commandLine.trim()) {
        const res = this.selfLearning.learnFromCommandResolution({
          memories: this.store.data.memories,
          failure: activeFailure,
          fixCommand: commandLine,
          scope: `server:${session.label}`,
        });
        this.store.data.memories = res.memories;
        this.terminals.dismissFailure(session.id);
        // What a person happened to run next is a note on this computer, not a skill for the team:
        // nothing showed it was the fix. Only a proven fix (core) is shared.
        if (res.learnedSkill && res.learnedSkill.scope !== "personal" && res.learnedSkill.tier === "core") {
          await this.host.saveWorkspaceMemory?.(res.learnedSkill).catch(() => {});
        }
      }

      await this.host.recordWorkspaceActivity?.(event).catch(() => {});
      await this.syncAutoMemoryForTarget(session.profileId, session.label);
      this.s3Workspace.schedulePush();
      this.changed();
    } catch {
      // Never let activity logging disrupt terminal operation
    }
  }

  private async recordAgentChangeActivity(
    task: AgentTask,
    change: AgentChange,
    sessionId?: string,
  ): Promise<void> {
    try {
      const session = sessionId
        ? this.terminals.get(sessionId)
        : task.target
          ? this.terminals.get(task.target.sessionId)
          : undefined;
      // Only a command that is shown to have worked may be learned as the fix for a failure.
      // A change with its own check counts only when the check passed and had not passed before:
      // otherwise the "failure" before it is its own failed check, and the change is what broke it.
      const provenFix =
        change.kind === "command" &&
        change.exitCode === 0 &&
        // A plain command proves nothing about a failure before it; only a change whose own check showed it.
        Boolean(change.check && change.status === "completed" && change.check.after === true && change.check.before === false);
      const activeFailure =
        session && provenFix
          ? this.terminals.consumeResolvedFailure(session.id)
          : undefined;
      const actor = `${await this.resolveActorName()} (AI)`;
      const targetLabel = change.target || session?.label || task.title;
      const how = change.rollback?.ran
        ? change.rollback.restored === false
          ? "rolled back, not as it was"
          : "rolled back"
        : change.status === "completed"
          ? ""
          : change.status;
      const event: WorkspaceActivityEvent = {
        // Named after the change, so this computer's own Changes list shows it once, not twice.
        id: `change-${change.id}`,
        at: Date.now(),
        actor,
        profileId: session?.profileId,
        targetLabel,
        kind: change.kind === "file" ? "config-edit" : "command",
        summary: clip(
          `${change.description}${how ? ` (${how})` : change.exitCode !== undefined && change.exitCode !== 0 ? ` (exit ${change.exitCode})` : ""}`,
          400,
        ),
        detail: change.command
          ? boundedContext(change.command, 1000)
          : change.kind === "file"
            ? boundedContext(`File: ${change.target}`, 400)
            : undefined,
      };
      this.appendActivityEvent(event);

      // Voyager Failure->Fix Self-Learning: if an AI command succeeded on a session with a prior failure
      if (
        session &&
        activeFailure &&
        change.kind === "command" &&
        change.exitCode === 0 &&
        change.command &&
        activeFailure.command.trim() !== change.command.trim()
      ) {
        const res = this.selfLearning.learnFromCommandResolution({
          memories: this.store.data.memories,
          failure: activeFailure,
          fixCommand: change.command,
          fixOutput: change.output,
          scope: `server:${targetLabel}`,
          // Only reached for a proven fix (see provenFix above).
          proven: true,
        });
        this.store.data.memories = res.memories;
        this.terminals.dismissFailure(session.id);
        if (res.learnedSkill && res.learnedSkill.scope !== "personal") {
          await this.host.saveWorkspaceMemory?.(res.learnedSkill).catch(() => {});
        }
      }

      await this.host.recordWorkspaceActivity?.(event).catch(() => {});
      await this.syncAutoMemoryForTarget(session?.profileId, targetLabel);
      this.s3Workspace.schedulePush();
    } catch {
      // Non-fatal
    }
  }

  /**
   * Always-On Automatic Workspace Memory:
   * Whenever any user or AI modifies a node/cluster or runs notable commands on a target,
   * automatically keep a shared workspace memory entry up to date for that target.
   */
  private async syncAutoMemoryForTarget(
    profileId?: string,
    targetLabel?: string,
  ): Promise<void> {
    try {
      const key = (profileId || targetLabel || "").trim();
      if (!key) return;
      const extra = await this.collectExtraContext();
      const server = (extra.workspaceServers ?? []).find(
        (s) => s.id === profileId || s.name === targetLabel || s.id === key,
      );
      const displayName = server?.name || targetLabel || key;
      const recentEvents = (extra.activityLog ?? [])
        .filter(
          (a) =>
            (profileId && a.profileId === profileId) ||
            a.targetLabel === displayName ||
            a.targetLabel === targetLabel,
        )
        .slice(0, 6);

      const lines: string[] = [];
      if (server) {
        lines.push(
          `Server: ${server.name} (${server.username}@${server.host}:${server.port})`,
        );
        if (server.cluster) lines.push(`Cluster: ${server.cluster}`);
        if (server.nodeRole) lines.push(`Node role: ${server.nodeRole}`);
        if (server.role) lines.push(`Role: ${server.role}`);
        if (server.tags?.length)
          lines.push(`Tags: ${server.tags.join(", ")}`);
        if (server.description)
          lines.push(`Description: ${server.description}`);
      } else {
        lines.push(`Target: ${displayName}`);
      }
      if (recentEvents.length > 0) {
        lines.push("Latest recorded changes:");
        for (const evt of recentEvents) {
          lines.push(
            `- [${new Date(evt.at).toISOString()}] ${evt.actor} (${evt.kind}): ${evt.summary}${evt.detail ? ` — ${evt.detail}` : ""}`,
          );
        }
      }
      await this.saveMemoryInternal({
        id: `auto-node:${server?.id || key}`,
        kind: "memory",
        // The card of a server a person keeps to themselves stays with them too.
        scope: server?.shared === false ? "personal" : "workspace",
        title: `Server card: ${displayName}${server?.cluster ? ` (${server.cluster})` : ""}`,
        text: lines.join("\n"),
        author: "Auto-Memory",
      });
    } catch {
      // Never block main flow on auto-memory
    }
  }

  private async generateInlineSuggestion(
    prompt: string,
    sessionId?: string,
    context?: string,
    shell?: string,
  ): Promise<InlineCommandSuggestion> {
    const q = prompt.trim();
    const lower = q.toLowerCase();
    const session = sessionId ? this.terminals.get(sessionId) : undefined;
    const targetShell =
      shell ||
      session?.shell ||
      (process.platform === "win32" && session?.kind === "local"
        ? "powershell"
        : "bash");

    const dismissed = new Set(
      this.store.data.preferences.dismissedBuiltinIds ?? [],
    );
    const deletedMemoryIds = this.store.data.deletedMemoryIds ?? {};
    const candidateSkills: MemoryEntry[] = [
      ...this.store.data.memories.filter((m) => Boolean(m.sourceCommand)),
      ...getBuiltinSkillsAndMemories().filter(
        (m) =>
          Boolean(m.sourceCommand) &&
          !dismissed.has(m.id) &&
          (deletedMemoryIds[m.id] ?? 0) < (m.updatedAt ?? 0) &&
          !this.store.data.memories.some((x) => x.id === m.id),
      ),
    ];

    // Check Voyager Self-Learning & built-in skills first for POSIX shells, then fast heuristic fallback
    const learnedMatch =
      targetShell !== "cmd" &&
      targetShell !== "powershell" &&
      targetShell !== "pwsh"
        ? this.selfLearning.findBestLearnedCommand(
            // Only what applies here: a command saved for another server is not offered on this one.
            session
              ? [
                  ...scopedMemory(candidateSkills, `target:${session.profileId ?? session.id}`, true, {
                    targetLabel: session.label,
                    serverName: this.getKnownServers().find((s) => s.id === session.profileId)?.name,
                    serverHost: this.getKnownServers().find((s) => s.id === session.profileId)?.host,
                    cluster: this.getKnownServers().find((s) => s.id === session.profileId)?.cluster,
                  }),
                ]
              : candidateSkills.filter((m) => !/^(server|target|cluster):/.test(m.scope)),
            q,
          )
        : undefined;
    const fallback =
      learnedMatch ?? buildInstantCommandSuggestion(q, lower, targetShell);

    const sysPrompt = `You are an inline terminal command generator for ${targetShell}. Return ONLY a JSON object {"command":"...","explanation":"..."} with a single safe shell command matching the user's request and a 1-sentence explanation in the user's language.`;
    // What the person typed is masked and bounded like the output around it.
    const userPrompt = `Request: ${clip(q, 1000)}\n${context ? `Terminal output context:\n${boundedContext(context, 1500)}` : ""}`;

    try {
      const config = await this.config.getConfig();
      if (config.enabled) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), INLINE_SUGGEST_TIMEOUT_MS);
        try {
          let outputText = "";
          if (config.provider === "openai-codex") {
            const { CodexAuthProvider, buildCodexHeaders } = await import(
              "../CodexAuthProvider"
            );
            // The same sign-in a run would use: the workspace's own folder, and on the desktop app
            // the person's `codex login` too.
            const configDir =
              typeof this.config.codexAuthDir === "function"
                ? this.config.codexAuthDir()
                : undefined;
            const auth = new CodexAuthProvider(configDir);
            const creds = await auth.resolveCredentials();
            if (creds) {
              const baseUrl = (config.baseUrl || creds.baseUrl).replace(/\/$/, "");
              const resp = await fetch(`${baseUrl}/responses`, {
                method: "POST",
                headers: buildCodexHeaders(creds.accessToken, baseUrl),
                body: JSON.stringify({
                  model: config.model || creds.defaultModel || "gpt-6.1-sol",
                  // A reasoning model at its default effort takes 5 to 11 seconds for this; one command does not need it.
                  reasoning: { effort: "low" },
                  instructions: sysPrompt,
                  input: [
                    {
                      type: "message",
                      role: "user",
                      content: [{ type: "input_text", text: userPrompt }],
                    },
                  ],
                  store: false,
                  stream: true,
                }),
                signal: controller.signal,
              });
              if (resp.ok) {
                if (typeof resp.text === "function") {
                  outputText = extractResponseTextFromRaw(await resp.text());
                } else if (typeof resp.json === "function") {
                  outputText = extractResponseText(
                    (await resp.json()) as Record<string, unknown>,
                  );
                }
              }
            }
          } else if (config.provider === "openai-compatible" && config.baseUrl) {
            const baseUrl = config.baseUrl.replace(/\/$/, "");
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
            const resp = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: config.model || DEFAULT_AI_MODELS["openai-compatible"],
                messages: [
                  { role: "system", content: sysPrompt },
                  { role: "user", content: userPrompt },
                ],
                max_tokens: 400,
                temperature: 0.1,
                stream: false,
              }),
              signal: controller.signal,
            });
            if (resp.ok) {
              const json = (await resp.json()) as {
                choices?: Array<{ message?: { content?: string } }>;
              };
              outputText = json.choices?.[0]?.message?.content ?? "";
            }
          } else if (config.provider === "anthropic" && config.apiKey) {
            const base = (config.baseUrl || "https://api.anthropic.com").replace(
              /\/$/,
              "",
            );
            const endpoint = base.endsWith("/v1")
              ? `${base}/messages`
              : `${base}/v1/messages`;
            const resp = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": config.apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: config.model || DEFAULT_AI_MODELS.anthropic,
                max_tokens: 400,
                temperature: 0.1,
                system: sysPrompt,
                messages: [{ role: "user", content: userPrompt }],
              }),
              signal: controller.signal,
            });
            if (resp.ok) {
              const json = (await resp.json()) as {
                content?: Array<{ type?: string; text?: string }>;
              };
              outputText = (json.content ?? [])
                .filter((b) => typeof b.text === "string")
                .map((b) => b.text)
                .join("\n");
            }
          }
          const parsed = parseInlineCommandJson(outputText);
          if (parsed) {
            return {
              command: parsed.command,
              explanation: parsed.explanation,
              sessionId,
              createdAt: Date.now(),
              source: "model",
            };
          }
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch {
      // Fall back to instant deterministic command suggestion
    }

    // No model answered (none is connected, it took too long, or it did not give a command).
    return {
      ...fallback,
      sessionId,
      createdAt: Date.now(),
      source: learnedMatch ? "skill" : "fallback",
    };
  }

  /**
   * What an agent writes into memory during a run. It is saved at once only
   * when the workspace saves memories without review (the default) and it
   * does not overwrite something a person wrote; otherwise it becomes a
   * suggestion a person accepts or not, as the review switch promises. Its
   * author is the agent, so a person's note is never mistaken for one.
   */
  async rememberFromRun(
    task: AgentTask,
    input: { id?: string; kind: "memory" | "skill"; tier?: MemoryEntry["tier"]; cluster?: string; scope: string; title: string; text: string; sourceCommand?: string },
  ): Promise<{ entry?: MemoryEntry; proposal?: MemoryProposal }> {
    const memories = this.store.data.memories;
    const existing = input.id ? memories.find((m) => m.id === input.id) : undefined;
    const author = `${task.agentName ?? "Assistant"} (agent)`;
    const scope = /^(workspace|personal|(server|cluster|target):.+)$/.test(input.scope) ? input.scope : "workspace";
    const writtenByPerson = Boolean(existing && !existing.autoLearned && !/\(agent\)$|assistant|learner|learning|distill/i.test(existing.author ?? ""));
    if (this.store.data.preferences.autoSaveMemories === false || writtenByPerson) {
      const proposal: MemoryProposal = {
        id: crypto.randomUUID(),
        op: existing ? "update" : "add",
        ...(existing ? { targetId: existing.id, previousText: existing.text } : {}),
        kind: input.kind,
        scope,
        title: clip(input.title, 200),
        text: boundedContext(input.text, MAX_MEMORY_TEXT),
        evidence: writtenByPerson ? `Would change a memory ${existing!.author} wrote.` : "Written by an agent during a run.",
        sourceId: task.id,
        sourceTitle: clip(task.title, 160),
        createdAt: Date.now(),
      };
      this.store.data.memoryProposals = [...(this.store.data.memoryProposals ?? []), proposal].slice(-MAX_STORED_PROPOSALS);
      this.changed();
      return { proposal };
    }
    // An agent does not pin for the whole team: pinned (core) is a person's choice.
    // Saying something else about the same memory replaces it, and keeps what it said as history; adding to it does not.
    const supersede = Boolean(existing && !input.text.trim().startsWith(existing.text.trim()));
    const entry = await this.saveMemoryInternal({ ...input, scope, author, tier: input.tier === "core" ? "archival" : input.tier, supersede });
    return { entry };
  }

  private async saveMemoryInternal(input: {
    id?: string;
    kind: "memory" | "skill";
    tier?: "core" | "archival" | "episodic";
    cluster?: string;
    scope: string;
    title: string;
    text: string;
    author?: string;
    confidence?: number;
    autoLearned?: boolean;
    sourceCommand?: string;
    errorSignature?: string;
    /** A newer memory replaces the one it matches; the old one is kept as history. */
    supersede?: boolean;
  }): Promise<MemoryEntry> {
    const author = input.author?.trim() || (await this.resolveActorName());
    const { memories, saved, superseded } = this.kb.deduplicateOrMergeMemory(
      this.store.data.memories,
      {
        id: input.id,
        kind: input.kind,
        tier: input.tier,
        cluster: input.cluster?.trim() || undefined,
        scope: input.scope,
        title: clip(input.title, 200),
        text: boundedContext(input.text),
        author: clip(author, 80),
        confidence: input.confidence,
        autoLearned: input.autoLearned,
        sourceCommand: input.sourceCommand
          ? boundedContext(input.sourceCommand, 500)
          : undefined,
        errorSignature: input.errorSignature
          ? boundedContext(input.errorSignature, 160)
          : undefined,
        supersede: input.supersede,
      },
    );
    this.store.data.memories = memories;
    if (superseded && superseded.scope !== "personal")
      await this.host.saveWorkspaceMemory?.(superseded).catch(() => {});
    if (this.store.data.deletedMemoryIds?.[saved.id]) {
      delete this.store.data.deletedMemoryIds[saved.id];
    }
    if (saved.scope !== "personal") {
      await this.host.saveWorkspaceMemory?.(saved).catch(() => {});
      this.s3Workspace.schedulePush();
    }
    this.changed();
    return saved;
  }

  /**
   * Merges with the shared workspace file (HubStore.syncSharedFile): the preference, else
   * SSHS3_SHARED_WORKSPACE_FILE, resolved the same way HubStore does. A demo process only uses a file inside
   * its own data directory (the web server's file its demo users share, see WebTenantManager): a team share
   * anywhere else would hand the demo workspace to teammates (demo/outwardSync.ts).
   */
  private async syncSharedWorkspaceFile(
    localServers: WorkspaceServerSummary[],
  ): Promise<{ servers: WorkspaceServerSummary[]; changed: boolean }> {
    const sharedFile = (
      this.store.data.preferences.sharedWorkspacePath ||
      process.env.SSHS3_SHARED_WORKSPACE_FILE ||
      ""
    ).trim();
    if (!sharedFile || (isDemoMode() && !insideDataDirectory(sharedFile)))
      return { servers: localServers, changed: false };
    return this.store.syncSharedFile(sharedFile, localServers);
  }

  private async collectExtraContext(): Promise<ExtraWorkspaceContext> {
    const [rawWorkspaceServers, teamData] = await Promise.all([
      this.host.workspaceServers?.().catch(() => []) ?? Promise.resolve([]),
      this.host
        .getTeamWorkspaceData?.()
        .catch(() => ({ memories: [], activityLog: [] })) ??
        Promise.resolve({ memories: [], activityLog: [] }),
    ]);

    const sharedFileSync = await this.syncSharedWorkspaceFile(
      rawWorkspaceServers,
    ).catch(() => ({ servers: rawWorkspaceServers, changed: false }));

    const deletedServerIds = this.store.data.deletedServerIds ?? {};
    const localOverrides = this.store.data.localOverrides ?? {};
    const srvMap = new Map<string, WorkspaceServerSummary>();
    for (const s of this.store.data.s3SyncedServers ?? []) {
      if (s?.id && s.host) srvMap.set(s.id, { ...s, shared: true });
    }
    for (const s of sharedFileSync.servers) {
      if (!s?.id || !s.host) continue;
      const prev = srvMap.get(s.id);
      // A person's own server stays theirs: a team copy under the same id (sent by somebody who
      // learnt the id) neither re-points it nor makes it shared.
      if (s.shared === false) {
        srvMap.set(s.id, s);
        continue;
      }
      if (!prev) {
        srvMap.set(s.id, s);
      } else {
        const tPrev = Date.parse(prev.updatedAt || "") || 0;
        const tNext = Date.parse(s.updatedAt || "") || 0;
        if (tNext >= tPrev) {
          srvMap.set(s.id, { ...prev, ...s, shared: prev.shared || s.shared });
        }
      }
    }

    const workspaceServers: WorkspaceServerSummary[] = [];
    for (const srv of srvMap.values()) {
      const delIso = deletedServerIds[srv.id] || srv.deletedAt;
      const delMs =
        typeof delIso === "number"
          ? delIso
          : typeof delIso === "string"
            ? Number(delIso) || Date.parse(delIso) || 0
            : 0;
      const updMs = srv.updatedAt
        ? Number(srv.updatedAt) || Date.parse(srv.updatedAt) || 0
        : 0;
      // A removal is of the team's copy. A person's own server is not hidden by what a teammate removed.
      if (srv.shared !== false && delMs > 0 && delMs >= updMs) {
        continue;
      }
      const ov = localOverrides[srv.id];
      workspaceServers.push({
        ...srv,
        ...(ov?.username ? { localUsername: ov.username } : {}),
        ...(ov?.privateKeyPath
          ? { localPrivateKeyPath: ov.privateKeyPath }
          : {}),
        ...(ov?.authType ? { localAuthType: ov.authType } : {}),
      });
    }
    this.cachedWorkspaceServers = workspaceServers;

    const deletedMemoryIds = this.store.data.deletedMemoryIds ?? {};
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    const memoryMap = new Map<string, MemoryEntry>();
    for (const m of this.store.data.memories) {
      if ((deletedMemoryIds[m.id] ?? 0) < (m.updatedAt ?? 0)) {
        memoryMap.set(m.id, m);
      }
    }
    for (const m of teamData.memories) {
      if ((deletedMemoryIds[m.id] ?? 0) >= (m.updatedAt ?? 0)) continue;
      const existing = memoryMap.get(m.id);
      if (!existing) {
        memoryMap.set(m.id, m);
      } else if (m.updatedAt > existing.updatedAt) {
        memoryMap.set(m.id, { ...existing, ...m });
      } else {
        memoryMap.set(m.id, { ...m, ...existing });
      }
    }
    for (const m of getBuiltinSkillsAndMemories()) {
      if (dismissed.has(m.id)) continue;
      if ((deletedMemoryIds[m.id] ?? 0) >= (m.updatedAt ?? 0)) continue;
      if (!memoryMap.has(m.id)) {
        memoryMap.set(m.id, m);
      }
    }
    const activityMap = new Map<string, WorkspaceActivityEvent>();
    for (const a of this.store.data.activityLog ?? []) activityMap.set(a.id, a);
    for (const a of teamData.activityLog) activityMap.set(a.id, a);
    const activityLog = Array.from(activityMap.values())
      .sort((a, b) => b.at - a.at)
      .slice(0, 200);

    // Ensure Always-On Workspace Memory includes live cluster & node summaries automatically
    for (const srv of workspaceServers) {
      const autoId = `auto-node:${srv.id}`;
      if (!memoryMap.has(autoId)) {
        const srvEvents = activityLog
          .filter((a) => a.profileId === srv.id || a.targetLabel === srv.name)
          .slice(0, 4);
        const lines: string[] = [
          `Server: ${srv.name} (${srv.username}@${srv.host}:${srv.port})`,
          ...(srv.cluster ? [`Cluster: ${srv.cluster}`] : []),
          ...(srv.nodeRole ? [`Node role: ${srv.nodeRole}`] : []),
          ...(srv.role ? [`Role: ${srv.role}`] : []),
          ...(srv.tags?.length ? [`Tags: ${srv.tags.join(", ")}`] : []),
          ...(srv.description ? [`Description: ${srv.description}`] : []),
          ...(srvEvents.length
            ? [
                "Latest activity:",
                ...srvEvents.map(
                  (e) =>
                    `- [${new Date(e.at).toISOString()}] ${e.actor}: ${e.summary}`,
                ),
              ]
            : []),
        ];
        memoryMap.set(autoId, {
          id: autoId,
          kind: "memory",
          scope: "workspace",
          title: `Server card: ${srv.name}${srv.cluster ? ` (${srv.cluster})` : ""}`,
          text: lines.join("\n"),
          author: "Auto-Memory",
          updatedAt: srv.updatedAt ? Date.parse(srv.updatedAt) || Date.now() : Date.now(),
        });
      }
    }

    const memories = Array.from(memoryMap.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );

    const [appExtra, aiCfg] = await Promise.all([
      this.host.extraAppContext?.().catch(() => undefined),
      this.config.getView().catch(() => undefined),
    ]);

    const hostSnippets = appExtra?.snippets ?? [];
    const snippets =
      hostSnippets.length > 0
        ? hostSnippets
        : getBuiltinSnippets().filter((s) => !dismissed.has(s.id));

    return {
      workspaceServers,
      memories,
      activityLog,
      folders: appExtra?.folders ?? [],
      s3Profiles: appExtra?.s3Profiles ?? [],
      s3TeamWorkspace: this.s3Workspace.getStatus(),
      schedules: this.store.data.schedules ?? [],
      snippets,
      dotfilesPools: appExtra?.dotfilesPools ?? [],
      dirSyncProfiles: appExtra?.dirSyncProfiles ?? [],
      activeTunnels: appExtra?.activeTunnels ?? [],
      agents: this.getAgentsList(),
      mcpServers: this.mcpServersShown(),
      kbDocuments: this.getKbDocumentsList(),
      kbPages: this.pagesWithUse(),
      infraEdges: this.getInfraEdgesList(),
      recentServerChanges: this.recentServerChanges(48 * 3_600_000),
      serverFactsNow: this.serverFactsNow(),
      workforceRuns: this.getWorkforceRunsList(),
      terminalContextChars: aiCfg?.terminalContextChars ?? 8000,
      appSettings: {
        ...(appExtra?.appSettings ?? {}),
        aiPreferences: this.store.data.preferences,
        aiConfig: aiCfg,
      },
    };
  }

  private getKnownServers(): WorkspaceServerSummary[] {
    const map = new Map<string, WorkspaceServerSummary>();
    for (const s of isDemoMode() ? getDemoServers() : []) {
      if (s?.id) map.set(s.id, s);
    }
    for (const s of this.store.data.s3SyncedServers ?? []) {
      if (s?.id) map.set(s.id, s);
    }
    for (const s of this.cachedWorkspaceServers) {
      if (s?.id) map.set(s.id, s);
    }
    return Array.from(map.values());
  }

  private async resolveServerTarget(
    query?: string,
  ): Promise<WorkspaceServerSummary | undefined> {
    if (!query || !query.trim()) return undefined;
    const q = query.trim().toLowerCase();
    const extra = await this.collectExtraContext();
    const servers = extra.workspaceServers ?? [];
    return (
      servers.find((s) => s.id.toLowerCase() === q) ||
      servers.find((s) => s.name.toLowerCase() === q) ||
      servers.find((s) => s.host.toLowerCase() === q) ||
      servers.find(
        (s) =>
          s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q),
      )
    );
  }

  /**
   * Whether a tool's target reference (an id, or the server name or host the model gave instead) is one
   * of the demo workspace's fixtures. Identity decides (isDemoTarget): a name or host only counts through
   * the server it resolves to.
   */
  private async isDemoTargetRef(ref: string | undefined): Promise<boolean> {
    if (!ref || !isDemoMode()) return false;
    return isDemoTarget(ref) || isDemoTarget((await this.resolveServerTarget(ref))?.id);
  }

  /**
   * What the agent tool handlers in AppActions.ts may use of the hub: the one
   * place that says which hub internals a tool call can reach.
   */
  appActionHost() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the accessor below needs the hub
    const hub = this;
    return {
      store: this.store,
      host: this.host,
      terminals: this.terminals,
      config: this.config,
      mcp: this.mcp,
      kb: this.kb,
      embeddings: this.embeddings,
      s3Workspace: this.s3Workspace,
      get pendingLayoutEvent(): WorkspaceLayoutEvent | undefined {
        return hub.pendingLayoutEvent;
      },
      set pendingLayoutEvent(event: WorkspaceLayoutEvent | undefined) {
        hub.pendingLayoutEvent = event;
      },
      request: this.request.bind(this),
      changed: this.changed.bind(this),
      closeWhenRunEnds: this.closeWhenRunEnds.bind(this),
      getMcpServersList: this.getMcpServersList.bind(this),
      getKbDocumentsList: this.getKbDocumentsList.bind(this),
      getAgentsList: this.getAgentsList.bind(this),
      getWorkforceRunsList: this.getWorkforceRunsList.bind(this),
      getInfraEdgesList: this.getInfraEdgesList.bind(this),
      collectExtraContext: this.collectExtraContext.bind(this),
      resolveServerTarget: this.resolveServerTarget.bind(this),
      isDemoTargetRef: this.isDemoTargetRef.bind(this),
      saveMemoryInternal: this.saveMemoryInternal.bind(this),
      rememberFromRun: this.rememberFromRun.bind(this),
      resolveActorName: this.resolveActorName.bind(this),
      recordAgentChangeActivity: this.recordAgentChangeActivity.bind(this),
      kbEmbedder: this.kbEmbedder.bind(this),
      beginWorkforceRun: this.beginWorkforceRun.bind(this),
      investigate: this.investigate.bind(this),
      reviewPlan: this.reviewPlan.bind(this),
      saveTicketFrom: this.saveTicketFrom.bind(this),
      notePageOpened: this.notePageOpened.bind(this),
      noteKbGap: this.noteKbGap.bind(this),
      pagesWithUse: this.pagesWithUse.bind(this),
      commentTicket: (id: string, author: string, text: string): void =>
        this.putTicket(withComment(this.ticket(id), author, text)),
    };
  }

  async recordServerDeleted(id: string): Promise<void> {
    const trimmed = id?.trim();
    if (!trimmed) return;
    await this.initialize().catch(() => {});
    const nowIso = new Date().toISOString();
    this.store.data.deletedServerIds = {
      ...(this.store.data.deletedServerIds ?? {}),
      [trimmed]: nowIso,
    };
    this.store.data.s3SyncedServers = (
      this.store.data.s3SyncedServers ?? []
    ).filter((s) => s.id !== trimmed);
    const rawWorkspaceServers =
      (await this.host.workspaceServers?.().catch(() => [])) ?? [];
    await this.syncSharedWorkspaceFile(rawWorkspaceServers).catch(() => {});
    await this.store.save().catch(() => {});
    this.s3Workspace.schedulePush(400);
    this.changed();
  }

  async recordServerSaved(id: string, shared?: boolean): Promise<void> {
    const trimmed = id?.trim();
    if (!trimmed) return;
    await this.initialize().catch(() => {});
    // Made personal: it is no longer pushed as the team's (it used to come straight back as shared).
    if (shared === false)
      this.store.data.s3SyncedServers = (this.store.data.s3SyncedServers ?? []).filter((s) => s.id !== trimmed);
    if (this.store.data.deletedServerIds?.[trimmed]) {
      const next = { ...this.store.data.deletedServerIds };
      delete next[trimmed];
      this.store.data.deletedServerIds = next;
    }
    const rawWorkspaceServers =
      (await this.host.workspaceServers?.().catch(() => [])) ?? [];
    await this.syncSharedWorkspaceFile(rawWorkspaceServers).catch(() => {});
    await this.store.save().catch(() => {});
    this.s3Workspace.schedulePush(400);
    this.changed();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.tickTimer);
    clearTimeout(this.saveTimer);
    powerMonitor?.removeListener("suspend", this.suspend);
    powerMonitor?.removeListener("resume", this.resume);
    await Promise.all(
      this.store.data.tasks
        .filter(active)
        .map((t) => this.stop(t, "Application shutting down")),
    );
    await this.localMcp?.stop();
    await this.recorder?.stopAll().catch(() => undefined);
    await this.s3Workspace.dispose();
    await this.broker.dispose();
    this.terminals.dispose();
    // A document being read, or facts being collected, writes into the hub's folder when it
    // ends. A hub that has been disposed of must have stopped writing before it says so.
    for (let i = 0; i < 100 && (this.kbReadingId || this.factsRound); i++)
      await new Promise((r) => setTimeout(r, 20));
    await this.factsRound?.catch(() => undefined);
    if (this.initialized) await this.store.save();
  }
}
/** Whether `file` lies inside this process's data directory (userData: in demo mode, the demo workspace). */
export const MAX_INVESTIGATIONS = 4;

function investigatorPrompt(
  question: string,
  scope: string | undefined,
  job: string,
): string {
  return [
    "You are an investigator working for another agent on one question. Find the answer, read-only, and report it. You do not fix anything.",
    `The job this is part of: ${boundedContext(job, 300)}`,
    `Your question: ${boundedContext(question, 2000)}`,
    ...(scope ? [`Where to look: ${boundedContext(scope, 500)}`] : []),
    "",
    "Use `workspace_context` (team activity, servers, team memory), `sshs3_kb_search` (runbooks) and `sshs3_storage_ops` (list and read files and logs on the servers, diff a file between two servers). Whether you can also run read-only commands is said at the end.",
    "Report: first the answer in one or two sentences; then the evidence, each item with its source (server and file with the relevant lines, activity entry with who and when, runbook title); then what you could not determine from here. Do not go beyond the evidence, and do not answer a different question.",
  ].join("\n");
}

/** The workforce conversation's message: per-specialist status, then the combined result. */
export function renderWorkforceProgress(run: WorkforceRun): string {
  const done = run.steps.filter((s) => s.status === "completed").length;
  const failed = run.steps.filter((s) => s.status === "failed").length;
  const lines = run.steps.map((s) => {
    // Words, as everywhere else in the hub: a mark means nothing to a screen reader or a log.
    const mark = s.status === "completed" ? "done" : s.status === "failed" ? "failed" : s.status === "running" ? "running" : "waiting";
    const where = s.targetCluster ? ` (${s.targetCluster})` : "";
    const time =
      s.durationMs === undefined ? "" : ` — ${Math.round(s.durationMs / 1000)} s`;
    const problem = s.error ? ` — ${s.error}` : "";
    return `- **${s.agentName}**${where}: ${mark}${time}${problem}`;
  });
  const status = [
    `**Workforce** — ${done}/${run.steps.length} specialists finished${failed ? `, ${failed} failed` : ""}`,
    ...lines,
  ].join("\n");
  if (run.status === "running") return status;
  if (run.status === "failed")
    return `${status}\n\nThe run failed: ${run.error ?? "unknown error"}`;
  return `${run.synthesis}\n\n---\n${status}`;
}
