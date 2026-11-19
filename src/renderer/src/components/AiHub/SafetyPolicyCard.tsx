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

type BooleanSafetyKey =
  | "autoApproveSafeReadOnly"
  | "requireApprovalOnProdTags"
  | "blockDestructiveWithoutConfirm"
  | "requirePeerApprovalOnProd";

const RULES: { key: BooleanSafetyKey; title: string; detail: string; testId?: string }[] = [
  {
    key: "autoApproveSafeReadOnly",
    title: "Run read-only commands without asking",
    detail: "Commands that only look (ls, df, kubectl get …). Applies when the assistant asks before commands.",
  },
  {
    key: "requireApprovalOnProdTags",
    title: "Always ask before a change on production",
    detail:
      "On a server tagged prod, critical or production: when the assistant asks before commands, a change is always asked about. In Auto mode a command that changes something is refused there when it comes alone: the agent has to send it together with a check that shows it worked and a way to undo it.",
  },
  {
    key: "blockDestructiveWithoutConfirm",
    title: "Stop destructive commands until reviewed",
    detail:
      "Commands that are hard to take back — rm -r, mkfs, dd onto a disk, DROP DATABASE, kubectl delete of a namespace, terraform destroy, piping a download into sh — never run without an explicit approval, in any mode.",
  },
  {
    key: "requirePeerApprovalOnProd",
    title: "Two people must approve a change on production",
    detail:
      "A change on a server tagged prod, critical or production runs only when you and one more person have approved it. The other person is asked in their inbox, and their answer counts as theirs.",
    testId: "safety-peer-approval-toggle",
  },
];

const MODE_LABELS: Record<AgentMode, string> = {
  advice: `${modes.advice} (read-only advice)`,
  plan: `${modes.plan} (propose plan first)`,
  assisted: `${modes.assisted} (ask before commands)`,
  autonomous: `${modes.autonomous} (run on its own)`,
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
 * Command safety policy controls: global safety switches, the two-person rule,
 * global allowed command prefixes, and per-cluster / per-tag safety overrides.
 */
export function SafetyPolicyCard({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const policy: SafetyPolicy = {
    autoApproveSafeReadOnly: hub.safetyPolicy?.autoApproveSafeReadOnly ?? true,
    requireApprovalOnProdTags: hub.safetyPolicy?.requireApprovalOnProdTags ?? true,
    blockDestructiveWithoutConfirm: hub.safetyPolicy?.blockDestructiveWithoutConfirm ?? true,
    requirePeerApprovalOnProd: hub.safetyPolicy?.requirePeerApprovalOnProd ?? false,
    commandAllowPrefixes: hub.safetyPolicy?.commandAllowPrefixes ?? [],
    clusterPolicies: hub.safetyPolicy?.clusterPolicies ?? {},
  };

  const [prefixInput, setPrefixInput] = useState("");
  const [overrideDraft, setOverrideDraft] = useState<OverrideDraft | undefined>();

  const savePolicy = (patch: Partial<SafetyPolicy>): void => {
    void act({
      action: "safety-policy-save",
      policy: {
        ...policy,
        ...patch,
      },
    });
  };

  const clusterEntries = Object.entries(policy.clusterPolicies ?? {});
  const allowPrefixes = policy.commandAllowPrefixes ?? [];

  return (
    <article className="ai-card" data-testid="safety-policy-card">
      <div className="ai-card-head">
        <div>
          <strong>Command safety</strong>
          <small>
            Before a command runs, each part of it is classified as read-only, changing or destructive — also inside
            pipes, chains, subshells, bash -c and find -exec. What is not known to be read-only counts as changing.
          </small>
          <small data-testid="safety-policy-whose">
            {isWebBrowserMode()
              ? "These rules are yours: they apply to the runs you start. Each person on this server has their own, and they are not shared with the team."
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

      <div className="ai-switches">
        {RULES.map((rule) => {
          // Two people can only be asked for where there is a second person who may answer.
          const nobodyElse = rule.key === "requirePeerApprovalOnProd" && hub.peerApprovalPossible !== true;
          return (
            <label key={rule.key}>
              <input
                type="checkbox"
                data-testid={rule.testId}
                checked={Boolean(policy[rule.key])}
                disabled={nobodyElse && !policy[rule.key]}
                onChange={(e) => savePolicy({ [rule.key]: e.target.checked })}
              />
              <span>
                {rule.title}
                <small>{rule.detail}</small>
                {nobodyElse && (
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

      <div className="ai-set" data-testid="safety-allow-prefixes">
        <strong>Allowed command prefixes</strong>
        <small>
          Normalized read-only or low-risk command prefixes allowed without prompting in assisted mode (never bypasses
          production or destructive guards).
        </small>
        {allowPrefixes.length > 0 && (
          <div className="ai-tags">
            {allowPrefixes.map((prefix) => (
              <span key={prefix} className="ai-tool-tag">
                <code>{prefix}</code>{" "}
                <button
                  type="button"
                  aria-label={`Remove allowed prefix ${prefix}`}
                  onClick={() =>
                    savePolicy({
                      commandAllowPrefixes: allowPrefixes.filter((p) => p !== prefix),
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="ai-inline-form">
          <input
            aria-label="New allowed command prefix"
            placeholder="e.g. kubectl get, df -h"
            value={prefixInput}
            onChange={(e) => setPrefixInput(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              const next = prefixInput.trim();
              if (!next || allowPrefixes.includes(next)) return;
              savePolicy({ commandAllowPrefixes: [...allowPrefixes, next] });
              setPrefixInput("");
            }}
          >
            Add prefix
          </button>
        </div>
      </div>

      <div className="ai-set" data-testid="cluster-safety-policies">
        <div className="ai-section-head">
          <div>
            <strong>Per-cluster &amp; per-tag safety overrides</strong>
            <small>
              Override max autonomy mode, two-person approval, check/rollback requirement, or change freeze per cluster
              or <code>tag:&lt;name&gt;</code>.
            </small>
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
              <span>Require pre-change check and rollback command</span>
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
