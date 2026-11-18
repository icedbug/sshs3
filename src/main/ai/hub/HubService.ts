import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app, powerMonitor } from "electron";
import type {
  AgentMode,
  AgentChange,
  AgentUsage,
  HubReply,
  KbPageUse,
  AgentTask,
  HubRequest,
  HubSnapshot,
  InlineCommandSuggestion,
  MemoryEntry,
  RunbookTemplate,
  TerminalSession,
  WorkspaceActivityEvent,
  WorkspaceLayoutEvent,
  WorkspacePresenceTerminal,
  WorkspaceRule,
  WorkspaceServerSummary,
  FactChange,
} from "../../../shared/types/aiHub";
import { CONTEXT_NOTE_PREFIX, SHELL_KINDS } from "../../../shared/types/aiHub";
import { DEFAULT_AI_MODELS } from "../../../shared/types/ai";
import { AiConfigStore } from "../AiConfigStore";
import { HermesManager } from "../HermesManager";
import { HubStore } from "./HubStore";
import { S3WorkspaceSyncService, mergeMemoryCopies } from "./S3WorkspaceSyncService";
import { McpClientManager } from "./McpClientManager";
import { KnowledgeBaseService } from "./KnowledgeBaseService";
import { SelfLearningService } from "./SelfLearningService";
import { analyzeCommandSafety } from "./CommandSafetyService";
import { EXTERNAL_RUNNER_PRESETS } from "./AcpRuntime";
import { withUse } from "./KbCompile";
import { guardUrl, hostOf, type GuardOptions } from "./Notifier";
import { NotifyStore } from "./NotifyStore";
import { AtlassianStore } from "./AtlassianStore";
import { AtlassianBridge } from "./AtlassianBridge";
import { ChatBridge } from "./ChatBridge";
import { FactsStore } from "./FactsStore";
import { Replay } from "./EvalSuite";
import { lintKnowledgeBase } from "./KbLint";
import { getBuiltinSkillsAndMemories, getDemoSchedules, getDemoTasks, getDemoWorkforceRuns, isDemoMode, mcpCatalog } from "./demoWorkspace";
import { TerminalRegistry, type DetectedCommandActivity } from "./TerminalRegistry";
import { ToolBroker } from "./ToolBroker";
import { type AgentRuntime } from "./AgentRuntime";
import { ContextService, scopedMemory } from "./ContextService";
import { AuditLog, AuditShipper } from "./AuditLog";
import { LocalMcpServer } from "./LocalMcpServer";
import { SessionRecorder } from "./SessionRecorder";
import { McpTokenStore } from "../../web/McpTokenStore";
import { boundedContext, boundedPrompt, clip, maskContext, safeError } from "./privacy";
import { LearningQueue } from "./LearningQueue";
import { WorkSync, type ConditionalQueueStore } from "./WorkSync";
import { withComment, live, templateSummaries } from "./WorkBoard";
import { EmbeddingIndex } from "./EmbeddingIndex";
import {
  requiredText,
  integer,
  extractResponseTextFromRaw,
  extractResponseText,
  parseInlineCommandJson,
  buildInstantCommandSuggestion,
} from "./hubHelpers";
import { worksOnItsOwn } from "./DirectAgentRuntime";
import { handleAppAction } from "./AppActions";
import type { HubHost } from "./hubHost";
import {
  log,
  taskForSnapshot,
  READ_ONLY_ACTIONS,
  checkedSuggestion,
  active,
  INLINE_SUGGEST_TIMEOUT_MS,
  RUN_STOP_GRACE_MS,
  isBackgroundRun,
} from "./hubShared";
import { areaOf, type AreaName, type Handled, type RequestsOf } from "./areas/routes";
import { mixParts } from "./areas/mix";
import { InboxPart } from "./areas/inbox";
import { ChatAndAtlassianPart } from "./areas/chatAndAtlassian";
import { FactsPart } from "./areas/facts";
import { AlertsPart } from "./areas/alerts";
import { SchedulesPart } from "./areas/schedules";
import { SimulationPart } from "./areas/simulation";
import { EvalsPart } from "./areas/evals";
import { AuditPart } from "./areas/audit";
import { McpPart } from "./areas/mcp";
import { AgentsPart } from "./areas/agents";
import { MemoryPart } from "./areas/memory";
import { KnowledgePart } from "./areas/knowledge";
import { SafetyPart } from "./areas/safety";
import { ServersPart } from "./areas/servers";
import { TicketsPart } from "./areas/tickets";
import { SharingPart } from "./areas/sharing";
import { RunsPart } from "./areas/runs";
// Declared in files of their own now; still exported from here, where others import them.
export type { HubHost } from "./hubHost";
export { changeForSnapshot, taskForSnapshot, incomingAgentForTesting, checkedSuggestionForTesting, withUnanswered, budgetStopLine, renderWorkforceProgress } from "./hubShared";

/** The Electron main process is the per-user background owner; renderer lifetimes confer no authority. */
/** The hub members the agent tool handlers use (see HubService.appActionHost). */
export type AppActionHost = ReturnType<HubService["appActionHost"]>;

