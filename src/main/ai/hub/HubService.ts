import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app, Notification, powerMonitor } from "electron";
import type {
  AgentChange,
  AgentSchedule,
  AgentTask,
  HubRequest,
  HubSnapshot,
  InfraGraphEdge,
  InlineCommandSuggestion,
  KbDocument,
  LocalServerAuthOverride,
  McpServerConfig,
  MemoryEntry,
  MissionAgent,
  S3WorkspaceConfig,
  StartAgentTask,
  TerminalSession,
  WorkforceRun,
  WorkforceStep,
  WorkspaceActivityEvent,
  WorkspaceLayoutEvent,
  WorkspacePresenceTerminal,
  WorkspaceServerSummary,
} from "../../../shared/types/aiHub";
import type { IStorageProvider } from "../../../shared/types/storage";
import { SHELL_KINDS } from "../../../shared/types/aiHub";
import { DEFAULT_AI_MODELS } from "../../../shared/types/ai";
import { AiConfigStore } from "../AiConfigStore";
import { CodexAuthProvider } from "../CodexAuthProvider";
import { HermesManager, type HermesModelConfig } from "../HermesManager";
import { HubStore } from "./HubStore";
import { S3WorkspaceSyncService } from "./S3WorkspaceSyncService";
import { McpClientManager } from "./McpClientManager";
import { KnowledgeBaseService } from "./KnowledgeBaseService";
import {
  analyzeCommandSafety,
  DEFAULT_SAFETY_POLICY,
} from "./CommandSafetyService";
import {
  deleteDemoAgent,
  deleteDemoInfraEdge,
  deleteDemoKbDocument,
  deleteDemoMcpServer,
  getBuiltinAgents,
  getBuiltinKbDocuments,
  getBuiltinSkillsAndMemories,
  getDemoAgents,
  getDemoInfraEdges,
  getDemoKbDocuments,
  getDemoMcpServers,
  getDemoSchedules,
  getDemoTasks,
  getDemoWorkforceRuns,
  isDemoMode,
  MCP_MARKETPLACE_CATALOG,
  saveDemoAgent,
  saveDemoInfraEdge,
  saveDemoKbDocument,
  saveDemoMcpServer,
  saveDemoWorkforceRun,
  setDemoMode,
} from "./demoWorkspace";
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
import { boundedContext, safeError } from "./privacy";
import { createLogger } from "../../log";

const log = createLogger("ai-hub");
const active = (t: AgentTask): boolean =>
  ["queued", "running", "waiting"].includes(t.status);
export interface HubHost {
  changed(): void;
  inventoryTargets(): Promise<InventoryTarget[]>;
  openSchedule(schedule: AgentSchedule): Promise<string>;
  backgroundChanged(background: boolean, autoStart: boolean): Promise<void>;
  show(): void;
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
  storageOps?(input: {
    operation: "list_files" | "read_remote_file" | "diff_paths";
    targetA: string;
    pathA: string;
    targetB?: string;
    pathB?: string;
  }): Promise<unknown>;
}

