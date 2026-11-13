import type { AgentChange } from "@shared/types/aiHub";

/**
 * The check and the way back a change carries, and what became of them: shown
 * where the change is approved and where it is looked up afterwards. It says
 * only what is known: a check that already passed before proves nothing, and
 * a rollback has taken the change back only when the check reads as before.
 */
export function ChangeProof({
  change,
}: {
  change: Pick<AgentChange, "check" | "rollback" | "status" | "hiddenValues">;
}): JSX.Element | null {
  if (!change.check && !change.rollback && !change.hiddenValues) return null;
  const check = change.check;
  const rollback = change.rollback;
  const decided = !["pending", "approved", "running"].includes(change.status);
  const checkText = (): string => {
    if (!check) return "";
    if (check.skipped) return ` · not looked at: ${check.skipped}`;
    if (check.after === true)
      return check.before ? " · passed, but it already passed before the change, so it does not show the change did it" : " · passed (it did not pass before)";
    if (check.after === false) return " · failed";
    return "";
  };
  const rollbackText = (): string => {
    if (!rollback) return "";
    if (rollback.ran) {
      if (rollback.exitCode !== 0) return `The rollback failed (exit ${rollback.exitCode ?? "?"})`;
      if (rollback.restored === true) return "Rolled back · the check reads as it did before the change";
      if (rollback.restored === false) return "The rollback ran, but the check does not read as it did before the change";
      return "The rollback ran · whether it restored things is not known";
    }
    if (rollback.skipped) return `Did not run: ${rollback.skipped}`;
    return decided ? "Not needed: the check passed" : "Runs by itself if the check fails after the change";
  };
  return (
    <div className="ai-proof" data-testid="change-proof">
      {change.hiddenValues && (
        <small className="ai-proof-hidden">
          Secrets in this were masked here: what runs has the real values where you see [redacted].
        </small>
      )}
      {check && (
        <div>
          <small>Check{checkText()}</small>
          <code>{check.command}</code>
          <small>must show “{check.expected}”</small>
        </div>
      )}
      {rollback && (
        <div data-ran={rollback.ran ? "yes" : "no"}>
          <small>{rollbackText()}</small>
          <code>{rollback.command}</code>
          {rollback.ran && rollback.output ? <pre>{rollback.output}</pre> : null}
        </div>
      )}
    </div>
  );
}
