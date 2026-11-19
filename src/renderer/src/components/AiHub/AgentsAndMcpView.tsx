import { useState } from "react";
import { ACP_WORKSPACE_TOOLS, acpEditorTools } from "@shared/acpWorkspaceTools";
import {
  type AgentMode,
  type HubSnapshot,
  type McpCatalogPreset,
  type McpOAuthConfig,
  type McpServerConfig,
  type McpToolPolicy,
  type MissionAgent,
  type WorkforceRun,
  type WorkspaceRule,
  type WorkspaceRuleActivation,
  type WorkspaceRuleScope,
} from "@shared/types/aiHub";
import { AgentTestsView } from "./AgentTestsView";
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
  allowedTools: string[];
  modelOverride: string;
  runnerId: string;
}

interface McpDraft {
  id?: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  url: string;
  needs?: string;
  /** Environment variables (stdio) or headers (http). A stored value is never sent here: `kept` rows keep theirs unless retyped. */
  secrets?: { name: string; value: string; kept: boolean }[];
  enabled?: boolean;
  trustReadOnlyHint?: boolean;
  oauthEnabled?: boolean;
  oauthClientId?: string;
  oauthScopes?: string;
  oauthConnectedAt?: number;
}

interface RuleDraft {
  id?: string;
  name: string;
  scope: WorkspaceRuleScope;
  scopeValue: string;
  activation: WorkspaceRuleActivation;
  description: string;
  body: string;
  priority: number;
  applyToReadOnly: boolean;
  enabled: boolean;
}

type McpServerWithCapabilities = McpServerConfig & {
  discoveredPrompts?: unknown[];
  discoveredResources?: unknown[];
  promptCount?: number;
  resourceCount?: number;
};

const NARROWABLE: { name: string; label: string }[] = [
  { name: "terminal_command", label: "Run commands in the terminal" },
  { name: "sshs3_change", label: "Make a change that carries its check and its rollback" },
  { name: "terminal_verify", label: "Check the result of a command" },
  { name: "sshs3_cluster_exec", label: "Run the same command across a cluster" },
  { name: "file_read", label: "Read files on a server" },
  { name: "file_write", label: "Write files on a server" },
  { name: "sshs3_storage_ops", label: "List, read and compare remote files" },
  { name: "sshs3_tickets", label: "Read and write the team's tickets" },
  { name: "sshs3_investigate", label: "Start investigators" },
  { name: "sshs3_plan_propose", label: "Propose a plan" },
  { name: "sshs3_session_search", label: "Search earlier conversations" },
  { name: "workspace_remember", label: "Write to the team's memory" },
  { name: "sshs3_kb_manage", label: "Add or remove knowledge base sources" },
  { name: "sshs3_manage_server", label: "Change servers and tunnels" },
  { name: "sshs3_manage_cluster_and_folders", label: "Change clusters and folders" },
  { name: "sshs3_manage_memory_and_activity", label: "Change memories, skills and the activity log" },
  { name: "sshs3_manage_schedule", label: "Change schedules" },
  { name: "sshs3_manage_s3_and_sync", label: "Change storage and sync" },
  { name: "sshs3_manage_app_and_settings", label: "Change the app's own settings" },
  { name: "sshs3_agent_and_mcp_manage", label: "Change agents and MCP servers" },
  { name: "sshs3_workspace_layout", label: "Open terminals and panes" },
];

const emptyAgent: AgentDraft = {
  name: "",
  role: "",
  mission: "",
  systemPrompt: "",
  targetCluster: "",
  defaultMode: "assisted",
  kbDocIds: [],
  mcpServerIds: [],
  allowedTools: [],
  modelOverride: "",
  runnerId: "",
};

const emptyRule: RuleDraft = {
  name: "",
  scope: "global",
  scopeValue: "",
  activation: "always",
  description: "",
  body: "",
  priority: 100,
  applyToReadOnly: true,
  enabled: true,
};