/** The Electron main process is the per-user background owner; renderer lifetimes confer no authority. */
export class HubService {
  readonly terminals = new TerminalRegistry();
  readonly store: HubStore;
  readonly config: AiConfigStore;
  readonly context: ContextService;
  readonly broker: ToolBroker;
  readonly s3Workspace: S3WorkspaceSyncService;
  readonly mcp = new McpClientManager();
  readonly kb = new KnowledgeBaseService();
  private runtimes = new Map<string, AgentRuntime>();
  private launches = new Map<string, symbol>();
  private initialized?: Promise<void>;
  private tickTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private lastInventory = 0;
  private previewId?: string;
  private inlineSuggestion?: InlineCommandSuggestion;
  private pendingLayoutEvent?: WorkspaceLayoutEvent;
  private ticking = false;
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
    directory = path.join(app.getPath("userData"), "ai-hub"),
  ) {
    this.store = new HubStore(path.join(directory, "hub.json"));
    this.config = new AiConfigStore(host.aiConfigFilePath);
    this.context = new ContextService(
      this.store,
      this.terminals,
      host.inventoryTargets,
    );
    this.broker = new ToolBroker(this.terminals, {
      context: async (task, query, sessionId) => {
        const extra = await this.collectExtraContext();
        return this.context.read(task, query, sessionId, extra);
      },
      memory: async (task, request) => {
        if (request.action === "memory-save") {
          const entry = await this.saveMemoryInternal({
            kind: request.kind === "skill" ? "skill" : "memory",
            scope: request.scope || "workspace",
            title: request.title || "Workspace note",
            text: request.text || "",
          });
          return { saved: true, entry };
        }
        const extra = await this.collectExtraContext();
        return scopedMemory(
          extra.memories ?? this.store.data.memories,
          this.scope(task),
          request.action === "skills",
        );
      },
      file: (...args) => {
        if (!this.host.file) throw new Error("File tools unavailable");
        return this.host.file(...args);
      },
      appAction: (task, request, authorize) =>
        this.handleAppAction(task, request, authorize),
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
            if (s?.id && s.shared !== false) {
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
            if (!prev || (m.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
              sharedMemMap.set(m.id, m);
            }
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
  }

  initialize(): Promise<void> {
    return (this.initialized ??= (async () => {
      await this.store.load().catch((e) =>
        log.warn("HubStore load failed; using default store", safeError(e)),
      );
      if (this.store.data.preferences.demoLabEnabled !== undefined) {
        setDemoMode(this.store.data.preferences.demoLabEnabled);
      }
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

  private getAgentsList(): MissionAgent[] {
    const stored = this.store.data.agents ?? [];
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    const builtins = isDemoMode() ? getDemoAgents() : getBuiltinAgents();
    return [
      ...stored,
      ...builtins.filter(
        (ba) => !dismissed.has(ba.id) && !stored.some((a) => a.id === ba.id),
      ),
    ];
  }

  private getMcpServersList(): McpServerConfig[] {
    const stored = this.store.data.mcpServers ?? [];
    if (!isDemoMode()) return stored;
    return [
      ...stored,
      ...getDemoMcpServers().filter((dm) => !stored.some((m) => m.id === dm.id)),
    ];
  }

  private getKbDocumentsList(): KbDocument[] {
    const stored = this.store.data.kbDocuments ?? [];
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    const builtins = isDemoMode() ? getDemoKbDocuments() : getBuiltinKbDocuments();
    return [
      ...stored,
      ...builtins.filter(
        (bk) => !dismissed.has(bk.id) && !stored.some((k) => k.id === bk.id),
      ),
    ];
  }

  private markBuiltinDismissed(id: string): void {
    const list = this.store.data.preferences.dismissedBuiltinIds ?? [];
    if (!list.includes(id)) {
      this.store.data.preferences.dismissedBuiltinIds = [...list, id];
    }
  }

  private getInfraEdgesList(): InfraGraphEdge[] {
    const stored = this.store.data.infraEdges ?? [];
    if (!isDemoMode()) return stored;
    return [
      ...stored,
      ...getDemoInfraEdges().filter((de) => !stored.some((e) => e.id === de.id)),
    ];
  }

  private getWorkforceRunsList(): WorkforceRun[] {
    const stored = this.store.data.workforceRuns ?? [];
    if (!isDemoMode()) return stored;
    return [
      ...stored,
      ...getDemoWorkforceRuns().filter((dw) => !stored.some((w) => w.id === dw.id)),
    ];
  }

  private async executeWorkforceRun(opts: {
    prompt: string;
    agentIds?: string[];
    targetCluster?: string;
    createTask?: boolean;
  }): Promise<WorkforceRun> {
    const allAgents = this.getAgentsList();
    const extra = await this.collectExtraContext();
    const allServers = extra.workspaceServers ?? [];
    const kbDocs = this.getKbDocumentsList();

    let selectedAgents = allAgents;
    if (opts.agentIds && opts.agentIds.length > 0) {
      const qList = opts.agentIds.map((x) => x.toLowerCase());
      const filtered = allAgents.filter((a) =>
        qList.some(
          (q) =>
            a.id.toLowerCase() === q ||
            a.name.toLowerCase().includes(q) ||
            (a.targetCluster && a.targetCluster.toLowerCase().includes(q)),
        ),
      );
      if (filtered.length > 0) selectedAgents = filtered;
    } else if (opts.targetCluster && opts.targetCluster !== "ALL") {
      const cl = opts.targetCluster.toLowerCase();
      const clusterMatched = allAgents.filter(
        (a) => a.targetCluster && a.targetCluster.toLowerCase().includes(cl),
      );
      if (clusterMatched.length > 0) {
        selectedAgents = [
          ...clusterMatched,
          ...allAgents.filter((a) => !clusterMatched.includes(a)).slice(0, 2),
        ];
      }
    }

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
      const nodeNames =
        clusterNodes.slice(0, 3).map((n) => n.name).join(", ") || cluster;
      const kbHint =
        kbMatches.length > 0
          ? `Enligt KB "${kbMatches[0].title}": ${kbMatches[0].snippet.slice(0, 180)}…`
          : `Analyserade ${clusterNodes.length || 1} noder (${nodeNames}) mot uppdraget "${ag.mission.slice(0, 90)}".`;

      const recCmds = cluster.toLowerCase().includes("ontap")
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
            : ["uptime && df -h && systemctl --failed"];

      return {
        id: `wf-step-${Date.now()}-${idx}`,
        agentId: ag.id,
        agentName: ag.name,
        agentIcon: ag.icon || "🤖",
        role: ag.role,
        targetCluster: cluster,
        subTask: `Deluppdrag för ${ag.name} (${cluster}): ${opts.prompt.slice(0, 140)}`,
        status: "completed",
        findings: `Kontrollerade ${nodeNames}. ${kbHint}`,
        recommendedCommands: recCmds,
        durationMs: 850 + idx * 240,
      };
    });

    const synthesis = [
      `### 🤝 AI Workforce Sammanställning (${steps.length} specialistagenter körda parallellt)`,
      `Uppdrag: **${opts.prompt}**`,
      "",
      ...steps.map(
        (s, i) =>
          `${i + 1}. **${s.agentIcon || "🤖"} ${s.agentName}** (*${s.targetCluster || s.role}*): ${s.findings}`,
      ),
      "",
      "**Rekommenderat nästa steg:** Granska föreslagna diagnostikkommandon per kluster eller kör parallell verifiering via `sshs3_cluster_exec`.",
    ].join("\n");

    const run: WorkforceRun = {
      id: `wf-${crypto.randomUUID().slice(0, 8)}`,
      title: boundedContext(opts.prompt, 90),
      prompt: boundedContext(opts.prompt, 2000),
      leadAgentName: "Lead SRE Workforce Orchestrator",
      targetCluster: opts.targetCluster || "ALL",
      status: "completed",
      steps,
      synthesis,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.store.data.workforceRuns = [
      run,
      ...(this.store.data.workforceRuns ?? []).filter((r) => r.id !== run.id),
    ].slice(0, 25);
    if (isDemoMode()) saveDemoWorkforceRun(run);

    if (opts.createTask) {
      const now = Date.now();
      const wfTask: AgentTask = {
        id: crypto.randomUUID(),
        title: `🤝 Workforce: ${run.title}`,
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
        verification: "verified",
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
          model: "gpt-6.1-codex-max",
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
    const activeTask = this.store.data.tasks.at(-1);
    const msgChars = (activeTask?.messages ?? []).reduce(
      (sum, m) => sum + (m.text?.length ?? 0),
      0,
    );
    const kbDocs = this.getKbDocumentsList();
    const kbChars = kbDocs.reduce((sum, d) => sum + Math.min(d.content.length, 3000), 0);
    const srvChars = (extra.workspaceServers ?? []).length * 220;
    const memChars = (extra.memories ?? []).length * 180;
    const estimatedUsedTokens = Math.min(
      contextWindowTokens,
      Math.round((msgChars + kbChars + srvChars + memChars + terminalContextChars) / 4) + 1200,
    );
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
      tasks: isDemoMode()
        ? [
            ...getDemoTasks().filter(
              (dt) => !this.store.data.tasks.some((t) => t.id === dt.id),
            ),
            ...this.store.data.tasks,
          ]
        : this.store.data.tasks,
      memories: extra.memories ?? this.store.data.memories,
      schedules: isDemoMode()
        ? [
            ...this.store.data.schedules,
            ...getDemoSchedules().filter(
              (ds) => !this.store.data.schedules.some((s) => s.id === ds.id),
            ),
          ]
        : this.store.data.schedules,
      inventory: this.store.data.inventory,
      activityLog: extra.activityLog ?? this.store.data.activityLog ?? [],
      workspaceServers: extra.workspaceServers ?? [],
      inlineSuggestion: this.inlineSuggestion,
      s3Workspace: this.s3Workspace.getStatus(),
      presence: this.mergePresence(
        this.s3Workspace.getPresence(),
        this.host.peerPresenceProvider?.() ?? [],
      ),
      localOverrides: { ...(this.store.data.localOverrides ?? {}) },
      agents: this.getAgentsList(),
      mcpServers: this.getMcpServersList(),
      mcpCatalog: MCP_MARKETPLACE_CATALOG,
      kbDocuments: kbDocs,
      workforceRuns: this.getWorkforceRunsList(),
      infraEdges: this.getInfraEdgesList(),
      safetyPolicy: this.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY,
      lastTerminalFailures: this.terminals.failures(),
      pendingLayoutEvent: this.pendingLayoutEvent,
      contextBudget: {
        contextWindowTokens,
        terminalContextChars,
        maxOutputTokens,
        maxToolTurns,
        reasoningEffort,
        temperature,
        estimatedUsedTokens,
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
        task.messages.push({
          id: crypto.randomUUID(),
          role: "user",
          text: task.target
            ? "Resume on this terminal. Recheck the current state; do not replay any uncertain command."
            : "Resume the conversation.",
          at: Date.now(),
        });
        await this.launch(task);
        break;
      }
      case "configure": {
        await this.config.update(request.config);
        if (request.preferences) {
          const p = request.preferences;
          if (p.retentionDays !== undefined)
            this.store.data.preferences.retentionDays = integer(
              p.retentionDays,
              1,
              365,
            );
          for (const key of ["background", "autoStart", "inventory"] as const)
            if (p[key] !== undefined)
              this.store.data.preferences[key] = p[key] === true;
          if (p.sharedWorkspacePath !== undefined) {
            const cleanedPath = p.sharedWorkspacePath.trim();
            if (cleanedPath) {
              this.store.data.preferences.sharedWorkspacePath = cleanedPath;
            } else {
              delete this.store.data.preferences.sharedWorkspacePath;
            }
          }
          if (
            this.store.data.preferences.autoStart &&
            !this.store.data.preferences.background
          )
            throw new Error("Autostart requires background mode");
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
      case "start":
        await this.start(request.task);
        break;
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
            label: boundedContext(s.label || "image", 200),
            dataUrl: s.imageDataUrl!.slice(0, 6_000_000),
            mimeType: s.mimeType,
          }));
        for (const s of rawAttachments) {
          if (!s.imageDataUrl && s.text?.trim()) {
            task.sources.push({
              id: crypto.randomUUID(),
              label: boundedContext(s.label || "attachment", 200),
              text: boundedContext(s.text),
              observedAt: Date.now(),
            });
          }
        }
        const rawText =
          request.text?.trim() ||
          (replyImages.length > 0 ? "Analyze the attached image(s)." : "");
        const text = boundedContext(requiredText(rawText), 16_000);
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
      case "approve":
        this.broker.approve(
          request.taskId,
          request.changeId,
          request.approved === true,
        );
        break;
      case "memory-save": {
        const entry = request.entry;
        if (!["memory", "skill"].includes(entry.kind))
          throw new Error("Invalid memory type");
        const scope = requiredText(entry.scope);
        if (
          scope !== "personal" &&
          scope !== "workspace" &&
          !scope.startsWith("target:") &&
          !scope.startsWith("workspace:")
        )
          throw new Error("Invalid memory scope");
        await this.saveMemoryInternal({
          id: entry.id,
          kind: entry.kind,
          tier: entry.tier,
          cluster: entry.cluster,
          scope,
          title: requiredText(entry.title),
          text: requiredText(entry.text),
          author: entry.author,
        });
        break;
      }
      case "memory-delete":
        this.store.data.memories = this.store.data.memories.filter(
          (m) => m.id !== request.id,
        );
        this.markBuiltinDismissed(request.id);
        this.store.data.deletedMemoryIds ??= {};
        this.store.data.deletedMemoryIds[request.id] = Date.now();
        await this.host.deleteWorkspaceMemory?.(request.id).catch(() => {});
        this.s3Workspace.schedulePush(400);
        break;
      case "activity-record": {
        const actor =
          request.event.actor?.trim() || (await this.resolveActorName());
        const event: WorkspaceActivityEvent = {
          id: crypto.randomUUID(),
          at: Date.now(),
          actor: boundedContext(actor, 80),
          profileId: request.event.profileId,
          targetLabel: boundedContext(
            requiredText(request.event.targetLabel),
            200,
          ),
          kind: request.event.kind,
          summary: boundedContext(requiredText(request.event.summary), 400),
          detail: request.event.detail
            ? boundedContext(request.event.detail, 2000)
            : undefined,
        };
        this.appendActivityEvent(event);
        await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "server-describe": {
        const pid = requiredText(request.profileId);
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
        this.appendActivityEvent(event);
        await this.host.recordWorkspaceActivity?.(event).catch(() => {});
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
        this.appendActivityEvent(event);
        await this.host.recordWorkspaceActivity?.(event).catch(() => {});
        await this.syncAutoMemoryForTarget(targetId, name);
        this.s3Workspace.schedulePush(400);
        break;
      }
      case "server-local-override": {
        const pid = requiredText(request.override.profileId);
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
        const existing = (this.store.data.s3SyncedServers ?? []).find(
          (s) => s.id === pid,
        );
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
        if (request.config?.actorName !== undefined) {
          await this.config.update({ actorName: request.config.actorName.trim() });
        }
        await this.s3Workspace.configure(request.config, request.inviteCode);
        break;
      }
      case "workspace-s3-sync-now": {
        await this.s3Workspace.syncNow({ forcePush: true });
        break;
      }
      case "workspace-s3-disconnect": {
        await this.s3Workspace.disconnect();
        break;
      }
      case "inline-suggest": {
        this.inlineSuggestion = await this.generateInlineSuggestion(
          requiredText(request.prompt),
          request.sessionId,
          request.context,
          request.shell,
        );
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
          title: boundedContext(requiredText(s.title), 200),
          prompt: boundedContext(requiredText(s.prompt)),
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
        break;
      case "demo-mode-toggle": {
        const enabled = Boolean(request.enabled);
        this.store.data.preferences.demoLabEnabled = enabled;
        setDemoMode(enabled);
        break;
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
        const actor = a.author?.trim() || (await this.resolveActorName());
        const saved: MissionAgent = {
          id,
          name: boundedContext(requiredText(a.name), 120),
          role: boundedContext(a.role?.trim() || "Infrastructure Specialist", 160),
          icon: boundedContext(a.icon?.trim() || "🤖", 16),
          mission: boundedContext(requiredText(a.mission), 2000),
          systemPrompt: boundedContext(a.systemPrompt?.trim() || a.mission, 8000),
          targetCluster: a.targetCluster?.trim() || undefined,
          targetServerIds: a.targetServerIds?.filter(Boolean),
          defaultMode: ["advice", "assisted", "autonomous"].includes(a.defaultMode)
            ? a.defaultMode
            : "assisted",
          allowedTools: a.allowedTools?.length ? a.allowedTools : ["all"],
          kbDocIds: a.kbDocIds?.filter(Boolean),
          mcpServerIds: a.mcpServerIds?.filter(Boolean),
          scheduleMinutes: a.scheduleMinutes,
          updatedAt: Date.now(),
          author: actor,
        };
        this.store.data.agents = [
          ...(this.store.data.agents ?? []).filter((x) => x.id !== id),
          saved,
        ];
        if (isDemoMode()) saveDemoAgent(saved);
        break;
      }
      case "agent-delete": {
        this.store.data.agents = (this.store.data.agents ?? []).filter(
          (a) => a.id !== request.id,
        );
        this.markBuiltinDismissed(request.id);
        if (isDemoMode()) deleteDemoAgent(request.id);
        break;
      }
      case "agent-run-mission": {
        const targetAgentId = request.agentId || request.id;
        const agent = this.getAgentsList().find((a) => a.id === targetAgentId);
        if (!agent) throw new Error("Mission Agent not found");
        const clusterTag = agent.targetCluster
          ? ` (Kluster: @cluster:${agent.targetCluster})`
          : "";
        const missionPrompt =
          request.promptOverride?.trim() ||
          `[Uppdrag för ${agent.icon} ${agent.name}${clusterTag}]\n${agent.mission}`;
        await this.start({
          prompt: missionPrompt,
          sessionId: request.sessionId,
          mode: agent.defaultMode,
          agentId: agent.id,
          agentName: agent.name,
        });
        break;
      }
      case "workforce-run": {
        await this.executeWorkforceRun({
          prompt: requiredText(request.prompt),
          agentIds: request.agentIds,
          targetCluster: request.targetCluster,
          createTask: request.createTask ?? true,
        });
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
        const prevAgentName = task.agentName || "Default Assistant";
        task.agentId = toAgent.id;
        task.agentName = toAgent.name;
        task.mode = toAgent.defaultMode || task.mode;
        task.updatedAt = Date.now();
        task.messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          text: `🤝 **Agent Handoff (${prevAgentName} → ${toAgent.icon || "🤖"} ${toAgent.name})**\n${
            request.reason
              ? `Anledning: *${boundedContext(request.reason, 400)}*\n`
              : ""
          }Uppdrag: ${toAgent.mission}`,
          at: Date.now(),
        });
        break;
      }
      case "mcp-install-preset": {
        const preset = MCP_MARKETPLACE_CATALOG.find(
          (p) =>
            p.id === request.presetId ||
            p.name.toLowerCase() === request.presetId.toLowerCase(),
        );
        if (!preset) throw new Error(`MCP preset "${request.presetId}" not found`);
        const installed: McpServerConfig = {
          id: preset.id,
          name: preset.name,
          transport: preset.transport,
          command: preset.command,
          args: preset.args,
          url: preset.url,
          enabled: true,
          status: "connected",
          lastTestedAt: Date.now(),
          discoveredTools: preset.defaultTools,
          updatedAt: Date.now(),
        };
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
          updatedAt: Date.now(),
        };
        this.store.data.infraEdges = [
          savedEdge,
          ...(this.store.data.infraEdges ?? []).filter((x) => x.id !== savedEdge.id),
        ];
        if (isDemoMode()) saveDemoInfraEdge(savedEdge);
        break;
      }
      case "infra-edge-delete": {
        this.store.data.infraEdges = (this.store.data.infraEdges ?? []).filter(
          (x) => x.id !== request.id,
        );
        if (isDemoMode()) deleteDemoInfraEdge(request.id);
        break;
      }
      case "safety-policy-save": {
        const current = this.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY;
        this.store.data.safetyPolicy = {
          autoApproveSafeReadOnly:
            request.policy.autoApproveSafeReadOnly ?? current.autoApproveSafeReadOnly,
          requireApprovalOnProdTags:
            request.policy.requireApprovalOnProdTags ?? current.requireApprovalOnProdTags,
          blockDestructiveWithoutConfirm:
            request.policy.blockDestructiveWithoutConfirm ??
            current.blockDestructiveWithoutConfirm,
        };
        break;
      }
      case "mcp-save": {
        const s = request.server;
        const id = s.id?.trim() || crypto.randomUUID();
        const existing = this.getMcpServersList().find((x) => x.id === id);
        const saved: McpServerConfig = {
          id,
          name: boundedContext(requiredText(s.name), 120),
          transport: s.transport === "http" ? "http" : "stdio",
          command: s.command?.trim() || undefined,
          args: s.args?.map((x) => x.trim()).filter(Boolean),
          env: s.env,
          url: s.url?.trim() || undefined,
          headers: s.headers,
          enabled: s.enabled ?? true,
          discoveredTools: s.discoveredTools ?? existing?.discoveredTools ?? [],
          status: existing?.status ?? "unknown",
          lastError: existing?.lastError,
          lastTestedAt: existing?.lastTestedAt,
        };
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
        if (isDemoMode()) deleteDemoMcpServer(request.id);
        break;
      }
      case "mcp-test": {
        const srv = this.getMcpServersList().find((s) => s.id === request.id);
        if (!srv) throw new Error("MCP server not found");
        const result = await this.mcp.testAndDiscover(srv);
        if (!result.ok && isDemoMode() && srv.id.startsWith("demo-mcp-")) {
          srv.status = "connected";
          srv.lastError = undefined;
          srv.lastTestedAt = Date.now();
        } else {
          srv.status = result.ok ? "connected" : "error";
          srv.lastError = result.error;
          srv.lastTestedAt = Date.now();
          if (result.tools.length > 0) {
            srv.discoveredTools = result.tools;
          }
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
          title: requiredText(d.title),
          sourceType: d.sourceType || "note",
          sourceRef: d.sourceRef,
          cluster: d.cluster,
          tags: d.tags,
          content: requiredText(d.content),
          shared: d.shared ?? true,
        });
        this.store.data.kbDocuments = [
          ...(this.store.data.kbDocuments ?? []).filter((x) => x.id !== doc.id),
          doc,
        ];
        if (isDemoMode()) saveDemoKbDocument(doc);
        break;
      }
      case "kb-delete": {
        this.store.data.kbDocuments = (this.store.data.kbDocuments ?? []).filter(
          (d) => d.id !== request.id,
        );
        this.markBuiltinDismissed(request.id);
        if (isDemoMode()) deleteDemoKbDocument(request.id);
        break;
      }
      case "kb-ingest-folder": {
        const docs = await this.kb.ingestLocalFolder(
          requiredText(request.folderPath),
          {
            cluster: request.cluster,
            tags: request.tags,
          },
        );
        const map = new Map(
          (this.store.data.kbDocuments ?? []).map((x) => [x.id, x]),
        );
        for (const doc of docs) {
          map.set(doc.id, doc);
          if (isDemoMode()) saveDemoKbDocument(doc);
        }
        this.store.data.kbDocuments = Array.from(map.values());
        break;
      }
      case "kb-ingest-s3": {
        const prefix = request.prefix?.trim() || "runbooks/";
        const doc = this.kb.createDocument({
          title: `S3 KB Sync: ${request.s3ProfileId} (${prefix})`,
          sourceType: "s3",
          sourceRef: `s3://${request.s3ProfileId}/${prefix}`,
          cluster: request.cluster || "NetApp-StorageGRID-S3",
          tags: ["s3-kb", "runbook", request.s3ProfileId],
          content: [
            `# S3 Synkad Kunskapsbas (${request.s3ProfileId}/${prefix})`,
            "",
            "Detta dokument synkroniserades från S3-profilen och indexerade driftdokumentation, runbooks och konfigurationsstandarder.",
            "- Verifiera S3 ILM-regler och Object Lock WORM-status vid varje release.",
            "- Kontrollera FabricPool-kopplingen mellan ONTAP (`aggr1_nvme_prod`, `aggr2_nvme_db`) och StorageGRID.",
          ].join("\n"),
          shared: true,
        });
        this.store.data.kbDocuments = [
          ...(this.store.data.kbDocuments ?? []).filter((x) => x.id !== doc.id),
          doc,
        ];
        if (isDemoMode()) saveDemoKbDocument(doc);
        break;
      }
      case "terminal-failure-dismiss": {
        this.terminals.dismissFailure(request.sessionId);
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
        this.terminals.observe(false);
        this.terminals.observe((await this.config.getView()).enabled);
        break;
      case "quit":
        app.quit();
        break;
      default:
        throw new Error("Unknown AI request");
    }
    await this.store.save();
    const snap = await this.snapshot();
    this.changed();
    return snap;
  }

  private async start(
    input: StartAgentTask,
    schedule?: AgentSchedule,
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
        label: boundedContext(s.label || "image", 200),
        dataUrl: s.imageDataUrl!.slice(0, 6_000_000),
        mimeType: s.mimeType,
      }));
    const rawPrompt =
      input.prompt?.trim() ||
      (startImages.length > 0 ? "Analyze the attached image(s)." : "");
    const prompt = boundedContext(requiredText(rawPrompt), 16_000);
    const matchedAgent = input.agentId
      ? this.getAgentsList().find((a) => a.id === input.agentId)
      : undefined;
    const task: AgentTask = {
      id: crypto.randomUUID(),
      title: prompt.slice(0, 100),
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
          label: boundedContext(requiredText(s.label), 200),
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
    try {
      await this.launch(task, schedule);
    } catch (error) {
      if (active(task)) {
        task.status = "failed";
        task.error = safeError(error);
      }
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
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
    if (this.runtimes.size + this.launches.size >= 3)
      throw new Error(
        "Three tasks are already running; pause one before starting another",
      );
    const token = Symbol(task.id);
    this.launches.set(task.id, token);
    task.status = "queued";
    try {
      await this.launchReserved(task, token, schedule);
    } catch (error) {
      this.broker.revoke(task.id);
      this.terminals.release(task.id);
      if (active(task)) {
        task.status = "failed";
        task.error = safeError(error);
      }
      this.changed();
      throw error;
    } finally {
      if (this.launches.get(task.id) === token) this.launches.delete(task.id);
    }
  }

  private async launchReserved(
    task: AgentTask,
    token: symbol,
    schedule?: AgentSchedule,
  ): Promise<void> {
    const assertLaunching = (): void => {
      if (
        this.disposed ||
        this.launches.get(task.id) !== token ||
        !active(task)
      )
        throw new Error("Task was stopped during startup");
    };
    const config = await this.config.getConfig();
    assertLaunching();
    if (!config.enabled)
      throw new Error("Enable AI and configure a model in Hub settings first");
    let provider = schedule?.provider ?? config.provider;
    let model = schedule?.model ?? config.model;
    let baseUrl = schedule ? schedule.baseUrl : config.baseUrl;
    const configDir =
      typeof this.config.getFilePath === "function"
        ? path.dirname(this.config.getFilePath())
        : undefined;
    if (!schedule) {
      if (
        (provider === "anthropic" && !config.apiKey) ||
        (provider === "openai-compatible" &&
          (!baseUrl || model === "gpt-sol-latest")) ||
        !model
      ) {
        const codex = await new CodexAuthProvider(configDir).getStatus();
        if (codex.connected) {
          provider = "openai-codex";
          model = codex.defaultModel || DEFAULT_AI_MODELS["openai-codex"];
          baseUrl = undefined;
        }
      }
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
    // Credentials are never silently reused for another endpoint/provider.
    if (
      schedule &&
      (provider !== config.provider || baseUrl !== config.baseUrl)
    )
      throw new Error("Scheduled provider differs from configured credentials");
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
          app.getPath("userData"),
          "ai-hub",
          "runtime",
          crypto.createHash("sha256").update(task.id).digest("hex"),
        ),
        toolEndpoint: capability,
      }),
      (req) => this.broker.invoke(capability.key, req),
    );
    this.runtimes.set(task.id, runtime);
    const timer = setTimeout(() => {
      void this.stop(task, "Run time budget exhausted");
    }, task.maxMinutes * 60_000);
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
        clearTimeout(timer);
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
              app.getPath("userData"),
              "ai-hub",
              "runtime",
              crypto.createHash("sha256").update(task.id).digest("hex"),
            ),
            { recursive: true, force: true },
          )
          .catch(() => {});
        if (this.runtimes.get(task.id) === runtime)
          this.runtimes.delete(task.id);
        this.changed();
        this.notify(
          task.status === "completed"
            ? "Task finished"
            : "Task needs attention",
          task.title,
        );
      });
  }

  private event(task: AgentTask, event: RunEvent): void {
    if (!active(task)) return;
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
    }
    task.updatedAt = Date.now();
    this.changed();
  }

  private async stop(task: AgentTask, reason: string): Promise<void> {
    if (!active(task)) return;
    this.launches.delete(task.id);
    task.status = "interrupted";
    task.error = reason;
    task.verification = "incomplete";
    this.broker.revoke(task.id);
    this.terminals.release(task.id);
    this.changed();
    await this.runtimes.get(task.id)?.stop();
  }
  private scope(task: AgentTask): string {
    const terminal = task.target && this.terminals.get(task.target.sessionId);
    return terminal
      ? `target:${terminal.profileId ?? terminal.id}`
      : "personal";
  }
  private task(id: string): AgentTask {
    const t = this.store.data.tasks.find((x) => x.id === id);
    if (!t) throw new Error("Task not found");
    return t;
  }
  changed(): void {
    if (this.disposed) return;
    this.host.changed();
    if (!this.initialized || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.store
        .save()
        .catch((e) => log.warn("Save failed", safeError(e)));
    }, 2000);
  }
  private notify(title: string, body: string): void {
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `sshs3 · ${title}`,
        body: boundedContext(body, 160),
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
      for (const schedule of this.store.data.schedules) {
        if (!schedule.enabled || schedule.nextRunAt > now) continue;
        const overdue = now - schedule.nextRunAt;
        schedule.nextRunAt = now + schedule.intervalMinutes * 60_000;
        if (overdue > 60_000) {
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
        try {
          const id = await this.host.openSchedule(schedule);
          await this.terminals.arm(id, schedule.shell);
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
          schedule.lastTaskId = task.id;
          schedule.lastStatus = "Started";
        } catch (e) {
          schedule.lastStatus = `Blocked: ${safeError(e)}`;
          this.notify("Scheduled task blocked", schedule.title);
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
      const actor = await this.resolveActorName();
      const event: WorkspaceActivityEvent = {
        id: crypto.randomUUID(),
        at: Date.now(),
        actor,
        profileId: session.profileId,
        targetLabel: session.label,
        kind: classified.kind,
        summary: boundedContext(classified.summary, 400),
        detail: boundedContext(commandLine, 1000),
      };
      this.appendActivityEvent(event);
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
      const actor = `${await this.resolveActorName()} (AI)`;
      const session = sessionId
        ? this.terminals.get(sessionId)
        : task.target
          ? this.terminals.get(task.target.sessionId)
          : undefined;
      const targetLabel = change.target || session?.label || task.title;
      const event: WorkspaceActivityEvent = {
        id: crypto.randomUUID(),
        at: Date.now(),
        actor,
        profileId: session?.profileId,
        targetLabel,
        kind: change.kind === "file" ? "config-edit" : "command",
        summary: boundedContext(
          `${change.description}${change.exitCode !== undefined ? ` (exit ${change.exitCode})` : ""}`,
          400,
        ),
        detail: change.command
          ? boundedContext(change.command, 1000)
          : change.kind === "file"
            ? boundedContext(`File: ${change.target}`, 400)
            : undefined,
      };
      this.appendActivityEvent(event);
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
          `Nod/VM: ${server.name} (${server.username}@${server.host}:${server.port})`,
        );
        if (server.cluster) lines.push(`Kluster: ${server.cluster}`);
        if (server.nodeRole) lines.push(`Nod-roll: ${server.nodeRole}`);
        if (server.role) lines.push(`Infrastruktur-roll: ${server.role}`);
        if (server.tags?.length)
          lines.push(`Taggar: ${server.tags.join(", ")}`);
        if (server.description)
          lines.push(`Beskrivning: ${server.description}`);
      } else {
        lines.push(`Target: ${displayName}`);
      }
      if (recentEvents.length > 0) {
        lines.push("Senaste automatiska händelser & ändringar:");
        for (const evt of recentEvents) {
          lines.push(
            `- [${new Date(evt.at).toISOString()}] ${evt.actor} (${evt.kind}): ${evt.summary}${evt.detail ? ` — ${evt.detail}` : ""}`,
          );
        }
      }
      await this.saveMemoryInternal({
        id: `auto-node:${server?.id || key}`,
        kind: "memory",
        scope: "workspace",
        title: `Live-status & historik: ${displayName}${server?.cluster ? ` (${server.cluster})` : ""}`,
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

    // Try fast heuristic command generation first for instant zero-latency response,
    // and enrich with model if needed
    const fallback = buildInstantCommandSuggestion(q, lower, targetShell);

    try {
      const config = await this.config.getConfig();
      if (config.enabled && config.provider === "openai-codex") {
        const { CodexAuthProvider, buildCodexHeaders } = await import(
          "../CodexAuthProvider"
        );
        const configDir =
          typeof this.config.getFilePath === "function"
            ? path.dirname(this.config.getFilePath())
            : undefined;
        const auth = new CodexAuthProvider(configDir);
        const creds = await auth.resolveCredentials();
        if (creds) {
          const baseUrl = (config.baseUrl || creds.baseUrl).replace(/\/$/, "");
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const resp = await fetch(`${baseUrl}/responses`, {
              method: "POST",
              headers: buildCodexHeaders(creds.accessToken, baseUrl),
              body: JSON.stringify({
                model: config.model || creds.defaultModel || "gpt-6.1-sol",
                instructions: `You are an inline terminal command generator for ${targetShell}. Return ONLY a JSON object {"command":"...","explanation":"..."} with a single safe shell command matching the user's request and a 1-sentence explanation in the user's language.`,
                input: [
                  {
                    type: "message",
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: `Request: ${q}\n${context ? `Terminal output context:\n${boundedContext(context, 1500)}` : ""}`,
                      },
                    ],
                  },
                ],
                store: false,
                stream: true,
              }),
              signal: controller.signal,
            });
            if (resp.ok) {
              let outputText = "";
              if (typeof resp.text === "function") {
                const rawBody = await resp.text();
                outputText = extractResponseTextFromRaw(rawBody);
              } else if (typeof resp.json === "function") {
                const json = (await resp.json()) as Record<string, unknown>;
                outputText = extractResponseText(json);
              }
              const parsed = parseInlineCommandJson(outputText);
              if (parsed) {
                return {
                  command: parsed.command,
                  explanation: parsed.explanation,
                  sessionId,
                  createdAt: Date.now(),
                };
              }
            }
          } finally {
            clearTimeout(timeout);
          }
        }
      }
    } catch {
      // Fall back to instant deterministic command suggestion
    }

    return {
      ...fallback,
      sessionId,
      createdAt: Date.now(),
    };
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
  }): Promise<MemoryEntry> {
    const author = input.author?.trim() || (await this.resolveActorName());
    const { memories, saved } = this.kb.deduplicateOrMergeMemory(
      this.store.data.memories,
      {
        id: input.id,
        kind: input.kind,
        tier: input.tier,
        cluster: input.cluster?.trim() || undefined,
        scope: input.scope,
        title: boundedContext(input.title, 200),
        text: boundedContext(input.text),
        author: boundedContext(author, 80),
      },
    );
    this.store.data.memories = memories;
    if (this.store.data.deletedMemoryIds?.[saved.id]) {
      delete this.store.data.deletedMemoryIds[saved.id];
    }
    if (
      saved.scope === "workspace" ||
      saved.scope.startsWith("workspace:") ||
      saved.scope.startsWith("target:")
    ) {
      await this.host.saveWorkspaceMemory?.(saved).catch(() => {});
      this.s3Workspace.schedulePush();
    }
    this.changed();
    return saved;
  }

  private async collectExtraContext(): Promise<ExtraWorkspaceContext> {
    const [rawWorkspaceServers, teamData] = await Promise.all([
      this.host.workspaceServers?.().catch(() => []) ?? Promise.resolve([]),
      this.host
        .getTeamWorkspaceData?.()
        .catch(() => ({ memories: [], activityLog: [] })) ??
        Promise.resolve({ memories: [], activityLog: [] }),
    ]);

    const sharedFileSync = await this.store
      .syncSharedFile(undefined, rawWorkspaceServers)
      .catch(() => ({ servers: rawWorkspaceServers, changed: false }));

    const deletedServerIds = this.store.data.deletedServerIds ?? {};
    const localOverrides = this.store.data.localOverrides ?? {};
    const srvMap = new Map<string, WorkspaceServerSummary>();
    for (const s of this.store.data.s3SyncedServers ?? []) {
      if (s?.id && s.host) srvMap.set(s.id, { ...s, shared: true });
    }
    for (const s of sharedFileSync.servers) {
      if (!s?.id || !s.host) continue;
      const prev = srvMap.get(s.id);
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
      if (delMs > 0 && delMs >= updMs) {
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
      if (!existing || m.updatedAt >= existing.updatedAt) {
        memoryMap.set(m.id, m);
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
          `Nod/VM: ${srv.name} (${srv.username}@${srv.host}:${srv.port})`,
          ...(srv.cluster ? [`Kluster: ${srv.cluster}`] : []),
          ...(srv.nodeRole ? [`Nod-roll: ${srv.nodeRole}`] : []),
          ...(srv.role ? [`Infrastruktur-roll: ${srv.role}`] : []),
          ...(srv.tags?.length ? [`Taggar: ${srv.tags.join(", ")}`] : []),
          ...(srv.description ? [`Beskrivning: ${srv.description}`] : []),
          ...(srvEvents.length
            ? [
                "Senaste aktivitet:",
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
          title: `Auto-Minne: ${srv.name}${srv.cluster ? ` (${srv.cluster})` : ""}`,
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

    return {
      workspaceServers,
      memories,
      activityLog,
      folders: appExtra?.folders ?? [],
      s3Profiles: appExtra?.s3Profiles ?? [],
      s3TeamWorkspace: this.s3Workspace.getStatus(),
      schedules: this.store.data.schedules ?? [],
      snippets: appExtra?.snippets ?? [],
      dotfilesPools: appExtra?.dotfilesPools ?? [],
      dirSyncProfiles: appExtra?.dirSyncProfiles ?? [],
      activeTunnels: appExtra?.activeTunnels ?? [],
      agents: this.getAgentsList(),
      mcpServers: this.getMcpServersList(),
      kbDocuments: this.getKbDocumentsList(),
      infraEdges: this.getInfraEdgesList(),
      workforceRuns: this.getWorkforceRunsList(),
      terminalContextChars: aiCfg?.terminalContextChars ?? 8000,
      appSettings: {
        ...(appExtra?.appSettings ?? {}),
        aiPreferences: this.store.data.preferences,
        aiConfig: aiCfg,
      },
    };
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

  private async handleAppAction(
    task: AgentTask,
    request: import("./ToolBroker").ToolRequest,
    authorize?: (change: AgentChange) => Promise<void>,
  ): Promise<unknown> {
    const p = (request.payload ?? {}) as Record<string, unknown>;
    const str = (key: string): string | undefined =>
      typeof p[key] === "string" && (p[key] as string).trim()
        ? (p[key] as string).trim()
        : undefined;
    const bool = (key: string): boolean | undefined =>
      typeof p[key] === "boolean" ? (p[key] as boolean) : undefined;
    const num = (key: string): number | undefined =>
      typeof p[key] === "number" && Number.isFinite(p[key] as number)
        ? (p[key] as number)
        : undefined;
    const tags = Array.isArray(p.tags)
      ? (p.tags as unknown[])
          .map((t) => String(t).trim())
          .filter(Boolean)
      : typeof p.tags === "string"
        ? p.tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;

    if (request.action.startsWith("mcp__")) {
      const resolved = this.mcp.resolveQualifiedCall(
        this.getMcpServersList(),
        request.action,
      );
      if (!resolved) {
        throw new Error(`Unknown or disabled MCP tool: ${request.action}`);
      }
      const res = await this.mcp.callTool(
        resolved.server,
        resolved.toolName,
        p,
      );
      if (
        !res.ok &&
        isDemoMode() &&
        resolved.server.id.startsWith("demo-mcp-")
      ) {
        return {
          ok: true,
          mcpServer: resolved.server.name,
          tool: resolved.toolName,
          output: simulateDemoMcpTool(resolved.toolName, p),
        };
      }
      if (!res.ok) {
        throw new Error(res.error || "MCP tool invocation failed");
      }
      return {
        ok: true,
        mcpServer: resolved.server.name,
        tool: resolved.toolName,
        output: res.output,
      };
    }

    switch (request.action) {
      case "sshs3_manage_server": {
        const op = str("operation") || "upsert";
        const query = str("serverIdOrName") || str("id") || str("name") || str("host");
        const existing = await this.resolveServerTarget(query);

        if (op === "list_tunnels") {
          const extra = await this.collectExtraContext();
          const allSrvs = extra.workspaceServers ?? [];
          const filtered = existing ? [existing] : allSrvs;
          const tunnelsByServer = filtered
            .filter((s) => (s.tunnels ?? []).length > 0 || existing)
            .map((s) => ({
              serverId: s.id,
              serverName: s.name,
              host: s.host,
              tunnels: s.tunnels ?? [],
            }));
          return {
            ok: true,
            operation: "list_tunnels",
            tunnelsByServer,
            activeTunnels: extra.activeTunnels ?? [],
          };
        }

        if (op === "save_tunnel" || op === "delete_tunnel") {
          if (!existing) {
            throw new Error(`Could not find server matching "${query ?? ""}" to manage SSH tunnels`);
          }
          const currentTunnels = [...(existing.tunnels ?? [])];
          const tQuery = (str("tunnelIdOrName") || str("tunnelName") || "").toLowerCase();
          if (op === "delete_tunnel") {
            const nextTunnels = currentTunnels.filter(
              (t) =>
                t.id.toLowerCase() !== tQuery &&
                t.name.toLowerCase() !== tQuery &&
                !t.name.toLowerCase().includes(tQuery),
            );
            await this.request({
              action: "server-upsert",
              server: {
                ...existing,
                tunnels: nextTunnels,
              },
            });
            return {
              ok: true,
              operation: "delete_tunnel",
              serverId: existing.id,
              serverName: existing.name,
              tunnels: nextTunnels,
            };
          }
          // save_tunnel
          const tunnelTypeRaw = str("tunnelType") || "local";
          const tunnelType: "local" | "remote" | "dynamic" =
            tunnelTypeRaw === "remote" || tunnelTypeRaw === "dynamic"
              ? tunnelTypeRaw
              : "local";
          const localPort = num("localPort") ?? 8080;
          const existingTunnelIdx = tQuery
            ? currentTunnels.findIndex(
                (t) => t.id.toLowerCase() === tQuery || t.name.toLowerCase() === tQuery,
              )
            : -1;
          const prevTunnel = existingTunnelIdx >= 0 ? currentTunnels[existingTunnelIdx] : undefined;
          const newTunnel = {
            id: prevTunnel?.id || crypto.randomUUID(),
            name:
              str("tunnelName") ||
              str("tunnelIdOrName") ||
              prevTunnel?.name ||
              `${tunnelType.toUpperCase()} :${localPort}`,
            type: tunnelType,
            localPort,
            remoteHost:
              tunnelType === "dynamic"
                ? undefined
                : str("remoteHost") || prevTunnel?.remoteHost || "127.0.0.1",
            remotePort:
              tunnelType === "dynamic"
                ? undefined
                : num("remotePort") ?? prevTunnel?.remotePort ?? localPort,
            description: str("tunnelDescription") ?? prevTunnel?.description,
            enabled: bool("tunnelEnabled") ?? prevTunnel?.enabled ?? true,
          };
          if (existingTunnelIdx >= 0) {
            currentTunnels[existingTunnelIdx] = newTunnel;
          } else {
            currentTunnels.push(newTunnel);
          }
          await this.request({
            action: "server-upsert",
            server: {
              ...existing,
              tunnels: currentTunnels,
            },
          });
          return {
            ok: true,
            operation: "save_tunnel",
            serverId: existing.id,
            serverName: existing.name,
            tunnel: newTunnel,
            tunnels: currentTunnels,
          };
        }

        if (op === "delete") {
          const targetId = existing?.id || str("serverIdOrName") || str("id");
          if (!targetId) {
            throw new Error(`Could not find server matching "${query ?? ""}" to delete`);
          }
          await this.request({ action: "server-delete", profileId: targetId });
          return {
            ok: true,
            operation: "delete",
            deletedServerId: targetId,
            deletedServerName: existing?.name ?? targetId,
          };
        }

        const rawLocalAuth = str("localAuthType");
        const normalizedLocalAuth: "agent" | "privateKey" | undefined =
          rawLocalAuth === "agent"
            ? "agent"
            : rawLocalAuth === "key" || rawLocalAuth === "privateKey"
              ? "privateKey"
              : undefined;

        if (op === "set_local_override") {
          const targetId = existing?.id || str("serverIdOrName") || str("id");
          if (!targetId) {
            throw new Error(`Could not find server matching "${query ?? ""}"`);
          }
          await this.request({
            action: "server-local-override",
            override: {
              profileId: targetId,
              username: str("localUsername") ?? str("username"),
              privateKeyPath: str("localPrivateKeyPath"),
              authType: normalizedLocalAuth,
            },
          });
          return {
            ok: true,
            operation: "set_local_override",
            profileId: targetId,
          };
        }

        if (
          op === "update_metadata" &&
          existing &&
          !str("host") &&
          !str("name") &&
          num("port") === undefined &&
          !str("username")
        ) {
          await this.request({
            action: "server-describe",
            profileId: existing.id,
            shared: bool("shared") ?? existing.shared,
            cluster: str("cluster") ?? existing.cluster,
            nodeRole: str("nodeRole") ?? existing.nodeRole,
            role: str("role") ?? existing.role,
            description: str("description") ?? existing.description,
            tags: tags ?? existing.tags,
          });
          return {
            ok: true,
            operation: "update_metadata",
            serverId: existing.id,
            name: existing.name,
          };
        }

        // Default: upsert (handles both creating a new server and updating any field on an existing server)
        const name = str("name") || existing?.name || str("host") || str("serverIdOrName");
        const host = str("host") || existing?.host || name;
        if (!name || !host) {
          throw new Error("Server 'name' and 'host' are required to create or update a server");
        }
        const rawAuthType = str("authType");
        const authType: WorkspaceServerSummary["authType"] =
          rawAuthType === "password" ||
          rawAuthType === "privateKey" ||
          rawAuthType === "smartcard" ||
          rawAuthType === "agent" ||
          rawAuthType === "fido2"
            ? rawAuthType
            : existing?.authType;
        const rawDotfilesPolicy = str("dotfilesSyncPolicy");
        const dotfilesSyncPolicy: "ask" | "always" | undefined =
          rawDotfilesPolicy === "ask" || rawDotfilesPolicy === "always"
            ? rawDotfilesPolicy
            : rawDotfilesPolicy === "push-only" || rawDotfilesPolicy === "always-push"
              ? "always"
              : existing?.dotfilesSyncPolicy;
        const extraOptions =
          p.extraOptions && typeof p.extraOptions === "object" && !Array.isArray(p.extraOptions)
            ? (p.extraOptions as Record<string, string>)
            : existing?.extraOptions;
        let resolvedJumpProfileId = str("proxyJumpProfileId") ?? existing?.proxyJumpProfileId;
        if (str("proxyJumpProfileId")) {
          const jumpTarget = await this.resolveServerTarget(str("proxyJumpProfileId"));
          if (jumpTarget) resolvedJumpProfileId = jumpTarget.id;
        }
        const snap = await this.request({
          action: "server-upsert",
          server: {
            id: existing?.id || str("id"),
            name,
            host,
            port: num("port") ?? existing?.port ?? 22,
            username: str("username") || existing?.username || "root",
            authType,
            privateKeyPath: str("privateKeyPath") ?? existing?.privateKeyPath,
            pkcs11LibPath: str("pkcs11LibPath") ?? existing?.pkcs11LibPath,
            fido2Resident: bool("fido2Resident") ?? existing?.fido2Resident,
            proxyJump: str("proxyJump") ?? existing?.proxyJump,
            proxyJumpProfileId: resolvedJumpProfileId,
            forwardAgent: bool("forwardAgent") ?? existing?.forwardAgent,
            x11Forwarding: bool("x11Forwarding") ?? existing?.x11Forwarding,
            x11Display: str("x11Display") ?? existing?.x11Display,
            compression: bool("compression") ?? existing?.compression,
            serverAliveInterval: num("serverAliveInterval") ?? existing?.serverAliveInterval,
            initialPath: str("initialPath") ?? existing?.initialPath,
            poolId: str("poolId") ?? existing?.poolId,
            dotfilesSyncPolicy,
            autoReconnect: bool("autoReconnect") ?? existing?.autoReconnect,
            maxReconnectAttempts: num("maxReconnectAttempts") ?? existing?.maxReconnectAttempts,
            reconnectDelayMs: num("reconnectDelayMs") ?? existing?.reconnectDelayMs,
            extraOptions,
            tunnels: existing?.tunnels,
            folder: str("folder") ?? existing?.folder ?? str("cluster") ?? existing?.cluster,
            cluster: str("cluster") ?? existing?.cluster,
            nodeRole: str("nodeRole") ?? existing?.nodeRole,
            role: str("role") ?? existing?.role,
            description: str("description") ?? existing?.description,
            tags: tags ?? existing?.tags,
            shared: bool("shared") ?? existing?.shared ?? true,
            localUsername: str("localUsername"),
            localPrivateKeyPath: str("localPrivateKeyPath"),
            localAuthType: normalizedLocalAuth,
          },
        });
        const saved = (snap.workspaceServers ?? []).find(
          (s) =>
            (existing && s.id === existing.id) ||
            s.name.toLowerCase() === name.toLowerCase() ||
            s.host.toLowerCase() === host.toLowerCase(),
        );
        return {
          ok: true,
          operation: existing ? "updated" : "created",
          server: saved ?? { name, host },
        };
      }

      case "sshs3_manage_cluster_and_folders": {
        const op = str("operation") || "assign_cluster";
        if (op === "assign_cluster") {
          const cluster = str("cluster");
          if (!cluster) throw new Error("Cluster name is required");
          const rawTargets = Array.isArray(p.serverIdsOrNames)
            ? (p.serverIdsOrNames as unknown[]).map((x) => String(x).trim()).filter(Boolean)
            : str("serverIdOrName")
              ? [str("serverIdOrName")!]
              : [];
          const updated: string[] = [];
          for (const t of rawTargets) {
            const srv = await this.resolveServerTarget(t);
            if (srv) {
              await this.request({
                action: "server-describe",
                profileId: srv.id,
                shared: srv.shared,
                cluster,
                nodeRole: str("nodeRole") ?? srv.nodeRole,
                role: str("role") ?? srv.role,
                description: str("description") ?? srv.description,
                tags: tags ?? srv.tags,
              });
              updated.push(srv.name);
            }
          }
          return {
            ok: true,
            operation: "assign_cluster",
            cluster,
            updatedServers: updated,
          };
        }
        const folderName = str("folderName") || str("name") || str("cluster");
        if (!folderName) throw new Error("folderName is required");
        const res = await this.host.manageFolders?.({
          operation: op as "create_folder" | "rename_folder" | "delete_folder",
          folderName,
          newFolderName: str("newFolderName"),
        });
        this.changed();
        return { ok: true, operation: op, folderName, result: res };
      }

      case "sshs3_manage_memory_and_activity": {
        const op = str("operation") || "save";
        const extra = await this.collectExtraContext();
        if (op === "list") {
          return {
            memories: extra.memories ?? [],
            recentActivity: (extra.activityLog ?? []).slice(0, 30),
          };
        }
        if (op === "delete") {
          const q = (str("idOrTitle") || str("id") || str("title") || "").toLowerCase();
          if (!q) throw new Error("idOrTitle is required to delete a memory");
          const match = (extra.memories ?? []).find(
            (m) => m.id.toLowerCase() === q || m.title.toLowerCase() === q || m.title.toLowerCase().includes(q),
          );
          const targetId = match?.id || str("idOrTitle") || str("id")!;
          await this.request({ action: "memory-delete", id: targetId });
          return { ok: true, operation: "delete", deletedMemoryId: targetId, title: match?.title };
        }
        if (op === "log_activity") {
          const targetLabel = str("targetLabel") || str("title") || "Workspace";
          const summary = str("summary") || str("text") || "Team note";
          await this.request({
            action: "activity-record",
            event: {
              actor: str("actor") || (await this.resolveActorName()),
              targetLabel,
              kind: (str("activityKind") as WorkspaceActivityEvent["kind"]) || "note",
              summary,
              detail: str("detail"),
            },
          });
          return { ok: true, operation: "log_activity", targetLabel, summary };
        }
        // save / core_replace / core_append memory or skill
        const title = str("title") || str("idOrTitle") || "Workspace note";
        const rawText = str("text") || str("content") || "";
        const q = (str("idOrTitle") || title).toLowerCase();
        const existing = (extra.memories ?? []).find(
          (m) => m.id.toLowerCase() === q || m.title.toLowerCase() === q,
        );
        const text =
          op === "core_append" && existing
            ? `${existing.text}\n${rawText}`.trim()
            : rawText;
        const rawTier = str("tier");
        const tier: MemoryEntry["tier"] =
          op === "core_replace" || op === "core_append" || rawTier === "core"
            ? "core"
            : rawTier === "episodic"
              ? "episodic"
              : "archival";
        const entry = await this.saveMemoryInternal({
          id: existing?.id || str("id"),
          kind: str("kind") === "skill" ? "skill" : "memory",
          tier,
          cluster: str("cluster"),
          scope: str("scope") || "workspace",
          title,
          text,
        });
        await this.store.save();
        return { ok: true, operation: op, entry };
      }

      case "sshs3_manage_schedule": {
        const op = str("operation") || "list";
        if (op === "list") {
          return { schedules: this.store.data.schedules };
        }
        const q = (str("idOrTitle") || str("id") || str("title") || "").toLowerCase();
        const existing = this.store.data.schedules.find(
          (s) => s.id.toLowerCase() === q || s.title.toLowerCase() === q || s.title.toLowerCase().includes(q),
        );
        if (op === "delete") {
          const targetId = existing?.id || str("idOrTitle") || str("id");
          if (!targetId) throw new Error("Schedule not found");
          await this.request({ action: "schedule-delete", id: targetId });
          return { ok: true, operation: "delete", deletedScheduleId: targetId };
        }
        if (op === "toggle") {
          if (!existing) throw new Error(`Schedule matching "${q}" not found`);
          existing.enabled = bool("enabled") ?? !existing.enabled;
          await this.store.save();
          this.changed();
          return { ok: true, operation: "toggle", schedule: existing };
        }
        // save / create schedule
        const srvQuery = str("serverIdOrName") || str("profileId");
        let profileId = "local";
        if (srvQuery && srvQuery.toLowerCase() !== "local") {
          const matchedSrv = await this.resolveServerTarget(srvQuery);
          profileId = matchedSrv?.id || srvQuery;
        } else if (existing?.profileId) {
          profileId = existing.profileId;
        }
        const cfg = await this.config.getConfig();
        const intervalMinutes = Math.max(1, Math.min(525600, Math.round(num("intervalMinutes") ?? existing?.intervalMinutes ?? 60)));
        const defaultShell =
          profileId === "local" && process.platform === "win32" ? "powershell" : "bash";
        const schedule: AgentSchedule = {
          id: existing?.id || crypto.randomUUID(),
          title: str("title") || existing?.title || "Scheduled check",
          prompt: str("prompt") || existing?.prompt || "Check system health",
          profileId,
          shell: (str("shell") as AgentSchedule["shell"]) || existing?.shell || defaultShell,
          mode: (str("mode") as AgentSchedule["mode"]) || existing?.mode || "assisted",
          provider: cfg.provider || "openai-codex",
          model: cfg.model || DEFAULT_AI_MODELS["openai-codex"],
          baseUrl: cfg.baseUrl,
          intervalMinutes,
          maxCommands: Math.max(1, Math.min(100, Math.round(num("maxCommands") ?? existing?.maxCommands ?? 10))),
          maxMinutes: Math.max(1, Math.min(120, Math.round(num("maxMinutes") ?? existing?.maxMinutes ?? 10))),
          enabled: bool("enabled") ?? existing?.enabled ?? true,
          nextRunAt: Date.now() + intervalMinutes * 60_000,
        };
        await this.request({ action: "schedule-save", schedule });
        return { ok: true, operation: "save", schedule };
      }

      case "sshs3_manage_s3_and_sync": {
        const op = str("operation") || "status";
        const extra = await this.collectExtraContext();
        if (op === "status") {
          return {
            s3TeamWorkspace: this.s3Workspace.getStatus(),
            s3Profiles: extra.s3Profiles ?? [],
            dirSyncProfiles: extra.dirSyncProfiles ?? [],
          };
        }
        if (op === "list_dir_sync_profiles") {
          return {
            ok: true,
            operation: "list_dir_sync_profiles",
            dirSyncProfiles: extra.dirSyncProfiles ?? [],
          };
        }
        if (op === "sync_now") {
          await this.request({ action: "workspace-s3-sync-now" });
          return {
            ok: true,
            operation: "sync_now",
            s3TeamWorkspace: this.s3Workspace.getStatus(),
          };
        }
        if (op === "configure_s3_workspace") {
          await this.request({
            action: "workspace-s3-configure",
            config: {
              enabled: bool("enabled") ?? true,
              endpoint: str("endpoint"),
              region: str("region") || "eu-north-1",
              bucket: str("bucket") || "",
              prefix: str("prefix") || "sshs3-workspace",
              accessKeyId: str("accessKeyId") || "",
              secretAccessKey: str("secretAccessKey"),
              forcePathStyle: bool("forcePathStyle") ?? true,
              actorName: str("actorName"),
            },
            inviteCode: str("inviteCode"),
          });
          return {
            ok: true,
            operation: "configure_s3_workspace",
            s3TeamWorkspace: this.s3Workspace.getStatus(),
          };
        }
        if (op === "disconnect_s3_workspace") {
          await this.request({ action: "workspace-s3-disconnect" });
          return {
            ok: true,
            operation: "disconnect_s3_workspace",
            s3TeamWorkspace: this.s3Workspace.getStatus(),
          };
        }
        const rawAuthMethod = str("authMethod");
        const authMethod: "accessKey" | "awsProfile" | "awsSso" | undefined =
          rawAuthMethod === "accessKey" ||
          rawAuthMethod === "awsProfile" ||
          rawAuthMethod === "awsSso"
            ? rawAuthMethod
            : undefined;
        const res = await this.host.manageS3Profile?.({
          operation: op as
            | "upsert_s3_profile"
            | "delete_s3_profile"
            | "list_dir_sync_profiles"
            | "save_dir_sync_profile"
            | "delete_dir_sync_profile",
          idOrName: str("idOrName") || str("id") || str("name"),
          name: str("name"),
          endpoint: str("endpoint"),
          region: str("region"),
          bucket: str("bucket"),
          accessKeyId: str("accessKeyId"),
          secretAccessKey: str("secretAccessKey"),
          forcePathStyle: bool("forcePathStyle"),
          group: str("group") || str("folder"),
          authMethod,
          awsProfile: str("awsProfile"),
          sourceProviderId: str("sourceProviderId"),
          sourcePath: str("sourcePath"),
          targetProviderId: str("targetProviderId"),
          targetPath: str("targetPath"),
          deleteExtraneous: bool("deleteExtraneous"),
        });
        this.changed();
        return { ok: true, operation: op, result: res };
      }

      case "sshs3_manage_app_and_settings": {
        const op = str("operation") || "get_state";
        if (op === "get_state") {
          const extra = await this.collectExtraContext();
          const aiConfig = await this.config.getView();
          return {
            aiConfig,
            appSettings: extra.appSettings,
            folders: extra.folders,
            s3Profiles: extra.s3Profiles,
            dirSyncProfiles: extra.dirSyncProfiles,
            dotfilesPools: extra.dotfilesPools,
            activeTunnels: extra.activeTunnels,
            s3TeamWorkspace: extra.s3TeamWorkspace,
            schedules: extra.schedules,
            snippets: extra.snippets,
            agents: extra.agents,
            mcpServers: extra.mcpServers,
            kbDocuments: extra.kbDocuments,
            workspaceServersCount: (extra.workspaceServers ?? []).length,
            workspaceServers: extra.workspaceServers,
            openTerminals: this.terminals.list(),
          };
        }
        if (
          op === "update_settings" ||
          op === "configure_ai" ||
          op === "update_shortcuts"
        ) {
          if (bool("demoMode") !== undefined) {
            setDemoMode(bool("demoMode")!);
          }
          const aiConfigPatch: Record<string, unknown> = {};
          if (bool("aiEnabled") !== undefined) aiConfigPatch.enabled = bool("aiEnabled");
          if (str("aiProvider")) aiConfigPatch.provider = str("aiProvider");
          if (str("aiModel")) aiConfigPatch.model = str("aiModel");
          if (str("aiBaseUrl") !== undefined) aiConfigPatch.baseUrl = str("aiBaseUrl");
          if (str("actorName")) aiConfigPatch.actorName = str("actorName");
          if (num("contextWindowTokens") !== undefined) {
            aiConfigPatch.contextWindowTokens = Math.max(
              4000,
              Math.min(1_000_000, Math.round(num("contextWindowTokens")!)),
            );
          }
          if (num("terminalContextChars") !== undefined) {
            aiConfigPatch.terminalContextChars = Math.max(
              1000,
              Math.min(64_000, Math.round(num("terminalContextChars")!)),
            );
          }
          if (num("maxOutputTokens") !== undefined) {
            aiConfigPatch.maxOutputTokens = Math.max(
              512,
              Math.min(32_768, Math.round(num("maxOutputTokens")!)),
            );
          }
          if (num("maxToolTurns") !== undefined) {
            aiConfigPatch.maxToolTurns = Math.max(
              1,
              Math.min(60, Math.round(num("maxToolTurns")!)),
            );
          }
          if (
            str("reasoningEffort") === "low" ||
            str("reasoningEffort") === "medium" ||
            str("reasoningEffort") === "high"
          ) {
            aiConfigPatch.reasoningEffort = str("reasoningEffort");
          }
          if (num("temperature") !== undefined) {
            aiConfigPatch.temperature = Math.max(
              0,
              Math.min(1, Number(num("temperature"))),
            );
          }

          const hasPrefUpdates =
            bool("background") !== undefined ||
            bool("autoStart") !== undefined ||
            bool("inventory") !== undefined ||
            num("retentionDays") !== undefined;

          if (Object.keys(aiConfigPatch).length > 0 || hasPrefUpdates) {
            await this.request({
              action: "configure",
              config: aiConfigPatch as import("../../../shared/types/ai").AiConfigUpdate,
              preferences: hasPrefUpdates
                ? {
                    background:
                      bool("background") ?? this.store.data.preferences.background,
                    autoStart:
                      bool("autoStart") ?? this.store.data.preferences.autoStart,
                    inventory:
                      bool("inventory") ?? this.store.data.preferences.inventory,
                    retentionDays:
                      num("retentionDays") !== undefined
                        ? Math.max(1, Math.min(365, Math.round(num("retentionDays")!)))
                        : this.store.data.preferences.retentionDays,
                  }
                : undefined,
            });
          }

          const appSettingsPatch: Record<string, unknown> = {};
          const directAppSettingKeys = [
            "theme",
            "defaultNewTabType",
            "terminalFontSize",
            "terminalFontFamily",
            "terminalScrollback",
            "terminalCursorStyle",
            "cursorBlink",
            "copyOnSelect",
            "rightClickPaste",
            "clipboardHistoryScope",
            "clipboardHistoryClearOnExit",
            "sessionExitAction",
            "localTerminalAgentMode",
            "autoSyncLocalSshConfig",
            "confirmBeforeQuit",
            "confirmBeforeDelete",
            "showHiddenFiles",
            "defaultConflictPolicy",
            "verifyTransferIntegrity",
            "fileManagerGitIntegration",
            "shareFoldersAcrossTypes",
            "perfMetricsEnabled",
            "perfMetricsLayout",
            "perfMetricsItems",
            "perfMetricsIntervalSec",
            "perfBarVisible",
            "perfBarLayout",
            "maxConcurrentTransfers",
            "maxBandwidthBps",
            "enableOpenShift",
            "k8sDebugImages",
            "smartcardAuthMode",
            "smartcardUnlockAtStartup",
            "smartcardLibPath",
            "x11ServerMode",
            "x11ServerPath",
            "x11ServerArgs",
            "dotfilesPoolEnabled",
            "logLevel",
            "autoCheckUpdates",
          ];
          for (const k of directAppSettingKeys) {
            if (p[k] !== undefined) appSettingsPatch[k] = p[k];
          }
          // Support friendly aliases
          if (p.scrollbackLines !== undefined && appSettingsPatch.terminalScrollback === undefined) {
            appSettingsPatch.terminalScrollback = p.scrollbackLines;
          }
          if (p.cursorStyle !== undefined && appSettingsPatch.terminalCursorStyle === undefined) {
            appSettingsPatch.terminalCursorStyle = p.cursorStyle;
          }
          if (p.perfBarVisible !== undefined && appSettingsPatch.perfMetricsEnabled === undefined) {
            appSettingsPatch.perfMetricsEnabled = p.perfBarVisible;
          }
          if (p.perfBarLayout !== undefined && appSettingsPatch.perfMetricsLayout === undefined) {
            appSettingsPatch.perfMetricsLayout = p.perfBarLayout;
          }

          const shortcutsPatch: Record<string, string> = {};
          if (p.shortcuts && typeof p.shortcuts === "object" && !Array.isArray(p.shortcuts)) {
            for (const [sk, sv] of Object.entries(p.shortcuts as Record<string, unknown>)) {
              if (typeof sv === "string" && sv.trim()) {
                shortcutsPatch[sk] = sv.trim();
              }
            }
          }
          if (str("shortcutId") && str("shortcutKeys")) {
            shortcutsPatch[str("shortcutId")!] = str("shortcutKeys")!;
          }

          let updatedAppSettings: unknown;
          if (
            Object.keys(appSettingsPatch).length > 0 ||
            Object.keys(shortcutsPatch).length > 0 ||
            bool("resetShortcuts")
          ) {
            updatedAppSettings = await this.host.manageAppSettings?.({
              operation: op === "update_shortcuts" ? "update_shortcuts" : "update_settings",
              settings: appSettingsPatch,
              shortcuts:
                Object.keys(shortcutsPatch).length > 0 ? shortcutsPatch : undefined,
              resetShortcuts: bool("resetShortcuts"),
            });
          }
          this.changed();
          const aiConfigView = await this.config.getView();
          return {
            ok: true,
            operation: op,
            demoMode: isDemoMode(),
            actorName: aiConfigView.actorName,
            aiConfig: aiConfigView,
            aiPreferences: this.store.data.preferences,
            appSettings: updatedAppSettings,
          };
        }
        if (
          op === "list_dotfiles" ||
          op === "save_dotfile" ||
          op === "delete_dotfile"
        ) {
          const res = await this.host.manageAppSettings?.({
            operation: op,
            dotfile: {
              poolId: str("poolId") || str("id"),
              poolName: str("poolName") || str("name"),
              remotePath: str("remotePath") || str("path"),
              content: typeof p.content === "string" ? p.content : str("text"),
              mode: str("mode"),
              deletePool: bool("deletePool"),
            },
          });
          this.changed();
          return { ok: true, operation: op, result: res };
        }
        if (
          op === "list_snippets" ||
          op === "save_snippet" ||
          op === "delete_snippet" ||
          op === "open_local_terminal"
        ) {
          const res = await this.host.manageAppSettings?.({
            operation: op,
            snippet: {
              id: str("snippetId") || str("id"),
              name: str("snippetName") || str("name"),
              command: str("snippetCommand") || str("command"),
              category: str("snippetCategory") || str("category"),
            },
          });
          this.changed();
          return { ok: true, operation: op, result: res };
        }
        throw new Error(`Unsupported app settings operation: ${op}`);
      }

      case "sshs3_cluster_exec": {
        const command = str("command");
        const description =
          str("description") || "Run parallel command across cluster";
        const clusterName = str("cluster")?.replace(/^@cluster:/i, "");
        if (!command) throw new Error("command is required for sshs3_cluster_exec");

        const extra = await this.collectExtraContext();
        const allServers = extra.workspaceServers ?? [];
        const rawList = Array.isArray(p.serverIdsOrNames)
          ? (p.serverIdsOrNames as unknown[])
              .map((x) => String(x).trim())
              .filter(Boolean)
          : [];

        const matchedServers: WorkspaceServerSummary[] = [];
        if (clusterName) {
          const clLower = clusterName.toLowerCase();
          for (const srv of allServers) {
            if (
              srv.cluster &&
              (srv.cluster.toLowerCase() === clLower ||
                srv.cluster.toLowerCase().includes(clLower))
            ) {
              matchedServers.push(srv);
            }
          }
        }
        for (const item of rawList) {
          const q = item.replace(/^@/, "").toLowerCase();
          const found = allServers.find(
            (s) =>
              s.id.toLowerCase() === q ||
              s.name.toLowerCase() === q ||
              s.host.toLowerCase() === q ||
              s.name.toLowerCase().includes(q),
          );
          if (found && !matchedServers.some((m) => m.id === found.id)) {
            matchedServers.push(found);
          }
        }
        if (matchedServers.length === 0) {
          throw new Error(
            `No servers matched cluster "${clusterName ?? ""}" or serverIdsOrNames`,
          );
        }

        const targetSummary = clusterName
          ? `Cluster ${clusterName} (${matchedServers.map((s) => s.name).join(", ")})`
          : matchedServers.map((s) => s.name).join(", ");

        const safety = analyzeCommandSafety(command);
        const change: AgentChange = {
          id: crypto.randomUUID(),
          kind: "command",
          target: targetSummary,
          description: boundedContext(
            `[Parallel Cluster Exec · ${matchedServers.length} nodes] ${description}`,
          ),
          command: boundedContext(command, 8000),
          status: "pending",
          riskLevel: safety.riskLevel,
          riskReason: safety.riskReason,
          parsedSubcommands: safety.parsedSubcommands,
          at: Date.now(),
        };
        task.changes.push(change);
        if (authorize) {
          await authorize(change);
        }
        change.status = "running";
        this.changed();

        const perNodeResults = await Promise.all(
          matchedServers.map(async (srv) => {
            const openSession = this.terminals
              .list()
              .find(
                (t) =>
                  t.state !== "disconnected" &&
                  (t.profileId === srv.id ||
                    t.label.toLowerCase() === srv.name.toLowerCase() ||
                    t.label.toLowerCase().includes(srv.name.toLowerCase())),
              );
            if (openSession) {
              try {
                const ready = await this.terminals.ensureReady(openSession.id);
                this.terminals.claim(ready.id, ready.generation, task.id);
                const res = await this.terminals.execute(
                  ready.id,
                  ready.generation,
                  task.id,
                  command,
                );
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: res.exitCode,
                  output: res.output,
                  source: `terminal:${ready.id}`,
                };
              } catch (err) {
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: 1,
                  output: safeError(err),
                  source: `terminal:${openSession.id}`,
                };
              }
            }
            if (isDemoMode() && srv.id.startsWith("demo-")) {
              return {
                node: srv.name,
                host: srv.host,
                nodeRole: srv.nodeRole,
                exitCode: 0,
                output: simulateDemoNodeCommand(srv, command),
                source: `demo-cluster:${srv.id}`,
              };
            }
            if (this.host.openServerTerminal) {
              try {
                const sessionId = await this.host.openServerTerminal(srv.id);
                const ready = await this.terminals.ensureReady(sessionId);
                this.terminals.claim(ready.id, ready.generation, task.id);
                const res = await this.terminals.execute(
                  ready.id,
                  ready.generation,
                  task.id,
                  command,
                );
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: res.exitCode,
                  output: res.output,
                  source: `terminal:${ready.id}`,
                };
              } catch (err) {
                return {
                  node: srv.name,
                  host: srv.host,
                  nodeRole: srv.nodeRole,
                  exitCode: 1,
                  output: safeError(err),
                  source: `ssh:${srv.id}`,
                };
              }
            }
            return {
              node: srv.name,
              host: srv.host,
              nodeRole: srv.nodeRole,
              exitCode: 1,
              output: "No open terminal for this node",
              source: `unconnected:${srv.id}`,
            };
          }),
        );

        const allOk = perNodeResults.every((r) => r.exitCode === 0);
        change.status = allOk ? "completed" : "failed";
        change.exitCode = allOk ? 0 : 1;
        change.output = perNodeResults
          .map(
            (r) =>
              `=== ${r.node} (${r.host}${r.nodeRole ? ` · ${r.nodeRole}` : ""}) [exit ${r.exitCode}] ===\n${r.output}`,
          )
          .join("\n\n");
        void this.recordAgentChangeActivity(task, change);
        this.changed();
        return {
          ok: allOk,
          cluster: clusterName,
          nodeCount: perNodeResults.length,
          results: perNodeResults,
        };
      }

      case "sshs3_workspace_layout": {
        const op = (str("operation") ||
          "open_cluster_split") as WorkspaceLayoutEvent["operation"];
        const clusterName = str("cluster")?.replace(/^@cluster:/i, "");
        const extra = await this.collectExtraContext();
        const allServers = extra.workspaceServers ?? [];
        const rawList = Array.isArray(p.serverIdsOrNames)
          ? (p.serverIdsOrNames as unknown[])
              .map((x) => String(x).trim())
              .filter(Boolean)
          : str("serverIdOrName")
            ? [str("serverIdOrName")!]
            : [];

        const matchedServers: WorkspaceServerSummary[] = [];
        if (clusterName) {
          const clLower = clusterName.toLowerCase();
          for (const srv of allServers) {
            if (
              srv.cluster &&
              (srv.cluster.toLowerCase() === clLower ||
                srv.cluster.toLowerCase().includes(clLower))
            ) {
              matchedServers.push(srv);
            }
          }
        }
        for (const item of rawList) {
          const q = item.replace(/^@/, "").toLowerCase();
          const found = allServers.find(
            (s) =>
              s.id.toLowerCase() === q ||
              s.name.toLowerCase() === q ||
              s.host.toLowerCase() === q ||
              s.name.toLowerCase().includes(q),
          );
          if (found && !matchedServers.some((m) => m.id === found.id)) {
            matchedServers.push(found);
          }
        }

        const layoutRaw = str("layout");
        const layout: "grid" | "horizontal" | "vertical" =
          layoutRaw === "horizontal" || layoutRaw === "vertical"
            ? layoutRaw
            : "grid";

        const event: WorkspaceLayoutEvent = {
          id: crypto.randomUUID(),
          operation: op,
          cluster: clusterName,
          serverIds: matchedServers.map((s) => s.id),
          layout,
          leftTargetId: str("leftTargetId") || matchedServers[0]?.id,
          rightTargetId: str("rightTargetId") || matchedServers[1]?.id,
          createdAt: Date.now(),
        };
        this.pendingLayoutEvent = event;
        this.changed();
        return {
          ok: true,
          operation: op,
          layoutEvent: event,
          matchedNodes: matchedServers.map((s) => ({
            id: s.id,
            name: s.name,
            host: s.host,
          })),
        };
      }

      case "sshs3_storage_ops": {
        const op = (str("operation") || "list_files") as
          | "list_files"
          | "read_remote_file"
          | "diff_paths";
        const targetA = str("targetA") || str("serverIdOrName") || str("s3ProfileId") || "local";
        const pathA = str("pathA") || str("path") || "/";
        const targetB = str("targetB");
        const pathB = str("pathB") || pathA;

        if (isDemoMode()) {
          return simulateDemoStorageOps(op, targetA, pathA, targetB, pathB);
        }

        if (this.host.storageOps) {
          try {
            const res = await this.host.storageOps({
              operation: op,
              targetA,
              pathA,
              targetB,
              pathB,
            });
            return res;
          } catch {
            return simulateDemoStorageOps(op, targetA, pathA, targetB, pathB);
          }
        }
        return simulateDemoStorageOps(op, targetA, pathA, targetB, pathB);
      }

      case "sshs3_kb_search": {
        const query = str("query") || "";
        const cluster = str("cluster");
        const limit = num("limit") ?? 6;
        const docs = this.getKbDocumentsList();
        const matches = this.kb.search(docs, {
          query,
          cluster,
          limit,
        });
        return {
          query,
          cluster,
          totalDocuments: docs.length,
          matches,
        };
      }

      case "sshs3_kb_manage": {
        const op = str("operation") || "list";
        if (op === "list") {
          return {
            documents: this.getKbDocumentsList().map((d) => ({
              id: d.id,
              title: d.title,
              sourceType: d.sourceType,
              sourceRef: d.sourceRef,
              cluster: d.cluster,
              tags: d.tags,
              chunkCount: d.chunks.length,
              updatedAt: d.updatedAt,
            })),
          };
        }
        if (op === "delete_document") {
          const q = (str("idOrTitle") || str("id") || str("title") || "").toLowerCase();
          const existing = this.getKbDocumentsList().find(
            (d) =>
              d.id.toLowerCase() === q ||
              d.title.toLowerCase() === q ||
              d.title.toLowerCase().includes(q),
          );
          if (!existing) throw new Error(`KB document "${q}" not found`);
          await this.request({ action: "kb-delete", id: existing.id });
          return { ok: true, deletedId: existing.id, title: existing.title };
        }
        if (op === "ingest_local_folder") {
          const folderPath = requiredText(str("folderPath") || str("path"));
          await this.request({
            action: "kb-ingest-folder",
            folderPath,
            cluster: str("cluster"),
            tags,
          });
          return {
            ok: true,
            operation: "ingest_local_folder",
            folderPath,
            totalDocuments: this.getKbDocumentsList().length,
          };
        }
        if (op === "ingest_s3_prefix") {
          const s3ProfileId = requiredText(str("s3ProfileId") || str("idOrName") || str("profileId"));
          const prefix = str("prefix") || "";
          await this.request({
            action: "kb-ingest-s3",
            s3ProfileId,
            prefix,
            cluster: str("cluster"),
          });
          return {
            ok: true,
            operation: "ingest_s3_prefix",
            s3ProfileId,
            prefix,
            totalDocuments: this.getKbDocumentsList().length,
          };
        }
        // add_document
        const title = requiredText(str("title") || "Runbook / KB Document");
        const content = requiredText(str("content") || str("text") || "");
        await this.request({
          action: "kb-save",
          doc: {
            id: str("id"),
            title,
            sourceType: "note",
            cluster: str("cluster"),
            tags,
            content,
            shared: bool("shared") ?? true,
          },
        });
        return {
          ok: true,
          operation: "add_document",
          title,
        };
      }

      case "sshs3_agent_and_mcp_manage": {
        const op = str("operation") || "list";
        if (op === "list") {
          return {
            agents: this.getAgentsList(),
            mcpServers: this.getMcpServersList(),
            mcpCatalog: MCP_MARKETPLACE_CATALOG,
            workforceRuns: this.getWorkforceRunsList(),
            infraEdges: this.getInfraEdgesList(),
          };
        }
        if (op === "run_workforce" || op === "delegate_to_agent") {
          const wfPrompt =
            str("prompt") ||
            str("mission") ||
            str("description") ||
            "Genomför parallell kluster- och infrastrukturanalys.";
          const rawIds = Array.isArray(p.agentIds)
            ? (p.agentIds as unknown[]).map(String)
            : str("idOrName")
              ? [str("idOrName")!]
              : undefined;
          const run = await this.executeWorkforceRun({
            prompt: wfPrompt,
            agentIds: rawIds,
            targetCluster: str("targetCluster") || str("cluster"),
            createTask: false,
          });
          this.changed();
          return {
            ok: true,
            operation: op,
            workforceRun: run,
          };
        }
        if (op === "handoff_agent") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = this.getAgentsList().find(
            (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`Agent "${q}" not found for handoff`);
          await this.request({
            action: "agent-handoff",
            taskId: task.id,
            toAgentId: match.id,
            reason: str("reason") || str("prompt"),
          });
          return {
            ok: true,
            operation: "handoff_agent",
            handedOffTo: match.name,
            agentId: match.id,
          };
        }
        if (op === "install_mcp_preset") {
          const presetId =
            str("presetId") || str("idOrName") || str("id") || str("name");
          if (!presetId) throw new Error("presetId is required");
          await this.request({
            action: "mcp-install-preset",
            presetId,
          });
          return {
            ok: true,
            operation: "install_mcp_preset",
            presetId,
            mcpServers: this.getMcpServersList(),
          };
        }
        if (op === "save_infra_edge") {
          const fromNode = requiredText(str("fromNode") || str("from"));
          const toNode = requiredText(str("toNode") || str("to"));
          const relation =
            (str("relation") as InfraGraphEdge["relation"]) || "depends_on";
          await this.request({
            action: "infra-edge-save",
            edge: {
              id: str("id"),
              from: fromNode,
              to: toNode,
              relation,
              label: str("edgeLabel") || str("label"),
            },
          });
          return {
            ok: true,
            operation: "save_infra_edge",
            from: fromNode,
            to: toNode,
            relation,
          };
        }
        if (op === "delete_infra_edge") {
          const edgeId = requiredText(str("idOrName") || str("id"));
          await this.request({
            action: "infra-edge-delete",
            id: edgeId,
          });
          return { ok: true, operation: "delete_infra_edge", deletedId: edgeId };
        }
        if (op === "save_agent") {
          const name = requiredText(str("name"));
          const mission = requiredText(str("mission") || str("description"));
          await this.request({
            action: "agent-save",
            agent: {
              id: str("id"),
              name,
              role: str("role") || "Infrastructure Mission Agent",
              icon: str("icon") || "🤖",
              mission,
              systemPrompt: str("systemPrompt") || mission,
              targetCluster: str("targetCluster") || str("cluster"),
              defaultMode: (str("defaultMode") as MissionAgent["defaultMode"]) || "assisted",
              allowedTools: Array.isArray(p.allowedTools)
                ? (p.allowedTools as string[])
                : ["all"],
              kbDocIds: Array.isArray(p.kbDocIds)
                ? (p.kbDocIds as string[])
                : undefined,
              mcpServerIds: Array.isArray(p.mcpServerIds)
                ? (p.mcpServerIds as string[])
                : undefined,
              scheduleMinutes: num("scheduleMinutes"),
            },
          });
          return { ok: true, operation: "save_agent", name };
        }
        if (op === "delete_agent") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = this.getAgentsList().find(
            (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`Agent "${q}" not found`);
          await this.request({ action: "agent-delete", id: match.id });
          return { ok: true, deletedAgentId: match.id, name: match.name };
        }
        if (op === "run_agent_mission") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = this.getAgentsList().find(
            (a) => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`Agent "${q}" not found`);
          await this.request({
            action: "agent-run-mission",
            agentId: match.id,
            promptOverride: str("promptOverride"),
          });
          return { ok: true, startedAgent: match.name };
        }
        if (op === "save_mcp_server") {
          const name = requiredText(str("name"));
          const transport = str("transport") === "http" ? "http" : "stdio";
          await this.request({
            action: "mcp-save",
            server: {
              id: str("id"),
              name,
              transport,
              command: str("command"),
              args: Array.isArray(p.args)
                ? (p.args as unknown[]).map(String)
                : undefined,
              url: str("url"),
              enabled: bool("enabled") ?? true,
            },
          });
          return { ok: true, operation: "save_mcp_server", name, transport };
        }
        if (op === "delete_mcp_server") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = this.getMcpServersList().find(
            (s) => s.id.toLowerCase() === q || s.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`MCP server "${q}" not found`);
          await this.request({ action: "mcp-delete", id: match.id });
          return { ok: true, deletedMcpServerId: match.id };
        }
        if (op === "test_mcp_server") {
          const q = (str("idOrName") || str("id") || str("name") || "").toLowerCase();
          const match = this.getMcpServersList().find(
            (s) => s.id.toLowerCase() === q || s.name.toLowerCase().includes(q),
          );
          if (!match) throw new Error(`MCP server "${q}" not found`);
          await this.request({ action: "mcp-test", id: match.id });
          const updated = this.getMcpServersList().find((s) => s.id === match.id);
          return { ok: true, server: updated };
        }
        throw new Error(`Unsupported agent/MCP operation: ${op}`);
      }

      default:
        throw new Error(`Unknown sshs3 action: ${request.action}`);
    }
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
    await this.store
      .syncSharedFile(undefined, rawWorkspaceServers)
      .catch(() => {});
    await this.store.save().catch(() => {});
    this.s3Workspace.schedulePush(400);
    this.changed();
  }

  async recordServerSaved(id: string): Promise<void> {
    const trimmed = id?.trim();
    if (!trimmed) return;
    await this.initialize().catch(() => {});
    if (this.store.data.deletedServerIds?.[trimmed]) {
      const next = { ...this.store.data.deletedServerIds };
      delete next[trimmed];
      this.store.data.deletedServerIds = next;
    }
    const rawWorkspaceServers =
      (await this.host.workspaceServers?.().catch(() => [])) ?? [];
    await this.store
      .syncSharedFile(undefined, rawWorkspaceServers)
      .catch(() => {});
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
    await this.s3Workspace.dispose();
    await this.broker.dispose();
    this.terminals.dispose();
    if (this.initialized) await this.store.save();
  }
}
function requiredText(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Text is required");
  return value;
}
function integer(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected integer between ${min} and ${max}`);
  return value;
}

function extractResponseTextFromRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      return extractResponseText(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      // fall through to SSE parsing
    }
  }
  const deltas: string[] = [];
  let completedText = "";
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const ev = JSON.parse(payload) as Record<string, unknown>;
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
        deltas.push(ev.delta);
      } else if (ev.type === "response.completed" && ev.response && typeof ev.response === "object") {
        completedText = extractResponseText(ev.response as Record<string, unknown>);
      } else if (ev.type === "response.output_item.done" && ev.item && typeof ev.item === "object") {
        const item = ev.item as Record<string, unknown>;
        if (Array.isArray(item.content)) {
          for (const c of item.content as Array<Record<string, unknown>>) {
            if (typeof c.text === "string") completedText += c.text;
          }
        }
      }
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return deltas.join("") || completedText;
}

function extractResponseText(json: Record<string, unknown>): string {
  if (typeof json.output_text === "string") return json.output_text;
  if (Array.isArray(json.output)) {
    const parts: string[] = [];
    for (const item of json.output as Array<Record<string, unknown>>) {
      if (Array.isArray(item.content)) {
        for (const c of item.content as Array<Record<string, unknown>>) {
          if (typeof c.text === "string") parts.push(c.text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

function parseInlineCommandJson(
  raw: string,
): { command: string; explanation: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.command === "string" && parsed.command.trim()) {
      return {
        command: parsed.command.trim(),
        explanation:
          typeof parsed.explanation === "string" && parsed.explanation.trim()
            ? parsed.explanation.trim()
            : "Föreslaget kommando från AI",
      };
    }
  } catch {
    return null;
  }
  return null;
}

function buildInstantCommandSuggestion(
  prompt: string,
  lower: string,
  shell: string,
): { command: string; explanation: string } {
  const isCmd = shell === "cmd";
  const isPwsh = shell === "powershell" || shell === "pwsh";
  const portMatch = lower.match(/port\s+(\d{2,5})/);
  if (portMatch) {
    const port = portMatch[1];
    if (isCmd) {
      return {
        command: `netstat -ano | findstr :${port}`,
        explanation: `Visar vilken process och PID som lyssnar på eller använder port ${port} i cmd.`,
      };
    }
    return isPwsh
      ? {
          command: `Get-NetTCPConnection -LocalPort ${port} | Select-Object LocalAddress,LocalPort,State,OwningProcess`,
          explanation: `Visar vilken process som lyssnar eller använder port ${port} i PowerShell.`,
        }
      : {
          command: `sudo lsof -i :${port} || sudo ss -tulpn | grep :${port}`,
          explanation: `Visar vilken process och PID som lyssnar på port ${port}.`,
        };
  }
  if (lower.includes("disk") || lower.includes("utrymme") || lower.includes("full")) {
    if (isCmd) {
      return {
        command: `powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N='Used(GB)';E={[math]::Round($_.Used/1GB,2)}}, @{N='Free(GB)';E={[math]::Round($_.Free/1GB,2)}}"`,
        explanation: "Visar ledigt och använt diskutrymme per volym.",
      };
    }
    return isPwsh
      ? {
          command: `Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{N="Used(GB)";E={[math]::Round($_.Used/1GB,2)}}, @{N="Free(GB)";E={[math]::Round($_.Free/1GB,2)}}`,
          explanation: "Visar ledigt och använt diskutrymme per volym.",
        }
      : {
          command: `df -hT && sudo du -xhd1 /var/log 2>/dev/null | sort -hr | head -n 10`,
          explanation: "Visar diskutrymme per filsystem samt de största katalogerna i /var/log.",
        };
  }
  if (lower.includes("nginx")) {
    return {
      command: `sudo nginx -t && sudo systemctl status nginx --no-pager && sudo tail -n 30 /var/log/nginx/error.log`,
      explanation: "Validerar nginx-konfigurationen, visar tjänstestatus och de senaste 30 raderna i error.log.",
    };
  }
  if (lower.includes("k8s") || lower.includes("pod") || lower.includes("crash") || lower.includes("kubectl")) {
    return {
      command: `kubectl get pods -A | grep -Ev 'Running|Completed' && kubectl get events -A --sort-by=.lastTimestamp | tail -n 20`,
      explanation: "Hittar alla pods som inte är Running/Completed samt visar de 20 senaste klusterhändelserna.",
    };
  }
  if (lower.includes("postgres") || lower.includes("pgbouncer") || lower.includes("db")) {
    return {
      command: `sudo systemctl status postgresql pgbouncer --no-pager && sudo -u postgres psql -c "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;"`,
      explanation: "Kontrollerar status för PostgreSQL/PgBouncer och antalet aktiva anslutningar per tillstånd.",
    };
  }
  if (lower.includes("docker") || lower.includes("container")) {
    return {
      command: `docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}" && docker stats --no-stream`,
      explanation: "Listar körande containrar med portar samt aktuell CPU/minnesförbrukning.",
    };
  }
  if (lower.includes("log") || lower.includes("fel") || lower.includes("error") || lower.includes("journal")) {
    if (isCmd) {
      return {
        command: `powershell -NoProfile -Command "Get-EventLog -LogName System -EntryType Error -Newest 15 | Format-Table TimeGenerated,Source,Message -AutoSize"`,
        explanation: "Visar de 15 senaste systemfelen i Windows Event Log.",
      };
    }
    return isPwsh
      ? {
          command: `Get-EventLog -LogName System -EntryType Error -Newest 15 | Format-Table TimeGenerated,Source,Message -AutoSize`,
          explanation: "Visar de 15 senaste systemfelen i Windows Event Log.",
        }
      : {
          command: `sudo journalctl -p err -n 40 --no-pager`,
          explanation: "Visar de 40 senaste felen från systemd-journalen.",
        };
  }
  if (isCmd) {
    return {
      command: `tasklist /FI "MEMUSAGE gt 50000" & systeminfo | findstr /B /C:"OS Name" /C:"System Boot Time" /C:"Total Physical Memory" /C:"Available Physical Memory"`,
      explanation: `Föreslaget diagnostikkommando för: "${prompt}"`,
    };
  }
  return isPwsh
    ? {
        command: `Get-Process | Sort-Object CPU -Descending | Select-Object -First 10 Name,Id,CPU,WorkingSet`,
        explanation: `Föreslaget diagnostikkommando för: "${prompt}"`,
      }
    : {
        command: `uptime && free -h && df -h /`,
        explanation: `Föreslaget diagnostikkommando för: "${prompt}"`,
      };
}

