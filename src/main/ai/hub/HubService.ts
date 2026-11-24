import os from "node:os";
import path from "node:path";
import { app, powerMonitor } from "electron";
import type {
  AgentChange,
  AgentUsage,
  KbPageUse,
  AgentTask,
  HubRequest,
  HubSnapshot,
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
import { AiConfigStore } from "../AiConfigStore";
import { HermesManager } from "../HermesManager";
import { HubStore } from "./HubStore";
import { sharedMemoryRemovals } from "./memory/sharedMemoryRemovals";
import { S3WorkspaceSyncService, mergeMemoryCopies } from "./S3WorkspaceSyncService";
import { McpClientManager } from "./McpClientManager";
import { KnowledgeBaseService } from "./KnowledgeBaseService";
import { SelfLearningService } from "./SelfLearningService";
import { EXTERNAL_RUNNER_PRESETS } from "./AcpRuntime";
import { withUse } from "./KbCompile";
import { guardUrl, type GuardOptions } from "./Notifier";
import { NotifyStore } from "./NotifyStore";
import { AtlassianStore } from "./AtlassianStore";
import { AtlassianBridge } from "./AtlassianBridge";
import { ChatBridge } from "./ChatBridge";
import { FactsStore } from "./FactsStore";
import { Replay } from "./EvalSuite";
import { lintKnowledgeBase } from "./KbLint";
import { getDemoSchedules, getDemoTasks, isDemoMode, mcpCatalog } from "./demoWorkspace";
import { TerminalRegistry, type DetectedCommandActivity } from "./TerminalRegistry";
import { ToolBroker } from "./ToolBroker";
import { type AgentRuntime } from "./AgentRuntime";
import { ContextService, scopedMemory } from "./ContextService";
import { AuditLog } from "./AuditLog";
import { LocalMcpServer } from "./LocalMcpServer";
import { SessionRecorder } from "./SessionRecorder";
import { McpTokenStore } from "../../web/McpTokenStore";
import { safeError } from "./privacy";
import { teamActivity } from "./personalServers";
import { LearningQueue } from "./LearningQueue";
import { WorkSync, type ConditionalQueueStore } from "./WorkSync";
import { withComment, live, templateSummaries } from "./WorkBoard";
import { EmbeddingIndex } from "./EmbeddingIndex";
import { integer } from "./hubHelpers";
import { worksOnItsOwn } from "./DirectAgentRuntime";
import { handleAppAction } from "./AppActions";
import type { HubHost } from "./hubHost";
import { log, taskForSnapshot, READ_ONLY_ACTIONS, REVEAL_KEPT_MS, active, RUN_STOP_GRACE_MS, isBackgroundRun } from "./hubShared";
import { areaOf, type AreaName, type Handled, type RequestsOf } from "./areas/routes";
import { mixParts } from "./areas/mix";
import { InboxPart } from "./areas/inbox";
import { ChatAndAtlassianPart } from "./areas/chatAndAtlassian";
import { FactsPart } from "./areas/facts";
import { AlertsPart } from "./areas/alerts";
import { nextScheduleTime, SchedulesPart } from "./areas/schedules";
import { disposeSimulation, SimulationPart } from "./areas/simulation";
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
import { ConversationsPart } from "./areas/conversations";
import { ChatRunsPart, type HubRunEvent } from "./areas/chatRuns";
import { ChatAnsweringPart } from "./areas/chatAnswering";
import { memoryInFence } from "./chatFence";
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
  previewId?: string;
  pendingLayoutEvent?: WorkspaceLayoutEvent;
  cachedWorkspaceServers: WorkspaceServerSummary[] = [];
  private ticking = false;
  /** When the previous pass over the schedules began: a job that fell due after it is late, not missed. */
  private lastScheduleLoopAt = 0;
  /** For a recording that is being made: the recording its conversation pointed to before. */
  private readonly recordingBefore = new Map<string, string | undefined>();
  /** The terminal each scheduled run was given, so it is closed when the run ends. */
  readonly scheduleStarts = new Set<string>();
  readonly scheduleSessions = new Map<string, string>();
  /** Terminals the hub opened for a run while it ran (another server of the cluster, a ticket's target). */
  readonly runTerminals = new Map<string, Set<string>>();
  /** Who follows the runs without a browser (see onRun). */
  readonly runListeners = new Set<(event: HubRunEvent) => void>();
  disposed = false;
  private resume = (): void => {
    const now = Date.now();
    for (const schedule of this.store.data.schedules) {
      if (!schedule.enabled || schedule.nextRunAt > now) continue;
      if (schedule.missedPolicy === "run_once") schedule.nextRunAt = now;
      else {
        schedule.lastStatus = "Missed while unavailable; not replayed.";
        schedule.nextRunAt = nextScheduleTime(schedule, now);
      }
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
      beforeAction: host.beforeAction,
      context: async (task, query, sessionId) => {
        const extra = await this.collectExtraContext();
        // A run asked for from chat sees only its own terminals and servers: never what another
        // conversation's terminal showed, what it did, or what was learned from it.
        const fence = this.chatFence(task);
        return this.context.read(task, query, sessionId, this.asOfEvalCase(task, fence ? this.fencedContext(extra, fence) : extra));
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
        const fence = this.chatFence(task);
        const memories = extra.memories ?? this.store.data.memories;
        return scopedMemory(
          fence ? memories.filter((m) => memoryInFence(m, fence.allows, extra.workspaceServers ?? [])) : memories,
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
      recordIntent: async (task, change, rollback) => {
        await this.audit().append({
          kind: change.kind === "file" ? "file-write" : change.kind === "setting" ? "setting" : "change",
          actor: task.agentName ?? "Assistant", target: change.target, taskId: task.id, changeId: change.id,
          what: rollback ? change.rollback?.command ?? change.description : change.command ?? change.description,
          outcome: rollback ? "rollback-intent" : "intent",
          approvedBy: change.decidedBy?.name, detail: change.adminException?.reason, userId: change.adminException?.actorId,
        }, Date.now(), true);
      },
      recordStarted: (task, change) => this.recordStarted(task, change),
      approvalWaitMs: () => this.approvalWaitMinutes() * 60_000,
      // Nobody sits at a ticket's or a schedule's run: what it waits for is told at once, not on the next look.
      asking: (task, change) => {
        if (worksOnItsOwn(task)) void this.flushInbox().catch((e) => log.warn("Notifications failed", safeError(e)));
        this.emitRun({ type: "asking", taskId: task.id, changeId: change.id });
      },
      answered: (task, changeId, answer) =>
        this.emitRun({ type: "answered", taskId: task.id, changeId, allowed: answer.allowed, how: answer.how, final: answer.final }),
      chatFence: (task) => this.chatFence(task),
      chatTerminal: (task, name) => this.chatTerminal(task, name),
      // Told its budget is spent, the agent asked for more anyway: the run ends here.
      budgetSpent: (task) => void this.stop(task, "Command budget exhausted"),
      // Told a command is not run again for the same answer, the agent kept asking for it: the run ends here.
      stuck: (task, why) => void this.stop(task, why),
      peerStillEligible: host.peerStillEligible,
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
          // A service account's terminals are nobody's at a keyboard: they are not shown as somebody here.
          const activeTerminals: WorkspacePresenceTerminal[] = this.host.serviceAccount ? [] : this.terminals
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
            // What was done on a server a person keeps to themselves stays on this computer.
            activityLog: teamActivity(this.store.data.activityLog ?? [], [...this.getKnownServers(), ...hostServers]),
            deletedServerIds,
            deletedMemoryIds: { ...(this.store.data.deletedMemoryIds ?? {}) },
            deletedServerBy: { ...(this.store.data.deletedServerBy ?? {}) },
            deletedMemoryBy: { ...(this.store.data.deletedMemoryBy ?? {}) },
            activeTerminals,
          };
        },
        applyMergedState: async (state) => {
          this.store.data.deletedServerIds = state.deletedServerIds;
          const removals = sharedMemoryRemovals(this.store.data, state);
          this.store.data.deletedMemoryIds = removals.deleted;
          if (state.deletedServerBy) this.store.data.deletedServerBy = state.deletedServerBy;
          if (state.deletedMemoryBy) this.store.data.deletedMemoryBy = state.deletedMemoryBy;
          this.store.data.s3SyncedServers = state.activeServers;

          const personalMemories = this.store.data.memories.filter(
            (m) => m.scope === "personal",
          );
          const sharedMemMap = new Map<string, MemoryEntry>();
          for (const m of this.store.data.memories) {
            if (m.scope !== "personal") {
              if (!removals.removed(m)) {
                sharedMemMap.set(m.id, m);
              }
            }
          }
          for (const m of state.memories) {
            if (removals.removed(m)) continue;
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

          if (state.changed || removals.changed) {
            this.changed();
          }
        },
        onStateChanged: () => {
          if (!this.disposed) this.host.changed();
        },
      },
      {
        providerFactory: host.s3ProviderFactory,
        publishPresence: !host.serviceAccount,
      },
    );
    this.terminals.on("changed", () => {
      this.changed();
      if (!this.host.serviceAccount) this.s3Workspace.schedulePresenceUpdate();
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
      if (!task || isBackgroundRun(task) || this.store.data.preferences.recordSessions === false) return;
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
          if (!info) return;
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
      // A store that could not be read leaves the hub on default settings and rules, saving nothing.
      // The person is told in every snapshot (`storeProblem`), not only in the log.
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
      if (isDemoMode()) this.seedDemoWorkspaceState();
      await this.s3Workspace.start().catch((e) =>
        log.warn("S3 workspace start failed", safeError(e)),
      );
      let migrated = false;
      for (const schedule of this.store.data.schedules) {
        if (!schedule.cron || schedule.cronTimingVersion === 1) continue;
        try {
          schedule.nextRunAt = nextScheduleTime(schedule, Date.now());
        } catch (err) {
          schedule.enabled = false;
          schedule.lastStatus = `Paused. ${safeError(err)}`;
        }
        schedule.cronTimingVersion = 1;
        migrated = true;
      }
      if (migrated) await this.store.save();
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
    // The agent bot in chat is the server's: a failure to read it leaves it out, never the whole snapshot.
    const chatAnswering = this.host.chatAnswering
      ? await this.host.chatAnswering.view().catch((e) => {
          log.warn("The agent bot's state could not be read for the snapshot", safeError(e));
          return undefined;
        })
      : undefined;
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
      // What a replay is given (the recording, the server list of the day) stays here: the windows show the test, not its material.
      evalCases: (this.store.data.evalCases ?? []).map(({ recorded, servers: _servers, ...rest }) => ({ ...rest, recordedCalls: recorded.length })),
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
      ...(this.teamRulesView() ? { teamRules: this.teamRulesView() } : {}),
      ...(chatAnswering ? { chatAnswering } : {}),
      safetyPolicyChanged: this.store.data.safetyPolicyChanged,
      ...(this.store.problem ? { storeProblem: this.store.problem } : {}),
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
        reasoningEffort,
        temperature,
      },
    };
  }

  /** Hands a request to the part of the hub it belongs to (./areas/routes). */
  private handleIn(area: AreaName, request: HubRequest): Promise<Handled> {
    switch (area) {
      case "inbox":
        return this.handleInbox(request as RequestsOf<"inbox">);
      case "chatAndAtlassian":
        return this.handleChatAndAtlassian(request as RequestsOf<"chatAndAtlassian">);
      case "chatAnswering":
        return this.handleChatAnswering(request as RequestsOf<"chatAnswering">);
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
      case "conversations":
        return this.handleConversations(request as RequestsOf<"conversations">);
    }
  }

  async request(asked: HubRequest): Promise<HubSnapshot> {
    await this.initialize();
    if (this.disposed) throw new Error("Application is shutting down");
    if (!asked || typeof asked.action !== "string")
      throw new Error("Invalid AI request");
    if (process.env.SSHS3_NATIVE_HERMES === '1' && ['start', 'reply', 'resume', 'schedule-save'].includes(asked.action))
      throw new Error('This installation uses native Hermes. Open the Hermes chat to start or schedule work.');
    // Each request belongs to one part of the hub (./areas/routes), and that part answers it. An action
    // that is typed but has no part, or a part that does not handle one of its actions, does not compile.
    const area = areaOf(asked.action);
    if (!area) throw new Error(`Unknown AI request: ${String(asked.action)}`);
    const handled = await this.handleIn(area, asked);
    // A case that made the snapshot itself (it went on in another request) answers with that one.
    if (handled.snapshot) return handled.snapshot;
    // What this request returns beside the snapshot. Local to the call: requests overlap.
    const reply = handled.reply;
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
  /**
   * What a person typed on an approval card for the secrets a setting needs, by change id. Memory only:
   * the tool that waited for the approval reads it once, and it is dropped when that tool ends.
   */
  readonly changeSecrets = new Map<string, Record<string, string>>();
  /** What a setting change made for the person alone (a key, a code), until it is shown once. Memory only. */
  readonly changeReveals = new Map<string, { label: string; value: string; at: number }>();
  readonly writingAudit = new Set<string>();
  readonly restoringChanges = new Set<string>();
  private lastAnchorAt = 0;
  private lastRecordingPruneAt = 0;
  recorder?: SessionRecorder;

  reflectTaskCompletion(task: AgentTask): void {
    if (task.status !== "completed" && task.status !== "failed") return;
    if (!this.learnsFrom(task)) return;
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
  readonly factsInFlight = new Map<string, { reading: Promise<void>; next?: Promise<void> }>();
  lastFactsTick = 0;
  /** What the bucket says each server was last read as, by whichever installation read it. */
  readonly factsHeads = new Map<string, { collectedAt: number; hash: string }>();
  /** Each reading's head in the bucket as it was last looked at, by the mark its listing gave: one that has not changed is not downloaded again. */
  readonly factsHeadSeen = new Map<string, { version: string; serverId: string; done: boolean }>();

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
      // The team's learning is done by people's installations. The chat agent's hub holds what every
      // channel asked, and it never hands that over, reads the team's queue or learns from activity,
      // whatever its preferences say.
      if (!this.host.serviceAccount)
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
          ) {
            this.notify("Endpoint became unreachable", entry.label);
            await this.scheduleEvent("unreachable", [entry.id]);
          }
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
        schedule.nextRunAt = nextScheduleTime(schedule, now);
        if (schedule.missedPolicy !== "run_once" && overdue > 60_000 && dueAt < previousLoop - 60_000) {
          schedule.lastStatus = "Missed while unavailable; not replayed.";
          this.changed();
          continue;
        }
        if (this.scheduleInProgress(schedule)) {
          schedule.lastStatus = "Skipped: previous run still active";
          this.changed();
          continue;
        }
        await this.launchSchedule(schedule, true);
        this.changed();
      }
    } finally {
      this.ticking = false;
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

  /** A plain command that has been running for a moment: in the log as started, in case its end never comes. */
  recordStarted(task: AgentTask, change: AgentChange): void {
    void this.audit()
      .append({
        kind: task.fromOutside ? "mcp" : "command",
        actor: `${task.agentName ?? "Assistant"} (${task.fromOutside ? "from outside" : `run ${task.id.slice(0, 8)}`}, ${task.mode})`,
        target: change.target, taskId: task.id, changeId: change.id,
        what: change.command || change.description,
        outcome: "started",
        detail: "Still running. How it ended is written when it ends.",
      }, Date.now(), true)
      .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
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
      recheckChange: this.broker.checkCurrentPolicy.bind(this.broker),
      closeWhenRunEnds: this.closeWhenRunEnds.bind(this),
      /**
       * A command that is still running after a moment (the broker's `startedNoteMs`) is written in the
       * audit log as started, as a terminal command is. Returns what to call once it has ended.
       */
      noteStartedAfterAWhile: (task: AgentTask, change: AgentChange): (() => void) => {
        const timer = setTimeout(() => this.recordStarted(task, change), this.broker.startedNoteMs);
        return () => clearTimeout(timer);
      },
      chatFence: this.chatFence.bind(this),
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
      /** The secrets a person typed when approving this change. Read once: they are gone after. */
      takeChangeSecrets: (changeId: string): Record<string, string> => {
        const given = this.changeSecrets.get(changeId) ?? {};
        this.changeSecrets.delete(changeId);
        return given;
      },
      /** Keeps what a change made for the person alone, to be shown once on its card. */
      keepChangeReveal: (changeId: string, label: string, value: string): void => {
        const now = Date.now();
        // Ones nobody came for are dropped as new ones arrive.
        for (const [id, kept] of this.changeReveals) if (now - kept.at > REVEAL_KEPT_MS) this.changeReveals.delete(id);
        this.changeReveals.set(changeId, { label, value, at: now });
      },
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await disposeSimulation(this);
    this.stopChatListening();
    clearInterval(this.tickTimer);
    clearTimeout(this.saveTimer);
    clearTimeout(this.streamTimer);
    clearTimeout(this.workSyncPushTimer);
    powerMonitor?.removeListener("suspend", this.suspend);
    powerMonitor?.removeListener("resume", this.resume);
    /** The runs that are at work as the app closes. */
    const closing = new Set(this.store.data.tasks.filter(active).map((t) => t.id));
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
    // What was running when the app closed ends here as "uncertain". It is written to the audit log
    // before the app is gone, not left for the next start. Only the runs that were at work, and
    // not for ever: a log that is slow to write must not hold the app open.
    await new Promise((resolve) => setImmediate(resolve));
    this.auditFinishedChanges(closing);
    if (this.auditLog) {
      let giveUp: NodeJS.Timeout | undefined;
      await Promise.race([this.auditLog.idle(), new Promise((resolve) => (giveUp = setTimeout(resolve, 3000)))]);
      clearTimeout(giveUp);
    }
    // A document being read, or facts being collected, writes into the hub's folder when it
    // ends. A hub that has been disposed of must have stopped writing before it says so.
    for (let i = 0; i < 100 && (this.kbReadingId || this.factsRound); i++)
      await new Promise((r) => setTimeout(r, 20));
    await this.factsRound?.catch(() => undefined);
    // The last save. When it cannot be written (the folder is gone, the disk is full) there is nobody
    // left to tell: closing must still end, and must not end as an error nobody catches.
    if (this.initialized) await this.store.save().catch(() => undefined);
  }
}

/** The hub's methods that are kept in files of their own (./areas). Declared here so the class has them; put on it just below. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- it names the parts and has no members of its own
export interface HubService extends InboxPart, ChatAndAtlassianPart, FactsPart, AlertsPart, SchedulesPart, SimulationPart, EvalsPart, AuditPart, McpPart, AgentsPart, MemoryPart, KnowledgePart, SafetyPart, ServersPart, TicketsPart, SharingPart, RunsPart, ConversationsPart, ChatRunsPart, ChatAnsweringPart {}
mixParts(HubService, [InboxPart, ChatAndAtlassianPart, FactsPart, AlertsPart, SchedulesPart, SimulationPart, EvalsPart, AuditPart, McpPart, AgentsPart, MemoryPart, KnowledgePart, SafetyPart, ServersPart, TicketsPart, SharingPart, RunsPart, ConversationsPart, ChatRunsPart, ChatAnsweringPart]);
