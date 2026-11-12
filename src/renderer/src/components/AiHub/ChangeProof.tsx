import type { AgentChange } from "@shared/types/aiHub";

/**
 * The check and the way back a change carries, and what became of them: shown
 * where the change is approved and where it is looked up afterwards.
 */
export function ChangeProof({ change }: { change: Pick<AgentChange, "check" | "rollback" | "status"> }): JSX.Element | null {
  if (!change.check && !change.rollback) return null;
  const check = change.check;
  const rollback = change.rollback;
  return (
    <div className="ai-proof" data-testid="change-proof">
      {check && (
        <div>
          <small>
            Check
            {check.after === true ? " · passed" : check.after === false ? " · failed" : ""}
            {check.before !== undefined ? ` · before the change it ${check.before ? "already passed" : "did not pass"}` : ""}
          </small>
          <code>{check.command}</code>
          <small>must show “{check.expected}”</small>
        </div>
      )}
      {rollback && (
        <div data-ran={rollback.ran ? "yes" : "no"}>
          <small>
            {rollback.ran
              ? rollback.exitCode === 0
                ? `Rolled back${rollback.checkAfter === true ? " · the check passes again" : rollback.checkAfter === false ? " · the check still fails" : ""}`
                : `The rollback failed (exit ${rollback.exitCode ?? "?"})`
              : "If the check fails, this runs"}
          </small>
          <code>{rollback.command}</code>
          {rollback.ran && rollback.output ? <pre>{rollback.output}</pre> : null}
        </div>
      )}
    </div>
  );
}
