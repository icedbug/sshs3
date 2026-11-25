import crypto from "node:crypto";
import type {
  ChatServiceName,
  AgentMode,
  SafetyPolicyConfig,
  AgentChangeApproval,
  AgentPlan,
  ClusterSafetyPolicy,
  HubReply,
  AgentTask,
  HubSnapshot,
  KbDocument,
  MissionAgent,
  RunbookTemplate,
  TeamSafetyRules,
  WorkspaceActivityEvent,
  WorkspaceRule,
} from "../../../../shared/types/aiHub";
import { modeLabel } from "../../../../shared/modeLabels";
import { DEFAULT_SAFETY_POLICY, isProdTag } from "../safetyPolicy";
import { lowerMode } from "../AppGuard";
import {
  getBuiltinAgents,
  getBuiltinKbDocuments,
  getBuiltinSkillsAndMemories,
  getDemoMemories,
  isDemoMode,
  restoreDemoBuiltins,
} from "../demoWorkspace";
import { boundedContext, boundedPrompt, clip, PERSON_PROMPT_MAX, safeError, secretLine } from "../privacy";
import { resolveTargetSelector } from "../WorkforceRunner";
import { approvalAsksEach, approvalMessage, checkPlanApprovals, rejectionMessage, stepTerminal, todosFromPlan } from "../PlanMode";
import { requiredText, integer } from "../hubHelpers";
import { log, BOOLEAN_POLICY_NAMES, active, fromHub, REVEAL_KEPT_MS } from "../hubShared";
import { chatServiceLabel } from "../chatFence";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * What may run, and who has to say yes.
 *
 * The safety rules a run is held to, approvals of a change and of a plan (also by a second person on a
 * server several people share), the team's rules and runbooks, and bringing back the built-in ones.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
/** Said when an answer was given to a plan that is no longer the one waiting. */
const PLAN_REPLACED = "That plan was replaced. Answer the new one.";