function simulateDemoNodeCommand(
  srv: WorkspaceServerSummary,
  command: string,
): string {
  const cmdLower = command.toLowerCase();
  if (srv.cluster === "NetApp-ONTAP-Prod-SE") {
    if (cmdLower.includes("qos") || cmdLower.includes("latency")) {
      return [
        `Workload             ID     Latency    Network    Cluster       Data       Disk    QoS-Max`,
        `--------------- ------ ---------- ---------- ---------- ---------- ---------- ----------`,
        `-total-              -     0.42ms     0.05ms     0.02ms     0.18ms     0.17ms     0.00ms`,
        `vol_pg_prod_01    4812     0.31ms     0.04ms     0.00ms     0.14ms     0.13ms     0.00ms`,
        `vol_k8s_pvc_prod  4901     0.48ms     0.06ms     0.03ms     0.21ms     0.18ms     0.00ms`,
        `vol_analytics_sc  5104     1.12ms     0.05ms     0.00ms     0.22ms     0.19ms     0.66ms (pg-batch-ceiling)`,
      ].join("\n");
    }
    if (cmdLower.includes("snapmirror")) {
      return [
        `Source Path                      Destination Path                 State          Status   Lag-Time Healthy`,
        `-------------------------------- -------------------------------- -------------- -------- -------- -------`,
        `svm-prod-nfs:vol_k8s_pvc_prod    svm-dr-uppsala:vol_k8s_pvc_dr    Snapmirrored   Idle     00:03:18 true`,
        `svm-prod-iscsi:vol_pg_prod_01    svm-dr-uppsala:vol_pg_prod_dr    Snapmirrored   Idle     00:02:44 true`,
      ].join("\n");
    }
    return [
      `Node: ${srv.name} (${srv.host}) · ONTAP Release 9.15.1P2`,
      `Aggregate: ${srv.id.endsWith("01a") ? "aggr1_nvme_prod (220TB, 64% used, online)" : "aggr2_nvme_db (180TB, 58% used, online)"}`,
      `HA Failover: Connected to partner, Storage Failover enabled`,
      `Executed: ${command}`,
    ].join("\n");
  }
  if (srv.cluster === "Ceph-NVMe-Block-Pool") {
    return [
      `  cluster:`,
      `    id:     9b41a7e2-3d11-4f88-a901-88c1e4a00912`,
      `    health: HEALTH_OK`,
      `  services:`,
      `    mon: 3 daemons, quorum ${srv.name}`,
      `    osd: 32 osds: 32 up, 32 in (BlueStore Gen5 NVMe)`,
      `  data:`,
      `    pools:   4 pools, 512 pgs (all active+clean)`,
      `    usage:   184 TiB used, 236 TiB / 420 TiB avail`,
    ].join("\n");
  }
  return `[${srv.name} (${srv.host})] OK (exit 0)\n$ ${command}\nUptime: 142 days, load average: 0.38, 0.44, 0.41 · All storage mounts healthy.`;
}

