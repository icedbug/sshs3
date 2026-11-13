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
  imageDataUrl?: string;
  mimeType?: string;
  observedAt: number;
}
export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  images?: Array<{ label: string; dataUrl: string; mimeType?: string }>;
  at: number;
}
/** One item of an agent's own task list for a job. */
export interface AgentTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked";
  /** What showed it done, or why it was dropped or waits for the user. */
  note?: string;
}
/** One step of an agent's plan for a change. */
export interface AgentPlanStep {
  /** What is done, in one sentence. */
  action: string;
  /** The server, cluster, file or service it is done to. */
  target?: string;
  /** The exact command, when the step is one. */
  command?: string;
  risk: "low" | "medium" | "high";
  /** How it will be shown to have worked: the command and what it should print. */
  check: string;
  /** How to undo it. Required for medium and high risk. */
  rollback?: string;
  /** sha256 of the exact command as proposed: a plan covers that command and no other. */
  commandHash?: string;
  /** Set when an approved plan's command has run without asking again. */
  ranAt?: number;
}
/**
 * A plan the agent proposes before changing anything. Nothing that changes a
 * system runs while a plan waits for the user's decision.
 */
/** Something that might explain what is wrong, and what was found for or against it. */
export interface AgentHypothesis {
  id: string;
  text: string;
  status: "open" | "confirmed" | "ruled-out";
  /** The hypothesis this one refines. */
  parentId?: string;
  evidence: { supports: boolean; text: string }[];
}
export interface AgentPlan {
  id: string;
  goal: string;
  steps: AgentPlanStep[];
  /** What the plan takes for granted and has not checked. */
  assumptions?: string[];
  status: "proposed" | "approved" | "rejected";
  /** How many times the agent has proposed a plan in this conversation. */
  revision: number;
  /** A second, read-only run's review of the plan; `unreviewed` when that run could not be had. */
  review: {
    verdict: "approve" | "revise" | "unreviewed";
    findings: string[];
  };
  createdAt: number;
  decidedAt?: number;
  /** What the user said when asking for changes. */
  decisionNote?: string;
}
/** One tool call an agent made, with what it got back (both masked and shortened). */
export interface AgentToolRecord {
  name: string;
  input: string;
  output: string;
  at: number;
}
/** What a person says should happen when a test case is run. */
export interface EvalExpectation {
  /** Words the answer must contain. */
  mention: string[];
  notMention: string[];
  /** A tool, or part of a command, the run must use (e.g. `sshs3_kb_search`, `zpool status`). */
  mustCall: string[];
  /** Part of a command the run must never try (e.g. `systemctl restart`). */
  mustNotRun: string[];
  /** The conclusion the answer should reach, in words; judged by a model. */
  conclusion?: string;
}
export interface EvalCheck {
  name: string;
  passed: boolean;
  detail?: string;
}
export interface EvalRun {
  at: number;
  model?: string;
  passed: boolean;
  checks: EvalCheck[];
  answer: string;
  calls: { name: string; input: string }[];
  /** Tool calls the case had no recording for. */
  unrecorded: number;
  /** Tool calls the replay asked for real instead of answering from the recording (the knowledge base). */
  live?: Record<string, number>;
  tokens: number;
}
/** A test for the agents, made from a real conversation and replayed without running anything. */
export interface EvalCase {
  id: string;
  title: string;
  prompt: string;
  mode: AgentMode;
  agentId?: string;
  fromTaskId?: string;
  /** What each tool answered when the conversation took place. */
  recorded: { name: string; input: string; output: string }[];
  expect: EvalExpectation;
  /** Newest first. */
  runs: EvalRun[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export type CommandRiskLevel = "safe" | "modify" | "destructive";

export interface SafetyPolicyConfig {
  autoApproveSafeReadOnly: boolean;
  requireApprovalOnProdTags: boolean;
  blockDestructiveWithoutConfirm: boolean;
}

export interface AgentChange {
  id: string;
  /** "setting": a change to sshs3's own rules that an agent asked for and only a person can let through. */
  kind: "command" | "file" | "setting";
  /** Moves the fence agents run inside: asked about in every mode, whatever the safety policy says. */
  guard?: boolean;
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
  riskLevel?: CommandRiskLevel;
  riskReason?: string;
  parsedSubcommands?: string[];
  /** A short name for this command within its conversation (c1, c2 …), so a report can point at it. */
  ref?: string;
  /** Who answered, when a person had to: their name, and when. Kept where the decision is made. */
  decidedBy?: { name: string; at: number; allowed: boolean };
  /** What the person said with their answer; the agent is given it. */
  decisionNote?: string;
  /** It has gone into the audit log in the state it ended in. */
  audited?: boolean;
  /**
   * On a change that carries its own proof: the read-only check that shows it
   * worked, and whether it passed before and after.
   */
  /**
   * `before`: whether the check already passed before the change (then passing
   * afterwards does not show that the change did it). `skipped`: why the check
   * was never looked at after the change.
   */
  check?: { command: string; expected: string; before?: boolean; after?: boolean; output?: string; skipped?: string };
  /**
   * The command that takes the change back, and what happened if it had to run.
   * `restored`: after the rollback the check reads as it did before the change.
   * `skipped`: why it did not run although the change did not hold.
   */
  rollback?: {
    command: string;
    ran?: boolean;
    exitCode?: number;
    output?: string;
    checkAfter?: boolean;
    restored?: boolean;
    skipped?: string;
  };
  /**
   * How it came to be allowed or refused: a person said so (see `decidedBy`),
   * the safety policy let it through or stopped it, an approved plan listed it,
   * nobody answered in time, or the run was stopped while it waited.
   */
  decidedHow?: "person" | "policy" | "plan" | "timeout" | "stopped";
  /** For a file: what changes, as a unified diff. */
  diff?: string;
  /** Secrets in what is shown here were masked: the shown text is not the exact text that ran. */
  hiddenValues?: boolean;
  /** sha256 of the exact command that runs, so that what was approved can be matched exactly. */
  commandHash?: string;
  at: number;
}
export interface AgentTask {
  id: string;
  title: string;
  agentId?: string;
  agentName?: string;
  target?: { sessionId: string; generation: string; label: string };
  mode: AgentMode;
  status: RunStatus;
  messages: AgentMessage[];
  changes: AgentChange[];
  sources: ContextSource[];
  /**
   * The tool calls of earlier runs of this conversation, newest last. Given
   * back to the model on the next reply, so it still knows what it looked up
   * and ran instead of only what it said.
   */
  toolLog?: AgentToolRecord[];
  /** The knowledge base pages this conversation opened, so its outcome can be put down to them. */
  kbPages?: string[];
  /** How many of `changes` have been put down to those pages already. */
  kbCounted?: number;
  /** What this run spent has been added to its agent's month. Counted once, wherever it ended. */
  usageCounted?: boolean;
  /** When learning last reflected on this run: it is reflected on once, not again every night. */
  reflectedAt?: number;
  /** A handover asked for while a run was going: made when that run ends, so its spending stays with the agent that spent it. */
  handoffTo?: { agentId: string; reason?: string };
  /** The recording of the terminal this run owned, when one was made. */
  recordingId?: string;
  /**
   * The run was asked for from outside sshs3 — by somebody's own agent over
   * MCP. Nobody is watching it here, so every command it asks for is put to a
   * person, whatever the command is and whatever the safety policy would
   * otherwise allow.
   */
  fromOutside?: boolean;
  /**
   * The agent's task list for this conversation, as it last wrote it. The run
   * is held to it: stopping with open items sends the agent back to work.
   */
  todos?: AgentTodo[];
  /** The plan the agent last proposed in this conversation, with the user's decision. */
  plan?: AgentPlan;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** Explicit command budget for this task; never inferred from model text. */
  maxCommands: number;
  maxMinutes: number;
  /** Actions counted against `maxCommands` in the current (or last) run. Every run starts again at 0. */
  commandsUsed?: number;
  /**
   * The last run ended because it used its command or time budget. Resuming
   * gives it the same budget again; cleared when the next run starts.
   */
  budgetStop?: { kind: "commands" | "minutes"; limit: number; at: number };
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** How much the model was sent at its last call in this conversation: how full its window was. Absent before the first run. */
  contextTokens?: number;
  verification: "not-verified" | "verified" | "incomplete";
  /**
   * Set on a read-only specialist run started by a workforce run. Such a task
   * is offered only read-only tools and is not listed as a conversation.
   */
  workforceRunId?: string;
  /**
   * Set on the tool-less run that proposes memories from one record
   * (a finished task, a stretch of team activity): that record's id. Not
   * listed as a conversation.
   */
  distillSourceId?: string;
  /** What might explain the problem at hand, as the agent last recorded it. */
  hypotheses?: AgentHypothesis[];
  /**
   * Set on an investigator: a read-only run that may also run commands, but
   * only ones classified as read-only, in a terminal of its own.
   */
  investigator?: boolean;
  /**
   * Set on a run that replays a test case: its tools answer from the case's
   * recording and nothing is executed. Not listed as a conversation.
   */
  evalCaseId?: string;
  /** Set on a run that works a ticket from the board: that ticket's id. */
  ticketId?: string;
  /** The model the task's latest run was started on. */
  model?: string;
  /** Set on a background run that is the second attempt, on the main model, after the fast model failed. */
  mainModelOnly?: boolean;
}
export interface MemoryEntry {
  id: string;
  kind: "memory" | "skill";
  tier?: "core" | "archival" | "episodic";
  cluster?: string;
  scope: string;
  title: string;
  text: string;
  author?: string;
  updatedCount?: number;
  confidence?: number;
  successCount?: number;
  failureCount?: number;
  usageCount?: number;
  feedbackScore?: number;
  /** Who said it was useful (1) or not (-1): one vote each, which can be changed but not repeated. */
  votes?: Record<string, 1 | -1>;
  autoLearned?: boolean;
  sourceCommand?: string;
  errorSignature?: string;
  /**
   * A newer memory said otherwise and took this one's place: its id. Kept as
   * history, shown under the newer one; never given to agents or found by search.
   */
  supersededBy?: string;
  /** When it was replaced. */
  supersededAt?: number;
  updatedAt: number;
}

/**
 * A memory the assistant suggests after reading a finished task or the team's
 * recent activity. It is not a memory yet: it is not given to agents and not
 * shared with the team until somebody accepts it.
 */
export interface MemoryProposal {
  id: string;
  /** `add` a new memory, or `update` the text of the existing memory `targetId`. */
  op: "add" | "update";
  targetId?: string;
  kind: "memory" | "skill";
  scope: string;
  title: string;
  text: string;
  /** For an update: the text it would replace. */
  previousText?: string;
  /** The part of the record the proposal rests on, as the model cited it. */
  evidence: string;
  sourceId: string;
  sourceTitle: string;
  createdAt: number;
  /**
   * Set once the suggestion has been saved (by the assistant itself when
   * memories are saved automatically, the default): the memory it became.
   * Such an entry is a record of what was learned, kept so it can be undone.
   */
  appliedMemoryId?: string;
}

/** The outcome of the latest memory proposal run. */
export interface MemoryDistillStatus {
  at: number;
  sourceTitle: string;
  proposed: number;
  error?: string;
}

export interface SelfLearningEvent {
  id: string;
  kind:
    | "failure_to_fix"
    | "task_reflexion"
    | "memory_consolidation"
    | "topology_discovery"
    | "user_feedback";
  title: string;
  summary: string;
  targetCluster?: string;
  confidence: number;
  memoryId?: string;
  createdAt: number;
}

/** What the team memory holds that the assistant wrote itself. Counts only: nothing here is a score. */
export interface SelfLearningStatus {
  totalLearnedSkills: number;
  /** Entries the assistant wrote from what it saw. */
  autoLearned: number;
  /** Skills that record a failure and the command that succeeded after it. */
  failureToFixPatterns: number;
  /** The mean of the confidence the entries carry. Absent when there is nothing to average. */
  averageConfidence?: number;
  lastReflectionAt?: number;
  recentEvents: SelfLearningEvent[];
}

export interface InfraGraphEdge {
  id: string;
  from: string;
  to: string;
  relation:
    | "depends_on"
    | "mounts_storage"
    | "routes_to"
    | "replicates_to"
    | "ssh_tunnel"
    | "monitors";
  label?: string;
  /** Suggested by an agent from what it observed; not given to agents as fact until a person confirms it. */
  proposed?: boolean;
  /** What the agent saw that made it suggest the link. */
  evidence?: string;
  proposedBy?: string;
  updatedAt: number;
}

export interface WorkforceStep {
  id: string;
  agentId: string;
  agentName: string;
  agentIcon?: string;
  role: string;
  targetCluster?: string;
  subTask: string;
  status: "queued" | "running" | "completed" | "failed";
  /** The specialist's own final answer; empty until its model run has finished. */
  findings: string;
  recommendedCommands?: string[];
  /** Measured wall-clock time of the specialist's run. */
  durationMs?: number;
  /** The agent task that produced `findings` (absent for scripted demo runs). */
  taskId?: string;
  error?: string;
}

export interface WorkforceRun {
  id: string;
  title: string;
  prompt: string;
  leadAgentName: string;
  targetCluster?: string;
  status: "running" | "completed" | "failed";
  steps: WorkforceStep[];
  synthesis: string;
  error?: string;
  /** True for the scripted demo-mode run: no model was called. */
  simulated?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpCatalogPreset {
  /** What the person has to fill in or have installed before it can connect. */
  needs?: string;
  id: string;
  name: string;
  category:
    | "observability"
    | "kubernetes"
    | "storage"
    | "database"
    | "gitops"
    | "security"
    | "network";
  icon: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  defaultTools: McpToolSummary[];
}
export interface LocalServerAuthOverride {
  profileId: string;
  username?: string;
  privateKeyPath?: string;
  authType?: "agent" | "privateKey";
}
export interface WorkspacePresenceTerminal {
  profileId?: string;
  targetLabel: string;
  state: "connected" | "ai-working";
  since: number;
}
export interface WorkspacePresenceEntry {
  actor: string;
  updatedAt: number;
  activeTerminals: WorkspacePresenceTerminal[];
}
export interface S3WorkspaceConfig {
  enabled: boolean;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  actorName?: string;
}
export interface S3WorkspaceSyncStatus {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  endpoint?: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  hasSecretAccessKey: boolean;
  forcePathStyle: boolean;
  lastSyncAt?: number;
  syncing?: boolean;
  error?: string;
  /** Set when this process never syncs with the bucket (demo mode): why. Also shown as `error` once a bucket is configured. */
  syncDisabledReason?: string;
  inviteCode?: string;
}
export interface WorkspaceServerSummary {
  id: string;
  /** Comes from an unlocked Team Vault: shared through the vault, never copied into the plain team bucket. */
  fromVault?: boolean;
  name: string;
  host: string;
  port: number;
  username: string;
  authType?: "password" | "privateKey" | "smartcard" | "agent" | "fido2";
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
  tunnels?: Array<{
    id: string;
    name: string;
    type: "local" | "remote" | "dynamic";
    localPort: number;
    remoteHost?: string;
    remotePort?: number;
    description?: string;
    enabled?: boolean;
  }>;
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
  deletedAt?: string;
  localUsername?: string;
  localPrivateKeyPath?: string;
  localAuthType?: "agent" | "privateKey";
}
export interface InlineCommandSuggestion {
  command: string;
  explanation: string;
  sessionId?: string;
  createdAt: number;
  /**
   * Where the command came from: the model, a skill the team has saved, or a
   * general check picked by keyword because no model answered. The terminal
   * says which, so that a canned check is not taken for an answer.
   */
  source?: "model" | "skill" | "fallback";
  /** How the command is classified, as any agent's command would be. */
  riskLevel?: CommandRiskLevel;
  riskReason?: string;
  /** More than one line: pasted only, never run with one key. */
  multiline?: boolean;
  /** May run with one key: one line, classified read-only. Anything else is pasted for the person to read. */
  runnable?: boolean;
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
  /**
   * The desktop app answering this person's own agent over MCP, on
   * 127.0.0.1. Off until they switch it on; `port` 0 means any free port.
   */
  localMcp?: { enabled: boolean; port?: number };
  /**
   * Whether the terminal an agent's run owns is recorded. On unless switched
   * off; recordings are kept as long as conversations are (`retentionDays`).
   */
  recordSessions?: boolean;
  autoStart: boolean;
  inventory: boolean;
  retentionDays: number;
  sharedWorkspacePath?: string;
  dismissedBuiltinIds?: string[];
  /**
   * Whether a finished agent task is read once more by the model to propose
   * team memories (one extra model call per task). On unless set to false.
   */
  proposeMemories?: boolean;
  /**
   * Whether what the assistant proposes to remember is saved and shared with
   * the team at once (on unless set to false), so the team's memory grows on
   * its own; each such memory can be undone. Off: a person accepts each one.
   */
  autoSaveMemories?: boolean;
  /**
   * Heartbeat: this app takes tickets in "todo" that have an agent and runs
   * them, one at a time, without being asked. Off unless switched on.
   */
  workforceAutopilot?: boolean;
  /**
   * How long an agent waits for a person to approve before it gives up, in
   * minutes (10 unless set; at most 60). The wait does not count against the
   * run's time budget.
   */
  approvalWaitMinutes?: number;
}

/** What was read from a server, without a model: see ServerFacts.ts. */
export interface ServerFacts {
  collectedAt: number;
  /** The system answered nothing the collection knows (a storage appliance with a shell of its own). */
  unsupported?: boolean;
  os?: { name: string; version: string; pretty: string };
  kernel?: string;
  hostname?: string;
  bootAt?: number;
  packageManager?: "dpkg" | "rpm" | "apk";
  packages?: Record<string, string>;
  failedServices: string[];
  runningServices: string[];
  listening: { proto: "tcp" | "udp"; address: string; port: number; process?: string }[];
  /** Addresses this server has connections to that it opened itself. */
  peers: string[];
  disks: { mount: string; fs: string; type: string; sizeKb: number; usedPct: number }[];
  certs: { path: string; subject?: string; notAfter: number }[];
  /** Watched files: path to SHA-256, or "unreadable" for a file that is there but may not be read. */
  files: Record<string, string>;
  rebootRequired?: boolean;
}
export interface FactChange {
  at: number;
  kind: "os" | "kernel" | "reboot" | "package" | "service" | "port" | "file" | "disk" | "cert";
  text: string;
}
export interface FactProblem {
  kind: "disk" | "cert" | "service" | "unreachable";
  /** Stable for the same problem on the same server, so it can be dismissed. */
  key: string;
  severity: "warning" | "critical";
  text: string;
  /** When it was first seen. */
  since?: number;
}
/** One server's facts as the interface gets them: the summary, not the package list. */
export interface ServerFactsView {
  serverId: string;
  name: string;
  /** ok: collected. unsupported: not a system the collection knows. failed: could not be reached or signed in to. never: not collected yet. */
  status: "ok" | "unsupported" | "failed" | "never";
  error?: string;
  collectedAt?: number;
  via?: "open-tab" | "own-connection" | "local" | "demo";
  os?: string;
  kernel?: string;
  bootAt?: number;
  rebootRequired?: boolean;
  packages?: number;
  listening?: number;
  services?: number;
  disks?: { mount: string; usedPct: number }[];
  problems: FactProblem[];
  /** Newest first. */
  changes: FactChange[];
}

export type NotifyChannelKind = "slack" | "teams" | "ntfy" | "webhook";
/** What can be sent to a channel: the kinds of inbox item, without knowledge base findings. */
export type NotifyEventKind = "approval" | "plan" | "question" | "blocked" | "alert" | "health" | "review" | "report";

/** A notification channel as the interface sees it: the address itself never leaves the main process. */
export interface NotifyChannelView {
  id: string;
  kind: NotifyChannelKind;
  name: string;
  /** The host of the address, to tell channels apart. */
  host: string;
  hasSecret: boolean;
  enabled: boolean;
  events: NotifyEventKind[];
  includeCommand: boolean;
  alertMinSeverity?: "info" | "warning" | "critical";
  last?: { at: number; ok: boolean; status?: number; error?: string };
}

/** A channel as it is saved from the form. `url` and `secret` are sent only when they are set or changed. */
export interface NotifyChannelInput {
  id?: string;
  kind: NotifyChannelKind;
  name: string;
  url?: string;
  secret?: string;
  enabled: boolean;
  events: NotifyEventKind[];
  includeCommand: boolean;
  alertMinSeverity?: "info" | "warning" | "critical";
}
export interface MissionAgent {
  id: string;
  name: string;
  role: string;
  mission: string;
  systemPrompt: string;
  icon?: string;
  targetCluster?: string;
  kbDocIds?: string[];
  mcpServerIds?: string[];
  allowedTools?: string[];
  defaultMode: AgentMode;
  /** A model of its own for this agent's runs, on the endpoint that is configured. */
  modelOverride?: string;
  /** The provider that model was chosen for. After a change of provider the override is let go. */
  modelProvider?: string;
  /** false: paused. A paused agent is given no tickets by the heartbeat. */
  enabled?: boolean;
  /**
   * Set when the agent is an external coding agent (Claude Code, Codex …)
   * reached over ACP: the id of a runner. The runner itself, a command and a
   * folder, is set up on each computer and is not shared.
   */
  runnerId?: string;
  /** The agent this one reports to in the workforce (an agent id). */
  reportsTo?: string;
  /** Tokens (in + out) this agent may spend on tickets per calendar month. 0 or unset: no limit. */
  monthlyTokenBudget?: number;
  author?: string;
  updatedAt: number;
}
/**
 * An external coding agent as it is started on this computer. Kept per
 * installation: a command that runs with the user's rights is not something a
 * teammate's app should receive from the bucket.
 */
export interface ExternalRunner {
  /** Stable id agents refer to, e.g. `claude-code`. The same id on every computer means the same agent. */
  id: string;
  name: string;
  command: string;
  args: string[];
  /** The folder the agent works in: the checkout of the code. */
  cwd?: string;
  updatedAt: number;
}
export interface ExternalRunnerPreset {
  id: string;
  name: string;
  command: string;
  args: string[];
  note: string;
}

export type WorkTicketStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "review"
  | "blocked"
  | "done";

/** What the workforce is working towards. Tickets hang on a goal. */
export interface WorkGoal {
  id: string;
  title: string;
  description?: string;
  status: "active" | "done";
  author?: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface WorkTicketComment {
  id: string;
  at: number;
  author: string;
  text: string;
}

/**
 * One piece of work on the team's board. With a team bucket the board is
 * shared; whoever's app is running takes a ticket by claiming it.
 */
export interface WorkTicket {
  id: string;
  title: string;
  description: string;
  goalId?: string;
  status: WorkTicketStatus;
  /** The agent that should do it. */
  assigneeAgentId?: string;
  /** Kept with the ticket so a teammate without that agent still sees who. */
  assigneeName?: string;
  /** A cluster or server the work is about. */
  target?: string;
  /** Tickets that have to be done first. */
  blockedBy?: string[];
  /** The ticket this one was split off from. */
  parentId?: string;
  /**
   * Where text on it came from outside the team (an MCP key, an alert), or
   * that it was made while working such a ticket. An agent's ticket that
   * carries it stays in Backlog until a person moves it: outside text never
   * starts work by itself, not even through a ticket an agent copied it into.
   */
  outside?: string;
  /** Set on a ticket an alert created: the alert, and how often it fired. */
  alert?: {
    fingerprint: string;
    /** What the alert is called wherever it fires (its rule's name, else its title): pages are noted as handling it by this. */
    name?: string;
    source: string;
    severity: "critical" | "warning" | "info";
    firstAt: number;
    lastAt: number;
    count: number;
    resolvedAt?: number;
    /** When the current firing began: the first time, or when it fired again after it had resolved. */
    firingSince?: number;
    /** The sender's own start of the current firing: a re-send carries the same one. */
    startsAt?: string;
  };
  /** When it came to the status it has now. Comments move `updatedAt`; this stays. */
  statusAt?: number;
  /** Who is running it: a person's app, since when, last seen. */
  claim?: { by: string; client: string; at: number; seenAt: number };
  /** The conversation of the latest run, on the computer that ran it. */
  taskId?: string;
  /** What the agent reported when it finished, or why it stopped. */
  result?: string;
  /** Tokens the runs of this ticket have used. */
  tokens?: number;
  comments?: WorkTicketComment[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

/** Tokens an agent has spent on tickets in one calendar month (`YYYY-MM`). */
export interface AgentUsage {
  month: string;
  tokens: number;
  runs: number;
}

export interface WorkforceTemplateSummary {
  id: string;
  title: string;
  description: string;
  roles: string[];
}

export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /**
   * The server said this tool only looks (`annotations.readOnlyHint`). It is
   * the server's own word, not a guarantee: it decides whether a person is
   * asked before the tool runs, never whether the tool may exist.
   */
  readOnly?: boolean;
}
export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  status?: "connected" | "disconnected" | "error" | "unknown";
  lastError?: string;
  lastTestedAt?: number;
  discoveredTools?: McpToolSummary[];
  updatedAt?: number;
}
export interface KbChunk {
  id: string;
  heading?: string;
  text: string;
}
export interface KbDocument {
  id: string;
  collection?: string;
  title: string;
  sourceType: "upload" | "folder" | "s3" | "manual" | "note" | "url" | "paste";
  sourceUri?: string;
  sourceRef?: string;
  targetCluster?: string;
  cluster?: string;
  tags?: string[];
  /**
   * The text. In a snapshot sent to the interface this is only the beginning
   * (see `contentLength`); the whole text comes with a `kb-read` request.
   */
  content: string;
  /** Empty in a snapshot; see `chunkCount`. */
  chunks: KbChunk[];
  chunkCount?: number;
  /** Length of the whole text, set on a snapshot's shortened copy. */
  contentLength?: number;
  shared?: boolean;
  updatedAt: number;
  author?: string;
  /** What the document is and when to open it, written when it was read. */
  summary?: string;
  kind?: "runbook" | "reference" | "architecture" | "incident" | "config" | "notes";
  /**
   * Where the reading that gives a dropped-in document its title, summary and
   * tags stands. Absent on a document a person wrote.
   */
  reading?: {
    state: "queued" | "reading" | "done" | "failed";
    attempts?: number;
    error?: string;
    at: number;
    /** The text changed since pages were written from it: they are brought in line with it, not added to. */
    revised?: boolean;
  };
  /** For a source with an address: when it was last fetched again, and what went wrong if it could not be. */
  sourceCheck?: { at: number; error?: string; failures?: number };
  /** The title is only the file's name or the link: the reading may replace it. */
  titleFromSource?: boolean;
  /** The file this text was taken from, kept beside it. */
  original?: { name: string; mime?: string; size: number };
  /** Set once the document was worked into the pages: when, and how many pages it touched. */
  compiled?: { at: number; pages: number };
  /** Hash of the text, so the same material is not added twice. */
  contentHash?: string;
  pages?: number;
}

export type KbPageKind = "system" | "procedure" | "troubleshooting";

/** What a page looked like before a change, kept so the change can be undone. */
export interface KbPageVersion {
  title: string;
  when: string;
  body: string;
  targets: string[];
  sources: KbPageSource[];
  keys?: string[];
  unverified?: { commands: string[]; citations: string[] };
}
export interface KbPageChange {
  at: number;
  /** A person's name, or "assistant". */
  by: string;
  /** What changed and why, in a line. */
  summary: string;
  /** Present on the newest changes only. */
  previous?: KbPageVersion;
}
export interface KbPageSource {
  /** A source document's id, or `task:<id>` for a session the page learned from. */
  docId: string;
  title: string;
  /** Hash of the source's text when the page was last held against it, and when that was. */
  hash?: string;
  at?: number;
}

/**
 * What the agents read: a page the assistant writes and keeps up to date from
 * the sources people drop in and from what was confirmed in finished work.
 * `when` is the line in the index every agent carries.
 */
export interface KbPage {
  id: string;
  kind: KbPageKind;
  title: string;
  /** When an agent should open this page. One line. */
  when: string;
  body: string;
  /** Clusters and servers of the workspace the page is about. Empty: general. */
  targets: string[];
  sources: KbPageSource[];
  revision: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
  /** A person changed the text: the assistant adds to it and does not rewrite it. */
  editedByPerson?: boolean;
  history: KbPageChange[];
  /**
   * What an agent would type when it needs this page: an error message as it
   * appears, the name of a command or a file. Search matches these like the
   * title; a question that found nothing becomes one when a person says which
   * page answers it.
   */
  keys?: string[];
  /**
   * What the assistant wrote that could not be found where it said it came
   * from: a command that is in none of the page's sources, a source it names
   * that the page does not rest on. Shown to the agent that opens the page
   * and listed for review; cleared when a person says they checked.
   */
  unverified?: { commands: string[]; citations: string[] };
  /** Alerts this page was worked from, by title: the next ticket for the same alert names the page. */
  alerts?: string[];
  /**
   * How the page was used, added up over the team's installations. Not part
   * of the stored page: use is not a change to its text (see `KbPageUse`).
   */
  opens?: number;
  lastOpenedAt?: number;
  /** Runs that opened it and whose change then passed its check. */
  proven?: number;
  lastProvenAt?: number;
}

/**
 * How one installation's runs used a page. Kept beside the pages and shared
 * per installation, so two computers never overwrite each other's count and
 * the page's text does not change because somebody read it.
 */
export interface KbPageUse {
  opens: number;
  lastOpenedAt?: number;
  proven?: number;
  lastProvenAt?: number;
  /** Runs that opened the page and then had to take a change back. Newest first. */
  rolledBack?: { at: number; title: string }[];
}

/** One line of the audit log, as the screen shows it. */
export interface AuditEntryView {
  seq: number;
  at: number;
  kind: string;
  actor: string;
  target?: string;
  what: string;
  outcome?: string;
  exitCode?: number;
  approvedBy?: string;
  taskId?: string;
  changeId?: string;
  detail?: string;
  hash: string;
}

/** Whether the audit log's chain holds, and where it does not. */
export interface AuditVerificationView {
  ok: boolean;
  entries: number;
  problem?: { seq: number; text: string };
  anchors?: { checked: number; held: number; coveredSeq?: number; lastAt?: number; gaps?: { from: number; to: number }[] };
  lastAt?: number;
}

/** Something about the knowledge base a person should look at. */
export interface KbFinding {
  id: string;
  kind:
    | "dead-target"
    | "lost-source"
    | "stale"
    | "unused"
    | "unused-source"
    | "gap"
    | "contradiction"
    | "unverified"
    | "rolled-back"
    | "source-changed"
    | "source-unreachable";
  pageId?: string;
  docId?: string;
  /** For a contradiction: the other page. */
  otherPageId?: string;
  text: string;
  detail?: string;
  at: number;
}

/** A question an agent asked the knowledge base that found nothing. */
export interface KbGap {
  id: string;
  query: string;
  agent?: string;
  target?: string;
  count: number;
  at: number;
}

/** One piece of a document that matched a search. */
export interface KbSearchHit {
  /** Set when the hit is a page the agents read, not a source. */
  pageId?: string;
  docId: string;
  title: string;
  collection: string;
  heading?: string;
  snippet: string;
  score: number;
}

/** What one request asked for, beside the snapshot. Present only on that request's answer. */
export interface HubReply {
  /** A new alert hook's address (the path on this server), shown this once. Empty where there is no address. */
  alertHook?: { path: string };
  /** Tickets an alert request created or updated. */
  alerts?: { created: string[]; updated: string[] };
  /** The conversation a request started, so that the interface opens that one and not "the newest". */
  started?: { taskId: string };
  /** The answer to `inline-suggest`. In the reply, not in shared state: two terminals may ask at once. */
  inlineSuggestion?: InlineCommandSuggestion;
  serverFacts?: { serverId: string; facts?: ServerFacts; changes: FactChange[] };
  /** Whether a test notification arrived. */
  notifyTest?: { ok: boolean; status?: number; error?: string };
  kbDocument?: KbDocument;
  kbPage?: KbPage;
  /** A key as it is shown once, when it is made, and never again. */
  mcpKey?: { token: string; key: unknown };
  audit?: { entries: AuditEntryView[]; verification: AuditVerificationView };
  /** `sealed`: it matches the hash the audit log kept when it was finished; false: it does not; absent: no seal (still being made, or older). */
  recording?: { id: string; cast: string; sealed?: boolean };
  kbSearch?: { query: string; hits: KbSearchHit[]; byMeaning: boolean };
  download?: { name: string; mime: string; dataBase64: string };
  /** `updated`: sources that were already there under the same address and got the new text. */
  ingest?: { added: string[]; duplicates: string[]; failed: { name: string; error: string }[]; updated?: string[] };
}
export interface TerminalCommandFailure {
  sessionId: string;
  label: string;
  command: string;
  exitCode?: number;
  snippet: string;
  outputSnippet?: string;
  at: number;
}
export interface WorkspaceLayoutEvent {
  id: string;
  operation:
    | "open_terminal"
    | "open_cluster_split"
    | "open_dual_pane_explorer";
  kind?: "open_terminal" | "open_cluster_split" | "open_dual_pane_explorer";
  serverIds: string[];
  cluster?: string;
  clusterName?: string;
  layout?: "grid" | "horizontal" | "vertical";
  leftTargetId?: string;
  rightTargetId?: string;
  leftTarget?: { type: "local" | "sftp" | "s3"; profileId?: string; path?: string };
  rightTarget?: { type: "local" | "sftp" | "s3"; profileId?: string; path?: string };
  createdAt: number;
  at?: number;
}
export interface HubSnapshot {
  preview?: ContextSource & { sessionId: string };
  config: AiConfigView;
  preferences: HubPreferences;
  /** Read-only: whether this process was started in demo mode (decided at launch, see main/demo/demoMode.ts). */
  demoMode?: boolean;
  runtime: { bundled: boolean; version?: string };
  sessions: TerminalSession[];
  tasks: AgentTask[];
  memories: MemoryEntry[];
  /** Memories the assistant suggests; nothing here is in use until accepted. */
  memoryProposals?: MemoryProposal[];
  /** True while a proposal run is reading a record. */
  memoryDistillRunning?: boolean;
  lastMemoryDistill?: MemoryDistillStatus;
  schedules: AgentSchedule[];
  inventory: InventoryEntry[];
  activityLog?: WorkspaceActivityEvent[];
  workspaceServers?: WorkspaceServerSummary[];
  s3Workspace?: S3WorkspaceSyncStatus;
  presence?: WorkspacePresenceEntry[];
  localOverrides?: Record<string, LocalServerAuthOverride>;
  agents?: MissionAgent[];
  mcpServers?: McpServerConfig[];
  mcpCatalog?: McpCatalogPreset[];
  reply?: HubReply;
  /** Whether alerts can be posted to this installation, and who gets which. */
  alertIntake?: {
    /** Whether this installation has an address to post to (the web server has, the desktop app has not). */
    canReceive: boolean;
    enabled: boolean;
    lastAt?: number;
    received: number;
    rules: { match: string; agentId: string }[];
  };
  /** Test cases for the agents. Recordings are left out here; `recordedCalls` says how many there are. */
  evalCases?: Array<Omit<EvalCase, "recorded"> & { recordedCalls: number }>;
  /** The id of the case being run right now. */
  evalRunning?: string;
  /** The latest nightly summary of what happened, until it has been read. */
  dailyReport?: { day: string; at: number; text: string; readAt?: number };
  /** Knowledge base work that goes on after the request that asked for it has returned. */
  kbWork?: {
    /** Pages being rewritten from their sources right now. */
    rebuilding: string[];
    checkingContradictions: boolean;
    /** How the last comparison of pages ended. */
    /** `compared` of `of`: how many pairs of pages the comparison read, of how many there are. */
    lastCheck?: { at: number; found: number; compared?: number; of?: number; error?: string };
    /** How the latest "Update from its sources" of a page ended. */
    rebuilt?: Record<string, { at: number; changed: boolean; error?: string }>;
  };
  /** What is read from the servers on a schedule, and what changed. */
  serverFacts?: {
    enabled: boolean;
    intervalHours: number;
    /** Servers left alone. */
    exclude: string[];
    /** Extra files to watch, beside the built-in list. */
    watchPaths: string[];
    servers: ServerFactsView[];
    /** Server ids being read right now. */
    collecting: string[];
  };
  /** Where notifications go when something starts to wait for a person. */
  notifications?: {
    channels: NotifyChannelView[];
    /** The address people reach this installation at, for links in notifications. Empty: notifications carry no link. */
    publicUrl: string;
    /** Set by the administrator (SSHS3_PUBLIC_URL); cannot be changed here. */
    publicUrlFixed: boolean;
    /** Minutes after which a waiting approval is told about once more. 0: never. */
    reminderMinutes: number;
  };
  /** The pages agents read. Bodies are shortened here; `kb-page-read` returns one in full. */
  /** The local MCP listener: whether it is on, where it answers, and this person's keys. */
  localMcp?: { enabled: boolean; address?: string; keys: unknown[]; error?: string };
  kbPages?: KbPage[];
  kbFindings?: KbFinding[];
  /** The queue of documents waiting to be read for title, summary and tags. */
  kbReading?: { waiting: number; reading?: string; failed: number; needsModel?: boolean };
  externalRunners?: ExternalRunner[];
  externalRunnerPresets?: ExternalRunnerPreset[];
  workGoals?: WorkGoal[];
  workTickets?: WorkTicket[];
  /** Per agent id: what it has spent on tickets this month. */
  agentUsage?: Record<string, AgentUsage>;
  workforceTemplates?: WorkforceTemplateSummary[];
  /** Whether the board is shared through the team bucket, and when it was last read. */
  workBoardSync?: { shared: boolean; lastSyncAt?: number; error?: string };
  kbDocuments?: KbDocument[];
  workforceRuns?: WorkforceRun[];
  infraEdges?: InfraGraphEdge[];
  safetyPolicy?: SafetyPolicyConfig;
  /** Who last changed the safety policy on this computer, and when. */
  safetyPolicyChanged?: { by: string; at: number };
  pendingLayoutEvent?: WorkspaceLayoutEvent;
  selfLearning?: SelfLearningStatus;
  contextBudget?: {
    contextWindowTokens: number;
    terminalContextChars: number;
    maxOutputTokens: number;
    maxToolTurns: number;
    reasoningEffort: string;
    temperature: number;
  };
}
export interface StartAgentTask {
  prompt: string;
  sessionId?: string;
  agentId?: string;
  agentName?: string;
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
  | {
      action: "reply";
      taskId: string;
      text: string;
      sessionId?: string;
      agentId?: string;
      attachments?: ContextSource[];
    }
  | { action: "stop"; taskId: string }
  | { action: "takeover"; sessionId: string }
  | { action: "arm"; sessionId: string; shell: ShellKind }
  | { action: "approve"; taskId: string; changeId: string; approved: boolean; note?: string }
  /**
   * The user's decision on the plan a conversation's agent proposed. Approved:
   * the agent carries it out, and the plan's listed commands run without
   * asking again (destructive ones still ask). Not approved: with a note the
   * agent revises the plan, without one the plan is simply dropped.
   */
  | { action: "plan-decide"; taskId: string; approved: boolean; note?: string }
  | {
      action: "memory-save";
      entry: Omit<MemoryEntry, "id" | "updatedAt"> & { id?: string };
    }
  | { action: "memory-delete"; id: string }
  | { action: "memory-feedback"; id: string; delta: 1 | -1; voter?: string }
  /** Saves a proposal as a memory (or applies its update), optionally with edited text. */
  | { action: "memory-proposal-accept"; id: string; title?: string; text?: string }
  | { action: "memory-proposal-reject"; id: string }
  /** Takes back a memory the assistant saved by itself: a new one is deleted, an updated one gets its earlier text. */
  | { action: "memory-proposal-undo"; id: string }
  /** Reads the team's recent activity and chat once and proposes memories from it. */
  | { action: "memory-distill-activity" }
  | { action: "self-learn-reflect"; targetCluster?: string }
  | {
      action: "agent-save";
      agent: Omit<MissionAgent, "id" | "updatedAt"> & { id?: string };
    }
  | { action: "agent-delete"; id: string }
  | {
      action: "agent-run-mission";
      id?: string;
      agentId?: string;
      sessionId?: string;
      promptOverride?: string;
    }
  | {
      action: "workforce-run";
      prompt: string;
      agentIds?: string[];
      targetCluster?: string;
      createTask?: boolean;
    }
  | {
      action: "agent-handoff";
      taskId: string;
      toAgentId: string;
      reason?: string;
    }
  | {
      action: "mcp-install-preset";
      presetId: string;
    }
  | {
      action: "infra-edge-save";
      edge: Omit<InfraGraphEdge, "id" | "updatedAt"> & { id?: string };
    }
  | {
      action: "infra-edge-delete";
      id: string;
    }
  | {
      action: "safety-policy-save";
      policy: Partial<SafetyPolicyConfig>;
    }
  | {
      action: "mcp-save";
      server: Omit<McpServerConfig, "id" | "updatedAt"> & { id?: string };
    }
  | { action: "mcp-delete"; id: string }
  | {
      action: "goal-save";
      goal: { id?: string; title: string; description?: string; status?: WorkGoal["status"] };
    }
  | { action: "goal-delete"; id: string }
  | {
      action: "ticket-save";
      ticket: {
        id?: string;
        title: string;
        description?: string;
        goalId?: string;
        status?: WorkTicketStatus;
        assigneeAgentId?: string;
        target?: string;
        /** Where it came from when that was outside the team. Only ever adds the mark. */
        outside?: string;
        blockedBy?: string[];
        parentId?: string;
      };
    }
  | { action: "ticket-move"; id: string; status: WorkTicketStatus }
  | { action: "ticket-delete"; id: string }
  | { action: "ticket-comment"; id: string; text: string }
  /** Claims the ticket and runs its agent on it now. */
  | { action: "ticket-start"; id: string; sessionId?: string }
  /** The person's verdict on a ticket in review: done, or back to the agent with a note. */
  | { action: "ticket-review"; id: string; approve: boolean; note?: string }
  | { action: "workforce-template-apply"; templateId: string; goalTitle?: string }
  | { action: "agent-pause"; id: string; paused: boolean }
  /** Makes (or replaces) the address alerts are posted to; it comes back once in `reply.alertHook`. */
  | { action: "alert-hook-create" }
  | { action: "alert-hook-disable" }
  | { action: "alert-rules-save"; rules: { match: string; agentId: string }[] }
  | { action: "daily-report-read" }
  /** Makes a test case from a finished conversation, or changes a case's title and expectations. */
  | { action: "eval-case-save"; id?: string; fromTaskId?: string; title?: string; expect?: Partial<EvalExpectation> }
  | { action: "eval-case-delete"; id: string }
  /** Replays one case, or all of them when no id is given. Nothing is executed. */
  | { action: "eval-run"; id?: string }
  | { action: "infra-edge-confirm"; id: string }
  | { action: "facts-configure"; enabled?: boolean; intervalHours?: number; exclude?: string[]; watchPaths?: string[] }
  /** Reads one server now, or every server that is due when no id is given. */
  | { action: "facts-collect-now"; serverId?: string }
  /** The whole of one server's facts, packages and all, for the reply. */
  | { action: "server-facts-read"; serverId: string }
  /** Dismisses one problem of a server, or all it has now when no key is given. They come back when they are new again. */
  | { action: "facts-problem-dismiss"; serverId: string; key?: string }
  | { action: "notify-channel-save"; channel: NotifyChannelInput }
  | { action: "notify-channel-delete"; id: string }
  /** Sends a test message to one channel and reports whether it arrived. */
  | { action: "notify-channel-test"; id: string }
  | { action: "notify-settings-save"; publicUrl?: string; reminderMinutes?: number }
  /** An alert pasted by hand: JSON as a monitoring system posts it, or text. */
  | { action: "alert-paste"; text: string }
  | { action: "runner-save"; runner: { id: string; name: string; command: string; args: string[]; cwd?: string } }
  | { action: "runner-delete"; id: string }
  | { action: "mcp-test"; id: string }
  | {
      action: "kb-save";
      doc: Omit<KbDocument, "id" | "updatedAt" | "chunks"> & {
        id?: string;
        chunks?: KbChunk[];
      };
    }
  | { action: "kb-delete"; id: string }
  /** One file as it was dropped in. */
  | { action: "kb-ingest-file"; name: string; mime?: string; dataBase64: string }
  /** `mask`: run the text through the secret masking first (a configuration file, a log). `sourceRef`: where it came from. */
  | { action: "kb-ingest-text"; text: string; title?: string; mask?: boolean; sourceRef?: string }
  | { action: "kb-ingest-url"; url: string }
  /** The whole document comes back in `reply.kbDocument`. */
  | { action: "kb-read"; id: string }
  /** The ranked search the assistant uses; hits come back in `reply.kbSearch`. */
  | { action: "kb-search"; query: string; limit?: number }
  /** The original file comes back in `reply.download`. */
  | { action: "kb-original"; id: string }
  /** Read the document again for title, summary and tags. */
  | { action: "kb-reread"; id: string }
  /** The whole page comes back in `reply.kbPage`. */
  | { action: "kb-page-read"; id: string }
  | {
      action: "kb-page-save";
      page: {
        id?: string;
        kind: KbPageKind;
        title: string;
        when: string;
        body: string;
        targets?: string[];
        /** Search phrases. Absent: the page keeps the ones it has. */
        keys?: string[];
        /** The alerts the page handles, by name. Absent: kept. */
        alerts?: string[];
      };
    }
  | { action: "kb-page-delete"; id: string }
  /** Takes back the newest change to the page. */
  | { action: "kb-page-undo"; id: string }
  /** Has the page written again from its sources. */
  | { action: "kb-page-rebuild"; id: string }
  /** Compares pages about the same systems and lists where they disagree. */
  | { action: "kb-check-contradictions" }
  | { action: "kb-finding-dismiss"; id: string }
  /** A question that found nothing is answered by this page: its words become one of the page's search phrases. */
  | { action: "kb-gap-answered"; id: string; pageId: string }
  /** The keys this person's own agents use to reach this app. The new key comes back once, in `reply.mcpKey`. */
  | { action: "mcp-key-list" }
  | { action: "mcp-key-create"; name: string; scopes: string[]; serverId?: string; expiresInDays?: number; tools?: string[] }
  | { action: "mcp-key-revoke"; id: string }
  /** Switches the local MCP listener on or off. */
  | { action: "mcp-local-set"; enabled: boolean; port?: number }
  /** The newest audit entries, and whether the chain holds, in `reply.audit`. */
  | { action: "audit-read"; limit?: number }
  /** The whole log with its verification, as a file in `reply.download`. */
  | { action: "audit-export" }
  /** One recording as asciicast text, in `reply.recording`. */
  | { action: "recording-read"; id: string }
  | {
      action: "kb-ingest-folder";
      folderPath: string;
      collection?: string;
      cluster?: string;
      targetCluster?: string;
      tags?: string[];
    }
  | {
      action: "kb-ingest-s3";
      s3ProfileId: string;
      prefix?: string;
      collection?: string;
      cluster?: string;
      targetCluster?: string;
    }
  | { action: "layout-event-ack"; id: string }
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
      localUsername?: string;
      localPrivateKeyPath?: string;
      localAuthType?: "agent" | "privateKey";
    }
  | {
      action: "server-upsert";
      server: {
        id?: string;
        name: string;
        host: string;
        port?: number;
        username: string;
        authType?: "password" | "privateKey" | "smartcard" | "agent" | "fido2";
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
        tunnels?: Array<{
          id: string;
          name: string;
          type: "local" | "remote" | "dynamic";
          localPort: number;
          remoteHost?: string;
          remotePort?: number;
          description?: string;
          enabled?: boolean;
        }>;
        folder?: string;
        cluster?: string;
        nodeRole?: string;
        role?: string;
        description?: string;
        tags?: string[];
        shared?: boolean;
        localUsername?: string;
        localPrivateKeyPath?: string;
        localAuthType?: "agent" | "privateKey";
      };
    }
  | {
      action: "server-local-override";
      override: LocalServerAuthOverride;
    }
  | {
      action: "server-delete";
      profileId: string;
    }
  | {
      action: "workspace-s3-configure";
      config?: Partial<S3WorkspaceConfig>;
      inviteCode?: string;
    }
  | { action: "workspace-s3-sync-now" }
  | { action: "workspace-s3-disconnect" }
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
  /**
   * Asks to run sshs3 with demo mode on/off. Demo mode never changes inside a running process: the
   * desktop app confirms with the user and relaunches itself; the web server refuses (set at server start).
   */
  | { action: "demo-mode-toggle"; enabled: boolean }
  | { action: "restore-builtins" }
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
