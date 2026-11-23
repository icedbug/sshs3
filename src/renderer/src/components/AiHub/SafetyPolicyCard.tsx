import { useState } from "react";
import {
  AGENT_MODES,
  type AgentMode,
  type ClusterSafetyPolicy,
  type HubSnapshot,
  type SafetyPolicyConfig as SafetyPolicy,
} from "@shared/types/aiHub";
import { isWebBrowserMode } from "../../lib/webClientBridge";
import { type Act, modes } from "./panelShared";
import { TeamRulesSection } from "./TeamRulesSection";

type BooleanSafetyKey = "requireApprovalOnProdTags" | "requirePeerApprovalOnProd";

const RULES: { key: BooleanSafetyKey; title: string; detail: string; testId?: string }[] = [
  {
    key: "requireApprovalOnProdTags",
    title: "Always ask before a change card or a file write on production",
    detail:
      "On a server tagged prod, critical or production a change card or a file write waits for a person, in Auto mode too. Commands still run without asking.",
    testId: "safety-prod-approval-toggle",
  },
  {
    key: "requirePeerApprovalOnProd",
    title: "Two people must approve a change card or a file write on production",
    detail:
      "A change card or a file write on a server tagged prod, critical or production runs only when you and one more person have approved it. The other person is asked in their inbox, and their answer counts as theirs. Commands are not covered.",
    testId: "safety-peer-approval-toggle",
  },
];

const MODE_LABELS: Record<AgentMode, string> = {
  advice: `${modes.advice} (advice only, nothing runs)`,
  plan: `${modes.plan} (a plan first)`,
  assisted: `${modes.assisted} (change cards wait for you)`,
  autonomous: `${modes.autonomous} (change cards run on their own)`,
};

interface OverrideDraft {
  originalSelector?: string;
  selector: string;
  maxMode: "" | AgentMode;
  requirePeerApproval: boolean;
  requireCheckAndRollback: boolean;
  freezeHours: string;
}

const emptyOverride: OverrideDraft = {
  selector: "",
  maxMode: "assisted",
  requirePeerApproval: false,
  requireCheckAndRollback: true,
  freezeHours: "",
};

/**
 * The safety rules: when a change card or a file write waits for a person, the two-person rule,
 * and per-cluster / per-tag overrides. Commands are covered by none of it, and the card says so.
 */
