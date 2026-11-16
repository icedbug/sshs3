import { countWaitingInboxItems } from "@shared/aiHubInbox";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  ChevronDown,
  FlaskConical,
  GitFork,
  History,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  AGENT_MODES,
  SHELL_KINDS,
  type AgentMode,
  type AgentTask,
  type AgentToolRecord,
  type ContextSource,
  type HubRequest,
  type HubSnapshot,
  type MissionAgent,
  type ShellKind,
} from "@shared/types/aiHub";
import { CONTEXT_NOTE_PREFIX } from "@shared/types/aiHub";
import * as aiHubModule from "../../lib/aiHub";
import {
  hubRequest,
  selectAiTerminal,
  useHub,
  useSelectedTerminal,
} from "../../lib/aiHub";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import "./aiHub.css";
import { TaskTodos } from "./TaskTodos";
import { PlanCard } from "./PlanCard";
import { TerminalControl } from "./TerminalControl";
import { AnsiLogView, DiffViewer, HighlightedCode } from "./DiffViewer";
import type { FileRef } from "./reportRefs";
import {
  ALL_HUB_VIEWS,
  DEMO_MODE_SET_BY_SERVER,
  formatCompactTokens,
  formatUsdCost,
  getHubViewLabel,
  getVisibleHubViews,
  isLabsView,
  modes,
  TABULAR_NUMS_STYLE,
  type HubViewId,
} from "./panelShared";
import { copyToClipboard, RichMarkdownContent } from "./RichMarkdownContent";
import { LABS_ENABLED_STORAGE_KEY, Settings } from "./SettingsView";
import { Memory } from "./MemoryView";
import { Schedules } from "./SchedulesView";
import { ChangesView } from "./ChangesView";
import { WorkforceView } from "./WorkforceView";
import { HypothesisTree } from "./HypothesisTree";
import { ChangeProof } from "./ChangeProof";
import { InboxView } from "./InboxView";
import { isConversation } from "./workforceModel";
import { InfrastructureView } from "./InfrastructureView";
import { AgentsAndMcpView } from "./AgentsAndMcpView";
import { KnowledgeBaseView } from "./KnowledgeBaseView";

type View = HubViewId;
/** Where this tab remembers which conversation is open (sessionStorage: kept over a reload, not shared between tabs or people). */
const OPEN_TASK_KEY = "sshs3.aiHub.openTask";
const VIEWS: View[] = [...ALL_HUB_VIEWS];
type Menu = "history" | "target" | "control" | "mention" | "agent" | "views" | null;

const ESC_CSI = `${String.fromCharCode(27)}[`;

interface AiHubDeltaEvent {
  taskId: string;
  messageId?: string;
  delta?: string;
  textDelta?: string;
  text?: string;
  done?: boolean;
  toolRecord?: AgentToolRecord;
  tool?: AgentToolRecord;
}

interface StreamingTaskState {
  text: string;
  messageId?: string;
  tools: AgentToolRecord[];
}

interface DlpRule {
  label: string;
  pattern: RegExp;
}

