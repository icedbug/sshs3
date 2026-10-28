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
  InlineCommandSuggestion,
  LocalServerAuthOverride,
  MemoryEntry,
  S3WorkspaceConfig,
  StartAgentTask,
  TerminalSession,
  WorkspaceActivityEvent,
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
}

/** The Electron main process is the per-user background owner; renderer lifetimes confer no authority. */
export class HubService {
  readonly terminals = new TerminalRegistry();
  readonly store: HubStore;
  readonly config: AiConfigStore;
  readonly context: ContextService;
  readonly broker: ToolBroker;
  readonly s3Workspace: S3WorkspaceSyncService;
  private runtimes = new Map<string, AgentRuntime>();
  private launches = new Map<string, symbol>();
  private initialized?: Promise<void>;
  private tickTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;
  private lastInventory = 0;
  private previewId?: string;
  private inlineSuggestion?: InlineCommandSuggestion;
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

  async snapshot(): Promise<HubSnapshot> {
    await this.initialize();
    const manifest = await new HermesManager().getManifest();
    const preview = this.previewId && this.terminals.get(this.previewId);
    const extra = await this.collectExtraContext();
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
      config: await this.config.getView().catch((e) => {
        log.warn("Config view read failed in snapshot, using fallback", safeError(e));
        return {
          enabled: false,
          provider: "openai-codex" as const,
          model: "gpt-6.1-codex-max",
          useHermes: false,
          hasApiKey: false,
          keyStorage: "encrypted" as const,
        };
      }),
      preferences: this.store.data.preferences,
      runtime: {
        bundled: true,
        version: manifest?.tag ?? "native-ts-1.0",
      },
      sessions: this.terminals.list(),
      tasks: this.store.data.tasks,
      memories: extra.memories ?? this.store.data.memories,
      schedules: this.store.data.schedules,
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
        const text = boundedContext(requiredText(request.text), 16_000);
        if (active(task)) {
          await this.runtimes.get(task.id)?.steer(text);
          task.messages.push({
            id: crypto.randomUUID(),
            role: "user",
            text,
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
    const prompt = boundedContext(requiredText(input.prompt), 16_000);
    const task: AgentTask = {
      id: crypto.randomUUID(),
      title: prompt.slice(0, 100),
      mode: input.mode,
      status: "queued",
      target: terminal
        ? {
            sessionId: terminal.id,
            generation: terminal.generation,
            label: terminal.label,
          }
        : undefined,
      messages: [
        { id: crypto.randomUUID(), role: "user", text: prompt, at: now },
      ],
      changes: [],
      sources: (input.attachments ?? []).slice(0, 10).map((s) => ({
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
    scope: string;
    title: string;
    text: string;
    author?: string;
  }): Promise<MemoryEntry> {
    const id = input.id || crypto.randomUUID();
    const author = input.author?.trim() || (await this.resolveActorName());
    const entry: MemoryEntry = {
      id,
      kind: input.kind,
      scope: input.scope,
      title: boundedContext(input.title, 200),
      text: boundedContext(input.text),
      author: boundedContext(author, 80),
      updatedAt: Date.now(),
    };
    this.store.data.memories = this.store.data.memories.filter(
      (m) => m.id !== id,
    );
    if (this.store.data.deletedMemoryIds?.[id]) {
      delete this.store.data.deletedMemoryIds[id];
    }
    this.store.data.memories.push(entry);
    if (
      entry.scope === "workspace" ||
      entry.scope.startsWith("workspace:") ||
      entry.scope.startsWith("target:")
    ) {
      await this.host.saveWorkspaceMemory?.(entry).catch(() => {});
      this.s3Workspace.schedulePush();
    }
    this.changed();
    return entry;
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

    return {
      workspaceServers,
      memories,
      activityLog,
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
