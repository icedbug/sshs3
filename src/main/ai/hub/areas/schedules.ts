import crypto from "node:crypto";
import type { HubReply, AgentSchedule, AgentTask } from "../../../../shared/types/aiHub";
import { SHELL_KINDS } from "../../../../shared/types/aiHub";
import { getDemoSchedules, isDemoMode } from "../demoWorkspace";
import { boundedPrompt, clip, PERSON_PROMPT_MAX, safeError } from "../privacy";
import { requiredText, integer } from "../hubHelpers";
import { active } from "../hubShared";
import { nextCronTime } from "../../../../shared/scheduleTiming";
import { resolveTargetSelector } from "../WorkforceRunner";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * Schedules: a prompt that runs at set times.
 *
 * Saving and removing one, running one now, and what happens when its run has ended.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export function nextScheduleTime(schedule: Pick<AgentSchedule, "cron" | "timezone" | "intervalMinutes">, now: number): number {
  return schedule.cron ? nextCronTime(schedule.cron, schedule.timezone || "UTC", now) : now + schedule.intervalMinutes * 60_000;
}

export class SchedulesPart {
  async scheduleEvent(this: HubService, kind: "facts_drift" | "unreachable" | "alert", profileIds: string[]): Promise<void> {
    const storedById = new Map(this.store.data.schedules.map((s) => [s.id, s]));
    const candidates: AgentSchedule[] = [...this.store.data.schedules];
    if (isDemoMode()) {
      const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
      for (const demo of getDemoSchedules()) {
        if (!storedById.has(demo.id) && !dismissed.has(demo.id)) {
          candidates.push(demo);
        }
      }
    }
    const matches = candidates.filter((s) => s.enabled && s.eventTrigger?.kind === kind && profileIds.includes(s.profileId));
    if (!matches.length || this.disposed || !(await this.config.getView()).enabled) return;
    const now = Date.now();
    for (const candidate of matches) {
      let s = storedById.get(candidate.id);
      if (!s) {
        s = { ...candidate };
        this.store.data.schedules.push(s);
        storedById.set(s.id, s);
      }
      if (!s.enabled || !this.store.data.schedules.includes(s) || this.scheduleInProgress(s)) continue;
      if (s.lastEventAt !== undefined && now - s.lastEventAt < (s.eventTrigger?.cooldownMinutes ?? 30) * 60_000) continue;
      s.lastEventAt = now;
      await this.launchSchedule(s, true);
      this.changed();
    }
  }

  scheduleInProgress(this: HubService, schedule: AgentSchedule): boolean {
    return this.scheduleStarts.has(schedule.id) || this.store.data.tasks.some((task) => active(task) && (task.scheduleId === schedule.id || task.id === schedule.lastTaskId));
  }

  /**
   * A scheduled run has ended: its schedule says how (not just "Started"),
   * a failure is told to the person, and the terminal opened for it is closed.
   */
  scheduledRunEnded(this: HubService, taskId: string): void {
    const sessionId = this.scheduleSessions.get(taskId);
    if (sessionId) {
      this.scheduleSessions.delete(taskId);
      this.closeOwnTerminal(sessionId);
    }
    for (const opened of this.runTerminals.get(taskId) ?? []) this.closeOwnTerminal(opened);
    this.runTerminals.delete(taskId);
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    const schedule = this.store.data.schedules.find((s) => s.id === task?.scheduleId || s.lastTaskId === taskId);
    if (!task || active(task)) return;
    delete task.quietScheduleResult;
    if (!schedule || (schedule.lastTaskId && schedule.lastTaskId !== task.id && !this.scheduleStarts.has(schedule.id))) return;
    const answer = task.messages.filter((m) => m.role === "assistant").at(-1)?.text.trim();
    if (schedule.quietSentinel && task.status === "completed" && !task.error && answer === "HEARTBEAT_OK" &&
        !task.plan && task.changes.every((c) => c.status === "completed" && c.riskLevel === "safe") &&
        (task.toolLog ?? []).every((rec) => rec.ok !== false && !rec.exitCode)) {
      task.quietScheduleResult = true;
    }
    const at = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    schedule.lastStatus =
      task.status === "completed"
        ? `Completed at ${at}${task.verification === "verified" ? ", verified" : ""}`
        : `${task.status === "failed" ? "Failed" : "Stopped"} at ${at}${task.error ? `: ${clip(task.error, 160)}` : ""}`;
    if (task.status !== "completed") this.notify("Scheduled task did not finish", schedule.title);
  }

  /** Starts one run of a scheduled job: when it falls due, and when somebody asks for it now. */
  async launchSchedule(this: HubService, schedule: AgentSchedule, persistDueTime = false): Promise<AgentTask | undefined> {
    if (this.scheduleInProgress(schedule)) return undefined;
    this.scheduleStarts.add(schedule.id);
    let opened: string | undefined;
    try {
      if (persistDueTime) await this.store.save();
      if (!schedule.enabled || !this.store.data.schedules.includes(schedule)) return undefined;
      let prompt = schedule.prompt;
      if (schedule.runbookId) {
        const book = this.storeDataExtra().runbooks?.find((b) => b.id === schedule.runbookId);
        if (!book) throw new Error("The selected runbook no longer exists.");
        if (book.targetSelector && Object.values(book.targetSelector).some((v) => Array.isArray(v) ? v.length > 0 : Boolean(v)) &&
            !resolveTargetSelector(this.getKnownServers(), book.targetSelector).some((t) => t.id === schedule.profileId)) {
          throw new Error("This server is outside the runbook's targets.");
        }
        if (book.inputs.some((f) => f.required && (f.defaultValue === undefined || f.defaultValue === ""))) {
          throw new Error("The runbook needs an input value. Set a default before scheduling it.");
        }
        const inputs = new Map(book.inputs.map((f) => [f.name, f.defaultValue]));
        const fill = (value: string): string => value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, k: string) => String(inputs.get(k) ?? ""));
        const steps = book.steps.map((step, index) => [`${index + 1}. ${step.title || step.kind}`, step.command && fill(step.command), step.prompt && fill(step.prompt), step.expected && fill(step.expected)].filter(Boolean).join("\n"));
        prompt = [prompt, `Follow the runbook "${book.name}" on the selected server.`, ...steps].join("\n");
      }
      if (schedule.quietSentinel) prompt += "\nOnly answer HEARTBEAT_OK if the available evidence confirms normal operation. Explain any problem or missing evidence.";