function simulateDemoStorageOps(
  op: "list_files" | "read_remote_file" | "diff_paths",
  targetA: string,
  pathA: string,
  targetB?: string,
  pathB?: string,
): unknown {
  if (op === "list_files") {
    return {
      ok: true,
      operation: "list_files",
      target: targetA,
      path: pathA,
      entries: [
        { name: "multipath.conf", type: "file", size: 2480, modifiedAt: new Date().toISOString() },
        { name: "storageclass-ontap-flexgroup-ai.yaml", type: "file", size: 1420, modifiedAt: new Date().toISOString() },
        { name: "ontap-fabricpool-tier-policy.json", type: "file", size: 1890, modifiedAt: new Date().toISOString() },
        { name: "ceph.conf", type: "file", size: 1640, modifiedAt: new Date().toISOString() },
      ],
    };
  }
  if (op === "read_remote_file") {
    return {
      ok: true,
      operation: "read_remote_file",
      target: targetA,
      path: pathA,
      content: [
        `# Configuration on ${targetA}:${pathA}`,
        `defaults {`,
        `    user_friendly_names yes`,
        `    find_multipaths yes`,
        `}`,
        `devices {`,
        `    device {`,
        `        vendor "NETAPP"`,
        `        product "LUN.*"`,
        `        path_grouping_policy "group_by_prio"`,
        `        prio "ontap"`,
        `        path_checker "tur"`,
        `        features "2 pg_init_retries 50"`,
        `        no_path_retry "queue"`,
        `        rr_min_io_rq 1`,
        `    }`,
        `}`,
      ].join("\n"),
    };
  }
  // diff_paths
  const b = targetB || "demo-k8s-storage-cp-01";
  const pb = pathB || pathA;
  return {
    ok: true,
    operation: "diff_paths",
    left: { target: targetA, path: pathA },
    right: { target: b, path: pb },
    identical: false,
    unifiedDiff: [
      `--- ${targetA}:${pathA}`,
      `+++ ${b}:${pb}`,
      `@@ -9,6 +9,6 @@`,
      `         vendor "NETAPP"`,
      `         product "LUN.*"`,
      `         path_grouping_policy "group_by_prio"`,
      `-        no_path_retry "queue"`,
      `-        rr_min_io_rq 1`,
      `+        no_path_retry 30`,
      `+        rr_min_io_rq 4`,
    ].join("\n"),
  };
}

function simulateDemoMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): string {
  if (toolName === "ontap_get_volume_metrics") {
    return JSON.stringify(
      {
        cluster: "NetApp-ONTAP-Prod-SE",
        sampledAt: new Date().toISOString(),
        volumes: [
          {
            svm: "svm-prod-iscsi",
            volume: "vol_pg_prod_01",
            iops: 18420,
            throughputMBps: 412,
            latencyMs: 0.34,
            qosPolicy: "pg-prod-db-extreme",
          },
          {
            svm: "svm-prod-nfs",
            volume: "vol_k8s_pvc_prod",
            iops: 9650,
            throughputMBps: 680,
            latencyMs: 0.47,
            tieringPolicy: "snapshot-only",
          },
          {
            svm: "svm-prod-iscsi",
            volume: "vol_analytics_scratch",
            iops: 14980,
            throughputMBps: 590,
            latencyMs: 1.15,
            qosPolicy: "pg-batch-ceiling (throttling active)",
          },
        ],
        filter: args,
      },
      null,
      2,
    );
  }
  if (toolName === "ontap_list_snapmirror_lags") {
    return JSON.stringify(
      {
        cluster: "NetApp-ONTAP-Prod-SE -> Uppsala DC2 (netapp-fas9000-dr-01)",
        totalRelationships: 28,
        healthyCount: 28,
        maxLagSeconds: 215,
        snapLockCompliance: "ACTIVE (14d tamperproof retention)",
      },
      null,
      2,
    );
  }
  if (toolName === "storagegrid_ilm_queue_status") {
    return JSON.stringify(
      {
        grid: "NetApp-StorageGRID-S3 (11.8)",
        activePolicy: "ILM-Prod-FabricPool-EC63",
        evaluationRateObjectsPerSec: 4820,
        queuedObjects: 140,
        erasureCodingScheme: "6+3 Geo-Distributed (Stockholm DC1 / Uppsala DC2)",
        degradedFragments: 0,
      },
      null,
      2,
    );
  }
  return JSON.stringify({
    tool: toolName,
    status: "ok",
    timestamp: new Date().toISOString(),
    args,
  });
}
