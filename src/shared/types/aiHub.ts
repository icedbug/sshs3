import type { AiConfigView, AiConfigUpdate, AiProvider } from "./ai";
import type { WorkspaceActivityEvent } from "./teamVault";

export type { WorkspaceActivityEvent };

export type AgentMode = "advice" | "assisted" | "autonomous";
export type ShellKind =
  | "bash"
  | "zsh"
  | "fish"
  | "sh"
  | "dash"
  | "powershell"
  | "pwsh"
  | "cmd";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface TerminalSession {
  id: string;
  generation: string;
  label: string;
  kind: "local" | "ssh" | "k8s";
  profileId?: string;
  shell?: ShellKind;
  cwd?: string;
  state: "unknown" | "ready" | "busy" | "disconnected";
  owner?: string;
  updatedAt: number;
}
export interface ContextSource {
  id: string;
  label: string;
  text: string;
  observedAt: number;
}
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
}
export interface AgentChange {
  id: string;
  kind: "command" | "file";
  target: string;
  description: string;
  command?: string;
  before?: string;
  after?: string;
  status:
    | "pending"
    | "approved"
    | "denied"
    | "running"
    | "completed"
    | "failed"
    | "uncertain";
  output?: string;
  exitCode?: number;
  at: number;
}
export interface AgentTask {
  id: string;
  title: string;
  target?: { sessionId: string; generation: string; label: string };
  mode: AgentMode;
  status: RunStatus;
  messages: AgentMessage[];
  changes: AgentChange[];
  sources: ContextSource[];
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** Explicit command budget for this task; never inferred from model text. */
  maxCommands: number;
  maxMinutes: number;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  verification: "not-verified" | "verified" | "incomplete";
}
export interface MemoryEntry {
  id: string;
  kind: "memory" | "skill";
  scope: string;
  title: string;
  text: string;
  author?: string;
  updatedAt: number;
}
export interface WorkspaceServerSummary {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  folder?: string;
  group?: string;
  cluster?: string;
  nodeRole?: string;
  description?: string;
  role?: string;
  tags?: string[];
  shared: boolean;
  updatedAt?: string;
  updatedBy?: string;
}
export interface InlineCommandSuggestion {
  command: string;
  explanation: string;
  sessionId?: string;
  createdAt: number;
}
export interface InventoryEntry {
  id: string;
  kind: "ssh" | "s3" | "k8s";
  label: string;
  address: string;
  status: "unknown" | "reachable" | "unreachable" | "blocked";
  detail: string;
  observedAt: number;
}
export interface AgentSchedule {
  id: string;
  title: string;
  prompt: string;
  profileId: string;
  shell: ShellKind;
  intervalMinutes: number;
  nextRunAt: number;
  enabled: boolean;
  mode: AgentMode;
  model: string;
  provider: AiProvider;
  baseUrl?: string;
  maxCommands: number;
  maxMinutes: number;
  lastStatus?: string;
  lastTaskId?: string;
}
export interface HubPreferences {
  background: boolean;
  autoStart: boolean;
  inventory: boolean;
  retentionDays: number;
  sharedWorkspacePath?: string;
}
export interface HubSnapshot {
  preview?: ContextSource & { sessionId: string };
  config: AiConfigView;
  preferences: HubPreferences;
  runtime: { bundled: boolean; version?: string };
  sessions: TerminalSession[];
  tasks: AgentTask[];
  memories: MemoryEntry[];
  schedules: AgentSchedule[];
  inventory: InventoryEntry[];
  activityLog?: WorkspaceActivityEvent[];
  workspaceServers?: WorkspaceServerSummary[];
  inlineSuggestion?: InlineCommandSuggestion;
}
export interface StartAgentTask {
  prompt: string;
  sessionId?: string;
  mode: AgentMode;
  attachments?: ContextSource[];
  maxCommands?: number;
  maxMinutes?: number;
}
export type HubRequest =
  | { action: "snapshot" }
  | { action: "inspect"; sessionId: string }
  | { action: "resume"; taskId: string }
  | {
      action: "configure";
      config: AiConfigUpdate;
      preferences?: Partial<HubPreferences>;
    }
  | { action: "start"; task: StartAgentTask }
  | { action: "reply"; taskId: string; text: string; sessionId?: string }
  | { action: "stop"; taskId: string }
  | { action: "takeover"; sessionId: string }
  | { action: "arm"; sessionId: string; shell: ShellKind }
  | { action: "approve"; taskId: string; changeId: string; approved: boolean }
  | {
      action: "memory-save";
      entry: Omit<MemoryEntry, "id" | "updatedAt"> & { id?: string };
    }
  | { action: "memory-delete"; id: string }
  | {
      action: "activity-record";
      event: Omit<WorkspaceActivityEvent, "id" | "at"> & { id?: string; at?: number };
    }
  | {
      action: "server-describe";
      profileId: string;
      shared?: boolean;
      cluster?: string;
      nodeRole?: string;
      description?: string;
      role?: string;
      tags?: string[];
    }
  | {
      action: "server-upsert";
      server: {
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
      };
    }
  | {
      action: "inline-suggest";
      prompt: string;
      sessionId?: string;
      context?: string;
      shell?: string;
    }
  | {
      action: "schedule-save";
      schedule: Omit<AgentSchedule, "id" | "lastStatus" | "lastTaskId"> & {
        id?: string;
      };
    }
  | { action: "schedule-delete"; id: string }
  | { action: "inventory-refresh" }
  | { action: "forget-history" }
  | { action: "quit" };

export interface AiHubApi {
  aiHubRequest(request: HubRequest): Promise<HubSnapshot>;
  onAiHubChanged(listener: () => void): () => void;
}
export const HUB_CHANNEL = "ai-hub:request";
export const HUB_CHANGED = "ai-hub:changed";
export const SHELL_KINDS: ShellKind[] = [
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "powershell",
  "pwsh",
  "cmd",
];