export function SafetyPolicyCard({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const policy: SafetyPolicy = {
    requireApprovalOnProdTags: hub.safetyPolicy?.requireApprovalOnProdTags ?? true,
    requirePeerApprovalOnProd: hub.safetyPolicy?.requirePeerApprovalOnProd ?? false,
    clusterPolicies: hub.safetyPolicy?.clusterPolicies ?? {},
  };

  const [overrideDraft, setOverrideDraft] = useState<OverrideDraft | undefined>();

  const savePolicy = (patch: Partial<SafetyPolicy>): void => {
    // Only what was changed is sent. What is shown here is what holds (the server's rules for everyone
    // on top of this person's own), and sending that back whole would store the server's rule as theirs.
    void act({ action: "safety-policy-save", policy: patch });
  };

  const clusterEntries = Object.entries(policy.clusterPolicies ?? {});

  return (
    <article className="ai-card" data-testid="safety-policy-card">
      <div className="ai-card-head">
        <div>
          <strong>Safety rules</strong>
          <small data-testid="safety-policy-not-a-lock">
            Commands the agent runs are not checked and nobody is asked first. Change cards, file writes and plans wait
            for approval. This is a working agreement, not a lock: the agent can run a command directly. What it can do
            on a server is decided by the account it logs in with.
          </small>
          <small data-testid="safety-policy-whose">
            {isWebBrowserMode()
              ? `These rules are yours: they apply to the runs you start. Each person on this server has their own, and they are not shared with the team.${hub.teamRules ? " The rules for everyone on this server are set by an administrator, and yours cannot loosen them." : ""}`
              : "These rules apply to runs on this computer. They are not shared with the team: each person sets their own."}
          </small>
          {hub.safetyPolicyChanged && (
            <small data-testid="safety-policy-changed">
              Last changed by {hub.safetyPolicyChanged.by},{" "}
              {new Date(hub.safetyPolicyChanged.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.
            </small>
          )}
        </div>
      </div>

      <TeamRulesSection hub={hub} act={act} />

      <div className="ai-switches">
        {RULES.map((rule) => {
          // Two people can only be asked for where there is a second person who may answer.
          const nobodyElse = rule.key === "requirePeerApprovalOnProd" && hub.peerApprovalPossible !== true;
          // On for everyone: this person's own switch has nothing left to decide.
          const forEveryone = rule.key === "requirePeerApprovalOnProd" && hub.teamRules?.requirePeerApprovalOnProd === true;
          return (
            <label key={rule.key}>
              <input
                type="checkbox"
                data-testid={rule.testId}
                checked={Boolean(policy[rule.key])}
                disabled={forEveryone || (nobodyElse && !policy[rule.key])}
                onChange={(e) => savePolicy({ [rule.key]: e.target.checked })}
              />
              <span>
                {rule.title}
                <small>{rule.detail}</small>
                {forEveryone && <small data-testid="safety-peer-for-everyone">On for everyone on this server: see the rules for everyone above.</small>}
                {nobodyElse && !forEveryone && (
                  <small data-testid="safety-peer-nobody">
                    {isWebBrowserMode()
                      ? "Not available to you here: nobody else on this server may approve on production. That takes an administrator other than yourself."
                      : "Not available here: only one person signs in to this app. It works on an sshS3 server several people share."}
                  </small>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="ai-set" data-testid="cluster-safety-policies">
        <div className="ai-section-head">
          <div>
            <strong>Per-cluster &amp; per-tag safety overrides</strong>
            <small>
              Override max autonomy mode, two-person approval, check/rollback requirement, or change freeze per cluster
              or <code>tag:&lt;name&gt;</code>. They hold for change cards and file writes. Only a max mode of Advice
              also stops commands.
            </small>
            <small data-testid="safety-freeze-note">A freeze stops change cards and file writes. Commands still run.</small>
            <small data-testid="safety-own-runs-note">
              A freeze or an override set here holds for your own runs only.
            </small>
          </div>
          <button
            type="button"
            data-testid="add-cluster-policy-btn"
            onClick={() =>
              setOverrideDraft(
                overrideDraft
                  ? undefined
                  : // Ticked only where a second person can approve: elsewhere the override would not be saved.
                    { ...emptyOverride, requirePeerApproval: hub.peerApprovalPossible === true },
              )
            }
          >
            {overrideDraft ? "Close" : "Add cluster / tag override"}
          </button>
        </div>

        {overrideDraft && (
          <div className="ai-form ai-card" data-testid="cluster-policy-form">
            <label>
              Cluster or tag selector
              <input
                aria-label="Cluster or tag selector"
                placeholder="prod-k8s or tag:prod"
                value={overrideDraft.selector}
                onChange={(e) => setOverrideDraft({ ...overrideDraft, selector: e.target.value })}
              />
            </label>
            <div className="ai-form-row">
              <label>
                Max autonomy mode
                <select
                  aria-label="Override max mode"
                  value={overrideDraft.maxMode}
                  onChange={(e) =>
                    setOverrideDraft({ ...overrideDraft, maxMode: e.target.value as "" | AgentMode })
                  }
                >
                  <option value="">Inherit global policy</option>
                  {AGENT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {MODE_LABELS[m]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Change freeze duration (hours, optional)
                <input
                  type="number"
                  min="0"
                  max="720"
                  placeholder="0 = no freeze"
                  value={overrideDraft.freezeHours}
                  onChange={(e) => setOverrideDraft({ ...overrideDraft, freezeHours: e.target.value })}
                />
              </label>
            </div>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={overrideDraft.requirePeerApproval}
                onChange={(e) =>
                  setOverrideDraft({ ...overrideDraft, requirePeerApproval: e.target.checked })
                }
              />
              <span>
                Two people must approve (you and one more)
                <small>
                  {hub.peerApprovalPossible === true
                    ? "The other person is asked in their inbox: somebody on this server who may approve there."
                    : "Needs somebody else who may approve: a second account on a shared server, and on production an administrator other than yourself. Where only you can approve, untick this or the override is not saved."}
                </small>
              </span>
            </label>
            <label className="ai-check">
              <input
                type="checkbox"
                checked={overrideDraft.requireCheckAndRollback}
                onChange={(e) =>
                  setOverrideDraft({ ...overrideDraft, requireCheckAndRollback: e.target.checked })
                }
              />
              <span>
                Every change needs a check and a rollback
                <small>A file write is refused there. Commands still run.</small>
              </span>
            </label>
            <div className="ai-card-actions">
              <button
                type="button"
                className="ai-btn-emerald"
                onClick={() => {
                  const selector = overrideDraft.selector.trim();
                  if (!selector) return;
                  const hours = Number(overrideDraft.freezeHours);
                  const nextPolicy: ClusterSafetyPolicy = {
                    ...(overrideDraft.maxMode ? { maxMode: overrideDraft.maxMode } : {}),
                    requiredApprovals: overrideDraft.requirePeerApproval ? 2 : 1,
                    requireCheckAndRollback: overrideDraft.requireCheckAndRollback,
                    ...(Number.isFinite(hours) && hours > 0
                      ? { frozenUntil: Date.now() + hours * 3_600_000 }
                      : {}),
                  };
                  const nextMap = { ...(policy.clusterPolicies ?? {}) };
                  if (overrideDraft.originalSelector && overrideDraft.originalSelector !== selector) {
                    delete nextMap[overrideDraft.originalSelector];
                  }
                  nextMap[selector] = nextPolicy;
                  savePolicy({ clusterPolicies: nextMap });
                  setOverrideDraft(undefined);
                }}
              >
                Save override
              </button>
              <button type="button" onClick={() => setOverrideDraft(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {clusterEntries.length === 0 && !overrideDraft && (
          <small className="ai-hint">No per-cluster or per-tag overrides configured.</small>
        )}

        {clusterEntries.map(([selector, cp]) => {
          const isFrozen = Boolean(cp.frozenUntil && cp.frozenUntil > Date.now());
          const sodEnabled = (cp.requiredApprovals ?? 1) >= 2;
          return (
            <div className="ai-card" key={selector} data-testid={`cluster-policy-${selector}`}>
              <div className="ai-card-head">
                <div>
                  <strong>{selector}</strong>
                  <div className="ai-tags">
                    {cp.maxMode && (
                      <span className="ai-badge ai-badge-mode">max: {modes[cp.maxMode] ?? cp.maxMode}</span>
                    )}
                    <span className={`ai-badge ${sodEnabled ? "ai-badge-purple" : ""}`}>
                      {sodEnabled ? "2 people approve" : "1 approval"}
                    </span>
                    {cp.requireCheckAndRollback && (
                      <span className="ai-badge ai-badge-success">check + rollback</span>
                    )}
                    {isFrozen && (
                      <span className="ai-badge ai-badge-danger">
                        frozen until {new Date(cp.frozenUntil!).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="ai-card-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setOverrideDraft({
                        originalSelector: selector,
                        selector,
                        maxMode: cp.maxMode ?? "",
                        requirePeerApproval: sodEnabled,
                        requireCheckAndRollback: Boolean(cp.requireCheckAndRollback),
                        freezeHours: isFrozen
                          ? String(Math.max(1, Math.ceil((cp.frozenUntil! - Date.now()) / 3_600_000)))
                          : "",
                      })
                    }
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove override ${selector}`}
                    onClick={() => {
                      const nextMap = { ...(policy.clusterPolicies ?? {}) };
                      delete nextMap[selector];
                      savePolicy({ clusterPolicies: nextMap });
                    }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </article>
  );
}
