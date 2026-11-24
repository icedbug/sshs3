import crypto from "node:crypto";
import { app } from "electron";
import type {
  AgentPlan,
  ExternalRunner,
  HubReply,
  AgentSchedule,
  AgentTask,
  MissionAgent,
  StartAgentTask,
  WorkforceRun,
} from "../../../../shared/types/aiHub";
import { probeRunner, runnerEnvNames } from "../AcpRuntime";
import { deleteDemoAgent, getBuiltinAgents, getDemoWorkforceRuns, isDemoMode, saveDemoAgent } from "../demoWorkspace";
import { boundedContext, boundedPrompt, clip, PERSON_PROMPT_MAX, safeError } from "../privacy";
import { runWorkforce } from "../WorkforceRunner";
import {
  WORKFORCE_TEMPLATES,
  mergeCopies,
  stampChange,
  removedMessage,
  addUsage,
  withComment,
  live,
  tokensLeft,
  wouldCycle,
} from "../WorkBoard";
import { parseReview, reviewerPrompt } from "../PlanMode";
import { applyHandoff as applyDisciplinedHandoff, checkHandoffAllowed } from "../AgentDiscipline";
import { requiredText, integer } from "../hubHelpers";
import { log, AGENT_FIELD_GROUPS, active, investigatorPrompt, renderWorkforceProgress } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * Agents and the workforce.
 *
 * The team's agents (saving, pausing, removing), external agents' runners, and the runs the hub starts
 * for them: a workforce run with its specialists, a read-only specialist, a plan's reviewer and the
 * investigators an agent hands questions to.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
/**
 * How many investigators of one asking run work at the same time. Each is a model run with a
 * terminal of its own on the target: a question list of forty opened forty of both at once.
 */
export const MAX_PARALLEL_INVESTIGATORS = 4;

export class AgentsPart {
  // Built-ins depend on the mode (demoWorkspace getBuiltin*): the demo workspace's fixtures in demo mode,
  // otherwise the neutral defaults of builtins.ts. They are merged in here, never stored.
  getAgentsList(this: HubService): MissionAgent[] {
    const stored = this.store.data.agents ?? [];
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    const builtins = getBuiltinAgents();
    return [
      ...stored,
      ...builtins.filter(
        (ba) => !dismissed.has(ba.id) && !stored.some((a) => a.id === ba.id),
      ),
    ];
  }

  getWorkforceRunsList(this: HubService): WorkforceRun[] {
    const stored = this.store.data.workforceRuns ?? [];
    if (!isDemoMode()) return stored;
    const dismissed = new Set(this.store.data.preferences.dismissedBuiltinIds ?? []);
    return [
      ...stored,
      ...getDemoWorkforceRuns().filter(
        (dw) => !dismissed.has(dw.id) && !stored.some((w) => w.id === dw.id),
      ),
    ];
  }

  /** The Mission Agents a workforce request addresses (ids/names, else the cluster's, else all enabled). */
  selectWorkforceAgents(this: HubService, opts: {
    agentIds?: string[];
    targetCluster?: string;
  }): MissionAgent[] {
    const allAgents = this.getAgentsList().filter((a) => a.enabled !== false);
    if (opts.agentIds && opts.agentIds.length > 0) {
      const qList = opts.agentIds.map((x) => x.toLowerCase());
      const filtered = allAgents.filter((a) =>
        qList.some(
          (q) =>
            // By id or exact name only: "db" must not also start "db-backup".
            a.id.toLowerCase() === q || a.name.toLowerCase() === q,
        ),
      );
      // Named agents that are all paused or unknown: nobody runs, rather than everybody.
      if (filtered.length === 0)
        throw new Error(`None of ${opts.agentIds.join(", ")} can run: they are paused, or there is no agent by that name.`);
      return filtered.filter((a) => tokensLeft(a, this.usageTotal()) > 0);
    } else if (opts.targetCluster && opts.targetCluster !== "ALL") {
      const cl = opts.targetCluster.toLowerCase();
      const clusterMatched = allAgents.filter(
        (a) => a.targetCluster && a.targetCluster.toLowerCase().includes(cl),
      );
      if (clusterMatched.length > 0) {
        return [
          ...clusterMatched,
          ...allAgents.filter((a) => !clusterMatched.includes(a)).slice(0, 2),
        ];
      }
    }
    return allAgents.filter((a) => tokensLeft(a, this.usageTotal()) > 0);
  }

