import crypto from "node:crypto";
import type { HubReply, AgentTask, MissionAgent, WorkGoal, WorkTicket, WorkTicketStatus } from "../../../../shared/types/aiHub";
import { isDemoMode } from "../demoWorkspace";
import { isDemoTarget } from "../../../demo/demoMode";
import { boundedContext, clip, safeError } from "../privacy";
import {
  TICKET_STATUSES,
  mergeItems,
  mergeTicketCopies,
  stampChange,
  ticketRemovedMessage,
  withComment,
  claimIsFresh,
  live,
  nextForHeartbeat,
  ticketAfterRun,
  ticketPrompt,
  whyNotRunnable,
} from "../WorkBoard";
import { requiredText } from "../hubHelpers";
import { log, active, withUnanswered, WORK_SYNC_INTERVAL_MS } from "../hubShared";
import type { HubService } from "../HubService";
import type { Handled, RequestsOf } from "./routes";

/**
 * The board: goals and tickets.
 *
 * Saving, moving, removing and deciding a ticket, starting its agent on it (once, whichever
 * installation claims it), finding its run again after a restart, and the board's own clock.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class TicketsPart {
  ticket(this: HubService, id: string): WorkTicket {
    const found = live(this.store.data.workTickets).find((t) => t.id === id);
    if (!found) throw new Error(ticketRemovedMessage(this.store.data.workTickets, id) ?? "Ticket not found");
    return found;
  }

  /** Whether this installation's agent is running the ticket now: its run decides about the run's fields. */
  ticketRunningHere(this: HubService, t: WorkTicket): boolean {
    return (
      !t.deleted &&
      t.status === "in_progress" &&
      t.claim?.client === this.clientId() &&
      this.store.data.tasks.some((x) => x.id === t.taskId)
    );
  }

  /**
   * Takes the bucket's copy of one ticket into the board now, instead of at the next sync (up to a
   * minute away): before an edit, so that it is not made on a view the team has moved past, and after
   * an action a teammate's run refused, so that the board shows the run.
   */
  async pullTicket(this: HubService, id: string): Promise<void> {
    const sync = this.work();
    if (!sync) return;
    const remote = await sync.readItem<WorkTicket>("tickets", id).catch(() => undefined);
    if (!remote) return;
    const merged = mergeItems(this.store.data.workTickets ?? [], [remote], (l, r) =>
      mergeTicketCopies(l, r, (t) => this.ticketRunningHere(t)),
    );
    if (!merged.changed) return;
    this.store.data.workTickets = merged.items;
    // A copy made of both (a removal that stands, two edits put together) goes back to the team.
    const mine = merged.newerLocally.find((t) => t.id === id);
    if (mine) void sync.put("tickets", mine).catch((e) => (this.workSyncError = safeError(e)));
    this.changed();
  }

  /** Stores a ticket here and sends it to the team. The upload is not waited for. */
  putTicket(this: HubService, ticket: WorkTicket): void {
    const had = (this.store.data.workTickets ?? []).find((t) => t.id === ticket.id);
    // When it came to this status: what tells a new "review" from an old one with a new comment.
    ticket = { ...ticket, statusAt: had && had.status === ticket.status ? (had.statusAt ?? ticket.statusAt) : Date.now() };
    // Which fields this change touched, and which version it was made from: what a merge needs to
    // keep a teammate's change of another field, and to let a removal made meanwhile stand.
    ticket = stampChange(had, ticket);
    this.store.data.workTickets = [
      ...(this.store.data.workTickets ?? []).filter((t) => t.id !== ticket.id),
      ticket,
    ];
    void this.work()
      ?.put("tickets", ticket)
      .catch((e) => (this.workSyncError = safeError(e)));
    // Its issue may be owed a result, a decision or a close: looked at on the next tick, not in two minutes.
    if (ticket.external && had && had.status !== ticket.status) this.atlassian.kick();
    this.changed();
  }

  putGoal(this: HubService, goal: WorkGoal): void {
    goal = stampChange((this.store.data.workGoals ?? []).find((g) => g.id === goal.id), goal);
    this.store.data.workGoals = [
      ...(this.store.data.workGoals ?? []).filter((g) => g.id !== goal.id),
      goal,
    ];
    void this.work()
      ?.put("goals", goal)
      .catch((e) => (this.workSyncError = safeError(e)));
    this.changed();
  }

  /** Creates or changes a ticket from a form or from an agent's tool call. */
  async saveTicketFrom(this: HubService,
    input: {
      id?: string;
      title: string;
      description?: string;
      goalId?: string;
      status?: WorkTicketStatus;
      assigneeAgentId?: string;
      target?: string;
      blockedBy?: string[];
      parentId?: string;
      outside?: string;
    },
    createdBy?: string,
    /** Made by an agent's run, not by a person. */
    byAgent = false,
    /** Filled with what was saved differently from what was asked, for the reply. */
    notes: string[] = [],
  ): Promise<WorkTicket> {
    const known = input.id
      ? live(this.store.data.workTickets).find((t) => t.id === input.id)
      : undefined;
    // A ticket that an agent is running keeps its place on the board: its text can be changed, its status
    // belongs to the run. Asked of the bucket too, because this board can be behind another installation's.
    const running = known ? await this.ticketRunsNow(known) : undefined;
    // Read again after the question: the board may have moved while the bucket answered.
    const existing = known ? live(this.store.data.workTickets).find((t) => t.id === known.id) : undefined;
    // Removed by a teammate meanwhile: the edit does not bring it back (as a new ticket either).
    if (known && !existing) throw new Error(ticketRemovedMessage(this.store.data.workTickets, known.id) ?? "Ticket not found");
    if (!known && input.id) {
      const removed = ticketRemovedMessage(this.store.data.workTickets, input.id);
      if (removed) throw new Error(removed);
    }
    const now = Date.now();
    const agent = input.assigneeAgentId
      ? this.getAgentsList().find((a) => a.id === input.assigneeAgentId)
      : undefined;
    if (input.assigneeAgentId && !agent) throw new Error("The assigned agent does not exist");
    const goals = live(this.store.data.workGoals);
    // Outside text travels: a ticket split off one that came from outside carries the mark too.
    const parent = input.parentId ? live(this.store.data.workTickets).find((t) => t.id === input.parentId) : undefined;
    const outside = existing?.outside ?? input.outside ?? (parent?.outside ? `split off "${clip(parent.title, 80)}" (${parent.outside})` : undefined);
    const wanted =
      input.status && TICKET_STATUSES.includes(input.status) && input.status !== "in_progress"
        ? input.status
        : // A backlog ticket that gets an agent is ready for it, unless its alert put it aside.
          existing?.status === "backlog" && !existing.assigneeAgentId && agent && !existing.alert?.parked
          ? "todo"
          : (existing?.status ?? (agent ? "todo" : "backlog"));
    // An agent cannot put work that started outside the team in front of another agent: a person moves it.
    const status =
      running && existing ? existing.status : byAgent && outside && !existing && wanted === "todo" ? "backlog" : wanted;
    if (running && existing && input.status && input.status !== existing.status)
      notes.push(`The status was not changed. ${running}`);
    else if (input.status === "in_progress" && existing?.status !== "in_progress")
      notes.push("The status was not changed: a ticket is in progress while an agent runs it. Start it instead.");
    if (input.goalId && !goals.some((g) => g.id === input.goalId))
      notes.push("The goal does not exist, so the ticket was saved without one.");
    const id = existing?.id ?? `t-${crypto.randomUUID().slice(0, 8)}`;
    const blockers = (input.blockedBy ?? existing?.blockedBy ?? []).filter(
      (b) => b !== id && live(this.store.data.workTickets).some((t) => t.id === b),
    );
    const dropped = (input.blockedBy ?? []).filter((b) => !blockers.includes(b));
    if (dropped.length)
      notes.push(
        `Left out of "waits for", because ${dropped.length === 1 ? "it is" : "they are"} not on the board${dropped.includes(id) ? " (a ticket cannot wait for itself)" : ""}: ${dropped.join(", ")}.`,
      );
    const ticket: WorkTicket = {
      ...existing,
      id,
      title: clip(requiredText(input.title), 200),
      description: clip(input.description?.trim() ?? existing?.description ?? "", 8000),
      goalId: goals.some((g) => g.id === input.goalId) ? input.goalId : undefined,
      status,
      assigneeAgentId: agent?.id,
      assigneeName: agent?.name,
      target: input.target?.trim() ? boundedContext(input.target.trim(), 200) : undefined,
      blockedBy: blockers,
      parentId: input.parentId ?? existing?.parentId,
      ...(outside ? { outside } : {}),
      createdBy: existing?.createdBy ?? createdBy ?? (await this.resolveActorName()),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.putTicket(ticket);
    return ticket;
  }

  /**
   * Checks the ticket out and wakes its agent for it. With a team bucket the
   * claim is taken there first, so a teammate's app that reaches for the same
   * ticket finds it taken.
   */
  async startTicket(this: HubService, id: string, sessionId?: string): Promise<AgentTask> {
    // Decided before anything is awaited: opening the run's terminal can take half a minute, and the
    // next heartbeat pass (or a second click) in that time must find the ticket taken.
    if (this.ticketStarts.has(id)) throw new Error("This ticket is already being started.");
    const client = this.clientId();
    const before = this.ticket(id);
    // Its conversation is running here (a person went on with it, or its run has not handed the
    // ticket back yet): a second run of the same ticket would be two agents on one piece of work.
    if (this.store.data.tasks.some((t) => t.id === before.taskId && active(t)))
      throw new Error("An agent is already running this ticket. Stop the run first.");
    this.ticketStarts.add(id);
    try {
      return await this.startTicketOnce(before, client, sessionId);
    } finally {
      this.ticketStarts.delete(id);
    }
  }

  async startTicketOnce(this: HubService, ticket: WorkTicket, client: string, sessionId?: string): Promise<AgentTask> {
    const agents = this.getAgentsList();
    const reason = whyNotRunnable(ticket, {
      tickets: live(this.store.data.workTickets),
      agents,
      usage: this.usageTotal(),
      runners: (this.store.data.externalRunners ?? []).map((r) => r.id),
      client,
    });
    if (reason) throw new Error(reason);
    const agent = agents.find((a) => a.id === ticket.assigneeAgentId)!;
    const by = await this.resolveActorName();
    const now = Date.now();
    const sync = this.work();
    if (sync) {
      // The claim is decided only after the bucket has settled, and another installation's claim is
      // judged alive by this machine's own observation, not by that machine's clock.
      const held = await sync.claim(ticket.id, { by, client }, now, {
        fresh: (c) => this.claimAlive(ticket.id, c.seenAt, Date.now()),
        settle: this.notifySettle,
      });
      if (held.client !== client) throw new Error(`${held.by} is already running this ticket.`);
    }
    // The board shows the ticket taken from here on, also while the terminal is being opened.
    this.putTicket({ ...ticket, status: "in_progress", claim: { by, client, at: now, seenAt: now }, taskId: undefined, updatedAt: now });
    const giveBack = (): void => {
      const current = live(this.store.data.workTickets).find((t) => t.id === ticket.id);
      // Only what this start put there: an edit made meanwhile stays.
      if (current?.status === "in_progress" && current.claim?.client === client && current.claim.at === now && !current.taskId)
        this.putTicket({ ...current, status: ticket.status, claim: undefined, taskId: ticket.taskId, updatedAt: Date.now() });
    };
    // Nobody sits at a terminal for a ticket the heartbeat takes (or one started without naming a
    // terminal): where the ticket names one of the workspace's servers, the run gets a terminal of its own there.
    let own: Awaited<ReturnType<HubService["openTicketTerminal"]>>;
    let task: AgentTask;
    try {
      own = sessionId ? undefined : await this.openTicketTerminal(ticket, agent);
      task = await this.start({
        prompt:
          ticketPrompt(
            ticket,
            live(this.store.data.workGoals).find((g) => g.id === ticket.goalId),
            { tickets: live(this.store.data.workTickets), agents, agent },
          ) + (own?.note ? `\n\n${own.note}` : ""),
        sessionId: sessionId ?? own?.sessionId,
        mode: agent.defaultMode,
        agentId: agent.id,
        agentName: agent.name,
      }, undefined, undefined, undefined, ticket.id);
    } catch (e) {
      if (own?.sessionId) this.closeOwnTerminal(own.sessionId);
      giveBack();
      await sync?.release(ticket.id, client).catch(() => undefined);
      throw e;
    }
    if (own?.sessionId) {
      task.ownTerminal = own.terminal;
      this.closeWhenRunEnds(task.id, own.sessionId);
    }
    task.ticketId = ticket.id;
    task.title = clip(`Ticket: ${ticket.title}`, 100);
    this.putTicket({
      // What was written on the ticket while the terminal opened (a comment, an alert firing again) stays.
      ...(live(this.store.data.workTickets).find((t) => t.id === ticket.id) ?? ticket),
      status: "in_progress",
      claim: { by, client, at: now, seenAt: now },
      taskId: task.id,
      result: undefined,
      updatedAt: now,
    });
    return task;
  }

  /**
   * Why the ticket cannot be moved, removed or decided right now: somebody's agent is running it. Asked
   * of the claim in the bucket, not only of this installation's copy of the ticket. The board here can
   * be most of a minute behind, and an edit made on that old view would take the ticket from under a
   * teammate's run. Undefined when nobody runs it.
   */
  async ticketRunsNow(this: HubService, ticket: WorkTicket): Promise<string | undefined> {
    const client = this.clientId();
    const here = "An agent is running this ticket. Stop the run first.";
    if (
      ticket.status === "in_progress" &&
      ticket.claim?.client === client &&
      this.store.data.tasks.some((t) => t.id === ticket.taskId && active(t))
    )
      return here;
    // The ticket as the team has it, taken in now: a refused action shows the run on the board at
    // once, and an edit of a ticket a teammate removed is told so.
    const [claim] = await Promise.all([
      this.work()
        ?.readClaim(ticket.id)
        .catch(() => undefined),
      this.pullTicket(ticket.id).catch(() => undefined),
    ]);
    if (claim && claim.client !== client && this.claimAlive(ticket.id, claim.seenAt, Date.now()))
      return `${claim.by} is running this ticket on another computer. Stop the run there first.`;
    return ticket.status === "in_progress" && claimIsFresh(ticket) ? here : undefined;
  }

  /**
   * A ticket's conversation that goes on after its run ended (the agent's plan was approved, a person
   * answered it, "Continue") is the ticket's run again. The ticket is checked out once more, so that
   * what this run does and reports ends up on the ticket. Without this the ticket kept the report of
   * the run that only proposed the plan, also after the work was done.
   */
  async reattachTicket(this: HubService, task: AgentTask): Promise<void> {
    if (!task.ticketId) return;
    const ticket = live(this.store.data.workTickets).find((t) => t.id === task.ticketId);
    // Only the ticket's latest conversation, and not one a person has already closed.
    if (!ticket || ticket.taskId !== task.id || ticket.status === "in_progress" || ticket.status === "done") return;
    // The heartbeat is starting this ticket right now: that start has it. Otherwise this one holds it
    // until it is written, so the heartbeat does not start a second run while the claim is being taken.
    if (this.ticketStarts.has(ticket.id)) return;
    this.ticketStarts.add(ticket.id);
    try {
      await this.reattachTicketNow(task, ticket);
    } finally {
      this.ticketStarts.delete(ticket.id);
    }
  }

  async reattachTicketNow(this: HubService, task: AgentTask, ticket: WorkTicket): Promise<void> {
    const client = this.clientId();
    const by = await this.resolveActorName();
    const now = Date.now();
    const sync = this.work();
    if (sync) {
      const held = await sync
        .claim(ticket.id, { by, client }, now, { fresh: (c) => this.claimAlive(ticket.id, c.seenAt, Date.now()) })
        .catch(() => undefined);
      // Somebody else's app has taken the ticket meanwhile: the conversation goes on, the ticket is theirs.
      if (held && held.client !== client) return;
    }
    const current = live(this.store.data.workTickets).find((t) => t.id === ticket.id);
    if (!current || current.taskId !== task.id || current.status === "done") return;
    this.putTicket({ ...current, status: "in_progress", claim: { by, client, at: now, seenAt: now }, updatedAt: now });
  }

  /**
   * A terminal for a ticket's run on the server the ticket names. Undefined
   * when the ticket names none of the workspace's servers or the agent only
   * advises; a `note` instead of a session when the server is known and no
   * terminal could be opened on it (it needs a person to sign in, it is
   * down): the run is told, so that its report says so.
   */
  async openTicketTerminal(this: HubService,
    ticket: WorkTicket,
    agent: MissionAgent,
  ): Promise<{ sessionId?: string; terminal?: NonNullable<AgentTask["ownTerminal"]>; note?: string } | undefined> {
    const name = ticket.target?.trim().toLowerCase();
    if (!name || agent.defaultMode === "advice" || agent.runnerId) return undefined;
    if (!this.host.openServerTerminal || !this.host.closeSession) return undefined;
    if (this.getKnownServers().length === 0) await this.collectExtraContext().catch(() => undefined);
    const server = this.getKnownServers().find(
      (s) => s.name.toLowerCase() === name || s.id.toLowerCase() === name || s.host?.toLowerCase() === name,
    );
    if (!server) return undefined;
    // The demo lab opens terminals on its own simulated servers only: never a connection to a real one.
    if (isDemoMode() && !isDemoTarget(server.id)) return undefined;
    try {
      const sessionId = await this.host.openServerTerminal(server.id);
      return { sessionId, terminal: { via: "server", profileId: server.id, shell: "bash", label: server.name } };
    } catch (error) {
      log.info("No terminal for a ticket run", safeError(error));
      return {
        note: `No terminal could be opened on ${server.name} for this run (${clip(safeError(error), 300)}), so you cannot run commands there. Say so in your report, with what a person should check on the server.`,
      };
    }
  }

  /**
   * Tickets this app is running whose run has ended: the report goes on the
   * ticket, the tokens on the agent's budget, and the ticket to review.
   */
  settleTickets(this: HubService): void {
    const client = this.clientId();
    for (const ticket of live(this.store.data.workTickets)) {
      if (ticket.status !== "in_progress" || ticket.claim?.client !== client || this.ticketStarts.has(ticket.id)) continue;
      const task = this.store.data.tasks.find((t) => t.id === ticket.taskId);
      if (task && active(task)) continue;
      if (!task) {
        // The conversation is gone (history was deleted): the ticket goes back.
        this.putTicket({ ...ticket, status: "todo", claim: undefined, updatedAt: Date.now() });
      } else {
        // Only what was not counted when the run ended (a run that carries the agent has been).
        this.countAgentUsage(task, ticket.assigneeAgentId ?? task.agentId);
        this.putTicket(withUnanswered(ticketAfterRun(ticket, task), task, ticket.claim?.at ?? 0));
      }
      void this.work()
        ?.release(ticket.id, client)
        .catch(() => undefined);
    }
  }

  async workTick(this: HubService, now = Date.now(), aiEnabled?: boolean): Promise<void> {
    this.settleTickets();
    const client = this.clientId();
    const sync = this.work();
    if (sync && !this.workSyncing && now - this.lastWorkSync >= WORK_SYNC_INTERVAL_MS) {
      this.workSyncing = true;
      this.lastWorkSync = now;
      const run = this.runWorkSync(sync, client, now);
      this.workSyncInFlight = run;
      try {
        await run;
      } finally {
        if (this.workSyncInFlight === run) this.workSyncInFlight = undefined;
        this.workSyncing = false;
        if (!this.disposed && this.lastWorkSync === 0) {
          this.scheduleWorkSync(50);
        }
      }
    }
    // A run that stopped reporting (closed laptop, crash) frees its ticket.
    for (const t of live(this.store.data.workTickets)) {
      if (t.status !== "in_progress") continue;
      if (t.claim?.client === client) {
        if (this.ticketStarts.has(t.id) || this.store.data.tasks.some((x) => x.id === t.taskId && active(x))) continue;
      } else if (t.claim && (sync ? this.claimAlive(t.id, t.claim.seenAt, now) : claimIsFresh(t, now))) continue;
      this.putTicket({
        ...withComment(t, "sshS3", `The run by ${t.claim?.by ?? "somebody"} stopped reporting; the ticket is free again.`),
        status: "todo",
        claim: undefined,
      });
    }
    if (this.store.data.preferences.workforceAutopilot !== true) return;
    if (this.storeDataExtra().workforcePaused) return;
    if (!(aiEnabled ?? (await this.config.getView().catch(() => ({ enabled: false }))).enabled)) return;
    const tickets = live(this.store.data.workTickets);
    const targetKey = (t: WorkTicket): string => t.target?.trim().toLowerCase() || "__untargeted__";
    const inFlightTickets = tickets.filter((t) => t.status === "in_progress" && t.claim?.client === client);
    // No limit on how many tickets run at once; one at a time on a target, so two runs do not work the same server.
    const busyTargets = new Set<string>(inFlightTickets.map(targetKey));
    for (const startId of this.ticketStarts) {
      const startingTicket = tickets.find((t) => t.id === startId);
      if (startingTicket) busyTargets.add(targetKey(startingTicket));
    }
    const availableTickets = tickets.filter(
      (t) =>
        t.status === "todo" &&
        !busyTargets.has(targetKey(t)) &&
        !this.store.data.tasks.some((task) => task.id === t.taskId && active(task)),
    );
    const next = nextForHeartbeat({
      tickets: availableTickets,
      agents: this.getAgentsList(),
      usage: this.usageTotal(),
      runners: (this.store.data.externalRunners ?? []).map((r) => r.id),
      client,
      now,
      infraEdges: this.getInfraEdgesList(),
    });
    if (next)
      await this.startTicket(next.id).catch((e) =>
        log.warn("Heartbeat could not start a ticket", safeError(e)),
      );
  }
  /** The requests this part answers. What a case leaves in `reply` goes back with the snapshot. */
  async handleTickets(this: HubService, request: RequestsOf<"tickets">): Promise<Handled> {
    let reply: HubReply | undefined;
    switch (request.action) {
      case "goal-save": {
        const g = request.goal;
        const existing = (this.store.data.workGoals ?? []).find((x) => x.id === g.id);
        const now = Date.now();
        this.putGoal({
          id: existing?.id ?? crypto.randomUUID(),
          title: clip(requiredText(g.title), 200),
          description: g.description?.trim() ? boundedContext(g.description.trim(), 4000) : undefined,
          status: g.status === "done" ? "done" : "active",
          author: existing?.author ?? (await this.resolveActorName()),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        break;
      }
      case "goal-delete": {
        const goal = (this.store.data.workGoals ?? []).find((x) => x.id === request.id);
        if (goal) this.putGoal({ ...goal, deleted: true, updatedAt: Date.now() });
        break;
      }
      case "ticket-save": {
        const notes: string[] = [];
        await this.saveTicketFrom(request.ticket, undefined, false, notes);
        if (notes.length) reply = { notes };
        break;
      }
      case "ticket-move": {
        if (!TICKET_STATUSES.includes(request.status)) throw new Error("Unknown ticket status");
        if (request.status === "in_progress")
          throw new Error("A ticket is in progress while an agent runs it: start it instead.");
        const running = await this.ticketRunsNow(this.ticket(request.id));
        if (running) throw new Error(running);
        // Read again: the check asked the bucket, and the board may have moved meanwhile.
        this.putTicket({ ...this.ticket(request.id), status: request.status, claim: undefined, updatedAt: Date.now() });
        break;
      }
      case "ticket-delete": {
        // Removing a ticket from under its run would leave the run's result with nowhere to go.
        const running = await this.ticketRunsNow(this.ticket(request.id));
        if (running) throw new Error(running);
        this.putTicket({
          ...this.ticket(request.id),
          deleted: true,
          deletedBy: await this.resolveActorName(),
          claim: undefined,
          updatedAt: Date.now(),
        });
        break;
      }
      case "ticket-restore": {
        // A removal is a mark on the ticket, so taking the mark away brings it back as it was.
        const gone = (this.store.data.workTickets ?? []).find((t) => t.id === request.id);
        if (!gone) throw new Error("That ticket is not here any more.");
        if (gone.deleted) this.putTicket({ ...gone, deleted: undefined, deletedBy: undefined, updatedAt: Date.now() });
        reply = { notes: [`Brought back "${clip(gone.title, 120)}".`] };
        break;
      }
      case "ticket-result": {
        await this.pullTicket(request.id);
        const ticket = this.ticket(request.id);
        const running = await this.ticketRunsNow(ticket);
        if (running) throw new Error(running);
        const text = boundedContext(request.result.trim(), 8000);
        if (!text) throw new Error("Write what was wrong and what you did.");
        // A person's own account of the work: kept as the ticket's result, with who wrote it in the notes.
        const who = await this.resolveActorName();
        this.putTicket({
          ...ticket,
          result: text,
          comments: [...(ticket.comments ?? []), { id: crypto.randomUUID(), author: who, text: "Wrote the report.", at: Date.now() }].slice(-100),
          updatedAt: Date.now(),
        });
        break;
      }
      case "ticket-comment": {
        await this.pullTicket(request.id);
        const ticket = this.ticket(request.id);
        this.putTicket(
          withComment(ticket, await this.resolveActorName(), requiredText(request.text)),
        );
        break;
      }
      case "ticket-start":
        try {
          reply = { started: { taskId: (await this.startTicket(request.id, request.sessionId)).id } };
        } catch (e) {
          // Refused (a teammate's run has it, it was removed): the board shows why at once.
          await this.pullTicket(request.id).catch(() => undefined);
          throw e;
        }
        break;
      case "ticket-review": {
        const ticket = this.ticket(request.id);
        if (ticket.status !== "review" && ticket.status !== "blocked")
          throw new Error("Only a ticket in review or blocked can be decided.");
        const running = await this.ticketRunsNow(ticket);
        if (running) throw new Error(running);
        // "Done" would be said of work that has not started: the agent's plan still waits for its answer.
        if (request.approve && this.store.data.tasks.find((t) => t.id === ticket.taskId)?.plan?.status === "proposed")
          throw new Error(
            "The agent proposed a plan and has not carried it out. Approve or reject the plan in the conversation first, or send the ticket back.",
          );
        const who = await this.resolveActorName();
        const note = request.note?.trim();
        let decided = note
          ? withComment(ticket, who, `${request.approve ? "Approved" : "Sent back"}: ${note}`)
          : ticket;
        // A ticket that mirrors an issue: the decision is written there too, with who made it.
        if (ticket.external) {
          if (!note && request.approve) decided = withComment(ticket, who, "Approved as done.");
          const last = decided.comments?.[decided.comments.length - 1];
          if (last && decided !== ticket)
            decided = { ...decided, comments: decided.comments!.map((c) => (c.id === last.id ? { ...c, push: "jira" as const } : c)) };
        }
        this.putTicket({
          ...decided,
          status: request.approve ? "done" : "todo",
          claim: undefined,
          updatedAt: Date.now(),
        });
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
