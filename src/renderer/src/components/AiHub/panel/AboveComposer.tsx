import { AlertTriangle } from "lucide-react";
import { TaskTodos } from "../TaskTodos";
import { HypothesisTree } from "../HypothesisTree";
import { maskSecretsForDlp } from "./panelHelpers";
import type { PanelState } from "./usePanelState";

/**
 * Between the conversation and the composer: the agent's task list, and the warning about something that looks like a secret.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function AboveComposer({ p }: { p: PanelState }): JSX.Element {
  const {
    task,
    dlpWarning,
    setPrompt,
    setAttachments,
    sendMessage,
    setDlpWarning,
    terminalHandoff,
  } = p;
  const { draft, writing, connected, hasControl } = terminalHandoff;
  return (
    <>
      {draft && (
        <div className="ai-card" style={{ margin: "4px 8px" }}>
          <label>
            <strong>Terminal draft{draft.target ? ` · ${draft.target.label}` : ""}</strong>
            <textarea
              aria-label="Terminal command draft"
              className="ai-mono"
              style={{ display: "block", width: "100%", boxSizing: "border-box" }}
              rows={3}
              autoFocus
              value={draft.text}
              disabled={writing}
              onChange={(e) => terminalHandoff.edit(e.target.value)}
            />
          </label>
          {hasControl && <small className="ai-muted">Remove terminal control characters to run this draft.</small>}
          {!connected && (
            <small className="ai-muted">Select a current terminal and stage the command again to run it.</small>
          )}
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-accent" disabled={!connected || hasControl || writing || !draft.text.trim()} onClick={() => void terminalHandoff.runDraft()}>
              {writing ? "Sending…" : "Run edited command"}
            </button>
            <button type="button" disabled={writing} onClick={() => terminalHandoff.reset()}>Cancel draft</button>
          </div>
        </div>
      )}
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
                            draft: { prompt: dlpWarning.typed, attachments: dlpWarning.attachments },
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
                            draft: { prompt: dlpWarning.typed, attachments: dlpWarning.attachments },
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
    </>
  );
}
