import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
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
  type KbDocument,
  type McpServerConfig,
  type MissionAgent,
  type ShellKind,
} from "@shared/types/aiHub";
import {
  DEFAULT_AI_MODELS,
  DEFAULT_PROVIDER_MODELS,
  type AiReasoningEffort,
} from "@shared/types/ai";
import {
  hubRequest,
  selectAiTerminal,
  useHub,
  useSelectedTerminal,
} from "../../lib/aiHub";
import "./aiHub.css";

type View =
  | "Work"
  | "Agents & MCP"
  | "Knowledge Base"
  | "Infrastructure"
  | "Changes"
  | "Memory & skills"
  | "Schedules";
type Menu = "history" | "target" | "control" | "mention" | "agent" | null;
const modes: Record<AgentMode, string> = {
  advice: "Ask",
  assisted: "Ask first",
  autonomous: "Auto",
};

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
          s.cluster ? `🧩 ${s.cluster}` : "",
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
        subtitle: `🤖 ${ag.name} · ${ag.role} (${ag.mission})`,
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
        subtitle: `📚 KB (${doc.collection}): ${doc.title}`,
        text: `# KB Document: ${doc.title} (${doc.collection})\n\n${doc.content.slice(0, 6000)}`,
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
    if (!hub?.config.enabled || !hub.config.model || !hub.runtime.bundled) {
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
      className={"ai-hub ai-hub-" + mode}
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
                "Agents & MCP",
                "Knowledge Base",
                "Infrastructure",
                "Changes",
                "Memory & skills",
                "Schedules",
              ] as View[])
            : ([
                "Work",
                "Agents & MCP",
                "Knowledge Base",
                "Memory & skills",
              ] as View[])
        ).map((name) => {
          const badgeCount =
            name === "Agents & MCP"
              ? (hub?.agents?.length ?? 0) + (hub?.mcpServers?.length ?? 0)
              : name === "Knowledge Base"
                ? (hub?.kbDocuments?.length ?? 0)
                : name === "Memory & skills"
                  ? (hub?.memories?.length ?? 0)
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
                  ? "💬 Chat"
                  : name === "Agents & MCP"
                    ? "🤖 Agents & MCP"
                    : name === "Knowledge Base"
                      ? mode === "panel"
                        ? "📚 KB"
                        : "📚 Knowledge Base"
                      : name === "Memory & skills"
                        ? mode === "panel"
                          ? "🧠 Memory"
                          : "🧠 Memory & skills"
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
                      {!hub.tasks.length && (
                        <small className="ai-hint">No conversations yet.</small>
                      )}
                      {[...hub.tasks].reverse().map((t) => (
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

                  <div className="ai-sidebar-section">
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
                          <span>{ag.icon || "🤖"}</span>
                          <div>
                            <span>{ag.name}</span>
                            <small>
                              {ag.targetCluster || ag.role} · {ag.defaultMode}
                            </small>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="ai-sidebar-section">
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
                    <h2>Vad kan jag hjälpa dig med i sshS3?</h2>
                    <p>
                      Välj en specialiserad <strong>Mission Agent</strong> eller fråga fritt om dina kluster, VMs, S3-buckets, KB-runbooks och MCP-verktyg.
                    </p>
                    {(hub.agents ?? []).length > 0 && (
                      <div className="ai-agent-quick-bar" aria-label="Quick select Mission Agent">
                        <button
                          type="button"
                          className={`ai-agent-pill ${!selectedAgentId ? "active" : ""}`}
                          onClick={() => setSelectedAgentId("")}
                        >
                          ✨ Standard AI
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
                            <span>{ag.icon || "🤖"}</span>
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
                              {activeAgent.icon || "🤖"} {activeAgent.name}
                            </strong>
                            <div>
                              <small>{activeAgent.role}</small>
                            </div>
                          </div>
                          {activeAgent.targetCluster && (
                            <span className="ai-badge ai-badge-cluster">
                              🧩 {activeAgent.targetCluster}
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: 12, margin: "8px 0" }}>
                          <strong>Uppdrag:</strong> {activeAgent.mission}
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
                            🚀 Kör uppdrag nu
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPrompt(
                                `Utför ditt uppdrag för ${activeAgent.targetCluster ? `@cluster:${activeAgent.targetCluster}` : "vår infrastruktur"}: ${activeAgent.mission}`,
                              )
                            }
                          >
                            ✏️ Anpassa uppdrag i chatten
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
                            "Kör en parallell hälsokontroll över alla noder i @cluster:NetApp-ONTAP-Prod-SE med sshs3_cluster_exec och jämför WAFL/NVMe-latens, aggregat och SnapMirror-status.",
                          )
                        }
                      >
                        <strong>⚡ Parallell klusterkörning (@cluster)</strong>
                        <small>Kör kommandon parallellt över hela kluster och få en samlad rapport</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Öppna en 2x2 split-view terminal-grid för alla noder i @cluster:NetApp-ONTAP-Prod-SE så att jag kan övervaka dem sida vid sida.",
                          )
                        }
                      >
                        <strong>🪟 Öppna 2×2 Kluster Split-View</strong>
                        <small>Be AI:n öppna Konsole split-grid eller Dual-Pane Explorer direkt i UI:t</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Jämför (diffa) /etc/multipath.conf mellan k8s-gpu-io-worker-01 och k8s-storage-cp-01 med sshs3_storage_ops och kontrollera mot vår KB-standard.",
                          )
                        }
                      >
                        <strong>🔍 Cross-Server Config Diff &amp; SFTP/S3</strong>
                        <small>Diffa konfigurationsfiler mellan två noder eller inspektera S3-buckets</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Sök i vår Knowledge Base (@kb) efter ONTAP Adaptive QoS och hämta aktuella volym-IOPS och latens via NetApp Harvest MCP.",
                          )
                        }
                      >
                        <strong>📚 Sök i Kunskapsbasen (KB) &amp; MCP</strong>
                        <small>Kombinera BM25-runbooks med live-telemetri från anslutna MCP-servrar</small>
                      </button>
                    </div>
                  </div>
                )}
                {timeline.map((item) =>
                  item.message ? (
                    <article
                      className={"ai-message ai-message-" + item.message.role}
                      key={item.message.id}
                    >
                      <small className="ai-message-author">
                        {item.message.role === "user"
                          ? "You"
                          : item.message.role === "assistant"
                            ? "Assistant"
                            : "sshs3"}
                      </small>
                      {item.message.images && item.message.images.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "8px",
                            marginBottom: "8px",
                          }}
                        >
                          {item.message.images.map((img, idx) => (
                            <img
                              key={idx}
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
                      <ReactMarkdown>{item.message.text}</ReactMarkdown>
                    </article>
                  ) : item.change && task ? (
                    <details
                      className={"ai-change ai-change-" + item.change.status}
                      key={item.change.id}
                      open={item.change.status === "pending"}
                    >
                      <summary>
                        <Terminal size={13} />
                        <span>{item.change.description}</span>
                        <small>
                          {item.change.status === "pending"
                            ? "Approval needed"
                            : item.change.status}
                        </small>
                      </summary>
                      {item.change.command && <pre>{item.change.command}</pre>}
                      {item.change.kind === "file" && (
                        <div className="ai-diff">
                          <strong>Before</strong>
                          <pre>{item.change.before}</pre>
                          <strong>Proposed</strong>
                          <pre>{item.change.after}</pre>
                        </div>
                      )}
                      {item.change.output && <pre>{item.change.output}</pre>}
                      <small>
                        {item.change.target}
                        {item.change.exitCode !== undefined
                          ? " · exit " + item.change.exitCode
                          : ""}
                      </small>
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
                          ? `${activeAgent.icon || "🤖"} ${activeAgent.name}`
                          : "🤖 Default Agent"}
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
                            🤖 {ag.name}
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
                          ⚙️ Manage Agents & MCP…
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
                        ? "Send a follow-up… (type @ for clusters/nodes, paste or drop images)"
                        : "Ask anything… (type @ for clusters/nodes, or paste/upload images)"
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
                            📊 {Math.max(1, Math.round(usedTokens / 1000))}k /{" "}
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
            />
          )}
          {activeView === "Infrastructure" && (
            <div className="ai-scroll">
              <h2>Saved targets</h2>
              <p className="ai-hint">
                Light checks measure endpoint reachability. Health and
                authentication remain unknown until investigated.
              </p>
              <button
                disabled={busy}
                onClick={() => void act({ action: "inventory-refresh" })}
              >
                Refresh inventory
              </button>
              {hub.inventory.map((item) => (
                <article className="ai-card" key={item.id}>
                  <strong>{item.label}</strong>
                  <p>
                    {item.kind} · {item.address} · {item.status}
                  </p>
                  <p>{item.detail}</p>
                  {item.status === "unreachable" && (
                    <button
                      onClick={() => {
                        setPrompt(
                          "Investigate why " +
                            item.label +
                            " is unreachable. Start with observations and verify the cause.",
                        );
                        setTaskId("");
                        selectAiTerminal(
                          hub.sessions.find((s) => s.profileId === item.id)
                            ?.id ?? "",
                        );
                        setView("Work");
                      }}
                    >
                      Investigate
                    </button>
                  )}
                  <small>{new Date(item.observedAt).toLocaleString()}</small>
                </article>
              ))}
              {hub.preview && (
                <article className="ai-card">
                  <strong>{hub.preview.label}</strong>
                  <pre>{hub.preview.text || "No captured output yet"}</pre>
                  <button
                    onClick={() => {
                      setAttachments((old) => [...old.slice(-9), hub.preview!]);
                      setView("Work");
                    }}
                  >
                    Attach this terminal context
                  </button>
                </article>
              )}
              <h2>Open sessions</h2>
              {hub.sessions.map((s) => (
                <article className="ai-card" key={s.id}>
                  <strong>{s.label}</strong>
                  <button
                    onClick={() =>
                      void act({ action: "inspect", sessionId: s.id })
                    }
                  >
                    Open transcript
                  </button>
                  <p>
                    {s.state} · {s.owner ? "AI working" : "You control"}
                  </p>
                  <button
                    onClick={() => {
                      selectAiTerminal(s.id);
                      setTaskId("");
                      setView("Work");
                    }}
                  >
                    Use as target
                  </button>
                </article>
              ))}
            </div>
          )}
          {activeView === "Changes" && (
            <div className="ai-scroll">
              <h2>Team Workspace Activity</h2>
              {!(hub.activityLog ?? []).length && (
                <p className="ai-hint">
                  Config edits, service restarts and infrastructure changes across VMs appear here automatically.
                </p>
              )}
              {(hub.activityLog ?? []).map((ev) => (
                <article className="ai-card" key={ev.id}>
                  <strong>
                    {ev.actor} · {ev.targetLabel}
                  </strong>
                  <small>
                    {" "}
                    · {ev.kind} · {new Date(ev.at).toLocaleString()}
                  </small>
                  <p>{ev.summary}</p>
                  {ev.detail && <pre>{ev.detail}</pre>}
                </article>
              ))}
              <h2>Action history</h2>
              {[...hub.tasks].reverse().map((t) => (
                <section key={t.id}>
                  <button
                    onClick={() => {
                      setTaskId(t.id);
                      setView("Work");
                    }}
                  >
                    {t.title} ↗
                  </button>
                  {t.changes.map((c) => (
                    <details className="ai-change" key={c.id}>
                      <summary>
                        {c.target} · {c.status} ·{" "}
                        {new Date(c.at).toLocaleString()}
                      </summary>
                      <p>{c.description}</p>
                      {c.kind === "file" && (
                        <>
                          <strong>Before</strong>
                          <pre>{c.before}</pre>
                          <strong>After</strong>
                        </>
                      )}
                      <pre>{c.command ?? c.after}</pre>
                      <pre>{c.output}</pre>
                      <small>
                        Evidence: {c.id} · exit {c.exitCode ?? "unknown"}
                      </small>
                    </details>
                  ))}
                </section>
              ))}
            </div>
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
          {activeView === "Schedules" && <Schedules hub={hub} act={act} />}
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

type Act = (request: HubRequest) => Promise<HubSnapshot | undefined>;
function Settings({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const [provider, setProvider] = useState(hub.config.provider);
  const [model, setModel] = useState(hub.config.model);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [url, setUrl] = useState(hub.config.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [actorName, setActorName] = useState(hub.config.actorName ?? "");
  const [enabled, setEnabled] = useState(hub.config.enabled);
  const [contextWindowTokens, setContextWindowTokens] = useState(
    hub.config.contextWindowTokens ?? 128000,
  );
  const [terminalContextChars, setTerminalContextChars] = useState(
    hub.config.terminalContextChars ?? 8000,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    hub.config.maxOutputTokens ?? 8192,
  );
  const [maxToolTurns, setMaxToolTurns] = useState(
    hub.config.maxToolTurns ?? 20,
  );
  const [reasoningEffort, setReasoningEffort] = useState<AiReasoningEffort>(
    hub.config.reasoningEffort ?? "medium",
  );
  const [temperature, setTemperature] = useState(
    hub.config.temperature ?? 0.2,
  );
  const [prefs, setPrefs] = useState(hub.preferences);
  const [savedNotice, setSavedNotice] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProvider(hub.config.provider);
    setModel(hub.config.model);
    setCustomModelMode(false);
    setUrl(hub.config.baseUrl ?? "");
    setActorName(hub.config.actorName ?? "");
    setEnabled(hub.config.enabled);
    setContextWindowTokens(hub.config.contextWindowTokens ?? 128000);
    setTerminalContextChars(hub.config.terminalContextChars ?? 8000);
    setMaxOutputTokens(hub.config.maxOutputTokens ?? 8192);
    setMaxToolTurns(hub.config.maxToolTurns ?? 20);
    setReasoningEffort(hub.config.reasoningEffort ?? "medium");
    setTemperature(hub.config.temperature ?? 0.2);
  }, [
    hub.config.provider,
    hub.config.model,
    hub.config.baseUrl,
    hub.config.actorName,
    hub.config.enabled,
    hub.config.contextWindowTokens,
    hub.config.terminalContextChars,
    hub.config.maxOutputTokens,
    hub.config.maxToolTurns,
    hub.config.reasoningEffort,
    hub.config.temperature,
  ]);

  useEffect(() => {
    setPrefs(hub.preferences);
  }, [hub.preferences]);

  const presetModels =
    provider === "openai-codex"
      ? hub.config.codexModels?.length
        ? hub.config.codexModels
        : DEFAULT_PROVIDER_MODELS["openai-codex"]
      : DEFAULT_PROVIDER_MODELS[provider] ?? [];

  return (
    <form
      className="ai-scroll ai-form"
      onSubmit={(e) => {
        e.preventDefault();
        setSavedNotice(false);
        void act({
          action: "configure",
          config: {
            enabled,
            provider,
            model: model.trim(),
            baseUrl: provider === "openai-codex" ? "" : url.trim(),
            actorName,
            useHermes: false,
            contextWindowTokens,
            terminalContextChars,
            maxOutputTokens,
            maxToolTurns,
            reasoningEffort,
            temperature,
            ...(key ? { apiKey: key } : {}),
          },
          preferences: prefs,
        }).then((result) => {
          if (result) {
            setKey("");
            setSavedNotice(true);
          }
        });
      }}
    >
      <h2>Your model, your infrastructure</h2>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Enable AI context collection and model requests
      </label>
      <label>
        Your Team Handle (shown in shared workspace activity)
        <input
          value={actorName}
          onChange={(e) => setActorName(e.target.value)}
          placeholder={
            hub.config.codexAccountEmail
              ? hub.config.codexAccountEmail.split("@")[0]
              : "e.g. jacob"
          }
        />
      </label>
      {hub.s3Workspace?.configured && (
        <small>
          S3 Team Bucket active: s3://{hub.s3Workspace.bucket}/
          {hub.s3Workspace.prefix || "sshs3-team"}
          {hub.s3Workspace.lastSyncAt
            ? ` (synced ${new Date(hub.s3Workspace.lastSyncAt).toLocaleTimeString()})`
            : ""}
        </small>
      )}
      <label>
        Shared Team Workspace File (Git / OneDrive / Shared Folder — optional)
        <input
          value={prefs.sharedWorkspacePath ?? ""}
          onChange={(e) =>
            setPrefs({ ...prefs, sharedWorkspacePath: e.target.value })
          }
          placeholder="e.g. C:\Shared\Project\sshs3-workspace.json (in addition to SFTP/S3/Team Vault)"
        />
      </label>
      <label>
        Provider
        <select
          value={provider}
          onChange={(e) => {
            const next = e.target.value as typeof provider;
            setProvider(next);
            setCustomModelMode(false);
            setSavedNotice(false);
            if (next === "openai-codex") {
              const codexDefault =
                hub.config.codexDefaultModel || DEFAULT_AI_MODELS["openai-codex"];
              const validCodex =
                hub.config.codexModels ?? DEFAULT_PROVIDER_MODELS["openai-codex"];
              if (
                !model ||
                model === "local" ||
                model === "gpt-sol-latest" ||
                model.startsWith("claude-") ||
                !validCodex.includes(model)
              ) {
                setModel(codexDefault);
              }
              if (url.includes("openrouter.ai")) {
                setUrl("");
              }
            } else if (next === "anthropic") {
              if (!model || !model.startsWith("claude-")) {
                setModel(DEFAULT_AI_MODELS.anthropic);
              }
            }
          }}
        >
          <option value="openai-codex">
            ChatGPT / Codex (OAuth — {hub.config.codexDefaultModel || "gpt-6.1-sol"})
          </option>
          <option value="anthropic">Anthropic</option>
          <option value="openai-compatible">
            OpenAI-compatible / local / enterprise
          </option>
        </select>
      </label>
      {provider === "openai-codex" && (
        <small>
          {hub.config.codexConnected
            ? `Connected via ChatGPT OAuth${hub.config.codexAccountEmail ? ` (${hub.config.codexAccountEmail})` : ""}. No API key needed.`
            : "Uses your local ChatGPT / Codex OAuth session (hermes-native/auth.json)."}
        </small>
      )}
      {presetModels.length > 0 && (
        <label>
          Model preset
          <select
            aria-label="Model preset"
            value={
              !customModelMode && presetModels.includes(model)
                ? model
                : "__custom__"
            }
            onChange={(e) => {
              if (e.target.value === "__custom__") {
                setCustomModelMode(true);
                setTimeout(() => modelInputRef.current?.focus(), 0);
              } else {
                setCustomModelMode(false);
                setModel(e.target.value);
                setSavedNotice(false);
              }
            }}
          >
            {presetModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="__custom__">
              Custom{!presetModels.includes(model) && model ? ` (${model})` : " model ID…"}
            </option>
          </select>
        </label>
      )}
      <label>
        Model ID
        <input
          ref={modelInputRef}
          required
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setSavedNotice(false);
          }}
          placeholder={
            provider === "openai-codex"
              ? hub.config.codexDefaultModel || "gpt-6.1-sol"
              : "Model offered by your endpoint"
          }
        />
      </label>
      {provider !== "openai-codex" && (
        <>
          <label>
            Endpoint
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:11434/v1"
            />
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                hub.config.hasApiKey
                  ? "Key configured · leave blank to keep"
                  : "Optional for local models"
              }
            />
          </label>
          <small>
            {hub.config.keyStorage === "session"
              ? "OS keyring unavailable: key is retained for this app session only."
              : "Keys use the operating system keyring."}
          </small>
          <button
            type="button"
            onClick={() =>
              void act({ action: "configure", config: { apiKey: null } })
            }
          >
            Remove API key
          </button>
        </>
      )}
      <label>
        <input
          type="checkbox"
          checked={prefs.background}
          onChange={(e) =>
            setPrefs({
              ...prefs,
              background: e.target.checked,
              autoStart: e.target.checked && prefs.autoStart,
            })
          }
        />{" "}
        Keep running when the window closes
      </label>
      <label>
        <input
          type="checkbox"
          disabled={!prefs.background}
          checked={prefs.autoStart}
          onChange={(e) => setPrefs({ ...prefs, autoStart: e.target.checked })}
        />{" "}
        Start in background when I log in
      </label>
      <label>
        <input
          type="checkbox"
          checked={prefs.inventory}
          onChange={(e) => setPrefs({ ...prefs, inventory: e.target.checked })}
        />{" "}
        Check saved endpoints every 5 minutes
      </label>
      <label>
        History retention (days)
        <input
          type="number"
          min="1"
          max="365"
          value={prefs.retentionDays}
          onChange={(e) =>
            setPrefs({ ...prefs, retentionDays: Number(e.target.value) })
          }
        />
      </label>
      <h3>Context Window & Model Parameters</h3>
      <label>
        Max Context Window (tokens)
        <select
          aria-label="Max Context Window"
          value={String(contextWindowTokens)}
          onChange={(e) => setContextWindowTokens(Number(e.target.value))}
        >
          <option value="16384">16k tokens (Fast / Compact)</option>
          <option value="32768">32k tokens (Standard)</option>
          <option value="65536">64k tokens (Extended)</option>
          <option value="128000">128k tokens (Recommended Enterprise)</option>
          <option value="256000">256k tokens (Deep Multi-Cluster)</option>
          <option value="900000">900k tokens (Ultra Long Context)</option>
        </select>
      </label>
      <label>
        Terminal Scrollback Context (chars per terminal)
        <select
          aria-label="Terminal Scrollback Context"
          value={String(terminalContextChars)}
          onChange={(e) => setTerminalContextChars(Number(e.target.value))}
        >
          <option value="2000">2,000 chars (~500 tokens)</option>
          <option value="4000">4,000 chars (~1k tokens)</option>
          <option value="8000">8,000 chars (~2k tokens — default)</option>
          <option value="16000">16,000 chars (~4k tokens)</option>
          <option value="32000">32,000 chars (~8k tokens)</option>
          <option value="64000">64,000 chars (~16k tokens)</option>
        </select>
      </label>
      <label>
        Max Output Tokens
        <input
          type="number"
          min="512"
          max="65536"
          step="512"
          value={maxOutputTokens}
          onChange={(e) => setMaxOutputTokens(Number(e.target.value))}
        />
      </label>
      <label>
        Max Autonomous Tool Turns per Task
        <input
          type="number"
          min="1"
          max="100"
          value={maxToolTurns}
          onChange={(e) => setMaxToolTurns(Number(e.target.value))}
        />
      </label>
      <label>
        Reasoning Effort
        <select
          aria-label="Reasoning Effort"
          value={reasoningEffort}
          onChange={(e) =>
            setReasoningEffort(e.target.value as AiReasoningEffort)
          }
        >
          <option value="low">Low (Fastest response)</option>
          <option value="medium">Medium (Balanced — default)</option>
          <option value="high">High (Deep storage & root-cause analysis)</option>
        </select>
      </label>
      <label>
        Temperature ({temperature.toFixed(2)})
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
        />
      </label>
      <button type="submit">Save settings</button>
      {savedNotice && <small role="status">Settings saved.</small>}
      <button
        type="button"
        onClick={() => void act({ action: "forget-history" })}
      >
        Delete task and terminal history
      </button>
      <button type="button" onClick={() => void act({ action: "quit" })}>
        Quit sshs3 completely
      </button>
    </form>
  );
}
function Memory({
  hub,
  act,
  suggestion,
}: {
  hub: HubSnapshot;
  act: Act;
  suggestion: string;
}): JSX.Element {
  const [id, setId] = useState<string>();
  const [title, setTitle] = useState("");
  const [text, setText] = useState(suggestion);
  const [scope, setScope] = useState("personal");
  const [kind, setKind] = useState<"memory" | "skill">(
    suggestion ? "skill" : "memory",
  );
  return (
    <div className="ai-scroll">
      <h2>Memory & skills</h2>
      <p className="ai-hint">
        Review the content and choose its environment. Model output never grants
        new permissions.
      </p>
      <form
        className="ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act({
            action: "memory-save",
            entry: { id, title, text, scope, kind },
          }).then((result) => {
            if (result) {
              setId(undefined);
              setTitle("");
              setText("");
            }
          });
        }}
      >
        <label>
          Title
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Type
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="memory">Memory</option>
            <option value="skill">Skill</option>
          </select>
        </label>
        <label>
          Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="workspace">Shared Workspace (Team Vault)</option>
            <option value="personal">Personal</option>
            {hub.inventory.map((i) => (
              <option key={i.id} value={`target:${i.id}`}>
                {i.label}
              </option>
            ))}
            <option value="target:local">Local machine</option>
          </select>
        </label>
        <label>
          Instructions / facts
          <textarea
            required
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button>Save</button>
      </form>
      {hub.memories.map((m) => (
        <article className="ai-card" key={m.id}>
          <strong>{m.title}</strong>
          <small>
            {" "}
            · {m.kind} · {m.scope}
          </small>
          <p>{m.text}</p>
          <button
            onClick={() => {
              setId(m.id);
              setTitle(m.title);
              setText(m.text);
              setScope(m.scope);
              setKind(m.kind);
            }}
          >
            Edit
          </button>
          <button
            onClick={() => void act({ action: "memory-delete", id: m.id })}
          >
            Delete
          </button>
        </article>
      ))}
    </div>
  );
}
function Schedules({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [profileId, setProfile] = useState("local");
  const [shell, setShell] = useState<ShellKind>("bash");
  const [minutes, setMinutes] = useState(60);
  const [mode, setMode] = useState<AgentMode>("assisted");
  return (
    <div className="ai-scroll">
      <h2>Scheduled work</h2>
      <p className="ai-hint">
        Each job gets its own terminal and a fixed model. Missed runs are
        recorded without catch-up. Assisted commands wait for approval.
      </p>
      <form
        className="ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act({
            action: "schedule-save",
            schedule: {
              title,
              prompt,
              profileId,
              shell,
              mode,
              intervalMinutes: minutes,
              nextRunAt: Date.now() + minutes * 60_000,
              enabled: true,
              model: hub.config.model,
              provider: hub.config.provider,
              baseUrl: hub.config.baseUrl,
              maxCommands: 20,
              maxMinutes: 15,
            },
          });
        }}
      >
        <label>
          Name
          <input
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Task
          <textarea
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label>
          Target
          <select
            value={profileId}
            onChange={(e) => setProfile(e.target.value)}
          >
            <option value="local">Local machine</option>
            {hub.inventory
              .filter((i) => i.kind === "ssh")
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.label}
                </option>
              ))}
          </select>
        </label>
        <label>
          Shell
          <select
            value={shell}
            onChange={(e) => setShell(e.target.value as ShellKind)}
          >
            {SHELL_KINDS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Every (minutes)
          <input
            type="number"
            min="1"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <label>
          Control
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as AgentMode)}
          >
            <option value="assisted">Assisted</option>
            <option value="autonomous">
              Autonomous · 20 commands / 15 min
            </option>
          </select>
        </label>
        <p>{hub.config.model} · 20 commands · 15 minutes maximum</p>
        <button>Add schedule</button>
      </form>
      {hub.schedules.map((s) => (
        <article className="ai-card" key={s.id}>
          <strong>{s.title}</strong>
          <p>
            {s.profileId} · {s.model} · {s.mode}
          </p>
          <p>Next: {new Date(s.nextRunAt).toLocaleString()}</p>
          <p>{s.lastStatus ?? "Not run yet"}</p>
          <button
            onClick={() =>
              void act({
                action: "schedule-save",
                schedule: { ...s, enabled: !s.enabled },
              })
            }
          >
            {s.enabled ? "Disable" : "Enable"}
          </button>
          <button
            onClick={() => void act({ action: "schedule-delete", id: s.id })}
          >
            Delete
          </button>
        </article>
      ))}
    </div>
  );
}

