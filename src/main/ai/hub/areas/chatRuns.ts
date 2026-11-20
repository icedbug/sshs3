import type { AgentChange, AgentPlan, AgentPlanStep, AgentTask, ChatOrigin, RunStatus, StartAgentTask } from "../../../../shared/types/aiHub";
import { lowerMode } from "../AppGuard";
import {
  allowedProfiles,
  allowedServerNamed,
  allowedServerNames,
  CHAT_NOT_EXTERNAL,
  chatChannelReadable,
  chatPrompt,
  inSharedHub,
  reachMode,
  sameChatPlace,
  type ChatFenceCheck,
} from "../chatFence";
import type { ExtraWorkspaceContext } from "../ContextService";
import { isDemoMode } from "../demoWorkspace";
import { isDemoTarget } from "../../../demo/demoMode";
import { clip, maskContext, maskStrings, safeError } from "../privacy";
import { ToolBrokerError } from "../ToolBroker";
import { log } from "../hubShared";
import type { HubService } from "../HubService";

/**
 * What a run tells whoever follows it without a browser (the chat agent posting in a thread). Each
 * event names the conversation and what happened; the text itself is read with `runView`, from what
 * the hub stored, masked. A raw piece of the model's stream is never sent.
 */
export type HubRunEvent =
  | { type: "progress"; taskId: string; event: string }
  | { type: "settled"; taskId: string; status: RunStatus }
  | { type: "asking"; taskId: string; changeId: string }
  /** A person answered a change, or the wait ended. `final`: the run goes on with this answer. */
  | { type: "answered"; taskId: string; changeId: string; allowed: boolean; how: NonNullable<AgentChange["decidedHow"]>; final: boolean }
  | { type: "plan"; taskId: string; planId: string; status: AgentPlan["status"] };

/** A conversation as somebody outside the app reads it: what it said last, what waits, how it stands. */
export interface RunView {
  taskId: string;
  title: string;
  status: RunStatus;
  /** The last thing the agent said, as stored (masked), masked once more. */
  text?: string;
  /** Changes waiting for a person, with the text that was stored for approval. */
  pending: Array<{
    id: string;
    kind: AgentChange["kind"];
    target: string;
    description: string;
    command?: string;
    hiddenValues?: boolean;
    riskLevel?: AgentChange["riskLevel"];
    riskReason?: string;
    check?: { command: string; expected: string };
    rollback?: string;
    diff?: string;
    blastRadius?: string;
    requiredApprovals: number;
    approvals: Array<{ actor: string; allowed: boolean; at: number; via?: string }>;
  }>;
  plan?: {
    id: string;
    goal: string;
    status: AgentPlan["status"];
    /** What a card shows of each step: never the hash of the raw command, which could be guessed back. */
    steps: Array<Pick<AgentPlanStep, "action" | "target" | "command" | "risk" | "check" | "checkExpected" | "rollback" | "observeSeconds">>;
    review: AgentPlan["review"];
    requiredApprovals: number;
    approvals: Array<{ actor: string; allowed: boolean; at: number; via?: string }>;
  };
  error?: string;
  /** The last tool the agent used, shortened. */
  lastStep?: { name: string; target?: string; at: number; ok?: boolean };
  commandsUsed?: number;
  usage?: AgentTask["usage"];
}

const MAX_HOPS = 5;

/**
 * Conversations asked for from a chat thread: the fence they run inside, starting and going on, the
 * terminals they get, and following a run with nobody at a browser.
 *
 * A part of HubService. These are the hub's own methods, kept in a file of their own: `this` is the hub,
 * and they are copied onto its class where it is declared (HubService.ts).
 */
export class ChatRunsPart {
  /**
   * The chat conversation a run belongs to: itself, or for an investigator or a specialist, the
   * conversation that asked for it. They look on its behalf, so its fence holds for them too.
   */
  chatLead(this: HubService, task: AgentTask): AgentTask | undefined {
    let current: AgentTask | undefined = task;
    for (let i = 0; current && i < MAX_HOPS; i++) {
      if (current.chat) return current;
      const leadId: string | undefined = current.workforceRunId ? this.workforceLeads.get(current.workforceRunId) : undefined;
      current = leadId ? this.store.data.tasks.find((t) => t.id === leadId) : undefined;
    }
    return undefined;
  }