/**
 * The hub: one object behind every AI request of one person.
 *
 * Its methods are kept in several files, one per area, in ./areas. Each of those is a class that is
 * never made into an object: its methods are put on this class at the end of this file (mixParts),
 * and the interface of the same name there tells the compiler that this class has them. What is
 * declared here is the hub's state, its start and its end, and the handing out of requests.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- one object, several files: see ./areas/mix
export class HubService {
  // On Windows the terminals run in a pseudo console that delivers a command's markers ahead of its text.
  readonly terminals = new TerminalRegistry({ lateOutput: process.platform === "win32" });
  readonly store: HubStore;
  readonly config: AiConfigStore;
  readonly context: ContextService;
  readonly broker: ToolBroker;
  readonly s3Workspace: S3WorkspaceSyncService;
  readonly mcp = new McpClientManager(fetch, (server) => this.assertMcpReach(server), {
    guardOptions: () => ({ ...this.outboundGuard(), allowPlainHttp: !this.sharedServer() }),
  });
  readonly kb = new KnowledgeBaseService();
  readonly selfLearning = new SelfLearningService(this.kb);
  runtimes = new Map<string, AgentRuntime>();
  launches = new Map<string, symbol>();
  /** Resolvers for callers waiting on a task's run to end (see whenSettled). */
  settleWaiters = new Map<string, Array<() => void>>();
  /** Workforce run id → the conversation task that shows it. */
  workforceLeads = new Map<string, string>();
  /** Records being read for memory proposals right now. */
  distilling = new Set<string>();
  readonly embeddings: EmbeddingIndex;
  learningQueue?: LearningQueue;
  workSyncStore?: WorkSync;
  lastWorkSync = 0;
  workSyncing = false;
  workSyncInFlight?: Promise<void>;
  workSyncPushTimer?: NodeJS.Timeout;
  workSyncAt?: number;
  workSyncError?: string;
  /** What other installations' runs have spent, as last read from the bucket. */
  othersUsage: Record<string, AgentUsage>[] = [];
  uploadedUsage = "";
  /** Recordings that answer the tool calls of test-case runs, by task id. */
  evalReplays = new Map<string, Replay>();
  evalRunningId?: string;
  kbReadingId?: string;
  kbRetryAt = 0;
  kbNeedsModel = false;
  /** Documents another installation is reading: left alone until this time. */
  kbSkipUntil = new Map<string, number>();
  readingQueue = false;
  lastQueueCheck = 0;
  lastActivityCheck = 0;
  recoveredSessions = false;
  initialized?: Promise<void>;
  private tickTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private lastInventory = 0;
  private previewId?: string;
  private pendingLayoutEvent?: WorkspaceLayoutEvent;
  cachedWorkspaceServers: WorkspaceServerSummary[] = [];
  private ticking = false;
  /** When the previous pass over the schedules began: a job that fell due after it is late, not missed. */
  private lastScheduleLoopAt = 0;
  /** For a recording that is being made: the recording its conversation pointed to before. */
  private readonly recordingBefore = new Map<string, string | undefined>();
  /** The terminal each scheduled run was given, so it is closed when the run ends. */
  readonly scheduleSessions = new Map<string, string>();
  /** Terminals the hub opened for a run while it ran (another server of the cluster, a ticket's target). */
  readonly runTerminals = new Map<string, Set<string>>();
  disposed = false;
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
    readonly host: HubHost,
    readonly directory = path.join(app.getPath("userData"), "ai-hub"),
  ) {
    this.store = new HubStore(path.join(directory, "hub.json"));
    this.notifyStore = new NotifyStore(path.join(directory, "notify.json"));
    this.atlassian = new AtlassianBridge(new AtlassianStore(path.join(directory, "atlassian.json")), {
      tickets: () => this.store.data.workTickets ?? [],
      putTicket: (ticket) => this.putTicket(ticket),
      ticketRuns: async (ticket) => Boolean(await this.ticketRunsNow(ticket)),
      once: async (key) => {
        const sync = this.work();
        return sync ? sync.markOnce(key, this.clientId(), this.notifySettle) : true;
      },
      guard: () => ({ ...this.outboundGuard(), ...(this.kbNetwork ? { lookup: this.kbNetwork.lookup } : {}) }),
      kbDocs: () => this.store.data.kbDocuments ?? [],
      ingest: (extracted, source) => this.ingestExtracted(extracted, source),
      persist: () => this.store.save(),
      record: (entry) =>
        void this.audit()
          .append({ kind: "integration", ...entry })
          .catch((e) => log.warn("Could not write the audit log", safeError(e))),
      changed: () => this.changed(),
    });
    this.chat =
      host.teamChat ??
      new ChatBridge(path.join(directory, "chat"), {
        guard: () => ({ ...this.outboundGuard(), ...(this.kbNetwork ? { lookup: this.kbNetwork.lookup } : {}) }),
      });
    this.stopChatListening = this.chat.onChange(() => this.changed());
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
      // Nobody sits at a ticket's or a schedule's run: what it waits for is told at once, not on the next look.
      asking: (task) => {
        if (worksOnItsOwn(task)) void this.flushInbox().catch((e) => log.warn("Notifications failed", safeError(e)));
      },
      waited: (task, ms) => {
        const armed = this.runTimers.get(task.id);
        if (armed) this.armRunTimer(task, armed.endsAt + ms);
      },
      // Told its budget is spent, the agent asked for more anyway: the run ends here.
      budgetSpent: (task) => void this.stop(task, "Command budget exhausted"),
      safetyContext: (task, targetLabel) =>
        this.resolveSafetyContext(task, targetLabel),
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
          // Which version of the team's copy an edit here started from: a removal made after it wins over the edit.
          for (const [id, base] of Object.entries(this.store.data.serverEditBase ?? {})) {
            const s = srvMap.get(id);
            if (s) srvMap.set(id, { ...s, baseAt: base });
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
            // This installation's own, lasting id: presence is one file per person and installation,
            // and an id made anew at every start would leave a file behind in the bucket each time.
            clientId: this.clientId(),
            servers: Array.from(srvMap.values()),
            memories: this.store.data.memories.filter(
              (m) => m.scope !== "personal",
            ),
            activityLog: this.store.data.activityLog ?? [],
            deletedServerIds,
            deletedMemoryIds: { ...(this.store.data.deletedMemoryIds ?? {}) },
            deletedServerBy: { ...(this.store.data.deletedServerBy ?? {}) },
            deletedMemoryBy: { ...(this.store.data.deletedMemoryBy ?? {}) },
            activeTerminals,
          };
        },
        applyMergedState: async (state) => {
          this.store.data.deletedServerIds = state.deletedServerIds;
          this.store.data.deletedMemoryIds = state.deletedMemoryIds;
          if (state.deletedServerBy) this.store.data.deletedServerBy = state.deletedServerBy;
          if (state.deletedMemoryBy) this.store.data.deletedMemoryBy = state.deletedMemoryBy;
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
    this.terminals.on(
      "reconnecting",
      (sessionId: string, grace: { attempt?: number; maxAttempts?: number; reason?: string }) => {
        const reason =
          grace?.reason ||
          `SSH connection lost; reconnecting (attempt ${grace?.attempt ?? 1}/${grace?.maxAttempts ?? 3})`;
        for (const task of this.store.data.tasks) {
          if (active(task) && task.target?.sessionId === sessionId) {
            void this.stop(task, reason);
          }
        }
      },
    );
    // A terminal an agent's run owns is recorded while it owns it: what the terminal
    // showed, masked, with a marker per command. What a person types is never recorded.
    this.terminals.on("claimed", (session: TerminalSession, owner: string) => {
      const task = this.store.data.tasks.find((t) => t.id === owner);
      if (!task || isBackgroundRun(task) || isDemoMode() || this.store.data.preferences.recordSessions === false) return;
      const recorder = this.recordings();
      recorder.setPolicy({ allowHumanOptIn: true });
      void recorder
        .start({ sessionId: session.id, taskId: task.id, label: session.label, ...this.terminals.size(session.id) })
        .then((info) => {
          // Kept, so that a recording in which nothing ran can give the conversation its earlier one back.
          if (task.recordingId !== info.id) this.recordingBefore.set(info.id, task.recordingId);
          task.recordingId = info.id;
          task.recordingIds = [...(task.recordingIds ?? []).filter((id) => id !== info.id), info.id];
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
            if (task) {
              if (task.recordingIds) {
                task.recordingIds = task.recordingIds.filter((id) => id !== info.id);
              }
              if (task.recordingId === info.id) {
                task.recordingId = before;
                this.changed();
              }
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
      await this.atlassian.store.load();
      await this.chat.load();
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
      }, 10_000);
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

  /**
   * Remembers that the user deleted one of `builtins` (this mode's), so it stays hidden until
   * restore-builtins. Any other id is the user's own item, which the delete already removed.
   */
  markBuiltinDismissed(id: string, builtins: readonly { id: string }[]): void {
    if (!builtins.some((b) => b.id === id)) return;
    const list = this.store.data.preferences.dismissedBuiltinIds ?? [];
    if (!list.includes(id)) {
      this.store.data.preferences.dismissedBuiltinIds = [...list, id];
    }
  }

  /** What this hub last told the server about its own changes waiting for a second person. */
  private peerWaitingTold = "";

  storeDataExtra(): {
    inboxState?: Record<string, { snoozedUntil?: number; acknowledgedAt?: number }>;
    workforcePaused?: boolean;
    runbooks?: RunbookTemplate[];
    rules?: WorkspaceRule[];
  } {
    return this.store.data as unknown as {
      inboxState?: Record<string, { snoozedUntil?: number; acknowledgedAt?: number }>;
      workforcePaused?: boolean;
      runbooks?: RunbookTemplate[];
      rules?: WorkspaceRule[];
    };
  }

  /**
   * The model's address is called on every run with the person's prompt and key. On a shared server it
   * is held to the same rule as any other address a user gives: not the server itself, not its private
   * network (unless the administrator allows it). Asked when it is set and again when a run starts.
   */
  async assertModelEndpointReach(baseUrl: string | undefined): Promise<void> {
    if (!baseUrl || !this.sharedServer()) return;
    await guardUrl(baseUrl, { ...this.outboundGuard(), allowPlainHttp: true, ...(this.kbNetwork ? { lookup: this.kbNetwork.lookup } : {}) });
  }

  // ---- the demo lab's simulation ----------------------------------------------

  simulation?: { startedAt: number; ticketId?: string; servers: string[]; pageId?: string };

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
      // The tool log is for the model's next run; the UI shows changes and messages. A long conversation
      // is sent by its last messages only: the window that shows it asks for all of it (task-read).
      tasks: allTasks.map(taskForSnapshot),
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
      // Other members' changes that wait for a second person, where the server passes them between accounts.
      ...(this.host.peerWaiting ? { peerApprovals: this.host.peerWaiting() } : {}),
      workBoardSync: {
        shared: Boolean(this.teamStore()),
        // Who it is shared with: everyone who has the team's bucket, or everyone with an account on this server.
        ...(this.teamStore() ? { via: this.s3Workspace.canUseBucket() ? ("bucket" as const) : ("server" as const) } : {}),
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
      ...(isDemoMode() ? { simulation: this.simulationView() } : {}),
      signsAs: await this.resolveActorName(),
      peerApprovalPossible: this.peerApprovalPossible(),
      chatSources: {
        connections: this.chat.view(),
        canChange: !this.sharedServer() || Boolean(this.host.teamAdmin?.()),
        retentionDays: this.chat.retentionDays,
        total: this.chat.index.total(),
      },
      atlassian: {
        jira: this.atlassian.view("jira"),
        confluence: this.atlassian.view("confluence"),
      },
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
      inboxState: this.storeDataExtra().inboxState ?? {},
      workforcePaused: Boolean(this.storeDataExtra().workforcePaused),
      runbooks: this.storeDataExtra().runbooks ?? [],
      rules: this.storeDataExtra().rules ?? [],
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

  /** Hands a request to the part of the hub it belongs to (./areas/routes). */
  private handleIn(area: Exclude<AreaName, "hub">, request: HubRequest): Promise<Handled> {
    switch (area) {
      case "inbox":
        return this.handleInbox(request as RequestsOf<"inbox">);
      case "chatAndAtlassian":
        return this.handleChatAndAtlassian(request as RequestsOf<"chatAndAtlassian">);
      case "facts":
        return this.handleFacts(request as RequestsOf<"facts">);
      case "alerts":
        return this.handleAlerts(request as RequestsOf<"alerts">);
      case "schedules":
        return this.handleSchedules(request as RequestsOf<"schedules">);
      case "simulation":
        return this.handleSimulation(request as RequestsOf<"simulation">);
      case "evals":
        return this.handleEvals(request as RequestsOf<"evals">);
      case "audit":
        return this.handleAudit(request as RequestsOf<"audit">);
      case "mcp":
        return this.handleMcp(request as RequestsOf<"mcp">);
      case "agents":
        return this.handleAgents(request as RequestsOf<"agents">);
      case "memory":
        return this.handleMemory(request as RequestsOf<"memory">);
      case "knowledge":
        return this.handleKnowledge(request as RequestsOf<"knowledge">);
      case "safety":
        return this.handleSafety(request as RequestsOf<"safety">);
      case "servers":
        return this.handleServers(request as RequestsOf<"servers">);
      case "tickets":
        return this.handleTickets(request as RequestsOf<"tickets">);
      case "sharing":
        return this.handleSharing(request as RequestsOf<"sharing">);
    }
  }

  async request(asked: HubRequest): Promise<HubSnapshot> {
    await this.initialize();
    // What this request returns beside the snapshot. Local to the call: requests overlap.
    let reply: HubReply | undefined;
    if (this.disposed) throw new Error("Application is shutting down");
    if (!asked || typeof asked.action !== "string")
      throw new Error("Invalid AI request");
    if (process.env.SSHS3_NATIVE_HERMES === '1' && ['start', 'reply', 'resume', 'schedule-save'].includes(asked.action))
      throw new Error('This installation uses native Hermes. Open the Hermes chat to start or schedule work.');
    // Each request belongs to one part of the hub, and that part answers it.
    const area = areaOf(asked.action);
    if (!area) throw new Error(`Unknown AI request: ${String(asked.action)}`);
    if (area !== "hub") {
      const handled = await this.handleIn(area, asked);
      if (handled.snapshot) return handled.snapshot;
      reply = handled.reply;
    } else {
    // The requests that are answered here still.
    const request = asked as RequestsOf<"hub">;
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
          if (p.recordSessions !== undefined) {
            next.recordSessions = p.recordSessions === true;
            this.recorder?.setPolicy({ allowHumanOptIn: next.recordSessions });
          }
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
            next.approvalWaitMinutes = integer(p.approvalWaitMinutes, 0, 10_080);
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
        // Asked again: the question that is already there, answered anew.
        const again = request.retry === true;
        if (again && active(task)) throw new Error("This conversation is still running. Stop it first, then ask again.");
        const asked = again ? task.messages.map((m) => m.role).lastIndexOf("user") : -1;
        if (again && asked < 0) throw new Error("There is no question here to ask again.");
        // A message is read from its start: what a person says first (or an approval's instruction) is kept.
        const text = again ? "" : clip(requiredText(rawText), 16_000);
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
          if (again) {
            // What followed the question was the answer being asked again: the new one takes its place.
            // The question is asked now, so what the earlier try ran (still in the tool log) comes
            // before it, and the model knows what was already done.
            task.messages.splice(asked + 1);
            task.messages[asked] = { ...task.messages[asked], at: Date.now() };
          } else
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
      case "task-read": {
        // Read as it is: a demo conversation that is only listed is not made a stored one by being looked at.
        const found =
          this.store.data.tasks.find((t) => t.id === request.taskId) ??
          (isDemoMode() ? getDemoTasks().find((t) => t.id === request.taskId) : undefined);
        if (!found) throw new Error("Task not found");
        reply = { task: { id: found.id, messages: found.messages, changes: found.changes } };
        break;
      }
      case "takeover":
        this.terminals.takeover(request.sessionId);
        break;
      case "arm":
        if (!SHELL_KINDS.includes(request.shell))
          throw new Error("Unsupported shell");
        await this.terminals.arm(request.sessionId, request.shell);
        break;
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
      case "ai-probe":
        reply = { probe: await this.probeModel(request.baseUrl?.trim() || undefined) };
        break;
      case "layout-event-ack": {
        if (this.pendingLayoutEvent?.id === request.id) {
          this.pendingLayoutEvent = undefined;
        }
        break;
      }
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
      case "restore-checkpoint": {
        const task = this.task(request.taskId);
        const change = task.changes.find((c) => c.id === request.changeId);
        if (!change) throw new Error("Change not found");
        if (!this.host.restoreCheckpoint) {
          throw new Error("Checkpoint restore is unavailable");
        }
        await this.host.restoreCheckpoint(change, { task, force: request.force });
        task.updatedAt = Date.now();
        if (!isDemoMode()) {
          void this.audit()
            .append({
              kind: "file-write",
              actor: await this.resolveActorName(),
              target: change.target,
              what: change.rollback?.command || `restoreCheckpoint(${change.description})`,
              outcome: "rolled-back",
              taskId: task.id,
              changeId: change.id,
            })
            .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        }
        break;
      }
      case "rollback-change": {
        const task = this.task(request.taskId);
        const change = task.changes.find((c) => c.id === request.changeId);
        if (!change) throw new Error("Change not found");
        if (change.kind === "file" && this.host.restoreCheckpoint) {
          await this.host.restoreCheckpoint(change, { task });
          task.updatedAt = Date.now();
          break;
        }
        const rollbackCmd = change.rollback?.command?.trim();
        if (!rollbackCmd) throw new Error("This change has no rollback command");
        // Only what actually ran can be taken back, and only once: the rollback of a change that was
        // refused or never ran would be a new change that nobody approved.
        if (!["completed", "failed", "uncertain"].includes(change.status))
          throw new Error("This change did not run, so there is nothing to take back.");
        if (change.rollback?.ran) throw new Error("This change has already been taken back.");
        // The rollback is the model's own command. It was shown on the change the person approved; one
        // that is destructive (or a check that is not read-only) is not run from a button: it goes
        // through the agent, where it is asked about like any other command.
        const rollbackRisk = analyzeCommandSafety(rollbackCmd);
        if (rollbackRisk.riskLevel === "destructive")
          throw new Error(
            `The rollback command is destructive (${rollbackRisk.riskReason}). Ask the assistant to take the change back, so that the command is approved like any other.`,
          );
        const checkCmd = change.check?.command?.trim();
        const checkIsReadOnly = !!checkCmd && analyzeCommandSafety(checkCmd).riskLevel === "safe";
        const sessionId = task.target?.sessionId;
        const session = sessionId ? this.terminals.get(sessionId) : undefined;
        if (!session || session.state !== "ready" || !session.shell) {
          throw new Error("No ready terminal is bound to this task for rollback");
        }
        if (session.owner && session.owner !== task.id) {
          throw new Error("Terminal is currently busy with another task");
        }
        const alreadyOwned = session.owner === task.id;
        if (!alreadyOwned) {
          this.terminals.claim(session.id, session.generation, task.id);
        }
        let runRes: { output: string; exitCode: number };
        let restored: boolean | undefined;
        try {
          runRes = await this.terminals.execute(session.id, session.generation, task.id, rollbackCmd, 120_000);
          if (request.verify !== false && checkCmd && checkIsReadOnly) {
            const checkRes = await this.terminals.execute(
              session.id,
              session.generation,
              task.id,
              checkCmd,
              60_000,
            );
            restored = checkRes.exitCode === 0;
          }
        } finally {
          if (!alreadyOwned) {
            this.terminals.release(task.id);
          }
        }
        change.rollback = {
          ...change.rollback,
          command: rollbackCmd,
          ran: true,
          exitCode: runRes.exitCode,
          output: maskContext(runRes.output),
          ...(restored !== undefined ? { restored } : {}),
        };
        task.updatedAt = Date.now();
        if (!isDemoMode()) {
          void this.audit()
            .append({
              kind: "change",
              actor: await this.resolveActorName(),
              target: change.target,
              what: `Rollback: ${rollbackCmd}`,
              outcome: runRes.exitCode === 0 ? "rolled-back" : "failed",
              exitCode: runRes.exitCode,
              taskId: task.id,
              changeId: change.id,
            })
            .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        }
        break;
      }
      case "task-fork": {
        const parent = this.task(request.taskId);
        const mode: AgentMode = request.mode ?? parent.mode;
        if (!["advice", "plan", "assisted", "autonomous"].includes(mode)) {
          throw new Error("Invalid autonomy mode");
        }
        let sourceMessages = parent.messages;
        if (request.fromMessageId) {
          const cutIdx = parent.messages.findIndex((m) => m.id === request.fromMessageId);
          if (cutIdx < 0) throw new Error("Fork message not found");
          sourceMessages = parent.messages.slice(0, cutIdx + 1);
        }
        const now = Date.now();
        const forked: AgentTask = {
          id: crypto.randomUUID(),
          title: clip(request.title?.trim() || `Fork: ${parent.title}`, 120),
          mode,
          agentId: parent.agentId,
          agentName: parent.agentName,
          status: sourceMessages.some((m) => m.role === "assistant") ? "completed" : "interrupted",
          target: parent.target ? { ...parent.target } : undefined,
          messages: sourceMessages.map((m) => ({
            ...m,
            id: crypto.randomUUID(),
            ...(m.images ? { images: m.images.map((img) => ({ ...img })) } : {}),
          })),
          changes: [],
          sources: parent.sources.map((s) => ({ ...s })),
          ...(parent.todos ? { todos: parent.todos.map((td) => ({ ...td })) } : {}),
          ...(parent.hypotheses ? { hypotheses: parent.hypotheses.map((h) => ({ ...h })) } : {}),
          ...(parent.handoffChain ? { handoffChain: [...parent.handoffChain] } : {}),
          parentTaskId: parent.id,
          ...(request.fromMessageId ? { forkedFromMessageId: request.fromMessageId } : {}),
          createdAt: now,
          updatedAt: now,
          maxCommands: parent.maxCommands,
          maxMinutes: parent.maxMinutes,
          verification: "not-verified",
        };
        this.store.data.tasks.push(forked);
        reply = { started: { taskId: forked.id } };
        break;
      }
      case "compact-task": {
        const task = this.task(request.taskId);
        if (active(task)) {
          throw new Error("Stop the running task before compacting its conversation");
        }
        const keepRecent = 4;
        if (task.messages.length > keepRecent) {
          const older = task.messages.slice(0, task.messages.length - keepRecent);
          const recent = task.messages.slice(-keepRecent);
          // What was asked first is the task itself: it is kept whole (as far as a summary can hold it).
          const asked = older.filter((m) => m.role === "user" && m.text.trim());
          const firstAsk = asked[0] ? [`Asked first:\n${boundedPrompt(asked[0].text.trim(), 2000)}`] : [];
          const userGoals = asked
            .slice(1)
            .slice(-3)
            .map((m) => `- User: ${clip(m.text.trim(), 240)}`);
          const keyFindings = older
            .filter((m) => m.role === "assistant" && m.text.trim())
            .slice(-3)
            .map((m) => `- Assistant: ${clip(m.text.trim(), 320)}`);
          const changeNotes = task.changes
            .slice(-5)
            .map((c) => `- Change [${c.status}]: ${clip(c.description, 160)}`);
          const focusLine = request.focus?.trim()
            ? `Focus: ${clip(request.focus.trim(), 200)}`
            : "";
          const summaryParts = [
            `Summary of ${older.length} earlier message(s) of this conversation, which were compacted.`,
            focusLine,
            ...firstAsk,
            ...userGoals,
            ...keyFindings,
            ...changeNotes,
          ].filter(Boolean);
          task.messages = [
            {
              id: crypto.randomUUID(),
              role: "system",
              // Marked as context: the model is given it. An ordinary system note is for the person only,
              // and the earlier conversation would be gone from the model's view altogether.
              text: CONTEXT_NOTE_PREFIX + clip(summaryParts.join("\n"), 6000),
              at: Date.now(),
            },
            ...recent,
          ];
          task.updatedAt = Date.now();
        }
        break;
      }
      case "quit":
        app.quit();
        break;
      default: {
        // Every action in HubRequest has a case above: a new one that is typed but not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    }
    // A request that only reads changes nothing: the store is not rewritten and the other windows are not told.
    const read = READ_ONLY_ACTIONS.has(asked.action);
    if (!read) await this.store.save();
    const snap = await this.snapshot();
    if (reply) snap.reply = reply;
    if (!read) this.changed(true);
    return snap;
  }

  streamTimer?: NodeJS.Timeout;

  mcpTokenStore?: McpTokenStore;
  localMcp?: LocalMcpServer;
  localMcpError?: string;

  auditLog?: AuditLog;
  auditShipper?: AuditShipper;
  auditShipperUnsub?: () => void;
  private lastAnchorAt = 0;
  private lastRecordingPruneAt = 0;
  recorder?: SessionRecorder;

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
  /**
   * A stopped run normally ends by itself a moment later. One that is blocked
   * inside a tool call that never returns (a connection that hangs) does not:
   * it would stay "running" for ever, whoever waits for it (a ticket, a
   * workforce run, the asking agent) would wait for ever, and "Continue"
   * would be refused. After a grace period the hub lets go of it: the
   * conversation is free again, and whatever the blocked call does later is
   * refused, because its capability is revoked.
   */
  runStopGraceMs = RUN_STOP_GRACE_MS;
  /** `saved`: the store was just written; only tell the windows (a second save of the same data is not needed). */
  changed(saved = false): void {
    if (this.disposed) return;
    this.host.changed();
    // Before the early return below: a change while a save is pending must still reach the inbox.
    this.pokeInbox();
    this.auditFinishedChanges();
    // A change of this member's that waits for a second person, or one that no longer does: the other
    // members' windows are told, so it is in their inbox (or out of it) without their asking.
    if (this.host.peerWaitingChanged && this.initialized) {
      const waiting = this.waitingForApproval()
        .map((w) => `${w.changeId}:${w.approvers.length}`)
        .join(",");
      if (waiting !== this.peerWaitingTold) {
        this.peerWaitingTold = waiting;
        this.host.peerWaitingChanged();
      }
    }
    // The board kept on this server (no bucket): what was just marked for the team is written there now,
    // and the other accounts are told the moment it is. With a bucket it waits for the next look, as before.
    if (
      this.lastWorkSync === 0 &&
      this.initialized &&
      !this.workSyncPushTimer &&
      !this.workSyncing &&
      this.host.sharedWorkStore &&
      this.teamStore() === this.host.sharedWorkStore
    )
      this.scheduleWorkSync(250);
    if (saved || !this.initialized || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.store
        .save()
        .catch((e) => log.warn("Save failed", safeError(e)));
    }, 2000);
  }

  othersPageUse: Record<string, KbPageUse>[] = [];
  uploadedPageUse = "";

  checkingContradictions = false;
  readonly rebuildingPages = new Set<string>();
  /** How the latest "Update from its sources" of each page ended, until the app is closed. */
  readonly lastRebuilds = new Map<string, { at: number; changed: boolean; error?: string }>();
  lastContradictionCheck?: { at: number; found: number; compared?: number; of?: number; error?: string };

  // ---- server facts ----------------------------------------------------------


  readonly factsStore: FactsStore;
  readonly factsCollecting = new Set<string>();
  readonly factsInFlight = new Map<string, Promise<void>>();
  lastFactsTick = 0;
  /** What the bucket says each server was last read as, by whichever installation read it. */
  readonly factsHeads = new Map<string, { collectedAt: number; hash: string }>();

  private static changeLine(change: FactChange, name: string): string {
    return `${new Date(change.at).toISOString().slice(0, 16).replace("T", " ")} UTC · ${name}: ${change.text}`;
  }

  /** What changed lately, per server, as lines that start with the time: handed to the agent's context, which picks the target's. */
  recentServerChanges(withinMs: number, now = Date.now()): { name: string; cluster?: string; lines: string[] }[] {
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

  factsRound?: Promise<void>;

  // ---- notifications out -----------------------------------------------------

  readonly notifyStore: NotifyStore;
  readonly atlassian: AtlassianBridge;
  /** What the team said in chat: the bot's connection, the channels it reads, and the search over them. */
  readonly chat: ChatBridge;
  private readonly stopChatListening: () => void;
  readonly runTimers = new Map<string, { timer: NodeJS.Timeout; endsAt: number }>();
  inboxDirty = false;
  inboxTimer?: NodeJS.Timeout;
  flushingInbox = false;
  /** How long the bucket is given to settle before a shared item is told about. Replaced in tests. */
  notifySettle = (): Promise<void> => new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
  notifyWaits: number[] | undefined;

  /** How long an agent waits for a person's answer. 0, the default, is for as long as it takes. */
  approvalWaitMinutes(): number {
    return integer(this.store.data.preferences.approvalWaitMinutes ?? 0, 0, 10_080);
  }

  /** Stands in for the network when a page is fetched for the knowledge base. Set in tests only. */
  kbNetwork?: { fetchImpl: typeof fetch; lookup: GuardOptions["lookup"] };

  /** The web server, where people sign in to accounts: a person's name and the server's own paths are the account's, not the request's. */
  hosted(): boolean {
    return Boolean(this.host.alertHookOwner);
  }

  /**
   * A shared server with several users: what one of them types must not reach into the server itself.
   * A web server with one account, its administrator's, is that person's own machine like the desktop app.
   */
  sharedServer(): boolean {
    return this.hosted() && !this.host.soleUser?.();
  }

  /** Where sshs3 may call out to on a user's word: a notification channel, a page for the knowledge base. */
  outboundGuard(): GuardOptions {
    return { server: this.sharedServer(), allowPrivate: !this.sharedServer() || process.env.SSHS3_ALLOW_PRIVATE_ADDRESSES === "1" };
  }

  // ---- nightly upkeep --------------------------------------------------------

  nightlyRunning = false;
  alertIntake: Promise<unknown> = Promise.resolve();

  /** The store `workSyncStore` was made for: a bucket connected or taken away later means a new one. */
  workSyncOn?: ConditionalQueueStore;

  /** Tickets whose run is being started right now (claim, terminal): no second start, and not the heartbeat's to free. */
  readonly ticketStarts = new Set<string>();

  /**
   * The board's share of the timer: finish what ended, keep this app's claims
   * alive, read the team's copy, free tickets whose runner went away, and, if
   * the heartbeat is on, take the next ticket.
   */
  /** When this machine last saw each other installation's claim move: its own clock, never theirs. */
  readonly claimSeen = new Map<string, { seenAt: number; at: number }>();
  private async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      const aiEnabled = (await this.config.getView()).enabled;
      const now = Date.now();
      void this.workTick(now, aiEnabled).catch((e) => log.warn("Board tick failed", safeError(e)));
      // The board mirrors Jira whether or not a model is set up: it is the team's record either way.
      void this.atlassian.syncJira(now).catch((e) => log.warn("Reading Jira failed", safeError(e)));
      void this.atlassian.rereadConfluence(now).catch((e) => log.warn("Reading Confluence failed", safeError(e)));
      void this.chat.tick(now).catch((e) => log.warn("Reading the team's chat failed", safeError(e)));
      void this.fillChatOnTickets(now).catch((e) => log.warn("Looking through the team's chat for a ticket failed", safeError(e)));
      if (!aiEnabled) return;
      void (async () => {
        await this.recoverUnreadSessions(now);
        await this.maybeLearnFromOwnActivity(now);
        await this.queueTeamActivity(now);
        await this.readLearningQueue(now);
      })().catch((e) => log.warn("Learning failed", safeError(e)));
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
      this.sweepDeadTerminals();
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
        await this.launchSchedule(schedule);
        this.changed();
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Whether a model answers at an address: asked once, nothing kept. What it
   * says is for the person choosing a model, so it names the address and what to do.
   */
  private async probeModel(baseUrl?: string): Promise<{ ok: boolean; detail: string; models?: string[] }> {
    const view = await this.config.getView();
    const url = (baseUrl ?? view.baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!baseUrl && !view.enabled) return { ok: false, detail: "The assistant is switched off. Switch it on in AI settings." };
    if (!url) {
      if (view.codexConnected) return { ok: true, detail: "Signed in. The sign-in is checked when a message is sent." };
      return view.hasApiKey
        ? { ok: true, detail: "A key is saved. It is checked when a message is sent." }
        : { ok: false, detail: "No key is saved and no model address is set. Add one in AI settings." };
    }
    try {
      await this.assertModelEndpointReach(url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const res = await (this.kbNetwork?.fetchImpl ?? fetch)(`${url}/models`, { signal: controller.signal });
        if (res.status === 401 || res.status === 403) return { ok: false, detail: `${hostOf(url)} answered, and refused the key. Check the key in AI settings.` };
        if (!res.ok) return { ok: false, detail: `${hostOf(url)} answered with an error (${res.status}). Check the address in AI settings.` };
        const body = (await res.json().catch(() => undefined)) as { data?: { id?: string }[] } | undefined;
        const models = (body?.data ?? []).map((m) => String(m.id ?? "")).filter(Boolean).slice(0, 50);
        return { ok: true, detail: models.length ? `${hostOf(url)} answers. It offers ${models.length} model${models.length === 1 ? "" : "s"}.` : `${hostOf(url)} answers.`, models };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const local = /127\.0\.0\.1|localhost|\[::1\]/.test(url);
      const why = e instanceof Error && e.name === "AbortError" ? "did not answer in time" : "did not answer";
      return { ok: false, detail: `No model answered: ${hostOf(url)} ${why}.${local ? " Start the local model (for Ollama: ollama serve), or choose another one in AI settings." : " Check the address, or choose another model in AI settings."}${local ? "" : ` (${clip(safeError(e), 120)})`}` };
    }
  }

  async resolveActorName(): Promise<string> {
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

  appendActivityEvent(event: WorkspaceActivityEvent): void {
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
            // `plain`: the limit under the name OpenAI's newer models take, and no temperature (they take their own only).
            const ask = (plain: boolean): Promise<Response> =>
              fetch(`${baseUrl}/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                  model: config.model || DEFAULT_AI_MODELS["openai-compatible"],
                  messages: [
                    { role: "system", content: sysPrompt },
                    { role: "user", content: userPrompt },
                  ],
                  ...(plain ? { max_completion_tokens: 400 } : { max_tokens: 400, temperature: 0.1 }),
                  stream: false,
                }),
                signal: controller.signal,
              });
            let resp = await ask(false);
            if (resp.status === 400) resp = await ask(true);
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
   * What the agent tool handlers in AppActions.ts may use of the hub: the one
   * place that says which hub internals a tool call can reach.
   */
  appActionHost() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the accessor below needs the hub
    const hub = this;
    return {
      store: this.store,
      chat: this.chat,
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
      planProposed: this.planProposed.bind(this),
      saveTicketFrom: this.saveTicketFrom.bind(this),
      notePageOpened: this.notePageOpened.bind(this),
      noteKbGap: this.noteKbGap.bind(this),
      pagesWithUse: this.pagesWithUse.bind(this),
      commentTicket: (id: string, author: string, text: string): void =>
        this.putTicket(withComment(this.ticket(id), author, text)),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopChatListening();
    clearInterval(this.tickTimer);
    clearTimeout(this.saveTimer);
    clearTimeout(this.streamTimer);
    clearTimeout(this.workSyncPushTimer);
    powerMonitor?.removeListener("suspend", this.suspend);
    powerMonitor?.removeListener("resume", this.resume);
    await Promise.all(
      this.store.data.tasks
        .filter(active)
        .map((t) => this.stop(t, "Application shutting down")),
    );
    await this.localMcp?.stop();
    await this.recorder?.stopAll().catch(() => undefined);
    this.auditShipperUnsub?.();
    this.auditShipperUnsub = undefined;
    await this.auditShipper?.flush().catch(() => undefined);
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

/** The hub's methods that are kept in files of their own (./areas). Declared here so the class has them; put on it just below. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- it names the parts and has no members of its own
export interface HubService extends InboxPart, ChatAndAtlassianPart, FactsPart, AlertsPart, SchedulesPart, SimulationPart, EvalsPart, AuditPart, McpPart, AgentsPart, MemoryPart, KnowledgePart, SafetyPart, ServersPart, TicketsPart, SharingPart, RunsPart {}
mixParts(HubService, [InboxPart, ChatAndAtlassianPart, FactsPart, AlertsPart, SchedulesPart, SimulationPart, EvalsPart, AuditPart, McpPart, AgentsPart, MemoryPart, KnowledgePart, SafetyPart, ServersPart, TicketsPart, SharingPart, RunsPart]);
