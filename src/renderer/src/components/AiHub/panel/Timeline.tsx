import { memo, useEffect, useMemo, useRef, useState } from "react";
import { GitFork, Pencil, RotateCcw, Terminal } from "lucide-react";
import { CONTEXT_NOTE_PREFIX, SNAPSHOT_TAIL_CHARS, type AgentMessage } from "@shared/types/aiHub";
import type { FileRef } from "../reportRefs";
import { AnsiLogView, DiffViewer } from "../DiffViewer";
import { copyToClipboard, RichMarkdownContent } from "../RichMarkdownContent";
import { AnswerSources } from "../AnswerSources";
import { ChangeProof } from "../ChangeProof";
import { ConfirmButton } from "../ConfirmButton";
import { ChangeReveal, ChangeSecretInputs } from "../ChangeSecrets";
import { lastUserMessageId } from "./panelHelpers";
import { memoryFromAnswer } from "./memoryFromAnswer";
import type { PanelState } from "./usePanelState";

/** What a message row can ask of the panel. One object for the whole conversation, the same on every render. */
interface RowActions {
  edit(text: string): void;
  retry(): void;
  fork(messageId: string): void;
  copy(messageId: string, text: string): void;
  saveToMemory(text: string): void;
  followUp(): void;
  openRef(ref: string): void;
  openFileRef(ref: FileRef): void;
  stage(messageId: string, command: string, line: number): void;
  run(messageId: string, command: string, line: number): void;
}

interface MessageRowProps {
  message: AgentMessage;
  taskId?: string;
  agentIcon?: string;
  agentName?: string;
  running: boolean;
  /** A request is on its way. Only the row that offers Retry is told. */
  busy: boolean;
  copied: boolean;
  /** The last thing in the conversation: the answer's own buttons are under it. */
  isLast: boolean;
  /** The last message a person wrote: it can be asked again. */
  canRetry: boolean;
  /** The message a running answer is being written into. */
  streaming: boolean;
  /** The short names of this conversation's commands, for an answer that points at them. */
  refs?: ReadonlySet<string>;
  /** Only the end of a long message is here: its code blocks cannot be numbered yet. */
  clipped: boolean;
  actions: RowActions;
}

/**
 * One message of the conversation. It is drawn again only when what it is given changes, so the
 * markdown of a long conversation is not worked out anew for every key pressed in the composer.
 */
