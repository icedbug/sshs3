import { externalLinkProps } from "../../../lib/openLink";
import { Check, Terminal, X } from "lucide-react";
import { SHELL_KINDS, type ShellKind } from "@shared/types/aiHub";
import { PlanCard } from "../PlanCard";
import { TerminalControl } from "../TerminalControl";
import { AnsiLogView, DiffViewer, HighlightedCode } from "../DiffViewer";
import { TABULAR_NUMS_STYLE } from "../panelShared";
import { RichMarkdownContent } from "../RichMarkdownContent";
import { isModelSetupMessage, formatDurationBadge, isDiffToolRecord, isAnsiToolRecord } from "./panelHelpers";
import type { PanelState } from "./usePanelState";

/**
 * What follows the conversation's messages: the tool log, sources, text as it streams, the terminal control,
 * the plan, an error, what the agent is doing, why it stopped, and the question about connecting a terminal.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function ConversationTail({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    task,
    streamingState,
    running,
    activeAgent,
    terminalHandoff,
    handleOpenFileRef,
    targetSessionId,
    act,
    setSettingsOpen,
    sending,
    pending,
    busy,
    mode,
    setView,
    connection,
    shell,
    setShell,
    prompt,
    connectAndSend,
    setConnection,
    sendMessage,
  } = p;
  return (
    <>
                {(() => {
                  const streamed = streamingState?.tools ?? [];
                  const combinedTools = [
                    ...(task?.toolLog ?? []).filter((rec) => !streamed.some((live) => live.at === rec.at && live.name === rec.name && live.input === rec.input)),
                    ...streamed,
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
                  <div className="ai-sources-bar" data-testid="ai-task-sources" aria-label="Conversation context">
                    <small className="ai-hint">Conversation context</small>
                    {(() => {
                      const hasSimulatedChat = Boolean(hub.chatSources?.connections.some((c) => c.simulated));
                      return task.sources.map((src) =>
                        // What was read in the team's chat opens the thread it came from, unless simulated in the demo lab.
                        src.kind === "chat" && src.link && !hasSimulatedChat ? (
                          <a key={src.id} className="ai-pill" {...externalLinkProps(src.link)} title={src.text.slice(0, 200)}>
                            {src.label}
                          </a>
                        ) : (
                          <span
                            key={src.id}
                            className="ai-pill"
                            title={src.text.slice(0, 200)}
                          >
                            {src.label}
                            {src.kind === "chat" && hasSimulatedChat ? " (simulated)" : ""}
                          </span>
                        ),
                      );
                    })()}
                  </div>
                )}
                {streamingState &&
                  streamingState.text &&
                  !(streamingState.messageId
                    ? task?.messages.some((m) => m.id === streamingState.messageId)
                    : task?.messages.at(-1)?.role === "assistant" && task.messages.at(-1)?.text === streamingState.text) && (
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
                      terminalActions={terminalHandoff.forMessage(streamingState.partial ? undefined : streamingState.messageId ?? streamingState.localId)}
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
    </>
  );
}
