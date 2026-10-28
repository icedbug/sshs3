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
  type ShellKind,
} from "@shared/types/aiHub";
import {
  DEFAULT_AI_MODELS,
  DEFAULT_PROVIDER_MODELS,
} from "@shared/types/ai";
import {
  hubRequest,
  selectAiTerminal,
  useHub,
  useSelectedTerminal,
} from "../../lib/aiHub";
import "./aiHub.css";

type View =
  "Work" | "Infrastructure" | "Changes" | "Memory & skills" | "Schedules";
type Menu = "history" | "target" | "control" | "mention" | null;
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
  const targetSessionId = task
    ? task.target?.sessionId
    : (connection?.id ?? selectedTerminal);
  const terminal = hub?.sessions.find(
    (s) => s.id === targetSessionId && (task || s.state !== "disconnected"),
  );
  const running =
    !!task && ["queued", "running", "waiting"].includes(task.status);
  const activeView = mode === "panel" ? "Work" : view;
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
    const open = (): void => setMode("panel");
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
  async function sendMessage(sessionId?: string): Promise<void> {
    if (busy || !prompt.trim()) return;
    const result = task
      ? await act({ action: "reply", taskId: task.id, text: prompt })
      : await act({
          action: "start",
          task: { prompt, sessionId, mode: autonomy, attachments },
        });
    if (result) {
      if (!task) setTaskId(result.tasks.at(-1)?.id ?? "");
      setPrompt("");
      setAttachments([]);
      setConnection(undefined);
    }
  }
  async function submit(): Promise<void> {
    if (busy || !prompt.trim()) return;
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
      {mode === "hub" && (
        <nav aria-label="Hub views">
          {(
            [
              "Work",
              "Infrastructure",
              "Changes",
              "Memory & skills",
              "Schedules",
            ] as View[]
          ).map((name) => (
            <button
              key={name}
              aria-current={activeView === name ? "page" : undefined}
              onClick={() => {
                setView(name);
                setMenu(null);
              }}
            >
              {name === "Work" ? "Chat" : name}
            </button>
          ))}
        </nav>
      )}
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
                    <p>Ask a question or describe what you want to do across your shared VMs and terminals.</p>
                    {mode === "hub" && (
                      <div className="ai-welcome-grid">
                        <button
                          type="button"
                          className="ai-starter-card"
                          onClick={() =>
                            setPrompt(
                              "Summarize the latest @team-changes across our shared VMs and check if any service needs attention.",
                            )
                          }
                        >
                          <strong>Review recent team changes</strong>
                          <small>Check what Erik & Sara changed on prod-api-01 and prod-db-primary</small>
                        </button>
                        <button
                          type="button"
                          className="ai-starter-card"
                          onClick={() =>
                            setPrompt(
                              "Diagnose nginx upstream timeouts and PgBouncer connection pool saturation on prod-api-01.",
                            )
                          }
                        >
                          <strong>Investigate prod-api-01 latency</strong>
                          <small>Inspect nginx error logs, PgBouncer pools, and active connections</small>
                        </button>
                        <button
                          type="button"
                          className="ai-starter-card"
                          onClick={() =>
                            setPrompt(
                              "Check CrashLoopBackOff pods in namespace payments on k8s-eu-north-1 and verify Redis TLS settings.",
                            )
                          }
                        >
                          <strong>Debug Kubernetes CrashLoopBackOff</strong>
                          <small>Inspect pod logs and events in k8s-eu-north-1</small>
                        </button>
                        <button
                          type="button"
                          className="ai-starter-card"
                          onClick={() =>
                            setPrompt(
                              "Audit disk usage, WAL archive growth, and replication lag on prod-db-primary.",
                            )
                          }
                        >
                          <strong>Check PostgreSQL health & disk</strong>
                          <small>Verify WAL cleanup and replication status on prod-db-primary</small>
                        </button>
                      </div>
                    )}
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
                        <Paperclip size={11} />
                        {a.label}
                        <X size={11} />
                      </button>
                    ))}
                  </div>
                )}
                <div className="ai-input-box" style={{ position: "relative" }}>
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
                        ? "Send a follow-up… (type @ for clusters/nodes)"
                        : "Ask anything… (type @ for clusters, nodes or @team-changes)"
                    }
                    value={prompt}
                    onChange={(e) => {
                      setPrompt(e.target.value);
                      setAtIndex(0);
                      setAtDismissedFor(null);
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
                      aria-label="Attach text file"
                      title="Attach text file"
                      onClick={() => fileInput.current?.click()}
                    >
                      <Paperclip size={16} />
                    </button>
                    <small>Enter to send · Shift+Enter for a new line</small>
                    {running && !prompt.trim() ? (
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
                        disabled={busy || !prompt.trim()}
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
                  {attachments.length > 0 && (
                    <small>{attachments.length} sources</small>
                  )}
                </div>
                <input
                  ref={fileInput}
                  hidden
                  type="file"
                  accept="text/*,.log,.yaml,.yml,.json,.conf,.md"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      if (file.size > 128_000)
                        setError("Choose a text file smaller than 128 KB.");
                      else
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
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            </div>
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
  }, [
    hub.config.provider,
    hub.config.model,
    hub.config.baseUrl,
    hub.config.actorName,
    hub.config.enabled,
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