  /** The fence a run is held to, when it belongs to a conversation asked for from chat. */
  chatFence(this: HubService, task: AgentTask): ChatFenceCheck | undefined {
    const origin = this.chatLead(task)?.chat;
    if (!origin) return undefined;
    const allowed = allowedProfiles(origin.fence, this.getKnownServers());
    const allows = (profileId: string | undefined): boolean => Boolean(profileId && allowed.has(profileId));
    return {
      origin,
      reach: origin.fence.reach,
      allows,
      // Only a terminal this run was given or opened, and only on a server inside the fence: never
      // whichever terminal of the account happens to be open.
      own: (sessionId) => {
        const session = this.terminals.get(sessionId);
        if (!session || session.kind !== "ssh" || !allows(session.profileId)) return false;
        return sessionId === task.target?.sessionId || Boolean(this.runTerminals.get(task.id)?.has(sessionId));
      },
      sees: (other) => sameChatPlace(origin, this.chatLead(other)?.chat),
    };
  }

  /**
   * Whether the hub learns from a run on its own: what failed, what fixed it, what to propose to keep.
   * Not from a run asked in a channel, or by somebody who is not linked: that hub is every channel's,
   * and what one channel's run left there, another channel's run would read.
   */
  learnsFrom(this: HubService, task: AgentTask): boolean {
    const origin = this.chatLead(task)?.chat;
    return !origin || !inSharedHub(origin);
  }

  /**
   * The workspace context as a run held to a fence is given it: its own terminals, its own servers and
   * what was done there, and the team's chat channels it may read. See ContextService.readPartitioned.
   */
  fencedContext(this: HubService, extra: ExtraWorkspaceContext, fence: ChatFenceCheck): ExtraWorkspaceContext {
    const channels = extra.teamChat
      ? this.chat.index.list().filter((c) => c.count > 0 && chatChannelReadable(fence.origin, c))
      : [];
    return {
      ...extra,
      allowSession: fence.own,
      allowProfile: fence.allows,
      allowTask: fence.sees,
      teamChat: extra.teamChat && channels.length ? { ...extra.teamChat, channels: channels.map((c) => `#${c.name}`).slice(0, 60) } : undefined,
    };
  }

  /**
   * A terminal on the server a chat run named, when that name is exactly one server inside its fence.
   * Refused otherwise, with the names it may use.
   */
  async chatTerminal(this: HubService, task: AgentTask, name: string): Promise<string> {
    const origin = this.chatLead(task)?.chat;
    if (!origin) throw new ToolBrokerError("precondition", "This run was not asked for from chat.", { code: "no_terminal" });
    if (this.getKnownServers().length === 0) await this.collectExtraContext().catch(() => undefined);
    const servers = this.getKnownServers();
    const server = allowedServerNamed(origin.fence, servers, name);
    if (!server) {
      const names = allowedServerNames(origin.fence, servers);
      throw new ToolBrokerError(
        "auth_denied",
        names.length
          ? `"${clip(name, 80)}" is not a server this chat may use. Nothing ran. Use one of: ${names.join(", ")}.`
          : `"${clip(name, 80)}" is not a server this chat may use, and it was given none. Nothing ran.`,
        { code: "outside_chat_fence" },
      );
    }
    // One it opened there already is used again, whatever name it was given by: never one more.
    const fence = this.chatFence(task);
    const open = this.terminals
      .list()
      .find((s) => s.profileId === server.id && s.state !== "disconnected" && Boolean(fence?.own(s.id)));
    if (open) return open.id;
    return this.openChatTerminal(task, server.id);
  }