const DLP_RULES: DlpRule[] = [
  { label: "Private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "API secret key", pattern: /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g },
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { label: "GitLab/Slack/Cloud token", pattern: /\b(?:glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|hv[bs]\.[A-Za-z0-9._-]{16,})\b/g },
  { label: "JWT / Bearer token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { label: "Webhook URL", pattern: /https:\/\/(?:hooks\.slack\.com\/services|outlook\.office\.com\/webhook)\/[^\s"'<>]+/g },
  { label: "Credential assignment", pattern: /\b(?:password|passwd|secret|token|api_?key)\s*[:=]\s*["']?[A-Za-z0-9_/+.-]{8,}["']?/gi },
];

function scanSecretsForDlp(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const rule of DLP_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      found.push(rule.label);
    }
  }
  return found;
}

function maskSecretsForDlp(text: string): string {
  let masked = text;
  for (const rule of DLP_RULES) {
    rule.pattern.lastIndex = 0;
    masked = masked.replace(rule.pattern, "[REDACTED]");
  }
  return masked;
}

function readLabsEnabled(): boolean {
  try {
    return window.localStorage.getItem(LABS_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** True when a failure text is about the model or its settings, so a way to the settings is offered. */
function isModelSetupMessage(text: string | undefined): boolean {
  return /AI settings|settings first|API key|No model answered|endpoint missing|key was refused/i.test(text ?? "");
}

/** The last thing the person said: the only message that can be asked again without confusion. */
function lastUserMessageId(task?: AgentTask): string | undefined {
  return [...(task?.messages ?? [])].reverse().find((m) => m.role === "user")?.id;
}

function getActiveProfileSummary(hub?: HubSnapshot): {
  label: string;
  provider?: string;
  isLocal: boolean;
} {
  const activeId = hub?.config.activeProfileByRole?.primary;
  const profile = activeId
    ? (hub?.config.profiles ?? []).find((p) => p.id === activeId)
    : undefined;
  const provider = profile?.provider;
  const baseUrl = (profile?.baseUrl ?? hub?.config.baseUrl ?? "").toLowerCase();
  const model = profile?.model ?? hub?.config.model ?? "";
  const isLocal =
    Boolean(hub?.demoMode) ||
    String(provider ?? "") === "ollama" ||
    model.toLowerCase().startsWith("ollama") ||
    baseUrl.includes("localhost") ||
    baseUrl.includes("127.0.0.1") ||
    baseUrl.includes("::1");
  return {
    // A model name here would read as "ready" while the assistant is switched off.
    label: !hub?.config.enabled
      ? "AI off"
      : // The demo lab without a model answers from a script: a model's name here would promise one.
        hub.demoMode && !hub.config.hasApiKey && !hub.config.codexConnected && !baseUrl
        ? "Demo answers (no model)"
        : profile?.name || model || "Default profile",
    provider,
    isLocal,
  };
}

function getTaskUsageSummary(task?: AgentTask): { totalTokens: number; costUsd: number } {
  if (!task) return { totalTokens: 0, costUsd: 0 };
  const isRunning = ["queued", "running", "waiting"].includes(task.status);
  const run = isRunning ? task.runUsage : undefined;
  const inputTokens = (task.usage?.inputTokens ?? 0) + (run?.inputTokens ?? 0);
  const outputTokens = (task.usage?.outputTokens ?? 0) + (run?.outputTokens ?? 0);
  const costUsd = (task.usage?.costUsd ?? 0) + (run?.costUsd ?? 0);
  return {
    totalTokens: inputTokens + outputTokens,
    costUsd,
  };
}

function subscribeAiHubDelta(cb: (delta: AiHubDeltaEvent) => void): () => void {
  const modFn = (
    aiHubModule as unknown as {
      onAiHubDelta?: (listener: (ev: AiHubDeltaEvent) => void) => () => void;
    }
  ).onAiHubDelta;
  if (typeof modFn === "function") {
    return modFn(cb);
  }
  const winFn = (
    window.multissh as unknown as {
      onAiHubDelta?: (listener: (ev: AiHubDeltaEvent) => void) => () => void;
    } | undefined
  )?.onAiHubDelta;
  if (typeof winFn === "function") {
    return winFn(cb);
  }
  return () => {};
}

function normalizeViewTarget(raw?: string): View | undefined {
  if (!raw) return undefined;
  if (raw === "Assistant" || raw === "Workspace" || raw === "Chat") return "Work";
  return VIEWS.find((v) => v === raw);
}

function formatDurationBadge(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function isDiffToolRecord(rec: AgentToolRecord): boolean {
  const name = rec.name.toLowerCase();
  if (name.includes("patch") || name.includes("diff") || name.includes("edit") || name.includes("write_file")) {
    return true;
  }
  const text = `${rec.output}\n${rec.input}`;
  return (text.includes("--- ") && text.includes("+++ ")) || text.includes("\n@@ ");
}

function isAnsiToolRecord(rec: AgentToolRecord): boolean {
  if (rec.output.includes(ESC_CSI)) return true;
  const name = rec.name.toLowerCase();
  return name.includes("exec") || name.includes("ssh") || name.includes("terminal") || name.includes("command") || name.includes("kubectl") || name.includes("log");
}

// The same incident as the demo lab's conversation (demoWorkspace.ts), at the point where it is found.
const DEMO_SHOWCASE_RESPONSE = [
  "## Cluster check: `NetApp-ONTAP-Prod-SE` and `K8s-Trident-CSI-Prod`",
  "",
  "I ran a health check on all 4 nodes of `@cluster:NetApp-ONTAP-Prod-SE` in parallel and compared `/etc/multipath.conf` between `k8s-storage-cp-01` and `k8s-gpu-io-worker-01`.",
  "",
  "### 1. Node status and latency (ONTAP 9.15.1P2)",
  "",
  "| Node | Role | Aggregate / capacity | Highest volume latency | SnapMirror lag | Status |",
  "| :--- | :--- | :--- | :--- | :--- | :--- |",
  "| `netapp-aff-a800-01a` | HA node A (DC1) | `aggr1_nvme_prod` (72% of 220 TB) | `0.38 ms` | `00:03:18` | **ONLINE · HEALTH_OK** |",
  "| `netapp-aff-a800-01b` | HA node B (DC1) | `aggr2_nvme_db` (68% of 180 TB) | `2.45 ms` | `00:02:44` | **ONLINE · QoS warning** |",
  "| `netapp-fas9000-dr-01` | SnapVault DR (DC2) | `aggr_dr_nlsas` (71% of 1.6 PB) | `1.12 ms` | In sync (XDP) | **ONLINE · SNAPMIRRORED** |",
  "| `ontap-aiq-um-01` | Active IQ and Harvest | Prometheus / Grafana | — | — | **TELEMETRY OK** |",
  "",
  "> **Cause:** the scratch volume `vol_ai_scratch_03` (`svm-prod-nfs`) on `netapp-aff-a800-01b` has no QoS policy. Its read peaks (`48 200 IOPS`) drive up the queue depth on `aggr2_nvme_db`, which also holds the production database volume `vol_pg_prod_db01` (`1.88 ms`). On `k8s-gpu-io-worker-01`, multipath uses `multibus` instead of ALUA `group_by_prio`, which the Trident multipath standard in the knowledge base requires.",
  "",
  "### 2. Configuration difference (`/etc/multipath.conf`)",
  "",
  "```diff",
  "--- k8s-storage-cp-01:/etc/multipath.conf",
  "+++ k8s-gpu-io-worker-01:/etc/multipath.conf",
  "@@ -7,7 +7,7 @@",
  "     device {",
  "         vendor \"NETAPP\"",
  "         product \"LUN.*\"",
  "-        path_grouping_policy group_by_prio",
  "+        path_grouping_policy multibus",
  "         path_checker tur",
  "         features \"2 pg_init_retries 50\"",
  "         hardware_handler \"1 alua\"",
  "```",
  "",
  "### 3. Proposed commands",
  "",
  "Put the QoS ceiling `pg-batch-ceiling` (`15 000 IOPS` / `600 MB/s`) on the scratch volume and check the latency again, then switch the GPU worker's multipath to ALUA:",
  "",
  "```bash",
  "# On netapp-aff-a800-01b:",
  "volume modify -vserver svm-prod-nfs -volume vol_ai_scratch_03 -qos-policy-group pg-batch-ceiling",
  "qos statistics volume latency show -iterations 3",
  "# On k8s-gpu-io-worker-01:",
  "sudo multipath -r && sudo multipath -ll",
  "```",
].join("\n");

export interface AiHubPanelProps {
  mode: "closed" | "panel" | "hub";
  setMode: (value: "closed" | "panel" | "hub") => void;
  width?: number;
  onResizeWidth?: (width: number) => void;
  /** Optional per-tab active task id. */
  initialTaskId?: string;
  /** Called whenever the active task id changes inside the panel. */
  onTaskChange?: (taskId: string) => void;
  /** Optional terminal session id bound to this tab's AI dock. */
  boundTerminalId?: string;
  /** Optional compact navigation label preference. */
  compactMode?: boolean;
  /** Optional handler invoked when clicking a `host:/path:line` or `/path:line` citation. */
  onOpenFileRef?: (ref: FileRef) => void;
}

export function AiHubPanel({
  mode,
  setMode,
  width,
  onResizeWidth,
  initialTaskId,
  onTaskChange,
  boundTerminalId,
  compactMode: compactModeProp = false,
  onOpenFileRef,
}: AiHubPanelProps): JSX.Element {
  const hub = useHub();
  const selectedTerminal = useSelectedTerminal();
  const [view, setView] = useState<View>("Work");
  const [labsEnabled, setLabsEnabled] = useState<boolean>(() => readLabsEnabled());
  const [focusInboxItem, setFocusInboxItem] = useState<string | undefined>();
  // A ticket the Inbox asked the Workforce view to open.
  const [workforceTicketId, setWorkforceTicketId] = useState<string | undefined>();
  // The conversation that is open is remembered for this tab: a reload or a reconnect (the server
  // restarted, the connection dropped) opens the same conversation again, not an empty "new chat".
  const [taskId, setTaskIdState] = useState<string>(() => {
    // The dock's own state is in memory and empty after a reload: an empty id from it is "nothing
    // chosen yet", not "new chat", so what this tab remembers is opened.
    if (initialTaskId) return initialTaskId;
    try {
      return window.sessionStorage.getItem(OPEN_TASK_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const setTaskId = (next: string): void => {
    setTaskIdState(next);
    onTaskChange?.(next);
  };
  const [prompt, setPrompt] = useState("");
  /** What was just sent and has not come back in the conversation yet (the answer to the request can take a while). */
  const [sending, setSending] = useState("");
  const [autonomy, setAutonomy] = useState<AgentMode>("assisted");
  // True once the person chose a mode themselves: then an agent's default no longer decides.
  const [modePicked, setModePicked] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [shell, setShell] = useState<ShellKind>("bash");
  const [error, setError] = useState("");
  // What a request saved differently from what was asked (a value left out, an id rewritten).
  const [notice, setNotice] = useState("");
  // A note that something was done goes away by itself: it is not something to act on.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const [busy, setBusy] = useState(false);
  /** What the person wants to say with an answer, per pending action; the agent is given it. */
  const [approvalNotes, setApprovalNotes] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<ContextSource[]>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [atIndex, setAtIndex] = useState(0);
  const [atDismissedFor, setAtDismissedFor] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showDemoPreview, setShowDemoPreview] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [streamingByTask, setStreamingByTask] = useState<Record<string, StreamingTaskState>>({});
  const [dlpWarning, setDlpWarning] = useState<{
    labels: string[];
    prompt: string;
    attachments: ContextSource[];
    sessionId?: string;
  } | null>(null);
  const [connection, setConnection] = useState<{
    id: string;
    generation: string;
    label: string;
  }>();
  const task = hub?.tasks.find((t) => t.id === taskId);
  const activeAgent: MissionAgent | undefined = (hub?.agents ?? []).find(
    (a) => a.id === (task?.agentId || selectedAgentId),
  );
  const targetSessionId = task
    ? task.target?.sessionId
    : (connection?.id ?? boundTerminalId ?? selectedTerminal);
  const terminal = hub?.sessions.find(
    (s) => s.id === targetSessionId && (task || s.state !== "disconnected"),
  );
  const activeProfile = getActiveProfileSummary(hub);
  const draftMode: AgentMode = modePicked ? autonomy : (activeAgent?.defaultMode ?? autonomy);
  const aiSetUp =
    !!hub &&
    (hub.demoMode ||
      (hub.config.enabled &&
        !!hub.config.model &&
        (hub.config.hasApiKey || hub.config.codexConnected || !!hub.config.baseUrl?.includes("11434"))));
  const taskUsage = getTaskUsageSummary(task);
  const streamingState = task ? streamingByTask[task.id] : undefined;
  const visibleHubViews = getVisibleHubViews(labsEnabled || isLabsView(view));
  const running =
    !!task && ["queued", "running", "waiting"].includes(task.status);
  const activeView = view;
  const end = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const modal = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const lastText = task?.messages.at(-1)?.text;
  const pending =
    task?.changes.filter((c) => c.status === "pending").length ?? 0;
  const timeline = task
    ? [
        ...task.messages.map((message) => ({
          at: message.at,
          message,
          change: undefined,
        })),
        ...task.changes.map((change) => ({
          at: change.at,
          message: undefined,
          change,
        })),
      ].sort((a, b) => a.at - b.at)
    : [];

  // Build @-mention items for both the @ Context menu and inline @-autocomplete when typing in textarea
  const allMentionOptions = (() => {
    if (!hub) return [];
    const items: Array<{ label: string; subtitle: string; text: string }> = [];
    const recent = (hub.activityLog ?? []).slice(0, 20);
    items.push({
      label: "@team-changes",
      subtitle: "Recent config & command changes by your team",
      text: recent.length
        ? recent
            .map(
              (a) =>
                `[${new Date(a.at).toISOString()}] ${a.actor} on ${a.targetLabel} (${a.kind}): ${a.summary}${a.detail ? ` — ${a.detail}` : ""}`,
            )
            .join("\n")
        : "No recent team activity recorded yet.",
    });

    const servers = hub.workspaceServers ?? [];
    items.push({
      label: "@workspace",
      subtitle: "All clusters, nodes, VMs, roles & descriptions",
      text: servers.length
        ? servers
            .map(
              (s) =>
                `- ${s.name} (${s.username}@${s.host}:${s.port}) [${s.shared ? "Shared" : "Personal"}]${s.cluster ? ` cluster=${s.cluster}` : ""}${s.nodeRole ? ` nodeRole=${s.nodeRole}` : ""}${s.role ? ` role=${s.role}` : ""}${s.tags?.length ? ` tags=[${s.tags.join(", ")}]` : ""}${s.description ? `: ${s.description}` : ""}`,
            )
            .join("\n")
        : "No saved servers in workspace.",
    });

    // Unique clusters
    const clusterNames = Array.from(
      new Set(servers.map((s) => s.cluster).filter((c): c is string => Boolean(c))),
    );
    for (const cName of clusterNames) {
      const members = servers.filter((s) => s.cluster === cName);
      items.push({
        label: `@cluster:${cName}`,
        subtitle: `Cluster (${members.length} nodes: ${members.map((m) => m.name).join(", ")})`,
        text: [
          `Cluster: ${cName} (${members.length} nodes)`,
          ...members.map(
            (m) =>
              `- ${m.name} (${m.username}@${m.host}:${m.port}) [nodeRole=${m.nodeRole || m.role || "node"}]${m.tags?.length ? ` tags=[${m.tags.join(", ")}]` : ""}${m.description ? `: ${m.description}` : ""}`,
          ),
        ].join("\n"),
      });
    }

    for (const s of servers.slice(0, 20)) {
      const serverEvents = (hub.activityLog ?? [])
        .filter((a) => a.profileId === s.id || a.targetLabel === s.name)
        .slice(0, 5);
      items.push({
        label: `@${s.name}`,
        subtitle: [
          s.cluster ? s.cluster : "",
          s.nodeRole || s.role || "",
          s.description || `${s.username}@${s.host}`,
        ]
          .filter(Boolean)
          .join(" · "),
        text: [
          `Server/Node: ${s.name} (${s.username}@${s.host}:${s.port})`,
          ...(s.cluster ? [`Cluster: ${s.cluster}`] : []),
          ...(s.nodeRole ? [`Node Role: ${s.nodeRole}`] : []),
          ...(s.role ? [`Role: ${s.role}`] : []),
          ...(s.description ? [`Description: ${s.description}`] : []),
          ...(s.tags?.length ? [`Tags: ${s.tags.join(", ")}`] : []),
          ...(serverEvents.length
            ? [
                "Recent changes:",
                ...serverEvents.map(
                  (e) =>
                    `  - [${new Date(e.at).toISOString()}] ${e.actor}: ${e.summary}`,
                ),
              ]
            : []),
        ].join("\n"),
      });
    }
    for (const ag of hub.agents ?? []) {
      const slug = ag.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      items.push({
        label: `@agent:${slug}`,
        subtitle: `${ag.name} · ${ag.role} (${ag.mission})`,
        text: [
          `Mission Agent: ${ag.name} (${ag.role})`,
          `Mission: ${ag.mission}`,
          `System Prompt:\n${ag.systemPrompt}`,
        ].join("\n"),
      });
    }
    for (const doc of (hub.kbDocuments ?? []).slice(0, 12)) {
      const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      items.push({
        label: `@kb:${slug}`,
        subtitle: `Runbook (${doc.collection}): ${doc.title}`,
        // The list holds only the start of each text: the assistant reads the rest itself.
        text: [
          `Knowledge base document: ${doc.title} (docId ${doc.id}, ${doc.collection ?? "General"})`,
          doc.summary ? `Summary: ${doc.summary}` : "",
          `Beginning:\n${doc.content}`,
          (doc.contentLength ?? 0) > doc.content.length
            ? `This is only the beginning. Read the document with sshs3_kb_search (id="${doc.id}") before relying on it.`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    }
    return items;
  })();

  const atMatch = /(?:^|\s)@([a-zA-Z0-9_.:-]*)$/.exec(prompt);
  const atQuery = atMatch ? atMatch[1].toLowerCase() : null;
  const activeAtSuggestions =
    atQuery !== null && atDismissedFor !== prompt
      ? allMentionOptions
          .filter(
            (opt) =>
              opt.label.toLowerCase().includes(atQuery) ||
              opt.subtitle.toLowerCase().includes(atQuery),
          )
          .slice(0, 7)
      : [];

  const slashCommands = [
    {
      cmd: "/workforce",
      title: "Run a workforce review",
      subtitle: "Have your Mission Agents investigate an objective in parallel and combine their reports",
      template:
        "Run a workforce review with sshs3_agent_and_mcp_manage (operation=run_workforce) to investigate: ",
    },
    {
      cmd: "/handoff",
      title: "Hand over to another agent",
      subtitle: "Hand the active conversation over to another Mission Agent",
      template:
        "Hand over with sshs3_agent_and_mcp_manage (operation=handoff_agent) to our specialist agent for: ",
    },
    {
      cmd: "/mcp",
      title: "Set up an MCP server",
      subtitle: "See which MCP servers can be set up and add one",
      template:
        "List the MCP servers that can be set up with sshs3_agent_and_mcp_manage (operation=list) and help me add: ",
    },
    {
      cmd: "/cluster-exec",
      title: "Run across a cluster",
      subtitle: "Run a command on every node of a cluster in parallel with sshs3_cluster_exec",
      template:
        "Run a parallel health check across the nodes of a cluster with sshs3_cluster_exec: ",
    },
    {
      cmd: "/split-cluster",
      title: "Cluster split view",
      subtitle: "Open a whole cluster in a 2×2 terminal grid with sshs3_workspace_layout",
      template:
        "Open a 2x2 split-view terminal grid for the nodes of one of my clusters with sshs3_workspace_layout; ask me which cluster if there are several.",
    },
    {
      cmd: "/diff",
      title: "Compare a file between servers",
      subtitle: "Diff a configuration file between two nodes with sshs3_storage_ops",
      template:
        "Diff a configuration file between two of my servers with sshs3_storage_ops; ask me which file and which servers.",
    },
    {
      cmd: "/configure",
      title: "Configure sshS3",
      subtitle: "Set up SSH tunnels, S3 profiles, shortcuts, themes, dotfiles and cloud sync",
      template:
        "Configure sshS3 for me (SSH tunnels, S3 profile, shortcuts, theme or dotfiles): ",
    },
    {
      cmd: "/tunnel",
      title: "Create an SSH tunnel",
      subtitle: "Add a local, remote or dynamic SOCKS5 tunnel to a server profile",
      template:
        "Create an SSH port-forwarding tunnel (local 5432 -> 127.0.0.1:5432) on a server I name, with sshs3_manage_server (operation=save_tunnel).",
    },
    {
      cmd: "/kb",
      title: "Search runbooks",
      subtitle: "Search the knowledge base",
      template:
        "Search our knowledge base (@kb) for runbooks and standards about: ",
    },
    {
      cmd: "/memory",
      title: "Save to team memory",
      subtitle: "Save a fact or a procedure to the shared team memory",
      template:
        "Save the following as a shared team memory or skill with sshs3_manage_memory_and_activity: ",
    },
    {
      cmd: "/plan",
      title: "Plan first",
      subtitle: "Write a step-by-step plan with risks and rollback",
      template:
        "/plan Write a step-by-step plan with risks, verification and rollback for: ",
    },
    {
      cmd: "/grill-me",
      title: "Challenge my plan",
      subtitle: "Have the assistant question your design or change before production",
      template:
        "/grill-me Question and review my planned infrastructure change critically before production: ",
    },
  ];

  const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(prompt.trim());
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const activeSlashSuggestions =
    slashQuery !== null && atDismissedFor !== prompt
      ? slashCommands.filter(
          (item) =>
            item.cmd.toLowerCase().includes(slashQuery) ||
            item.title.toLowerCase().includes(slashQuery) ||
            item.subtitle.toLowerCase().includes(slashQuery),
        )
      : [];

  const applySlashSuggestion = (item: {
    cmd: string;
    title: string;
    subtitle: string;
    template: string;
  }): void => {
    setPrompt(item.template);
    setAtIndex(0);
    setMenu(null);
    setTimeout(() => composer.current?.focus(), 10);
  };

  const applyAtSuggestion = (opt: {
    label: string;
    subtitle: string;
    text: string;
  }): void => {
    setPrompt((prev) =>
      prev.replace(/(?:^|\s)@([a-zA-Z0-9_.:-]*)$/, (m) =>
        m.startsWith(" ") ? ` ${opt.label} ` : `${opt.label} `,
      ),
    );
    setAttachments((old) => [
      ...old.filter((x) => x.label !== opt.label).slice(-9),
      {
        id: crypto.randomUUID(),
        label: opt.label,
        text: opt.text,
        observedAt: Date.now(),
      },
    ]);
    setAtIndex(0);
    setMenu(null);
    setTimeout(() => composer.current?.focus(), 10);
  };

  useEffect(() => {
    if (activeView === "Work" && follow.current)
      end.current?.scrollIntoView?.({ block: "end" });
  }, [lastText, pending, activeView, mode, connection]);
  useEffect(() => {
    follow.current = true;
    end.current?.scrollIntoView?.({ block: "end" });
    try {
      if (taskId) window.sessionStorage.setItem(OPEN_TASK_KEY, taskId);
      else window.sessionStorage.removeItem(OPEN_TASK_KEY);
    } catch {
      // Storage may be blocked: the conversation then simply is not remembered.
    }
  }, [taskId]);
  useEffect(() => {
    const element = composer.current;
    if (element) {
      element.style.height = "auto";
      element.style.height =
        Math.min(180, Math.max(64, element.scrollHeight)) + "px";
    }
  }, [prompt, mode]);
  const handleToggleLabs = (next: boolean): void => {
    setLabsEnabled(next);
    try {
      window.localStorage.setItem(LABS_ENABLED_STORAGE_KEY, String(next));
    } catch {
      // ignore storage errors
    }
    window.dispatchEvent(new CustomEvent("sshs3:labs-changed", { detail: { labsEnabled: next } }));
    window.dispatchEvent(new CustomEvent("sshs3:settings-updated", { detail: { labsEnabled: next } }));
  };

  // The dock is followed when it changes (another tab's conversation is chosen), not on every render:
  // otherwise its empty id after a reload would close the conversation this tab just opened again.
  const followedTaskId = useRef(initialTaskId);
  useEffect(() => {
    if (initialTaskId === followedTaskId.current) return;
    followedTaskId.current = initialTaskId;
    if (initialTaskId !== undefined && initialTaskId !== taskId) setTaskIdState(initialTaskId);
  }, [initialTaskId, taskId]);
  // The conversation remembered over a reload is told to the dock once, so that both agree.
  useEffect(() => {
    if (taskId && taskId !== initialTaskId) onTaskChange?.(taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  useEffect(() => {
    if (boundTerminalId) {
      selectAiTerminal(boundTerminalId);
    }
  }, [boundTerminalId]);

  useEffect(() => {
    return subscribeAiHubDelta((ev) => {
      if (!ev?.taskId) return;
      const deltaChunk = ev.delta ?? ev.textDelta ?? "";
      const incomingTool = ev.toolRecord ?? ev.tool;
      setStreamingByTask((prev) => {
        if (ev.done && !deltaChunk && !ev.text && !incomingTool) {
          if (!(ev.taskId in prev)) return prev;
          const copy = { ...prev };
          delete copy[ev.taskId];
          return copy;
        }
        const current = prev[ev.taskId] ?? { text: "", tools: [] };
        const nextText = ev.text !== undefined ? ev.text : `${current.text}${deltaChunk}`;
        const nextTools = incomingTool ? [...current.tools, incomingTool] : current.tools;
        return {
          ...prev,
          [ev.taskId]: {
            text: nextText,
            messageId: ev.messageId ?? current.messageId,
            tools: nextTools,
          },
        };
      });
    });
  }, []);

  useEffect(() => {
    if (!task || !streamingByTask[task.id]) return;
    if (!["queued", "running", "waiting"].includes(task.status)) {
      setStreamingByTask((prev) => {
        if (!(task.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[task.id];
        return copy;
      });
    }
  }, [task, streamingByTask]);

  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (
        event as CustomEvent<{
          view?: string;
          mode?: "closed" | "panel" | "hub";
          agentId?: string;
          taskId?: string;
          newTask?: boolean;
          prompt?: string;
        }>
      ).detail;
      // With no mode given, Full view stays Full view: only a closed assistant is opened.
      if (detail?.mode) setMode(detail.mode);
      else if (modeRef.current === "closed") setMode("panel");
      const targetView = normalizeViewTarget(detail?.view);
      if (targetView) {
        if (isLabsView(targetView)) setLabsEnabled(true);
        setView(targetView);
      }
      if (detail?.newTask) {
        setTaskIdState("");
        onTaskChange?.("");
        // A new conversation starts empty, unless the event brings its own text or agent (set below).
        if (detail.agentId === undefined && !detail.prompt) {
          setPrompt("");
          setSelectedAgentId("");
        }
      } else if (detail?.taskId) {
        setTaskIdState(detail.taskId);
        onTaskChange?.(detail.taskId);
      }
      if (detail?.agentId !== undefined) {
        setSelectedAgentId(detail.agentId);
        setModePicked(false);
      }
      if (detail?.prompt) {
        setPrompt(detail.prompt);
        setTimeout(() => composer.current?.focus(), 30);
      }
    };
    const askAi = (event: Event): void => {
      const custom = event as CustomEvent<{
        sessionId?: string;
        text?: string;
        label?: string;
        prompt?: string;
        action?: string;
      }>;
      custom.preventDefault();
      const detail = custom.detail;
      if (detail?.sessionId) {
        selectAiTerminal(detail.sessionId);
      }
      if (detail?.text && detail?.label) {
        setAttachments((old) => [
          ...old.slice(-9),
          {
            id: crypto.randomUUID(),
            label: detail.label!,
            text: detail.text!,
            observedAt: Date.now(),
          },
        ]);
      }
      if (detail?.prompt) {
        setPrompt(detail.prompt);
      }
      if (modeRef.current === "closed") {
        setMode("panel");
      }
      setView("Work");
      setTimeout(() => composer.current?.focus(), 30);
    };
    const focusComposer = (): void => {
      if (modeRef.current === "closed") {
        setMode("panel");
      }
      setView("Work");
      setTimeout(() => composer.current?.focus(), 30);
    };
    const attach = (event: Event): void => {
      const detail = (
        event as CustomEvent<{
          text?: string;
          label?: string;
          prompt?: string;
          sessionId?: string;
        }>
      ).detail;
      if (detail?.sessionId) {
        selectAiTerminal(detail.sessionId);
      }
      if (detail?.text && detail?.label) {
        setAttachments((old) => [
          ...old.slice(-9),
          {
            id: crypto.randomUUID(),
            label: detail.label!,
            text: detail.text!,
            observedAt: Date.now(),
          },
        ]);
      }
      if (detail?.prompt) {
        setPrompt(detail.prompt);
      }
      if (detail?.text || detail?.prompt) {
        if (modeRef.current === "closed") setMode("panel");
        setView("Work");
        setTimeout(() => composer.current?.focus(), 30);
      }
    };
    const onLabsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<{ labsEnabled?: boolean }>).detail;
      if (typeof detail?.labsEnabled === "boolean") {
        setLabsEnabled(detail.labsEnabled);
      } else {
        setLabsEnabled(readLabsEnabled());
      }
    };
    window.addEventListener("sshs3:ai-open", open);
    window.addEventListener("sshs3:ask-ai", askAi);
    window.addEventListener("sshs3:focus-ai-composer", focusComposer);
    window.addEventListener("sshs3:ai-attach", attach);
    window.addEventListener("sshs3:labs-changed", onLabsChanged);
    window.addEventListener("sshs3:settings-updated", onLabsChanged);
    // A link from a notification: ?view=Inbox&item=…  Opened once, then taken out of the address.
    const linked = new URLSearchParams(window.location.search);
    const linkedView = VIEWS.find((v) => v === linked.get("view"));
    if (linkedView) {
      if (isLabsView(linkedView)) setLabsEnabled(true);
      setMode("hub");
      setView(linkedView);
      setFocusInboxItem(linked.get("item") ?? undefined);
      linked.delete("view");
      linked.delete("item");
      const rest = linked.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
    }
    return () => {
      window.removeEventListener("sshs3:ai-open", open);
      window.removeEventListener("sshs3:ask-ai", askAi);
      window.removeEventListener("sshs3:focus-ai-composer", focusComposer);
      window.removeEventListener("sshs3:ai-attach", attach);
      window.removeEventListener("sshs3:labs-changed", onLabsChanged);
      window.removeEventListener("sshs3:settings-updated", onLabsChanged);
    };
  }, [onTaskChange, setMode]);
  useEffect(() => {
    if (!settingsOpen || mode === "closed") return;
    const previous = document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSettingsOpen(false);
      }
      if (event.key === "Tab") {
        const elements = Array.from(
          modal.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? [],
        );
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [settingsOpen, mode]);
  // An error shown in the settings is about the settings: it does not stay on the panel once they are closed.
  useEffect(() => {
    if (!settingsOpen) setError("");
  }, [settingsOpen]);

  async function act(request: HubRequest): Promise<HubSnapshot | undefined> {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const snap = await hubRequest(request);
      setNotice(snap?.reply?.notes?.join(" ") ?? "");
      return snap;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function copyMessage(id: string, text: string): Promise<void> {
    if (await copyToClipboard(text)) {
      setCopiedMsgId(id);
      setTimeout(() => setCopiedMsgId((prev) => (prev === id ? null : prev)), 1800);
    }
  }
  function newChat(): void {
    setTaskId("");
    setPrompt("");
    setAttachments([]);
    setConnection(undefined);
    setView("Work");
    setMenu(null);
    setError("");
    composer.current?.focus();
  }
  function chooseTask(id: string): void {
    setTaskId(id);
    setConnection(undefined);
    setView("Work");
    setMenu(null);
    setError("");
  }
  function attachFileOrImage(file: File): void {
    const isImage =
      file.type.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name);
    if (isImage) {
      if (file.size > 4_500_000) {
        setError("Choose an image smaller than 4.5 MB.");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === "string" ? reader.result : "";
        if (!dataUrl.startsWith("data:image/")) {
          setError("Could not read that image.");
          return;
        }
        setAttachments((old) => [
          ...old.slice(-9),
          {
            id: crypto.randomUUID(),
            label: file.name || `screenshot-${ new Date().toLocaleTimeString() }.png`,
            text: `[Image attachment: ${file.name || "image"}]`,
            imageDataUrl: dataUrl,
            mimeType: file.type || "image/png",
            observedAt: Date.now(),
          },
        ]);
      };
      reader.onerror = () => setError("Could not read that image.");
      reader.readAsDataURL(file);
      return;
    }
    if (file.size > 128_000) {
      setError("Choose a text file smaller than 128 KB.");
      return;
    }
    void file
      .text()
      .then((text) =>
        setAttachments((old) => [
          ...old.slice(-9),
          {
            id: crypto.randomUUID(),
            label: file.name,
            text,
            observedAt: Date.now(),
          },
        ]),
      )
      .catch(() => setError("Could not read that file."));
  }
  function activeSessionForHandoff(): { id: string; label: string } | undefined {
    const candidate =
      (terminal && terminal.state !== "disconnected" ? terminal : undefined) ??
      (boundTerminalId
        ? hub?.sessions.find((s) => s.id === boundTerminalId && s.state !== "disconnected")
        : undefined) ??
      (selectedTerminal
        ? hub?.sessions.find((s) => s.id === selectedTerminal && s.state !== "disconnected")
        : undefined);
    if (candidate) return { id: candidate.id, label: candidate.label };
    const fallbackId = boundTerminalId || (selectedTerminal && selectedTerminal !== "" ? selectedTerminal : "");
    if (fallbackId) return { id: fallbackId, label: fallbackId };
    return undefined;
  }

  function stageCommandInTerminal(cmd: string): void {
    const session = activeSessionForHandoff();
    const write = window.multissh?.terminalWrite;
    if (session && typeof write === "function") {
      void write(session.id, cmd);
      setNotice(`Staged in ${session.label}: ${cmd}`);
      setError("");
      return;
    }
    setPrompt(cmd);
    setNotice("Staged in AI composer (connect a terminal to stage directly).");
    setTimeout(() => composer.current?.focus(), 20);
  }

  function runCommandInTerminal(cmd: string): boolean {
    const session = activeSessionForHandoff();
    const write = window.multissh?.terminalWrite;
    if (session && typeof write === "function") {
      const payload = cmd.endsWith("\n") ? cmd : `${cmd}\n`;
      void write(session.id, payload);
      setNotice(`Ran in ${session.label}: ${cmd}`);
      setError("");
      return true;
    }
    setError("No active terminal session selected. Connect or choose a terminal target first.");
    return false;
  }

  function handleOpenFileRef(fileRef: FileRef): void {
    if (onOpenFileRef) {
      onOpenFileRef(fileRef);
      return;
    }
    const formatted = `${fileRef.host ? `${fileRef.host}:` : ""}${fileRef.path}${fileRef.line ? `:${fileRef.line}` : ""}`;
    window.dispatchEvent(new CustomEvent("sshs3:open-file-ref", { detail: fileRef }));
    void copyToClipboard(formatted);
    setNotice(`Referenced ${formatted} (copied to clipboard).`);
  }

  function cycleMode(): void {
    const idx = AGENT_MODES.indexOf(draftMode);
    const next = AGENT_MODES[(idx + 1) % AGENT_MODES.length];
    setAutonomy(next);
    setModePicked(true);
    setConnection(undefined);
    setNotice(`Mode switched to ${modes[next]}.`);
  }

  // Typed against HubRequest so a wrong field name does not compile.
  async function dispatchExtraHubRequest(payload: HubRequest): Promise<HubSnapshot | undefined> {
    return act(payload);
  }

  // Ollama is asked first: saving an address nothing answers at would leave a broken setup behind.
  async function connectLocalOllama(): Promise<void> {
    const baseUrl = "http://127.0.0.1:11434/v1";
    const probe = (await act({ action: "ai-probe", baseUrl }))?.reply?.probe;
    if (!probe) return;
    if (!probe.ok) {
      setError(probe.detail || `No model answered at ${baseUrl}. Start Ollama, then try again.`);
      return;
    }
    const preferred = "qwen2.5-coder:14b";
    const model = !probe.models?.length || probe.models.includes(preferred) ? preferred : probe.models[0];
    const saved = await act({
      action: "configure",
      config: { enabled: true, provider: "openai-compatible", baseUrl, model, useHermes: false },
    });
    if (saved) setNotice(`Connected to local Ollama. Model: ${model}.`);
  }

  async function handleForkTask(fromMessageId?: string): Promise<void> {
    if (!task || busy) return;
    const result = await dispatchExtraHubRequest({
      action: "task-fork",
      taskId: task.id,
      ...(fromMessageId ? { fromMessageId } : {}),
    });
    const forkedId = result?.reply?.started?.taskId ?? result?.tasks.at(-1)?.id;
    if (forkedId && forkedId !== task.id) {
      setTaskId(forkedId);
      setNotice(`Forked conversation into ${forkedId}.`);
    }
  }

  async function handleCompactTask(): Promise<void> {
    if (!task || busy) return;
    const result = await dispatchExtraHubRequest({
      action: "compact-task",
      taskId: task.id,
    });
    if (result) {
      setNotice("Compacted conversation context.");
    }
  }

  async function handleRestoreCheckpoint(changeId: string): Promise<void> {
    if (!task || busy || !changeId) return;
    const result = await dispatchExtraHubRequest({
      action: "restore-checkpoint",
      taskId: task.id,
      changeId,
    });
    if (result) {
      setNotice("Restored checkpoint.");
    }
  }

  async function sendMessage(
    sessionId?: string,
    opts?: {
      overridePrompt?: string;
      overrideAttachments?: ContextSource[];
      bypassDlp?: boolean;
    },
  ): Promise<void> {
    const candidateAttachments = opts?.overrideAttachments ?? attachments;
    const hasImages = candidateAttachments.some((a) => !!a.imageDataUrl);
    const rawPrompt = opts?.overridePrompt ?? prompt;
    if (busy || (!rawPrompt.trim() && !hasImages)) return;
    const textToSend =
      rawPrompt.trim() || "Look at the attached image and say what it shows.";

    if (!opts?.bypassDlp && !activeProfile.isLocal) {
      const combinedText = [
        textToSend,
        ...candidateAttachments.map((a) => a.text || ""),
      ].join("\n");
      const detected = scanSecretsForDlp(combinedText);
      if (detected.length > 0) {
        setDlpWarning({
          labels: detected,
          prompt: textToSend,
          attachments: candidateAttachments,
          sessionId,
        });
        return;
      }
    }

    // The field is emptied at once and the message shown as sent: the answer to the request can take
    // a while on a busy server, and a message that stays in the field looks as if nothing happened.
    setDlpWarning(null);
    const sentAttachments = candidateAttachments;
    setSending(textToSend);
    if (opts?.overridePrompt === undefined) setPrompt("");
    if (opts?.overrideAttachments === undefined) setAttachments([]);
    const result = task
      ? await act({
          action: "reply",
          taskId: task.id,
          text: textToSend,
          sessionId,
          attachments: sentAttachments,
        })
      : await act({
          action: "start",
          task: {
            prompt: textToSend,
            sessionId,
            mode: draftMode,
            agentId: activeAgent?.id,
            agentName: activeAgent?.name,
            attachments: sentAttachments,
          },
        });
    setSending("");
    if (result) {
      // The conversation this request started: "the newest in the list" may be a background run that began meanwhile.
      if (!task) setTaskId(result.reply?.started?.taskId ?? result.tasks.at(-1)?.id ?? "");
      setConnection(undefined);
    } else if (opts?.overridePrompt === undefined) {
      // It did not go: what was written is given back, unless something new has been typed meanwhile.
      setPrompt((now) => now || rawPrompt);
      setAttachments((now) => (now.length ? now : sentAttachments));
    }
  }
  async function submit(): Promise<void> {
    const trimmed = prompt.trim();
    if (trimmed.startsWith("!") && !busy) {
      const quickCmd = trimmed.slice(1).trim();
      if (!quickCmd) return;
      if (runCommandInTerminal(quickCmd)) {
        setPrompt("");
      }
      return;
    }
    const hasImages = attachments.some((a) => !!a.imageDataUrl);
    if (busy || (!trimmed && !hasImages)) return;
    if (!hub?.config.enabled) {
      if (hub?.demoMode || hub?.config.codexConnected || hub?.config.hasApiKey) {
        await act({
          action: "configure",
          config: { enabled: true },
        });
      } else {
        setSettingsOpen(true);
        return;
      }
    } else if (!hub.config.model || !hub.runtime.bundled) {
      setSettingsOpen(true);
      return;
    }
    follow.current = true;
    await sendMessage(
      terminal && terminal.state !== "disconnected" ? terminal.id : undefined,
    );
  }
  async function connectAndSend(): Promise<void> {
    if (!connection || busy) return;
    const current = hub?.sessions.find((s) => s.id === connection.id);
    if (
      !current ||
      current.generation !== connection.generation ||
      current.state === "disconnected"
    ) {
      setError(
        "The terminal changed. Select the current terminal before continuing.",
      );
      setConnection(undefined);
      return;
    }
    const result = await act({
      action: "arm",
      sessionId: connection.id,
      shell,
    });
    if (result?.sessions.find((s) => s.id === connection.id)?.state === "ready")
      await sendMessage(connection.id);
  }
  if (mode === "closed") return <aside hidden aria-label="AI chat" />;
  return (
    <aside
      // In the browser a floating account bar sits at the bottom right; the panel leaves room for it.
      className={"ai-hub ai-hub-" + mode + (isWebBrowserMode() ? " ai-hub-web" : "")}
      style={mode === "panel" && width ? { width: `${width}px` } : undefined}
      aria-label="AI chat"
      onKeyDown={(e) => {
        if (e.key === "Escape") setMenu(null);
      }}
    >
      {mode === "panel" && onResizeWidth && (
        <div
          className="ai-hub-resize-handle"
          title="Drag to resize AI panel"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = width ?? 420;
            const onMove = (moveEvent: MouseEvent): void => {
              const delta = startX - moveEvent.clientX;
              const nextWidth = Math.min(
                900,
                Math.max(300, startWidth + delta),
              );
              onResizeWidth(nextWidth);
            };
            const onUp = (): void => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        />
      )}
      <header className="ai-hub-header">
        <span className="ai-chat-title">
          <MessageSquare size={16} />
          <strong>{mode === "hub" ? "AI Hub" : "Assistant"}</strong>
          {mode === "hub" && (
            <span className="ai-pill" title="Active workspace hub">
              Workspace
            </span>
          )}
        </span>
        <div className="ai-header-actions">
          {hub && (
            <button
              type="button"
              data-testid="ai-profile-badge"
              className="ai-badge"
              style={{ cursor: "pointer", fontSize: 10.5, padding: "3px 8px" }}
              title={`Active primary profile: ${activeProfile.label}${activeProfile.provider ? ` (${activeProfile.provider})` : ""}`}
              onClick={() => setSettingsOpen(true)}
            >
              <Sparkles size={11} style={{ marginRight: 4 }} />
              {activeProfile.label}
            </button>
          )}
          {task && (
            <span
              data-testid="ai-usage-pill"
              className="ai-badge"
              style={{ ...TABULAR_NUMS_STYLE, fontSize: 10.5, padding: "3px 8px" }}
              title="Live token usage and estimated USD cost for this task"
            >
              {formatCompactTokens(taskUsage.totalTokens)} tok
              {taskUsage.costUsd > 0 ? ` · ${formatUsdCost(taskUsage.costUsd)}` : " · $0.00"}
            </span>
          )}
          {hub && (
            <div className="ai-menu-anchor">
              <button
                type="button"
                data-testid="ai-view-switcher"
                className="ai-badge"
                style={{ cursor: "pointer", fontSize: 10.5, padding: "3px 8px" }}
                aria-label="Switch hub view"
                aria-expanded={menu === "views"}
                onClick={() => setMenu(menu === "views" ? null : "views")}
              >
                <span>{getHubViewLabel(activeView, { compact: compactModeProp || mode === "panel" })}</span>
                <ChevronDown size={11} style={{ marginLeft: 3 }} />
              </button>
              {menu === "views" && (
                <div className="ai-popover" aria-label="Switch view menu">
                  <strong>Workspace views</strong>
                  {visibleHubViews.map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-current={activeView === v ? "true" : undefined}
                      onClick={() => {
                        setView(v);
                        setMenu(null);
                      }}
                    >
                      {getHubViewLabel(v, { compact: compactModeProp })}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      handleToggleLabs(!labsEnabled);
                    }}
                  >
                    {labsEnabled ? "Hide Labs views" : "Show Labs views"}
                  </button>
                </div>
              )}
            </div>
          )}
          {hub && (
            <button
              type="button"
              data-testid="ai-hub-demo-toggle"
              className={`ai-badge ${hub.demoMode ? "ai-badge-warn" : ""}`}
              style={{
                cursor: isWebBrowserMode() ? "not-allowed" : "pointer",
                fontSize: 10.5,
                padding: "3px 8px",
              }}
              title={
                isWebBrowserMode()
                  ? DEMO_MODE_SET_BY_SERVER
                  : "Turn the interactive demo lab (a scripted 12-node environment) on or off"
              }
              disabled={isWebBrowserMode()}
              onClick={() =>
                void act({
                  action: "demo-mode-toggle",
                  enabled: !hub.demoMode,
                })
              }
            >
              {hub.demoMode ? "Demo lab: on" : "Demo lab: off"}
            </button>
          )}
          <button
            className="ai-icon-button"
            aria-label="New chat"
            title="New chat"
            onClick={newChat}
          >
            <Plus size={17} />
          </button>
          <button
            className="ai-icon-button"
            aria-label="Chat history"
            title="Chat history"
            aria-expanded={menu === "history"}
            onClick={() => setMenu(menu === "history" ? null : "history")}
          >
            <History size={16} />
          </button>
          <button
            className="ai-icon-button"
            aria-label="AI settings"
            title="AI settings"
            onClick={() => {
              setSettingsOpen(true);
              setMenu(null);
            }}
          >
            <SettingsIcon size={15} />
          </button>
          <button
            className="ai-expand-button"
            aria-label={mode === "hub" ? "Collapse chat" : "Expand chat"}
            title={mode === "hub" ? "Collapse chat to sidebar" : "Expand chat to full view"}
            onClick={() => {
              setMode(mode === "hub" ? "panel" : "hub");
              setMenu(null);
            }}
          >
            {mode === "hub" ? (
              <>
                <Minimize2 size={14} />
                <span>Sidebar</span>
              </>
            ) : (
              <>
                <Maximize2 size={14} />
                <span>Full view</span>
              </>
            )}
          </button>
          <button
            className="ai-icon-button"
            aria-label="Close AI panel"
            title="Close chat"
            onClick={() => setMode("closed")}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      {menu === "history" && (
        <div className="ai-history" aria-label="Conversation history">
          <button className="ai-history-new" onClick={newChat}>
            <Plus size={14} /> New chat
          </button>
          {!hub?.tasks.some(isConversation) && (
            <p className="ai-hint">Your conversations will appear here.</p>
          )}
          {/* Same list as the sidebar: background runs are not conversations. */}
          {[...(hub?.tasks ?? [])].filter(isConversation).reverse().map((t) => (
            <button
              className="ai-history-entry"
              key={t.id}
              aria-current={t.id === taskId ? "true" : undefined}
              onClick={() => chooseTask(t.id)}
            >
              <MessageSquare size={14} />
              <span>
                {t.title}
                <small>{new Date(t.updatedAt).toLocaleDateString()}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      <nav aria-label="Hub views" className={mode === "hub" ? "ai-nav-rail" : undefined}>
        {(mode === "hub"
          ? visibleHubViews
          : (["Work", "Inbox", "Workforce", "Knowledge Base"] as View[])
        ).map((name) => {
          const badgeCount =
            name === "Inbox"
              ? // What still waits for somebody: an alert that was acknowledged stays listed and is not counted.
                (hub ? countWaitingInboxItems(hub) : 0)
              : name === "Workforce"
              ? (hub?.workTickets ?? []).filter((t) => t.status === "review" || t.status === "in_progress").length
              : name === "Agents & MCP"
              ? (hub?.agents?.length ?? 0) + (hub?.mcpServers?.length ?? 0)
              : name === "Knowledge Base"
                ? (hub?.kbDocuments?.length ?? 0)
                : name === "Memory & skills"
                  ? (hub?.memories ?? []).filter((m) => !m.id.startsWith("auto-node:") && !m.id.startsWith("auto-cluster:")).length
                  : name === "Schedules"
                    ? (hub?.schedules?.length ?? 0)
                    : 0;
          return (
            <button
              key={name}
              aria-current={activeView === name ? "page" : undefined}
              onClick={() => {
                setView(name);
                setMenu(null);
              }}
            >
              <span>{getHubViewLabel(name, { compact: compactModeProp || mode === "panel" })}</span>
              {badgeCount > 0 && (
                <span className="ai-nav-badge">{badgeCount}</span>
              )}
            </button>
          );
        })}
        {mode === "hub" && (
          <button
            type="button"
            data-testid="ai-hub-labs-toggle"
            className={`ai-labs-nav-toggle ${labsEnabled ? "active" : ""}`}
            aria-pressed={labsEnabled}
            title="Show or hide Labs views (Memory & skills, Agents & MCP, Schedules)"
            onClick={() => handleToggleLabs(!labsEnabled)}
          >
            <FlaskConical size={12} />
            <span>{labsEnabled ? "More: on" : "More: Memory, Agents & MCP, Schedules"}</span>
          </button>
        )}
      </nav>
      {error && (
        <div className="ai-error" role="alert">
          {error}
          {isModelSetupMessage(error) && (
            <button type="button" className="ai-code-btn" onClick={() => setSettingsOpen(true)}>
              Open AI settings
            </button>
          )}
          <button
            className="ai-icon-button"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {notice && (
        <div className="ai-error ai-notice" role="status">
          {notice}
          <button
            className="ai-icon-button"
            aria-label="Dismiss note"
            onClick={() => setNotice("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {!hub ? (
        <p className="ai-empty">Connecting…</p>
      ) : (
        <>
          {activeView === "Work" && (
            <div className="ai-work-layout">
              {mode === "hub" && (
                <aside className="ai-work-sidebar" aria-label="Full view sidebar">
                  <div className="ai-sidebar-section">
                    <div className="ai-sidebar-header">
                      <strong>Conversations</strong>
                      <button
                        className="ai-sidebar-new"
                        onClick={newChat}
                        title="Start a new conversation"
                      >
                        <Plus size={13} /> New
                      </button>
                    </div>
                    <div className="ai-sidebar-list">
                      {!hub.tasks.some(isConversation) && (
                        <small className="ai-hint">No conversations yet.</small>
                      )}
                      {/* A workforce specialist's run is shown in its workforce conversation. */}
                      {[...hub.tasks].filter(isConversation).reverse().map((t) => (
                        <button
                          key={t.id}
                          className="ai-sidebar-item"
                          aria-current={t.id === taskId ? "true" : undefined}
                          onClick={() => chooseTask(t.id)}
                        >
                          <MessageSquare size={13} />
                          <div>
                            <span>{t.title}</span>
                            <small>
                              {t.target?.label ?? "Workspace"} ·{" "}
                              {new Date(t.updatedAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </small>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* A section with nothing in it is not shown. */}
                  <div
                    className="ai-sidebar-section"
                    hidden={hub.sessions.every((s) => s.state === "disconnected")}
                  >
                    <div className="ai-sidebar-header">
                      <strong>Active Terminals</strong>
                      <small>{hub.sessions.filter((s) => s.state !== "disconnected").length}</small>
                    </div>
                    <div className="ai-sidebar-list">
                      {hub.sessions.filter((s) => s.state !== "disconnected").length === 0 ? (
                        <small className="ai-hint">No active terminals open.</small>
                      ) : (
                        hub.sessions
                          .filter((s) => s.state !== "disconnected")
                          .map((s) => (
                            <button
                              key={s.id}
                              className="ai-sidebar-item"
                              aria-current={s.id === selectedTerminal ? "true" : undefined}
                              onClick={() => {
                                selectAiTerminal(s.id);
                                setConnection(undefined);
                              }}
                            >
                              <Terminal size={13} />
                              <div>
                                <span>{s.label}</span>
                                <small>
                                  {s.state === "ready"
                                    ? "Connected · Ready"
                                    : s.state === "busy"
                                      ? "Connected · Working"
                                      : "Connected"}
                                </small>
                              </div>
                            </button>
                          ))
                      )}
                    </div>
                  </div>

                  <div className="ai-sidebar-section">
                    <div className="ai-sidebar-header">
                      <strong>Mission Agents</strong>
                      <button
                        className="ai-sidebar-new"
                        onClick={() => setView("Agents & MCP")}
                        title="Manage Mission Agents & MCP servers"
                      >
                        Manage
                      </button>
                    </div>
                    <div className="ai-sidebar-list">
                      {(hub.agents ?? []).map((ag) => (
                        <button
                          key={ag.id}
                          className="ai-sidebar-item"
                          aria-current={selectedAgentId === ag.id ? "true" : undefined}
                          onClick={() => {
                            setSelectedAgentId(
                              selectedAgentId === ag.id ? "" : ag.id,
                            );
                            setAutonomy(ag.defaultMode);
                          }}
                        >
                          <span>{ag.icon || ag.name.slice(0, 1).toUpperCase()}</span>
                          <div>
                            <span>{ag.name}</span>
                            <small>
                              {ag.targetCluster || ag.role} · {ag.defaultMode}
                            </small>
                          </div>
                        </button>
                      ))}
                      <button
                        type="button"
                        className="ai-btn-emerald"
                        style={{ marginTop: 4, fontSize: 11.5, textAlign: "center" }}
                        onClick={() => {
                          const prevIds = new Set(hub.tasks.map((t) => t.id));
                          void act({
                            action: "workforce-run",
                            prompt:
                              "Review our shared servers and clusters: recent team changes, known problems in the knowledge base, and what should be checked next.",
                          }).then((nextSnap) => {
                            const created = nextSnap?.tasks.find(
                              (t) => !prevIds.has(t.id),
                            );
                            if (created?.id) setTaskId(created.id);
                          });
                        }}
                      >
                        Run a workforce review
                      </button>
                    </div>
                  </div>

                  <div
                    className="ai-sidebar-section"
                    hidden={(hub.activityLog ?? []).length === 0}
                  >
                    <div className="ai-sidebar-header">
                      <strong>Recent Team Activity</strong>
                    </div>
                    <div className="ai-sidebar-list">
                      {(hub.activityLog ?? []).slice(0, 4).map((evt) => (
                        <div key={evt.id} className="ai-sidebar-activity">
                          <div className="ai-sidebar-activity-top">
                            <strong>{evt.actor}</strong>
                            <small>{evt.targetLabel}</small>
                          </div>
                          <p>{evt.summary}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </aside>
              )}
              <div className="ai-chat-body">
              <div
                className="ai-scroll ai-conversation"
                ref={conversation}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  follow.current =
                    el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                }}
              >
                {!task && !connection && !sending && (
                  <div className="ai-welcome">
                    <h2>What can I help with?</h2>
                    <p>
                      Pick a <strong>Mission Agent</strong>, or ask about your clusters, VMs, S3 buckets, runbooks and MCP tools.
                    </p>
                    {/* Shown until AI is on and set up, so a failed attempt can be tried again. */}
                    {!aiSetUp && (
                        <article
                          className="ai-card ai-card-active"
                          data-testid="ai-hub-quick-connect-card"
                          style={{ marginBottom: 14, textAlign: "left" }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <strong>Connect your AI</strong>
                            <span className="ai-badge ai-badge-green">
                              {(hub.agents ?? []).length} agent(s) · {(hub.kbDocuments ?? []).length} runbooks
                            </span>
                          </div>
                          <p style={{ fontSize: 11.5, margin: "6px 0 10px" }}>
                            Choose how to connect a model:
                          </p>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            <button
                              type="button"
                              className="ai-btn-emerald"
                              onClick={() =>
                                void act({
                                  action: "configure",
                                  config: {
                                    enabled: true,
                                    provider: "openai-codex",
                                    model: hub.config.codexDefaultModel || "gpt-6.1-sol",
                                    useHermes: false,
                                  },
                                })
                              }
                            >
                              Sign in with ChatGPT / Codex
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void connectLocalOllama()}
                            >
                              Local Ollama (localhost:11434)
                            </button>
                            <button
                              type="button"
                              onClick={() => setSettingsOpen(true)}
                            >
                              Paste an API key (OpenAI / Claude)…
                            </button>
                          </div>
                        </article>
                      )}
                    {(hub.agents ?? []).length > 0 && (
                      <div className="ai-agent-quick-bar" aria-label="Quick select Mission Agent">
                        <button
                          type="button"
                          className={`ai-agent-pill ${!selectedAgentId ? "active" : ""}`}
                          onClick={() => setSelectedAgentId("")}
                        >
                          Assistant
                        </button>
                        {(hub.agents ?? []).map((ag) => (
                          <button
                            key={ag.id}
                            type="button"
                            className={`ai-agent-pill ${selectedAgentId === ag.id ? "active" : ""}`}
                            onClick={() => {
                              setSelectedAgentId(ag.id);
                              setAutonomy(ag.defaultMode);
                            }}
                          >
                            <span>{ag.icon || ag.name.slice(0, 1).toUpperCase()}</span>
                            <span>{ag.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {activeAgent && (
                      <article className="ai-card ai-card-active" style={{ marginBottom: 14 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                          <div>
                            <strong>
                              {activeAgent.icon ? `${activeAgent.icon} ` : ""}{activeAgent.name}
                            </strong>
                            <div>
                              <small>{activeAgent.role}</small>
                            </div>
                          </div>
                          {activeAgent.targetCluster && (
                            <span className="ai-badge ai-badge-cluster">
                              {activeAgent.targetCluster}
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: 12, margin: "8px 0" }}>
                          <strong>Mission:</strong> {activeAgent.mission}
                        </p>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          <button
                            type="button"
                            className="ai-btn-emerald"
                            onClick={() => {
                              void act({
                                action: "agent-run-mission",
                                id: activeAgent.id,
                              }).then((nextSnap) => {
                                const started = nextSnap?.reply?.started?.taskId;
                                if (started) setTaskId(started);
                              });
                            }}
                          >
                            Run the mission now
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPrompt(
                                `Carry out your mission for ${activeAgent.targetCluster ? `@cluster:${activeAgent.targetCluster}` : "our infrastructure"}: ${activeAgent.mission}`,
                              )
                            }
                          >
                            Adjust the mission in chat
                          </button>
                        </div>
                      </article>
                    )}
                    <div className="ai-welcome-grid">
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Run a parallel health check across the nodes of my clusters with sshs3_cluster_exec and summarise load, disk, failed services and anything unusual.",
                          )
                        }
                      >
                        <strong>Run across a cluster</strong>
                        <small>Run a command on every node of a cluster and get one report</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Open a 2x2 split-view terminal grid for the nodes of one of my clusters; ask me which cluster if there are several.",
                          )
                        }
                      >
                        <strong>Open a cluster split view</strong>
                        <small>Have the assistant open a split terminal grid or the dual-pane explorer</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Diff a configuration file between two of my servers with sshs3_storage_ops; ask me which file and which servers.",
                          )
                        }
                      >
                        <strong>Compare configuration between servers</strong>
                        <small>Diff configuration files between two nodes, or inspect S3 buckets</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Search our knowledge base (@kb) for what I describe next, and tell me which runbook applies.",
                          )
                        }
                      >
                        <strong>Search the runbooks</strong>
                        <small>Find the runbook that applies; combine it with data from connected MCP servers</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        data-testid="ai-starter-configure-sshs3"
                        onClick={() =>
                          setPrompt(
                            "Configure sshs3 for me: set up an SSH port-forwarding tunnel (local 5432 -> 127.0.0.1:5432), switch on the performance row in the status bar, and turn on dotfiles sync for ~/.zshrc and ~/.tmux.conf.",
                          )
                        }
                      >
                        <strong>Configure sshS3</strong>
                        <small>Tunnels, S3 profiles, shortcuts, dotfiles, cloud sync and themes</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        data-testid="ai-starter-workforce"
                        onClick={() => {
                          const prevIds = new Set(hub.tasks.map((t) => t.id));
                          void act({
                            action: "workforce-run",
                            prompt:
                              "Review our shared servers and clusters: recent team changes, known problems in the knowledge base, and what should be checked next.",
                          }).then((nextSnap) => {
                            const created = nextSnap?.tasks.find(
                              (t) => !prevIds.has(t.id),
                            );
                            if (created?.id) setTaskId(created.id);
                          });
                        }}
                      >
                        <strong>Run a workforce review</strong>
                        <small>Your Mission Agents investigate in parallel (read-only) and one report combines their findings</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "/plan Write a safe plan with risks, verification steps and rollback for a rolling upgrade of one of my clusters.",
                          )
                        }
                      >
                        <strong>Plan first: /plan</strong>
                        <small>Have a change planned and reviewed before anything runs, or your design questioned</small>
                      </button>
                    </div>
                    {/* The example answer is invented data: shown in the demo lab only. */}
                    <div hidden={!hub.demoMode} style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="ai-btn-accent"
                        onClick={() => setShowDemoPreview((prev) => !prev)}
                      >
                        {showDemoPreview
                          ? "Hide the example"
                          : "Show an example answer (invented data)"}
                      </button>
                    </div>
                    {showDemoPreview && (
                      <div style={{ marginTop: "14px" }}>
                        <article className="ai-message ai-message-user">
                          <div className="ai-message-header">
                            <span className="ai-message-author">
                              <span className="ai-avatar-badge">Y</span>
                              <span>You</span>
                            </span>
                            <span className="ai-message-meta">Example · @cluster:NetApp-ONTAP-Prod-SE</span>
                          </div>
                          <p>
                            Run a health check across @cluster:NetApp-ONTAP-Prod-SE in parallel and diff /etc/multipath.conf between k8s-storage-cp-01 and k8s-gpu-io-worker-01.
                          </p>
                        </article>
                        <details className="ai-change ai-change-completed" open>
                          <summary>
                            <Terminal size={13} />
                            <span>Ran on 4 nodes of NetApp-ONTAP-Prod-SE in parallel</span>
                            <span className="ai-badge ai-badge-success">done · 4 of 4 nodes · exit 0</span>
                          </summary>
                          <pre>qos statistics volume latency show -iterations 1; snapmirror show</pre>
                          <div className="ai-change-meta">
                            <span className="ai-badge ai-badge-cluster">NetApp-ONTAP-Prod-SE</span>
                            <span className="ai-tool-tag">netapp-aff-a800-01a</span>
                            <span className="ai-tool-tag">netapp-aff-a800-01b</span>
                            <span className="ai-tool-tag">netapp-fas9000-dr-01</span>
                            <span className="ai-tool-tag">ontap-aiq-um-01</span>
                          </div>
                        </details>
                        <article className="ai-message ai-message-assistant">
                          <div className="ai-message-header">
                            <span className="ai-message-author">
                              <span className="ai-avatar-badge">A</span>
                              <span>Assistant</span>
                              <span className="ai-pill">NetApp ONTAP Storage Architect</span>
                            </span>
                            <span className="ai-message-meta">
                              <button
                                type="button"
                                className="ai-code-btn"
                                onClick={() => void copyMessage("demo-showcase", DEMO_SHOWCASE_RESPONSE)}
                              >
                                {copiedMsgId === "demo-showcase" ? "Copied" : "Copy answer"}
                              </button>
                            </span>
                          </div>
                          <RichMarkdownContent
                            text={DEMO_SHOWCASE_RESPONSE}
                            onUseCommand={stageCommandInTerminal}
                            onRunCommand={runCommandInTerminal}
                            onOpenFileRef={handleOpenFileRef}
                          />
                        </article>
                      </div>
                    )}
                  </div>
                )}
                {task && (
                  <div
                    className="ai-task-context-bar"
                    data-testid="ai-task-context-bar"
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span className="ai-badge ai-badge-purple">
                        {activeAgent?.icon ? `${activeAgent.icon} ` : ""}
                        {task.agentName || activeAgent?.name || "Assistant"}
                      </span>
                      <span
                        className="ai-badge ai-badge-success"
                        title="Command safety checks apply to every command in this conversation"
                      >
                        Safety checks on
                      </span>
                      <button
                        type="button"
                        className="ai-mini-btn"
                        data-testid="ai-task-fork-btn"
                        disabled={busy}
                        title="Fork this conversation into a new branch"
                        onClick={() => void handleForkTask()}
                      >
                        <GitFork size={11} />
                        Fork
                      </button>
                      <button
                        type="button"
                        className="ai-mini-btn"
                        data-testid="ai-task-compact-btn"
                        disabled={busy || task.messages.length === 0}
                        title="Compact older messages to save context tokens"
                        onClick={() => void handleCompactTask()}
                      >
                        Compact
                      </button>
                      {task.changes.some(
                        (c) => c.status === "pending" && c.riskLevel === "safe",
                      ) && (
                        <button
                          type="button"
                          className="ai-btn-emerald"
                          style={{ padding: "2px 8px", fontSize: 10.5 }}
                          disabled={busy}
                          onClick={() => {
                            const safePending = task.changes.filter(
                              (c) =>
                                c.status === "pending" && c.riskLevel === "safe",
                            );
                            for (const c of safePending) {
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId: c.id,
                                approved: true,
                              });
                            }
                          }}
                        >
                          Approve all read-only (
                          {
                            task.changes.filter(
                              (c) =>
                                c.status === "pending" && c.riskLevel === "safe",
                            ).length
                          }
                          )
                        </button>
                      )}
                    </div>
                    {(hub.agents ?? []).length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <small>Hand over:</small>
                        <select
                          aria-label="Swarm Handoff to specialist agent"
                          data-testid="chat-swarm-handoff-select"
                          style={{ padding: "2px 6px", fontSize: 11 }}
                          value={task.agentId || selectedAgentId || ""}
                          onChange={(e) => {
                            const nextAgentId = e.target.value;
                            if (!nextAgentId) return;
                            setSelectedAgentId(nextAgentId);
                            void act({
                              action: "agent-handoff",
                              taskId: task.id,
                              toAgentId: nextAgentId,
                              reason: "Handed over from the conversation",
                            });
                          }}
                        >
                          <option value="">Choose an agent…</option>
                          {(hub.agents ?? []).map((ag) => (
                            <option key={ag.id} value={ag.id}>
                              {ag.icon ? `${ag.icon} ` : ""}{ag.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
                {timeline.map((item, idx) =>
                  item.message ? (
                    <article
                      className={
                        "ai-message ai-message-" +
                        item.message.role +
                        // What the app told the agent on the user's behalf (a plan decision) is a one-line note.
                        (item.message.text.startsWith("[sshs3]") ? " ai-message-note" : "")
                      }
                      key={item.message.id}
                    >
                      <div className="ai-message-header">
                        <small className="ai-message-author">
                          <span className="ai-avatar-badge">
                            {item.message.role === "user"
                              ? "Y"
                              : activeAgent?.icon || "A"}
                          </span>
                          <span>
                            {item.message.role === "user"
                              ? "You"
                              : item.message.role === "assistant"
                                ? "Assistant"
                                : "sshs3"}
                          </span>
                          {item.message.role === "assistant" &&
                            (task?.agentName || activeAgent?.name) && (
                              <span className="ai-pill">
                                {task?.agentName || activeAgent?.name}
                              </span>
                            )}
                        </small>
                        <span className="ai-message-meta">
                          {item.message.at > 0 && (
                            <span>
                              {new Date(item.message.at).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          )}
                          {item.message.role === "user" && !running && (
                            <>
                              <button
                                type="button"
                                className="ai-code-btn"
                                title="Edit prompt in composer"
                                onClick={() => {
                                  setPrompt(item.message!.text);
                                  setTimeout(() => composer.current?.focus(), 20);
                                }}
                              >
                                <Pencil size={11} /> Edit
                              </button>
                              {/* Asking again posts the question once more, so it is offered only on the last one. */}
                              {item.message.id === lastUserMessageId(task) && (
                                <button
                                  type="button"
                                  className="ai-code-btn"
                                  data-testid="ai-message-retry"
                                  title="Ask again"
                                  onClick={() =>
                                    void sendMessage(
                                      terminal && terminal.state !== "disconnected" ? terminal.id : undefined,
                                      { overridePrompt: item.message!.text },
                                    )
                                  }
                                >
                                  <RotateCcw size={11} /> Retry
                                </button>
                              )}
                            </>
                          )}
                          {task && (
                            <button
                              type="button"
                              className="ai-code-btn"
                              title="Fork conversation from this message"
                              onClick={() => void handleForkTask(item.message!.id)}
                            >
                              <GitFork size={11} /> Fork
                            </button>
                          )}
                          {item.message.role === "assistant" && (
                            <button
                              type="button"
                              className="ai-code-btn"
                              title="Copy the whole answer"
                              onClick={() => void copyMessage(item.message!.id, item.message!.text)}
                            >
                              {copiedMsgId === item.message.id
                                ? "Copied"
                                : "Copy"}
                            </button>
                          )}
                        </span>
                      </div>
                      {item.message.images && item.message.images.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "8px",
                            marginBottom: "8px",
                          }}
                        >
                          {item.message.images.map((img, imgIdx) => (
                            <img
                              key={imgIdx}
                              src={img.dataUrl}
                              alt={img.label}
                              title={img.label}
                              style={{
                                maxWidth: "240px",
                                maxHeight: "160px",
                                borderRadius: "8px",
                                border: "1px solid rgba(255,255,255,0.14)",
                                objectFit: "cover",
                              }}
                            />
                          ))}
                        </div>
                      )}
                      <RichMarkdownContent
                        text={item.message.text.startsWith(CONTEXT_NOTE_PREFIX) ? item.message.text.slice(CONTEXT_NOTE_PREFIX.length) : item.message.text}
                        refs={
                          item.message.role === "assistant" && task
                            ? new Set(task.changes.flatMap((c) => (c.ref ? [c.ref] : [])))
                            : undefined
                        }
                        onOpenRef={(ref) => {
                          const el = document.querySelector<HTMLDetailsElement>(`[data-ref="${ref}"]`);
                          if (!el) return;
                          el.open = true;
                          el.scrollIntoView({ block: "center", behavior: "smooth" });
                          el.classList.add("ai-change-flash");
                          setTimeout(() => el.classList.remove("ai-change-flash"), 1600);
                        }}
                        onUseCommand={stageCommandInTerminal}
                        onRunCommand={runCommandInTerminal}
                        onOpenFileRef={handleOpenFileRef}
                      />
                      {item.message.role === "assistant" &&
                        idx === timeline.length - 1 &&
                        !running && (
                          <div className="ai-message-footer">
                            <button
                              type="button"
                              className="ai-msg-action-btn"
                              onClick={() => void copyMessage(item.message!.id, item.message!.text)}
                            >
                              {copiedMsgId === item.message.id
                                ? "Copied"
                                : "Copy answer"}
                            </button>
                            <button
                              type="button"
                              className="ai-msg-action-btn"
                              onClick={() => {
                                void act({
                                  action: "memory-save",
                                  entry: {
                                    kind: "memory",
                                    scope: "workspace",
                                    title:
                                      task?.title?.slice(0, 60) ||
                                      "From an AI conversation",
                                    text: item.message!.text.slice(0, 1200),
                                  },
                                });
                              }}
                            >
                              Save to team memory
                            </button>
                            <button
                              type="button"
                              className="ai-msg-action-btn"
                              onClick={() => {
                                setPrompt(
                                  "Keep investigating and propose the next concrete verification step.",
                                );
                                setTimeout(() => composer.current?.focus(), 20);
                              }}
                            >
                              Follow up
                            </button>
                          </div>
                        )}
                    </article>
                  ) : item.change && task ? (
                    <details
                      className={"ai-change ai-change-" + item.change.status}
                      key={item.change.id}
                      data-ref={item.change.ref}
                      open={item.change.status === "pending"}
                    >
                      <summary>
                        <Terminal size={13} />
                        {item.change.ref && <small className="ai-ref-name">{item.change.ref}</small>}
                        <span>{item.change.description}</span>
                        {item.change.riskLevel && (
                          <small
                            className={
                              item.change.riskLevel === "safe"
                                ? "ai-badge ai-badge-success"
                                : item.change.riskLevel === "destructive"
                                  ? "ai-badge ai-badge-danger"
                                  : "ai-badge ai-badge-mode"
                            }
                            title={item.change.riskReason}
                            data-testid={`change-risk-${item.change.riskLevel}`}
                          >
                            {item.change.riskLevel === "safe"
                              ? "read-only"
                              : item.change.riskLevel === "destructive"
                                ? "destructive"
                                : "changes state"}
                          </small>
                        )}
                        <small
                          className={
                            item.change.status === "pending"
                              ? "ai-badge ai-badge-mode"
                              : item.change.status === "completed" ||
                                  item.change.status === "approved"
                                ? "ai-badge ai-badge-success"
                                : "ai-badge"
                          }
                        >
                          {item.change.status === "pending"
                            ? "Approval needed"
                            : item.change.status}
                        </small>
                      </summary>
                      <ChangeProof change={item.change} />
                      {item.change.riskReason && (
                        <small
                          style={{
                            display: "block",
                            marginTop: 6,
                            fontSize: 11,
                            opacity: 0.85,
                          }}
                        >
                          {item.change.riskReason}
                          {(item.change.parsedSubcommands?.length ?? 0) > 1
                            ? ` · ${item.change.parsedSubcommands!.length} commands in it, each judged on its own`
                            : ""}
                        </small>
                      )}
                      {item.change.command && (
                        <div className="ai-code-block" style={{ marginTop: "8px" }}>
                          <div className="ai-code-header">
                            <span className="ai-code-lang">command</span>
                            <button
                              type="button"
                              className="ai-code-btn"
                              onClick={() => void copyToClipboard(item.change!.command!)}
                            >
                              Copy
                            </button>
                          </div>
                          <pre>{item.change.command}</pre>
                        </div>
                      )}
                      {item.change.kind === "file" && item.change.diff && (
                        <div className="ai-diff">
                          <strong>What changes</strong>
                          <DiffViewer diff={item.change.diff} filePath={item.change.target} />
                        </div>
                      )}
                      {item.change.kind === "file" && !item.change.diff && (
                        <div className="ai-diff">
                          <DiffViewer
                            before={item.change.before ?? ""}
                            after={item.change.after ?? ""}
                            filePath={item.change.target}
                          />
                        </div>
                      )}
                      {item.change.output && (
                        <AnsiLogView text={item.change.output} maxLines={40} />
                      )}
                      <div className="ai-change-meta">
                        <span className="ai-tool-tag">
                          {item.change.target}
                        </span>
                        {item.change.exitCode !== undefined && (
                          <span
                            className={
                              item.change.exitCode === 0
                                ? "ai-badge ai-badge-success"
                                : "ai-badge ai-badge-mode"
                            }
                          >
                            {"exit " + item.change.exitCode}
                          </span>
                        )}
                        {(() => {
                          const checkpointId = (item.change as { checkpointId?: string }).checkpointId;
                          if (!checkpointId && !(item.change.kind === "file" && item.change.status === "completed")) {
                            return null;
                          }
                          return (
                            <button
                              type="button"
                              className="ai-mini-btn"
                              data-testid={`ai-restore-checkpoint-${item.change!.id}`}
                              disabled={busy}
                              onClick={() => {
                                if (checkpointId) {
                                  // The hub finds the checkpoint by the change it belongs to.
                                  void handleRestoreCheckpoint(item.change!.id);
                                } else {
                                  void act({
                                    action: "rollback-change",
                                    taskId: task.id,
                                    changeId: item.change!.id,
                                  });
                                }
                              }}
                            >
                              <RotateCcw size={11} />
                              Restore Checkpoint
                            </button>
                          );
                        })()}
                      </div>
                      {item.change.status === "pending" && (
                        <div className="ai-approval-actions">
                          <input
                            type="text"
                            aria-label="Note for the agent"
                            placeholder="Note for the agent (optional), e.g. use --dry-run first"
                            value={approvalNotes[item.change.id] ?? ""}
                            onChange={(e) => setApprovalNotes({ ...approvalNotes, [item.change!.id]: e.target.value })}
                          />
                          <button
                            className="ai-primary"
                            disabled={busy}
                            onClick={() =>
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId: item.change!.id,
                                approved: true,
                                note: approvalNotes[item.change!.id]?.trim() || undefined,
                              })
                            }
                          >
                            Approve
                          </button>
                          <button
                            disabled={busy}
                            title="The run goes on; the agent is told no, and why if you wrote a note"
                            onClick={() =>
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId: item.change!.id,
                                approved: false,
                                note: approvalNotes[item.change!.id]?.trim() || undefined,
                              })
                            }
                          >
                            Decline
                          </button>
                        </div>
                      )}
                      {item.change.decisionNote && (
                        <small className="ai-hint">Note with the answer: {item.change.decisionNote}</small>
                      )}
                    </details>
                  ) : null,
                )}
                {(() => {
                  const combinedTools = [
                    ...(task?.toolLog ?? []),
                    ...(streamingState?.tools ?? []),
                  ];
                  if (!task || combinedTools.length === 0) return null;
                  return (
                    <section className="ai-tool-log" data-testid="ai-tool-log-list" aria-label="Tool execution steps">
                      {combinedTools.map((rec, toolIdx) => {
                        const dur = formatDurationBadge(rec.durationMs);
                        return (
                          <details
                            key={`${rec.name}-${rec.at}-${toolIdx}`}
                            className="ai-change"
                            open={toolIdx === combinedTools.length - 1 && running}
                          >
                            <summary>
                              <span className="ai-change-summary">
                                <strong>{rec.name}</strong>
                                {rec.target && <span className="ai-tool-tag">{rec.target}</span>}
                                {dur && (
                                  <small className="ai-hint" style={TABULAR_NUMS_STYLE}>
                                    {dur}
                                  </small>
                                )}
                              </span>
                              <span
                                className={
                                  rec.ok === false || (rec.exitCode !== undefined && rec.exitCode !== 0)
                                    ? "ai-badge ai-badge-danger"
                                    : "ai-badge ai-badge-success"
                                }
                              >
                                {rec.exitCode !== undefined
                                  ? `exit ${rec.exitCode}`
                                  : rec.ok === false
                                    ? "failed"
                                    : "ok"}
                              </span>
                            </summary>
                            {rec.input && (
                              <pre className="ai-code-pre">
                                <HighlightedCode code={rec.input} lang="shell" />
                              </pre>
                            )}
                            {rec.output && (
                              isDiffToolRecord(rec) ? (
                                <DiffViewer diff={rec.output} filePath={rec.target} />
                              ) : isAnsiToolRecord(rec) ? (
                                <AnsiLogView text={rec.output} maxLines={36} />
                              ) : (
                                <pre className="ai-code-pre">
                                  <HighlightedCode code={rec.output} lang="text" />
                                </pre>
                              )
                            )}
                          </details>
                        );
                      })}
                    </section>
                  );
                })()}
                {task?.sources && task.sources.length > 0 && (
                  <div className="ai-sources-bar" data-testid="ai-task-sources" aria-label="Context sources">
                    <small className="ai-hint">Sources:</small>
                    {task.sources.map((src) =>
                      // What was read in the team's chat opens the thread it came from.
                      src.kind === "chat" && src.link ? (
                        <a key={src.id} className="ai-pill" title={src.text.slice(0, 200)} href={src.link} target="_blank" rel="noreferrer noopener">
                          {src.label}
                        </a>
                      ) : (
                        <span
                          key={src.id}
                          className="ai-pill"
                          title={src.text.slice(0, 200)}
                        >
                          {src.label}
                        </span>
                      ),
                    )}
                  </div>
                )}
                {streamingState &&
                  streamingState.text &&
                  !task?.messages.some(
                    (m) => m.role === "assistant" && m.text === streamingState.text,
                  ) && (
                  <article className="ai-message ai-message-assistant" data-testid="ai-streaming-message">
                    <div className="ai-message-header">
                      <small className="ai-message-author">
                        <span className="ai-avatar-badge">{activeAgent?.icon || "A"}</span>
                        <span>Assistant</span>
                        <span className="ai-pill">Streaming</span>
                      </small>
                    </div>
                    <RichMarkdownContent
                      text={streamingState.text}
                      onUseCommand={stageCommandInTerminal}
                      onRunCommand={runCommandInTerminal}
                      onOpenFileRef={handleOpenFileRef}
                    />
                  </article>
                )}
                {targetSessionId && (
                  <TerminalControl
                    sessionId={targetSessionId}
                    hub={hub}
                    onRequest={act}
                  />
                )}
                {/* The plan comes where it was proposed: after what was said, as the last thing to read. */}
                {task?.plan && (
                  <PlanCard
                    taskId={task.id}
                    plan={task.plan}
                    busy={["queued", "running", "waiting"].includes(task.status)}
                    act={act}
                  />
                )}
                {task?.error && (
                  <p className="ai-task-error">
                    {task.error}
                    {isModelSetupMessage(task.error) && (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="ai-code-btn"
                          data-testid="ai-task-error-settings"
                          onClick={() => setSettingsOpen(true)}
                        >
                          Open AI settings
                        </button>
                      </>
                    )}
                  </p>
                )}
                {sending && (
                  <article className="ai-message ai-message-user ai-message-sending" data-testid="message-sending">
                    <div className="ai-message-header">
                      <small className="ai-message-author">
                        <span className="ai-avatar-badge">Y</span>
                        <span>You</span>
                      </small>
                      <span className="ai-message-meta">Sending…</span>
                    </div>
                    <RichMarkdownContent text={sending} />
                  </article>
                )}
                {running && (
                  <p className="ai-activity" aria-live="polite">
                    <span className="ai-activity-dot" />
                    {pending
                      ? "Waiting for your approval"
                      : task?.status === "queued"
                        ? "Starting…"
                        : "Working…"}
                    {task && task.status !== "queued" && (
                      <small className="ai-hint" data-testid="run-budget">
                        {" "}· {task.commandsUsed ?? 0}{task.maxCommands > 0 ? ` of ${task.maxCommands}` : ""} commands
                      </small>
                    )}
                  </p>
                )}
                {task?.budgetStop && !running && (
                  <div className="ai-resume">
                    <p>The run used its budget. Continue gives it the same budget again.</p>
                    <button
                      className="ai-primary"
                      disabled={busy}
                      onClick={() =>
                        void act({ action: "resume", taskId: task.id })
                      }
                    >
                      Continue
                    </button>
                  </div>
                )}
                {task?.status === "interrupted" && !task.budgetStop && (
                  <div className="ai-resume">
                    <p>Paused. Check the terminal before continuing.</p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act({ action: "resume", taskId: task.id })
                      }
                    >
                      Resume
                    </button>
                  </div>
                )}
                {task?.status === "completed" &&
                  task.verification === "verified" && (
                    <p className="ai-verification">
                      <Check size={13} /> Verification check passed
                    </p>
                  )}
                {mode === "hub" && task && !running && (
                  <button
                    className="ai-text-button"
                    onClick={() => setView("Memory & skills")}
                  >
                    Save findings as a skill
                  </button>
                )}
                {connection && (
                  <div className="ai-connect-question">
                    <span className="ai-message-author">
                      <Terminal size={14} /> Connect to {connection.label}
                    </span>
                    <p>
                      Confirm this terminal is at an idle prompt before I work
                      here.
                    </p>
                    <div className="ai-connect-actions">
                      <select
                        aria-label="Shell"
                        value={shell}
                        onChange={(e) => setShell(e.target.value as ShellKind)}
                      >
                        {SHELL_KINDS.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                      <button
                        className="ai-primary"
                        disabled={busy || !prompt.trim()}
                        onClick={() => void connectAndSend()}
                      >
                        Confirm and send
                      </button>
                      <button
                        type="button"
                        disabled={busy || !prompt.trim()}
                        onClick={() => {
                          setConnection(undefined);
                          void sendMessage(undefined);
                        }}
                      >
                        Ask without terminal
                      </button>
                      <button
                        className="ai-icon-button"
                        aria-label="Cancel terminal confirmation"
                        onClick={() => setConnection(undefined)}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                )}
                <div ref={end} />
              </div>
              {/* What the agent is working through stays in view above the composer. */}
              {task && ((task.todos?.length ?? 0) > 0 || (task.hypotheses?.length ?? 0) > 0) && (
                <div className="ai-run-dock" data-testid="ai-run-dock">
                  <HypothesisTree hypotheses={task.hypotheses} />
                  <TaskTodos todos={task.todos} startedAt={task.createdAt} />
                </div>
              )}
              {dlpWarning && (
                <div className="ai-error" role="alert" data-testid="ai-dlp-warning">
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "space-between", width: "100%" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <AlertTriangle size={14} />
                      <span>
                        Potential secret detected before sending to cloud ({dlpWarning.labels.join(", ")}).
                      </span>
                    </span>
                    <span style={{ display: "inline-flex", gap: 6 }}>
                      <button
                        type="button"
                        className="ai-primary"
                        onClick={() => {
                          const maskedPrompt = maskSecretsForDlp(dlpWarning.prompt);
                          const maskedAttachments = dlpWarning.attachments.map((a) => ({
                            ...a,
                            text: maskSecretsForDlp(a.text),
                          }));
                          setPrompt("");
                          setAttachments([]);
                          void sendMessage(dlpWarning.sessionId, {
                            overridePrompt: maskedPrompt,
                            overrideAttachments: maskedAttachments,
                            bypassDlp: true,
                          });
                        }}
                      >
                        Mask & Send
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPrompt("");
                          setAttachments([]);
                          void sendMessage(dlpWarning.sessionId, {
                            overridePrompt: dlpWarning.prompt,
                            overrideAttachments: dlpWarning.attachments,
                            bypassDlp: true,
                          });
                        }}
                      >
                        Send Anyway
                      </button>
                      <button
                        type="button"
                        onClick={() => setDlpWarning(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  </div>
                </div>
              )}
              <div className="ai-composer">
                <div className="ai-context-row">
                  <div className="ai-menu-anchor">
                    <button
                      className="ai-context-chip"
                      aria-label="Chat target"
                      title={
                        task
                          ? (task.target?.label ?? "Context only") +
                            " · fixed for this task"
                          : "Choose terminal context"
                      }
                      aria-expanded={menu === "target"}
                      disabled={!!task}
                      onClick={() =>
                        setMenu(menu === "target" ? null : "target")
                      }
                    >
                      <Terminal size={13} />
                      <span>
                        {task?.target?.label ??
                          terminal?.label ??
                          "Context only"}
                      </span>
                      {task ? (
                        <ShieldCheck size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                    </button>
                    {menu === "target" && (
                      <div className="ai-popover" aria-label="Choose terminal">
                        <strong>Terminal context</strong>
                        <button
                          onClick={() => {
                            selectAiTerminal("");
                            setConnection(undefined);
                            setMenu(null);
                          }}
                        >
                          Context only
                        </button>
                        {hub.sessions
                          .filter((s) => s.state !== "disconnected")
                          .map((s) => (
                            <button
                              key={s.id}
                              aria-current={
                                s.id === selectedTerminal ? "true" : undefined
                              }
                              onClick={() => {
                                selectAiTerminal(s.id);
                                setConnection(undefined);
                                setMenu(null);
                              }}
                            >
                              {s.label}
                              <small>
                                {s.state === "ready"
                                  ? "Connected · Ready"
                                  : "Connected"}
                              </small>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                  <div className="ai-menu-anchor">
                    <button
                      className="ai-context-chip"
                      aria-label="Add workspace context"
                      title="Attach @server, @team-changes, or @workspace context"
                      aria-expanded={menu === "mention"}
                      onClick={() =>
                        setMenu(menu === "mention" ? null : "mention")
                      }
                    >
                      <span>@ Context</span>
                      <ChevronDown size={11} />
                    </button>
                    {menu === "mention" && (
                      <div
                        className="ai-popover"
                        style={{ right: 0, left: "auto" }}
                        aria-label="Workspace context mentions"
                      >
                        <strong>Attach workspace context</strong>
                        {allMentionOptions.map((opt) => (
                          <button
                            key={opt.label}
                            onClick={() => {
                              setAttachments((old) => [
                                ...old.filter((x) => x.label !== opt.label).slice(-9),
                                {
                                  id: crypto.randomUUID(),
                                  label: opt.label,
                                  text: opt.text,
                                  observedAt: Date.now(),
                                },
                              ]);
                              setMenu(null);
                            }}
                          >
                            {opt.label}
                            <small>{opt.subtitle}</small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="ai-menu-anchor">
                    <button
                      className={`ai-context-chip ${activeAgent ? "ai-context-chip-active" : ""}`}
                      aria-label="Select Mission Agent"
                      title={
                        activeAgent
                          ? `${activeAgent.name}: ${activeAgent.mission}`
                          : "Choose a specialized Mission Agent or use Default Assistant"
                      }
                      aria-expanded={menu === "agent"}
                      onClick={() =>
                        setMenu(menu === "agent" ? null : "agent")
                      }
                    >
                      <span>
                        {activeAgent
                          ? `${activeAgent.icon ? `${activeAgent.icon} ` : ""}${activeAgent.name}`
                          : "Assistant"}
                      </span>
                      <ChevronDown size={11} />
                    </button>
                    {menu === "agent" && (
                      <div
                        className="ai-popover"
                        style={{ right: 0, left: "auto", minWidth: 250 }}
                        aria-label="Mission Agents"
                      >
                        <strong>Active Mission Agent</strong>
                        <button
                          className={!selectedAgentId ? "active" : ""}
                          onClick={() => {
                            setSelectedAgentId("");
                            setMenu(null);
                          }}
                        >
                          Default SSHS3 Assistant
                          <small>General SSH, S3, cluster & workspace assistant</small>
                        </button>
                        {(hub.agents ?? []).map((ag) => (
                          <button
                            key={ag.id}
                            className={selectedAgentId === ag.id ? "active" : ""}
                            onClick={() => {
                              setSelectedAgentId(ag.id);
                              setAutonomy(ag.defaultMode);
                              setMenu(null);
                            }}
                          >
                            {ag.name}
                            <small>
                              {ag.role}
                              {ag.targetCluster ? ` · ${ag.targetCluster}` : ""}
                            </small>
                          </button>
                        ))}
                        <button
                          onClick={() => {
                            setMenu(null);
                            setView("Agents & MCP");
                          }}
                        >
                          Manage agents…
                          <small>Create custom mission agents & MCP servers</small>
                        </button>
                      </div>
                    )}
                  </div>
                  {task && (task.usage || task.runUsage) && (() => {
                    // While a run goes on, what it has spent so far is counted in.
                    const running = ["queued", "running", "waiting"].includes(task.status) ? task.runUsage : undefined;
                    const input = (task.usage?.inputTokens ?? 0) + (running?.inputTokens ?? 0);
                    const output = (task.usage?.outputTokens ?? 0) + (running?.outputTokens ?? 0);
                    if (!input && !output) return null;
                    return (
                      <small
                        className="ai-usage"
                        title={`${input} input / ${output} output tokens${running ? " (the run in progress included)" : ""}`}
                      >
                        {((input + output) / 1000).toFixed(1)}k
                        {task.usage?.costUsd !== undefined ? " · $" + task.usage.costUsd.toFixed(3) : ""}
                      </small>
                    );
                  })()}
                  {terminal?.owner && (
                    <button
                      className="ai-text-button"
                      onClick={() =>
                        void act({ action: "takeover", sessionId: terminal.id })
                      }
                    >
                      Take control
                    </button>
                  )}
                </div>
                {attachments.length > 0 && (
                  <div className="ai-attachments">
                    {attachments.map((a) => (
                      <button
                        className="ai-attachment"
                        key={a.id}
                        title={"Remove " + a.label}
                        onClick={() =>
                          setAttachments((all) =>
                            all.filter((x) => x.id !== a.id),
                          )
                        }
                      >
                        {a.imageDataUrl ? (
                          <img
                            src={a.imageDataUrl}
                            alt={a.label}
                            style={{
                              width: "20px",
                              height: "20px",
                              borderRadius: "4px",
                              objectFit: "cover",
                            }}
                          />
                        ) : (
                          <Paperclip size={11} />
                        )}
                        {a.label}
                        <X size={11} />
                      </button>
                    ))}
                  </div>
                )}
                <div
                  className="ai-input-box"
                  style={{ position: "relative" }}
                  onDragOver={(e) => {
                    if (e.dataTransfer?.types?.includes("Files")) {
                      e.preventDefault();
                    }
                  }}
                  onDrop={(e) => {
                    const files = Array.from(e.dataTransfer?.files ?? []);
                    if (files.length > 0) {
                      e.preventDefault();
                      for (const f of files) attachFileOrImage(f);
                    }
                  }}
                >
                  {activeSlashSuggestions.length > 0 && (
                    <div
                      className="ai-popover"
                      data-testid="ai-slash-palette"
                      aria-label="Slash command palette"
                      style={{
                        bottom: "calc(100% + 6px)",
                        left: 0,
                        right: 0,
                        width: "100%",
                        zIndex: 46,
                      }}
                    >
                      <strong>Commands (Tab / Enter)</strong>
                      {activeSlashSuggestions.map((item, idx) => (
                        <button
                          key={item.cmd}
                          type="button"
                          aria-current={
                            idx === atIndex % activeSlashSuggestions.length
                              ? "true"
                              : undefined
                          }
                          onClick={() => applySlashSuggestion(item)}
                        >
                          <span>
                            <code>{item.cmd}</code> · {item.title}
                          </span>
                          <small>{item.subtitle}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {activeAtSuggestions.length > 0 && (
                    <div
                      className="ai-popover"
                      data-testid="ai-at-autocomplete"
                      aria-label="Autocomplete @ mention"
                      style={{
                        bottom: "calc(100% + 6px)",
                        left: 0,
                        right: 0,
                        width: "100%",
                        zIndex: 45,
                      }}
                    >
                      <strong>@ Context autocomplete (Tab / Enter)</strong>
                      {activeAtSuggestions.map((opt, idx) => (
                        <button
                          key={opt.label}
                          type="button"
                          aria-current={
                            idx === atIndex % activeAtSuggestions.length
                              ? "true"
                              : undefined
                          }
                          onClick={() => applyAtSuggestion(opt)}
                        >
                          {opt.label}
                          <small>{opt.subtitle}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    ref={composer}
                    data-testid="ai-composer"
                    aria-label="Message to agent"
                    placeholder={
                      task
                        ? "Reply in this conversation… (type !cmd to run in terminal, / for commands, @ for context)"
                        : "Ask anything to start a new conversation… (type !cmd to run in terminal, / for commands, Shift+Tab to cycle mode)"
                    }
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      setAtIndex(0);
                      setAtDismissedFor(null);
                    }}
                    onPaste={(e) => {
                      const items = Array.from(e.clipboardData?.items ?? []);
                      const imageFiles: File[] = [];
                      for (const item of items) {
                        if (item.kind === "file" && item.type.startsWith("image/")) {
                          const f = item.getAsFile();
                          if (f) imageFiles.push(f);
                        }
                      }
                      if (imageFiles.length > 0) {
                        e.preventDefault();
                        for (const f of imageFiles) attachFileOrImage(f);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Tab" && e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        cycleMode();
                        return;
                      }
                      if (activeSlashSuggestions.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setAtIndex((i) => (i + 1) % activeSlashSuggestions.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setAtIndex(
                            (i) =>
                              (i - 1 + activeSlashSuggestions.length) %
                              activeSlashSuggestions.length,
                          );
                          return;
                        }
                        if (
                          (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          const chosen =
                            activeSlashSuggestions[
                              atIndex % activeSlashSuggestions.length
                            ];
                          if (chosen) applySlashSuggestion(chosen);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setAtDismissedFor(prompt);
                          return;
                        }
                      }
                      if (activeAtSuggestions.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          setAtIndex((i) => (i + 1) % activeAtSuggestions.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          setAtIndex(
                            (i) =>
                              (i - 1 + activeAtSuggestions.length) %
                              activeAtSuggestions.length,
                          );
                          return;
                        }
                        if (
                          (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          const chosen =
                            activeAtSuggestions[
                              atIndex % activeAtSuggestions.length
                            ];
                          if (chosen) applyAtSuggestion(chosen);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setAtDismissedFor(prompt);
                          return;
                        }
                      }
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <div className="ai-input-tools">
                    <button
                      className="ai-icon-button"
                      aria-label="Attach image or text file"
                      title="Attach image (PNG/JPG/WebP) or text file — or paste with Ctrl+V"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={16} />
                    </button>
                    <small>Enter to send · Ctrl+V to paste screenshot</small>
                    {running && !prompt.trim() && !attachments.some((a) => !!a.imageDataUrl) ? (
                      <button
                        className="ai-send ai-stop"
                        aria-label="Stop response"
                        title="Stop response"
                        disabled={busy}
                        onClick={() =>
                          void act({ action: "stop", taskId: task!.id })
                        }
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="ai-send"
                        aria-label="Send message"
                        title="Send message"
                        disabled={
                          busy ||
                          (!prompt.trim() &&
                            !attachments.some((a) => !!a.imageDataUrl))
                        }
                        onClick={() => void submit()}
                      >
                        <ArrowUp size={17} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="ai-composer-footer">
                  <div className="ai-mode-pills" role="group" aria-label="Agent mode">
                    {AGENT_MODES.map((value) => {
                      const activeMode = (task?.mode ?? draftMode) === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          data-testid={`ai-mode-pill-${value}`}
                          className={`ai-footer-chip ${activeMode ? "ai-context-chip-active" : ""}`}
                          aria-pressed={activeMode}
                          disabled={!!task}
                          title={
                            value === "advice"
                              ? "Advice: discuss without running commands"
                              : value === "plan"
                                ? "Plan: propose steps for approval before changing anything"
                                : value === "assisted"
                                  ? "Assisted: approve commands and changes first"
                                  : "Auto: runs commands on this terminal automatically"
                          }
                          onClick={() => {
                            setAutonomy(value);
                            setModePicked(true);
                            setConnection(undefined);
                            setMenu(null);
                          }}
                        >
                          {activeMode && <ShieldCheck size={11} />}
                          <span>{modes[value]}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="ai-footer-chip ai-model-chip"
                    aria-label="Choose model"
                    title={hub.config.model || "Choose a model"}
                    onClick={() => setSettingsOpen(true)}
                  >
                    <span>
                      {hub.config.enabled && hub.config.model
                        ? hub.config.model
                        : "Choose model"}
                    </span>
                    <ChevronDown size={11} />
                  </button>
                  <button
                    className="ai-footer-chip"
                    aria-label="Context budget & parameters"
                    title={`Context window: ${Math.round((hub.contextBudget?.contextWindowTokens ?? hub.config.contextWindowTokens ?? 128000) / 1000)}k tokens · Terminal scrollback: ${Math.round((hub.contextBudget?.terminalContextChars ?? hub.config.terminalContextChars ?? 8000) / 1000)}k chars · Reasoning: ${hub.config.reasoningEffort ?? "medium"}`}
                    onClick={() => setSettingsOpen(true)}
                  >
                    {(() => {
                      const maxTokens = hub.contextBudget?.contextWindowTokens ?? hub.config.contextWindowTokens ?? 128000;
                      // What is known: how much the model was sent at its last call in this conversation.
                      // Before the first run there is nothing to measure, so only the window is shown.
                      const usedTokens = task?.contextTokens;
                      if (!usedTokens) return <span>{Math.round(maxTokens / 1000)}k window</span>;
                      const pct = Math.min(100, Math.max(4, Math.round((usedTokens / maxTokens) * 100)));
                      return (
                        <>
                          <span title="What the model was sent at its last call in this conversation">
                            {Math.max(1, Math.round(usedTokens / 1000))}k of {Math.round(maxTokens / 1000)}k
                          </span>
                          <span className="ai-context-meter-bar" aria-hidden="true">
                            <span className="ai-context-meter-fill" style={{ width: `${pct}%` }} />
                          </span>
                        </>
                      );
                    })()}
                  </button>
                  {attachments.length > 0 && (
                    <small>{attachments.length} sources</small>
                  )}
                </div>
                <input
                  ref={fileInput}
                  hidden
                  type="file"
                  multiple
                  accept="image/*,text/*,.log,.yaml,.yml,.json,.conf,.md,.sh,.ps1,.py,.ts,.tsx,.js"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    for (const file of files) {
                      attachFileOrImage(file);
                    }
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            </div>
          )}
          {activeView === "Inbox" && (
            <InboxView
              hub={hub}
              act={act}
              onOpenTask={(id) => {
                setTaskId(id);
                setView("Work");
              }}
              onOpenView={(next) => setView(next)}
              onOpenTicket={(id) => {
                setWorkforceTicketId(id);
                setView("Workforce");
              }}
              focusItemId={focusInboxItem}
              onRequest={act}
            />
          )}
          {activeView === "Workforce" && (
            <WorkforceView
              hub={hub}
              act={act}
              openTicketId={workforceTicketId}
              onOpenTask={(id) => {
                setTaskId(id);
                setView("Work");
              }}
            />
          )}
          {activeView === "Agents & MCP" && (
            <AgentsAndMcpView
              hub={hub}
              act={act}
              selectedAgentId={selectedAgentId}
              onSelectAgentForChat={(id) => {
                setSelectedAgentId(id);
                const ag = hub.agents?.find((x) => x.id === id);
                if (ag) setAutonomy(ag.defaultMode);
                setView("Work");
              }}
              onStartedMission={(newTaskId) => {
                if (newTaskId) setTaskId(newTaskId);
                setView("Work");
              }}
            />
          )}
          {activeView === "Knowledge Base" && (
            <KnowledgeBaseView
              hub={hub}
              act={act}
              request={hubRequest}
              onOpenFileRef={handleOpenFileRef}
              onRunStepInTerminal={(command) => {
                void runCommandInTerminal(command);
              }}
              onAskAiStep={(stepPrompt) => {
                setPrompt(stepPrompt);
                setView("Work");
                setTimeout(() => composer.current?.focus(), 30);
              }}
              onAttachDoc={(doc) => {
                const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                setAttachments((old) => [
                  ...old.filter((x) => x.label !== `@kb:${slug}`).slice(-9),
                  {
                    id: crypto.randomUUID(),
                    label: `@kb:${slug}`,
                    text: `# KB Document: ${doc.title} (${doc.collection})\n\n${doc.content.slice(0, 8000)}`,
                    observedAt: Date.now(),
                  },
                ]);
                setView("Work");
              }}
              onRunRunbook={(doc) => {
                const slug = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                setAttachments((old) => [
                  ...old.filter((x) => x.label !== `@kb:${slug}`).slice(-9),
                  {
                    id: crypto.randomUUID(),
                    label: `@kb:${slug}`,
                    text: `# KB Document: ${doc.title} (${doc.collection})\n\n${doc.content.slice(0, 8000)}`,
                    observedAt: Date.now(),
                  },
                ]);
                setTaskId("");
                setPrompt(
                  `Follow our runbook "${doc.title}" (${doc.collection || "general"}) step by step. Start with read-only checks and summarise the state.`,
                );
                setView("Work");
              }}
            />
          )}
          {activeView === "Infrastructure" && (
            <InfrastructureView
              hub={hub}
              act={act}
              busy={busy}
              onUseTerminal={(sessionId) => {
                selectAiTerminal(sessionId);
                setTaskId("");
                setView("Work");
              }}
              onAsk={(text, attach, sessionId) => {
                if (sessionId) selectAiTerminal(sessionId);
                if (attach)
                  setAttachments((old) => [
                    ...old.filter((x) => x.label !== attach.label).slice(-9),
                    { id: crypto.randomUUID(), observedAt: Date.now(), ...attach },
                  ]);
                if (text) setPrompt(text);
                setTaskId("");
                setView("Work");
              }}
            />
          )}
          {activeView === "Changes" && (
            <ChangesView
              hub={hub}
              request={hubRequest}
              onOpenTask={(id) => {
                setTaskId(id);
                setView("Work");
              }}
            />
          )}
          {activeView === "Memory & skills" && (
            <Memory
              hub={hub}
              act={act}
              request={hubRequest}
              onOpenTask={(id) => {
                setTaskId(id);
                setView("Work");
              }}
              suggestion={
                task?.messages
                  .filter((m) => m.role === "assistant")
                  .map((m) => m.text)
                  .join("\n\n") ?? ""
              }
            />
          )}
          {activeView === "Schedules" && (
            <Schedules
              hub={hub}
              act={act}
              onOpenTask={(id) => {
                setTaskId(id);
                setView("Work");
              }}
            />
          )}
        </>
      )}
      {settingsOpen && hub && (
        <div
          className="ai-settings-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSettingsOpen(false);
          }}
        >
          <div
            className="ai-settings-dialog"
            ref={modal}
            role="dialog"
            aria-modal="true"
            aria-label="AI settings"
          >
            <header>
              <strong>AI settings</strong>
              <button
                className="ai-icon-button"
                aria-label="Close AI settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </header>
            {error && (
              <p className="ai-error" role="alert">
                {error}
              </p>
            )}
            <Settings
              hub={hub}
              act={act}
              labsEnabled={labsEnabled}
              onToggleLabs={handleToggleLabs}
            />
          </div>
        </div>
      )}
    </aside>
  );
}
