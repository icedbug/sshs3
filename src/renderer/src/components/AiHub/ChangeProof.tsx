import { useState } from "react";
import type {
  AgentChange,
  AgentChangeStructuredCheck,
  HubRequest,
  HubSnapshot,
} from "@shared/types/aiHub";
import { hubRequest } from "../../lib/aiHub";
import { AnsiLogView } from "./DiffViewer";

export type ChangeProofChange = Pick<
  AgentChange,
  "check" | "rollback" | "status" | "hiddenValues"
> &
  Partial<
    Pick<
      AgentChange,
      | "id"
      | "structuredCheck"
      | "preflightSnapshot"
      | "dryRunOutput"
      | "blastRadius"
      | "approvals"
      | "requiredApprovals"
    >
  >;

/** Formats structured post-change verification assertions into readable badge labels. */
export function formatStructuredCheckSummary(
  sc: AgentChangeStructuredCheck | undefined,
): string[] {
  if (!sc) return [];
  const items: string[] = [];
  if (sc.equals !== undefined) items.push(`equals "${sc.equals}"`);
  if (sc.regex) items.push(`matches /${sc.regex}/`);
  if (sc.maxNumber !== undefined) items.push(`numeric ≤ ${sc.maxNumber}`);
  return items;
}

/** Returns true when a change outcome or rollback state is uncertain or partially restored. */
export function isUncertainOrPartialRollback(
  change: Pick<AgentChange, "status" | "check" | "rollback">,
): boolean {
  if (change.status === "uncertain") return true;
  const rb = change.rollback;
  if (rb?.ran) {
    if (rb.exitCode !== undefined && rb.exitCode !== 0) return true;
    if (rb.restored !== true) return true;
  }
  if (rb?.skipped) return true;
  const decided = !["pending", "approved", "running"].includes(change.status);
  if (decided && rb && change.check && change.check.after === undefined) return true;
  return false;
}

/**
 * The check and the way back a change carries, and what became of them: shown
 * where the change is approved and where it is looked up afterwards. It says
 * only what is known: a check that already passed before proves nothing, and
 * a rollback has taken the change back only when the check reads as before.
 */
