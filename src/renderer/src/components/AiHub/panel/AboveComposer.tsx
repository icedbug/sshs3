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
    terminalDraft,
    setTerminalDraft,
    draftConnected,
    writingDraft,
    runTerminalDraft,
    draftHasControl,
  } = p;
  return (
    <>
      {terminalDraft && (
        <div className="ai-card" style={{ margin: "4px 8px" }}>
          <label>
            <strong>Terminal draft{terminalDraft.target ? ` · ${terminalDraft.target.label}` : ""}</strong>
            <textarea
              aria-label="Terminal command draft"
              className="ai-mono"
              style={{ display: "block", width: "100%", boxSizing: "border-box" }}
              rows={3}
              autoFocus
              value={terminalDraft.text}
              disabled={writingDraft}
              onChange={(e) => setTerminalDraft({ ...terminalDraft, text: e.target.value })}
            />
          </label>
          {draftHasControl && <small className="ai-muted">Remove terminal control characters to run this draft.</small>}
          {!draftConnected && (
            <small className="ai-muted">Select a current terminal and stage the command again to run it.</small>
          )}
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-accent" disabled={!draftConnected || draftHasControl || writingDraft || !terminalDraft.text.trim()} onClick={() => void runTerminalDraft()}>
              {writingDraft ? "Sending…" : "Run edited command"}
            </button>
            <button type="button" disabled={writingDraft} onClick={() => setTerminalDraft(null)}>Cancel draft</button>
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
    </>
  );
}