export class SafetyPart {
  resolveSafetyContext(this: HubService,
    task: Pick<AgentTask, "target" | "startedAs" | "agentId" | "chat">,
    targetLabel?: string,
  ): {
    policy: SafetyPolicyConfig;
    targetTags?: string[];
    clusterPolicy?: ClusterSafetyPolicy;
    requesterId?: string;
    peerApproval?: boolean;
    canApproveAlone?: boolean;
  } {
    const policy = this.safetyPolicy();
    const rawLabel = (targetLabel || task.target?.label || "").trim();
    const label = rawLabel.toLowerCase();
    const session = task.target ? this.terminals.get(task.target.sessionId) : undefined;
    const knownServers = this.getKnownServers();
    const clusterMatch = /^cluster\s+([^\s(]+)/i.exec(rawLabel)?.[1]?.toLowerCase();
    const matchedServers = knownServers.filter((s) => {
      const sName = s.name.toLowerCase();
      const sId = s.id.toLowerCase();
      const sCluster = s.cluster?.toLowerCase();
      if (session?.profileId && s.id === session.profileId) return true;
      if (!label) return false;
      if (sName === label || sId === label || s.host.toLowerCase() === label) return true;
      if (
        sCluster &&
        (sCluster === label ||
          (clusterMatch && (sCluster === clusterMatch || sCluster.includes(clusterMatch))))
      ) {
        return true;
      }
      if ((rawLabel.includes(",") || rawLabel.includes("(")) && sName.length >= 2 && label.includes(sName)) {
        return true;
      }
      return false;
    });
    const aggregatedTags = Array.from(new Set(matchedServers.flatMap((s) => s.tags ?? [])));
    const clusterPolicies = policy.clusterPolicies;
    let clusterPolicy: ClusterSafetyPolicy | undefined;
    const candidateClusterKeys = new Set<string>();
    const tagKeys = new Set(aggregatedTags.map((tag) => `tag:${tag.trim().toLowerCase()}`));
    for (const s of matchedServers) {
      if (s.cluster?.trim()) candidateClusterKeys.add(s.cluster.trim().toLowerCase());
    }
    if (clusterMatch) candidateClusterKeys.add(clusterMatch);
    if (label) candidateClusterKeys.add(label);
    if (clusterPolicies && typeof clusterPolicies === "object") {
      const matchedPolicies: ClusterSafetyPolicy[] = [];
      for (const [k, v] of Object.entries(clusterPolicies)) {
        if (v && (candidateClusterKeys.has(k.trim().toLowerCase()) || tagKeys.has(k.trim().toLowerCase()))) {
          matchedPolicies.push(v);
        }
      }
      if (matchedPolicies.length > 0) {
        clusterPolicy = matchedPolicies.reduce<ClusterSafetyPolicy>((acc, cur) => ({
          ...(cur.maxMode || acc.maxMode
            ? {
                maxMode:
                  cur.maxMode && acc.maxMode
                    ? lowerMode(cur.maxMode, acc.maxMode)
                    : (cur.maxMode ?? acc.maxMode),
              }
            : {}),
          ...(cur.requiredApprovals !== undefined || acc.requiredApprovals !== undefined
            ? {
                requiredApprovals: Math.max(
                  cur.requiredApprovals ?? 1,
                  acc.requiredApprovals ?? 1,
                ),
              }
            : {}),
          ...(cur.requireCheckAndRollback || acc.requireCheckAndRollback
            ? { requireCheckAndRollback: true }
            : {}),
          ...(cur.frozenUntil !== undefined || acc.frozenUntil !== undefined
            ? { frozenUntil: Math.max(cur.frozenUntil ?? 0, acc.frozenUntil ?? 0) }
            : {}),
        }), {});
      }
    }
    // A freeze the server's administrator set for everyone holds whatever this person's own rules say.
    const teamUntil = this.teamFrozenUntil([...candidateClusterKeys, ...tagKeys]);
    if (teamUntil) clusterPolicy = { ...clusterPolicy, frozenUntil: Math.max(clusterPolicy?.frozenUntil ?? 0, teamUntil) };
    return {
      policy,
      targetTags: aggregatedTags.length > 0 ? aggregatedTags : undefined,
      ...(clusterPolicy ? { clusterPolicy } : {}),
      // A run acts for the person whose app this is: their approval is one, a second must be someone else's.
      requesterId: this.localApproverId(),
      peerApproval: this.peerApprovalPossible(aggregatedTags, task),
      canApproveAlone: Boolean(this.host.teamAdmin?.()),
    };
  }

  /** Who approves from this app: the signed-in account on the web server, the one person on the desktop. */
  localApproverId(this: HubService): string {
    return this.host.alertHookOwner ? `user:${this.host.alertHookOwner}` : "local";
  }

  /**
   * Whether a second person can be asked for an approval: only on a team server that routes it to them.
   * With `task`, for that run: a conversation from chat counts only the people its channel lets answer.
   */
  peerApprovalPossible(this: HubService, tags?: string[], task?: Pick<AgentTask, "chat">): boolean {
    return this.sharedServer() && Boolean(this.host.peerApproval?.(tags, task));
  }

  /**
   * Another signed-in member of the team server answers a change waiting in this person's app.
   * The web server calls this after it has checked that member may approve; their answer counts
   * as theirs, never as a second one of this person's.
   */
  async approveAsPeer(this: HubService,
    taskId: string,
    changeId: string,
    allowed: boolean,
    peer: { id: string; name: string },
    note?: string,
  ): Promise<boolean> {
    if (!this.peerApprovalPossible([]))
      throw new Error("Approvals are not shared between people on this server.");
    const actorId = `user:${requiredText(peer.id)}`;
    if (actorId === this.localApproverId())
      throw new Error("The person a change is made for answers it in their own app.");
    const name = requiredText(peer.name);
    const resolved = this.broker.approve(taskId, changeId, allowed, note?.trim() ? clip(note.trim(), 1000) : undefined, {
      actor: name,
      actorId,
      peer: true,
    });
    const change = this.store.data.tasks.find((t) => t.id === taskId)?.changes.find((c) => c.id === changeId);
    if (change && (resolved || change.status !== "pending")) change.decidedBy = { name, at: Date.now(), allowed };
    this.changed();
    return resolved;
  }

  /** How a plan stands with the people who have to approve it, by the rules in force for what it touches. */
  planApprovalStatus(this: HubService, task: AgentTask, plan: AgentPlan, approvals: ReadonlyArray<AgentChangeApproval>) {
    const target = task.target?.label ?? plan.steps.find((s) => s.target?.trim())?.target;
    const ctx = this.resolveSafetyContext(task, target);
    const status = checkPlanApprovals(plan, {
      approvals,
      // The person whose run it is: their approval alone is never the two.
      proposer: this.localApproverId(),
      targetTags: ctx.targetTags,
      defaultTarget: task.target?.label,
      policy: ctx.policy,
      clusterPolicy: ctx.clusterPolicy,
    });
    return { status, tags: ctx.targetTags ?? [] };
  }

  /** A plan was just proposed: how many people have to approve it is written on it, for whoever reads it. */
  planProposed(this: HubService, task: AgentTask): void {
    const plan = task.plan;
    if (!plan || plan.status !== "proposed") return;
    // A run asked for from chat binds its steps only to terminals of its own: a person's tab on the
    // same server is not where its plan runs.
    const fence = this.chatFence(task);
    const sessions = this.terminals.list().filter((s) => s.state !== "disconnected" && (!fence || fence.own(s.id)));
    const servers = this.getKnownServers();
    for (const step of plan.steps) {
      const session = stepTerminal(step.target, sessions, servers, task.target);
      if (session) {
        step.approvedTarget = JSON.stringify([session.id, session.generation]);
        step.target ??= session.label;
      }
    }
    const needs = this.planApprovalStatus(task, plan, plan.approvals ?? []).status.requiredApprovals;
    if (needs > 1) plan.requiredApprovals = needs;
    else delete plan.requiredApprovals;
    this.emitRun({ type: "plan", taskId: task.id, planId: plan.id, status: plan.status });
  }

  /**
   * A person's answer to the plan a conversation's agent proposed. `who` is the person answering: the
   * one whose run it is, or, on a server several people share, another member answering as the second
   * person (approvePlanAsPeer). Returns the snapshot of the conversation going on (the plan was
   * approved, or sent back with a note), or nothing when it only recorded the answer.
   *
   * What another member writes is shown to the person whose run it is. It is never sent to the agent as
   * that person's words, and a second person's no does not send the agent back to work.
   *
   * A person who answers in a chat thread (`chatApprover`) is another account too, but the conversation
   * is nobody's own: they answer it as its owner would. Their note goes to the agent, their choice about
   * each command holds, and their no with a note sends the agent back to revise.
   */
  async decidePlan(this: HubService,
    task: AgentTask,
    answer: { approved: boolean; note?: string; askEach?: boolean },
    who: { actor: string; actorId: string; peer?: boolean; chatApprover?: boolean; via?: ChatServiceName },
  ): Promise<HubSnapshot | undefined> {
    const plan = task.plan;
    if (!plan || plan.status !== "proposed") throw new Error("There is no plan waiting for a decision in this conversation");
    if (active(task)) throw new Error("The agent is still working; decide when it has stopped");
    const note = answer.note?.trim();
    const { actor, actorId } = who;
    const ownerLike = !who.peer || who.chatApprover === true;
    // Where the answer was given, for the conversation to say: "Maria Ek approved in Slack."
    const inChat = who.chatApprover && who.via ? ` in ${chatServiceLabel(who.via)}` : "";
    const vote = (allowed: boolean): AgentChangeApproval => ({
      actor,
      actorId,
      at: Date.now(),
      allowed,
      ...(who.peer ? { peer: true } : {}),
      ...(who.via ? { via: who.via } : {}),
      ...(note ? { note: boundedContext(note, 1000) } : {}),
    });
    const told = (): void => this.emitRun({ type: "plan", taskId: task.id, planId: plan.id, status: plan.status });
    const say = (text: string): void => {
      task.messages.push({ id: crypto.randomUUID(), role: "system", text, at: Date.now() });
      task.updatedAt = Date.now();
    };
    // Another member's own words, quoted as theirs for the person whose run it is.
    const wrote = who.peer && note ? ` They wrote: "${boundedContext(note, 1000)}"` : "";
    if (this.getKnownServers().length === 0) {
      await this.collectExtraContext().catch(() => undefined);
      // Looked at again after the wait: the agent may have proposed another plan, or started, meanwhile.
      if (task.plan !== plan || plan.status !== "proposed") throw new Error(PLAN_REPLACED);
      if (active(task)) throw new Error("The agent is still working; decide when it has stopped");
    }
    const planTargets = Array.from(new Set([task.target?.label, ...plan.steps.map((s) => s.target)].filter((t): t is string => Boolean(t?.trim()))));
    if (answer.approved) {
      for (const tgt of planTargets.length ? planTargets : [undefined]) {
        const tgtCtx = this.resolveSafetyContext(task, tgt ?? task.target?.label);
        if (tgtCtx.clusterPolicy?.frozenUntil && tgtCtx.clusterPolicy.frozenUntil > Date.now()) {
          throw new Error(`A change freeze holds on ${tgt ?? task.target?.label ?? "this target"} until ${new Date(tgtCtx.clusterPolicy.frozenUntil).toISOString()}. The plan cannot be approved before it ends.`);
        }
      }
      const prevApprovals = [...(plan.approvals ?? [])];
      if (prevApprovals.some((a) => a.allowed && (a.actorId || a.actor).toLowerCase() === actorId.toLowerCase())) {
        throw new Error("You already approved this plan; it needs the approval of another person.");
      }
      const nextApprovals: AgentChangeApproval[] = [...prevApprovals, vote(true)];
      const approvalStatus = this.planApprovalStatus(task, plan, nextApprovals).status;
      if (!approvalStatus.satisfied && approvalStatus.requiredApprovals > 1 && !this.peerApprovalPossible(undefined, task)) {
        throw new Error(
          `This plan needs the approval of ${approvalStatus.requiredApprovals} different people (the cluster's policy), and only one person can approve in this app.`,
        );
      }
      plan.approvals = nextApprovals;
      plan.requiredApprovals = approvalStatus.requiredApprovals;
      if (!approvalStatus.satisfied) {
        // What the person whose run it is chose about each command is kept for when the plan is approved.
        if (ownerLike && answer.askEach === true && !plan.askEach) plan.askEach = "person";
        say(
          who.chatApprover
            ? `${actor} approved this plan${inChat}. It needs ${approvalStatus.requiredApprovals === 2 ? "one more person" : `${approvalStatus.requiredApprovals} different people in all`}. The agent starts when enough of them have approved.`
            : who.peer
            ? `${actor} approved this plan as the second person. It waits for your own answer.`
            : approvalStatus.requiredApprovals === 2
              ? "You approved this plan. It needs one more person. The teammates who may approve it see it in their inbox. The agent starts when one of them has approved."
              : `You approved this plan. It needs ${approvalStatus.requiredApprovals} different people in all. The teammates who may approve it see it in their inbox. The agent starts when enough of them have approved.`,
        );
        this.changed();
        told();
        return undefined;
      }
      plan.decidedAt = Date.now();
      plan.status = "approved";
      if (approvalStatus.isProd) plan.production = true;
      else delete plan.production;
      // What the person whose run it is added, whoever of the two answered last. In a chat thread each
      // approver answers as the owner would, so what every one of them wrote goes to the agent.
      // An answer given in the app (no `via`) by a linked person counts as one given in the thread.
      const chatNotes = nextApprovals.filter((a) => a.allowed && (a.via || a.peer) && a.note);
      const ownNote = who.chatApprover
        ? chatNotes.length > 1
          ? chatNotes.map((a) => `${a.actor}: ${a.note}`).join("\n")
          : chatNotes[0]?.note
        : ownerLike
          ? note
          : nextApprovals.find((a) => a.allowed && !a.peer)?.note;
      // What this approval covers is settled here, where the person decided, and written on the plan.
      // A second person approves the plan as it stands: what is asked about each command is the
      // plan's own promise, or what the person whose run it is chose when they approved. An earlier
      // choice to be asked about each command is never undone by the one who answers last.
      const asks =
        plan.askEach === "person"
          ? "person"
          : ownerLike
            ? approvalAsksEach(plan, { note, askEach: answer.askEach })
            : plan.askEach;
      if (asks) plan.askEach = asks;
      else delete plan.askEach;
      if (ownNote) plan.decisionNote = boundedContext(ownNote, 2000);
      // The agent is held to the plan: its steps become its task list.
      task.todos = todosFromPlan(plan);
      if (who.chatApprover) say(`${actor} approved${inChat}.`);
      else if (who.peer) say(`${actor} approved this plan as the second person.${wrote}`);
      this.changed();
      told();
      if (!who.peer) return this.request(fromHub({ action: "reply", taskId: task.id, text: approvalMessage(plan, ownNote) }));
      try {
        return await this.request(fromHub({ action: "reply", taskId: task.id, text: approvalMessage(plan, ownNote) }));
      } catch (error) {
        // The plan is approved all the same. Why the agent did not start is for the person whose run it is.
        say(`The plan is approved, but the agent could not be started again: ${clip(error instanceof Error ? error.message : String(error), 300)} Send it a message to go on.`);
        this.changed();
        return undefined;
      }
    }
    plan.decidedAt = Date.now();
    plan.approvals = [...(plan.approvals ?? []), vote(false)];
    plan.status = "rejected";
    told();
    if (!ownerLike) {
      say(`${actor} did not approve this plan.${wrote} Nothing was run. Ask the agent for a new plan, or go on another way.`);
      this.changed();
      return undefined;
    }
    if (who.chatApprover) say(`${actor} did not approve this plan${inChat}.`);
    if (note) {
      plan.decisionNote = boundedContext(note, 2000);
      this.changed();
      if (!who.peer) return this.request(fromHub({ action: "reply", taskId: task.id, text: rejectionMessage(note) }));
      try {
        return await this.request(fromHub({ action: "reply", taskId: task.id, text: rejectionMessage(note) }));
      } catch (error) {
        say(`The agent could not be started again: ${clip(error instanceof Error ? error.message : String(error), 300)} Send it a message to go on.`);
        this.changed();
        return undefined;
      }
    }
    this.changed();
    return undefined;
  }

  /**
   * Another signed-in member of the team server answers the plan waiting in this person's conversation,
   * as the second person. The web server calls this after it has checked that member may; their answer
   * counts as theirs, never as a second one of this person's.
   */
  async approvePlanAsPeer(this: HubService, taskId: string, allowed: boolean, peer: { id: string; name: string }, note?: string): Promise<void> {
    if (!this.peerApprovalPossible([])) throw new Error("Approvals are not shared between people on this server.");
    const actorId = `user:${requiredText(peer.id)}`;
    if (actorId === this.localApproverId()) throw new Error("The person a plan is made for answers it in their own app.");
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("That conversation is not here any more.");
    await this.decidePlan(
      task,
      { approved: allowed, ...(note?.trim() ? { note: clip(note.trim(), 1000) } : {}) },
      { actor: requiredText(peer.name), actorId, peer: true },
    );
    // Recorded now: a request of this person's own saves at its end, this one is somebody else's.
    await this.store.save().catch(() => undefined);
  }

  /**
   * What a button in a chat thread would answer, for the server to check whether the person who pressed
   * it may: the tags of what it touches (a plan for production says "production"), how many people it
   * needs, and who has answered. Only a conversation asked for from chat is answered from there.
   */
  chatApprovalSubject(this: HubService, taskId: string, id: string): {
    kind: "change" | "plan";
    targetTags: string[];
    requiredApprovals: number;
    votes: Array<{ actor: string; actorId?: string; allowed: boolean }>;
    /** A change to sshs3's own rules: only answered in the app. */
    setting: boolean;
    /** Still waiting for an answer. */
    waiting: boolean;
    /** Who the channel it was asked in lets answer, as the run was started with. */
    approvers: "linked" | "admins";
  } {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task?.chat) throw new Error("That conversation was not asked for from chat.");
    const approvers = task.chat.fence.approvers === "admins" ? "admins" : "linked";
    const votesOf = (list: AgentChangeApproval[] | undefined) =>
      (list ?? []).map((a) => ({ actor: a.actor, ...(a.actorId ? { actorId: a.actorId } : {}), allowed: a.allowed }));
    const plan = task.plan;
    if (plan && plan.id === id) {
      const { status, tags } = this.planApprovalStatus(task, plan, plan.approvals ?? []);
      // Whoever answers a plan answers for every server it touches, not only for its first one: a step
      // on a server tagged production makes the whole plan one for production.
      const all = new Set(tags);
      for (const step of plan.steps)
        for (const tag of this.resolveSafetyContext(task, step.target?.trim() || task.target?.label).targetTags ?? []) all.add(tag);
      const targetTags = [...all];
      return {
        kind: "plan",
        targetTags: status.isProd && !targetTags.some(isProdTag) ? [...targetTags, "production"] : targetTags,
        requiredApprovals: status.requiredApprovals,
        votes: votesOf(plan.approvals),
        setting: false,
        waiting: plan.status === "proposed" && !active(task),
        approvers,
      };
    }
    const change = task.changes.find((c) => c.id === id);
    if (!change) throw new Error("That change is not in this conversation.");
    // The tags of the terminal the change runs on, as the broker reads them (ToolBroker.safetyFor):
    // not of the run's first target, which may be another server.
    let on: AgentTask["target"] = task.target;
    if (change.targetKey) {
      const session = this.terminals.list().find((s) => JSON.stringify([s.id, s.generation]) === change.targetKey);
      on = session ? { sessionId: session.id, generation: session.generation, label: session.label } : undefined;
    }
    return {
      kind: "change",
      targetTags: this.resolveSafetyContext({ ...task, target: on }, change.target).targetTags ?? [],
      requiredApprovals: Math.max(1, change.requiredApprovals ?? 1),
      votes: votesOf(change.approvals),
      setting: change.kind === "setting",
      waiting: change.status === "pending" && this.broker.waitingFor(change.id),
      approvers,
    };
  }

