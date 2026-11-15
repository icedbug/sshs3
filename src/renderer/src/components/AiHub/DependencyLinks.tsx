import { useMemo, useState } from "react";
import type { HubSnapshot, InfraGraphEdge } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";
import { buildDependencyTopology, type TopologyNode } from "./workforceModel";

const RELATIONS: Record<InfraGraphEdge["relation"], string> = {
  depends_on: "depends on",
  mounts_storage: "mounts storage from",
  replicates_to: "replicates to",
  routes_to: "routes to",
  monitors: "monitors",
  ssh_tunnel: "tunnels through",
};

/** What depends on what. The assistant is given these links as context. */
export function DependencyLinks({
  hub,
  act,
  selectedNode: controlledSelectedNode,
  onSelectNode,
  onOpenHost,
}: {
  hub: HubSnapshot;
  act: Act;
  selectedNode?: string;
  onSelectNode?: (nodeId: string | undefined) => void;
  onOpenHost?: (hostOrCluster: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [relation, setRelation] = useState<InfraGraphEdge["relation"]>("depends_on");
  const [label, setLabel] = useState("");
  const [internalSelected, setInternalSelected] = useState<string | undefined>();

  const selectedNode = controlledSelectedNode !== undefined ? controlledSelectedNode : internalSelected;
  const setSelectedNode = (next: string | undefined): void => {
    if (controlledSelectedNode === undefined) setInternalSelected(next);
    onSelectNode?.(next);
  };

  const all = useMemo(() => hub.infraEdges ?? [], [hub.infraEdges]);
  const topology = useMemo(
    () => buildDependencyTopology(all, hub.workspaceServers),
    [all, hub.workspaceServers],
  );
  const { edges, proposedEdges: proposed } = topology;

  const names = useMemo(
    () =>
      Array.from(
        new Set(
          (hub.workspaceServers ?? []).flatMap((s) => [s.cluster, s.name]).filter((x): x is string => Boolean(x)),
        ),
      ),
    [hub.workspaceServers],
  );

  const inventoryByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of hub.inventory ?? []) {
      map.set(item.label.toLowerCase(), item.status);
    }
    return map;
  }, [hub.inventory]);

  const activeAlertsByTarget = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of hub.workTickets ?? []) {
      if (t.status === "done" || !t.target) continue;
      if (t.alert && !t.alert.resolvedAt) {
        const key = t.target.toLowerCase();
        map.set(key, (map.get(key) ?? 0) + 1);
      }
    }
    return map;
  }, [hub.workTickets]);

  const tiers = useMemo(() => {
    const grouped = new Map<number, TopologyNode[]>();
    for (const node of topology.nodes) {
      const list = grouped.get(node.tier);
      if (list) list.push(node);
      else grouped.set(node.tier, [node]);
    }
    return [...grouped.entries()].sort((a, b) => a[0] - b[0]);
  }, [topology.nodes]);

  const selectedTopo = topology.nodes.find((n) => n.id === selectedNode);
  const highlightedPeers = useMemo(() => {
    if (!selectedTopo) return new Set<string>();
    return new Set([selectedTopo.id, ...selectedTopo.downstreamIds, ...selectedTopo.upstreamIds]);
  }, [selectedTopo]);

  const visibleEdges = useMemo(
    () => (selectedNode ? edges.filter((e) => e.from === selectedNode || e.to === selectedNode) : edges),
    [edges, selectedNode],
  );

  return (
    <article className="ai-card" data-testid="infra-dependency-graph-card">
      <div className="ai-card-head">
        <div>
          <strong>
            Dependencies <span className="ai-count">{edges.length}</span>
          </strong>
          <small>
            What depends on what. The assistant reads these before it touches something, so it knows what else a
            change can reach.
          </small>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)}>
          {open ? "Close" : "Add a link"}
        </button>
      </div>

      {open && (
        <form
          className="ai-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!from.trim() || !to.trim()) return;
            void act({
              action: "infra-edge-save",
              edge: { from: from.trim(), to: to.trim(), relation, label: label.trim() || undefined },
            }).then((next) => {
              if (!next) return;
              setFrom("");
              setTo("");
              setLabel("");
              setOpen(false);
            });
          }}
        >
          <datalist id="ai-dependency-names">
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <div className="ai-form-row ai-form-row-3">
            <input
              required
              list="ai-dependency-names"
              aria-label="From"
              placeholder="This cluster or server…"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <select
              aria-label="Relation"
              value={relation}
              onChange={(e) => setRelation(e.target.value as InfraGraphEdge["relation"])}
            >
              {Object.entries(RELATIONS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
            <input
              required
              list="ai-dependency-names"
              aria-label="To"
              placeholder="…that one"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="ai-inline-form">
            <input
              aria-label="Note"
              placeholder="Note (optional), e.g. replication lag must stay under 5 minutes"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button type="submit" className="ai-btn-emerald">
              Save
            </button>
          </div>
        </form>
      )}

      {edges.length === 0 && !open && (
        <p className="ai-empty">
          No links yet. Add the ones that matter when something breaks: which cluster stores another&apos;s volumes,
          what replicates where.
        </p>
      )}

      {topology.nodes.length > 0 && (
        <section
          className="ai-topo-graph"
          data-testid="dependency-topology"
          aria-label="Dependency topology"
          style={{ display: "grid", gap: 10, margin: "8px 0 12px" }}
        >
          {topology.cycles.length > 0 && (
            <div
              className="ai-badge ai-badge-danger"
              data-testid="dependency-cycle-warning"
              style={{ justifySelf: "start" }}
            >
              {topology.cycles.length} dependency cycle{topology.cycles.length === 1 ? "" : "s"} detected
            </div>
          )}

          {selectedTopo && (
            <div
              className="ai-topo-filter"
              data-testid="dependency-filter-bar"
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: 8,
                padding: "6px 10px",
                borderRadius: 8,
                border: "1px solid var(--ai-line-strong, rgba(148,163,184,0.3))",
                background: "rgba(45, 212, 191, 0.08)",
                fontSize: 12,
              }}
            >
              <span>
                Focused: <strong>{selectedTopo.label}</strong> · blast radius{" "}
                <strong>{selectedTopo.blastRadius}</strong> · {selectedTopo.upstreamIds.length} upstream
              </span>
              <span className="ai-spacer" />
              {onOpenHost && (
                <button
                  type="button"
                  className="ai-btn-accent"
                  data-testid={`open-host-${selectedTopo.id}`}
                  onClick={() => onOpenHost(selectedTopo.id)}
                >
                  Open host
                </button>
              )}
              <button
                type="button"
                data-testid="dependency-clear-filter"
                onClick={() => setSelectedNode(undefined)}
              >
                Clear filter
              </button>
            </div>
          )}

          <div
            className="ai-topo-tiers"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: 10,
            }}
          >
            {tiers.map(([tierIndex, tierNodes]) => (
              <div
                key={tierIndex}
                className="ai-topo-tier"
                data-tier={tierIndex}
                style={{
                  display: "grid",
                  gap: 8,
                  alignContent: "start",
                  padding: 8,
                  borderRadius: 10,
                  border: "1px solid var(--ai-line, rgba(148,163,184,0.2))",
                  background: "rgba(0, 0, 0, 0.12)",
                }}
              >
                <small style={{ color: "var(--ai-ink-faint)", textTransform: "uppercase", fontSize: 10.5 }}>
                  {tierIndex === 0 ? "Foundations / Upstream" : `Tier ${tierIndex}`}
                </small>
                {tierNodes.map((node) => {
                  const isSelected = selectedNode === node.id;
                  const isDimmed = Boolean(selectedNode && !highlightedPeers.has(node.id));
                  const invStatus = inventoryByName.get(node.id.toLowerCase());
                  const alertCount = activeAlertsByTarget.get(node.id.toLowerCase()) ?? 0;

                  return (
                    <div
                      key={node.id}
                      role="button"
                      tabIndex={0}
                      aria-pressed={isSelected}
                      data-testid={`topo-node-${node.id}`}
                      className={`ai-topo-node ${isSelected ? "ai-topo-node-selected" : ""}`}
                      style={{
                        display: "grid",
                        gap: 6,
                        padding: "9px 10px",
                        borderRadius: 9,
                        border: isSelected
                          ? "1px solid var(--ai-accent, #2dd4bf)"
                          : "1px solid var(--ai-line-strong, rgba(148,163,184,0.28))",
                        background: isSelected ? "rgba(45, 212, 191, 0.1)" : "var(--ai-surface, rgba(255,255,255,0.03))",
                        opacity: isDimmed ? 0.45 : 1,
                        cursor: "pointer",
                      }}
                      onClick={() => setSelectedNode(isSelected ? undefined : node.id)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter" || ev.key === " ") {
                          ev.preventDefault();
                          setSelectedNode(isSelected ? undefined : node.id);
                        }
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <strong style={{ fontSize: 12.5 }}>{node.label}</strong>
                        <span
                          className={`ai-badge ${node.blastRadius > 0 ? "ai-badge-mode" : ""}`}
                          data-testid={`blast-radius-${node.id}`}
                          title={
                            node.downstreamIds.length > 0
                              ? `Impacts: ${node.downstreamIds.join(", ")}`
                              : "No downstream dependents impacted"
                          }
                        >
                          {node.blastRadius} blast
                        </span>
                        {node.hasCycle && (
                          <span className="ai-badge ai-badge-danger" title="Participates in a dependency cycle">
                            cycle
                          </span>
                        )}
                        {alertCount > 0 && (
                          <span className="ai-badge ai-badge-danger">
                            {alertCount} alert{alertCount === 1 ? "" : "s"}
                          </span>
                        )}
                        {invStatus && invStatus !== "unknown" && (
                          <span
                            className={`ai-badge ${invStatus === "reachable" ? "ai-badge-success" : "ai-badge-danger"}`}
                          >
                            {invStatus}
                          </span>
                        )}
                      </div>

                      <div style={{ display: "grid", gap: 2, fontSize: 11, color: "var(--ai-ink-soft)" }}>
                        {node.outgoing.map((e) => (
                          <span key={`out-${e.id}`}>
                            → {RELATIONS[e.relation] ?? e.relation} <strong>{e.to}</strong>
                          </span>
                        ))}
                        {node.incoming.map((e) => (
                          <span key={`in-${e.id}`}>
                            ← <strong>{e.from}</strong> {RELATIONS[e.relation] ?? e.relation}
                          </span>
                        ))}
                      </div>

                      {onOpenHost && (
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="ai-chip"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              onOpenHost(node.id);
                            }}
                          >
                            Open host
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}

      {proposed.length > 0 && (
        <div className="ai-link-list" data-testid="proposed-links">
          <small className="ai-muted">
            Suggested by agents from what they saw. They are not given to agents as fact until you confirm them.
          </small>
          {proposed.map((edge) => (
            <div key={edge.id} className="ai-link ai-link-proposed">
              <div>
                <strong>{edge.from}</strong> <span>{RELATIONS[edge.relation] ?? edge.relation}</span>{" "}
                <strong>{edge.to}</strong>
                <small>
                  {edge.proposedBy ? `${edge.proposedBy}: ` : ""}
                  {edge.evidence || edge.label || "no evidence given"}
                </small>
              </div>
              <div className="ai-card-actions">
                <button
                  type="button"
                  className="ai-btn-emerald"
                  onClick={() => void act({ action: "infra-edge-confirm", id: edge.id })}
                >
                  Confirm
                </button>
                <button type="button" onClick={() => void act({ action: "infra-edge-delete", id: edge.id })}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="ai-link-list" data-testid="confirmed-links">
        {visibleEdges.map((edge) => (
          <div key={edge.id} className="ai-link" data-testid={`dep-edge-${edge.id}`}>
            <div>
              <strong>{edge.from}</strong> <span>{RELATIONS[edge.relation] ?? edge.relation}</span>{" "}
              <strong>{edge.to}</strong>
              {edge.label && <small>{edge.label}</small>}
            </div>
            <ConfirmButton
              label="Remove"
              confirmLabel="Remove link?"
              className=""
              onConfirm={() => void act({ action: "infra-edge-delete", id: edge.id })}
            />
          </div>
        ))}
      </div>
    </article>
  );
}
