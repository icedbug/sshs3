import { Terminal } from "lucide-react";
import { RichMarkdownContent } from "../RichMarkdownContent";
import { DEMO_SHOWCASE_RESPONSE } from "./panelHelpers";
import type { PanelState } from "./usePanelState";

/**
 * What a new chat shows before anything is said: how to connect a model, the agent that is chosen, and things to try.
 *
 * A piece of the chat panel (AiHubPanel). What it shows is the panel's own state, `p`: see usePanelState.
 */
export function Welcome({ p, hub }: { p: PanelState; hub: NonNullable<PanelState["hub"]> }): JSX.Element {
  const {
    task,
    connection,
    sending,
    aiSetUp,
    act,
    busy,
    connectLocalOllama,
    setSettingsOpen,
    selectedAgentId,
    setSelectedAgentId,
    setAutonomy,
    activeAgent,
    setTaskId,
    setPrompt,
    setShowDemoPreview,
    showDemoPreview,
    copyMessage,
    copiedMsgId,
    stageCommandInTerminal,
    runCodeBlockInTerminal,
    handleOpenFileRef,
  } = p;
  return (
    <>
                {!task && !connection && !sending && (
                  <div className="ai-welcome">
                    <h2>What can I help with?</h2>
                    <p>
                      Pick a <strong>Mission Agent</strong>, or ask about your clusters, VMs, S3 buckets, runbooks and MCP tools.
                    </p>
                    {/* Shown until AI is on and set up, so a failed attempt can be tried again. */}
                    {!aiSetUp && (
                        <article
                          className="ai-card ai-card-active"
                          data-testid="ai-hub-quick-connect-card"
                          style={{ marginBottom: 14, textAlign: "left" }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <strong>Connect your AI</strong>
                            <span className="ai-badge ai-badge-green">
                              {(hub.agents ?? []).length} agent(s) · {(hub.kbDocuments ?? []).length} runbooks
                            </span>
                          </div>
                          <p style={{ fontSize: 11.5, margin: "6px 0 10px" }}>
                            Choose how to connect a model:
                          </p>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            <button
                              type="button"
                              className="ai-btn-emerald"
                              onClick={() =>
                                void act({
                                  action: "configure",
                                  config: {
                                    enabled: true,
                                    provider: "openai-codex",
                                    model: hub.config.codexDefaultModel || "gpt-6.1-sol",
                                    useHermes: false,
                                  },
                                })
                              }
                            >
                              Sign in with ChatGPT / Codex
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void connectLocalOllama()}
                            >
                              Local Ollama (localhost:11434)
                            </button>
                            <button
                              type="button"
                              onClick={() => setSettingsOpen(true)}
                            >
                              Paste an API key (OpenAI / Claude)…
                            </button>
                          </div>
                        </article>
                      )}
                    {(hub.agents ?? []).length > 0 && (
                      <div className="ai-agent-quick-bar" aria-label="Quick select Mission Agent">
                        <button
                          type="button"
                          className={`ai-agent-pill ${!selectedAgentId ? "active" : ""}`}
                          onClick={() => setSelectedAgentId("")}
                        >
                          Assistant
                        </button>
                        {(hub.agents ?? []).map((ag) => (
                          <button
                            key={ag.id}
                            type="button"
                            className={`ai-agent-pill ${selectedAgentId === ag.id ? "active" : ""}`}
                            onClick={() => {
                              setSelectedAgentId(ag.id);
                              setAutonomy(ag.defaultMode);
                            }}
                          >
                            <span>{ag.icon || ag.name.slice(0, 1).toUpperCase()}</span>
                            <span>{ag.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {activeAgent && (
                      <article className="ai-card ai-card-active" style={{ marginBottom: 14 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                          <div>
                            <strong>
                              {activeAgent.icon ? `${activeAgent.icon} ` : ""}{activeAgent.name}
                            </strong>
                            <div>
                              <small>{activeAgent.role}</small>
                            </div>
                          </div>
                          {activeAgent.targetCluster && (
                            <span className="ai-badge ai-badge-cluster">
                              {activeAgent.targetCluster}
                            </span>
                          )}
                        </div>
                        <p style={{ fontSize: 12, margin: "8px 0" }}>
                          <strong>Mission:</strong> {activeAgent.mission}
                        </p>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                          <button
                            type="button"
                            className="ai-btn-emerald"
                            onClick={() => {
                              void act({
                                action: "agent-run-mission",
                                id: activeAgent.id,
                              }).then((nextSnap) => {
                                const started = nextSnap?.reply?.started?.taskId;
                                if (started) setTaskId(started);
                              });
                            }}
                          >
                            Run the mission now
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPrompt(
                                `Carry out your mission for ${activeAgent.targetCluster ? `@cluster:${activeAgent.targetCluster}` : "our infrastructure"}: ${activeAgent.mission}`,
                              )
                            }
                          >
                            Adjust the mission in chat
                          </button>
                        </div>
                      </article>
                    )}
                    <div className="ai-welcome-grid">
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Run a parallel health check across the nodes of my clusters with sshs3_cluster_exec and summarise load, disk, failed services and anything unusual.",
                          )
                        }
                      >
                        <strong>Run across a cluster</strong>
                        <small>Run a command on every node of a cluster and get one report</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Open a 2x2 split-view terminal grid for the nodes of one of my clusters; ask me which cluster if there are several.",
                          )
                        }
                      >
                        <strong>Open a cluster split view</strong>
                        <small>Have the assistant open a split terminal grid or the dual-pane explorer</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Diff a configuration file between two of my servers with sshs3_storage_ops; ask me which file and which servers.",
                          )
                        }
                      >
                        <strong>Compare configuration between servers</strong>
                        <small>Diff configuration files between two nodes, or inspect S3 buckets</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "Search our knowledge base (@kb) for what I describe next, and tell me which runbook applies.",
                          )
                        }
                      >
                        <strong>Search the runbooks</strong>
                        <small>Find the runbook that applies; combine it with data from connected MCP servers</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        data-testid="ai-starter-configure-sshs3"
                        onClick={() =>
                          setPrompt(
                            "Configure sshs3 for me: set up an SSH port-forwarding tunnel (local 5432 -> 127.0.0.1:5432), switch on the performance row in the status bar, and turn on dotfiles sync for ~/.zshrc and ~/.tmux.conf.",
                          )
                        }
                      >
                        <strong>Configure sshS3</strong>
                        <small>Tunnels, S3 profiles, shortcuts, dotfiles, cloud sync and themes</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        data-testid="ai-starter-workforce"
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
                        <strong>Run a workforce review</strong>
                        <small>Your agents investigate at the same time (read-only) and one report combines their findings</small>
                      </button>
                      <button
                        type="button"
                        className="ai-starter-card"
                        onClick={() =>
                          setPrompt(
                            "/plan Write a safe plan with risks, verification steps and rollback for a rolling upgrade of one of my clusters.",
                          )
                        }
                      >
                        <strong>Plan first: /plan</strong>
                        <small>Have a change planned and reviewed before anything runs, or your design questioned</small>
                      </button>
                    </div>
                    {/* The example answer is invented data: shown in the demo lab only. */}
                    <div hidden={!hub.demoMode} style={{ marginTop: "14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="ai-btn-accent"
                        onClick={() => setShowDemoPreview((prev) => !prev)}
                      >
                        {showDemoPreview
                          ? "Hide the example"
                          : "Show an example answer (invented data)"}
                      </button>
                    </div>
                    {showDemoPreview && (
                      <div style={{ marginTop: "14px" }}>
                        <article className="ai-message ai-message-user">
                          <div className="ai-message-header">
                            <span className="ai-message-author">
                              <span className="ai-avatar-badge">Y</span>
                              <span>You</span>
                            </span>
                            <span className="ai-message-meta">Example · @cluster:NetApp-ONTAP-Prod-SE</span>
                          </div>
                          <p>
                            Run a health check across @cluster:NetApp-ONTAP-Prod-SE in parallel and diff /etc/multipath.conf between k8s-storage-cp-01 and k8s-gpu-io-worker-01.
                          </p>
                        </article>
                        <details className="ai-change ai-change-completed" open>
                          <summary>
                            <Terminal size={13} />
                            <span>Ran on 4 nodes of NetApp-ONTAP-Prod-SE in parallel</span>
                            <span className="ai-badge ai-badge-success">done · 4 of 4 nodes · exit 0</span>
                          </summary>
                          <pre>qos statistics volume latency show -iterations 1; snapmirror show</pre>
                          <div className="ai-change-meta">
                            <span className="ai-badge ai-badge-cluster">NetApp-ONTAP-Prod-SE</span>
                            <span className="ai-tool-tag">netapp-aff-a800-01a</span>
                            <span className="ai-tool-tag">netapp-aff-a800-01b</span>
                            <span className="ai-tool-tag">netapp-fas9000-dr-01</span>
                            <span className="ai-tool-tag">ontap-aiq-um-01</span>
                          </div>
                        </details>
                        <article className="ai-message ai-message-assistant">
                          <div className="ai-message-header">
                            <span className="ai-message-author">
                              <span className="ai-avatar-badge">A</span>
                              <span>Assistant</span>
                              <span className="ai-pill">NetApp ONTAP Storage Architect</span>
                            </span>
                            <span className="ai-message-meta">
                              <button
                                type="button"
                                className="ai-code-btn"
                                onClick={() => void copyMessage("demo-showcase", DEMO_SHOWCASE_RESPONSE)}
                              >
                                {copiedMsgId === "demo-showcase" ? "Copied" : "Copy answer"}
                              </button>
                            </span>
                          </div>
                          <RichMarkdownContent
                            text={DEMO_SHOWCASE_RESPONSE}
                            onUseCommand={stageCommandInTerminal}
                      onRunCommand={runCodeBlockInTerminal}
                            onOpenFileRef={handleOpenFileRef}
                          />
                        </article>
                      </div>
                    )}
                  </div>
                )}
    </>
  );
}
