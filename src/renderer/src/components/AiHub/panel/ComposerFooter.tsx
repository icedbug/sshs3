import { ChevronDown, ShieldCheck } from "lucide-react";
import { AGENT_MODES } from "@shared/types/aiHub";
import { modes } from "../panelShared";
import { plural } from "../../../lib/plural";
import type { PanelState } from "./usePanelState";

/**
 * Under the text box: the agent's mode, the model, how full the context is, and the hidden file chooser.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function ComposerFooter({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    task,
    draftMode,
    activeProfile,
    setAutonomy,
    setModePicked,
    setConnection,
    setMenu,
    setSettingsOpen,
    attachments,
    fileInput,
    attachFileOrImage,
  } = p;
  return (
    <>
                <div className="ai-composer-footer">
                  <div className="ai-mode-pills" role="group" aria-label="Agent mode">
                    {AGENT_MODES.map((value) => {
                      const activeMode = (task?.mode ?? draftMode) === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          data-testid={`ai-mode-pill-${value}`}
                          className={`ai-footer-chip ${activeMode ? "ai-context-chip-active" : ""}`}
                          aria-pressed={activeMode}
                          disabled={!!task}
                          title={
                            value === "advice"
                              ? "Advice: talk it through. Nothing is run."
                              : value === "plan"
                                ? "Plan: The agent looks around, then proposes a plan. Change cards and file writes wait until you approve it."
                                : value === "assisted"
                                  ? "Ask first: Commands run without asking. A change card or a file write waits for you."
                                  : "Auto: Commands and change cards run without asking. On production a change card still waits for a person."
                          }
                          onClick={() => {
                            setAutonomy(value);
                            setModePicked(true);
                            setConnection(undefined);
                            setMenu(null);
                          }}
                        >
                          {activeMode && <ShieldCheck size={11} />}
                          <span>{modes[value]}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="ai-footer-chip ai-model-chip"
                    data-testid="ai-composer-model-chip"
                    aria-label="Choose model"
                    title={activeProfile.destination || activeProfile.label}
                    onClick={() => setSettingsOpen(true)}
                  >
                    <span>{activeProfile.label}</span>
                    <ChevronDown size={11} />
                  </button>
                  <button
                    className="ai-footer-chip"
                    aria-label="Context budget & parameters"
                    title={`Context window: ${Math.round((hub.contextBudget?.contextWindowTokens ?? hub.config.contextWindowTokens ?? 128000) / 1000)}k tokens · Terminal scrollback: ${Math.round((hub.contextBudget?.terminalContextChars ?? hub.config.terminalContextChars ?? 8000) / 1000)}k chars · Reasoning: ${hub.config.reasoningEffort ?? "medium"}`}
                    onClick={() => setSettingsOpen(true)}
                  >
                    {(() => {
                      const maxTokens = hub.contextBudget?.contextWindowTokens ?? hub.config.contextWindowTokens ?? 128000;
                      // What is known: how much the model was sent at its last call in this conversation.
                      // Before the first run there is nothing to measure, so only the window is shown.
                      const usedTokens = task?.contextTokens;
                      if (!usedTokens) return <span>{Math.round(maxTokens / 1000)}k window</span>;
                      const pct = Math.min(100, Math.max(4, Math.round((usedTokens / maxTokens) * 100)));
                      return (
                        <>
                          <span title="What the model was sent at its last call in this conversation">
                            {Math.max(1, Math.round(usedTokens / 1000))}k of {Math.round(maxTokens / 1000)}k
                          </span>
                          <span className="ai-context-meter-bar" aria-hidden="true">
                            <span className="ai-context-meter-fill" style={{ width: `${pct}%` }} />
                          </span>
                        </>
                      );
                    })()}
                  </button>
                  {attachments.length > 0 && (
                    <small>{plural(attachments.length, "source")}</small>
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
    </>
  );
}
