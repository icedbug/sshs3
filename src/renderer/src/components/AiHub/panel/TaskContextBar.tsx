import { GitFork } from "lucide-react";
import type { PanelState } from "./usePanelState";

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
                      <span
                        className="ai-badge ai-badge-success"
                        title="Command safety checks apply to every command in this conversation"
                      >
                        Safety checks on
                      </span>
                      <button
                        type="button"
                        className="ai-mini-btn"
                        data-testid="ai-task-fork-btn"
                        disabled={busy}
                        title="Fork this conversation into a new branch"
                        onClick={() => void handleForkTask()}
                      >
                        <GitFork size={11} />
                        Fork
                      </button>
                      <button
                        type="button"
                        className="ai-mini-btn"
                        data-testid="ai-task-compact-btn"
                        disabled={busy || task.messages.length === 0}
                        title="Compact older messages to save context tokens"
                        onClick={() => void handleCompactTask()}
                      >
                        Compact
                      </button>
                      {task.changes.some(
                        (c) => c.status === "pending" && c.riskLevel === "safe",
                      ) && (
                        <button
                          type="button"
                          className="ai-btn-emerald"
                          style={{ padding: "2px 8px", fontSize: 10.5 }}
                          disabled={busy}
                          onClick={() => {
                            const safePending = task.changes.filter(
                              (c) =>
                                c.status === "pending" && c.riskLevel === "safe",
                            );
                            for (const c of safePending) {
                              void act({
                                action: "approve",
                                taskId: task.id,
                                changeId: c.id,
                                approved: true,
                              });
                            }
                          }}
                        >
                          Approve all read-only (
                          {
                            task.changes.filter(
                              (c) =>
                                c.status === "pending" && c.riskLevel === "safe",
                            ).length
                          }
                          )
                        </button>
                      )}
                    </div>
                    {(hub.agents ?? []).length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <small>Hand over:</small>
                        <select
                          aria-label="Swarm Handoff to specialist agent"
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
