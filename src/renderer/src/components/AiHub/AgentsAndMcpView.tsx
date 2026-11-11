import { useState } from "react";
import {
  type AgentMode,
  type HubSnapshot,
  type InfraGraphEdge,
  type McpCatalogPreset,
  type McpServerConfig,
  type MissionAgent,
  type WorkforceRun,
} from "@shared/types/aiHub";
import { type Act } from "./panelShared";

export function AgentsAndMcpView({
  hub,
  act,
  selectedAgentId,
  onSelectAgentForChat,
  onStartedMission,
}: {
  hub: HubSnapshot;
  act: Act;
  selectedAgentId: string;
  onSelectAgentForChat: (id: string) => void;
  onStartedMission: (newTaskId?: string) => void;
}): JSX.Element {
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState("");
  const [agentMission, setAgentMission] = useState("");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentCluster, setAgentCluster] = useState("");
  const [agentMode, setAgentMode] = useState<AgentMode>("assisted");
  const [agentKbCollections, setAgentKbCollections] = useState("");
  const [showAgentForm, setShowAgentForm] = useState(false);

  const [mcpName, setMcpName] = useState("");
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpCommand, setMcpCommand] = useState("npx");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [showMcpForm, setShowMcpForm] = useState(false);
  const [testingMcpId, setTestingMcpId] = useState("");

  const [workforceObjective, setWorkforceObjective] = useState(
    "Kör koordinerad hälsokontroll över NetApp ONTAP, StorageGRID S3 och K8s Trident CSI",
  );
  const [runningWorkforce, setRunningWorkforce] = useState(false);

  const [edgeSource, setEdgeSource] = useState("K8s-Trident-CSI-Prod");
  const [edgeTarget, setEdgeTarget] = useState("NetApp-ONTAP-Prod-SE");
  const [edgeRel, setEdgeRel] =
    useState<InfraGraphEdge["relation"]>("mounts_storage");
  const [edgeLabel, setEdgeLabel] = useState("");
  const [showEdgeForm, setShowEdgeForm] = useState(false);

  const clusters = Array.from(
    new Set(
      (hub.workspaceServers ?? [])
        .map((s) => s.cluster)
        .filter((c): c is string => Boolean(c)),
    ),
  );

  const totalMcpTools = (hub.mcpServers ?? []).reduce(
    (sum, s) => sum + (s.discoveredTools?.length ?? 0),
    0,
  );

  const installedMcpNames = new Set(
    (hub.mcpServers ?? []).map((s) => s.name.toLowerCase()),
  );

  return (
    <div className="ai-scroll">
      <div className="ai-stat-grid">
        <div className="ai-stat-box">
          <strong>{(hub.agents ?? []).length}</strong>
          <small>🤖 Mission Agents</small>
        </div>
        <div className="ai-stat-box">
          <strong>{(hub.mcpServers ?? []).filter((s) => s.enabled).length}</strong>
          <small>🔌 Active MCP Servers</small>
        </div>
        <div className="ai-stat-box">
          <strong>{totalMcpTools}</strong>
          <small>🛠️ Discovered MCP Tools</small>
        </div>
      </div>

      {/* PILLAR 1: Multi-Agent Workforce Orchestrator (LangGraph Supervisor / OpenAI Swarm) */}
      <article className="ai-card" data-testid="workforce-orchestrator-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div>
            <strong>🤝 AI Workforce Orchestrator (Multi-Agent Swarm)</strong>
            <div style={{ marginTop: 2 }}>
              <small>
                Lead SRE Supervisor delegerar parallella deluppdrag till dina specialiserade Mission Agents och syntetiserar en gemensam åtgärdsplan.
              </small>
            </div>
          </div>
          <span className="ai-badge ai-badge-success">
            {(hub.workforceRuns ?? []).length} körning(ar)
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <input
            style={{ flex: 1, minWidth: 220 }}
            value={workforceObjective}
            onChange={(e) => setWorkforceObjective(e.target.value)}
            placeholder="Beskriv tvärfunktionellt uppdrag för AI Workforce…"
            data-testid="workforce-objective-input"
          />
          <button
            type="button"
            className="ai-btn-emerald"
            disabled={runningWorkforce || !workforceObjective.trim()}
            data-testid="run-workforce-btn"
            onClick={() => {
              setRunningWorkforce(true);
              const prevIds = new Set(hub.tasks.map((t) => t.id));
              void act({
                action: "workforce-run",
                prompt: workforceObjective.trim(),
              })
                .then((nextSnap) => {
                  const created = nextSnap?.tasks.find((t) => !prevIds.has(t.id));
                  if (created) {
                    onStartedMission(created.id);
                  }
                })
                .finally(() => setRunningWorkforce(false));
            }}
          >
            {runningWorkforce
              ? "⏳ Orkestrerar agenter…"
              : "🚀 Kör AI Workforce (Parallella Agenter)"}
          </button>
        </div>

        {(hub.workforceRuns ?? []).slice(0, 2).map((run: WorkforceRun) => (
          <details
            key={run.id}
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(15, 23, 42, 0.55)",
              border: "1px solid rgba(56, 189, 248, 0.2)",
            }}
          >
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: 12 }}>
              ⚡ {run.title} · {run.steps.length} agenter ({run.status})
              {run.simulated ? " · demo, ingen modell anropad" : ""}
            </summary>
            {run.error && (
              <p className="ai-error" style={{ margin: "6px 0 0", fontSize: 12 }}>
                {run.error}
              </p>
            )}
            <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
              {run.steps.map((step) => (
                <div
                  key={step.id}
                  style={{
                    padding: "6px 8px",
                    borderRadius: 6,
                    background: "rgba(30, 41, 59, 0.65)",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <strong>🤖 {step.agentName}</strong>
                    {step.targetCluster && (
                      <span className="ai-badge ai-badge-cluster">
                        🧩 {step.targetCluster}
                      </span>
                    )}
                  </div>
                  <p style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>
                    {step.status === "queued"
                      ? "Väntar…"
                      : step.status === "running"
                        ? "Undersöker…"
                        : step.status === "failed"
                          ? `Misslyckades: ${step.error ?? "okänt fel"}`
                          : step.findings}
                  </p>
                  {step.recommendedCommands?.[0] && (
                    <code style={{ display: "block", fontSize: 11, opacity: 0.9 }}>
                      $ {step.recommendedCommands[0]}
                    </code>
                  )}
                </div>
              ))}
            </div>
          </details>
        ))}
      </article>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2>🤖 Mission Agents ({(hub.agents ?? []).length})</h2>
        <button className="ai-btn-accent" onClick={() => setShowAgentForm((v) => !v)}>
          {showAgentForm ? "Close Form" : "+ New Mission Agent"}
        </button>
      </div>
      <p className="ai-hint">
        Configure specialized AI agents with their own mission, system prompt, target cluster, KB collections, and MCP tools. Select an agent in chat or launch its mission directly.
      </p>

      {showAgentForm && (
        <form
          className="ai-form ai-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!agentName.trim() || !agentMission.trim()) return;
            void act({
              action: "agent-save",
              agent: {
                name: agentName.trim(),
                role: agentRole.trim() || "Storage & Infrastructure Specialist",
                mission: agentMission.trim(),
                systemPrompt:
                  agentPrompt.trim() ||
                  `You are ${agentName.trim()}. Focus on mission: ${agentMission.trim()}`,
                targetCluster: agentCluster || undefined,
                defaultMode: agentMode,
                kbCollectionIds: agentKbCollections
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
                mcpServerIds: (hub.mcpServers ?? [])
                  .filter((m) => m.enabled)
                  .map((m) => m.id),
                enabled: true,
              },
            }).then(() => {
              setAgentName("");
              setAgentRole("");
              setAgentMission("");
              setAgentPrompt("");
              setShowAgentForm(false);
            });
          }}
        >
          <strong>Create Mission Agent</strong>
          <label>
            Agent Name
            <input
              required
              placeholder="e.g. NetApp MetroCluster Failover Auditor"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
          </label>
          <label>
            Role / Title
            <input
              placeholder="e.g. Principal ONTAP Availability Engineer"
              value={agentRole}
              onChange={(e) => setAgentRole(e.target.value)}
            />
          </label>
          <label>
            Mission (Uppdrag)
            <textarea
              required
              placeholder="e.g. Audit SnapMirror lag, aggregate capacity, and LIF failover policies across the cluster and propose remediations."
              value={agentMission}
              onChange={(e) => setAgentMission(e.target.value)}
            />
          </label>
          <label>
            System Instructions
            <textarea
              placeholder="Detailed runbook instructions, preferred CLI syntax, and safety rules…"
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
            />
          </label>
          <label>
            Target Cluster (optional)
            <select
              value={agentCluster}
              onChange={(e) => setAgentCluster(e.target.value)}
            >
              <option value="">All clusters / active terminal</option>
              {clusters.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            Default Control Mode
            <select
              value={agentMode}
              onChange={(e) => setAgentMode(e.target.value as AgentMode)}
            >
              <option value="plan">Plan only (read-only analysis)</option>
              <option value="assisted">Assisted (approve commands first)</option>
              <option value="autonomous">Autonomous (execute immediately)</option>
            </select>
          </label>
          <label>
            KB Collections (comma-separated, e.g. netapp-ontap, storagegrid)
            <input
              placeholder="netapp-ontap, storagegrid, ceph"
              value={agentKbCollections}
              onChange={(e) => setAgentKbCollections(e.target.value)}
            />
          </label>
          <button type="submit">Save Mission Agent</button>
        </form>
      )}

      {(hub.agents ?? []).map((ag: MissionAgent) => (
        <article
          className={`ai-card ${selectedAgentId === ag.id ? "ai-card-active" : ""}`}
          key={ag.id}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div>
              <strong>
                {ag.icon || "🤖"} {ag.name}
              </strong>
              <div style={{ marginTop: 2 }}>
                <small>{ag.role}</small>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" }}>
              {selectedAgentId === ag.id && (
                <span className="ai-pill">Active in Chat</span>
              )}
              <span className="ai-badge ai-badge-mode">{ag.defaultMode}</span>
              {ag.targetCluster && (
                <span className="ai-badge ai-badge-cluster">
                  🧩 {ag.targetCluster}
                </span>
              )}
            </div>
          </div>
          <p style={{ marginTop: 8 }}>
            <strong>Uppdrag:</strong> {ag.mission}
          </p>
          {((ag.kbCollectionIds ?? ag.kbDocIds ?? []).length > 0 ||
            (ag.mcpServerIds ?? []).length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
              {(ag.kbCollectionIds ?? ag.kbDocIds ?? []).map((kb) => (
                <span key={kb} className="ai-tool-tag">
                  📚 {kb}
                </span>
              ))}
              {(ag.mcpServerIds ?? []).map((mcpId) => {
                const srv = (hub.mcpServers ?? []).find((m) => m.id === mcpId);
                return (
                  <span key={mcpId} className="ai-tool-tag">
                    🔌 {srv?.name || mcpId}
                  </span>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
            <button
              className="ai-btn-accent"
              onClick={() => onSelectAgentForChat(ag.id)}
            >
              💬 Use in Chat
            </button>
            <button
              type="button"
              onClick={() => {
                const activeTaskId = hub.tasks[0]?.id;
                if (activeTaskId) {
                  void act({
                    action: "agent-handoff",
                    taskId: activeTaskId,
                    toAgentId: ag.id,
                    reason: `Swarm handoff till ${ag.name}`,
                  });
                }
                onSelectAgentForChat(ag.id);
              }}
            >
              🤝 Swarm Handoff
            </button>
            <button
              className="ai-btn-emerald"
              onClick={() => {
                const prevIds = new Set(hub.tasks.map((t) => t.id));
                void act({
                  action: "agent-run-mission",
                  id: ag.id,
                }).then((nextSnap) => {
                  const created = nextSnap?.tasks.find((t) => !prevIds.has(t.id));
                  onStartedMission(created?.id ?? nextSnap?.tasks[0]?.id);
                });
              }}
            >
              🚀 Run Mission Now
            </button>
            <button
              className="ai-btn-danger"
              onClick={() =>
                void act({ action: "agent-delete", id: ag.id })
              }
            >
              Delete
            </button>
          </div>
        </article>
      ))}

      <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #2a3140)", margin: "18px 0" }} />

      {/* PILLAR 5: 1-Click Open-Source MCP Marketplace */}
      <h2>🛒 1-Click Open-Source MCP Marketplace ({(hub.mcpCatalog ?? []).length})</h2>
      <p className="ai-hint">
        Installera färdigkonfigurerade Open-Source MCP-servrar (Prometheus, Grafana/Loki, Kubernetes/Helm, PostgreSQL, Terraform, GitHub) med ett klick.
      </p>
      <div
        data-testid="mcp-marketplace-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: 8,
          marginBottom: 16,
        }}
      >
        {(hub.mcpCatalog ?? []).map((preset: McpCatalogPreset) => {
          const isInstalled = installedMcpNames.has(preset.name.toLowerCase());
          return (
            <article
              key={preset.id}
              className="ai-card"
              style={{ margin: 0, display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 6 }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <strong>
                    {preset.icon} {preset.name}
                  </strong>
                  <span className="ai-badge ai-badge-mode">{preset.category}</span>
                </div>
                <p style={{ fontSize: 12, margin: "6px 0", opacity: 0.9 }}>
                  {preset.description}
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                  {preset.defaultTools.map((t) => (
                    <span key={t.name} className="ai-tool-tag" title={t.description}>
                      🛠️ {t.name}
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className={isInstalled ? "" : "ai-btn-emerald"}
                disabled={isInstalled}
                data-testid={`mcp-install-${preset.id}`}
                onClick={() =>
                  void act({
                    action: "mcp-install-preset",
                    presetId: preset.id,
                  })
                }
              >
                {isInstalled ? "✅ Installerad" : "⚡ 1-Klick Installera"}
              </button>
            </article>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h2>🔌 Installed MCP Servers ({(hub.mcpServers ?? []).length})</h2>
        <button onClick={() => setShowMcpForm((v) => !v)}>
          {showMcpForm ? "Close Form" : "+ Custom MCP Server"}
        </button>
      </div>
      <p className="ai-hint">
        Connect external Model Context Protocol (MCP) servers over local <code>stdio</code> or remote <code>HTTP / JSON-RPC</code>. Discovered tools are automatically exposed to the AI as <code>mcp__&lt;server&gt;__&lt;tool&gt;</code>.
      </p>

      {showMcpForm && (
        <form
          className="ai-form ai-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mcpName.trim()) return;
            void act({
              action: "mcp-save",
              server: {
                name: mcpName.trim(),
                transport: mcpTransport,
                command: mcpTransport === "stdio" ? mcpCommand.trim() : undefined,
                args:
                  mcpTransport === "stdio"
                    ? mcpArgs
                        .split(/\s+/)
                        .map((x) => x.trim())
                        .filter(Boolean)
                    : undefined,
                url: mcpTransport === "http" ? mcpUrl.trim() : undefined,
                enabled: true,
              },
            }).then(() => {
              setMcpName("");
              setMcpArgs("");
              setMcpUrl("");
              setShowMcpForm(false);
            });
          }}
        >
          <strong>Add MCP Server</strong>
          <label>
            Server Name
            <input
              required
              placeholder="e.g. NetApp Harvest & Prometheus MCP"
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
            />
          </label>
          <label>
            Transport
            <select
              value={mcpTransport}
              onChange={(e) =>
                setMcpTransport(e.target.value as "stdio" | "http")
              }
            >
              <option value="stdio">Local Process (stdio JSON-RPC)</option>
              <option value="http">Remote HTTP / JSON-RPC Endpoint</option>
            </select>
          </label>
          {mcpTransport === "stdio" ? (
            <>
              <label>
                Command
                <input
                  required
                  placeholder="npx or node or python"
                  value={mcpCommand}
                  onChange={(e) => setMcpCommand(e.target.value)}
                />
              </label>
              <label>
                Arguments (space-separated)
                <input
                  placeholder="-y @modelcontextprotocol/server-filesystem /etc"
                  value={mcpArgs}
                  onChange={(e) => setMcpArgs(e.target.value)}
                />
              </label>
            </>
          ) : (
            <label>
              HTTP JSON-RPC Endpoint URL
              <input
                required
                placeholder="https://mcp.internal.example.com/rpc"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
              />
            </label>
          )}
          <button type="submit">Save & Discover Tools</button>
        </form>
      )}

      {(hub.mcpServers ?? []).map((srv: McpServerConfig) => (
        <article className="ai-card" key={srv.id}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <strong>🔌 {srv.name}</strong>
            <span
              className={`ai-badge ${
                srv.status === "connected" ? "ai-badge-success" : ""
              }`}
            >
              {srv.status === "connected" ? "🟢 " : ""}
              {srv.transport.toUpperCase()} ·{" "}
              {srv.status ?? (srv.enabled ? "configured" : "disabled")}
            </span>
          </div>
          <small style={{ display: "block", marginTop: 4, fontFamily: "monospace" }}>
            {srv.transport === "stdio"
              ? `${srv.command ?? ""} ${(srv.args ?? []).join(" ")}`
              : srv.url}
          </small>
          {srv.lastError && (
            <p className="ai-error" style={{ marginTop: 6 }}>
              {srv.lastError}
            </p>
          )}
          {(srv.discoveredTools ?? []).length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
              {srv.discoveredTools!.map((t) => (
                <span
                  key={t.name}
                  className="ai-tool-tag"
                  title={t.description}
                >
                  🛠️ {t.name}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
            <button
              className="ai-btn-accent"
              disabled={testingMcpId === srv.id}
              onClick={() => {
                setTestingMcpId(srv.id);
                void act({ action: "mcp-test", id: srv.id }).finally(() =>
                  setTestingMcpId(""),
                );
              }}
            >
              {testingMcpId === srv.id ? "Testing…" : "🔍 Test & Discover Tools"}
            </button>
            <button
              onClick={() =>
                void act({
                  action: "mcp-save",
                  server: { ...srv, enabled: !srv.enabled },
                })
              }
            >
              {srv.enabled ? "Disable" : "Enable"}
            </button>
            <button
              className="ai-btn-danger"
              onClick={() => void act({ action: "mcp-delete", id: srv.id })}
            >
              Delete
            </button>
          </div>
        </article>
      ))}

      <hr style={{ border: "none", borderTop: "1px solid var(--border-subtle, #2a3140)", margin: "18px 0" }} />

      {/* PILLAR 2B: Temporal Infrastructure & Storage Dependency Graph (Zep / Graphiti) */}
      <article className="ai-card" data-testid="infra-dependency-graph-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <strong>🕸️ Service & Storage Dependency Graph ({(hub.infraEdges ?? []).length})</strong>
          <button type="button" onClick={() => setShowEdgeForm((v) => !v)}>
            {showEdgeForm ? "Close" : "+ Add Dependency Link"}
          </button>
        </div>
        <small style={{ display: "block", marginTop: 4 }}>
          Temporala beroendelänkar mellan kluster, noder och lagring som injiceras automatiskt i AI-kontexten vid rotorsaksanalys.
        </small>
        {showEdgeForm && (
          <form
            className="ai-form"
            style={{ marginTop: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!edgeSource.trim() || !edgeTarget.trim()) return;
              void act({
                action: "infra-edge-save",
                edge: {
                  from: edgeSource.trim(),
                  to: edgeTarget.trim(),
                  relation: edgeRel,
                  label:
                    edgeLabel.trim() ||
                    `${edgeSource.trim()} → ${edgeRel} → ${edgeTarget.trim()}`,
                },
              }).then(() => {
                setEdgeLabel("");
                setShowEdgeForm(false);
              });
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              <input
                value={edgeSource}
                onChange={(e) => setEdgeSource(e.target.value)}
                placeholder="Source (e.g. K8s-Trident-CSI-Prod)"
              />
              <select
                value={edgeRel}
                onChange={(e) =>
                  setEdgeRel(e.target.value as InfraGraphEdge["relation"])
                }
              >
                <option value="mounts_storage">mounts_storage</option>
                <option value="replicates_to">replicates_to</option>
                <option value="depends_on">depends_on</option>
                <option value="routes_to">routes_to</option>
                <option value="monitors">monitors</option>
                <option value="ssh_tunnel">ssh_tunnel</option>
              </select>
              <input
                value={edgeTarget}
                onChange={(e) => setEdgeTarget(e.target.value)}
                placeholder="Target (e.g. NetApp-ONTAP-Prod-SE)"
              />
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input
                style={{ flex: 1 }}
                value={edgeLabel}
                onChange={(e) => setEdgeLabel(e.target.value)}
                placeholder="Beskrivning (valfritt, t.ex. SnapMirror XDP lag < 5 min)"
              />
              <button type="submit">Save Link</button>
            </div>
          </form>
        )}
        <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
          {(hub.infraEdges ?? []).map((edge: InfraGraphEdge) => (
            <div
              key={edge.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                borderRadius: 6,
                background: "rgba(30, 41, 59, 0.55)",
                fontSize: 12,
              }}
            >
              <div>
                <strong>{edge.from}</strong>{" "}
                <span className="ai-badge ai-badge-mode">{edge.relation}</span>{" "}
                <strong>{edge.to}</strong>
                <div style={{ fontSize: 11, opacity: 0.8 }}>{edge.label}</div>
              </div>
              <button
                type="button"
                aria-label="Delete dependency link"
                onClick={() =>
                  void act({ action: "infra-edge-delete", id: edge.id })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </article>

      {/* PILLAR 4: AST Shell Command Safety Guardrails */}
      <article className="ai-card" data-testid="safety-policy-card">
        <strong>🛡️ AST Shell Command Safety Guardrails</strong>
        <small style={{ display: "block", marginTop: 4, marginBottom: 8 }}>
          Klassificerar automatiskt pipelines (<code>|</code>), kedjor (<code>&amp;&amp;</code>) och subshells i{" "}
          <span className="ai-badge ai-badge-success">🟢 Safe Read-Only</span>,{" "}
          <span className="ai-badge ai-badge-mode">🟡 State-Modifying</span> och{" "}
          <span className="ai-badge ai-badge-danger">🔴 Destructive</span>.
        </small>
        <div style={{ display: "grid", gap: 6, fontSize: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={hub.safetyPolicy?.autoApproveSafeReadOnly ?? true}
              onChange={(e) =>
                void act({
                  action: "safety-policy-save",
                  policy: {
                    autoApproveSafeReadOnly: e.target.checked,
                    requireApprovalOnProdTags:
                      hub.safetyPolicy?.requireApprovalOnProdTags ?? true,
                    blockDestructiveWithoutConfirm:
                      hub.safetyPolicy?.blockDestructiveWithoutConfirm ?? true,
                  },
                })
              }
            />
            <span>Auto-godkänn 🟢 Safe Read-Only diagnostikkommandon</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={hub.safetyPolicy?.requireApprovalOnProdTags ?? true}
              onChange={(e) =>
                void act({
                  action: "safety-policy-save",
                  policy: {
                    autoApproveSafeReadOnly:
                      hub.safetyPolicy?.autoApproveSafeReadOnly ?? true,
                    requireApprovalOnProdTags: e.target.checked,
                    blockDestructiveWithoutConfirm:
                      hub.safetyPolicy?.blockDestructiveWithoutConfirm ?? true,
                  },
                })
              }
            />
            <span>Kräv manuellt godkännande vid förändringar på produktionsnoder (🟡 Modify)</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={hub.safetyPolicy?.blockDestructiveWithoutConfirm ?? true}
              onChange={(e) =>
                void act({
                  action: "safety-policy-save",
                  policy: {
                    autoApproveSafeReadOnly:
                      hub.safetyPolicy?.autoApproveSafeReadOnly ?? true,
                    requireApprovalOnProdTags:
                      hub.safetyPolicy?.requireApprovalOnProdTags ?? true,
                    blockDestructiveWithoutConfirm: e.target.checked,
                  },
                })
              }
            />
            <span>Spärra 🔴 Destructive kommandon utan explicit granskning</span>
          </label>
        </div>
      </article>
    </div>
  );
}