  /**
   * A person who linked their chat account answers a change from a button in the thread. The server
   * has checked that they may (chatApprovalSubject, the same rules as a second person in the app). The
   * answer counts as theirs, once, and the conversation records where it was given.
   */
  async approveFromChat(this: HubService,
    taskId: string,
    changeId: string,
    allowed: boolean,
    person: { id: string; name: string; via?: ChatServiceName },
    note?: string,
  ): Promise<boolean> {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task?.chat) throw new Error("That conversation was not asked for from chat.");
    const change = task.changes.find((c) => c.id === changeId);
    if (change?.kind === "setting") throw new Error("A change to sshs3's own rules is answered in the app.");
    const actorId = `user:${requiredText(person.id)}`;
    if (actorId === this.localApproverId()) throw new Error("This account answers its own changes in the app.");
    const name = requiredText(person.name);
    const resolved = this.broker.approve(taskId, changeId, allowed, note?.trim() ? clip(note.trim(), 1000) : undefined, {
      actor: name,
      actorId,
      peer: true,
      ...(person.via ? { via: person.via } : {}),
    });
    if (change && (resolved || change.status !== "pending")) change.decidedBy = { name, at: Date.now(), allowed };
    this.changed();
    // Recorded now: nobody's request saves at its end here.
    await this.store.save().catch(() => undefined);
    return resolved;
  }

  /**
   * A person who linked their chat account answers the plan of a conversation asked for from chat, as
   * its owner would (see decidePlan): an approval that completes it starts the agent again.
   */
  async decidePlanFromChat(this: HubService,
    taskId: string,
    planId: string,
    approved: boolean,
    person: { id: string; name: string; via?: ChatServiceName },
    options: { note?: string; askEach?: boolean } = {},
  ): Promise<void> {
    const note = options.note;
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task?.chat) throw new Error("That conversation was not asked for from chat.");
    // A card stays in the thread: a press on it answers the plan it showed, never a newer one.
    if (task.plan?.id !== planId || task.plan.status !== "proposed") throw new Error(PLAN_REPLACED);
    const actorId = `user:${requiredText(person.id)}`;
    if (actorId === this.localApproverId()) throw new Error("This account answers its own plans in the app.");
    await this.decidePlan(
      task,
      { approved, ...(note?.trim() ? { note: clip(note.trim(), 1000) } : {}), ...(options.askEach ? { askEach: true } : {}) },
      { actor: requiredText(person.name), actorId, peer: true, chatApprover: true, ...(person.via ? { via: person.via } : {}) },
    );
    await this.store.save().catch(() => undefined);
  }

  /** Changes in this app waiting on a person's approval, for the web server to show to the other members. */
  waitingForApproval(this: HubService): Array<{
    taskId: string;
    changeId: string;
    agentName?: string;
    description: string;
    command?: string;
    target?: string;
    /** The tags of the server it is about: whether it is production decides who may be the second person. */
    targetTags: string[];
    requiredApprovals: number;
    approvedBy: string[];
    /** The ones who approved, as the broker counts them (an account's id where it has one). */
    approvers: Array<{ actor: string; actorId?: string; allowed: boolean }>;
    at: number;
    /** Set when what waits is a plan, not one change: its steps, for the person deciding. `changeId` is then the plan's id. */
    plan?: { steps: Array<{ action: string; command?: string; target?: string; risk: string }> };
  }> {
    if (!this.peerApprovalPossible([])) return [];
    const plans = this.store.data.tasks.flatMap((task) => {
      const plan = task.plan;
      // Decided when the agent has stopped, as by the person whose run it is. A test run's plan and a
      // summary's are nobody's to approve.
      if (!plan || plan.status !== "proposed" || active(task) || task.evalCaseId || task.distillSourceId) return [];
      const { status, tags } = this.planApprovalStatus(task, plan, plan.approvals ?? []);
      if (status.requiredApprovals < 2) return [];
      const target = task.target?.label ?? plan.steps.find((s) => s.target?.trim())?.target;
      return [
        {
          taskId: task.id,
          changeId: plan.id,
          ...(task.agentName ? { agentName: task.agentName } : {}),
          description: plan.goal,
          ...(target ? { target } : {}),
          // A plan counts as one for production by the names of what it touches too: said here as a tag,
          // so the server asks only somebody who may approve on production.
          targetTags: status.isProd && !tags.some(isProdTag) ? [...tags, "production"] : tags,
          requiredApprovals: status.requiredApprovals,
          approvedBy: (plan.approvals ?? []).filter((a) => a.allowed).map((a) => a.actor),
          approvers: (plan.approvals ?? []).map((a) => ({ actor: a.actor, ...(a.actorId ? { actorId: a.actorId } : {}), allowed: a.allowed })),
          at: plan.createdAt,
          plan: { steps: plan.steps.map((st) => ({ action: st.action, ...(st.command ? { command: st.command } : {}), ...(st.target ? { target: st.target } : {}), risk: st.risk })) },
        },
      ];
    });
    const changes = this.store.data.tasks.flatMap((task) =>
      task.changes
        .filter((c) => c.status === "pending" && (c.requiredApprovals ?? 1) > 1 && this.broker.waitingOnPerson(task.id))
        .map((c) => ({
          taskId: task.id,
          changeId: c.id,
          ...(task.agentName ? { agentName: task.agentName } : {}),
          description: c.description,
          ...(c.command ? { command: c.command } : {}),
          ...(c.target ? { target: c.target } : {}),
          targetTags: this.resolveSafetyContext(task, c.target).targetTags ?? [],
          requiredApprovals: c.requiredApprovals ?? 1,
          approvedBy: (c.approvals ?? []).filter((a) => a.allowed).map((a) => a.actor),
          approvers: (c.approvals ?? []).map((a) => ({ actor: a.actor, ...(a.actorId ? { actorId: a.actorId } : {}), allowed: a.allowed })),
          at: c.at,
        })),
    );
    return [...plans, ...changes];
  }

  /**
   * Another member's change that needs a second person has started to wait, or no longer does: this
   * member's windows fetch again and their notification channels are told. Called by the server.
   */
  peerApprovalsChanged(this: HubService): void {
    this.changed();
  }

  /**
   * The safety rules a run is held to. On a shared server a member's own rules may be stricter than
   * the team's, never looser: one stored before that rule (switched off by a member) counts as on.
   */
  safetyPolicy(this: HubService): SafetyPolicyConfig {
    const stored = this.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY;
    // A person's own rule: where only one person can approve, a second approval can never come, so it
    // is not in force (and cannot be switched on), rather than leaving every production change to time out.
    // The rule the server's administrator set for everyone is in force whoever can be asked: where nobody
    // can, the broker refuses a member's change at once and lets an administrator approve one change
    // alone with a written reason (`adminExceptionAvailable`).
    const peer = Boolean(this.teamRules()?.requirePeerApprovalOnProd || (stored.requirePeerApprovalOnProd && this.peerApprovalPossible()));
    const own = peer === Boolean(stored.requirePeerApprovalOnProd) ? stored : { ...stored, requirePeerApprovalOnProd: peer };
    if (!this.sharedServer() || this.host.teamAdmin?.()) return own;
    return { ...own, requireApprovalOnProdTags: true };
  }
  /** The rules the server's administrator set for everyone. None on the desktop, and none in the demo lab. */
  teamRules(this: HubService): TeamSafetyRules | undefined {
    return isDemoMode() ? undefined : this.host.teamRules?.read();
  }

  /** Until when a freeze set for everyone holds on a target: the one on every server, or one on a cluster it is in. */
  teamFrozenUntil(this: HubService, clusterKeys: Iterable<string>): number | undefined {
    const freezes = this.teamRules()?.freezes;
    if (!freezes) return undefined;
    let until = freezes["*"]?.until ?? 0;
    for (const key of clusterKeys) until = Math.max(until, freezes[key]?.until ?? 0);
    return until > Date.now() ? until : undefined;
  }

  /** The server's rules as the settings show them: a freeze that has run out is left out. */
  teamRulesView(this: HubService): HubSnapshot["teamRules"] {
    const rules = this.teamRules();
    if (!rules) return undefined;
    const now = Date.now();
    const freezes = Object.fromEntries(Object.entries(rules.freezes ?? {}).filter(([, f]) => f.until > now));
    return {
      requirePeerApprovalOnProd: Boolean(rules.requirePeerApprovalOnProd),
      ...(Object.keys(freezes).length ? { freezes } : {}),
      ...(rules.changedBy ? { changedBy: rules.changedBy, changedAt: rules.changedAt } : {}),
      canChange: Boolean(this.host.teamAdmin?.()),
    };
  }

  /** An administrator changed the rules for everyone: this member's windows fetch again. Called by the server. */
  teamRulesChanged(this: HubService): void {
    this.changed();
  }

  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleSafety(this: HubService, request: RequestsOf<"safety">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "approve": {
        const actor = await this.resolveActorName();
        const approvalNote = typeof request.note === "string" && request.note.trim() ? clip(request.note.trim(), 1000) : undefined;
        // A setting that needs a secret is approved together with it: the person types the token on the
        // card, and it goes from here straight to the tool that waits. It is never part of a message.
        const waiting = this.store.data.tasks.find((t) => t.id === request.taskId)?.changes.find((c) => c.id === request.changeId);
        let stored = false;
        if (request.approved === true && waiting?.status === "pending" && waiting.secretFields?.length) {
          // Only its own card answers such a change: the card always sends what was typed, even when
          // that is nothing. A plain yes from elsewhere (a shortcut, another list) would let it through
          // without the person having seen the fields.
          if (!request.secrets || typeof request.secrets !== "object" || Array.isArray(request.secrets))
            throw new Error("This one takes a token or key. Answer it on its card in the conversation.");
          const given: Record<string, unknown> = request.secrets;
          const kept: Record<string, string> = {};
          for (const field of waiting.secretFields) {
            const raw = given[field.key];
            const value = typeof raw === "string" ? raw.trim() : "";
            if (!value && !field.optional) throw new Error(`This one needs ${field.label}. Type it on the approval card in the conversation.`);
            if (value.length > 8192) throw new Error(`${field.label} is too long.`);
            if (value) kept[field.key] = value;
          }
          // The first answer's secrets are the ones the waiting tool reads. A second answer that arrives
          // while the first is still being written down must neither replace them nor take them away.
          if (this.broker.waitingFor(waiting.id) && !this.changeSecrets.has(waiting.id)) {
            this.changeSecrets.set(waiting.id, kept);
            stored = true;
          }
        }
        let resolved: boolean;
        try {
          resolved = this.broker.approve(
            request.taskId,
            request.changeId,
            request.approved === true,
            approvalNote,
            // The account, not the name it shows: two people may share a name, one person may rename.
            { actor, actorId: this.localApproverId(), adminException: request.adminException === true && this.host.teamAdmin?.() === true },
          );
        } catch (error) {
          // Nothing waits for this answer: what was typed with it is not kept. Only what this answer
          // itself stored is dropped, never what an earlier one left for the tool.
          if (stored) this.changeSecrets.delete(request.changeId);
          throw error;
        }
        // Who answered is written down once the broker resolves or records the final decision.
        const change = this.store.data.tasks
          .find((t) => t.id === request.taskId)
          ?.changes.find((c) => c.id === request.changeId);
        if (change && (resolved || change.status !== "pending")) {
          change.decidedBy = { name: actor, at: Date.now(), allowed: request.approved === true };
        }
        break;
      }
      case "change-reveal": {
        const change = this.task(request.taskId).changes.find((c) => c.id === request.changeId);
        if (!change?.reveal) throw new Error("There is nothing to show for this one.");
        const kept = this.changeReveals.get(change.id);
        this.changeReveals.delete(change.id);
        change.reveal.shown = true;
        const fresh = kept && Date.now() - kept.at <= REVEAL_KEPT_MS ? { label: kept.label, value: kept.value } : undefined;
        // An empty value says it is gone: shown before, kept too long, or sshs3 restarted since.
        return { reply: { changeReveal: fresh ?? { label: change.reveal.label, value: "" } } };
      }
      case "peer-approve": {
        if (!this.host.peerDecide) throw new Error("Approvals are not passed between people here.");
        await this.host.peerDecide({
          ownerId: requiredText(request.ownerId),
          taskId: requiredText(request.taskId),
          changeId: requiredText(request.changeId),
          approved: request.approved === true,
          ...(typeof request.note === "string" && request.note.trim() ? { note: clip(request.note.trim(), 1000) } : {}),
        });
        break;
      }
      case "plan-decide": {
        const decided = await this.decidePlan(
          this.task(request.taskId),
          { approved: request.approved === true, note: request.note, askEach: request.askEach },
          { actor: await this.resolveActorName(), actorId: this.localApproverId() },
        );
        // Approved or sent back with a note, the conversation went on: that request's answer is this one's.
        if (decided) return { snapshot: await decided };
        break;
      }
      case "restore-builtins": {
        const restoredIds = new Set<string>();
        for (const id of this.store.data.preferences.dismissedBuiltinIds ?? []) {
          restoredIds.add(id);
        }
        this.store.data.preferences.dismissedBuiltinIds = [];
        if (isDemoMode()) {
          for (const id of restoreDemoBuiltins()) restoredIds.add(id);
        }
        let sharedCleared = false;
        for (const a of getBuiltinAgents()) {
          const removedAt = this.store.data.sharedRemoved?.agents?.[a.id];
          if (removedAt) {
            delete this.store.data.sharedRemoved!.agents![a.id];
            const restoredAt = Math.max(Date.now(), removedAt + 1);
            const existing = (this.store.data.agents ?? []).find((x) => x.id === a.id);
            const restored: MissionAgent = {
              ...(existing ?? a),
              updatedAt: restoredAt,
            };
            delete (restored as MissionAgent & { baseAt?: number }).baseAt;
            this.store.data.agents = [
              ...(this.store.data.agents ?? []).filter((x) => x.id !== a.id),
              restored,
            ];
            restoredIds.add(a.id);
            sharedCleared = true;
          }
          if (this.store.data.sharedRemovedBy?.agents?.[a.id]) {
            delete this.store.data.sharedRemovedBy.agents[a.id];
          }
        }
        for (const doc of getBuiltinKbDocuments()) {
          const removedAt = this.store.data.sharedRemoved?.kb?.[doc.id];
          if (removedAt) {
            delete this.store.data.sharedRemoved!.kb![doc.id];
            const restoredAt = Math.max(Date.now(), removedAt + 1);
            const existing = (this.store.data.kbDocuments ?? []).find((x) => x.id === doc.id);
            const restored: KbDocument = {
              ...(existing ?? doc),
              updatedAt: restoredAt,
              restoredAt,
            };
            this.store.data.kbDocuments = [
              ...(this.store.data.kbDocuments ?? []).filter((x) => x.id !== doc.id),
              restored,
            ];
            restoredIds.add(doc.id);
            sharedCleared = true;
          }
        }
        let memoryCleared = false;
        const builtinMemories = [
          ...getBuiltinSkillsAndMemories(),
          ...(isDemoMode() ? getDemoMemories() : []),
        ];
        for (const bm of builtinMemories) {
          if (this.store.data.deletedMemoryIds?.[bm.id]) {
            delete this.store.data.deletedMemoryIds[bm.id];
            restoredIds.add(bm.id);
            memoryCleared = true;
          }
          if (this.store.data.deletedMemoryBy?.[bm.id]) {
            delete this.store.data.deletedMemoryBy[bm.id];
          }
        }
        if (sharedCleared) this.scheduleWorkSync();
        if (memoryCleared) this.s3Workspace.schedulePush(400);
        const restoredSnippets = (await this.host.restoreBuiltinSnippets?.().catch(() => 0)) ?? 0;
        const total = restoredIds.size + restoredSnippets;
        reply = {
          notes: [
            total > 0
              ? `Restored ${total} built-in item${total === 1 ? "" : "s"}.`
              : "All built-in agents, runbooks, and skills are already present.",
          ],
        };
        break;
      }
      case "safety-policy-save": {
        const stored = this.store.data.safetyPolicy ?? DEFAULT_SAFETY_POLICY;
        const asked: Partial<Record<keyof SafetyPolicyConfig, unknown>> =
          request.policy && typeof request.policy === "object" ? request.policy : {};
        for (const key of Object.keys(BOOLEAN_POLICY_NAMES) as (keyof typeof BOOLEAN_POLICY_NAMES)[])
          if (asked[key] !== undefined && typeof asked[key] !== "boolean")
            throw new Error(`"${BOOLEAN_POLICY_NAMES[key]}" is either on (true) or off (false).`);
        if (
          asked.clusterPolicies !== undefined &&
          (typeof asked.clusterPolicies !== "object" || asked.clusterPolicies === null || Array.isArray(asked.clusterPolicies))
        )
          throw new Error("Cluster policies must be a map of cluster names to policy settings.");
        if (this.sharedServer() && !this.host.teamAdmin?.()) {
          // This one holds for every member whatever is stored. The two-person rule is a member's own to
          // switch: the one for everyone is the administrator's (team-rules-save) and holds either way.
          if (asked.requireApprovalOnProdTags === false)
            throw new Error(`Only an administrator of this server switches off "${BOOLEAN_POLICY_NAMES.requireApprovalOnProdTags}": on a shared server it is the team's rule.`);
          // What is sent back unchanged is not a change: a member is not refused for what they did not touch.
          const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
          if (asked.clusterPolicies !== undefined && !same(asked.clusterPolicies, stored.clusterPolicies ?? {}))
            throw new Error("Only an administrator of this server changes cluster policies on a shared server.");
        }
        if (!this.peerApprovalPossible()) {
          const twoPeople =
            asked.requirePeerApprovalOnProd === true ||
            (asked.clusterPolicies !== undefined &&
              Object.entries(asked.clusterPolicies as Record<string, unknown>).some(
                ([name, p]) =>
                  p &&
                  typeof p === "object" &&
                  Number((p as { requiredApprovals?: unknown }).requiredApprovals) > 1 &&
                  (stored.clusterPolicies?.[name]?.requiredApprovals ?? 1) <= 1,
              ));
          if (twoPeople)
            throw new Error(
              "An approval by a second person needs a second person who can be asked: only a team server with several accounts has one. Here only you approve, so this rule is not offered.",
            );
        }
        const current: SafetyPolicyConfig = {
          requireApprovalOnProdTags: Boolean(stored.requireApprovalOnProdTags),
          ...(stored.requirePeerApprovalOnProd !== undefined ? { requirePeerApprovalOnProd: Boolean(stored.requirePeerApprovalOnProd) } : {}),
          ...(stored.clusterPolicies ? { clusterPolicies: { ...stored.clusterPolicies } } : {}),
        };
        let nextClusterPolicies = current.clusterPolicies;
        if (asked.clusterPolicies !== undefined) {
          const sanitized: Record<string, ClusterSafetyPolicy> = {};
          for (const [clusterName, rawPolicy] of Object.entries(asked.clusterPolicies as Record<string, unknown>)) {
            const key = clusterName.trim().slice(0, 120);
            if (!key || !rawPolicy || typeof rawPolicy !== "object") continue;
            const p = rawPolicy as Record<string, unknown>;
            const entry: ClusterSafetyPolicy = {};
            if (typeof p.maxMode === "string" && ["advice", "plan", "assisted", "autonomous"].includes(p.maxMode)) {
              entry.maxMode = p.maxMode as AgentMode;
            }
            if (typeof p.requiredApprovals === "number" && Number.isFinite(p.requiredApprovals)) {
              entry.requiredApprovals = integer(p.requiredApprovals, 1, 10);
            }
            if (typeof p.requireCheckAndRollback === "boolean") {
              entry.requireCheckAndRollback = p.requireCheckAndRollback;
            }
            if (typeof p.frozenUntil === "number" && Number.isFinite(p.frozenUntil)) {
              entry.frozenUntil = p.frozenUntil;
            }
            sanitized[key] = entry;
          }
          nextClusterPolicies = sanitized;
        }
        const next: SafetyPolicyConfig = {
          requireApprovalOnProdTags:
            (asked.requireApprovalOnProdTags as boolean | undefined) ?? current.requireApprovalOnProdTags,
          ...(asked.requirePeerApprovalOnProd !== undefined || current.requirePeerApprovalOnProd !== undefined
            ? {
                requirePeerApprovalOnProd:
                  (asked.requirePeerApprovalOnProd as boolean | undefined) ?? current.requirePeerApprovalOnProd,
              }
            : {}),
          ...(nextClusterPolicies ? { clusterPolicies: nextClusterPolicies } : {}),
        };
        const moved = (Object.keys(BOOLEAN_POLICY_NAMES) as (keyof typeof BOOLEAN_POLICY_NAMES)[])
          .filter((k) => Boolean(next[k]) !== Boolean(current[k]))
          .map((k) => `${BOOLEAN_POLICY_NAMES[k]}: ${current[k] ? "on" : "off"} → ${next[k] ? "on" : "off"}`);
        if (JSON.stringify(next.clusterPolicies ?? {}) !== JSON.stringify(current.clusterPolicies ?? {})) {
          const was = current.clusterPolicies ?? {};
          const now = next.clusterPolicies ?? {};
          const say = (p: (typeof now)[string] | undefined): string =>
            p
              ? [p.maxMode ? `at most "${modeLabel(p.maxMode)}"` : "", p.requiredApprovals ? `${p.requiredApprovals} approval${p.requiredApprovals === 1 ? "" : "s"}` : "", p.requireCheckAndRollback ? "check and rollback" : "", p.frozenUntil ? `frozen until ${new Date(p.frozenUntil).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""].filter(Boolean).join(", ") || "no limits"
              : "none";
          for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort())
            if (JSON.stringify(was[name]) !== JSON.stringify(now[name])) moved.push(`rules for "${clip(name, 60)}": ${say(was[name])} → ${say(now[name])}`);
        }
        // In the demo lab too: its audit log is its own, kept in the demo's folder and sent nowhere.
        if (moved.length) await this.audit().append({
          kind: "setting", actor: await this.resolveActorName(), target: "Safety rules", what: moved.join("; "), outcome: "intent",
        });
        this.store.data.safetyPolicy = next;
        if (moved.length) {
          // Who changed the rules is the team's business as well as the log's.
          const event: WorkspaceActivityEvent = { id: crypto.randomUUID(), at: Date.now(), actor: await this.resolveActorName(), targetLabel: "Safety rules", kind: "note", summary: clip(`Changed the safety rules: ${moved.join("; ")}`, 400) };
          this.appendActivityEvent(event);
          await this.shareActivity(event).catch(() => {});
        }
        if (moved.length) {
          this.store.data.safetyPolicyChanged = { by: await this.resolveActorName(), at: Date.now() };
          void this.audit()
            .append({ kind: "setting", actor: await this.resolveActorName(), target: "sshs3 on this computer", what: `Safety policy: ${moved.join("; ")}`, outcome: "completed" })
            .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        }
        break;
      }
      case "team-rules-save": {
        const kept = this.host.teamRules;
        if (!kept || isDemoMode()) throw new Error("Rules for everyone belong to a server several people sign in to. Here the rules are your own.");
        if (!this.host.teamAdmin?.()) throw new Error("Only an administrator of this server sets the rules that hold for everyone.");
        const was = kept.read();
        const actor = await this.resolveActorName();
        const now = Date.now();
        const freezeKey = (raw: unknown): string => {
          const name = typeof raw === "string" ? raw.trim().toLowerCase().slice(0, 120) : "";
          return !name || name === "*" ? "*" : name;
        };
        const freezeName = (key: string): string => (key === "*" ? "every server" : `the cluster "${clip(key, 60)}"`);
        const freezes = Object.fromEntries(Object.entries(was.freezes ?? {}).filter(([, f]) => f.until > now));
        const moved: string[] = [];
        let peer = Boolean(was.requirePeerApprovalOnProd);
        if (request.requirePeerApprovalOnProd !== undefined) {
          if (typeof request.requirePeerApprovalOnProd !== "boolean") throw new Error("The two-person rule is either on (true) or off (false).");
          if (request.requirePeerApprovalOnProd && !peer && this.host.soleUser?.())
            throw new Error("This server has one account, so there is no second person to ask. Invite somebody first, then switch this on.");
          if (request.requirePeerApprovalOnProd !== peer) {
            moved.push(`two people on a change card or a file write on production: ${peer ? "on" : "off"} → ${request.requirePeerApprovalOnProd ? "on" : "off"}`);
            peer = request.requirePeerApprovalOnProd;
          }
        }
        if (request.endFreeze !== undefined) {
          const key = freezeKey(request.endFreeze);
          if (freezes[key]) {
            delete freezes[key];
            moved.push(`change freeze on ${freezeName(key)}: ended`);
          }
        }
        if (request.freeze !== undefined) {
          const hours = Number(request.freeze?.hours);
          if (!Number.isFinite(hours) || hours <= 0 || hours > 1440) throw new Error("A change freeze lasts a number of hours: more than 0, and at most 1440 (60 days).");
          const key = freezeKey(request.freeze.cluster);
          const why = typeof request.freeze.why === "string" && request.freeze.why.trim() ? clip(request.freeze.why.trim(), 200) : undefined;
          freezes[key] = { until: now + Math.round(hours * 3_600_000), by: actor, at: now, ...(why ? { why } : {}) };
          moved.push(`change freeze on ${freezeName(key)} until ${new Date(freezes[key].until).toISOString()}${why ? ` (${why})` : ""}`);
        }
        if (!moved.length) break;
        await this.audit().append({ kind: "setting", actor, target: "everyone on this server", what: moved.join("; "), outcome: "intent" });
        await kept.write({
          ...(peer ? { requirePeerApprovalOnProd: true } : {}),
          ...(Object.keys(freezes).length ? { freezes } : {}),
          changedBy: actor,
          changedAt: now,
        }, was);
        // Who changed the rules for everyone is the team's business as well as the log's.
        const event: WorkspaceActivityEvent = { id: crypto.randomUUID(), at: now, actor, targetLabel: "Rules for everyone", kind: "note", summary: clip(`Changed the rules for everyone on this server: ${moved.join("; ")}`, 400) };
        this.appendActivityEvent(event);
        await this.shareActivity(event).catch(() => {});
        void this.audit()
          .append({ kind: "setting", actor, target: "everyone on this server", what: `Rules for everyone: ${moved.join("; ")}`, outcome: "completed" })
          .catch((e) => log.warn("Could not write to the audit log", safeError(e)));
        break;
      }
      case "rule-save": {
        const r = request.rule;
        if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("A rule to save is missing");
        const scope = r.scope;
        if (!["global", "env", "tag", "cluster", "server"].includes(scope)) {
          throw new Error("Invalid workspace rule scope");
        }
        const activation = r.activation;
        if (!["always", "auto", "agent-requested", "manual"].includes(activation)) {
          throw new Error("Invalid workspace rule activation");
        }
        const extra = this.storeDataExtra();
        const list = extra.rules ?? [];
        const id = r.id?.trim() || crypto.randomUUID();
        const prev = list.find((x) => x.id === id);
        const now = Date.now();
        const saved: WorkspaceRule = {
          id,
          name: clip(requiredText(r.name), 120),
          scope,
          ...(r.scopeValue?.trim() ? { scopeValue: clip(r.scopeValue.trim(), 120) } : {}),
          activation,
          ...(r.description?.trim() ? { description: boundedContext(r.description.trim(), 500) } : {}),
          body: boundedContext(requiredText(r.body), 8000),
          applyToReadOnly: r.applyToReadOnly ?? true,
          enabled: r.enabled ?? true,
          ...(typeof r.priority === "number" && Number.isFinite(r.priority)
            ? { priority: integer(r.priority, -1000, 1000) }
            : {}),
          author: r.author?.trim() || prev?.author || (await this.resolveActorName()),
          createdAt: prev?.createdAt ?? r.createdAt ?? now,
          updatedAt: now,
        };
        extra.rules = [saved, ...list.filter((x) => x.id !== id)];
        break;
      }
      case "rule-delete": {
        const extra = this.storeDataExtra();
        extra.rules = (extra.rules ?? []).filter((x) => x.id !== request.id);
        break;
      }
      case "runbook-save": {
        const rb = request.runbook;
        if (!rb || typeof rb !== "object" || Array.isArray(rb)) throw new Error("A runbook to save is missing");
        if (rb.inputs !== undefined && !Array.isArray(rb.inputs)) throw new Error("A runbook's inputs are a list");
        if (rb.steps !== undefined && !Array.isArray(rb.steps)) throw new Error("A runbook's steps are a list");
        for (const step of rb.steps ?? [])
          if (!step || typeof step !== "object" || typeof step.kind !== "string")
            throw new Error("Each runbook step needs a kind");
        for (const field of rb.inputs ?? [])
          if (!field || typeof field !== "object" || typeof field.name !== "string" || !field.name.trim())
            throw new Error("Each runbook input needs a name");
        if (rb.targetSelector !== undefined && (typeof rb.targetSelector !== "object" || rb.targetSelector === null || Array.isArray(rb.targetSelector)))
          throw new Error("A runbook's target is a selector of servers");
        // A step is run later as it stands, so a secret in it is refused, not hidden on save: hidden, the
        // step would type "[redacted]". A model is never shown one anyway; a variable is entered at run time.
        (rb.steps ?? []).forEach((step, index) => {
          const secret = [step.command, step.prompt, step.expected].map((t) => (typeof t === "string" ? secretLine(t) : undefined)).find(Boolean);
          if (secret)
            throw new Error(
              `Step ${index + 1}${step.title ? ` ("${clip(step.title, 80)}")` : ""} holds a password, key or token, here shown hidden: "${secret}". sshs3 does not keep one in a runbook. Put a variable such as {{password}} in its place and enter the value when you run the step in the terminal. A model is never shown a secret, so a step that needs one is for a person to run.`,
            );
        });
        for (const field of rb.inputs ?? []) {
          const secret = typeof field.defaultValue === "string" ? secretLine(field.defaultValue) : undefined;
          if (secret)
            throw new Error(`The default value of the input "${clip(field.name, 80)}" holds a password, key or token. sshs3 does not keep one in a runbook. Leave the default empty and enter the value when you run the runbook.`);
        }
        const extra = this.storeDataExtra();
        const list = extra.runbooks ?? [];
        const id = rb.id?.trim() || crypto.randomUUID();
        const prev = list.find((x) => x.id === id);
        const now = Date.now();
        const saved: RunbookTemplate = {
          id,
          name: clip(requiredText(rb.name), 120),
          ...(rb.description?.trim() ? { description: boundedContext(rb.description.trim(), 1000) } : {}),
          inputs: Array.isArray(rb.inputs) ? rb.inputs.slice(0, 30) : [],
          steps: Array.isArray(rb.steps) ? rb.steps.slice(0, 40) : [],
          ...(rb.targetSelector ? { targetSelector: rb.targetSelector } : {}),
          ...(rb.dispatchStrategy ? { dispatchStrategy: rb.dispatchStrategy } : {}),
          ...(typeof rb.maxConcurrency === "number" && Number.isFinite(rb.maxConcurrency)
            ? { maxConcurrency: integer(rb.maxConcurrency, 1, 20) }
            : {}),
          author: rb.author?.trim() || prev?.author || (await this.resolveActorName()),
          createdAt: prev?.createdAt ?? rb.createdAt ?? now,
          updatedAt: now,
        };
        extra.runbooks = [saved, ...list.filter((x) => x.id !== id)];
        break;
      }
      case "runbook-delete": {
        const extra = this.storeDataExtra();
        extra.runbooks = (extra.runbooks ?? []).filter((x) => x.id !== request.id);
        break;
      }
      case "runbook-run": {
        const extra = this.storeDataExtra();
        const rb = (extra.runbooks ?? []).find((x) => x.id === request.id);
        if (!rb) throw new Error("Runbook not found");
        if (request.inputs !== undefined && (typeof request.inputs !== "object" || request.inputs === null || Array.isArray(request.inputs)))
          throw new Error("A runbook's inputs are given by name");
        if (
          request.targetSelector !== undefined &&
          request.targetSelector !== null &&
          (typeof request.targetSelector !== "object" || Array.isArray(request.targetSelector))
        )
          throw new Error("A runbook's target is a selector of servers");
        const inputs = request.inputs ?? {};
        for (const field of rb.inputs) {
          const val = inputs[field.name] ?? field.defaultValue;
          if (field.required && (val === undefined || val === "")) {
            throw new Error(`Runbook input "${field.label || field.name}" is required`);
          }
        }
        const substituteInputs = (raw: string): string =>
          raw.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_m, key: string) => {
            const found = inputs[key] ?? rb.inputs.find((f) => f.name === key)?.defaultValue;
            return found === undefined ? "" : String(found);
          });
        const selector = request.targetSelector ?? rb.targetSelector;
        const matchedTargets = resolveTargetSelector(this.getKnownServers(), selector);
        const stepLines = rb.steps.map((s, idx) => {
          const title = s.title || `Step ${idx + 1}`;
          const cmd = s.command ? substituteInputs(s.command) : undefined;
          const promptPart = s.prompt ? substituteInputs(s.prompt) : undefined;
          return `${idx + 1}. [${s.kind}] ${title}${cmd ? `\n   command: \`${cmd}\`` : ""}${promptPart ? `\n   prompt: ${promptPart}` : ""}${s.expected ? `\n   expected: ${s.expected}` : ""}`;
        });
        const targetNames = matchedTargets.map((t) => `${t.name} (${t.host})`).join(", ") || "active session";
        const promptText = [
          `Runbook "${rb.name}"${request.dryRun ? " (DRY RUN)" : ""}`,
          `Targets: ${targetNames}`,
          ...stepLines,
        ].join("\n");
        if (request.dryRun) {
          const now = Date.now();
          const dryTask: AgentTask = {
            id: crypto.randomUUID(),
            title: `Dry run: ${rb.name}`,
            mode: "advice",
            status: "completed",
            messages: [
              { id: crypto.randomUUID(), role: "user", text: boundedPrompt(promptText, PERSON_PROMPT_MAX), at: now },
              {
                id: crypto.randomUUID(),
                role: "assistant",
                text: `Dry run validated ${rb.steps.length} step(s) across ${matchedTargets.length || 1} target(s). No commands executed.`,
                at: now,
              },
            ],
            changes: [],
            sources: [],
            createdAt: now,
            updatedAt: now,
            maxCommands: 1,
            maxMinutes: 15,
            verification: "not-verified",
          };
          this.store.data.tasks.push(dryTask);
          reply = { started: { taskId: dryTask.id } };
        } else {
          // A runbook runs where it was aimed, or not at all: never on whatever terminal happens to be open.
          const ready = this.terminals.list().filter((s) => s.state === "ready");
          const hasSelector = !!selector && Object.values(selector).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));
          let readySession: (typeof ready)[number] | undefined;
          let scopeNote = "";
          if (hasSelector) {
            if (matchedTargets.length === 0)
              throw new Error("This runbook's target matches no server in the workspace, so it was not started.");
            const candidates = ready.filter((s) => matchedTargets.some((t) => t.id === s.profileId));
            if (candidates.length === 0)
              throw new Error(
                `No terminal is open and ready on ${matchedTargets.map((t) => t.name).join(", ")}. Open one there and run the runbook again.`,
              );
            readySession = candidates[0];
            const rest = matchedTargets.filter((t) => t.id !== readySession!.profileId);
            if (rest.length)
              scopeNote = `This run works in the terminal on ${readySession.label} only. Not covered by it: ${rest.map((t) => t.name).join(", ")}. Say so in your report.`;
          } else {
            if (ready.length !== 1)
              throw new Error(
                ready.length === 0
                  ? "This runbook names no target and no terminal is open and ready. Open the terminal it should run in."
                  : "This runbook names no target and several terminals are open. Give it a target, so that it is clear where it runs.",
              );
            readySession = ready[0];
          }
          const task = await this.start({
            prompt: scopeNote ? `${promptText}\n\n${scopeNote}` : promptText,
            mode: "assisted",
            sessionId: readySession?.id,
            maxCommands: Math.max(10, Math.min(100, rb.steps.length * 3)),
            maxMinutes: 30,
          });
          reply = { started: { taskId: task.id } };
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
