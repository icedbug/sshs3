import crypto from "node:crypto";
import type { HubReply, AgentSchedule, AgentTask } from "../../../../shared/types/aiHub";
import { SHELL_KINDS } from "../../../../shared/types/aiHub";
import { getDemoSchedules, isDemoMode } from "../demoWorkspace";
import { boundedPrompt, clip, PERSON_PROMPT_MAX, safeError } from "../privacy";
import { requiredText, integer } from "../hubHelpers";
import { active } from "../hubShared";
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
export class SchedulesPart {
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
    const schedule = this.store.data.schedules.find((s) => s.lastTaskId === taskId);
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!schedule || !task || active(task)) return;
    const at = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    schedule.lastStatus =
      task.status === "completed"
        ? `Completed at ${at}${task.verification === "verified" ? ", verified" : ""}`
        : `${task.status === "failed" ? "Failed" : "Stopped"} at ${at}${task.error ? `: ${clip(task.error, 160)}` : ""}`;
    if (task.status !== "completed") this.notify("Scheduled task did not finish", schedule.title);
  }

  /** Starts one run of a scheduled job: when it falls due, and when somebody asks for it now. */
  async launchSchedule(this: HubService, schedule: AgentSchedule): Promise<AgentTask | undefined> {
    let opened: string | undefined;
    try {
      const id = await this.openUnattendedTerminal(schedule, `Schedule: ${schedule.title}`);
      opened = id;
      const task = await this.start(
        {
          prompt: schedule.prompt,
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
      return task;
    } catch (e) {
      schedule.lastStatus = `Blocked: ${safeError(e)}`;
      this.notify("Scheduled task blocked", schedule.title);
      // A run that never started leaves no terminal behind.
      if (opened) this.closeOwnTerminal(opened);
      return undefined;
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
          nextRunAt: Number.isFinite(s.nextRunAt)
            ? s.nextRunAt
            : Date.now() + 60_000,
        };
        this.store.data.schedules = this.store.data.schedules.filter(
          (x) => x.id !== id,
        );
        this.store.data.schedules.push(schedule);
        break;
      }
      case "schedule-run-now": {
        let schedule = this.store.data.schedules.find((x) => x.id === request.id);
        // The demo lab's example jobs are listed without being kept: running one makes it a job of this installation.
        const example = !schedule && isDemoMode() ? getDemoSchedules().find((x) => x.id === request.id) : undefined;
        if (example) this.store.data.schedules.push((schedule = { ...example }));
        if (!schedule) throw new Error("That job is not here any more.");
        if (!schedule.enabled) throw new Error("This job is paused. Resume it first.");
        if (schedule.lastTaskId && this.store.data.tasks.some((t) => t.id === schedule.lastTaskId && active(t))) throw new Error("Its last run is still going.");
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
