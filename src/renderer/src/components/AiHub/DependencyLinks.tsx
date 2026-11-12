import { useState } from "react";
import type { HubSnapshot, InfraGraphEdge } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";

const RELATIONS: Record<InfraGraphEdge["relation"], string> = {
  depends_on: "depends on",
  mounts_storage: "mounts storage from",
  replicates_to: "replicates to",
  routes_to: "routes to",
  monitors: "monitors",
  ssh_tunnel: "tunnels through",
};

/** What depends on what. The assistant is given these links as context. */
export function DependencyLinks({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [relation, setRelation] = useState<InfraGraphEdge["relation"]>("depends_on");
  const [label, setLabel] = useState("");
  const all = hub.infraEdges ?? [];
  const edges = all.filter((e) => !e.proposed);
  const proposed = all.filter((e) => e.proposed);
  const names = Array.from(
    new Set(
      (hub.workspaceServers ?? []).flatMap((s) => [s.cluster, s.name]).filter((x): x is string => Boolean(x)),
    ),
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
      <div className="ai-link-list">
        {edges.map((edge) => (
          <div key={edge.id} className="ai-link">
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