  /**
   * The conversation changes hands with a handoff packet that is checked first: never back to an
   * agent that already had it. There is no limit on how many times it is handed on
   * (MAX_HANDOFF_HOPS in AgentDiscipline.ts).
   */
  applyHandoff(this: HubService,
    task: AgentTask,
    toAgent: MissionAgent,
    reason?: string,
    options?: { allowCycle?: boolean },
  ): void {
    const res = applyDisciplinedHandoff(task, toAgent, reason, undefined, options);
    if (!res.ok) {
      task.handoffTo = undefined;
      task.updatedAt = Date.now();
      task.messages.push({
        id: crypto.randomUUID(),
        role: "system",
        text: res.error,
        at: Date.now(),
      });
    }
  }

  /**
   * An external agent's runner is a program started on this machine as the app's own account, like a
   * stdio MCP server: on a shared server only an administrator adds or starts one. Asked on save and on every start.
   */
  assertRunnerAllowed(this: HubService): void {
    if (this.sharedServer() && !this.host.teamAdmin?.())
      throw new Error("An external agent runs as a program on the shared server itself. Only an administrator of this server adds or starts one.");
  }

  /** Paused means paused, and a spent budget is spent: however an agent is started. */
  assertMayRun(this: HubService, agent: MissionAgent): void {
    if (agent.enabled === false) throw new Error(`${agent.name} is paused. Switch it on again before starting it.`);
    if (tokensLeft(agent, this.usageTotal()) <= 0)
      throw new Error(`${agent.name} has used its token budget for this month. Raise it or wait for the new month.`);
  }

  storeWorkforceRun(this: HubService, run: WorkforceRun): void {
    this.store.data.workforceRuns = [
      run,
      ...(this.store.data.workforceRuns ?? []).filter((r) => r.id !== run.id),
    ].slice(0, 25);
  }

  /**
   * Starts a workforce run: every selected Mission Agent investigates the
   * objective in its own read-only model run, then one more run combines the
   * reports. `run` is the live record (already stored); `done` settles when the
   * whole run has ended. Without a reachable model the specialists fail with the
   * provider's error — nothing is written on their behalf.
   *
   * Demo mode alone plays the scripted demo run instead (marked `simulated`).
   */
  async beginWorkforceRun(this: HubService, opts: {
    prompt: string;
    agentIds?: string[];
    targetCluster?: string;
    createTask?: boolean;
  }): Promise<{ run: WorkforceRun; done: Promise<WorkforceRun> }> {
    if (isDemoMode()) {
      const run = await this.simulateDemoWorkforceRun(opts);
      return { run, done: Promise.resolve(run) };
    }
    if (!(await this.config.getConfig()).enabled)
      throw new Error("No model is set up. Switch the assistant on and choose a model in AI settings first.");

    let lead: AgentTask | undefined;
    if (opts.createTask) {
      const now = Date.now();
      lead = {
        id: crypto.randomUUID(),
        title: `Workforce: ${clip(opts.prompt, 90)}`,
        agentName: "Workforce lead",
        mode: "advice",
        status: "running",
        messages: [
          {
            id: crypto.randomUUID(),
            role: "user",
            text: boundedPrompt(opts.prompt, PERSON_PROMPT_MAX),
            at: now,
          },
          { id: crypto.randomUUID(), role: "assistant", text: "", at: now },
        ],
        changes: [],
        sources: [],
        createdAt: now,
        updatedAt: now,
        maxCommands: 1,
        maxMinutes: 30,
        verification: "not-verified",
      };
      this.store.data.tasks.push(lead);
    }

    let current: WorkforceRun | undefined;
    const done = runWorkforce(
      {
        prompt: opts.prompt,
        agents: this.selectWorkforceAgents(opts),
        targetCluster: opts.targetCluster,
      },
      {
        cancelled: () => this.disposed || (lead ? !active(lead) : false),
        runSpecialist: (input) => this.runReadOnlySpecialist(input),
        onProgress: (run) => {
          current = run;
          this.storeWorkforceRun(run);
          if (lead) {
            this.workforceLeads.set(run.id, lead.id);
            // A lead the user stopped keeps its "interrupted" state.
            if (active(lead)) {
              lead.messages[1].text = renderWorkforceProgress(run);
              lead.updatedAt = Date.now();
              if (run.status !== "running") {
                lead.status = run.status;
                lead.error = run.error;
                if (run.status === "failed") lead.verification = "incomplete";
              }
            }
          }
          if (run.status !== "running") this.workforceLeads.delete(run.id);
          this.changed();
        },
      },
    );
    // runWorkforce reports its initial state before its first await.
    return { run: current!, done };
  }