export const MessageRow = memo(function MessageRow({
  message,
  taskId,
  agentIcon,
  agentName,
  running,
  busy,
  copied,
  isLast,
  canRetry,
  streaming,
  refs,
  clipped,
  actions,
}: MessageRowProps): JSX.Element {
  const terminalActions = useMemo(
    () =>
      clipped
        ? undefined
        : {
            stage: (command: string, line: number) => actions.stage(message.id, command, line),
            run: (command: string, line: number) => actions.run(message.id, command, line),
          },
    [clipped, actions, message.id],
  );
  return (
    <article
      className={
        "ai-message ai-message-" +
        message.role +
        // What the app told the agent on the user's behalf (a plan decision) is a one-line note.
        (message.text.startsWith("[sshs3]") ? " ai-message-note" : "")
      }
    >
      <div className="ai-message-header">
        <small className="ai-message-author">
          <span className="ai-avatar-badge">{message.role === "user" ? "Y" : agentIcon || "A"}</span>
          <span>{message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : "sshs3"}</span>
          {message.role === "assistant" && agentName && <span className="ai-pill">{agentName}</span>}
        </small>
        <span className="ai-message-meta">
          {message.at > 0 && (
            <span>
              {new Date(message.at).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          {message.role === "user" && !running && (
            <>
              <button
                type="button"
                className="ai-code-btn"
                title="Edit prompt in composer"
                onClick={() => actions.edit(message.text)}
              >
                <Pencil size={11} /> Edit
              </button>
              {/* Asking again answers the last question anew: the question is not posted a second time. */}
              {canRetry && (
                <button
                  type="button"
                  className="ai-code-btn"
                  data-testid="ai-message-retry"
                  title="Ask again. The answer below is replaced by the new one."
                  disabled={busy}
                  onClick={() => actions.retry()}
                >
                  <RotateCcw size={11} /> Retry
                </button>
              )}
            </>
          )}
          {taskId && (
            <button
              type="button"
              className="ai-code-btn"
              title="Start a new conversation from a copy of this one, up to this message"
              onClick={() => actions.fork(message.id)}
            >
              <GitFork size={11} /> Branch off here
            </button>
          )}
          {message.role === "assistant" && (
            <button
              type="button"
              className="ai-code-btn"
              title="Copy the whole answer"
              onClick={() => actions.copy(message.id, message.text)}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          )}
        </span>
      </div>
      {message.images && message.images.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "8px",
            marginBottom: "8px",
          }}
        >
          {message.images.map((img, imgIdx) => (
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
        text={message.text.startsWith(CONTEXT_NOTE_PREFIX) ? message.text.slice(CONTEXT_NOTE_PREFIX.length) : message.text}
        refs={refs}
        onOpenRef={actions.openRef}
        terminalActions={terminalActions}
        onOpenFileRef={actions.openFileRef}
      />
      {message.role === "assistant" && taskId && (
        <AnswerSources key={`${taskId}:${message.id}`} taskId={taskId} messageId={message.id} count={message.sourceCallCount} streaming={streaming} />
      )}
      {message.role === "assistant" && isLast && !running && (
        <div className="ai-message-footer">
          <button type="button" className="ai-msg-action-btn" onClick={() => actions.copy(message.id, message.text)}>
            {copied ? "Copied" : "Copy answer"}
          </button>
          <button type="button" className="ai-msg-action-btn" onClick={() => actions.saveToMemory(message.text)}>
            Save to team memory
          </button>
          <button type="button" className="ai-msg-action-btn" onClick={() => actions.followUp()}>
            Follow up
          </button>
        </div>
      )}
    </article>
  );
});

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
    busy,
    act,
    copiedMsgId,
    showingMessageTail,
    handleRestoreCheckpoint,
    approvalNotes,
    setApprovalNotes,
  } = p;
  // The rows ask the panel through this one object, which is the same on every render: it reads the
  // panel's state when it is used. So a row is drawn again only when its own message changes, and
  // typing in the composer draws no message again.
  const live = useRef(p);
  live.current = p;
  const actions = useMemo<RowActions>(
    () => ({
      edit(text) {
        live.current.setPrompt(text);
        setTimeout(() => live.current.composer.current?.focus(), 20);
      },
      retry() {
        const { task: now, terminal: at, act: send } = live.current;
        if (!now) return;
        void send({
          action: "reply",
          taskId: now.id,
          text: "",
          retry: true,
          sessionId: at && at.state !== "disconnected" ? at.id : undefined,
        });
      },
      fork(messageId) {
        void live.current.handleForkTask(messageId);
      },
      copy(messageId, text) {
        void live.current.copyMessage(messageId, text);
      },
      saveToMemory(text) {
        void live.current.act({
          action: "memory-save",
          entry: { kind: "memory", scope: "workspace", ...memoryFromAnswer(live.current.task?.title, text) },
        });
      },
      followUp() {
        live.current.setPrompt("Keep investigating and propose the next concrete verification step.");
        setTimeout(() => live.current.composer.current?.focus(), 20);
      },
      openRef(ref) {
        const el = document.querySelector<HTMLDetailsElement>(`[data-ref="${ref}"]`);
        if (!el) return;
        el.open = true;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("ai-change-flash");
        setTimeout(() => el.classList.remove("ai-change-flash"), 1600);
      },
      openFileRef(ref) {
        live.current.handleOpenFileRef(ref);
      },
      stage(messageId, command, line) {
        live.current.terminalHandoff.forMessage(messageId)?.stage(command, line);
      },
      run(messageId, command, line) {
        live.current.terminalHandoff.forMessage(messageId)?.run(command, line);
      },
    }),
    [],
  );
  // The short names of this conversation's commands, as one set that changes only when a name is added.
  const refNames = (task?.changes ?? []).flatMap((c) => (c.ref ? [c.ref] : [])).join(" ");
  const refs = useMemo(() => new Set(refNames.split(" ").filter(Boolean)), [refNames]);
  const lastUserId = lastUserMessageId(task);
  const lastMessageId = task?.messages.at(-1)?.id;
  // What was typed for a change that no longer waits (answered elsewhere, stopped, timed out) is dropped.
  const waitingIds = (task?.changes ?? []).filter((c) => c.status === "pending").map((c) => c.id).join(" ");
  useEffect(() => {
    const waiting = new Set(waitingIds.split(" ").filter(Boolean));
    setSecretValues((all) => (Object.keys(all).every((id) => waiting.has(id)) ? all : Object.fromEntries(Object.entries(all).filter(([id]) => waiting.has(id)))));
  }, [waitingIds]);
  return (
    <>
                {timeline.map((item, idx) =>
                  item.message ? (
                    <MessageRow
                      key={item.message.id}
                      message={item.message}
                      taskId={task?.id}
                      agentIcon={activeAgent?.icon}
                      agentName={task?.agentName || activeAgent?.name}
                      running={running}
                      busy={busy && item.message.id === lastUserId}
                      copied={copiedMsgId === item.message.id}
                      isLast={idx === timeline.length - 1}
                      canRetry={Boolean(task) && item.message.id === lastUserId}
                      streaming={running && item.message.id === lastMessageId}
                      refs={item.message.role === "assistant" && task ? refs : undefined}
                      clipped={showingMessageTail && item.message.text.length >= SNAPSHOT_TAIL_CHARS}
                      actions={actions}
                    />
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
                      <ChangeProof change={item.change} taskId={task.id} />
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
                            // It overwrites the file on the server with its earlier content: it asks first.
                            <ConfirmButton
                              label="Restore Checkpoint"
                              confirmLabel="Put the file back as it was?"
                              className="ai-mini-btn"
                              testId={`ai-restore-checkpoint-${item.change!.id}`}
                              disabled={busy}
                              onConfirm={() => {
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
                            />
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
                                // The card of a change that takes secrets always says what was typed, also when that is nothing.
                                ...(item.change!.secretFields?.length ? { secrets: typed ?? {} } : {}),
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
                            onClick={() => {
                              const changeId = item.change!.id;
                              // Said no: what was typed is not kept.
                              setSecretValues((all) => Object.fromEntries(Object.entries(all).filter(([id]) => id !== changeId)));
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId,
                                approved: false,
                                note: approvalNotes[changeId]?.trim() || undefined,
                              });
                            }}
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
