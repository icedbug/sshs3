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
import type { AiApiProtocol } from "../../shared/types/ai";
import type { AgentChange, AgentTask, RunStatus, SimulationView } from "../../shared/types/aiHub";
import { resolveModelPricing } from "../ai/hub/DirectAgentRuntime";
import { FileTools } from "../ai/hub/FileTools";
import { HubService, type HubHost } from "../ai/hub/HubService";
import { getDemoServers } from "../ai/hub/demoWorkspace";
import { FileEditorService } from "../editor/FileEditorService";
import type { IpcBridge } from "../IpcBridge";
import { StorageRegistry } from "../storage/StorageRegistry";
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
  | { kind: "plan"; summary: string; allowed: boolean; error?: string }
  | { kind: "follow-up"; text: string; passed: number; total: number }
  | { kind: "stopped"; why: string }
  | { kind: "ended"; status: RunStatus; error?: string };

export interface AgentRunOptions {
  scenarioId: string;
  /** The model service base address, including its API version. */
  baseUrl: string;
  apiProtocol?: AiApiProtocol;
  model: string;
  apiKey?: string;
  /** Who answers when the agent asks: everything is let through, nothing is, or the caller decides. */
  approve?: "all" | "none" | ((ask: ApprovalAsk) => boolean | Promise<boolean>);
  /** The run is stopped after this many commands. The app itself sets no limit. */
  maxCommands?: number;
  maxMinutes?: number;
  /**
   * What the person answers when the agent has reported and the incident is not solved, once. An
   * alert's ticket asks the agent to find out what is wrong; in a mode that asks first, the agent
   * says what it would change and stops there. This is the person reading that and saying go on.
   */
  followUp?: string;
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
  /** From starting the ticket until its run ends, including approvals and follow-ups. */
  elapsedMs: number;
  /** Time to the first nonblank text delivered to the ticket's chat. */
  firstTextMs?: number;
  /** All model HTTP calls made in this isolated scenario, including retry attempts. */
  modelRequests: number;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number; costUsd?: number };
  score: NonNullable<SimulationView["running"]>;
  /** Set when the person's follow-up was sent: how the checks stood after the agent's first report. */
  beforeFollowUp?: { passed: number; total: number; report: string };
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
  if (!Number.isSafeInteger(maxCommands) || maxCommands < 1 || !Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes * 60_000 > 2_147_483_647)
    throw new Error("Set a positive command limit and a time limit of less than 25 days.");
  const approve = options.approve ?? "all";
  const events: AgentRunEvent[] = [];
  const say = (event: AgentRunEvent): void => {
    events.push(event);
    options.onEvent?.(event);
  };

  // Terminals on the lab's servers, opened the way the app opens one for a ticket's run.
  const ptys = new Map<string, DemoVirtualPty>();
  const serverOf = new Map<string, ReturnType<typeof getDemoServers>[number]>();
  let opened = 0;
  // The servers' files, through the app's own file tools: only the connection is stood in for, since the
  // lab's terminals are not the app's SSH sessions. The storage registry gives a simulated server its files.
  // (They are made below, once the hub they read terminals from exists.)
  let spent = 0;
  let stoppedBy: AgentRunResult["stoppedBy"];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let signalStop!: () => void;
  const stopped = new Promise<void>((resolve) => { signalStop = resolve; });
  const stopAtLimit = (task: AgentTask, reason: "commands" | "minutes"): void => {
    if (stoppedBy) return;
    stoppedBy = reason;
    const why = reason === "commands" ? "The scenario reached its action limit." : "The scenario reached its time limit.";
    say({ kind: "stopped", why });
    signalStop();
    void hub.stop(task, why).catch(() => undefined);
  };
  let modelRequests = 0;
  let ticketStarted = 0;
  const firstText = new Map<string, number>();
  const host: HubHost = {
    onModelRequest: () => { modelRequests++; },
    delta: (event) => {
      if (ticketStarted && event.type === "message.delta" && event.delta?.trim() && !firstText.has(event.taskId)) {
        firstText.set(event.taskId, Math.round(performance.now() - ticketStarted));
      }
    },
    beforeAction(task) {
      if (Date.now() >= started + maxMinutes * 60_000) stopAtLimit(task, "minutes");
      if (spent >= maxCommands) stopAtLimit(task, "commands");
      if (stoppedBy) throw new Error("The scenario reached its limit.");
      spent++;
    },
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
      serverOf.set(id, server);
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
    file: (...args) => files.invoke(...args),
  };
  const hub = new HubService(host, options.dir);
  const files = new FileTools(
    {
      storageRegistry: new StorageRegistry(),
      fileEditorService: new FileEditorService({ baseTempDir: path.join(options.dir, "editor") }),
      sshPtyManager: {
        getSession: (id: string) => {
          const server = serverOf.get(id);
          return server ? { config: { id: server.id, name: server.name, host: server.host, username: server.username, port: server.port ?? 22 } } : undefined;
        },
      },
      smartcard: { prepareSftpSmartcardConfig: async (c: unknown) => c, prepareFido2SftpConfig: async (c: unknown) => c },
    } as unknown as IpcBridge,
    hub.terminals,
    () => {},
  );
  const started = Date.now();
  try {
    await hub.initialize();
    await hub.request({
      action: "configure",
      config: { enabled: true, provider: "openai-compatible", model: options.model, baseUrl: options.baseUrl, apiProtocol: options.apiProtocol, ...(options.apiKey ? { apiKey: options.apiKey } : {}) },
      // Nothing else in the lab is to spend on this model while the run lasts.
      preferences: { workforceAutopilot: false, proposeMemories: false, autoSaveMemories: false },
    });
    const sim = (await hub.request({ action: "sim-start", scenarioId: options.scenarioId })).simulation?.running;
    if (!sim?.ticketId) throw new Error("The scenario did not make a ticket to start from.");
    const others = new Set(hub.store.data.tasks.map((t) => t.id));
    ticketStarted = performance.now();
    const reply = await hub.request({ action: "ticket-start", id: sim.ticketId });
    const taskId = reply.reply?.started?.taskId;
    const task = hub.store.data.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("The ticket's run did not start.");
    deadline = setTimeout(() => stopAtLimit(task, "minutes"), Math.max(0, started + maxMinutes * 60_000 - Date.now()));
    others.add(task.id);
    say({ kind: "started", ticket: sim.ticketId, agent: task.agentName ?? "", mode: task.mode, target: task.target?.label ?? "(no terminal)", model: task.model ?? options.model });

    const told = new Set<string>();
    const asked = new Set<string>();
    let allowedCount = 0;
    let plansAnswered = 0;
    const commandsRun = (t: AgentTask): number => t.changes.filter((c) => c.kind === "command" && DECIDED.has(c.status) && c.status !== "denied").length;
    const tell = (t: AgentTask): void => {
      for (const change of t.changes) {
        if (change.kind !== "command" || !DECIDED.has(change.status) || told.has(change.id)) continue;
        told.add(change.id);
        say({ kind: "command", ref: change.ref, target: change.target, command: change.command ?? change.description, status: change.status, exitCode: change.exitCode, output: change.output });
      }
    };
    const decide = async (ask: ApprovalAsk): Promise<boolean> => (approve === "all" ? true : approve === "none" ? false : Boolean(await Promise.race([approve(ask), stopped.then(() => false)])));

    let beforeFollowUp: AgentRunResult["beforeFollowUp"];
    const lastReport = (): string => [...task.messages].reverse().find((m) => m.role === "assistant" && m.text.trim())?.text ?? "";
    for (;;) {
      tell(task);
      if (stoppedBy) break;
      if (ENDED.has(task.status)) {
        // A plan the agent proposed waits for the same person as a single change would. As in the app, it is
        // answered when the agent has stopped: a yes sends the agent on, a no sends the plan back.
        if (task.plan?.status === "proposed" && plansAnswered < 5 && task.status === "completed" && !stoppedBy) {
          plansAnswered++;
          const summary = [task.plan.goal, ...task.plan.steps.map((s) => s.command ?? s.action)].join("; ");
          const allowed = await decide({ command: summary, target: task.target?.label ?? "", description: "The agent's plan" });
          if (stoppedBy) break;
          let error: string | undefined;
          await hub
            .request({ action: "plan-decide", taskId: task.id, approved: allowed, ...(allowed ? {} : { note: "Not approved." }) })
            .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)));
          say({ kind: "plan", summary, allowed, ...(error ? { error } : {}) });
          for (let i = 0; !error && i < 100 && ENDED.has(task.status); i++) await sleep(50);
          if (!ENDED.has(task.status)) continue;
        }
        // The agent has reported. If the incident still stands, the person says go on, once.
        if (!options.followUp || beforeFollowUp || task.status !== "completed" || stoppedBy) break;
        await sleep(100);
        const now = (await hub.snapshot()).simulation?.running;
        if (!now || now.passed === now.total) break;
        beforeFollowUp = { passed: now.passed, total: now.total, report: lastReport() };
        say({ kind: "follow-up", text: options.followUp, passed: now.passed, total: now.total });
        await hub.request({ action: "reply", taskId: task.id, text: options.followUp });
        for (let i = 0; i < 100 && ENDED.has(task.status); i++) await sleep(50);
        if (ENDED.has(task.status)) break;
        continue;
      }
      for (const change of task.changes) {
        if (change.status !== "pending" || asked.has(change.id)) continue;
        asked.add(change.id);
        const ask: ApprovalAsk = { command: change.command ?? change.description, target: change.target, description: change.description, risk: change.riskLevel, reason: change.riskReason };
        const allowed = await decide(ask);
        if (stoppedBy) break;
        if (allowed) allowedCount++;
        say({ kind: "approval", ask, allowed });
        await hub.request({ action: "approve", taskId: task.id, changeId: change.id, approved: allowed });
      }
      if (commandsRun(task) >= maxCommands && !ENDED.has(task.status)) stopAtLimit(task, "commands");
      await Promise.race([sleep(options.pollMs ?? 150), stopped]);
    }
    const elapsedMs = Math.round(performance.now() - ticketStarted);
    tell(task);
    say({ kind: "ended", status: task.status, error: task.error });
    // The ticket takes the report once the run has let go of it: the checks read it from there.
    await sleep(100);
    const score = (await hub.snapshot()).simulation?.running;
    if (!score) throw new Error("The scenario was not running any more when the run ended.");
    const report = lastReport();
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
      elapsedMs,
      firstTextMs: firstText.get(task.id),
      modelRequests,
      usage: task.usage ? {
        inputTokens: task.usage.inputTokens + (task.usage.cacheReadTokens ?? 0) + (task.usage.cacheCreationTokens ?? 0),
        outputTokens: task.usage.outputTokens,
        cacheReadTokens: task.usage.cacheReadTokens ?? 0,
        cacheCreationTokens: task.usage.cacheCreationTokens ?? 0,
        ...(resolveModelPricing(task.model ?? options.model) && task.usage.costUsd !== undefined &&
          (task.usage.costUsd > 0 || modelRequests === 0) ? { costUsd: task.usage.costUsd } : {}),
      } : undefined,
      score,
      ...(beforeFollowUp ? { beforeFollowUp } : {}),
      otherRuns: hub.store.data.tasks.filter((t) => !others.has(t.id)).length,
    };
  } finally {
    clearTimeout(deadline);
    await hub.dispose().catch(() => undefined);
    for (const pty of ptys.values()) pty.kill();
  }
}