const RULE_SCOPES: readonly WorkspaceRuleScope[] = ["global", "env", "tag", "cluster", "server"];
const RULE_ACTIVATIONS: readonly WorkspaceRuleActivation[] = ["always", "auto", "agent-requested", "manual"];

const toggled = (list: string[], id: string): string[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

const commandLine = (srv: { transport: string; command?: string; args?: string[]; url?: string }): string =>
  srv.transport === "stdio"
    ? `${srv.command ?? ""} ${(srv.args ?? []).join(" ")}`.trim()
    : (srv.url ?? "");

function effectiveToolPolicy(
  srv: McpServerConfig,
  toolName: string,
  readOnly?: boolean,
): McpToolPolicy {
  const explicit = srv.toolPolicies?.[toolName];
  if (explicit) return explicit;
  if (readOnly && srv.trustReadOnlyHint) return "allow";
  return "ask";
}

function mcpOAuthStatus(oauth?: McpOAuthConfig): { label: string; badgeClass: string } {
  if (!oauth?.enabled) return { label: "OAuth 2.1 off", badgeClass: "" };
  if (oauth.connectedAt) return { label: "OAuth 2.1 connected", badgeClass: "ai-badge-success" };
  return { label: "OAuth 2.1 disconnected", badgeClass: "ai-badge-danger" };
}

/** What each commands level means, in one wording for the form and the card. */
const COMMAND_LEVELS: Record<AgentMode, string> = {
  advice: "Never runs commands, advises only",
  plan: "Proposes a plan for approval first",
  assisted: "Asks before each command",
  autonomous: "Runs commands on its own",
};

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

  const [mcpDraft, setMcpDraft] = useState<McpDraft | undefined>();
  const [testingMcpId, setTestingMcpId] = useState("");
  const [mcpTestNotes, setMcpTestNotes] = useState<Record<string, string>>({});
  const [runnerDraft, setRunnerDraft] = useState<
    { id: string; name: string; command: string; args: string; cwd: string; note?: string; existing?: boolean } | undefined
  >();
  /** What the last Test of an external agent found, by its id; "testing" while it is asked. */
  const [runnerTests, setRunnerTests] = useState<Record<string, { ok: boolean; detail: string } | "testing">>({});
  const testRunner = async (id: string): Promise<void> => {
    setRunnerTests((now) => ({ ...now, [id]: "testing" }));
    const snap = await act({ action: "runner-test", id });
    const found = snap?.reply?.runnerProbe;
    setRunnerTests((now) => {
      const { [id]: _was, ...rest } = now;
      return found?.id === id ? { ...rest, [id]: { ok: found.ok, detail: found.detail } } : rest;
    });
  };
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | undefined>();
  const [ruleScopeFilter, setRuleScopeFilter] = useState<"all" | WorkspaceRuleScope>("all");

  const runners = hub.externalRunners ?? [];
  const runnerPresets = (hub.externalRunnerPresets ?? []).filter((p) => !runners.some((r) => r.id === p.id));
  const runnerName = (id: string): string =>
    runners.find((r) => r.id === id)?.name ?? hub.externalRunnerPresets?.find((p) => p.id === id)?.name ?? id;

  const agents = hub.agents ?? [];
  const servers = (hub.mcpServers ?? []) as McpServerWithCapabilities[];
  const docs = hub.kbDocuments ?? [];
  const rules = hub.rules ?? [];
  const filteredRules =
    ruleScopeFilter === "all" ? rules : rules.filter((r) => r.scope === ruleScopeFilter);
  const localResourcesCount = (hub.kbPages?.length ?? 0) + (hub.runbooks?.length ?? 0);
  const localPromptsCount =
    hub.memories.filter((m) => m.kind === "skill").length + (hub.runbooks?.length ?? 0);

  const clusters = Array.from(
    new Set(
      (hub.workspaceServers ?? [])
        .map((s) => s.cluster)
        .filter((c): c is string => Boolean(c)),
    ),
  );
  const installedIds = new Set(servers.map((s) => s.id));
  const presets = (hub.mcpCatalog ?? []).filter((p) => !installedIds.has(p.id));

  // The request says which conversation it started: guessing "the one that is new" picks a background run when one began meanwhile.
  const startMission = (request: Parameters<Act>[0]): Promise<void> =>
    act(request).then((next) => {
      const started = next?.reply?.started?.taskId;
      if (started) onStartedMission(started);
    });

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
                // Nothing ticked means it is held to nothing: its mode decides, as before.
                allowedTools: draft.allowedTools.length ? draft.allowedTools : ["all"],
                modelOverride: draft.modelOverride.trim() || undefined,
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
              onChange={(e) => setDraft({ ...draft, runnerId: e.target.value, allowedTools: e.target.value ? acpEditorTools(draft.allowedTools) : draft.allowedTools })}
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
                An external agent uses its own folder, tools and model. When local MCP is enabled, it can
                also request the workspace tools selected below. Command requests still require approval.
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
                {(Object.keys(COMMAND_LEVELS) as AgentMode[]).map((level) => (
                  <option key={level} value={level}>
                    {COMMAND_LEVELS[level]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(hub.kbPages ?? []).length > 0 && (
            <fieldset className="ai-checks" data-testid="agent-pages">
              <legend>
                Knowledge base pages it always has at hand (every agent can open any page; these are given in full)
              </legend>
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
          <fieldset className="ai-checks">
            <legend>What it may do (none ticked: whatever its mode allows)</legend>
            <small className="ai-hint">
              {draft.runnerId
                ? "These restrictions apply to the local workspace MCP connection. The run's mode, target and permissions also apply."
                : "The agent's mode and safety policy still apply. It may always look at the workspace, read knowledge base pages and keep its own notes."}
            </small>
            {(draft.runnerId ? ACP_WORKSPACE_TOOLS : NARROWABLE).map((t) => (
              <label key={t.name}>
                <input
                  type="checkbox"
                  checked={draft.allowedTools.includes(t.name)}
                  onChange={() => setDraft({ ...draft, allowedTools: toggled(draft.allowedTools, t.name) })}
                />
                <span>{t.label}</span>
              </label>
            ))}
            {draft.allowedTools.filter(name => !(draft.runnerId ? ACP_WORKSPACE_TOOLS : NARROWABLE).some(t => t.name === name)).map(name => (
              <label key={name}>
                <input type="checkbox" checked onChange={() => setDraft({ ...draft, allowedTools: toggled(draft.allowedTools, name) })} />
                <span>{name} (unavailable for this runner)</span>
              </label>
            ))}
          </fieldset>
          <label>
            A model of its own (optional)
            <input
              placeholder="Empty: the model set in Settings"
              value={draft.modelOverride}
              onChange={(e) => setDraft({ ...draft, modelOverride: e.target.value })}
            />
            <small>
              A model of the endpoint that is configured now. After a change of provider the agent follows
              the configured model again instead of failing.
            </small>
          </label>
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
                <span className="ai-badge ai-badge-mode" title={COMMAND_LEVELS[ag.defaultMode]}>
                  {modes[ag.defaultMode] ?? ag.defaultMode}
                </span>
                {ag.targetCluster && <span className="ai-badge ai-badge-cluster">{ag.targetCluster}</span>}
              </div>
            </div>
            {/* What was saved, in the form's own words: the badge alone left people unsure it had stuck. */}
            <small className="ai-hint" data-testid={`agent-may-${ag.id}`}>
              Commands: {COMMAND_LEVELS[ag.defaultMode] ?? ag.defaultMode}.{" "}
              {(ag.allowedTools ?? []).filter((t) => t !== "all").length
                ? `Held to ${(ag.allowedTools ?? []).filter((t) => t !== "all").length} of the things an agent may do.`
                : "May do everything that level allows."}
            </small>
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
                    allowedTools: ag.runnerId ? acpEditorTools(ag.allowedTools) : (ag.allowedTools ?? []).filter((t) => t !== "all"),
                    modelOverride: ag.modelOverride ?? "",
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
              <span
                className={`ai-badge ${run.status === "completed" ? "ai-badge-success" : run.status === "failed" ? "ai-badge-danger" : ""}`}
              >
                {run.status}
              </span>
              {/* An example that came with the demo data describes no server as it is now. */}
              {run.id.startsWith("demo-") ? (
                <span className="ai-badge">Example from the demo data. Not the current state.</span>
              ) : (
                run.simulated && <span className="ai-badge">Demo: no model was called</span>
              )}
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

      <section className="ai-set" data-testid="workspace-rules-section">
        <div className="ai-section-head">
          <div>
            <h3>
              Workspace Rules (.sshs3/rules) <span className="ai-count">{rules.length}</span>
            </h3>
            <small>
              Cascading instructions scoped by global, env, tag, cluster, or server glob pattern. Applied across chat,
              mission agents, and external ACP runners.
            </small>
          </div>
          <button
            type="button"
            data-testid="new-rule-btn"
            onClick={() => setRuleDraft(ruleDraft ? undefined : { ...emptyRule })}
          >
            {ruleDraft ? "Close" : "New rule"}
          </button>
        </div>

        <div className="ai-tags" data-testid="workspace-rules-scope-filters">
          <button
            type="button"
            className={`ai-chip ${ruleScopeFilter === "all" ? "ai-chip-active" : ""}`}
            onClick={() => setRuleScopeFilter("all")}
          >
            All ({rules.length})
          </button>
          {RULE_SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              className={`ai-chip ${ruleScopeFilter === scope ? "ai-chip-active" : ""}`}
              onClick={() => setRuleScopeFilter(ruleScopeFilter === scope ? "all" : scope)}
            >
              {scope} ({rules.filter((r) => r.scope === scope).length})
            </button>
          ))}
        </div>

        {ruleDraft && (
          <form
            className="ai-form ai-card"
            data-testid="workspace-rule-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!ruleDraft.name.trim() || !ruleDraft.body.trim()) return;
              void act({
                action: "rule-save",
                rule: {
                  id: ruleDraft.id,
                  name: ruleDraft.name.trim(),
                  scope: ruleDraft.scope,
                  scopeValue: ruleDraft.scope === "global" ? undefined : ruleDraft.scopeValue.trim() || undefined,
                  activation: ruleDraft.activation,
                  description: ruleDraft.description.trim() || undefined,
                  body: ruleDraft.body.trim(),
                  priority: ruleDraft.priority,
                  applyToReadOnly: ruleDraft.applyToReadOnly,
                  enabled: ruleDraft.enabled,
                },
              }).then((next) => {
                if (next) setRuleDraft(undefined);
              });
            }}
          >
            <strong>{ruleDraft.id ? "Edit workspace rule" : "New workspace rule"}</strong>
            <div className="ai-form-row">
              <label>
                Rule name
                <input
                  required
                  aria-label="Rule name"
                  placeholder="Production change guardrails"
                  value={ruleDraft.name}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, name: e.target.value })}
                />
              </label>
              <label>
                Scope
                <select
                  aria-label="Rule scope"
                  value={ruleDraft.scope}
                  onChange={(e) =>
                    setRuleDraft({ ...ruleDraft, scope: e.target.value as WorkspaceRuleScope })
                  }
                >
                  {RULE_SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="ai-form-row">
              {ruleDraft.scope !== "global" && (
                <label>
                  Scope value / glob
                  <input
                    aria-label="Scope value or glob"
                    className="ai-mono"
                    placeholder="prod* or k8s-prod-*"
                    value={ruleDraft.scopeValue}
                    onChange={(e) => setRuleDraft({ ...ruleDraft, scopeValue: e.target.value })}
                  />
                </label>
              )}
              <label>
                Activation
                <select
                  aria-label="Rule activation"
                  value={ruleDraft.activation}
                  onChange={(e) =>
                    setRuleDraft({ ...ruleDraft, activation: e.target.value as WorkspaceRuleActivation })
                  }
                >
                  {RULE_ACTIVATIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Priority
                <input
                  type="number"
                  aria-label="Rule priority"
                  value={ruleDraft.priority}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, priority: Number(e.target.value) })}
                />
              </label>
            </div>
            <label>
              Description (optional)
              <input
                aria-label="Rule description"
                placeholder="When and why this rule applies"
                value={ruleDraft.description}
                onChange={(e) => setRuleDraft({ ...ruleDraft, description: e.target.value })}
              />
            </label>
            <label>
              Rule instructions (.sshs3/rules)
              <textarea
                required
                rows={4}
                aria-label="Rule body"
                placeholder="Always run read-only diagnostics before proposing configuration changes on prod*."
                value={ruleDraft.body}
                onChange={(e) => setRuleDraft({ ...ruleDraft, body: e.target.value })}
              />
            </label>
            <div className="ai-form-row">
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={ruleDraft.enabled}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, enabled: e.target.checked })}
                />
                <span>Rule enabled</span>
              </label>
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={ruleDraft.applyToReadOnly}
                  onChange={(e) => setRuleDraft({ ...ruleDraft, applyToReadOnly: e.target.checked })}
                />
                <span>Apply to read-only runs</span>
              </label>
            </div>
            <div className="ai-card-actions">
              <button type="submit" className="ai-btn-emerald">
                Save rule
              </button>
              <button type="button" onClick={() => setRuleDraft(undefined)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {filteredRules.length === 0 && !ruleDraft && (
          <p className="ai-empty">
            No workspace rules defined in <code>.sshs3/rules</code>. Add scoped rules to cascade instructions by
            environment, tag, cluster, or host glob.
          </p>
        )}

        {filteredRules.map((rule: WorkspaceRule) => {
          const isEnabled = rule.enabled !== false;
          return (
            <article
              key={rule.id}
              className={`ai-card ${isEnabled ? "" : "ai-card-off"}`}
              data-testid={`workspace-rule-${rule.id}`}
            >
              <div className="ai-card-head">
                <div>
                  <strong>{rule.name}</strong>
                  {rule.description && <small>{rule.description}</small>}
                </div>
                <div className="ai-tags">
                  <span className="ai-badge ai-badge-cluster">
                    {rule.scope === "global" ? "global" : `${rule.scope}:${rule.scopeValue || "*"}`}
                  </span>
                  <span className="ai-badge ai-badge-mode">{rule.activation}</span>
                  {rule.priority !== undefined && <span className="ai-badge">p:{rule.priority}</span>}
                  <span className={`ai-badge ${isEnabled ? "ai-badge-success" : ""}`}>
                    {isEnabled ? "enabled" : "disabled"}
                  </span>
                </div>
              </div>
              <p className="ai-memory-text">{rule.body}</p>
              <div className="ai-card-actions">
                <button
                  type="button"
                  onClick={() =>
                    setRuleDraft({
                      id: rule.id,
                      name: rule.name,
                      scope: rule.scope,
                      scopeValue: rule.scopeValue ?? "",
                      activation: rule.activation,
                      description: rule.description ?? "",
                      body: rule.body,
                      priority: rule.priority ?? 100,
                      applyToReadOnly: rule.applyToReadOnly !== false,
                      enabled: isEnabled,
                    })
                  }
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void act({
                      action: "rule-save",
                      rule: { ...rule, enabled: !isEnabled },
                    })
                  }
                >
                  {isEnabled ? "Disable" : "Enable"}
                </button>
                <span className="ai-spacer" />
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Delete this rule?"
                  onConfirm={() => void act({ action: "rule-delete", id: rule.id })}
                />
              </div>
            </article>
          );
        })}
      </section>

      <AgentTestsView hub={hub} act={act} />

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
              {(() => {
                const test = runnerTests[r.id];
                if (test === "testing") return <small data-testid={`runner-test-${r.id}`}>Starting it and waiting for its answer…</small>;
                if (test)
                  return (
                    <small data-testid={`runner-test-${r.id}`} role="status" className={test.ok ? "ai-ok" : "ai-bad"}>
                      {test.ok ? "Works: " : "Does not work: "}
                      {test.detail}
                    </small>
                  );
                return <small data-testid={`runner-test-${r.id}`}>Not checked yet. Test starts the program, greets it and stops it again. It is given no work.</small>;
              })()}
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
            <button type="button" data-testid={`runner-test-btn-${r.id}`} disabled={runnerTests[r.id] === "testing"} onClick={() => void testRunner(r.id)}>
              {runnerTests[r.id] === "testing" ? "Testing…" : "Test"}
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
        <div>
          <h3>
            MCP servers <span className="ai-count">{servers.length}</span>
          </h3>
          <small data-testid="local-mcp-capabilities">
            Local sshS3 MCP exposure: {localResourcesCount} resources · {localPromptsCount} prompts
          </small>
        </div>
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
            const oauth: McpOAuthConfig | undefined =
              !stdio && mcpDraft.oauthEnabled
                ? {
                    enabled: true,
                    clientId: mcpDraft.oauthClientId?.trim() || undefined,
                    scopes: (mcpDraft.oauthScopes ?? "")
                      .split(/[,\s]+/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                    connectedAt: mcpDraft.oauthConnectedAt,
                  }
                : undefined;

            void act({
              action: "mcp-save",
              server: {
                id: mcpDraft.id,
                name: mcpDraft.name.trim(),
                transport: mcpDraft.transport,
                command: stdio ? mcpDraft.command.trim() : undefined,
                args: stdio ? mcpDraft.args.split(/\s+/).filter(Boolean) : undefined,
                url: stdio ? undefined : mcpDraft.url.trim(),
                ...(() => {
                  const values = Object.fromEntries(
                    (mcpDraft.secrets ?? [])
                      .filter((r) => r.name.trim())
                      .map((r) => [r.name.trim(), r.value]),
                  );
                  return stdio ? { env: values, headers: {} } : { headers: values, env: {} };
                })(),
                enabled: mcpDraft.enabled ?? true,
                trustReadOnlyHint: mcpDraft.trustReadOnlyHint ?? false,
                oauth,
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
            <>
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
              <label className="ai-check">
                <input
                  type="checkbox"
                  checked={Boolean(mcpDraft.oauthEnabled)}
                  onChange={(e) => setMcpDraft({ ...mcpDraft, oauthEnabled: e.target.checked })}
                />
                <span>Use OAuth 2.1 (RFC 9728 / PKCE) authentication</span>
              </label>
              {mcpDraft.oauthEnabled && (
                <div className="ai-form-row">
                  <label>
                    OAuth Client ID (optional)
                    <input
                      placeholder="Dynamic registration or client_id"
                      value={mcpDraft.oauthClientId ?? ""}
                      onChange={(e) => setMcpDraft({ ...mcpDraft, oauthClientId: e.target.value })}
                    />
                  </label>
                  <label>
                    OAuth Scopes
                    <input
                      placeholder="mcp:read, mcp:tools"
                      value={mcpDraft.oauthScopes ?? ""}
                      onChange={(e) => setMcpDraft({ ...mcpDraft, oauthScopes: e.target.value })}
                    />
                  </label>
                </div>
              )}
            </>
          )}
          <label className="ai-check">
            <input
              type="checkbox"
              checked={Boolean(mcpDraft.trustReadOnlyHint)}
              onChange={(e) => setMcpDraft({ ...mcpDraft, trustReadOnlyHint: e.target.checked })}
            />
            <span>Believe this server when it says a tool only reads, and run those tools without asking (not for production)</span>
          </label>
          <fieldset className="ai-secret-rows" data-testid="mcp-secrets">
            <legend>{mcpDraft.transport === "stdio" ? "Environment variables" : "Headers"} (tokens and keys go here)</legend>
            {(mcpDraft.secrets ?? []).map((row, i) => (
              <div className="ai-inline-form" key={i}>
                <input
                  aria-label={mcpDraft.transport === "stdio" ? "Variable name" : "Header name"}
                  placeholder={mcpDraft.transport === "stdio" ? "GITHUB_TOKEN" : "Authorization"}
                  value={row.name}
                  disabled={row.kept}
                  onChange={(e) =>
                    setMcpDraft({
                      ...mcpDraft,
                      secrets: mcpDraft.secrets!.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                    })
                  }
                />
                <input
                  aria-label={`Value of ${row.name || "the new one"}`}
                  type="password"
                  autoComplete="off"
                  placeholder={row.kept ? "Kept. Type a new value to change it." : "Value"}
                  value={row.value}
                  onChange={(e) =>
                    setMcpDraft({
                      ...mcpDraft,
                      secrets: mcpDraft.secrets!.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove ${row.name || "this row"}`}
                  onClick={() =>
                    setMcpDraft({
                      ...mcpDraft,
                      secrets: mcpDraft.secrets!.filter((_, j) => j !== i),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setMcpDraft({
                  ...mcpDraft,
                  secrets: [...(mcpDraft.secrets ?? []), { name: "", value: "", kept: false }],
                })
              }
            >
              Add one
            </button>
            <small>Values are stored encrypted and never shown again, here or to a model. Only the names are.</small>
          </fieldset>
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

      {servers.map((srv) => {
        const isDemo = Boolean(srv.demo || srv.id.startsWith("demo-mcp-"));
        const state = !srv.enabled
          ? "disabled"
          : isDemo
            ? "Demo (simulated)"
            : srv.status === "connected"
              ? "connected"
              : srv.status === "error"
                ? "failed"
                : "not tested";
        const toolCount = srv.discoveredTools?.length ?? 0;
        const promptCount = srv.discoveredPrompts?.length ?? srv.promptCount ?? 0;
        const resourceCount = srv.discoveredResources?.length ?? srv.resourceCount ?? 0;
        const oauthInfo = mcpOAuthStatus(srv.oauth);
        const testNote = mcpTestNotes[srv.id];

        return (
          <article className="ai-card" key={srv.id} data-testid={`mcp-server-${srv.id}`}>
            <div className="ai-card-head">
              <div>
                <strong>{srv.name}</strong>
                <small className="ai-mono">{commandLine(srv)}</small>
                <small data-testid={`mcp-counts-${srv.id}`}>
                  {toolCount} tool{toolCount === 1 ? "" : "s"} · {promptCount} prompt{promptCount === 1 ? "" : "s"} ·{" "}
                  {resourceCount} resource{resourceCount === 1 ? "" : "s"}
                  {srv.lastTestedAt
                    ? ` · Tested ${new Date(srv.lastTestedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                    : ""}
                </small>
              </div>
              <div className="ai-tags">
                {(srv.transport === "http" || srv.oauth?.enabled) && (
                  <span
                    className={`ai-badge ${oauthInfo.badgeClass}`}
                    data-testid={`mcp-oauth-badge-${srv.id}`}
                    title={
                      srv.oauth?.scopes?.length
                        ? `Scopes: ${srv.oauth.scopes.join(", ")}`
                        : "OAuth 2.1 connection status"
                    }
                  >
                    {oauthInfo.label}
                  </span>
                )}
                <span
                  data-testid={isDemo && srv.enabled ? `mcp-demo-badge-${srv.id}` : undefined}
                  className={`ai-badge ${
                    state === "connected"
                      ? "ai-badge-success"
                      : state === "failed"
                        ? "ai-badge-danger"
                        : ""
                  }`}
                >
                  {state}
                </span>
              </div>
            </div>

            {isDemo && srv.enabled && (
              <p className="ai-hint" data-testid={`mcp-demo-note-${srv.id}`}>
                Simulated demo server. Its tools return scripted answers locally and do not connect to a real network.
              </p>
            )}

            {srv.lastError && srv.enabled && <p className="ai-error">{srv.lastError}</p>}

            {testNote && (
              <p className="ai-hint" role="status" data-testid={`mcp-test-status-${srv.id}`}>
                {testNote}
              </p>
            )}

            <label className="ai-check">
              <input
                type="checkbox"
                checked={Boolean(srv.trustReadOnlyHint)}
                onChange={(e) =>
                  void act({
                    action: "mcp-save",
                    server: { ...srv, trustReadOnlyHint: e.target.checked },
                  })
                }
              />
              <span>Believe this server when it says a tool only reads, and run those tools without asking</span>
            </label>

            {(srv.discoveredTools ?? []).length > 0 && (
              <div className="ai-form" data-testid={`mcp-tool-matrix-${srv.id}`}>
                <small>For each tool: run it, ask first, or never run it.</small>
                {srv.discoveredTools!.map((t) => {
                  const policy = effectiveToolPolicy(srv, t.name, t.readOnly);
                  return (
                    <div className="ai-inline-form" key={t.name}>
                      <span className="ai-tool-tag" title={t.description}>
                        {t.name}
                        {t.readOnly ? " · says it only reads" : ""}
                      </span>
                      <select
                        aria-label={`Policy for ${srv.name} ${t.name}`}
                        data-testid={`mcp-tool-policy-${srv.id}-${t.name}`}
                        value={policy}
                        onChange={(e) =>
                          void act({
                            action: "mcp-tool-policy",
                            serverId: srv.id,
                            toolName: t.name,
                            policy: e.target.value as McpToolPolicy,
                          })
                        }
                      >
                        <option value="allow">allow</option>
                        <option value="ask">ask</option>
                        <option value="deny">deny</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="ai-card-actions">
              <button
                type="button"
                className="ai-btn-accent"
                disabled={testingMcpId === srv.id}
                onClick={() => {
                  setTestingMcpId(srv.id);
                  void act({ action: "mcp-test", id: srv.id })
                    .then((next) => {
                      const updated = next?.mcpServers?.find((x) => x.id === srv.id);
                      const note =
                        next?.reply?.notes?.join(" ") ||
                        (updated?.lastError
                          ? `Failed: ${updated.lastError}`
                          : updated?.status === "connected"
                            ? `Connected: ${updated.discoveredTools?.length ?? 0} tool(s) available.`
                            : "Test finished.");
                      setMcpTestNotes((prev) => ({ ...prev, [srv.id]: note }));
                    })
                    .catch((err) => {
                      setMcpTestNotes((prev) => ({
                        ...prev,
                        [srv.id]: err instanceof Error ? err.message : "Test failed.",
                      }));
                    })
                    .finally(() => setTestingMcpId(""));
                }}
              >
                {testingMcpId === srv.id ? "Testing…" : "Test"}
              </button>
              {srv.transport === "http" && (
                <button
                  type="button"
                  data-testid={`mcp-oauth-connect-${srv.id}`}
                  onClick={() => {
                    const nextOAuth: McpOAuthConfig = {
                      ...(srv.oauth ?? {}),
                      enabled: true,
                    };
                    void act({
                      action: "mcp-save",
                      server: { ...srv, oauth: nextOAuth },
                    }).then((saved) => {
                      if (saved) void act({ action: "mcp-test", id: srv.id });
                    });
                  }}
                >
                  {srv.oauth?.connectedAt ? "Reconnect OAuth 2.1" : "Connect OAuth 2.1"}
                </button>
              )}
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
                    secrets: Object.keys((srv.transport === "http" ? srv.headers : srv.env) ?? {}).map((name) => ({
                      name,
                      value: "",
                      kept: true,
                    })),
                    enabled: srv.enabled,
                    trustReadOnlyHint: srv.trustReadOnlyHint,
                    oauthEnabled: srv.oauth?.enabled,
                    oauthClientId: srv.oauth?.clientId,
                    oauthScopes: srv.oauth?.scopes?.join(", "),
                    oauthConnectedAt: srv.oauth?.connectedAt,
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
            {hub.demoMode ? "Demo servers (invented, nothing is installed)" : "Starting points"}
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