      const id = await this.openUnattendedTerminal(schedule, `Schedule: ${schedule.title}`);
      opened = id;
      if (!schedule.enabled || !this.store.data.schedules.includes(schedule)) {
        this.closeOwnTerminal(id);
        return undefined;
      }
      const task = await this.start(
        {
          prompt,
          sessionId: id,
          mode: schedule.mode,
          maxCommands: schedule.maxCommands,
          maxMinutes: schedule.maxMinutes,
        },
        schedule,
      );
      task.ownTerminal = { via: "schedule", profileId: schedule.profileId, shell: schedule.shell, label: `Schedule: ${schedule.title}` };
      schedule.lastTaskId = task.id;
      schedule.lastStatus = "Running";
      this.scheduleSessions.set(task.id, id);
      if (!active(task)) this.scheduledRunEnded(task.id);
      return task;
    } catch (e) {
      schedule.lastStatus = `Blocked: ${safeError(e)}`;
      this.notify("Scheduled task blocked", schedule.title);
      // A run that never started leaves no terminal behind.
      if (opened) this.closeOwnTerminal(opened);
      return undefined;
    } finally {
      this.scheduleStarts.delete(schedule.id);
    }
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleSchedules(this: HubService, request: RequestsOf<"schedules">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "schedule-save": {
        const s = request.schedule;
        if (
          !SHELL_KINDS.includes(s.shell) ||
          !["advice", "plan", "assisted", "autonomous"].includes(s.mode) ||
          !["anthropic", "openai-compatible", "openai-codex"].includes(
            s.provider,
          )
        )
          throw new Error("Invalid schedule");
        const id = s.id || crypto.randomUUID();
        const previous = this.store.data.schedules.find((item) => item.id === id);
        const now = Date.now();
        const cron = s.cron?.trim();
        if (s.cron !== undefined && !cron) throw new Error("Enter a cron expression.");
        const timezone = cron ? s.timezone?.trim() || "UTC" : undefined;
        const cronNext = cron ? nextCronTime(cron, timezone!, now) : undefined;
        if (s.missedPolicy && !["skip", "run_once"].includes(s.missedPolicy)) throw new Error("Unknown missed run policy.");
        if (s.eventTrigger && (!["facts_drift", "unreachable", "alert"].includes(s.eventTrigger.kind) ||
            (s.eventTrigger.cooldownMinutes !== undefined && (!Number.isInteger(s.eventTrigger.cooldownMinutes) || s.eventTrigger.cooldownMinutes < 1 || s.eventTrigger.cooldownMinutes > 1440)))) throw new Error("Invalid event trigger or cooldown.");

        const schedule: AgentSchedule = {
          ...s,
          id,
          title: clip(requiredText(s.title), 200),
          prompt: boundedPrompt(requiredText(s.prompt), PERSON_PROMPT_MAX),
          profileId: requiredText(s.profileId),
          model: requiredText(s.model),
          intervalMinutes: integer(s.intervalMinutes, 1, 525600),
          maxCommands: integer(s.maxCommands, 1, 100),
          maxMinutes: integer(s.maxMinutes, 1, 120),
          cron,
          timezone,
          cronTimingVersion: cron ? 1 : undefined,
          lastTaskId: previous?.lastTaskId,
          lastStatus: previous?.lastStatus,
          lastEventAt: previous?.lastEventAt,
          nextRunAt: cronNext !== undefined
            ? previous?.enabled && previous.cron === cron && previous.timezone === timezone && previous.cronTimingVersion === 1 ? previous.nextRunAt : cronNext
            : Number.isFinite(s.nextRunAt) ? s.nextRunAt : now + integer(s.intervalMinutes, 1, 525600) * 60_000,
        };
        if (previous) this.store.data.schedules[this.store.data.schedules.indexOf(previous)] = schedule;
        else this.store.data.schedules.push(schedule);
        break;
      }
      case "schedule-run-now": {
        let schedule = this.store.data.schedules.find((x) => x.id === request.id);
        // The demo lab's example jobs are listed without being kept: running one makes it a job of this installation.
        const example = !schedule && isDemoMode() ? getDemoSchedules().find((x) => x.id === request.id) : undefined;
        if (example) this.store.data.schedules.push((schedule = { ...example }));
        if (!schedule) throw new Error("That job is not here any more.");
        if (!schedule.enabled) throw new Error("This job is paused. Resume it first.");
        if (this.scheduleInProgress(schedule)) throw new Error("Its last run is still going.");
        // Once, now: when it next runs by itself stays as it was.
        const task = await this.launchSchedule(schedule);
        reply = task ? { started: { taskId: task.id }, notes: [`Started "${clip(schedule.title, 120)}".`] } : { notes: [schedule.lastStatus ?? "It could not be started."] };
        break;
      }
      case "schedule-delete":
        this.store.data.schedules = this.store.data.schedules.filter(
          (s) => s.id !== request.id,
        );
        if (isDemoMode()) {
          this.markBuiltinDismissed(request.id, getDemoSchedules());
        }
        break;
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return reply ? { reply } : {};
  }
}
