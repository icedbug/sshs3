/**
 * An agent, run by a model, working one of the lab's incidents from start to finish.
 *
 * Nothing in the app uses this: it drives the hub from outside, the way a person at the app would.
 * The scenario is started, the ticket its alert became is started, the agent works in a terminal on
 * the simulated server, somebody answers when it asks to change something, and at the end the
 * scenario's own checks say how it went. `npm run sim -- <id> --agent` prints what this returns.
 *
 * The hub is the real one, in demo mode: the same broker, terminals, safety rules and approvals a
 * run in the app goes through. Only the model's address is given from outside.
 */
import path from "node:path";
import type { AgentChange, AgentTask, RunStatus, SimulationView } from "../../shared/types/aiHub";
import { HubService, type HubHost } from "../ai/hub/HubService";
import { getDemoServers } from "../ai/hub/demoWorkspace";
import { DemoVirtualPty } from "../demo/DemoVirtualPty";
import { isDemoMode } from "../demo/demoMode";

/** A change the agent asks a person about: what it wants to run, and where. */
export interface ApprovalAsk {
  command: string;
  target: string;
  description: string;
  risk?: string;
  reason?: string;
}

export type AgentRunEvent =
  | { kind: "started"; ticket: string; agent: string; mode: string; target: string; model: string }
  | { kind: "command"; ref?: string; target: string; command: string; status: AgentChange["status"]; exitCode?: number; output?: string }
  | { kind: "approval"; ask: ApprovalAsk; allowed: boolean }
  | { kind: "plan"; summary: string; allowed: boolean }
  | { kind: "stopped"; why: string }
  | { kind: "ended"; status: RunStatus; error?: string };

export interface AgentRunOptions {
  scenarioId: string;
  /** The model's address, OpenAI-compatible: the part before `/chat/completions`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Who answers when the agent asks: everything is let through, nothing is, or the caller decides. */
  approve?: "all" | "none" | ((ask: ApprovalAsk) => boolean | Promise<boolean>);
  /** The run is stopped after this many commands. The app itself sets no limit. */
  maxCommands?: number;
  maxMinutes?: number;
  /** An empty folder the run keeps its data in. */
  dir: string;
  onEvent?: (event: AgentRunEvent) => void;
  pollMs?: number;
}

export interface AgentRunResult {
  status: RunStatus;
  error?: string;
  /** Set when this run was stopped at its limit, not by the agent finishing. */
  stoppedBy?: "commands" | "minutes";
  agent: string;
  mode: string;
  model: string;
  /** The agent's last words: its report. */
  report: string;
  events: AgentRunEvent[];
  commands: number;
  approvals: { asked: number; allowed: number };
  minutes: number;
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  score: NonNullable<SimulationView["running"]>;
  /** Other conversations the hub started meanwhile on the same model. There should be none. */
  otherRuns: number;
}

