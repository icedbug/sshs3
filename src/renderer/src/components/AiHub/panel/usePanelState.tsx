import { useEffect, useRef, useState } from "react";
import {
  AGENT_MODES,
  type AgentMode,
  type ContextSource,
  type HubRequest,
  type HubSnapshot,
  type MissionAgent,
  type ShellKind,
} from "@shared/types/aiHub";
import { hubRequest, selectAiTerminal, useHub, useSelectedTerminal } from "../../../lib/aiHub";
import { useFullTask } from "../../../lib/aiHubTasks";
import type { FileRef } from "../reportRefs";
import { getVisibleHubViews, isLabsView, modes } from "../panelShared";
import { copyToClipboard } from "../RichMarkdownContent";
import { LABS_ENABLED_STORAGE_KEY } from "../SettingsView";
import {
  View,
  OPEN_TASK_KEY,
  VIEWS,
  Menu,
  StreamingTaskState,
  scanSecretsForDlp,
  readLabsEnabled,
  getActiveProfileSummary,
  getTaskUsageSummary,
  subscribeAiHubDelta,
  normalizeViewTarget,
} from "./panelHelpers";
import type { AiHubPanelProps } from "../AiHubPanel";

/**
 * Everything the chat panel holds and does before it draws: which conversation is open, what is typed,
 * the menus, what is attached, and the handlers for sending, stopping, forking and the rest. Moved here
 * from AiHubPanel.tsx as it was; it returns, as one object, the names the panel's pieces read.
 */
export function usePanelState({
  mode,
  setMode,
  width,
  onResizeWidth,
  initialTaskId,
  onTaskChange,
  boundTerminalId,
  compactMode: compactModeProp = false,
  onOpenFileRef,
}: AiHubPanelProps) {
  const hub = useHub();
  const selectedTerminal = useSelectedTerminal();
  const [view, setView] = useState<View>("Work");
  const [labsEnabled, setLabsEnabled] = useState<boolean>(() => readLabsEnabled());
  const [focusInboxItem, setFocusInboxItem] = useState<string | undefined>();
  // A ticket the Inbox asked the Workforce view to open.
  const [workforceTicketId, setWorkforceTicketId] = useState<string | undefined>();
  const [kbTabRequest, setKbTabRequest] = useState<
    { tab: "pages" | "sources" | "runbooks" | "review"; pageId?: string; seq: number } | undefined
  >();
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
  // The open conversation with all of its messages: a snapshot carries only the last few of a long one.
  const task = useFullTask(hub?.tasks.find((t) => t.id === taskId));
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
          kbTab?: "pages" | "sources" | "runbooks" | "review";
          pageId?: string;
        }>
      ).detail;
      // With no mode given, Full view stays Full view: only a closed assistant is opened.
      if (detail?.mode) setMode(detail.mode);
      else if (modeRef.current === "closed") setMode("panel");
      const targetView = normalizeViewTarget(detail?.view);
      if (targetView) {
        if (isLabsView(targetView)) setLabsEnabled(true);
        if (targetView === "Knowledge Base" && (detail?.kbTab || detail?.pageId)) {
          setKbTabRequest((prev) => ({
            tab: detail.kbTab ?? "pages",
            pageId: detail.pageId,
            seq: (prev?.seq ?? 0) + 1,
          }));
        } else {
          setKbTabRequest(undefined);
        }
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
  return {
    mode,
    setMode,
    width,
    onResizeWidth,
    compactModeProp,
    hub,
    selectedTerminal,
    setView,
    labsEnabled,
    focusInboxItem,
    workforceTicketId,
    setWorkforceTicketId,
    kbTabRequest,
    setKbTabRequest,
    taskId,
    setTaskId,
    prompt,
    setPrompt,
    sending,
    setAutonomy,
    setModePicked,
    selectedAgentId,
    setSelectedAgentId,
    shell,
    setShell,
    error,
    setError,
    notice,
    setNotice,
    busy,
    approvalNotes,
    setApprovalNotes,
    attachments,
    setAttachments,
    menu,
    setMenu,
    atIndex,
    setAtIndex,
    setAtDismissedFor,
    settingsOpen,
    setSettingsOpen,
    showDemoPreview,
    setShowDemoPreview,
    copiedMsgId,
    dlpWarning,
    setDlpWarning,
    connection,
    setConnection,
    task,
    activeAgent,
    targetSessionId,
    terminal,
    activeProfile,
    draftMode,
    aiSetUp,
    taskUsage,
    streamingState,
    visibleHubViews,
    running,
    activeView,
    end,
    conversation,
    follow,
    fileInput,
    composer,
    modal,
    pending,
    timeline,
    allMentionOptions,
    activeAtSuggestions,
    activeSlashSuggestions,
    applySlashSuggestion,
    applyAtSuggestion,
    handleToggleLabs,
    act,
    copyMessage,
    newChat,
    chooseTask,
    attachFileOrImage,
    stageCommandInTerminal,
    runCommandInTerminal,
    handleOpenFileRef,
    cycleMode,
    connectLocalOllama,
    handleForkTask,
    handleCompactTask,
    handleRestoreCheckpoint,
    sendMessage,
    submit,
    connectAndSend,
  };
}

/** What the panel holds and does: what each piece of it is given. */
export type PanelState = ReturnType<typeof usePanelState>;
