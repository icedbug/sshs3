import { useState } from "react";
import { GitFork, Pencil, RotateCcw, Terminal } from "lucide-react";
import { CONTEXT_NOTE_PREFIX, SNAPSHOT_TAIL_CHARS } from "@shared/types/aiHub";
import { AnsiLogView, DiffViewer } from "../DiffViewer";
import { copyToClipboard, RichMarkdownContent } from "../RichMarkdownContent";
import { AnswerSources } from "../AnswerSources";
import { ChangeProof } from "../ChangeProof";
import { ChangeReveal, ChangeSecretInputs } from "../ChangeSecrets";
import { lastUserMessageId } from "./panelHelpers";
import type { PanelState } from "./usePanelState";

/**
 * The conversation itself: each message, and each change an agent made or asked for, in the order they happened.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function Timeline({ p }: { p: PanelState }): JSX.Element {
  // What is typed for a setting's secrets, by change. Kept here only until the approval is sent.
  const [secretValues, setSecretValues] = useState<Record<string, Record<string, string>>>({});
  // Cards that show a one-time value in this window: they stay open while the person copies it.
  const [showing, setShowing] = useState<Record<string, true>>({});
  const {
    timeline,
    activeAgent,
    task,
    running,
    setPrompt,
    composer,
    busy,
    act,
    terminal,
    handleForkTask,
    copyMessage,
    copiedMsgId,
    terminalHandoff,
    showingMessageTail,
    handleOpenFileRef,
    handleRestoreCheckpoint,
    approvalNotes,
    setApprovalNotes,
  } = p;
  return (
    <>
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
                              {/* Asking again answers the last question anew: the question is not posted a second time. */}
                              {task && item.message.id === lastUserMessageId(task) && (
                                <button
                                  type="button"
                                  className="ai-code-btn"
                                  data-testid="ai-message-retry"
                                  title="Ask again. The answer below is replaced by the new one."
                                  disabled={busy}
                                  onClick={() =>
                                    void act({
                                      action: "reply",
                                      taskId: task.id,
                                      text: "",
                                      retry: true,
                                      sessionId: terminal && terminal.state !== "disconnected" ? terminal.id : undefined,
                                    })
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
                              title="Start a new conversation from a copy of this one, up to this message"
                              onClick={() => void handleForkTask(item.message!.id)}
                            >
                              <GitFork size={11} /> Branch off here
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
                        terminalActions={terminalHandoff.forMessage(showingMessageTail && item.message.text.length >= SNAPSHOT_TAIL_CHARS ? undefined : item.message.id)}
                        onOpenFileRef={handleOpenFileRef}
                      />
                      {item.message.role === "assistant" && task && (
                        <AnswerSources key={`${task.id}:${item.message.id}`} taskId={task.id} messageId={item.message.id}
                          count={item.message.sourceCallCount} streaming={running && item.message.id === task.messages.at(-1)?.id} />
                      )}
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
                      // Open while it waits for an answer, and while it holds something to show the person once:
                      // a key nobody sees is a key nobody copies.
                      open={item.change.status === "pending" || Boolean(item.change.reveal && (!item.change.reveal.shown || showing[item.change.id]))}
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
                        <ChangeSecretInputs
                          change={item.change}
                          values={secretValues[item.change.id] ?? {}}
                          onChange={(next) => setSecretValues({ ...secretValues, [item.change!.id]: next })}
                        />
                      )}
                      {item.change.status !== "pending" && (
                        <ChangeReveal taskId={task.id} change={item.change} act={act} onShown={() => setShowing((all) => ({ ...all, [item.change!.id]: true }))} />
                      )}
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
                            onClick={() => {
                              const changeId = item.change!.id;
                              const typed = secretValues[changeId];
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId,
                                approved: true,
                                note: approvalNotes[changeId]?.trim() || undefined,
                                ...(item.change!.secretFields?.length && typed ? { secrets: typed } : {}),
                              }).then((sent) => {
                                // Sent: what was typed is not kept in the window any longer.
                                if (sent) setSecretValues((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== changeId)));
                              });
                            }}
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
    </>
  );
}
