import { ChevronDown, ShieldCheck } from "lucide-react";
import { AGENT_MODES } from "@shared/types/aiHub";
import { modes } from "../panelShared";
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
                                ? "Plan: the agent writes the steps, and you approve them before anything is changed"
                                : value === "assisted"
                                  ? "Ask first: you approve commands and changes before they run"
                                  : "Auto: the agent runs commands on this terminal without asking, inside the safety rules"
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
    </>
  );
}
