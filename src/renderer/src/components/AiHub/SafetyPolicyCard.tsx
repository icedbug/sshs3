import type { HubSnapshot, SafetyPolicyConfig as SafetyPolicy } from "@shared/types/aiHub";
import type { Act } from "./panelShared";

const RULES: { key: keyof SafetyPolicy; title: string; detail: string }[] = [
  {
    key: "autoApproveSafeReadOnly",
    title: "Run read-only commands without asking",
    detail: "Commands that only look (ls, df, kubectl get …). Applies when the assistant asks before commands.",
  },
  {
    key: "requireApprovalOnProdTags",
    title: "Always ask before a change on production",
    detail:
      "On a server tagged prod, critical or production: when the assistant asks before commands, a change is always asked about. In Auto mode a bare command that changes something is refused there; a change has to come with its check and its rollback.",
  },
  {
    key: "blockDestructiveWithoutConfirm",
    title: "Stop destructive commands until reviewed",
    detail:
      "Commands that are hard to take back — rm -r, mkfs, dd onto a disk, DROP DATABASE, kubectl delete of a namespace, terraform destroy, piping a download into sh — never run without an explicit approval, in any mode.",
  },
];

/** The three switches of the command safety policy. Every part of a command line is classified, across pipes, chains and subshells. */
export function SafetyPolicyCard({ hub, act }: { hub: HubSnapshot; act: Act }): JSX.Element {
  const policy: SafetyPolicy = {
    autoApproveSafeReadOnly: hub.safetyPolicy?.autoApproveSafeReadOnly ?? true,
    requireApprovalOnProdTags: hub.safetyPolicy?.requireApprovalOnProdTags ?? true,
    blockDestructiveWithoutConfirm: hub.safetyPolicy?.blockDestructiveWithoutConfirm ?? true,
  };
  return (
    <article className="ai-card" data-testid="safety-policy-card">
      <div className="ai-card-head">
        <div>
          <strong>Command safety</strong>
          <small>
            Before a command runs, each part of it is classified as read-only, changing or destructive — also inside
            pipes, chains, subshells, bash -c and find -exec. What is not known to be read-only counts as changing.
            These rules apply to runs on this computer; they are not shared with the team.
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
        {RULES.map((rule) => (
          <label key={rule.key}>
            <input
              type="checkbox"
              checked={policy[rule.key]}
              onChange={(e) =>
                void act({ action: "safety-policy-save", policy: { ...policy, [rule.key]: e.target.checked } })
              }
            />
            <span>
              {rule.title}
              <small>{rule.detail}</small>
            </span>
          </label>
        ))}
      </div>
    </article>
  );
}
