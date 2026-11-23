import { useState } from "react";
import type { HubSnapshot } from "@shared/types/aiHub";
import { ConfirmButton } from "./ConfirmButton";
import type { Act } from "./panelShared";

const when = (at: number): string => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const where = (key: string): string => (key === "*" ? "every server" : `the cluster ${key}`);

/**
 * The rules an administrator sets for everyone on a server several people sign in to: two people on
 * a change card or a file write on production, and change freezes. An administrator changes them here; a member reads
 * them. Nothing is shown where there are no such rules (the desktop app, the demo lab).
 */
export function TeamRulesSection({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element | null {
  const rules = hub.teamRules;
  const [cluster, setCluster] = useState("");
  const [hours, setHours] = useState("");
  const [why, setWhy] = useState("");
  if (!rules) return null;
  // The freeze on every server first, then the clusters by name.
  const freezes = Object.entries(rules.freezes ?? {}).sort(([a], [b]) => (a === "*" ? -1 : b === "*" ? 1 : a.localeCompare(b)));
  const wantedHours = Number(hours);
  return (
    <div className="ai-set" data-testid="team-rules">
      <strong>Rules for everyone on this server</strong>
      <small>
        {rules.canChange
          ? "You set these as an administrator. They hold for every account's runs, yours too, and nobody's own rules can loosen them."
          : "An administrator of this server sets these. They hold for every account's runs, and your own rules below cannot loosen them."}
      </small>
      {rules.changedBy && rules.changedAt ? (
        <small data-testid="team-rules-changed">
          Last changed by {rules.changedBy}, {when(rules.changedAt)}.
        </small>
      ) : null}

      <label className="ai-check">
        <input
          type="checkbox"
          data-testid="team-peer-toggle"
          checked={Boolean(rules.requirePeerApprovalOnProd)}
          disabled={!rules.canChange}
          onChange={(e) => void act({ action: "team-rules-save", requirePeerApprovalOnProd: e.target.checked })}
        />
        <span>
          Two people must approve a change card or a file write on production
          <small>
            Change cards and file writes on servers tagged prod, critical or production need a second person. They are
            asked in their inbox. Commands are not covered.
          </small>
          {rules.requirePeerApprovalOnProd && hub.peerApprovalPossible !== true && (
            <small data-testid="team-peer-not-you">
              {rules.canChange ? "No other eligible approver is available. In the inbox, you can approve one change alone with a recorded reason." : "No eligible second approver is available. Your change cannot run."}
            </small>
          )}
        </span>
      </label>

      <div data-testid="team-freezes" style={{ display: "grid", gap: 6, marginTop: 8 }}>
        <strong>Change freeze</strong>
        <small>A freeze stops change cards and file writes. Commands still run.</small>
        {freezes.length === 0 ? (
          <small data-testid="team-freeze-none">No freeze is on.</small>
        ) : (
          <ul className="ai-link-list">
            {freezes.map(([key, freeze]) => (
              <li key={key} className="ai-link" data-testid={`team-freeze-${key}`}>
                <span>
                  <span className="ai-badge ai-badge-danger">frozen</span> <strong>{where(key)}</strong> until{" "}
                  {when(freeze.until)}
                  <br />
                  <small>
                    Set by {freeze.by}
                    {freeze.why ? `: ${freeze.why}` : ""}
                  </small>
                </span>
                {rules.canChange && (
                  <ConfirmButton
                    label="End it now"
                    confirmLabel="End this freeze?"
                    className=""
                    onConfirm={() => void act({ action: "team-rules-save", endFreeze: key })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {rules.canChange && (
          <div className="ai-inline-form" data-testid="team-freeze-form">
            <input
              aria-label="Cluster to freeze"
              placeholder="Cluster (empty: all)"
              value={cluster}
              onChange={(e) => setCluster(e.target.value)}
            />
            <input
              aria-label="Freeze for how many hours"
              type="number"
              min={1}
              max={1440}
              placeholder="Hours"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <input aria-label="Why the freeze" placeholder="Why (optional)" value={why} onChange={(e) => setWhy(e.target.value)} />
            <button
              type="button"
              data-testid="team-freeze-start"
              disabled={!(wantedHours > 0)}
              onClick={() => {
                void act({
                  action: "team-rules-save",
                  freeze: { ...(cluster.trim() ? { cluster: cluster.trim() } : {}), hours: wantedHours, ...(why.trim() ? { why: why.trim() } : {}) },
                });
                setCluster("");
                setHours("");
                setWhy("");
              }}
            >
              Start the freeze
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
