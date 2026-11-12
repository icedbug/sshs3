import { useState } from "react";
import type {
  ContextSource,
  HubSnapshot,
  InventoryEntry,
  TerminalSession,
  WorkspaceServerSummary,
} from "@shared/types/aiHub";
import { DependencyLinks } from "./DependencyLinks";
import type { Act } from "./panelShared";

const STATUS: Record<InventoryEntry["status"], { text: string; tone: string }> = {
  reachable: { text: "reachable", tone: "ai-badge-success" },
  unreachable: { text: "unreachable", tone: "ai-badge-danger" },
  blocked: { text: "blocked", tone: "ai-badge-danger" },
  unknown: { text: "not checked", tone: "" },
};

const SESSION_STATE: Record<TerminalSession["state"], string> = {
  ready: "idle",
  busy: "running something",
  disconnected: "disconnected",
  unknown: "state unknown",
};

function serverContext(server: WorkspaceServerSummary, check?: InventoryEntry): string {
  return [
    `Server: ${server.name} (${server.username}@${server.host}:${server.port})`,
    server.cluster ? `Cluster: ${server.cluster}` : "",
    server.nodeRole || server.role ? `Role: ${server.nodeRole || server.role}` : "",
    server.description ? `Description: ${server.description}` : "",
    server.tags?.length ? `Tags: ${server.tags.join(", ")}` : "",
    check && check.status !== "unknown"
      ? `Reachability check ${new Date(check.observedAt).toISOString()}: ${check.status} — ${check.detail}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What the assistant can see and work on: the terminals that are open, the
 * servers the workspace knows, whether they answer, and what depends on what.
 */
export function InfrastructureView({
  hub,
  act,
  busy,
  onAsk,
  onUseTerminal,
}: {
  hub: HubSnapshot;
  act: Act;
  busy: boolean;
  /** Opens the chat with a prompt and, optionally, a piece of context attached. */
  onAsk: (prompt: string, attach?: Pick<ContextSource, "label" | "text">, sessionId?: string) => void;
  onUseTerminal: (sessionId: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [checking, setChecking] = useState(false);

  const sessions = hub.sessions.filter((s) => s.state !== "disconnected");
  const servers = hub.workspaceServers ?? [];
  const checks = new Map<string, InventoryEntry>();
  for (const item of hub.inventory) {
    checks.set(item.id, item);
    checks.set(item.label.toLowerCase(), item);
  }
  const checkOf = (s: WorkspaceServerSummary): InventoryEntry | undefined =>
    checks.get(s.id) ?? checks.get(s.name.toLowerCase());
  const matched = new Set(servers.map(checkOf).filter((c): c is InventoryEntry => Boolean(c)).map((c) => c.id));
  const others = hub.inventory.filter((i) => !matched.has(i.id));
  const lastChecked = Math.max(0, ...hub.inventory.filter((i) => i.status !== "unknown").map((i) => i.observedAt));

  const q = filter.trim().toLowerCase();
  const shown = servers.filter(
    (s) =>
      !q ||
      [s.name, s.host, s.cluster, s.nodeRole, s.role, s.description, ...(s.tags ?? [])]
        .filter(Boolean)
        .some((x) => x!.toLowerCase().includes(q)),
  );
  const groups = new Map<string, WorkspaceServerSummary[]>();
  for (const s of shown) {
    const key = s.cluster || "";
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const groupNames = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));

  const statusBadge = (check?: InventoryEntry): JSX.Element | null =>
    check ? (
      <span className={`ai-badge ${STATUS[check.status].tone}`} title={check.detail}>
        {STATUS[check.status].text}
      </span>
    ) : null;

  return (
    <div className="ai-scroll">
      <header className="ai-view-head">
        <h2>Infrastructure</h2>
        <p className="ai-hint">
          What the assistant can see and work on: your open terminals, the servers this workspace knows, and how they
          depend on each other.
        </p>
      </header>

      <div className="ai-section-head">
        <h3>
          Open terminals <span className="ai-count">{sessions.length}</span>
        </h3>
      </div>
      {sessions.length === 0 && (
        <p className="ai-empty">
          No terminal is open. The assistant can still advise from memory and runbooks; to run commands it needs a
          terminal you have opened.
        </p>
      )}
      {sessions.map((s) => (
        <article className="ai-card" key={s.id} data-testid={`infra-session-${s.id}`}>
          <div className="ai-card-head">
            <div>
              <strong>{s.label}</strong>
              <small>
                {s.kind === "k8s" ? "Kubernetes" : s.kind === "ssh" ? "SSH" : "Local"} · {SESSION_STATE[s.state]} ·{" "}
                {s.owner ? "the assistant is working in it" : "you are in control"}
              </small>
            </div>
          </div>
          {hub.preview?.sessionId === s.id && (
            <pre className="ai-terminal-peek">{hub.preview.text || "Nothing captured from this terminal yet."}</pre>
          )}
          <div className="ai-card-actions">
            <button type="button" className="ai-btn-accent" onClick={() => onUseTerminal(s.id)}>
              Work in this terminal
            </button>
            {hub.preview?.sessionId === s.id ? (
              <button
                type="button"
                onClick={() =>
                  onAsk("", { label: hub.preview!.label, text: hub.preview!.text }, s.id)
                }
              >
                Attach this output to chat
              </button>
            ) : (
              <button type="button" onClick={() => void act({ action: "inspect", sessionId: s.id })}>
                Show recent output
              </button>
            )}
          </div>
        </article>
      ))}

      <div className="ai-section-head">
        <h3>
          Servers <span className="ai-count">{servers.length}</span>
        </h3>
        <button
          type="button"
          disabled={busy || checking}
          onClick={() => {
            setChecking(true);
            void act({ action: "inventory-refresh" }).finally(() => setChecking(false));
          }}
        >
          {checking ? "Checking…" : "Check reachability"}
        </button>
      </div>
      <p className="ai-hint">
        The check only tells whether an address answers
        {lastChecked ? ` (last run ${new Date(lastChecked).toLocaleString()})` : ""}. It says nothing about health or
        whether you can log in; ask the assistant to look into a server for that.
      </p>
      {servers.length > 6 && (
        <div className="ai-filter-bar">
          <input
            type="search"
            aria-label="Filter servers"
            placeholder="Filter by name, cluster, role or tag…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}
      {servers.length === 0 && (
        <p className="ai-empty">
          This workspace has no servers yet. Add them on the start page; shared ones are synced to the team.
        </p>
      )}
      {servers.length > 0 && shown.length === 0 && <p className="ai-empty">No server matches.</p>}
      {groupNames.map((name) => (
        <section key={name || "ungrouped"} className="ai-group">
          <h4>
            {name || "No cluster"} <span className="ai-count">{groups.get(name)!.length}</span>
          </h4>
          <div className="ai-rows">
            {groups.get(name)!.map((server) => {
              const check = checkOf(server);
              const down = check?.status === "unreachable" || check?.status === "blocked";
              return (
                <div className="ai-row" key={server.id} data-testid={`infra-server-${server.id}`}>
                  <div>
                    <strong>{server.name}</strong>
                    <small>
                      <span className="ai-mono">
                        {server.username}@{server.host}
                        {server.port !== 22 ? `:${server.port}` : ""}
                      </span>
                      {server.nodeRole || server.role ? ` · ${server.nodeRole || server.role}` : ""}
                      {server.shared ? "" : " · personal"}
                    </small>
                  </div>
                  <span className="ai-tags">
                    {(() => {
                      const about = (hub.kbPages ?? []).filter((p) =>
                        p.targets.some((t) => [server.name, server.cluster].filter(Boolean).map((x) => x!.toLowerCase()).includes(t.toLowerCase())),
                      );
                      return about.length ? (
                        <span className="ai-badge" title={`Knowledge base pages about it: ${about.map((p) => p.title).join("; ")}`}>
                          {about.length} page{about.length === 1 ? "" : "s"}
                        </span>
                      ) : null;
                    })()}
                    {statusBadge(check)}
                  </span>
                  <button
                    type="button"
                    className={down ? "ai-btn-accent" : ""}
                    onClick={() =>
                      onAsk(
                        down
                          ? `${server.name} does not answer (${check!.detail}). Find out why: start with what can be observed from here, and verify the cause before proposing a fix.`
                          : `Give me a short status of ${server.name}: what we know about it, what changed recently, and anything that needs attention.`,
                        { label: `@${server.name}`, text: serverContext(server, check) },
                      )
                    }
                  >
                    {down ? "Investigate" : "Ask about it"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {others.length > 0 && (
        <section className="ai-group">
          <h4>
            Your other saved targets <span className="ai-count">{others.length}</span>
          </h4>
          <div className="ai-rows">
            {others.map((item) => (
              <div className="ai-row" key={item.id}>
                <div>
                  <strong>{item.label}</strong>
                  <small>
                    {item.kind === "k8s" ? "Kubernetes context" : item.kind === "s3" ? "S3 profile" : "SSH profile"} ·{" "}
                    <span className="ai-mono">{item.address}</span>
                  </small>
                </div>
                {statusBadge(item)}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="ai-section-head">
        <h3>How it hangs together</h3>
      </div>
      <DependencyLinks hub={hub} act={act} />
    </div>
  );
}
