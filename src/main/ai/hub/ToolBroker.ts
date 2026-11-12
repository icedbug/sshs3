import { planCoversCommand } from "./PlanMode";
import crypto from "node:crypto";
import http from "node:http";
import type {
  AgentChange,
  AgentTask,
  SafetyPolicyConfig,
} from "../../../shared/types/aiHub";
import type { TerminalRegistry } from "./TerminalRegistry";
import {
  analyzeCommandSafety,
  shouldRequireCommandApproval,
} from "./CommandSafetyService";
import { boundedContext, safeError } from "./privacy";

export interface ToolRequest {
  action: string;
  command?: string;
  query?: string;
  id?: string;
  path?: string;
  content?: string;
  expected?: string;
  /** With `change`: the read-only command that shows the change worked, and what its output must contain. */
  check?: { command?: string; expected?: string };
  /** With `change`: the command that takes it back. */
  rollback?: string;
  /** With `change`: how long the check has to keep passing. */
  observeSeconds?: number;
  description?: string;
  title?: string;
  text?: string;
  kind?: "memory" | "skill";
  scope?: string;
  payload?: Record<string, unknown>;
}
/** The next short name for a command in this conversation: c1, c2, … */
export const nextRef = (task: AgentTask): string =>
  `c${task.changes.reduce((max, c) => Math.max(max, Number(/^c(\d+)$/.exec(c.ref ?? "")?.[1] ?? 0)), 0) + 1}`;

export interface ToolDependencies {
  context(task: AgentTask, query?: string, sessionId?: string): Promise<unknown>;
  memory(task: AgentTask, request: ToolRequest): Promise<unknown>;
  file(
    task: AgentTask,
    request: ToolRequest,
    authorize: (change: AgentChange) => Promise<void>,
  ): Promise<unknown>;
  appAction?(
    task: AgentTask,
    request: ToolRequest,
    authorize: (change: AgentChange) => Promise<void>,
  ): Promise<unknown>;
  openLocalTerminal?(): Promise<string>;
  activity?(task: AgentTask, change: AgentChange, sessionId?: string): void;
  safetyContext?(
    task: AgentTask,
    targetLabel?: string,
  ): { policy?: SafetyPolicyConfig; targetTags?: string[] };
  /** How long a person is given to approve, in milliseconds. Ten minutes unless set. */
  approvalWaitMs?(): number;
  /** A run stood still this long waiting for a person: that time is not the run's own. */
  waited?(task: AgentTask, ms: number): void;
  changed(): void;
}

/** A random capability is issued to one run. Model-supplied IDs can never rebind its target. */
export class ToolBroker {
  private server?: http.Server;
  private listening?: Promise<void>;
  private grants = new Map<
    string,
    { task: AgentTask; commands: number; expiresAt: number; busy: boolean }
  >();
  private approvals = new Map<
    string,
    {
      taskId: string;
      resolve: (allowed: boolean) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    private readonly terminals: TerminalRegistry,
    private readonly deps: ToolDependencies,
  ) {}

