import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  History,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  Plus,
  Settings as SettingsIcon,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import {
  SHELL_KINDS,
  type AgentMode,
  type ContextSource,
  type HubRequest,
  type HubSnapshot,
  type MissionAgent,
  type ShellKind,
} from "@shared/types/aiHub";
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
import { DEMO_MODE_SET_BY_SERVER, modes, } from "./panelShared";
import { RichMarkdownContent } from "./RichMarkdownContent";
import { Settings } from "./SettingsView";
import { Memory } from "./MemoryView";
import { Schedules } from "./SchedulesView";
import { ChangesView } from "./ChangesView";
import { WorkforceView } from "./WorkforceView";
import { HypothesisTree } from "./HypothesisTree";
import { ChangeProof } from "./ChangeProof";
import { InboxView } from "./InboxView";
import { inboxItems, isConversation } from "./workforceModel";
import { InfrastructureView } from "./InfrastructureView";
import { AgentsAndMcpView } from "./AgentsAndMcpView";
import { KnowledgeBaseView } from "./KnowledgeBaseView";


type View =
  | "Work"
  | "Inbox"
  | "Workforce"
  | "Agents & MCP"
  | "Knowledge Base"
  | "Infrastructure"
  | "Changes"
  | "Memory & skills"
  | "Schedules";
const VIEWS: View[] = ["Work", "Inbox", "Workforce", "Agents & MCP", "Knowledge Base", "Infrastructure", "Changes", "Memory & skills", "Schedules"];
type Menu = "history" | "target" | "control" | "mention" | "agent" | null;

const DEMO_SHOWCASE_RESPONSE = [
  "## Cluster check: `NetApp-ONTAP-Prod-SE` and `K8s-Trident-CSI-Prod`",
  "",
  "I ran a health check on all 4 nodes of `@cluster:NetApp-ONTAP-Prod-SE` in parallel and compared `/etc/multipath.conf` with our standard (`@kb:trident-csi-multipath-standard`).",
  "",
  "### 1. Node status and latency (ONTAP 9.15.1P2)",
  "",
  "| Node | Role | Aggregate / capacity | Mean latency | SnapMirror lag | Status |",
  "| :--- | :--- | :--- | :--- | :--- | :--- |",
  "| `netapp-aff-a800-01a` | HA Node A (DC1) | `aggr1_nvme_prod` (64% of 220 TB) | `0.31 ms` | `00:02:44` | **ONLINE · HEALTH_OK** |",
  "| `netapp-aff-a800-01b` | HA Node B (DC1) | `aggr2_nvme_db` (58% of 180 TB) | `0.48 ms` | `00:03:18` | **ONLINE · HEALTH_OK** |",
  "| `netapp-fas9000-dr-01` | SnapVault DR (DC2) | `aggr_dr_nlsas` (71% of 1.6 PB) | `1.12 ms` | In sync (XDP) | **ONLINE · SNAPMIRRORED** |",
  "| `ontap-aiq-um-01` | Active IQ & Harvest | Prometheus / Grafana | `0.19 ms` | — | **TELEMETRY OK** |",
  "",
  "> **Cause and recommendation:** The volume `vol_analytics_sc` hits the QoS ceiling `pg-batch-ceiling` (`15 000 IOPS` / `600 MB/s`) during batch runs, while the production database `vol_pg_prod_01` stays stable. The multipath settings on `k8s-gpu-io-worker-01` differ from the standard.",
  "",
  "### 2. Configuration difference (`/etc/multipath.conf`)",
  "",
  "```diff",
  "--- k8s-storage-cp-01:/etc/multipath.conf",
  "+++ k8s-gpu-io-worker-01:/etc/multipath.conf",
  "@@ -8,7 +8,7 @@",
  "     device {",
  "         vendor \"NETAPP\"",
  "         product \"LUN.*\"",
  "         path_grouping_policy \"group_by_prio\"",
  "-        features \"2 pg_init_retries 50\"",
  "-        no_path_retry \"queue\"",
  "+        features \"0\"",
  "+        no_path_retry \"fail\"",
  "     }",
  "```",
  "",
  "### 3. Proposed commands",
  "",
  "Raise the adaptive QoS ceiling for the analytics volume on `netapp-aff-a800-01a` for the time being:",
  "",
  "```bash",
  "volume modify -vserver svm-prod-nfs -volume vol_analytics_sc -qos-policy-group pg-prod-db-extreme",
  "qos statistics volume latency show -vserver svm-prod-nfs -volume vol_analytics_sc -iterations 5",
  "```",
].join("\n");

