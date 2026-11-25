import { ChevronDown, ShieldCheck, Terminal } from "lucide-react";
import { selectAiTerminal } from "../../../lib/aiHub";
import { composerUsage } from "./panelHelpers";
import { TargetNotice } from "./TargetNotice";
import type { PanelState } from "./usePanelState";

/**
 * The row over the text box: which terminal, what context, which agent, and what the conversation has used.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function ComposerContextRow({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    task,
    menu,
    setMenu,
    terminal,
    setConnection,
    selectedTerminal,
    allMentionOptions,
    setAttachments,
    activeAgent,
    selectedAgentId,
    setSelectedAgentId,
    setAutonomy,
    setView,
    act,
  } = p;
  return (
    <>
                {/* The server the message names, and the one this conversation runs on, when they differ. */}
                <TargetNotice
                  text={p.prompt}
                  target={task?.target?.label ?? terminal?.label}
                  servers={hub.workspaceServers ?? []}
                />
                <div className="ai-context-row">
                  <div className="ai-menu-anchor">
                    <button
                      className="ai-context-chip"
                      aria-label="Chat target"
                      title={
                        task
                          ? (task.target?.label ?? "Context only") +
                            " · fixed for this task"
                          : "Choose terminal context"
                      }
                      aria-expanded={menu === "target"}
                      disabled={!!task}
                      onClick={() =>
                        setMenu(menu === "target" ? null : "target")
                      }
                    >
                      <Terminal size={13} />
                      <span>
                        {task?.target?.label ??
                          terminal?.label ??
                          "Context only"}
                      </span>
                      {task ? (
                        <ShieldCheck size={12} />
                      ) : (
                        <ChevronDown size={12} />
                      )}
                    </button>
                    {menu === "target" && (
                      <div className="ai-popover" aria-label="Choose terminal">
                        <strong>Terminal context</strong>
                        <button
                          onClick={() => {
                            selectAiTerminal("");
                            setConnection(undefined);
                            setMenu(null);
                          }}
                        >
                          Context only
                        </button>
                        {hub.sessions
                          .filter((s) => s.state !== "disconnected")
                          .map((s) => (
                            <button
                              key={s.id}
                              aria-current={
                                s.id === selectedTerminal ? "true" : undefined
                              }
                              onClick={() => {
                                selectAiTerminal(s.id);
                                setConnection(undefined);
                                setMenu(null);
                              }}
                            >
                              {s.label}
                              <small>
                                {s.state === "ready"
                                  ? "Connected · Ready"
                                  : "Connected"}
                              </small>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                  <div className="ai-menu-anchor">
                    <button
                      className="ai-context-chip"
                      aria-label="Add workspace context"
                      title="Attach @server, @team-changes, or @workspace context"
                      aria-expanded={menu === "mention"}
                      onClick={() =>
                        setMenu(menu === "mention" ? null : "mention")
                      }
                    >
                      <span>@ Context</span>
                      <ChevronDown size={11} />
                    </button>
                    {menu === "mention" && (
                      <div
                        className="ai-popover"
                        style={{ right: 0, left: "auto" }}
                        aria-label="Workspace context mentions"
                      >
                        <strong>Attach workspace context</strong>
                        {allMentionOptions.map((opt) => (
                          <button
                            key={opt.label}
                            onClick={() => {
                              setAttachments((old) => [
                                ...old.filter((x) => x.label !== opt.label).slice(-9),
                                {
                                  id: crypto.randomUUID(),
                                  label: opt.label,
                                  text: opt.text,
                                  observedAt: Date.now(),
                                },
                              ]);
                              setMenu(null);
                            }}
                          >
                            {opt.label}
                            <small>{opt.subtitle}</small>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="ai-menu-anchor">
                    <button
                      className={`ai-context-chip ${activeAgent ? "ai-context-chip-active" : ""}`}
                      aria-label="Select Mission Agent"
                      title={
                        activeAgent
                          ? `${activeAgent.name}: ${activeAgent.mission}`
                          : "Choose a specialized Mission Agent or use Default Assistant"
                      }
                      aria-expanded={menu === "agent"}
                      onClick={() =>
                        setMenu(menu === "agent" ? null : "agent")
                      }
                    >
                      <span>
                        {activeAgent
                          ? `${activeAgent.icon ? `${activeAgent.icon} ` : ""}${activeAgent.name}`
                          : "Assistant"}
                      </span>
                      <ChevronDown size={11} />
                    </button>
                    {menu === "agent" && (
                      <div
                        className="ai-popover"
                        style={{ right: 0, left: "auto", minWidth: 250 }}
                        aria-label="Agents"
                      >
                        <strong>Active Mission Agent</strong>
                        <button
                          className={!selectedAgentId ? "active" : ""}
                          onClick={() => {
                            setSelectedAgentId("");
                            setMenu(null);
                          }}
                        >
                          Default SSHS3 Assistant
                          <small>General SSH, S3, cluster & workspace assistant</small>
                        </button>
                        {(hub.agents ?? []).map((ag) => (
                          <button
                            key={ag.id}
                            className={selectedAgentId === ag.id ? "active" : ""}
                            onClick={() => {
                              setSelectedAgentId(ag.id);
                              setAutonomy(ag.defaultMode);
                              setMenu(null);
                            }}
                          >
                            {ag.name}
                            <small>
                              {ag.role}
                              {ag.targetCluster ? ` · ${ag.targetCluster}` : ""}
                            </small>
                          </button>
                        ))}
                        <button
                          onClick={() => {
                            setMenu(null);
                            setView("Agents & MCP");
                          }}
                        >
                          Manage agents…
                          <small>Create custom mission agents & MCP servers</small>
                        </button>
                      </div>
                    )}
                  </div>
                  {(() => {
                    // The same count as the header's, the run going on and the prompt cache included.
                    const used = composerUsage(task);
                    return used ? (
                      <small className="ai-usage" title={used.title}>
                        {used.label}
                      </small>
                    ) : null;
                  })()}
                  {terminal?.owner && (
                    <button
                      className="ai-text-button"
                      onClick={() =>
                        void act({ action: "takeover", sessionId: terminal.id })
                      }
                    >
                      Take control
                    </button>
                  )}
                </div>
    </>
  );
}