  /**
   * Opens a terminal of the run's own on a server inside its fence, the way a ticket's run gets one:
   * closed when the run ends, and opened again on the same server when the conversation goes on.
   */
  async openChatTerminal(this: HubService, task: AgentTask, profileId: string): Promise<string> {
    const fence = this.chatFence(task);
    if (!fence?.allows(profileId)) throw new ToolBrokerError("auth_denied", "That server is not one this chat may use. Nothing ran.", { code: "outside_chat_fence" });
    if (!this.host.openServerTerminal || !this.host.closeSession) throw new Error("This installation cannot open a terminal for a run asked for from chat.");
    // The demo lab opens terminals on its own simulated servers only: never a connection to a real one.
    if (isDemoMode() && !isDemoTarget(profileId)) throw new Error("The demo opens terminals on its own servers only.");
    const server = this.getKnownServers().find((s) => s.id === profileId);
    const sessionId = await this.host.openServerTerminal(profileId);
    this.closeWhenRunEnds(task.id, sessionId);
    // A plan approved for this server before its terminal was closed goes on in this one.
    this.rebindPlanSteps(this.chatLead(task) ?? task, profileId, sessionId);
    const opened = this.terminals.get(sessionId);
    if (opened && !task.target) {
      task.target = { sessionId: opened.id, generation: opened.generation, label: opened.label };
      task.ownTerminal = { via: "server", profileId, shell: opened.shell ?? "bash", label: server?.name ?? opened.label };
    }
    return sessionId;
  }

  /**
   * Starts a conversation asked for from a chat thread. The person's words go after a short preface
   * that says who asked and how far the agent may go. It gets a terminal at once when there is only one
   * server it could mean: the fence has one, or the message names exactly one of them. Otherwise it
   * opens one when it names a server (chatTerminal).
   */
  async startFromChat(this: HubService, input: Omit<StartAgentTask, "sessionId">, origin: ChatOrigin): Promise<AgentTask> {
    if (input.agentId) {
      const agent = this.getAgentsList().find((a) => a.id === input.agentId);
      // Not run on the default prompt without a word: the channel's agent is not in this hub.
      if (!agent) throw new Error("The agent chosen for this channel is not there any more. An administrator can choose another in sshs3.");
      if (agent.runnerId) throw new Error(CHAT_NOT_EXTERNAL);
    }
    if (this.getKnownServers().length === 0) await this.collectExtraContext().catch(() => undefined);
    const servers = this.getKnownServers();
    const allowed = allowedProfiles(origin.fence, servers);
    const inFence = servers.filter((s) => allowed.has(s.id));
    // A name as it is written, at the end of a sentence too: "restart nginx on web-1." names web-1.
    const words = new Set(input.prompt.toLowerCase().split(/[^a-z0-9._:-]+/).map((w) => w.replace(/[.:]+$/, "")).filter(Boolean));
    const named = inFence.filter((s) => words.has(s.name.toLowerCase()) || words.has(s.host.toLowerCase()) || words.has(s.id.toLowerCase()));
    const server = inFence.length === 1 ? inFence[0] : named.length === 1 ? named[0] : undefined;
    let sessionId: string | undefined;
    if (server && this.host.openServerTerminal && this.host.closeSession && (!isDemoMode() || isDemoTarget(server.id))) {
      try {
        sessionId = await this.host.openServerTerminal(server.id);
      } catch (error) {
        // It works without one: when it names the server, it is tried again then.
        log.info("No terminal for a chat run", safeError(error));
      }
    }
    let task: AgentTask;
    try {
      task = await this.start(
        { ...input, prompt: chatPrompt(origin, input.prompt), sessionId, mode: lowerMode(input.mode, reachMode(origin.fence.reach)) },
        undefined,
        undefined,
        undefined,
        undefined,
        origin,
      );
    } catch (error) {
      if (sessionId) this.closeOwnTerminal(sessionId);
      throw error;
    }
    // Named by what the person asked, not by the preface before it: lists show the title.
    const asked = input.prompt.trim().replace(/\s+/g, " ");
    if (asked) {
      task.title = asked.slice(0, 100);
      this.changed();
    }
    if (sessionId && server) {
      const opened = this.terminals.get(sessionId);
      task.ownTerminal = { via: "server", profileId: server.id, shell: opened?.shell ?? "bash", label: server.name };
      this.closeWhenRunEnds(task.id, sessionId);
    }
    return task;
  }

