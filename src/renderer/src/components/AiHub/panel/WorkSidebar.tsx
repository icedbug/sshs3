import { MessageSquare, Plus, Terminal } from "lucide-react";
import { modeLabel } from "@shared/modeLabels";
import { selectAiTerminal } from "../../../lib/aiHub";
import { isConversation } from "../workforceModel";
import { ChatOriginBadge } from "../ChatOriginBadge";
import type { PanelState } from "./usePanelState";

/**
 * The full view's sidebar: conversations, agents and recent team activity.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function WorkSidebar({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    mode,
    newChat,
    taskId,
    chooseTask,
    selectedTerminal,
    setConnection,
    setView,
    selectedAgentId,
    setSelectedAgentId,
    setAutonomy,
    act,
    setTaskId,
  } = p;
  return (
    <>
              {mode === "hub" && (
                <aside className="ai-work-sidebar" aria-label="Full view sidebar">
                  <div className="ai-sidebar-section">
                    <div className="ai-sidebar-header">
                      <strong>Conversations</strong>
                      <button
                        className="ai-sidebar-new"
                        onClick={newChat}
                        title="Start a new conversation"
                      >
                        <Plus size={13} /> New
                      </button>
                    </div>
                    <div className="ai-sidebar-list">
                      {!hub.tasks.some(isConversation) && (
                        <small className="ai-hint">No conversations yet.</small>
                      )}
                      {/* A workforce specialist's run is shown in its workforce conversation. */}
                      {[...hub.tasks].filter(isConversation).reverse().map((t) => (
                        <button
                          key={t.id}
                          className="ai-sidebar-item"
                          aria-current={t.id === taskId ? "true" : undefined}
                          onClick={() => chooseTask(t.id)}
                        >
                          <MessageSquare size={13} />
                          <div>
                            <span>
                              {t.title}
                              <ChatOriginBadge task={t} />
                            </span>
                            <small>
                              {t.target?.label ?? "Workspace"} ·{" "}
                              {new Date(t.updatedAt).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </small>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* A section with nothing in it is not shown. */}
                  <div
                    className="ai-sidebar-section"
                    hidden={hub.sessions.every((s) => s.state === "disconnected")}
                  >
                    <div className="ai-sidebar-header">
                      <strong>Active Terminals</strong>
                      <small>{hub.sessions.filter((s) => s.state !== "disconnected").length}</small>
                    </div>
                    <div className="ai-sidebar-list">
                      {hub.sessions.filter((s) => s.state !== "disconnected").length === 0 ? (
                        <small className="ai-hint">No active terminals open.</small>
                      ) : (
                        hub.sessions
                          .filter((s) => s.state !== "disconnected")
                          .map((s) => (
                            <button
                              key={s.id}
                              className="ai-sidebar-item"
                              aria-current={s.id === selectedTerminal ? "true" : undefined}
                              onClick={() => {
                                selectAiTerminal(s.id);
                                setConnection(undefined);
                              }}
                            >
                              <Terminal size={13} />
                              <div>
                                <span>{s.label}</span>
                                <small>
                                  {s.state === "ready"
                                    ? "Connected · Ready"
                                    : s.state === "busy"
                                      ? "Connected · Working"
                                      : "Connected"}
                                </small>
                              </div>
                            </button>
                          ))
                      )}
                    </div>
                  </div>

                  <div className="ai-sidebar-section">
                    <div className="ai-sidebar-header">
                      <strong>Agents</strong>
                      <button
                        className="ai-sidebar-new"
                        onClick={() => setView("Agents & MCP")}
                        title="Manage agents and MCP servers"
                      >
                        Manage
                      </button>
                    </div>
                    <div className="ai-sidebar-list">
                      {(hub.agents ?? []).map((ag) => (
                        <button
                          key={ag.id}
                          className="ai-sidebar-item"
                          aria-current={selectedAgentId === ag.id ? "true" : undefined}
                          onClick={() => {
                            setSelectedAgentId(
                              selectedAgentId === ag.id ? "" : ag.id,
                            );
                            setAutonomy(ag.defaultMode);
                          }}
                        >
                          <span>{ag.icon || ag.name.slice(0, 1).toUpperCase()}</span>
                          <div>
                            <span>{ag.name}</span>
                            <small>
                              {ag.targetCluster || ag.role} · {modeLabel(ag.defaultMode)}
                            </small>
                          </div>
                        </button>
                      ))}
                      <button
                        type="button"
                        className="ai-btn-emerald"
                        style={{ marginTop: 4, fontSize: 11.5, textAlign: "center" }}
                        onClick={() => {
                          const prevIds = new Set(hub.tasks.map((t) => t.id));
                          void act({
                            action: "workforce-run",
                            prompt:
                              "Review our shared servers and clusters: recent team changes, known problems in the knowledge base, and what should be checked next.",
                          }).then((nextSnap) => {
                            const created = nextSnap?.tasks.find(
                              (t) => !prevIds.has(t.id),
                            );
                            if (created?.id) setTaskId(created.id);
                          });
                        }}
                      >
                        Run a workforce review
                      </button>
                    </div>
                  </div>

                  <div
                    className="ai-sidebar-section"
                    hidden={(hub.activityLog ?? []).length === 0}
                  >
                    <div className="ai-sidebar-header">
                      <strong>Recent Team Activity</strong>
                    </div>
                    <div className="ai-sidebar-list">
                      {(hub.activityLog ?? []).slice(0, 4).map((evt) => (
                        <div key={evt.id} className="ai-sidebar-activity">
                          <div className="ai-sidebar-activity-top">
                            <strong>{evt.actor}</strong>
                            <small>{evt.targetLabel}</small>
                          </div>
                          <p>{evt.summary}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </aside>
              )}
    </>
  );
}
