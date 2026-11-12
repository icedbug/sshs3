import { useState } from "react";
import {
  type AgentMode,
  type HubSnapshot,
  type McpCatalogPreset,
  type McpServerConfig,
  type MissionAgent,
  type WorkforceRun,
} from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import { type Act, modes } from "./panelShared";

interface AgentDraft {
  id?: string;
  name: string;
  role: string;
  mission: string;
  systemPrompt: string;
  targetCluster: string;
  defaultMode: AgentMode;
  kbDocIds: string[];
  mcpServerIds: string[];
  runnerId: string;
}

const emptyAgent: AgentDraft = {
  name: "",
  role: "",
  mission: "",
  systemPrompt: "",
  targetCluster: "",
  defaultMode: "assisted",
  kbDocIds: [],
  mcpServerIds: [],
  runnerId: "",
};

const toggled = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

const commandLine = (srv: { transport: string; command?: string; args?: string[]; url?: string }): string =>
  srv.transport === "stdio"
    ? `${srv.command ?? ""} ${(srv.args ?? []).join(" ")}`.trim()
    : (srv.url ?? "");

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
  const [draft, setDraft] = useState<AgentDraft | undefined>();
  const [objective, setObjective] = useState("");
  const [runningWorkforce, setRunningWorkforce] = useState(false);

  const [mcpDraft, setMcpDraft] = useState<
    | { id?: string; name: string; transport: "stdio" | "http"; command: string; args: string; url: string; needs?: string }
    | undefined
  >();
  const [testingMcpId, setTestingMcpId] = useState("");
  const [runnerDraft, setRunnerDraft] = useState<
    { id: string; name: string; command: string; args: string; cwd: string; note?: string; existing?: boolean } | undefined
  >();
  const runners = hub.externalRunners ?? [];
  const runnerPresets = (hub.externalRunnerPresets ?? []).filter((p) => !runners.some((r) => r.id === p.id));
  const runnerName = (id: string): string =>
    runners.find((r) => r.id === id)?.name ?? hub.externalRunnerPresets?.find((p) => p.id === id)?.name ?? id;

  const agents = hub.agents ?? [];
  const servers = hub.mcpServers ?? [];
  const docs = hub.kbDocuments ?? [];
  const clusters = Array.from(
    new Set(
      (hub.workspaceServers ?? [])
        .map((s) => s.cluster)
        .filter((c): c is string => Boolean(c)),
    ),
  );
  const installedIds = new Set(servers.map((s) => s.id));
  const presets = (hub.mcpCatalog ?? []).filter((p) => !installedIds.has(p.id));

  const startMission = (request: Parameters<Act>[0]): Promise<void> => {
    const before = new Set(hub.tasks.map((t) => t.id));
    return act(request).then((next) => {
      const created = next?.tasks.find((t) => !before.has(t.id));
      if (created) onStartedMission(created.id);
    });
  };

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Agents &amp; MCP</h2>
        <p className="ai-hint">
          An agent is the assistant with a standing mission, its own instructions and the runbooks and tools it should
          use. MCP servers give every agent more tools.
        </p>
      </header>

      <div className="ai-section-head">
        <h3>
          Mission agents <span className="ai-count">{agents.length}</span>
        </h3>
        <button
          type="button"
          className="ai-btn-accent"
          onClick={() => setDraft(draft ? undefined : { ...emptyAgent })}
        >
          {draft ? "Close" : "New agent"}
        </button>
      </div>

      {draft && (
        <form
          className="ai-form ai-card"
          data-testid="agent-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.name.trim() || !draft.mission.trim()) return;
            const existing = agents.find((a) => a.id === draft.id);
            void act({
              action: "agent-save",
              agent: {
                ...existing,
                id: draft.id,
                name: draft.name.trim(),
                role: draft.role.trim(),
                mission: draft.mission.trim(),
                systemPrompt: draft.systemPrompt.trim(),
                targetCluster: draft.targetCluster || undefined,
                defaultMode: draft.defaultMode,
                kbDocIds: draft.kbDocIds,
                mcpServerIds: draft.mcpServerIds,
                runnerId: draft.runnerId || undefined,
              },
            }).then((next) => {
              if (next) setDraft(undefined);
            });
          }}
        >
          <strong>{draft.id ? "Edit agent" : "New agent"}</strong>
          <label>
            Name
            <input
              required
              autoFocus
              placeholder="Storage capacity reviewer"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label>
            Speciality
            <input
              placeholder="What it knows best, in a few words"
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value })}
            />
          </label>
          <label>
            Mission
            <textarea
              required
              placeholder="What it does when you press Run mission: what to check, where, and what to report."
              value={draft.mission}
              onChange={(e) => setDraft({ ...draft, mission: e.target.value })}
            />
          </label>
          <label>
            Instructions (optional)
            <textarea
              placeholder="How it should work: conventions, commands to prefer or avoid, what always needs a second look."
              value={draft.systemPrompt}
              onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            />
          </label>
          <label>
            Runs on
            <select
              data-testid="agent-runner-select"
              value={draft.runnerId}
              onChange={(e) => setDraft({ ...draft, runnerId: e.target.value })}
            >
              <option value="">sshS3&apos;s assistant, on your model</option>
              {runners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} (external agent)
                </option>
              ))}
              {runnerPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (external agent, not set up on this computer)
                </option>
              ))}
              {draft.runnerId &&
                !runners.some((r) => r.id === draft.runnerId) &&
                !runnerPresets.some((p) => p.id === draft.runnerId) && (
                  <option value={draft.runnerId}>{draft.runnerId} (not set up on this computer)</option>
                )}
            </select>
            {draft.runnerId && (
              <small>
                An external agent works in its own folder with its own tools and model. sshS3&apos;s runbooks, MCP
                servers and terminals are not given to it; what it asks permission for is judged by your safety
                settings.
              </small>
            )}
          </label>
          <div className="ai-form-row">
            <label>
              Cluster
              <select
                value={draft.targetCluster}
                onChange={(e) => setDraft({ ...draft, targetCluster: e.target.value })}
              >
                <option value="">Any — works where you point it</option>
                {clusters.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Commands
              <select
                value={draft.defaultMode}
                onChange={(e) => setDraft({ ...draft, defaultMode: e.target.value as AgentMode })}
              >
                <option value="advice">Never runs commands — advises only</option>
                <option value="assisted">Asks before each command</option>
                <option value="autonomous">Runs commands on its own</option>
              </select>
            </label>
          </div>
          {(hub.kbPages ?? []).length > 0 && (
            <fieldset className="ai-checks" data-testid="agent-pages">
              <legend>Knowledge base pages it always has at hand (every agent can open any page; these are given in full)</legend>
              {(hub.kbPages ?? []).map((p) => (
                <label key={p.id}>
                  <input
                    type="checkbox"
                    checked={draft.kbDocIds.includes(p.id)}
                    onChange={() => setDraft({ ...draft, kbDocIds: toggled(draft.kbDocIds, p.id) })}
                  />
                  <span>{p.title}</span>
                </label>
              ))}
            </fieldset>
          )}
          {docs.length > 0 && (
            <fieldset className="ai-checks">
              <legend>Sources it always has at hand</legend>
              {docs.map((d) => (
                <label key={d.id}>
                  <input
                    type="checkbox"
                    checked={draft.kbDocIds.includes(d.id)}
                    onChange={() => setDraft({ ...draft, kbDocIds: toggled(draft.kbDocIds, d.id) })}
                  />
                  <span>{d.title}</span>
                </label>
              ))}
            </fieldset>
          )}
          {servers.length > 0 && (
            <fieldset className="ai-checks">
              <legend>MCP servers it may use (none ticked means all enabled servers)</legend>
              {servers.map((m) => (
                <label key={m.id}>
                  <input
                    type="checkbox"
                    checked={draft.mcpServerIds.includes(m.id)}
                    onChange={() =>
                      setDraft({ ...draft, mcpServerIds: toggled(draft.mcpServerIds, m.id) })
                    }
                  />
                  <span>{m.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              {draft.id ? "Save changes" : "Create agent"}
            </button>
            <button type="button" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {agents.length === 0 && !draft && (
        <p className="ai-empty">
          No agents yet. The assistant works without one; create an agent for work you hand out the same way every
          time.
        </p>
      )}

      {agents.map((ag: MissionAgent) => {
        const boundDocs = (ag.kbDocIds ?? [])
          .map((id) => docs.find((d) => d.id === id)?.title ?? (hub.kbPages ?? []).find((p) => p.id === id)?.title)
          .filter((t): t is string => Boolean(t));
        const boundServers = (ag.mcpServerIds ?? [])
          .map((id) => servers.find((m) => m.id === id)?.name)
          .filter((t): t is string => Boolean(t));
        return (
          <article
            className={`ai-card ${selectedAgentId === ag.id ? "ai-card-active" : ""}`}
            key={ag.id}
            data-testid={`agent-card-${ag.id}`}
          >
            <div className="ai-card-head">
              <div>
                <strong>
                  {ag.icon ? `${ag.icon} ` : ""}
                  {ag.name}
                </strong>
                <small>{ag.role}</small>
              </div>
              <div className="ai-tags">
                {ag.runnerId && (
                  <span
                    className={`ai-badge ${runners.some((r) => r.id === ag.runnerId) ? "ai-badge-purple" : "ai-badge-danger"}`}
                    title={
                      runners.some((r) => r.id === ag.runnerId)
                        ? "Runs on an external coding agent"
                        : "This external agent is not set up on this computer"
                    }
                  >
                    {runnerName(ag.runnerId)}
                    {runners.some((r) => r.id === ag.runnerId) ? "" : " · not set up here"}
                  </span>
                )}
                {selectedAgentId === ag.id && <span className="ai-pill">In chat</span>}
                <span className="ai-badge ai-badge-mode">{modes[ag.defaultMode] ?? ag.defaultMode}</span>
                {ag.targetCluster && <span className="ai-badge ai-badge-cluster">{ag.targetCluster}</span>}
              </div>
            </div>
            <p>{ag.mission}</p>
            {(boundDocs.length > 0 || boundServers.length > 0) && (
              <div className="ai-tags">
                {boundDocs.map((t) => (
                  <span key={`d-${t}`} className="ai-tool-tag" title="Runbook it always has at hand">
                    {t}
                  </span>
                ))}
                {boundServers.map((t) => (
                  <span key={`m-${t}`} className="ai-tool-tag" title="MCP server it may use">
                    MCP · {t}
                  </span>
                ))}
              </div>
            )}
            <div className="ai-card-actions">
              <button
                type="button"
                className="ai-btn-emerald"
                onClick={() => void startMission({ action: "agent-run-mission", id: ag.id })}
              >
                Run mission
              </button>
              <button type="button" className="ai-btn-accent" onClick={() => onSelectAgentForChat(ag.id)}>
                Chat with it
              </button>
              <button
                type="button"
                onClick={() =>
                  setDraft({
                    id: ag.id,
                    name: ag.name,
                    role: ag.role,
                    mission: ag.mission,
                    systemPrompt: ag.systemPrompt,
                    targetCluster: ag.targetCluster ?? "",
                    defaultMode: ag.defaultMode,
                    kbDocIds: ag.kbDocIds ?? [],
                    mcpServerIds: ag.mcpServerIds ?? [],
                    runnerId: ag.runnerId ?? "",
                  })
                }
              >
                Edit
              </button>
              <span className="ai-spacer" />
              <ConfirmButton
                label="Delete"
                confirmLabel="Delete this agent?"
                onConfirm={() => void act({ action: "agent-delete", id: ag.id })}
              />
            </div>
          </article>
        );
      })}

      <article className="ai-card" data-testid="workforce-orchestrator-card">
        <div className="ai-card-head">
          <div>
            <strong>Workforce review</strong>
            <small>
              Every agent looks into the same question in its own read-only run, and one more run combines what they
              found. Nothing is executed.
            </small>
          </div>
        </div>
        <div className="ai-inline-form">
          <input
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="What should they look into? e.g. what changed on the storage clusters this week, and what should we check next"
            data-testid="workforce-objective-input"
          />
          <button
            type="button"
            className="ai-btn-emerald"
            disabled={runningWorkforce || !objective.trim()}
            data-testid="run-workforce-btn"
            onClick={() => {
              setRunningWorkforce(true);
              void startMission({ action: "workforce-run", prompt: objective.trim() }).finally(() =>
                setRunningWorkforce(false),
              );
            }}
          >
            {runningWorkforce ? "Running…" : "Run review"}
          </button>
        </div>

        {(hub.workforceRuns ?? []).slice(0, 3).map((run: WorkforceRun) => (
          <details key={run.id} className="ai-fold ai-run">
            <summary>
              {run.title}
              <span className={`ai-badge ${run.status === "completed" ? "ai-badge-success" : run.status === "failed" ? "ai-badge-danger" : ""}`}>
                {run.status}
              </span>
              {run.simulated && <span className="ai-badge">demo — no model was called</span>}
            </summary>
            <div className="ai-run-body">
              {run.error && <p className="ai-error">{run.error}</p>}
              {run.steps.map((step) => (
                <div key={step.id} className="ai-run-step">
                  <div className="ai-card-head">
                    <strong>{step.agentName}</strong>
                    {step.targetCluster && <span className="ai-badge ai-badge-cluster">{step.targetCluster}</span>}
                  </div>
                  <p>
                    {step.status === "queued"
                      ? "Waiting…"
                      : step.status === "running"
                        ? "Investigating…"
                        : step.status === "failed"
                          ? `Failed: ${step.error ?? "unknown error"}`
                          : step.findings}
                  </p>
                </div>
              ))}
              {run.synthesis && (
                <div className="ai-run-step">
                  <strong>Combined result</strong>
                  <p>{run.synthesis}</p>
                </div>
              )}
            </div>
          </details>
        ))}
      </article>

      <div className="ai-section-head">
        <h3>
          External agents <span className="ai-count">{runners.length}</span>
        </h3>
        <button
          type="button"
          onClick={() =>
            setRunnerDraft(runnerDraft ? undefined : { id: "", name: "", command: "", args: "", cwd: "" })
          }
        >
          {runnerDraft ? "Close" : "Add an agent"}
        </button>
      </div>
      <p className="ai-hint">
        Coding agents such as Claude Code or Codex, started on this computer and spoken to over the Agent Client
        Protocol. An agent above can run on one of them. The command and folder are kept on this computer only: a
        teammate sets up the same agent on theirs.
      </p>
      {runnerDraft && (
        <form
          className="ai-form ai-card"
          data-testid="runner-form"
          onSubmit={(e) => {
            e.preventDefault();
            const name = runnerDraft.name.trim();
            if (!name || !runnerDraft.command.trim()) return;
            void act({
              action: "runner-save",
              runner: {
                id: runnerDraft.id || name,
                name,
                command: runnerDraft.command.trim(),
                args: runnerDraft.args.split(/\s+/).filter(Boolean),
                cwd: runnerDraft.cwd.trim() || undefined,
              },
            }).then((next) => {
              if (next) setRunnerDraft(undefined);
            });
          }}
        >
          <strong>{runnerDraft.existing ? "Edit external agent" : "Add an external agent"}</strong>
          {runnerDraft.note && <p className="ai-hint">{runnerDraft.note}</p>}
          <label>
            Name
            <input
              required
              autoFocus
              placeholder="Claude Code"
              value={runnerDraft.name}
              onChange={(e) => setRunnerDraft({ ...runnerDraft, name: e.target.value })}
            />
          </label>
          <div className="ai-form-row">
            <label>
              Command
              <input
                required
                className="ai-mono"
                placeholder="npx"
                value={runnerDraft.command}
                onChange={(e) => setRunnerDraft({ ...runnerDraft, command: e.target.value })}
              />
            </label>
            <label>
              Arguments
              <input
                className="ai-mono"
                placeholder="-y @agentclientprotocol/claude-agent-acp"
                value={runnerDraft.args}
                onChange={(e) => setRunnerDraft({ ...runnerDraft, args: e.target.value })}
              />
            </label>
          </div>
          <label>
            Folder it works in
            <input
              required
              className="ai-mono"
              placeholder="/home/you/code/the-product"
              value={runnerDraft.cwd}
              onChange={(e) => setRunnerDraft({ ...runnerDraft, cwd: e.target.value })}
            />
            <small>The checkout of the code. The agent reads and writes here with your user&apos;s rights.</small>
          </label>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              Save
            </button>
            <button type="button" onClick={() => setRunnerDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {runners.map((r) => (
        <article className="ai-card" key={r.id} data-testid={`runner-${r.id}`}>
          <div className="ai-card-head">
            <div>
              <strong>{r.name}</strong>
              <small className="ai-mono">
                {r.command} {r.args.join(" ")}
              </small>
              <small>{r.cwd ? `Works in ${r.cwd}` : "No folder set: it cannot run yet"}</small>
            </div>
            <span className="ai-badge">{agents.filter((a) => a.runnerId === r.id).length} agent(s)</span>
          </div>
          <div className="ai-card-actions">
            <button
              type="button"
              onClick={() =>
                setRunnerDraft({
                  id: r.id,
                  name: r.name,
                  command: r.command,
                  args: r.args.join(" "),
                  cwd: r.cwd ?? "",
                  existing: true,
                })
              }
            >
              Edit
            </button>
            <span className="ai-spacer" />
            <ConfirmButton
              label="Remove"
              confirmLabel="Remove from this computer?"
              onConfirm={() => void act({ action: "runner-delete", id: r.id })}
            />
          </div>
        </article>
      ))}
      {runnerPresets.length > 0 && !runnerDraft && (
        <div className="ai-tags ai-runner-presets">
          <small>Set up:</small>
          {runnerPresets.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ai-chip"
              data-testid={`runner-preset-${p.id}`}
              onClick={() =>
                setRunnerDraft({
                  id: p.id,
                  name: p.name,
                  command: p.command,
                  args: p.args.join(" "),
                  cwd: "",
                  note: p.note,
                })
              }
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      <div className="ai-section-head">
        <h3>
          MCP servers <span className="ai-count">{servers.length}</span>
        </h3>
        <button
          type="button"
          onClick={() =>
            setMcpDraft(
              mcpDraft ? undefined : { name: "", transport: "stdio", command: "npx", args: "", url: "" },
            )
          }
        >
          {mcpDraft ? "Close" : "Add a server"}
        </button>
      </div>
      <p className="ai-hint">
        A Model Context Protocol server, started on this computer or reached over HTTP. Its tools appear to the
        assistant as <code>mcp__server__tool</code> once the server has answered a test.
      </p>

      {mcpDraft && (
        <form
          className="ai-form ai-card"
          data-testid="mcp-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!mcpDraft.name.trim()) return;
            const stdio = mcpDraft.transport === "stdio";
            void act({
              action: "mcp-save",
              server: {
                id: mcpDraft.id,
                name: mcpDraft.name.trim(),
                transport: mcpDraft.transport,
                command: stdio ? mcpDraft.command.trim() : undefined,
                args: stdio ? mcpDraft.args.split(/\s+/).filter(Boolean) : undefined,
                url: stdio ? undefined : mcpDraft.url.trim(),
                enabled: true,
              },
            }).then((next) => {
              if (!next) return;
              const saved = next.mcpServers?.find(
                (m) => m.id === mcpDraft.id || m.name === mcpDraft.name.trim(),
              );
              setMcpDraft(undefined);
              if (!saved) return;
              setTestingMcpId(saved.id);
              void act({ action: "mcp-test", id: saved.id }).finally(() => setTestingMcpId(""));
            });
          }}
        >
          <strong>{mcpDraft.id ? "Edit server" : "Add a server"}</strong>
          {mcpDraft.needs && <p className="ai-hint">{mcpDraft.needs}</p>}
          <label>
            Name
            <input
              required
              autoFocus
              placeholder="Kubernetes"
              value={mcpDraft.name}
              onChange={(e) => setMcpDraft({ ...mcpDraft, name: e.target.value })}
            />
          </label>
          <label>
            How to reach it
            <select
              value={mcpDraft.transport}
              onChange={(e) => setMcpDraft({ ...mcpDraft, transport: e.target.value as "stdio" | "http" })}
            >
              <option value="stdio">Start a program on this computer (stdio)</option>
              <option value="http">Call a URL (HTTP)</option>
            </select>
          </label>
          {mcpDraft.transport === "stdio" ? (
            <div className="ai-form-row">
              <label>
                Command
                <input
                  required
                  placeholder="npx"
                  value={mcpDraft.command}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, command: e.target.value })}
                />
              </label>
              <label>
                Arguments
                <input
                  placeholder="-y mcp-server-kubernetes"
                  value={mcpDraft.args}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, args: e.target.value })}
                />
              </label>
            </div>
          ) : (
            <label>
              URL
              <input
                required
                type="url"
                placeholder="https://mcp.example.internal/mcp"
                value={mcpDraft.url}
                onChange={(e) => setMcpDraft({ ...mcpDraft, url: e.target.value })}
              />
            </label>
          )}
          <p className="ai-hint">
            Saving starts the program (or calls the URL) once to ask which tools it has. Only add servers you trust:
            a stdio server runs with your user&apos;s rights.
          </p>
          <div className="ai-card-actions">
            <button type="submit" className="ai-btn-emerald">
              Save and test
            </button>
            <button type="button" onClick={() => setMcpDraft(undefined)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {servers.length === 0 && !mcpDraft && (
        <p className="ai-empty">No MCP servers yet. The assistant&apos;s built-in tools work without any.</p>
      )}

      {servers.map((srv: McpServerConfig) => {
        const state = !srv.enabled
          ? "disabled"
          : srv.status === "connected"
            ? "connected"
            : srv.status === "error"
              ? "failed"
              : "not tested";
        return (
          <article className="ai-card" key={srv.id} data-testid={`mcp-server-${srv.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{srv.name}</strong>
                <small className="ai-mono">{commandLine(srv)}</small>
              </div>
              <span
                className={`ai-badge ${state === "connected" ? "ai-badge-success" : state === "failed" ? "ai-badge-danger" : ""}`}
              >
                {state}
              </span>
            </div>
            {srv.lastError && srv.enabled && <p className="ai-error">{srv.lastError}</p>}
            {(srv.discoveredTools ?? []).length > 0 && (
              <div className="ai-tags">
                {srv.discoveredTools!.map((t) => (
                  <span key={t.name} className="ai-tool-tag" title={t.description}>
                    {t.name}
                  </span>
                ))}
              </div>
            )}
            <div className="ai-card-actions">
              <button
                type="button"
                className="ai-btn-accent"
                disabled={testingMcpId === srv.id}
                onClick={() => {
                  setTestingMcpId(srv.id);
                  void act({ action: "mcp-test", id: srv.id }).finally(() => setTestingMcpId(""));
                }}
              >
                {testingMcpId === srv.id ? "Testing…" : "Test"}
              </button>
              <button
                type="button"
                onClick={() =>
                  setMcpDraft({
                    id: srv.id,
                    name: srv.name,
                    transport: srv.transport,
                    command: srv.command ?? "",
                    args: (srv.args ?? []).join(" "),
                    url: srv.url ?? "",
                  })
                }
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => void act({ action: "mcp-save", server: { ...srv, enabled: !srv.enabled } })}
              >
                {srv.enabled ? "Disable" : "Enable"}
              </button>
              <span className="ai-spacer" />
              <ConfirmButton
                label="Remove"
                confirmLabel="Remove this server?"
                onConfirm={() => void act({ action: "mcp-delete", id: srv.id })}
              />
            </div>
          </article>
        );
      })}

      {presets.length > 0 && (
        <>
          <h3 className="ai-subhead">
            {hub.demoMode ? "Demo servers (invented — nothing is installed)" : "Starting points"}
          </h3>
          <div className="ai-preset-grid" data-testid="mcp-marketplace-grid">
            {presets.map((preset: McpCatalogPreset) => (
              <article key={preset.id} className="ai-card">
                <div>
                  <strong>{preset.name}</strong>
                  <p>{preset.description}</p>
                  {!hub.demoMode && <small className="ai-mono">{commandLine(preset)}</small>}
                  {preset.needs && <small>{preset.needs}</small>}
                </div>
                <button
                  type="button"
                  data-testid={`mcp-install-${preset.id}`}
                  onClick={() =>
                    hub.demoMode
                      ? void act({ action: "mcp-install-preset", presetId: preset.id })
                      : setMcpDraft({
                          name: preset.name,
                          transport: preset.transport,
                          command: preset.command ?? "",
                          args: (preset.args ?? []).join(" "),
                          url: preset.url ?? "",
                          needs: preset.needs,
                        })
                  }
                >
                  {hub.demoMode ? "Add" : "Set up"}
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
