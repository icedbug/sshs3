import crypto from "node:crypto";
import type { EvalRun, AgentTask, WorkTicket, WorkspaceServerSummary } from "../../../../shared/types/aiHub";
import { buildDailyReport } from "../DailyReport";
import {
  Replay,
  caseFromTask,
  evalRun,
  judgePrompt,
  normalizeExpectation,
  parseRubricJudgement,
  promoteEvalFailureToIncident,
  ruleChecks,
} from "../EvalSuite";
import { getDemoTasks, isDemoMode } from "../demoWorkspace";
import { type ExtraWorkspaceContext } from "../ContextService";
import { boundedContext, clip, safeError } from "../privacy";
import { live } from "../WorkBoard";
import { log, active, isBackgroundRun } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * Tests for the agents, and the nightly upkeep with its daily report.
 *
 * A test case is a recorded question with what a person said should happen; running it puts the
 * question to the agent as it is now. The nightly upkeep tidies memory, looks for contradictions and
 * writes the day's report.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class EvalsPart {
  /**
   * A test case is replayed against the question as it was asked. What tells about the present
   * moment is left out of what the replay is given: activity after the case was made, how the
   * servers stand now, what changed on them lately and what the open terminals show. Otherwise a
   * case made before a fix fails after it, whatever the agent does: it is told the fault is over.
   * Memory and the pages stay: they are what a test is run to try. The servers are the ones the
   * workspace had when the case was made, where the case holds that list; a case without one is
   * replayed with today's servers, and its result says so (`serverList`).
   */
  asOfEvalCase(this: HubService, task: AgentTask, extra: ExtraWorkspaceContext): ExtraWorkspaceContext {
    if (!task.evalCaseId) return extra;
    const found = (this.store.data.evalCases ?? []).find((c) => c.id === task.evalCaseId);
    const asOf = found?.createdAt ?? 0;
    return {
      ...extra,
      ...(found?.servers ? { workspaceServers: found.servers as WorkspaceServerSummary[] } : {}),
      asOf,
      activityLog: (extra.activityLog ?? this.store.data.activityLog ?? []).filter((a) => a.at <= asOf),
      recentServerChanges: [],
      serverFactsNow: [],
      workforceRuns: [],
    };
  }
  /**
   * Once a day, after three in the morning and while nothing of the user's is
   * running: memory is tidied, pages are compared for contradictions, and the
   * day's report is written. With a team bucket one installation does it for
   * the team.
   */
  async nightly(this: HubService, now = Date.now()): Promise<void> {
    const at = new Date(now);
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
    if (this.nightlyRunning || this.store.data.lastNightlyDay === day || at.getHours() < 3 || isDemoMode()) return;
    if (this.store.data.tasks.some((t) => active(t) && !isBackgroundRun(t))) return;
    this.nightlyRunning = true;
    try {
      const sync = this.work();
      const client = this.clientId();
      // The team's upkeep (tidying team memory, fetching the knowledge base's links again, looking for
      // contradictions) is done once a day by one installation: a mark that stays for the day, not a
      // lease that lapses after four minutes and lets the next one do it all again.
      // The chat agent's hub never does it: it is not an installation of the team's, and it would take
      // the day's mark from one that is.
      const mine = this.host.serviceAccount
        ? false
        : sync
          ? await sync.markOnce(`nightly-${day}`, client, this.notifySettle, now).catch(() => false)
          : true;
      this.store.data.lastNightlyDay = day;
      if (mine) {
        await sync?.pruneMarks(14 * 24 * 60 * 60_000, now).catch(() => undefined);
        await this.request({ action: "self-learn-reflect" }).catch((e) => log.warn("Nightly tidy failed", safeError(e)));
        await this.refetchWatchedSources(now).catch((e) => log.warn("Fetching the knowledge base's links again failed", safeError(e)));
        await this.checkContradictions().catch((e) => log.warn("Nightly contradiction check failed", safeError(e)));
      }
      // The report is each installation's own: since its last one, however long the computer was off.
      const extra = await this.collectExtraContext();
      const snap = await this.snapshot();
      const since = this.store.data.dailyReport?.at ?? now - 24 * 60 * 60_000;
      this.store.data.dailyReport = {
        day,
        at: Date.now(),
        text: buildDailyReport({
          since,
          now,
          activity: extra.activityLog ?? this.store.data.activityLog ?? [],
          tickets: live(this.store.data.workTickets),
          tasks: this.store.data.tasks,
          pages: this.store.data.kbPages ?? [],
          memories: extra.memories ?? this.store.data.memories,
          findings: snap.kbFindings ?? [],
          serverChanges: this.recentServerChanges(Math.max(24 * 3_600_000, now - since), now).flatMap((r) => r.lines).sort().reverse(),
          serverProblems: this.factsStore.all().flatMap((r) => this.factsProblems(r, now).map((p) => `${r.name}: ${p.text}`)),
        }),
      };
      await this.store.save().catch(() => undefined);
      this.changed();
    } finally {
      this.nightlyRunning = false;
    }
  }

  // ---- tests for the agents --------------------------------------------------

  /**
   * Replays test cases one after the other. Each is the recorded question put
   * to the agent as it is now, with the tools answering from the recording;
   * the answer is checked against what a person said should happen.
   */
  async runEvalCases(this: HubService, ids: string[]): Promise<void> {
    try {
      for (const [at, id] of ids.entries()) {
        const found = (this.store.data.evalCases ?? []).find((c) => c.id === id);
        if (!found || this.disposed) continue;
        this.evalRunningId = id;
        this.changed();
        const replay = new Replay(found.recorded);
        let run: EvalRun;
        try {
          const task = await this.start(
            { prompt: found.prompt, mode: found.mode, agentId: found.agentId, maxCommands: 40, maxMinutes: 10 },
            undefined,
            { evalCaseId: id, title: `Test · ${clip(found.title, 80)}`, mainModel: true },
            replay,
          );
          await this.whenSettled(task);
          const answer = [...task.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text ?? "";
          const checks = ruleChecks(found.expect, answer, task.toolLog ?? [], { unrecorded: replay.unrecorded });
          let verdict: ReturnType<typeof parseRubricJudgement>;
          let judgeError: string | undefined;
          if (found.expect.conclusion && task.status === "completed" && answer) {
            const judge = await this.runBackground(
              { prompt: judgePrompt(found, answer, task.toolLog), mode: "advice", agentName: "Tests", maxCommands: 1, maxMinutes: 5 },
              { distillSourceId: `eval:${id}:${Date.now()}`, title: `Judging · ${clip(found.title, 80)}`, mainModel: true },
            );
            verdict = parseRubricJudgement(judge.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "");
            if (judge.status === "completed" && verdict) checks.push(verdict.check);
            else judgeError = "The test judge did not return a result.";
          }
          run = evalRun({ task, checks, unrecorded: replay.unrecorded, live: replay.live, rubricScores: verdict?.scores, failureModes: verdict?.failureModes });
          if (judgeError) run = { ...run, passed: false, inconclusive: judgeError };
          // Said with the result: this replay saw today's servers, not the ones of the day the case was made.
          if (!found.servers) run = { ...run, serverList: "today" };
        } catch (error) {
          run = {
            at: Date.now(),
            passed: false,
            // It never started: that says nothing about the agent.
            inconclusive: safeError(error),
            checks: [],
            answer: "",
            calls: [],
            unrecorded: replay.unrecorded,
            live: replay.live,
            tokens: 0,
          };
        }
        const current = (this.store.data.evalCases ?? []).find((c) => c.id === id);
        if (current) {
          current.runs = [run, ...current.runs].slice(0, 5);
          current.updatedAt = Date.now();
          this.lastWorkSync = 0;
        }
        // The result and "which case is running" change in one step: nobody is shown a case that has
        // its result and is still said to be running.
        this.evalRunningId = ids[at + 1];
        await this.store.save().catch(() => undefined);
        this.changed();
      }
    } finally {
      this.evalRunningId = undefined;
      this.changed();
    }
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleEvals(this: HubService, request: RequestsOf<"evals">): Promise<Handled> {
    switch (request.action) {
      case "eval-case-save": {
        const cases = this.store.data.evalCases ?? [];
        const existing = cases.find((c) => c.id === request.id);
        if (existing) {
          existing.title = boundedContext(request.title?.trim() || existing.title, 160);
          // Only the parts that were sent: the others stay as they are.
          if (request.expect) existing.expect = normalizeExpectation({ ...existing.expect, ...request.expect });
          existing.updatedAt = Date.now();
        } else {
          // The demo lab's example conversations are listed without being kept: they are found where they come from.
          const from = this.store.data.tasks.find((t) => t.id === request.fromTaskId) ?? (isDemoMode() ? getDemoTasks().find((t) => t.id === request.fromTaskId) : undefined);
          if (!from) throw new Error("That conversation is not on this computer any more.");
          if (active(from)) throw new Error("Wait until the conversation has ended.");
          const made = caseFromTask(from, { title: request.title, expect: request.expect }, await this.resolveActorName());
          // The servers as they are now go with the test: a replay is told about these, not about
          // whatever the workspace holds on the day it is run. A list with a server from a Team Vault
          // is not kept: a test is shared with the team, and what comes from the vault is not.
          const servers = (await this.collectExtraContext().catch(() => undefined))?.workspaceServers;
          if (servers && !servers.some((server) => server.fromVault))
            made.servers = servers.slice(0, 500).map(({ id, name, host, port, username, cluster, tags, description, nodeRole, role }) => ({
              id, name, host, port, username,
              ...(cluster ? { cluster } : {}), ...(tags ? { tags } : {}), ...(description ? { description } : {}),
              ...(nodeRole ? { nodeRole } : {}), ...(role ? { role } : {}),
            }));
          this.store.data.evalCases = [...cases, made];
        }
        this.lastWorkSync = 0;
        break;
      }
      case "eval-case-delete":
        this.store.data.evalCases = (this.store.data.evalCases ?? []).filter((c) => c.id !== request.id);
        this.markSharedRemoved("evals", request.id);
        break;
      case "eval-run": {
        const ids = (this.store.data.evalCases ?? []).filter((c) => !request.id || c.id === request.id).map((c) => c.id);
        if (ids.length === 0) throw new Error("There is no such test case.");
        if (this.evalRunningId) throw new Error("Test cases are already running.");
        void this.runEvalCases(ids).catch((e) => log.warn("Running test cases failed", safeError(e)));
        break;
      }
      case "daily-report-read":
        if (this.store.data.dailyReport) this.store.data.dailyReport.readAt = Date.now();
        break;
      case "promote-eval": {
        const task = this.task(request.taskId);
        // Promoted once: a second click (or a retried request) finds the ticket it already made.
        const promoted = live(this.store.data.workTickets).find(
          // The promotion's summary is how such a ticket begins (promoteEvalFailureToIncident).
          (t) => t.taskId === task.id && t.status !== "done" && Boolean(t.description?.startsWith('Eval "')),
        );
        if (promoted) break;
        const existingCase = (this.store.data.evalCases ?? []).find(
          (c) => c.id === task.evalCaseId || c.fromTaskId === task.id,
        );
        const failedStoredRun = existingCase?.runs.find((r) => !r.passed && !r.inconclusive);
        const promptText =
          existingCase?.prompt ||
          task.messages.find((m) => m.role === "user")?.text ||
          task.title;
        const targetRun = failedStoredRun ?? {
          passed: task.status === "completed" && !task.error && !task.changes.some((c) => c.status === "failed"),
          inconclusive: task.status === "interrupted" && !task.error ? "Interrupted before completion" : undefined,
          checks: [
            {
              name: "task-execution",
              passed: task.status === "completed" && !task.error,
              detail: task.error || `Task ended with status "${task.status}"`,
            },
          ],
          answer: [...task.messages].reverse().find((m) => m.role === "assistant")?.text ?? "",
        };
        const promotion = promoteEvalFailureToIncident(
          {
            id: existingCase?.id ?? task.id,
            title: existingCase?.title ?? task.title,
            prompt: promptText,
            fromTaskId: existingCase?.fromTaskId ?? task.id,
          },
          targetRun,
          { title: request.title },
        );
        const actor = await this.resolveActorName();
        const now = Date.now();
        const ticket: WorkTicket = {
          id: `t-${crypto.randomUUID().slice(0, 8)}`,
          title: promotion.title,
          description: promotion.summary,
          status: "todo",
          ...(task.target?.label ? { target: task.target.label } : {}),
          ...(task.agentId ? { assigneeAgentId: task.agentId, assigneeName: task.agentName } : {}),
          taskId: task.id,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
        };
        this.putTicket(ticket);
        break;
      }
      default: {
        // Every request of this part has a case above: one that is given to it and not handled does not compile.
        const unhandled: never = request;
        throw new Error(`Unknown AI request: ${String((unhandled as { action?: unknown })?.action)}`);
      }
    }
    return {};
  }
}
