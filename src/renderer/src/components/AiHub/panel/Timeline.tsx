import { GitFork, Pencil, RotateCcw, Terminal } from "lucide-react";
import { CONTEXT_NOTE_PREFIX } from "@shared/types/aiHub";
import { AnsiLogView, DiffViewer } from "../DiffViewer";
import { copyToClipboard, RichMarkdownContent } from "../RichMarkdownContent";
import { ChangeProof } from "../ChangeProof";
import { lastUserMessageId } from "./panelHelpers";
import type { PanelState } from "./usePanelState";

/**
 * The conversation itself: each message, and each change an agent made or asked for, in the order they happened.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function Timeline({ p }: { p: PanelState }): JSX.Element {
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
    stageCommandInTerminal,
    runCommandInTerminal,
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
    </>
  );
}