  /**
   * Starts one of the hub's own background runs and waits for it to end. A
   * run that fails on the fast model (not served by this endpoint, overloaded,
   * declined) is run once more on the main model, so setting a fast model can
   * make background work cheaper but not make it fail.
   */
  async runBackground(this: HubService,
    input: StartAgentTask,
    tag: {
      workforceRunId?: string;
      distillSourceId?: string;
      title: string;
      mainModel?: boolean;
      modelRole?: "backgroundDistill";
      investigator?: boolean;
    },
  ): Promise<AgentTask> {
    const task = await this.start(input, undefined, tag);
    await this.whenSettled(task);
    if (task.status !== "failed") return task;
    const config = await this.config.getConfig().catch(() => undefined);
    const role = task.distillSourceId ? "backgroundDistill" : "fastTriage";
    // Named profiles have their own permitted fallbacks. Only retry a legacy fast model here.
    if (task.mainModelOnly || config?.activeProfileByRole?.[role] || !config?.fastModel || task.model !== config.fastModel) return task;
    log.warn("Background run failed on the fast model; trying the main model", safeError(task.error));
    const again = await this.start(input, undefined, { ...tag, mainModel: true });
    await this.whenSettled(again);
    return again;
  }

  /**
   * One read-only model run to its end (context, knowledge base, remote files;
   * no terminal, no management tool), and what it answered. Used by workforce
   * reviews and by an agent's own investigations.
   */
  async runReadOnlySpecialist(this: HubService, input: {
    runId: string;
    prompt: string;
    agent?: MissionAgent;
    agentName: string;
    /** A terminal of the run's own: it then runs commands there, told to only look. Nothing checks them. */
    sessionId?: string;
    /** Work that needs the main model's judgment even when a fast model is set. */
    mainModel?: boolean;
  }): Promise<{
    taskId?: string;
    status: "completed" | "failed";
    text: string;
    error?: string;
  }> {
    const task = await this.runBackground(
      {
        prompt: input.prompt,
        mode: "advice",
        agentId: input.agent?.id,
        agentName: input.agentName,
        sessionId: input.sessionId,
        maxCommands: input.sessionId ? 15 : 1,
        maxMinutes: 10,
      },
      {
        workforceRunId: input.runId,
        investigator: Boolean(input.sessionId),
        title: `${input.agentName} · read-only`,
        ...(input.mainModel ? { mainModel: true } : {}),
      },
    );
    // A run that looked on behalf of a chat conversation is paid from the chat's budget: its tokens
    // are added to that conversation's, apart from its own usage. Found now, while the run's lead is known.
    const lead = this.chatLead(task);
    if (lead && lead !== task) {
      const used = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0);
      if (used > 0) lead.chatBackgroundTokens = (lead.chatBackgroundTokens ?? 0) + used;
    }
    const text =
      task.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
    return task.status === "completed"
      ? { taskId: task.id, status: "completed", text }
      : {
          taskId: task.id,
          status: "failed",
          text,
          error: task.error ?? `The run ended as ${task.status}.`,
        };
  }

  /**
   * Has a plan reviewed by a second, read-only run before the user sees it.
   * The reviewer has none of the planning agent's conversation, only the plan
   * and the request, and checks it against the workspace. It runs on the main
   * model: this is judgment, not reading. A review that cannot be had is
   * reported as `unreviewed`, never as an approval.
   */
  async reviewPlan(this: HubService,
    task: AgentTask,
    plan: Parameters<typeof reviewerPrompt>[0],
  ): Promise<AgentPlan["review"]> {
    const request =
      task.messages.filter((m) => m.role === "user").at(-1)?.text ?? task.title;
    const runId = `plan-${crypto.randomUUID().slice(0, 8)}`;
    // The reviewer of a plan asked for from chat reads for that conversation: its fence holds for it too.
    const fenced = Boolean(this.chatLead(task));
    if (fenced) this.workforceLeads.set(runId, task.id);
    try {
      const result = await this.runReadOnlySpecialist({
        runId,
        prompt: reviewerPrompt(plan, request),
        agentName: "Plan reviewer",
        mainModel: true,
      });
      if (result.status !== "completed" || !result.text.trim())
        return {
          verdict: "unreviewed",
          findings: [
            `The review could not be done: ${result.error ?? "the reviewer gave no answer"}. This plan has not been reviewed.`,
          ],
        };
      return parseReview(result.text);
    } catch (error) {
      return {
        verdict: "unreviewed",
        findings: [
          `The review could not be done: ${safeError(error)}. This plan has not been reviewed.`,
        ],
      };
    } finally {
      if (fenced) this.workforceLeads.delete(runId);
    }
  }

  /**
   * An agent hands questions to investigators that only look, in
   * parallel (MAX_PARALLEL_INVESTIGATORS at a time; further questions wait
   * for one to finish) and gets their reports
   * back together. Each investigator is a model run of its own with a fresh
   * context, so the asking agent's context is spent on the answers, not on the
   * reading. A question whose investigator fails comes back with the error.
   */
  async investigate(this: HubService,
    parent: AgentTask,
    questions: Array<{ question: string; scope?: string }>,
  ): Promise<
    Array<{ question: string; status: "answered" | "failed"; report: string }>
  > {
    const asked = questions;
    const runId = `inv-${crypto.randomUUID().slice(0, 8)}`;
    const results = new Array<{
      question: string;
      status: "answered" | "failed";
      report: string;
    }>(asked.length);
    let next = 0;
    // Its investigators belong to the asking run: stopping it stops them (stop() follows workforceLeads).
    this.workforceLeads.set(runId, parent.id);
    // And they spend for it: its agent's monthly budget holds for them while they work.
    this.investigations.set(runId, parent.id);
    const worker = async (): Promise<void> => {
      while (next < asked.length) {
        const index = next++;
        const { question, scope } = asked[index];
        if (this.disposed || !active(parent)) {
          results[index] = {
            question,
            status: "failed",
            report: "Not started: the asking run was stopped.",
          };
          continue;
        }
        // A terminal of its own on the same target, so it can look for itself. Where
        // one cannot be opened (the target needs an interactive login) it works from what is known.
        const sessionId = await this.openInvestigatorTerminal(parent);
        try {
          const result = await this.runReadOnlySpecialist({
            runId,
            prompt:
              investigatorPrompt(question, scope, parent.title) +
              (sessionId
                ? "\n\nYou have a terminal of your own on the target. A command runs there at once and nothing checks it, so run only commands that read (state, logs, configuration). You only look. Change nothing. Say which command showed what."
                : "\n\nNo terminal could be opened for you on the target, so you cannot run commands: work from the workspace's context and the knowledge base, and say what would have to be checked on the system."),
            agentName: `Investigator ${index + 1}`,
            sessionId,
          }).finally(() => {
            if (sessionId) this.closeOwnTerminal(sessionId);
          });
          results[index] =
            result.status === "completed" && result.text.trim()
              ? {
                  question,
                  status: "answered",
                  report: clip(result.text, 12_000),
                }
              : {
                  question,
                  status: "failed",
                  report: result.error ?? "The investigator ended without a report.",
                };
        } catch (error) {
          results[index] = { question, status: "failed", report: safeError(error) };
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(asked.length, MAX_PARALLEL_INVESTIGATORS) }, () => worker()),
      );
    } finally {
      this.workforceLeads.delete(runId);
      this.investigations.delete(runId);
      // What the investigators spent is the asking agent's spending.
      if (parent.agentId) {
        const used = this.store.data.tasks
          .filter((t) => t.workforceRunId === runId)
          .reduce((sum, t) => sum + (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0), 0);
        if (used > 0) this.store.data.agentUsage = addUsage(this.store.data.agentUsage ?? {}, parent.agentId, used);
      }
    }
    return results;
  }

  /**
   * Opens a terminal of the hub's own on a saved target and connects to it at
   * its prompt: for a run nobody is sitting at (a schedule, a ticket the
   * heartbeat took, an investigator). The one way such a terminal is made
   * ready, so that a run is never started on one that cannot run anything.
   * A terminal that does not get to a prompt is closed again, and the error
   * says what it last showed.
   */
  async openUnattendedTerminal(this: HubService,
    target: { profileId: string; shell: AgentSchedule["shell"] },
    label: string,
  ): Promise<string> {
    const id = await this.host.openSchedule({ profileId: target.profileId, shell: target.shell }, label);
    try {
      await this.terminals.armAtPrompt(id, target.shell);
    } catch (error) {
      this.closeOwnTerminal(id);
      throw error;
    }
    return id;
  }

  /** Opens a terminal for an investigator on the parent's target. Undefined when that is not possible. */
  async openInvestigatorTerminal(this: HubService, parent: AgentTask): Promise<string | undefined> {
    if (isDemoMode() || !parent.target || !this.host.closeSession) return undefined;
    const session = this.terminals.get(parent.target.sessionId);
    if (!session || session.kind === "k8s" || !session.shell) return undefined;
    try {
      return await this.openUnattendedTerminal(
        { profileId: session.kind === "local" ? "local" : (session.profileId ?? ""), shell: session.shell },
        `Investigator: ${clip(parent.target.label.replace(/^(?:Investigator|Schedule|Ticket): /, ""), 80)}`,
      );
    } catch (error) {
      log.info("No terminal for an investigator", safeError(error));
      return undefined;
    }
  }

  /**
   * Creates a template's team (with its reporting lines), goal and first tickets. An agent of the
   * same name that is already there is used as it is and not made a second time: agents are looked
   * up by name, and two of one name would make which one is found a matter of order. Returns the
   * names of the agents that were kept.
   */
  async applyWorkforceTemplate(this: HubService, templateId: string, goalTitle?: string): Promise<string[]> {
    const template = WORKFORCE_TEMPLATES.find((t) => t.id === templateId);
    if (!template) throw new Error("Unknown workforce template");
    const now = Date.now();
    const actor = await this.resolveActorName();
    const sameName = (name: string): MissionAgent | undefined =>
      this.getAgentsList().find((x) => x.name.trim().toLowerCase() === name.trim().toLowerCase());
    const there = new Map(template.team.flatMap((r) => (sameName(r.name) ? [[r.key, sameName(r.name)!] as const] : [])));
    const ids = new Map(
      template.team.map((r) => [r.key, there.get(r.key)?.id ?? `wf-${template.id}-${r.key}-${crypto.randomUUID().slice(0, 6)}`]),
    );
    const agents: MissionAgent[] = template.team.filter((r) => !there.has(r.key)).map((r) => ({
      id: ids.get(r.key)!,
      name: r.name,
      role: r.role,
      icon: "",
      mission: r.mission,
      systemPrompt: r.systemPrompt,
      defaultMode: r.defaultMode,
      reportsTo: r.reportsTo ? ids.get(r.reportsTo) : undefined,
      allowedTools: ["all"],
      enabled: true,
      author: actor,
      updatedAt: now,
    }));
    this.store.data.agents = [...(this.store.data.agents ?? []), ...agents];
    if (isDemoMode()) for (const a of agents) saveDemoAgent(a);
    const goalId = crypto.randomUUID();
    this.putGoal({
      id: goalId,
      title: clip(goalTitle?.trim() || template.goal.title, 200),
      description: template.goal.description,
      status: "active",
      author: actor,
      createdAt: now,
      updatedAt: now,
    });
    template.tickets.forEach((t, i) => {
      const agent = agents.find((a) => a.id === ids.get(t.role)) ?? there.get(t.role);
      this.putTicket({
        id: `t-${crypto.randomUUID().slice(0, 8)}`,
        title: t.title,
        description: t.description,
        goalId,
        status: t.status,
        assigneeAgentId: agent?.id,
        assigneeName: agent?.name,
        createdBy: actor,
        createdAt: now + i,
        updatedAt: now + i,
      });
    });
    if (agents.length) this.scheduleWorkSync();
    return [...there.values()].map((a) => a.name);
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleAgents(this: HubService, request: RequestsOf<"agents">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "agent-save": {
        const a = request.agent;
        const id = a.id?.trim() || crypto.randomUUID();
        const localHad = (this.store.data.agents ?? []).find((x) => x.id === id);
        // The team's copy as it is now: an agent a teammate removed is not saved back from an old view.
        if (a.id?.trim()) await this.pullAgent(id);
        const current = (this.store.data.agents ?? []).find((x) => x.id === id);
        // Removed (here, or by a teammate and synced): a save from a view that still showed it does not bring it back.
        const removedAt = this.store.data.sharedRemoved?.agents?.[id];
        if (a.id?.trim() && !current && removedAt)
          throw new Error(
            removedMessage("This agent", this.store.data.sharedRemovedBy?.agents?.[id], removedAt, "so the change was not saved. Create a new agent to keep it."),
          );
        // Three code paths look an agent up by name. Two agents of one name would make
        // which one they find a matter of order.
        const clash = this.getAgentsList().find(
          (x) => x.id !== id && x.name.trim().toLowerCase() === (a.name ?? "").trim().toLowerCase(),
        );
        if (clash) throw new Error(`There is already an agent called "${clash.name}". Give this one another name.`);
        const actor = a.author?.trim() || (await this.resolveActorName());
        const boss = a.reportsTo && a.reportsTo !== id ? this.getAgentsList().find((x) => x.id === a.reportsTo) : undefined;
        const circle = Boolean(boss) && wouldCycle(this.getAgentsList(), id, boss!.id);
        if (a.reportsTo && (!boss || circle))
          reply = {
            notes: [
              a.reportsTo === id
                ? "An agent cannot report to itself, so no reporting line was saved."
                : !boss
                  ? "The agent this one should report to does not exist, so no reporting line was saved."
                  : `${boss.name} already reports to this agent, directly or through others. The reporting line was not saved, because it would close a circle.`,
            ],
          };
        const fresh: MissionAgent = {
          id,
          name: clip(requiredText(a.name), 120),
          role: clip(a.role?.trim() || "Infrastructure Specialist", 160),
          icon: boundedContext(a.icon?.trim() || "", 16),
          mission: boundedContext(requiredText(a.mission), 2000),
          systemPrompt: boundedContext(a.systemPrompt?.trim() || a.mission, 8000),
          targetCluster: a.targetCluster?.trim() || undefined,
          defaultMode: ["advice", "plan", "assisted", "autonomous"].includes(a.defaultMode)
            ? a.defaultMode
            : "assisted",
          allowedTools: a.allowedTools?.length ? a.allowedTools : ["all"],
          kbDocIds: a.kbDocIds?.filter(Boolean),
          mcpServerIds: a.mcpServerIds?.filter(Boolean),
          modelOverride: a.modelOverride?.trim() || undefined,
          // Which endpoint it was chosen for, so that a change of provider lets it go
          // instead of sending one provider's model name to another's address.
          modelProvider: a.modelOverride?.trim()
            ? (a.modelProvider ?? (await this.config.getConfig().catch(() => undefined))?.provider)
            : undefined,
          enabled: a.enabled ?? true,
          runnerId: a.runnerId?.trim() || undefined,
          reportsTo: boss && !circle ? boss.id : undefined,
          monthlyTokenBudget:
            a.monthlyTokenBudget && a.monthlyTokenBudget > 0
              ? integer(a.monthlyTokenBudget, 1000, 2_000_000_000)
              : undefined,
          updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1),
          author: actor,
        };
        // Which fields changed, and from which version: a teammate's change of another field stays,
        // and a removal made meanwhile stands (the same rule as tickets and goals).
        let saved = stampChange(localHad, fresh);
        if (current && (!localHad || current.updatedAt !== localHad.updatedAt)) {
          saved = mergeCopies(saved, current, AGENT_FIELD_GROUPS);
        }
        this.store.data.agents = [
          ...(this.store.data.agents ?? []).filter((x) => x.id !== id),
          saved,
        ];
        if (isDemoMode()) saveDemoAgent(saved);
        this.scheduleWorkSync();
        break;
      }
      case "agent-delete": {
        const gone = this.getAgentsList().find((a) => a.id === request.id);
        this.store.data.agents = (this.store.data.agents ?? []).filter(
          (a) => a.id !== request.id,
        );
        this.markSharedRemoved("agents", request.id);
        this.store.data.sharedRemovedBy = {
          ...this.store.data.sharedRemovedBy,
          agents: { ...this.store.data.sharedRemovedBy?.agents, [request.id]: await this.resolveActorName() },
        };
        // A ticket that was this agent's is free again, and says so. Left as it was it
        // would sit for ever: nothing would run it, and the board would say it has no assignee.
        for (const ticket of live(this.store.data.workTickets))
          if (ticket.assigneeAgentId === request.id)
            this.putTicket({
              ...withComment(
                ticket,
                "sshS3",
                `${gone?.name ?? "The agent"} was removed, so this ticket has nobody. Assign it to another agent or do it by hand.`,
              ),
              assigneeAgentId: undefined,
              assigneeName: undefined,
            });
        // An agent that reported to it reports to nobody now, rather than to a gap.
        this.store.data.agents = (this.store.data.agents ?? []).map((a) =>
          a.reportsTo === request.id ? stampChange(a, { ...a, reportsTo: undefined, updatedAt: Date.now() }) : a,
        );
        this.store.data.alertRules = (this.store.data.alertRules ?? []).filter((r) => r.agentId !== request.id);
        // Before deleteDemoAgent: in demo mode the built-ins are the demo store's agents.
        this.markBuiltinDismissed(request.id, getBuiltinAgents());
        if (isDemoMode()) deleteDemoAgent(request.id);
        this.scheduleWorkSync();
        break;
      }
      case "agent-pause": {
        if (request.id?.trim()) await this.pullAgent(request.id);
        const agent = this.getAgentsList().find((a) => a.id === request.id);
        if (!agent) {
          const removedAt = this.store.data.sharedRemoved?.agents?.[request.id];
          if (removedAt)
            throw new Error(
              removedMessage("This agent", this.store.data.sharedRemovedBy?.agents?.[request.id], removedAt, "so it could not be paused."),
            );
          throw new Error("Agent not found");
        }
        const saved = stampChange(agent, { ...agent, enabled: !request.paused, updatedAt: Math.max(Date.now(), (agent.updatedAt ?? 0) + 1) });
        this.store.data.agents = [
          ...(this.store.data.agents ?? []).filter((x) => x.id !== saved.id),
          saved,
        ];
        if (isDemoMode()) saveDemoAgent(saved);
        this.scheduleWorkSync();
        break;
      }
      case "runner-save": {
        this.assertRunnerAllowed();
        const r = request.runner;
        const asked = requiredText(r.id);
        const id = asked.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
        // An agent names its runner by this id: one that was typed differently would never match.
        if (id !== asked)
          reply = {
            notes: [
              `The id was saved as "${id}": an id is lowercase letters, digits and "-", at most 40 characters. An agent that uses this runner has to name it "${id}".`,
            ],
          };
        const saved: ExternalRunner = {
          id,
          name: clip(requiredText(r.name), 80),
          command: requiredText(r.command),
          args: (r.args ?? []).map((x) => String(x)).filter(Boolean).slice(0, 40),
          cwd: r.cwd?.trim() || undefined,
          updatedAt: Date.now(),
        };
        // The variables it is given beyond the basics. A save that does not name any (the form in
        // the app has no field for them) keeps the ones it had.
        const env = r.env !== undefined ? runnerEnvNames(r.env) : (this.store.data.externalRunners ?? []).find((x) => x.id === id)?.env;
        if (env?.length) saved.env = env;
        this.store.data.externalRunners = [
          ...(this.store.data.externalRunners ?? []).filter((x) => x.id !== id),
          saved,
        ];
        break;
      }
      case "runner-delete":
        this.store.data.externalRunners = (this.store.data.externalRunners ?? []).filter(
          (x) => x.id !== request.id,
        );
        break;
      case "runner-test": {
        // The program is started, as it would be for a run: the same people may ask for that.
        this.assertRunnerAllowed();
        const runner = (this.store.data.externalRunners ?? []).find((x) => x.id === request.id);
        if (!runner) throw new Error("That external agent is not set up here any more.");
        reply = {
          runnerProbe: {
            id: runner.id,
            // In the web app the program is the server's, not one on the person's own computer.
            ...(await probeRunner(runner, { clientVersion: app?.getVersion?.(), ...(this.hosted() ? { where: "on the server sshS3 runs on" } : {}) })),
          },
        };
        break;
      }
      case "workforce-template-apply": {
        const kept = await this.applyWorkforceTemplate(request.templateId, request.goalTitle);
        if (kept.length)
          reply = {
            notes: [
              `${kept.join(", ")} already existed and ${kept.length === 1 ? "was" : "were"} kept as ${kept.length === 1 ? "it is" : "they are"}: the new goal and tickets use ${kept.length === 1 ? "it" : "them"}.`,
            ],
          };
        break;
      }
      case "agent-run-mission": {
        const targetAgentId = request.agentId || request.id;
        const agent = this.getAgentsList().find((a) => a.id === targetAgentId);
        if (!agent) throw new Error("Mission Agent not found");
        // Paused means paused. It used to hold only for the tickets the heartbeat picks up,
        // so "Run mission" started an agent a person had switched off.
        this.assertMayRun(agent);
        const clusterTag = agent.targetCluster
          ? ` (cluster: @cluster:${agent.targetCluster})`
          : "";
        const missionPrompt =
          request.promptOverride?.trim() ||
          `[Mission for ${agent.name}${clusterTag}]\n${agent.mission}`;
        reply = {
          started: {
            taskId: (
              await this.start({
                prompt: missionPrompt,
                sessionId: request.sessionId,
                mode: agent.defaultMode,
                agentId: agent.id,
                agentName: agent.name,
              })
            ).id,
          },
        };
        break;
      }
      case "workforce-run": {
        // The snapshot returns with the run in progress; its steps fill in as
        // the specialists finish (each change is announced through changed()).
        const { done } = await this.beginWorkforceRun({
          prompt: requiredText(request.prompt),
          agentIds: request.agentIds,
          targetCluster: request.targetCluster,
          createTask: request.createTask ?? true,
        });
        void done.catch((e) => log.warn("Workforce run failed", safeError(e)));
        break;
      }
      case "agent-handoff": {
        const task = this.task(request.taskId);
        const toAgent = this.getAgentsList().find(
          (a) =>
            a.id === request.toAgentId ||
            a.name.toLowerCase() === request.toAgentId.toLowerCase(),
        );
        if (!toAgent) throw new Error("Target Mission Agent not found for handoff");
        this.assertMayRun(toAgent);
        // Automated handoffs during an active run block cycles (A -> B -> A); idle/manual
        // handoffs on a finished conversation may return control while still capping hops.
        const allowCycle = !active(task);
        const hopCheck = checkHandoffAllowed({
          handoffChain: task.handoffChain,
          currentAgentId: task.agentId,
          currentAgentName: task.agentName,
          toAgentId: toAgent.id,
          toAgentName: toAgent.name,
          allowCycle,
        });
        if (!hopCheck.allowed) throw new Error(hopCheck.message ?? "Handoff limit reached");
        // During a run, the run finishes as the agent it started as (its instructions and tools were set
        // then, and what it spends is that agent's); the conversation changes hands when it ends.
        if (active(task)) {
          task.handoffTo = { agentId: toAgent.id, reason: request.reason };
          task.messages.push({
            id: crypto.randomUUID(),
            role: "system",
            text: `Hands over to ${toAgent.name} when this run ends.`,
            at: Date.now(),
          });
          break;
        }
        this.applyHandoff(task, toAgent, request.reason, { allowCycle });
        break;
      }
      case "workforce-pause": {
        const paused = Boolean(request.paused);
        const extra = this.storeDataExtra();
        const changedState = Boolean(extra.workforcePaused) !== paused;
        extra.workforcePaused = paused;
        if (changedState && !isDemoMode()) {
          void this.audit()
            .append({
              kind: "setting",
              actor: await this.resolveActorName(),
              target: "workforce",
              what: `Workforce autopilot ${paused ? "paused" : "resumed"}${request.reason?.trim() ? `: ${clip(request.reason.trim(), 200)}` : ""}`,
              outcome: "completed",
            })
            .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        }
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