export function AiHubPanel({
  mode,
  setMode,
  width,
  onResizeWidth,
}: {
  mode: "closed" | "panel" | "hub";
  setMode: (value: "closed" | "panel" | "hub") => void;
  width?: number;
  onResizeWidth?: (width: number) => void;
}): JSX.Element {
  const hub = useHub();
  const selectedTerminal = useSelectedTerminal();
  const [view, setView] = useState<View>("Work");
  const [focusInboxItem, setFocusInboxItem] = useState<string | undefined>();
  const [taskId, setTaskId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [autonomy, setAutonomy] = useState<AgentMode>("assisted");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [shell, setShell] = useState<ShellKind>("bash");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<ContextSource[]>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [atIndex, setAtIndex] = useState(0);
  const [atDismissedFor, setAtDismissedFor] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showDemoPreview, setShowDemoPreview] = useState(false);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
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
    : (connection?.id ?? selectedTerminal);
  const terminal = hub?.sessions.find(
    (s) => s.id === targetSessionId && (task || s.state !== "disconnected"),
  );
  const running =
    !!task && ["queued", "running", "waiting"].includes(task.status);
  const activeView = view;
  const end = useRef<HTMLDivElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const modal = useRef<HTMLDivElement>(null);
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
  }, [taskId]);
  useEffect(() => {
    const element = composer.current;
    if (element) {
      element.style.height = "auto";
      element.style.height =
        Math.min(180, Math.max(64, element.scrollHeight)) + "px";
    }
  }, [prompt, mode]);
  useEffect(() => {
    const open = (event: Event): void => {
      const detail = (
        event as CustomEvent<{
          view?: View;
          mode?: "closed" | "panel" | "hub";
          agentId?: string;
          prompt?: string;
        }>
      ).detail;
      setMode(detail?.mode ?? "panel");
      if (detail?.view) {
        setView(detail.view);
      }
      if (detail?.agentId !== undefined) {
        setSelectedAgentId(detail.agentId);
      }
      if (detail?.prompt) {
        setPrompt(detail.prompt);
        setTimeout(() => composer.current?.focus(), 30);
      }
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
        setMode("panel");
        setView("Work");
        setTimeout(() => composer.current?.focus(), 30);
      }
    };
    window.addEventListener("sshs3:ai-open", open);
    window.addEventListener("sshs3:ai-attach", attach);
    // A link from a notification: ?view=Inbox&item=…  Opened once, then taken out of the address.
    const linked = new URLSearchParams(window.location.search);
    const linkedView = VIEWS.find((v) => v === linked.get("view"));
    if (linkedView) {
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
      window.removeEventListener("sshs3:ai-attach", attach);
    };
  }, [setMode]);
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

  async function act(request: HubRequest): Promise<HubSnapshot | undefined> {
    setError("");
    setBusy(true);
    try {
      return await hubRequest(request);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
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
  async function sendMessage(sessionId?: string): Promise<void> {
    const hasImages = attachments.some((a) => !!a.imageDataUrl);
    if (busy || (!prompt.trim() && !hasImages)) return;
    const textToSend =
      prompt.trim() || "Analysera den bifogade bilden.";
    const result = task
      ? await act({
          action: "reply",
          taskId: task.id,
          text: textToSend,
          sessionId,
          attachments,
        })
      : await act({
          action: "start",
          task: {
            prompt: textToSend,
            sessionId,
            mode: activeAgent?.defaultMode ?? autonomy,
            agentId: activeAgent?.id,
            agentName: activeAgent?.name,
            attachments,
          },
        });
    if (result) {
      if (!task) setTaskId(result.tasks.at(-1)?.id ?? "");
      setPrompt("");
      setAttachments([]);
      setConnection(undefined);
    }
  }
  async function submit(): Promise<void> {
    const hasImages = attachments.some((a) => !!a.imageDataUrl);
    if (busy || (!prompt.trim() && !hasImages)) return;
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
          <strong>Chat</strong>
        </span>
        <div className="ai-header-actions">
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
          {!hub?.tasks.length && (
            <p className="ai-hint">Your conversations will appear here.</p>
          )}
          {[...(hub?.tasks ?? [])].reverse().map((t) => (
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
      <nav aria-label="Hub views">
        {(
          mode === "hub"
            ? ([
                "Work",
                "Inbox",
                "Workforce",
                "Agents & MCP",
                "Knowledge Base",
                "Infrastructure",
                "Changes",
                "Memory & skills",
                "Schedules",
              ] as View[])
            : ([
                "Work",
                "Inbox",
                "Workforce",
                "Agents & MCP",
                "Knowledge Base",
                "Memory & skills",
              ] as View[])
        ).map((name) => {
          const badgeCount =
            name === "Inbox"
              ? (hub ? inboxItems(hub).length : 0)
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
              <span>
                {name === "Work"
                  ? "Chat"
                    : name === "Agents & MCP"
                    ? "Agents & MCP"
                    : name === "Knowledge Base"
                      ? mode === "panel"
                        ? "Runbooks"
                        : "Knowledge base"
                      : name === "Memory & skills"
                        ? mode === "panel"
                          ? "Memory"
                          : "Memory & skills"
                        : name}
              </span>
              {badgeCount > 0 && (
                <span className="ai-nav-badge">{badgeCount}</span>
              )}
            </button>
          );
        })}
      </nav>
      {error && (
        <div className="ai-error" role="alert">
          {error}
          <button
            className="ai-icon-button"
            aria-label="Dismiss error"
            onClick={() => setError("")}
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
                {!task && !connection && (
                  <div className="ai-welcome">
                    <h2>What can I help with?</h2>
                    <p>
                      Pick a <strong>Mission Agent</strong>, or ask about your clusters, VMs, S3 buckets, runbooks and MCP tools.
                    </p>
                    {!hub.config.hasApiKey &&
                      !hub.config.codexConnected &&
                      !hub.config.baseUrl?.includes("11434") && (
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
                              onClick={() =>
                                void act({
                                  action: "configure",
                                  config: {
                                    enabled: true,
                                    provider: "openai-compatible",
                                    baseUrl: "http://127.0.0.1:11434/v1",
                                    model: "qwen2.5-coder:14b",
                                    useHermes: false,
                                  },
                                })
                              }
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
                              const prevIds = new Set(hub.tasks.map((t) => t.id));
                              void act({
                                action: "agent-run-mission",
                                id: activeAgent.id,
                              }).then((nextSnap) => {
                                const created = nextSnap?.tasks.find(
                                  (t) => !prevIds.has(t.id),
                                );
                                if (created?.id) setTaskId(created.id);
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
                                onClick={() => {
                                  void navigator.clipboard?.writeText(DEMO_SHOWCASE_RESPONSE);
                                  setCopiedMsgId("demo-showcase");
                                  setTimeout(() => setCopiedMsgId(null), 1800);
                                }}
                              >
                                {copiedMsgId === "demo-showcase" ? "Copied" : "Copy answer"}
                              </button>
                            </span>
                          </div>
                          <RichMarkdownContent
                            text={DEMO_SHOWCASE_RESPONSE}
                            onUseCommand={(cmd) => setPrompt(cmd)}
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
                          {item.message.role === "assistant" && (
                            <button
                              type="button"
                              className="ai-code-btn"
                              title="Copy the whole answer"
                              onClick={() => {
                                void navigator.clipboard?.writeText(
                                  item.message!.text,
                                );
                                setCopiedMsgId(item.message!.id);
                                setTimeout(() => setCopiedMsgId(null), 1800);
                              }}
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
                        text={item.message.text}
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
                        onUseCommand={(cmd) => {
                          setPrompt(cmd);
                          setTimeout(() => composer.current?.focus(), 20);
                        }}
                      />
                      {item.message.role === "assistant" &&
                        idx === timeline.length - 1 &&
                        !running && (
                          <div className="ai-message-footer">
                            <button
                              type="button"
                              className="ai-msg-action-btn"
                              onClick={() => {
                                void navigator.clipboard?.writeText(
                                  item.message!.text,
                                );
                                setCopiedMsgId(item.message!.id);
                                setTimeout(() => setCopiedMsgId(null), 1800);
                              }}
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
                            ? ` · ${item.change.parsedSubcommands!.length} AST pipeline/chain segments`
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
                              onClick={() =>
                                void navigator.clipboard?.writeText(
                                  item.change!.command!,
                                )
                              }
                            >
                              Copy
                            </button>
                          </div>
                          <pre>{item.change.command}</pre>
                        </div>
                      )}
                      {item.change.kind === "file" && (
                        <div className="ai-diff">
                          <strong>Before</strong>
                          <pre>{item.change.before}</pre>
                          <strong>Proposed</strong>
                          <pre>{item.change.after}</pre>
                        </div>
                      )}
                      {item.change.output && <pre>{item.change.output}</pre>}
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
                      </div>
                      {item.change.status === "pending" && (
                        <div className="ai-approval-actions">
                          <button
                            className="ai-primary"
                            disabled={busy}
                            onClick={() =>
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId: item.change!.id,
                                approved: true,
                              })
                            }
                          >
                            Approve
                          </button>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId: item.change!.id,
                                approved: false,
                              })
                            }
                          >
                            Decline
                          </button>
                        </div>
                      )}
                    </details>
                  ) : null,
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
                {task?.error && <p className="ai-task-error">{task.error}</p>}
                {running && (
                  <p className="ai-activity" aria-live="polite">
                    <span className="ai-activity-dot" />
                    {pending
                      ? "Waiting for your approval"
                      : task?.status === "queued"
                        ? "Starting…"
                        : "Working…"}
                  </p>
                )}
                {task?.status === "interrupted" && (
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
                  <TaskTodos todos={task.todos} />
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
                  {task?.usage && (
                    <small
                      className="ai-usage"
                      title={
                        task.usage.inputTokens +
                        " input / " +
                        task.usage.outputTokens +
                        " output tokens"
                      }
                    >
                      {(
                        (task.usage.inputTokens + task.usage.outputTokens) /
                        1000
                      ).toFixed(1)}
                      k
                      {task.usage.costUsd !== undefined
                        ? " · $" + task.usage.costUsd.toFixed(3)
                        : ""}
                    </small>
                  )}
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
                    aria-label="Message to agent"
                    placeholder={
                      running
                        ? "Send a follow-up… (type / for commands, @ for clusters/nodes, paste images)"
                        : "Ask anything… (type / for commands, @ for clusters/nodes, or paste images)"
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
                  <div className="ai-menu-anchor">
                    <button
                      className="ai-footer-chip"
                      aria-label="Chat permissions"
                      title="Permissions for this chat"
                      disabled={!!task}
                      aria-expanded={menu === "control"}
                      onClick={() =>
                        setMenu(menu === "control" ? null : "control")
                      }
                    >
                      <ShieldCheck size={12} />
                      {modes[task?.mode ?? autonomy]}
                      {!task && <ChevronDown size={11} />}
                    </button>
                    {menu === "control" && (
                      <div
                        className="ai-popover"
                        aria-label="Choose permissions"
                      >
                        <strong>How should I work?</strong>
                        {(
                          ["advice", "assisted", "autonomous"] as AgentMode[]
                        ).map((value) => (
                          <button
                            key={value}
                            aria-current={
                              value === autonomy ? "true" : undefined
                            }
                            onClick={() => {
                              setAutonomy(value);
                              setConnection(undefined);
                              setMenu(null);
                            }}
                          >
                            {modes[value]}
                            <small>
                              {value === "advice"
                                ? "Discuss without running commands"
                                : value === "assisted"
                                  ? "Approve commands and changes first"
                                  : "This terminal · 20 actions / 15 minutes"}
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
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
                      const usedTokens =
                        (hub.contextBudget?.estimatedUsedTokens ?? 2400) +
                        attachments.reduce(
                          (sum, a) => sum + Math.ceil((a.text?.length ?? 0) / 4),
                          0,
                        );
                      const maxTokens =
                        hub.contextBudget?.contextWindowTokens ??
                        hub.config.contextWindowTokens ??
                        128000;
                      const pct = Math.min(
                        100,
                        Math.max(4, Math.round((usedTokens / maxTokens) * 100)),
                      );
                      return (
                        <>
                          <span>
                            {Math.max(1, Math.round(usedTokens / 1000))}k /{" "}
                            {Math.round(maxTokens / 1000)}k ctx
                          </span>
                          <span className="ai-context-meter-bar" aria-hidden="true">
                            <span
                              className="ai-context-meter-fill"
                              style={{ width: `${pct}%` }}
                            />
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
              focusItemId={focusInboxItem}
            />
          )}
          {activeView === "Workforce" && (
            <WorkforceView
              hub={hub}
              act={act}
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
            <Settings hub={hub} act={act} />
          </div>
        </div>
      )}
    </aside>
  );
}