  async issue(task: AgentTask): Promise<{ url: string; key: string }> {
    if (!this.server) {
      this.server = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      this.listening = new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", resolve);
      });
      this.server.requestTimeout = 15_000;
      this.server.headersTimeout = 10_000;
    }
    await this.listening;
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Tool service unavailable");
    const key = crypto.randomBytes(32).toString("hex");
    this.grants.set(key, {
      task,
      commands: 0,
      expiresAt: Date.now() + task.maxMinutes * 60_000,
      busy: false,
    });
    return { url: `http://127.0.0.1:${address.port}/tool`, key };
  }

  approve(taskId: string, changeId: string, allowed: boolean): void {
    const approval = this.approvals.get(changeId);
    if (!approval || approval.taskId !== taskId)
      throw new Error("Approval expired or belongs to another task");
    clearTimeout(approval.timer);
    this.approvals.delete(changeId);
    approval.resolve(allowed);
  }

  /**
   * Asks the user about an action that does not go through this broker's own
   * tools (an external agent's request). The action is listed on the task as
   * pending; the answer comes through approve() like any other.
   */
  async askApproval(task: AgentTask, change: AgentChange): Promise<boolean> {
    task.changes.push(change);
    task.status = "waiting";
    this.deps.changed();
    const allowed = await this.waitForPerson(task, change.id);
    const still = task.status === "waiting";
    change.status = allowed && still ? "approved" : "denied";
    if (still) task.status = "running";
    this.deps.changed();
    return allowed && still;
  }

  /**
   * Waits for a person's answer. The time spent waiting is given back to the
   * run: its capability and its time budget are both moved by as long as it
   * stood still, so an answer that takes twenty minutes does not find a
   * fifteen-minute run already dead.
   */
  private async waitForPerson(task: AgentTask, changeId: string): Promise<boolean> {
    const started = Date.now();
    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(changeId);
        resolve(false);
      }, this.deps.approvalWaitMs?.() ?? 10 * 60_000);
      this.approvals.set(changeId, { taskId: task.id, resolve, timer });
    });
    const waited = Date.now() - started;
    for (const grant of this.grants.values()) if (grant.task.id === task.id) grant.expiresAt += waited;
    this.deps.waited?.(task, waited);
    return allowed;
  }

  revoke(taskId: string): void {
    for (const [key, grant] of this.grants)
      if (grant.task.id === taskId) this.grants.delete(key);
    for (const [id, approval] of this.approvals) {
      if (approval.taskId !== taskId) continue;
      clearTimeout(approval.timer);
      this.approvals.delete(id);
      approval.resolve(false);
    }
  }

  async invoke(key: string, request: ToolRequest): Promise<unknown> {
    const grant = this.grants.get(key);
    if (
      !grant ||
      Date.now() >= grant.expiresAt ||
      !["running", "waiting"].includes(grant.task.status)
    )
      throw new Error("Run capability expired");
    if (grant.busy) throw new Error("A tool call is already active");
    grant.busy = true;
    try {
      const task = grant.task;
      if (request.action === "context")
        return await this.deps.context(task, request.query, request.id);
      if (
        request.action === "memory" ||
        request.action === "skills" ||
        request.action === "memory-save"
      )
        return await this.deps.memory(task, request);
      if (
        (request.action.startsWith("sshs3_") ||
          request.action.startsWith("mcp__")) &&
        this.deps.appAction
      ) {
        const res = await this.deps.appAction(task, request, (change) =>
          this.authorize(key, task, change),
        );
        this.deps.changed();
        return res;
      }
      if (request.action === "file-read" || request.action === "file-write") {
        if (request.action === "file-write" && task.investigator)
          throw new Error("An investigator does not change files.");
        if (
          request.action === "file-write" &&
          ++grant.commands > task.maxCommands
        )
          throw new Error("Action budget exhausted");
        const fileRes = await this.deps.file(task, request, (change) =>
          this.authorize(key, task, change),
        );
        if (request.action === "file-write") {
          const lastChange = task.changes.at(-1);
          if (lastChange) {
            this.deps.activity?.(task, lastChange, request.id ?? task.target?.sessionId);
          }
        }
        return fileRes;
      }
      if (
        !["command", "verify", "change"].includes(request.action) ||
        typeof request.command !== "string" ||
        !request.command.trim() ||
        request.command.length > 16_000
      )
        throw new Error("Unsupported or invalid tool call");
      if (
        request.action === "verify" &&
        (typeof request.expected !== "string" || !request.expected.trim())
      )
        throw new Error("Verification needs an explicit expected observation");

      // Resolve target terminal: explicit request.id (sessionId, profileId, or node label) or bound task.target
      let target = task.target;
      if (request.id) {
        const direct = this.terminals.get(request.id);
        const byMatch =
          direct ??
          this.terminals
            .list()
            .find(
              (s) =>
                s.state !== "disconnected" &&
                (s.id === request.id ||
                  s.profileId === request.id ||
                  s.label.toLowerCase() === request.id!.toLowerCase() ||
                  s.label.toLowerCase().includes(request.id!.toLowerCase())),
            );
        if (byMatch && byMatch.state !== "disconnected") {
          target = {
            sessionId: byMatch.id,
            generation: byMatch.generation,
            label: byMatch.label,
          };
          if (!task.target) {
            task.target = target;
          }
        }
      }
      if (!target) {
        const fallbackSession = this.terminals
          .list()
          .find((s) => s.state !== "disconnected");
        if (fallbackSession) {
          target = {
            sessionId: fallbackSession.id,
            generation: fallbackSession.generation,
            label: fallbackSession.label,
          };
          task.target = target;
        } else if (this.deps.openLocalTerminal && task.mode !== "advice") {
          const newSessionId = await this.deps.openLocalTerminal();
          const created = this.terminals.get(newSessionId);
          if (created) {
            target = {
              sessionId: created.id,
              generation: created.generation,
              label: created.label,
            };
            task.target = target;
          }
        }
      }
      if (!target)
        throw new Error("No terminal was assigned to this task");
      if (++grant.commands > task.maxCommands)
        throw new Error("Command budget exhausted");

      // Auto-handshake on demand if the terminal has not been armed yet (and was not invalidated)
      if (task.mode !== "advice" || task.investigator) {
        const live = this.terminals.get(target.sessionId);
        if (
          live &&
          live.generation === target.generation &&
          (live.state !== "ready" || !live.shell)
        ) {
          const ready = await this.terminals.ensureReady(target.sessionId);
          target = {
            sessionId: ready.id,
            generation: ready.generation,
            label: ready.label,
          };
          task.target = target;
        }
        const afterPrepare = this.terminals.get(target.sessionId);
        if (
          afterPrepare &&
          afterPrepare.generation === target.generation &&
          afterPrepare.state === "ready" &&
          afterPrepare.owner !== task.id
        ) {
          this.terminals.claim(target.sessionId, target.generation, task.id);
        }
      }

      if (request.action === "change")
        return await this.runChange(key, task, target, request);

      const safety = analyzeCommandSafety(request.command);
      const change: AgentChange = {
        id: crypto.randomUUID(),
        kind: "command",
        target: target.label,
        description: boundedContext(
          request.description || "Run terminal command",
        ),
        command: boundedContext(request.command, 16_000),
        status: "pending",
        riskLevel: safety.riskLevel,
        riskReason: safety.riskReason,
        parsedSubcommands: safety.parsedSubcommands,
        ref: nextRef(task),
        at: Date.now(),
      };
      task.changes.push(change);
      await this.authorize(key, task, change);
      change.status = "running";
      this.deps.changed();
      try {
        const result = await this.terminals.execute(
          target.sessionId,
          target.generation,
          task.id,
          request.command,
        );
        change.status = result.exitCode === 0 ? "completed" : "failed";
        change.exitCode = result.exitCode;
        change.output = result.output;
        if (request.action === "verify")
          task.verification =
            result.exitCode === 0 && result.output.includes(request.expected!)
              ? "verified"
              : "incomplete";
        else task.verification = "not-verified";
        this.deps.activity?.(task, change, target.sessionId);
        this.deps.changed();
        return {
          ...result,
          // Cite this in the report, in brackets, after what it shows.
          ref: change.ref,
          commandId: change.id,
          source: `terminal:${target.sessionId}`,
          observedAt: Date.now(),
        };
      } catch (error) {
        change.status = "uncertain";
        change.output = safeError(error);
        task.verification = "incomplete";
        this.deps.changed();
        throw error;
      }
    } finally {
      grant.busy = false;
    }
  }

  /** Between two looks at the check while a change is observed. Replaced in tests. */
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * A change that carries its own proof and its own way back. The check is
   * looked at before, the change runs after the usual approval, and the check
   * has to pass afterwards and keep passing for the observation time. If it
   * does not, the rollback runs at once, once, and the agent is told what
   * happened instead of being left to notice.
   */
  private async runChange(
    key: string,
    task: AgentTask,
    target: NonNullable<AgentTask["target"]>,
    request: ToolRequest,
  ): Promise<unknown> {
    const command = request.command!;
    const checkCommand = request.check?.command?.trim() ?? "";
    const expected = request.check?.expected?.trim() ?? "";
    const rollback = request.rollback?.trim() ?? "";
    if (!checkCommand || !expected)
      throw new Error("A change needs a check: a read-only command and what its output must contain when the change worked.");
    if (!rollback) throw new Error("A change needs a rollback: the command that takes it back.");
    if (analyzeCommandSafety(checkCommand).riskLevel !== "safe")
      throw new Error("The check must only look: it is run before and after the change, and again after a rollback.");
    const run = (c: string) => this.terminals.execute(target.sessionId, target.generation, task.id, c);
    const passes = (r: { exitCode: number; output: string }): boolean => r.exitCode === 0 && r.output.includes(expected);

    const before = await run(checkCommand);
    const safety = analyzeCommandSafety(command);
    const undo = analyzeCommandSafety(rollback);
    // Approved as one thing: the worse of the change and its way back decides how it is treated.
    const worst = [safety, undo].sort(
      (a, b) => ["safe", "modify", "destructive"].indexOf(b.riskLevel) - ["safe", "modify", "destructive"].indexOf(a.riskLevel),
    )[0];
    const change: AgentChange = {
      id: crypto.randomUUID(),
      kind: "command",
      target: target.label,
      description: boundedContext(request.description || "Make a change"),
      command: boundedContext(command, 16_000),
      status: "pending",
      riskLevel: worst.riskLevel,
      riskReason: worst.riskReason,
      parsedSubcommands: safety.parsedSubcommands,
      check: { command: boundedContext(checkCommand, 2000), expected: boundedContext(expected, 400), before: passes(before) },
      rollback: { command: boundedContext(rollback, 4000) },
      ref: nextRef(task),
      at: Date.now(),
    };
    task.changes.push(change);
    await this.authorize(key, task, change);
    change.status = "running";
    this.deps.changed();
    try {
      const result = await run(command);
      change.exitCode = result.exitCode;
      change.output = result.output;
      const observeMs = Math.max(0, Math.min(180, Math.round(request.observeSeconds ?? 0))) * 1000;
      const until = Date.now() + observeMs;
      let last = result;
      let ok = result.exitCode === 0;
      while (ok) {
        last = await run(checkCommand);
        ok = passes(last);
        const left = until - Date.now();
        if (!ok || left <= 0) break;
        await this.wait(Math.min(10_000, left));
      }
      change.check = { ...change.check!, after: ok, output: boundedContext(last.output, 2000) };
      this.deps.activity?.(task, change, target.sessionId);
      if (ok) {
        change.status = "completed";
        task.verification = "verified";
        this.deps.changed();
        return {
          id: change.id,
          ref: change.ref,
          exitCode: result.exitCode,
          output: result.output,
          checkPassed: true,
          checkPassedBefore: change.check.before,
          observedSeconds: observeMs / 1000,
        };
      }
      // The change did not hold: take it back now, once.
      let undone: { exitCode: number; output: string };
      try {
        undone = await run(rollback);
      } catch (error) {
        undone = { exitCode: -1, output: safeError(error) };
      }
      let checkAfter: boolean | undefined;
      try {
        checkAfter = passes(await run(checkCommand));
      } catch {
        checkAfter = undefined;
      }
      change.rollback = { command: change.rollback!.command, ran: true, exitCode: undone.exitCode, output: boundedContext(undone.output, 2000), checkAfter };
      change.status = "failed";
      task.verification = "incomplete";
      this.deps.changed();
      return {
        id: change.id,
        exitCode: result.exitCode,
        output: result.output,
        checkPassed: false,
        checkOutput: last.output,
        rolledBack: undone.exitCode === 0,
        rollbackExitCode: undone.exitCode,
        rollbackOutput: undone.output,
        checkPassesAfterRollback: checkAfter,
        next:
          undone.exitCode === 0
            ? "The change did not pass its check and was rolled back. Do not make the same change again: find out why the check failed first."
            : "The change did not pass its check, and the rollback failed too. Stop making changes. Report exactly this state to the person, with the outputs above.",
      };
    } catch (error) {
      change.status = "uncertain";
      change.output = safeError(error);
      task.verification = "incomplete";
      this.deps.changed();
      throw error;
    }
  }

  private async authorize(
    key: string,
    task: AgentTask,
    change: AgentChange,
  ): Promise<void> {
    if (task.investigator) {
      // An investigator looks and never changes: only what the classifier calls read-only, and nobody is asked.
      const readOnly = change.kind === "command" && change.riskLevel === "safe";
      change.status = readOnly ? "approved" : "denied";
      this.deps.changed();
      if (!readOnly)
        throw new Error(
          `An investigator only runs read-only commands, and this one is classified as "${change.riskLevel ?? "changing"}"${change.riskReason ? ` (${change.riskReason})` : ""}. Find it out another way, or report that it needs a command you may not run.`,
        );
      const grant = this.grants.get(key);
      if (!grant || Date.now() >= grant.expiresAt || task.status !== "running")
        throw new Error("Run capability revoked");
      return;
    }
    if (task.mode === "advice") {
      change.status = "denied";
      this.deps.changed();
      throw new Error("Advice mode does not execute commands or change files");
    }

    let requiresApproval = task.mode === "assisted";
    if (
      (change.kind === "command" || change.kind === "file") &&
      this.deps.safetyContext
    ) {
      const ctx = this.deps.safetyContext(task, change.target);
      requiresApproval = shouldRequireCommandApproval({
        analysis: {
          riskLevel: change.riskLevel ?? "modify",
          riskReason:
            change.riskReason ??
            (change.kind === "file" ? "Remote file modification" : ""),
          parsedSubcommands: change.parsedSubcommands ?? [],
        },
        mode: task.mode,
        targetTags: ctx.targetTags,
        policy: ctx.policy,
      });
      // On its own on production, a change has to carry its check and its way
      // back; a bare command that changes something is not run at all.
      const prod = (ctx.targetTags ?? []).some((t) => ["prod", "production", "critical"].includes(t.toLowerCase()));
      if (
        task.mode === "autonomous" &&
        prod &&
        (ctx.policy?.requireApprovalOnProdTags ?? true) &&
        change.kind === "command" &&
        !change.check &&
        (change.riskLevel ?? "modify") !== "safe"
      ) {
        change.status = "denied";
        this.deps.changed();
        throw new Error(
          "This target is production and you are running on your own: a change here must be made with sshs3_change, which carries the check that shows it worked and the rollback that takes it back.",
        );
      }
    }

    // The user approved a plan that lists exactly this command: it is not asked
    // about a second time. A destructive command is always asked about.
    if (
      requiresApproval &&
      change.kind === "command" &&
      planCoversCommand(task, change.command, change.riskLevel)
    )
      requiresApproval = false;

    if (requiresApproval) {
      task.status = "waiting";
      this.deps.changed();
      const allowed = await this.waitForPerson(task, change.id);
      const grant = this.grants.get(key);
      if (
        !allowed ||
        !grant ||
        Date.now() >= grant.expiresAt ||
        task.status !== "waiting"
      ) {
        change.status = "denied";
        if (grant && task.status === "waiting") task.status = "running";
        this.deps.changed();
        throw new Error("Action not approved or task stopped");
      }
      task.status = "running";
    }
    const grant = this.grants.get(key);
    if (!grant || Date.now() >= grant.expiresAt || task.status !== "running")
      throw new Error("Run capability revoked");
    change.status = "approved";
    this.deps.changed();
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // No browser clients, redirects, CORS or cookies. Only the private Python adapter holds a capability.
    if (req.method !== "POST" || req.url !== "/tool" || req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    const key = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.grants.has(key)) {
      res.writeHead(401).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (body.length > 128_000) {
          res.writeHead(413).end();
          return;
        }
      }
      const input: unknown = JSON.parse(body);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid tool request");
      const result = await this.invoke(key, input as ToolRequest);
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ result }));
    } catch (error) {
      res
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: safeError(error) }));
    }
  }

  async dispose(): Promise<void> {
    for (const grant of [...this.grants.values()]) this.revoke(grant.task.id);
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }
}