  /** The next message in a chat thread goes on with its conversation. Never on another terminal: that is the run's to open. */
  async replyFromChat(this: HubService, taskId: string, text: string): Promise<void> {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task?.chat) throw new Error("That conversation was not asked for from chat.");
    await this.request({ action: "reply", taskId, text });
  }

  /** Tells the listener what the runs of this hub do, until the function it returns is called. */
  onRun(this: HubService, listener: (event: HubRunEvent) => void): () => void {
    this.runListeners.add(listener);
    return () => {
      this.runListeners.delete(listener);
    };
  }

  /** A listener that fails is logged and the others are still told: one cannot stop a run. */
  emitRun(this: HubService, event: HubRunEvent): void {
    if (this.disposed || this.runListeners.size === 0) return;
    for (const listener of [...this.runListeners]) {
      try {
        listener(event);
      } catch (error) {
        log.warn("A run listener failed", safeError(error));
      }
    }
  }

  /**
   * A conversation as it is stored now, for somebody who follows it without a browser. Every text in it
   * is masked here: the conversation in memory holds the model's own words as they were, and only its
   * copy on disk was masked.
   */
  runView(this: HubService, taskId: string): RunView {
    const task = this.store.data.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("Task not found");
    const said = [...task.messages].reverse().find((m) => m.role === "assistant" && m.text.trim());
    const votes = (list: AgentChange["approvals"]) =>
      (list ?? []).map((a) => ({ actor: a.actor, allowed: a.allowed, at: a.at, ...(a.via ? { via: a.via } : {}) }));
    const step = task.toolLog?.at(-1);
    const plan = task.plan;
    const pending = task.changes.filter((c) => c.status === "pending");
    const view: RunView = maskStrings({
      taskId: task.id,
      title: task.title,
      status: task.status,
      ...(said ? { text: said.text } : {}),
      pending: pending.map((c) => ({
        id: c.id,
        kind: c.kind,
        target: c.target,
        description: c.description,
        ...(c.command !== undefined ? { command: c.command } : {}),
        ...(c.hiddenValues ? { hiddenValues: true } : {}),
        ...(c.riskLevel ? { riskLevel: c.riskLevel } : {}),
        ...(c.riskReason ? { riskReason: c.riskReason } : {}),
        ...(c.check ? { check: { command: c.check.command, expected: c.check.expected } } : {}),
        ...(c.rollback ? { rollback: c.rollback.command } : {}),
        ...(c.diff ? { diff: c.diff } : {}),
        ...(c.blastRadius ? { blastRadius: c.blastRadius } : {}),
        requiredApprovals: Math.max(1, c.requiredApprovals ?? 1),
        approvals: votes(c.approvals),
      })),
      ...(plan
        ? {
            plan: {
              id: plan.id,
              goal: plan.goal,
              status: plan.status,
              steps: plan.steps.map(({ action, target, command, risk, check, checkExpected, rollback, observeSeconds }) => ({
                action,
                ...(target !== undefined ? { target } : {}),
                ...(command !== undefined ? { command } : {}),
                risk,
                check,
                ...(checkExpected !== undefined ? { checkExpected } : {}),
                ...(rollback !== undefined ? { rollback } : {}),
                ...(observeSeconds !== undefined ? { observeSeconds } : {}),
              })),
              review: plan.review,
              requiredApprovals: Math.max(1, plan.requiredApprovals ?? 1),
              approvals: votes(plan.approvals),
            },
          }
        : {}),
      ...(task.error ? { error: maskContext(task.error) } : {}),
      ...(step ? { lastStep: { name: step.name, ...(step.target ? { target: step.target } : {}), at: step.at, ...(step.ok !== undefined ? { ok: step.ok } : {}) } } : {}),
      ...(task.commandsUsed !== undefined ? { commandsUsed: task.commandsUsed } : {}),
      ...(task.usage ? { usage: task.usage } : {}),
    });
    // The ids name what a card answers: kept exactly as they are.
    view.taskId = task.id;
    view.pending.forEach((c, i) => (c.id = pending[i].id));
    if (view.plan && plan) view.plan.id = plan.id;
    return view;
  }
}