const ENDED: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled", "interrupted"]);
const DECIDED: ReadonlySet<AgentChange["status"]> = new Set<AgentChange["status"]>(["completed", "failed", "denied", "uncertain"]);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runAgentOnScenario(options: AgentRunOptions): Promise<AgentRunResult> {
  if (!isDemoMode()) throw new Error("An agent works a scenario in the demo lab only. Start with SSHS3_DEMO=1.");
  const maxCommands = options.maxCommands ?? 40;
  const maxMinutes = options.maxMinutes ?? 15;
  const approve = options.approve ?? "all";
  const events: AgentRunEvent[] = [];
  const say = (event: AgentRunEvent): void => {
    events.push(event);
    options.onEvent?.(event);
  };

  // Terminals on the lab's servers, opened the way the app opens one for a ticket's run.
  const ptys = new Map<string, DemoVirtualPty>();
  let opened = 0;
  const host: HubHost = {
    changed: () => {},
    inventoryTargets: async () => [],
    backgroundChanged: async () => {},
    openSchedule: async () => {
      throw new Error("No scheduled job runs during a scenario run.");
    },
    show: () => {},
    aiConfigFilePath: path.join(options.dir, "ai.json"),
    defaultActorName: "the scenario run",
    // The lab's servers are the workspace's servers, as the app lists them: an alert finds the one it names.
    workspaceServers: async () => getDemoServers(),
    openServerTerminal: async (profileId) => {
      const server = getDemoServers().find((s) => s.id === profileId);
      if (!server) throw new Error(`The lab has no server "${profileId}".`);
      const id = `lab-terminal-${++opened}`;
      const pty = new DemoVirtualPty({ ...server, port: server.port ?? 22, authType: "agent" } as never, 100, 30);
      ptys.set(id, pty);
      hub.terminals.register({ id, label: server.name, kind: "ssh", profileId: server.id }, (data) => pty.write(data));
      pty.onData((data) => hub.terminals.feed(id, data));
      try {
        await hub.terminals.armAtPrompt(id, "bash");
      } catch (error) {
        pty.kill();
        ptys.delete(id);
        hub.terminals.forget(id);
        throw error;
      }
      return id;
    },
    closeSession: (id) => {
      ptys.get(id)?.kill();
      ptys.delete(id);
    },
    sessionAlive: (id) => ptys.has(id),
  };
  const hub = new HubService(host, options.dir);
  const started = Date.now();
  try {
    await hub.initialize();
    await hub.request({
      action: "configure",
      config: { enabled: true, provider: "openai-compatible", model: options.model, baseUrl: options.baseUrl, ...(options.apiKey ? { apiKey: options.apiKey } : {}) },
      // Nothing else in the lab is to spend on this model while the run lasts.
      preferences: { workforceAutopilot: false, proposeMemories: false, autoSaveMemories: false },
    });
    const sim = (await hub.request({ action: "sim-start", scenarioId: options.scenarioId })).simulation?.running;
    if (!sim?.ticketId) throw new Error("The scenario did not make a ticket to start from.");
    const others = new Set(hub.store.data.tasks.map((t) => t.id));
    const reply = await hub.request({ action: "ticket-start", id: sim.ticketId });
    const taskId = reply.reply?.started?.taskId;
    const task = hub.store.data.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("The ticket's run did not start.");
    others.add(task.id);
    say({ kind: "started", ticket: sim.ticketId, agent: task.agentName ?? "", mode: task.mode, target: task.target?.label ?? "(no terminal)", model: task.model ?? options.model });

    const told = new Set<string>();
    const asked = new Set<string>();
    let allowedCount = 0;
    let plansAnswered = 0;
    let stoppedBy: AgentRunResult["stoppedBy"];
    const commandsRun = (t: AgentTask): number => t.changes.filter((c) => c.kind === "command" && DECIDED.has(c.status) && c.status !== "denied").length;
    const tell = (t: AgentTask): void => {
      for (const change of t.changes) {
        if (change.kind !== "command" || !DECIDED.has(change.status) || told.has(change.id)) continue;
        told.add(change.id);
        say({ kind: "command", ref: change.ref, target: change.target, command: change.command ?? change.description, status: change.status, exitCode: change.exitCode, output: change.output });
      }
    };
    const decide = async (ask: ApprovalAsk): Promise<boolean> => (approve === "all" ? true : approve === "none" ? false : Boolean(await approve(ask)));

    for (;;) {
      tell(task);
      if (ENDED.has(task.status)) break;
      // A plan the agent proposed waits for the same person as a single change would.
      if (task.plan?.status === "proposed" && plansAnswered < 20) {
        plansAnswered++;
        const summary = [task.plan.goal, ...task.plan.steps.map((s) => s.command ?? s.action)].join("; ");
        const allowed = await decide({ command: summary, target: task.target?.label ?? "", description: "The agent's plan" });
        say({ kind: "plan", summary, allowed });
        await hub.request({ action: "plan-decide", taskId: task.id, approved: allowed, ...(allowed ? {} : { note: "Not approved." }) }).catch(() => undefined);
      }
      for (const change of task.changes) {
        if (change.status !== "pending" || asked.has(change.id)) continue;
        asked.add(change.id);
        const ask: ApprovalAsk = { command: change.command ?? change.description, target: change.target, description: change.description, risk: change.riskLevel, reason: change.riskReason };
        const allowed = await decide(ask);
        if (allowed) allowedCount++;
        say({ kind: "approval", ask, allowed });
        await hub.request({ action: "approve", taskId: task.id, changeId: change.id, approved: allowed });
      }
      if (!stoppedBy && commandsRun(task) >= maxCommands) stoppedBy = "commands";
      if (!stoppedBy && Date.now() - started >= maxMinutes * 60_000) stoppedBy = "minutes";
      if (stoppedBy && !ENDED.has(task.status)) {
        say({ kind: "stopped", why: stoppedBy === "commands" ? `It had run ${maxCommands} commands, which is this run's limit.` : `It had worked for ${maxMinutes} minutes, which is this run's limit.` });
        await hub.request({ action: "stop", taskId: task.id }).catch(() => undefined);
        // The stop is taken at the agent's next step: it is waited for, not assumed.
        for (let i = 0; i < 200 && !ENDED.has(task.status); i++) await sleep(50);
        break;
      }
      await sleep(options.pollMs ?? 150);
    }
    tell(task);
    say({ kind: "ended", status: task.status, error: task.error });
    // The ticket takes the report once the run has let go of it: the checks read it from there.
    await sleep(100);
    const score = (await hub.snapshot()).simulation?.running;
    if (!score) throw new Error("The scenario was not running any more when the run ended.");
    const report = [...task.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text ?? "";
    return {
      status: task.status,
      error: task.error,
      stoppedBy,
      agent: task.agentName ?? "",
      mode: task.mode,
      model: task.model ?? options.model,
      report,
      events,
      commands: commandsRun(task),
      approvals: { asked: asked.size, allowed: allowedCount },
      minutes: Math.round(((Date.now() - started) / 60_000) * 10) / 10,
      usage: task.usage ? { inputTokens: task.usage.inputTokens, outputTokens: task.usage.outputTokens, ...(task.usage.costUsd !== undefined ? { costUsd: task.usage.costUsd } : {}) } : undefined,
      score,
      otherRuns: hub.store.data.tasks.filter((t) => !others.has(t.id)).length,
    };
  } finally {
    await hub.dispose().catch(() => undefined);
    for (const pty of ptys.values()) pty.kill();
  }
}
