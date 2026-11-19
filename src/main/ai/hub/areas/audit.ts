import path from "node:path";
import type { HubReply } from "../../../../shared/types/aiHub";
import { isDemoMode } from "../demoWorkspace";
import { AuditLog, AuditShipper, type AuditShipperOptions } from "../AuditLog";
import { SessionRecorder } from "../SessionRecorder";
import { safeError } from "../privacy";
import { requiredText } from "../hubHelpers";
import { log, DECIDED_HOW, active } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * The audit log and terminal recordings.
 *
 * Every change an agent made is written to a log that shows if it was cut or altered, and a run's
 * terminal is recorded. Reading and exporting them is here.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class AuditPart {
  /** This installation's audit log, kept beside the hub's other data, anchored in the team bucket. */
  audit(this: HubService): AuditLog {
    if (!this.auditLog) {
      this.auditLog = new AuditLog(path.join(this.directory, "audit"), this.clientId(), () =>
        this.s3Workspace.canUseBucket() && !isDemoMode() ? this.s3Workspace.objects : undefined,
      );
      if (this.host.auditShipper) {
        this.configureAuditShipper(this.host.auditShipper);
      }
    }
    return this.auditLog;
  }

  /** Attaches (or replaces) the out-of-band AuditShipper subscriber on the audit log. */
  configureAuditShipper(this: HubService, options?: AuditShipperOptions): void {
    this.auditShipperUnsub?.();
    this.auditShipperUnsub = undefined;
    this.auditShipper = undefined;
    if (!options) return;
    // Where the log goes is held to the same rule as any other address sshs3 calls out to: on a shared
    // server not the server itself or its private network, unless the administrator allows it.
    const shipper = new AuditShipper({ ...options, guard: { ...this.outboundGuard(), allowPlainHttp: true } });
    this.auditShipper = shipper;
    this.auditShipperUnsub = this.audit().subscribe((entry) => shipper.emit(entry));
  }

  /** Where the terminals an agent owned are recorded. */
  recordings(this: HubService): SessionRecorder {
    if (!this.recorder) {
      this.recorder = new SessionRecorder(path.join(this.directory, "recordings"));
      this.recorder.setPolicy({
        allowHumanOptIn: this.store.data.preferences.recordSessions !== false,
      });
    }
    return this.recorder;
  }

  /**
   * Every change that has reached the state it ends in goes into the audit
   * log once: what ran, where, as whose run, who allowed it, and how it ended.
   * Read off the changes themselves rather than from each place that makes
   * one, so a path that is added later is not a path that is left out.
   */
  auditFinishedChanges(this: HubService): void {
    if (isDemoMode()) return;
    const FINAL = new Set(["completed", "failed", "denied", "uncertain"]);
    for (const task of this.store.data.tasks) {
      if (task.distillSourceId) continue;
      for (const change of task.changes) {
        // A run that has ended leaves nothing half-way: what was never answered was not allowed,
        // and what was allowed but never reported back (an external agent's action) is not known.
        if (!active(task) && (change.status === "pending" || change.status === "approved" || change.status === "running")) {
          if (change.status === "pending") {
            change.status = "denied";
            change.decidedHow ??= "stopped";
          } else {
            change.status = "uncertain";
            change.output ??= "The run ended without saying how this went. Look at the target to know.";
          }
        }
        // A change that carries its own proof gets its final status only after its check (and rollback) had their say.
        if (change.audited || this.writingAudit.has(change.id) || !FINAL.has(change.status)) continue;
        this.writingAudit.add(change.id);
        const attempted = change.rollback?.ran === true;
        const rolledBack = attempted && change.rollback?.exitCode === 0 && change.rollback?.comparedWithBaseline && change.rollback?.restored === true;
        void this.audit()
          .append({
            kind: change.kind === "setting" ? "setting" : change.kind === "file" ? "file-write" : change.check ? "change" : task.fromOutside ? "mcp" : "command",
            actor: `${task.agentName ?? "Assistant"} (${task.fromOutside ? "from outside" : `run ${task.id.slice(0, 8)}`}, ${task.mode})`,
            target: change.target,
            what: change.command || change.description,
            outcome: rolledBack ? "rolled-back" : attempted ? "rollback-unverified" : change.status,
            exitCode: change.exitCode,
            approvedBy: change.decidedBy
              ? `${change.decidedBy.name} (${change.decidedBy.allowed ? "allowed" : "refused"})`
              : change.decidedHow && change.decidedHow !== "person"
                ? DECIDED_HOW[change.decidedHow]
                : undefined,
            taskId: task.id,
            changeId: change.id,
            detail: [
              change.riskLevel ? `risk: ${change.riskLevel}` : "",
              change.check
                ? `check ${change.check.after === true ? (change.check.before ? "passed (it already passed before)" : "passed") : change.check.after === false ? "failed" : `not looked at (${change.check.skipped ?? "unknown"})`}: ${change.check.command}`
                : "",
              change.adminException ? `Administrator exception: ${change.adminException.reason}` : "",
              attempted
                ? `Rollback attempted with: ${change.rollback!.command}${change.rollback!.restored === false ? " (the check does not read as before)" : ""}`
                : change.rollback?.skipped
                  ? `rollback not run: ${change.rollback.skipped}`
                  : "",
              change.hiddenValues ? "secrets in it were masked here" : "",
              change.ref ? `ref ${change.ref}` : "",
            ]
              .filter(Boolean)
              .join("; "),
          }, Date.now(), true)
          .then(() => { change.audited = true; })
          .catch((e) => log.warn("Could not write to the audit log", safeError(e)))
          .finally(() => this.writingAudit.delete(change.id));
      }
    }
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleAudit(this: HubService, request: RequestsOf<"audit">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "audit-read": {
        const log = this.audit();
        reply = {
          audit: {
            entries: await log.recent(Math.max(1, Math.min(1000, request.limit ?? 200))),
            verification: await log.verify(),
          },
        };
        break;
      }
      case "audit-export": {
        const out = await this.audit().export();
        const day = new Date().toISOString().slice(0, 10);
        // The log as it is on disk, line for line, and what its check found, in one file a person can hand on.
        const text = `${out.jsonl}${JSON.stringify({ verification: out.verification, exportedAt: Date.now() })}\n`;
        reply = {
          download: { name: `sshs3-audit-${day}.jsonl`, mime: "application/x-ndjson", dataBase64: Buffer.from(text, "utf8").toString("base64") },
        };
        break;
      }
      case "recording-read": {
        const cast = await this.recordings().read(requiredText(request.id));
        if (!cast) {
          // "Not any more" only for one that is known to have been here: a run names it, or the audit log sealed it.
          const known =
            this.store.data.tasks.some((t) => t.recordingId === request.id || t.recordingIds?.includes(request.id)) ||
            (await this.audit().recent(5000)).some((e) => e.kind === "recording" && e.changeId === request.id);
          throw new Error(known ? "That recording is not on this computer any more." : "There is no recording with that id.");
        }
        // Whether it is still what was sealed into the audit log when it was finished.
        const digest = await this.recordings().digest(request.id);
        const seal = (await this.audit().recent(5000)).find((e) => e.kind === "recording" && e.changeId === request.id);
        const sealed = seal ? seal.detail === `sha256 ${digest}` : undefined;
        reply = { recording: { id: request.id, cast, sealed } };
        break;
      }
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return reply ? { reply } : {};
  }
}