export function ChangeProof({
  change,
  taskId,
  request = hubRequest,
  onRollbackComplete,
}: {
  change: ChangeProofChange;
  taskId?: string;
  request?: (r: HubRequest) => Promise<HubSnapshot>;
  onRollbackComplete?: (snap: HubSnapshot) => void;
}): JSX.Element | null {
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackStatus, setRollbackStatus] = useState("");
  const [rollbackError, setRollbackError] = useState("");

  const structuredItems = formatStructuredCheckSummary(change.structuredCheck);
  const needsVerifyRollback = isUncertainOrPartialRollback(change);

  if (
    !change.check &&
    !change.rollback &&
    !change.hiddenValues &&
    structuredItems.length === 0 &&
    !change.preflightSnapshot &&
    !change.dryRunOutput &&
    !needsVerifyRollback
  ) {
    return null;
  }

  const check = change.check;
  const rollback = change.rollback;
  const decided = !["pending", "approved", "running"].includes(change.status);

  const checkText = (): string => {
    if (!check) return "";
    if (check.skipped) return ` · not looked at: ${check.skipped}`;
    if (check.after === true) {
      return check.before
        ? " · passed, but it already passed before the change, so it does not show the change did it"
        : " · passed (it did not pass before)";
    }
    if (check.after === false) return " · failed";
    return "";
  };

  const rollbackText = (): string => {
    if (!rollback) return "";
    if (rollback.ran) {
      if (rollback.exitCode !== 0) {
        return `The rollback failed (exit ${rollback.exitCode ?? "?"})`;
      }
      if (rollback.restored === true) {
        return "Rolled back · the check reads as it did before the change";
      }
      if (rollback.restored === false) {
        return "The rollback ran, but the check does not read as it did before the change";
      }
      return "The rollback ran · verification needed to confirm restoration";
    }
    if (rollback.skipped) return `Did not run: ${rollback.skipped}`;
    if (change.status === "uncertain") {
      return "Outcome uncertain · verify current state before executing rollback";
    }
    return decided
      ? "Not needed: the check passed"
      : "Runs by itself if the check fails after the change";
  };

  const executeVerifiedRollback = async (): Promise<void> => {
    if (!taskId || !change.id) {
      setRollbackError("Task context unavailable for rollback execution.");
      return;
    }
    setRollbackBusy(true);
    setRollbackError("");
    setRollbackStatus("");
    try {
      const snap = await request({
        action: "rollback-change",
        taskId,
        changeId: change.id,
        verify: true,
      });
      setConfirmingRollback(false);
      setRollbackStatus("State verified and rollback executed.");
      onRollbackComplete?.(snap);
    } catch (error) {
      setRollbackError(error instanceof Error ? error.message : String(error));
    } finally {
      setRollbackBusy(false);
    }
  };

  return (
    <div className="ai-proof" data-testid="change-proof">
      {change.hiddenValues && (
        <small className="ai-proof-hidden">
          Secrets in this were masked here: what runs has the real values where
          you see [redacted].
        </small>
      )}

      {change.preflightSnapshot && (
        <div data-testid="preflight-snapshot">
          <small>Preflight snapshot</small>
          <AnsiLogView text={change.preflightSnapshot} maxLines={25} />
        </div>
      )}

      {change.dryRunOutput && (
        <div data-testid="dry-run-output">
          <small>Dry-run preview</small>
          <AnsiLogView text={change.dryRunOutput} maxLines={35} />
        </div>
      )}

      {(check || structuredItems.length > 0) && (
        <div data-testid="post-check-block">
          <small>
            Post-check{checkText()}
            {check?.after === true && !check.before && (
              <>
                {" "}
                <span className="ai-badge ai-badge-success">verified</span>
              </>
            )}
            {check?.after === false && (
              <>
                {" "}
                <span className="ai-badge ai-badge-danger">failed</span>
              </>
            )}
          </small>
          {check && (
            <>
              <code>{check.command}</code>
              <small>must show “{check.expected}”</small>
            </>
          )}
          {structuredItems.length > 0 && (
            <div className="ai-tags" data-testid="structured-check">
              {structuredItems.map((item) => (
                <span key={item} className="ai-badge ai-badge-mode">
                  {item}
                </span>
              ))}
            </div>
          )}
          {check?.output && <AnsiLogView text={check.output} maxLines={25} />}
        </div>
      )}

      {rollback && (
        <div data-ran={rollback.ran ? "yes" : "no"}>
          <small>{rollbackText()}</small>
          <code>{rollback.command}</code>
          {rollback.ran && rollback.output ? (
            <AnsiLogView text={rollback.output} maxLines={30} />
          ) : null}
        </div>
      )}

      {needsVerifyRollback && (
        <div
          className="ai-proof-verify-rollback"
          data-testid="verify-execute-rollback-panel"
        >
          {!confirmingRollback ? (
            <button
              type="button"
              className="ai-btn-danger"
              data-testid="verify-execute-rollback-btn"
              disabled={rollbackBusy}
              onClick={() => {
                setRollbackError("");
                setConfirmingRollback(true);
              }}
            >
              Verify &amp; Execute Rollback
            </button>
          ) : (
            <div
              className="ai-proof-verify-confirm"
              data-testid="verify-execute-rollback-step2"
            >
              <small>
                Step 1: probe current target state
                {check ? ` (${check.command})` : ""}. Step 2: execute rollback
                {rollback ? ` (${rollback.command})` : ""}.
              </small>
              <div className="ai-card-actions">
                <button
                  type="button"
                  className="ai-btn-danger"
                  data-testid="confirm-execute-rollback-btn"
                  disabled={rollbackBusy}
                  onClick={() => void executeVerifiedRollback()}
                >
                  {rollbackBusy
                    ? "Verifying & rolling back…"
                    : "Confirm & Execute Rollback"}
                </button>
                <button
                  type="button"
                  disabled={rollbackBusy}
                  onClick={() => setConfirmingRollback(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {rollbackStatus && (
            <small role="status" className="ai-ok">
              {rollbackStatus}
            </small>
          )}
          {rollbackError && (
            <small role="alert" className="ai-error">
              {rollbackError}
            </small>
          )}
        </div>
      )}
    </div>
  );
}
