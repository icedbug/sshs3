import { GitFork } from "lucide-react";
import type { PanelState } from "./usePanelState";
import { ChatOriginBadge } from "../ChatOriginBadge";

/**
 * The bar over a conversation: its target, mode, budget and what waits in it.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function TaskContextBar({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    task,
    activeAgent,
    busy,
    handleForkTask,
    handleCompactTask,
    act,
    selectedAgentId,
    setSelectedAgentId,
  } = p;
  return (
    <>
                {task && (
                  <div
                    className="ai-task-context-bar"
                    data-testid="ai-task-context-bar"
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span className="ai-badge ai-badge-purple">
                        {activeAgent?.icon ? `${activeAgent.icon} ` : ""}
                        {task.agentName || activeAgent?.name || "Assistant"}
                      </span>
                      <ChatOriginBadge task={task} />
                      <button
                        type="button"
                        className="ai-mini-btn"
                        data-testid="ai-task-fork-btn"
                        disabled={busy}
                        title="Start a new conversation from a copy of this one. This one stays as it is."
                        onClick={() => void handleForkTask()}
                      >
                        <GitFork size={11} />
                        Branch off
                      </button>
                      <button
                        type="button"
                        className="ai-mini-btn"
                        data-testid="ai-task-compact-btn"
                        disabled={busy || task.messages.length === 0}
                        title="Replace the older messages with a short summary, so the model has room for more"
                        onClick={() => void handleCompactTask()}
                      >
                        Shorten
                      </button>
                    </div>
                    {hub.demoMode && task.id.startsWith("demo-task-") && (
                      <small className="ai-hint" data-testid="demo-example-note">
                        Demo lab: this conversation is an invented example. Nothing in it was run.
                      </small>
                    )}
                    {(hub.agents ?? []).length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <small>Give to another agent:</small>
                        <select
                          aria-label="Give this conversation to another agent"
                          data-testid="chat-swarm-handoff-select"
                          style={{ padding: "2px 6px", fontSize: 11 }}
                          value={task.agentId || selectedAgentId || ""}
                          onChange={(e) => {
                            const nextAgentId = e.target.value;
                            if (!nextAgentId) return;
                            setSelectedAgentId(nextAgentId);
                            void act({
                              action: "agent-handoff",
                              taskId: task.id,
                              toAgentId: nextAgentId,
                              reason: "Handed over from the conversation",
                            });
                          }}
                        >
                          <option value="">Choose an agent…</option>
                          {(hub.agents ?? []).map((ag) => (
                            <option key={ag.id} value={ag.id}>
                              {ag.icon ? `${ag.icon} ` : ""}{ag.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                )}
    </>
  );
}