function AgentsAndMcpView({
  hub,
  act,
  selectedAgentId,
  onSelectAgentForChat,
  onStartedMission,
}: {
  hub: HubSnapshot;
  act: Act;
  selectedAgentId: string;
  onSelectAgentForChat: (id: string) => void;
  onStartedMission: (newTaskId?: string) => void;
}): JSX.Element {
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentMission, setAgentMission] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentCluster, setAgentCluster] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>("assisted");
  const [agentKbCollections, setAgentKbCollections] = useState("");
  const [showAgentForm, setShowAgentForm] = useState(false);

  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpCommand, setMcpCommand] = useState("npx");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [testingMcpId, setTestingMcpId] = useState("");

  const clusters = Array.from(
    new Set(
      (hub.workspaceServers ?? [])
        .map((s) => s.cluster)
        .filter((c): c is string => Boolean(c)),
    ),
  );

  const totalMcpTools = (hub.mcpServers ?? []).reduce(
    (sum, s) => sum + (s.discoveredTools?.length ?? 0),
    0,
  );

  return (
    <div className="ai-scroll">
      <div className="ai-stat-grid">
        <div className="ai-stat-box">
          <strong>{(hub.agents ?? []).length}</strong>
          <small>🤖 Mission Agents</small>
        </div>
        <div className="ai-stat-box">
          <strong>{(hub.mcpServers ?? []).filter((s) => s.enabled).length}</strong>
          <small>🔌 Active MCP Servers</small>
        </div>
        <div className="ai-stat-box">
          <strong>{totalMcpTools}</strong>
          <small>🛠️ Discovered MCP Tools</small>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2>🤖 Mission Agents ({(hub.agents ?? []).length})</h2>
        <button className="ai-btn-accent" onClick={() => setShowAgentForm((v) => !v)}>
          {showAgentForm ? "Close Form" : "+ New Mission Agent"}
        </button>
      </div>
      <p className="ai-hint">
        Configure specialized AI agents with their own mission, system prompt, target cluster, KB collections, and MCP tools. Select an agent in chat or launch its mission directly.
      </p>

      {showAgentForm && (
        <form
          className="ai-form ai-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!agentName.trim() || !agentMission.trim()) return;
            void act({
              action: "agent-save",
              agent: {
                name: agentName.trim(),
                role: agentRole.trim() || "Storage & Infrastructure Specialist",
                mission: agentMission.trim(),
                systemPrompt:
                  agentPrompt.trim() ||
                  `You are ${agentName.trim()}. Focus on mission: ${agentMission.trim()}`,
                targetCluster: agentCluster || undefined,
                defaultMode: agentMode,
                kbCollectionIds: agentKbCollections
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
                mcpServerIds: (hub.mcpServers ?? [])
                  .filter((m) => m.enabled)
                  .map((m) => m.id),
                enabled: true,
              },
            }).then(() => {
              setAgentName("");
              setAgentRole("");
              setAgentMission("");
              setAgentPrompt("");
              setShowAgentForm(false);
            });
          }}
        >
          <strong>Create Mission Agent</strong>
          <label>
            Agent Name
            <input
              required
              placeholder="e.g. NetApp MetroCluster Failover Auditor"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
          </label>
          <label>
            Role / Title
            <input
              placeholder="e.g. Principal ONTAP Availability Engineer"
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
            />
          </label>
          <label>
            Mission (Uppdrag)
            <textarea
              required
              placeholder="e.g. Audit SnapMirror lag, aggregate capacity, and LIF failover policies across the cluster and propose remediations."
              value={agentMission}
              onChange={(e) => setAgentMission(e.target.value)}
            />
          </label>
          <label>
            System Instructions
            <textarea
              placeholder="Detailed runbook instructions, preferred CLI syntax, and safety rules…"
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
            />
          </label>
          <label>
            Target Cluster (optional)
            <select
              value={agentCluster}
              onChange={(e) => setAgentCluster(e.target.value)}
            >
              <option value="">All clusters / active terminal</option>
              {clusters.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default Control Mode
            <select
              value={agentMode}
              onChange={(e) => setAgentMode(e.target.value as AgentMode)}
            >
              <option value="plan">Plan only (read-only analysis)</option>
              <option value="assisted">Assisted (approve commands first)</option>
              <option value="autonomous">Autonomous (execute immediately)</option>
            </select>
          </label>
          <label>
            KB Collections (comma-separated, e.g. netapp-ontap, storagegrid)
            <input
              placeholder="netapp-ontap, storagegrid, ceph"
              value={agentKbCollections}
              onChange={(e) => setAgentKbCollections(e.target.value)}
            />
          </label>
          <button type="submit">Save Mission Agent</button>
        </form>
      )}

      {(hub.agents ?? []).map((ag: MissionAgent) => (
        <article
          className={`ai-card ${selectedAgentId === ag.id ? "ai-card-active" : ""}`}
          key={ag.id}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div>
              <strong>
                {ag.icon || "🤖"} {ag.name}
              </strong>
              <div style={{ marginTop: 2 }}>
                <small>{ag.role}</small>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" }}>
              {selectedAgentId === ag.id && (
                <span className="ai-pill">Active in Chat</span>
              )}
              <span className="ai-badge ai-badge-mode">{ag.defaultMode}</span>
              {ag.targetCluster && (
                <span className="ai-badge ai-badge-cluster">
                  🧩 {ag.targetCluster}
                </span>
              )}
            </div>
          </div>
          <p style={{ marginTop: 8 }}>
            <strong>Uppdrag:</strong> {ag.mission}
          </p>
          {((ag.kbCollectionIds ?? ag.kbDocIds ?? []).length > 0 ||
            (ag.mcpServerIds ?? []).length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
              {(ag.kbCollectionIds ?? ag.kbDocIds ?? []).map((kb) => (
                <span key={kb} className="ai-tool-tag">
                  📚 {kb}
                </span>
              ))}
              {(ag.mcpServerIds ?? []).map((mcpId) => {
                const srv = (hub.mcpServers ?? []).find((m) => m.id === mcpId);
                return (
                  <span key={mcpId} className="ai-tool-tag">
                    🔌 {srv?.name || mcpId}
                  </span>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            <button
              className="ai-btn-accent"
              onClick={() => onSelectAgentForChat(ag.id)}
            >
              💬 Use in Chat
            </button>
            <button
              className="ai-btn-emerald"
              onClick={() => {
                const prevIds = new Set(hub.tasks.map((t) => t.id));
                void act({
                  action: "agent-run-mission",
                  id: ag.id,
                }).then((nextSnap) => {
                  const created = nextSnap?.tasks.find((t) => !prevIds.has(t.id));
                  onStartedMission(created?.id ?? nextSnap?.tasks[0]?.id);
                });
              }}
            >
              🚀 Run Mission Now
            </button>
            <button
              className="ai-btn-danger"
              onClick={() =>
                void act({ action: "agent-delete", id: ag.id })
              }
            >
              Delete
            </button>
          </div>
        </article>
      ))}

      <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #2a3140)", margin: "18px 0" }} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2>🔌 MCP Servers ({(hub.mcpServers ?? []).length})</h2>
        <button onClick={() => setShowMcpForm((v) => !v)}>
          {showMcpForm ? "Close Form" : "+ Add MCP Server"}
        </button>
      </div>
      <p className="ai-hint">
        Connect external Model Context Protocol (MCP) servers over local <code>stdio</code> or remote <code>HTTP / JSON-RPC</code>. Discovered tools are automatically exposed to the AI as <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.
      </p>

      {showMcpForm && (
        <form
          className="ai-form ai-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mcpName.trim()) return;
            void act({
              action: "mcp-save",
              server: {
                name: mcpName.trim(),
                transport: mcpTransport,
                command: mcpTransport === "stdio" ? mcpCommand.trim() : undefined,
                args:
                  mcpTransport === "stdio"
                    ? mcpArgs
                        .split(/\s+/)
                        .map((x) => x.trim())
                        .filter(Boolean)
                    : undefined,
                url: mcpTransport === "http" ? mcpUrl.trim() : undefined,
                enabled: true,
              },
            }).then(() => {
              setMcpName("");
              setMcpArgs("");
              setMcpUrl("");
              setShowMcpForm(false);
            });
          }}
        >
          <strong>Add MCP Server</strong>
          <label>
            Server Name
            <input
              required
              placeholder="e.g. NetApp Harvest & Prometheus MCP"
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
            />
          </label>
          <label>
            Transport
            <select
              value={mcpTransport}
              onChange={(e) =>
                setMcpTransport(e.target.value as "stdio" | "http")
              }
            >
              <option value="stdio">Local Process (stdio JSON-RPC)</option>
              <option value="http">Remote HTTP / JSON-RPC Endpoint</option>
            </select>
          </label>
          {mcpTransport === "stdio" ? (
            <>
              <label>
                Command
                <input
                  required
                  placeholder="npx or node or python"
                  value={mcpCommand}
                  onChange={(e) => setMcpCommand(e.target.value)}
                />
              </label>
              <label>
                Arguments (space-separated)
                <input
                  placeholder="-y @modelcontextprotocol/server-filesystem /etc"
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                />
              </label>
            </>
          ) : (
            <label>
              HTTP JSON-RPC Endpoint URL
              <input
                required
                placeholder="https://mcp.internal.example.com/rpc"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
              />
            </label>
          )}
          <button type="submit">Save & Discover Tools</button>
        </form>
      )}

      {(hub.mcpServers ?? []).map((srv: McpServerConfig) => (
        <article className="ai-card" key={srv.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <strong>🔌 {srv.name}</strong>
            <span
              className={`ai-badge ${
                srv.status === "connected" ? "ai-badge-success" : ""
              }`}
            >
              {srv.status === "connected" ? "🟢 " : ""}
              {srv.transport.toUpperCase()} ·{" "}
              {srv.status ?? (srv.enabled ? "configured" : "disabled")}
            </span>
          </div>
          <small style={{ display: "block", marginTop: 4, fontFamily: "monospace" }}>
            {srv.transport === "stdio"
              ? `${srv.command ?? ""} ${(srv.args ?? []).join(" ")}`
              : srv.url}
          </small>
          {srv.lastError && (
            <p className="ai-error" style={{ marginTop: 6 }}>
              {srv.lastError}
            </p>
          )}
          {(srv.discoveredTools ?? []).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
              {srv.discoveredTools!.map((t) => (
                <span
                  key={t.name}
                  className="ai-tool-tag"
                  title={t.description}
                >
                  🛠️ {t.name}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            <button
              className="ai-btn-accent"
              disabled={testingMcpId === srv.id}
              onClick={() => {
                setTestingMcpId(srv.id);
                void act({ action: "mcp-test", id: srv.id }).finally(() =>
                  setTestingMcpId(""),
                );
              }}
            >
              {testingMcpId === srv.id ? "Testing…" : "🔍 Test & Discover Tools"}
            </button>
            <button
              onClick={() =>
                void act({
                  action: "mcp-save",
                  server: { ...srv, enabled: !srv.enabled },
                })
              }
            >
              {srv.enabled ? "Disable" : "Enable"}
            </button>
            <button
              className="ai-btn-danger"
              onClick={() => void act({ action: "mcp-delete", id: srv.id })}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function KnowledgeBaseView({
  hub,
  act,
  onAttachDoc,
}: {
  hub: HubSnapshot;
  act: Act;
  onAttachDoc: (doc: KbDocument) => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState("netapp-ontap");
  const [cluster, setCluster] = useState("");
  const [tags, setTags] = useState("");
  const [content, setContent] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);

  const docs = (hub.kbDocuments ?? []).filter((d) => {
    if (!searchFilter.trim()) return true;
    const q = searchFilter.toLowerCase();
    return (
      d.title.toLowerCase().includes(q) ||
      (d.collection ?? d.cluster ?? "").toLowerCase().includes(q) ||
      d.content.toLowerCase().includes(q) ||
      (d.tags ?? []).some((t: string) => t.toLowerCase().includes(q))
    );
  });

  const totalChunks = (hub.kbDocuments ?? []).reduce(
    (sum, d) => sum + (d.chunks?.length ?? 1),
    0,
  );

  return (
    <div className="ai-scroll">
      <div className="ai-stat-grid">
        <div className="ai-stat-box">
          <strong>{(hub.kbDocuments ?? []).length}</strong>
          <small>📚 Runbooks & Docs</small>
        </div>
        <div className="ai-stat-box">
          <strong>{totalChunks}</strong>
          <small>🧩 Indexed BM25 Chunks</small>
        </div>
        <div className="ai-stat-box">
          <strong>BM25 + Cluster</strong>
          <small>⚡ Retrieval Engine</small>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2>📚 Knowledge Base ({(hub.kbDocuments ?? []).length} docs)</h2>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() =>
              void act({
                action: "kb-ingest-s3",
                s3ProfileId: "sg-fabricpool-dc1",
                prefix: "runbooks/",
                cluster: "NetApp-StorageGRID-S3",
              })
            }
          >
            ☁️ Sync S3 Runbooks
          </button>
          <button className="ai-btn-accent" onClick={() => setShowAddDoc((v) => !v)}>
            {showAddDoc ? "Close Editor" : "+ Add Runbook / Doc"}
          </button>
        </div>
      </div>
      <p className="ai-hint">
        Store NetApp ONTAP, StorageGRID, Ceph, ZFS, and Kubernetes runbooks, CLI cheat-sheets, and architecture docs. Documents are automatically chunked and indexed for BM25 retrieval via <code>sshs3_kb_search</code> and synced with your S3 Team Workspace.
      </p>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        <input
          style={{ flex: 1 }}
          placeholder="Search KB runbooks, CLI commands, collections, tags…"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
        />
      </div>

      {showAddDoc && (
        <form
          className="ai-form ai-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !content.trim()) return;
            void act({
              action: "kb-save",
              doc: {
                title: title.trim(),
                collection: collection.trim() || "general",
                cluster: cluster.trim() || undefined,
                tags: tags
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
                content: content.trim(),
                sourceType: "manual",
              },
            }).then(() => {
              setTitle("");
              setContent("");
              setTags("");
              setShowAddDoc(false);
            });
          }}
        >
          <strong>Add KB Document / Runbook</strong>
          <label>
            Title
            <input
              required
              placeholder="e.g. NetApp ONTAP Aggregate Relocation SOP"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Collection
            <input
              placeholder="netapp-ontap, storagegrid, ceph, kubernetes"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
            />
          </label>
          <label>
            Cluster Binding (optional)
            <input
              placeholder="e.g. NetApp MetroCluster Stockholm"
              value={cluster}
              onChange={(e) => setCluster(e.target.value)}
            />
          </label>
          <label>
            Tags (comma-separated)
            <input
              placeholder="ontap, snapmirror, qos, failover"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </label>
          <label>
            Markdown / Runbook Content
            <textarea
              required
              rows={6}
              placeholder="# Runbook Title&#10;&#10;Paste CLI commands, troubleshooting steps, and architecture notes…"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <button type="submit">Save & Index Document</button>
        </form>
      )}

      <form
        className="ai-form ai-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (!folderPath.trim()) return;
          void act({
            action: "kb-ingest-folder",
            folderPath: folderPath.trim(),
            collection: collection.trim() || "folder-sync",
            cluster: cluster.trim() || undefined,
          }).then(() => setFolderPath(""));
        }}
      >
        <strong>Ingest Local Runbook Folder</strong>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            style={{ flex: 1 }}
            placeholder="e.g. C:\Runbooks\NetApp-ONTAP (.md, .txt, .yaml, .conf)"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
          />
          <button type="submit">Sync Folder</button>
        </div>
      </form>

      {docs.map((doc: KbDocument) => (
        <article className="ai-card" key={doc.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div>
              <strong>📄 {doc.title}</strong>
              <div>
                <small>
                  Collection: <code>{doc.collection || doc.cluster || "general"}</code> · {doc.chunks.length} chunk(s)
                  {doc.cluster ? ` · Cluster: ${doc.cluster}` : ""}
                </small>
              </div>
            </div>
            <small>{new Date(doc.updatedAt).toLocaleDateString()}</small>
          </div>
          {(doc.tags ?? []).length > 0 && (
            <small style={{ display: "block", marginTop: 4 }}>
              🏷️ {(doc.tags ?? []).join(", ")}
            </small>
          )}
          {expandedDocId === doc.id ? (
            <pre style={{ marginTop: 8, maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap" }}>
              {doc.content}
            </pre>
          ) : (
            <p style={{ marginTop: 6 }}>
              {doc.content.slice(0, 200)}
              {doc.content.length > 200 ? "…" : ""}
            </p>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            <button onClick={() => onAttachDoc(doc)}>
              📎 Attach to Chat (@kb)
            </button>
            <button
              onClick={() =>
                setExpandedDocId(expandedDocId === doc.id ? null : doc.id)
              }
            >
              {expandedDocId === doc.id ? "Hide Content" : "Read Full Runbook"}
            </button>
            <button
              onClick={() => void act({ action: "kb-delete", id: doc.id })}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}
