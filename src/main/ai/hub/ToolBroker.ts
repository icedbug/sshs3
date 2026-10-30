import crypto from "node:crypto";
import http from "node:http";
import type { AgentChange, AgentTask } from "../../../shared/types/aiHub";
import type { TerminalRegistry } from "./TerminalRegistry";
import { boundedContext, safeError } from "./privacy";

export interface ToolRequest {
  action: string;
  command?: string;
  query?: string;
  id?: string;
  path?: string;
  content?: string;
  expected?: string;
  description?: string;
  title?: string;
  text?: string;
  kind?: "memory" | "skill";
  scope?: string;
  payload?: Record<string, unknown>;
}
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
        !["command", "verify"].includes(request.action) ||
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
      if (task.mode !== "advice") {
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

      const change: AgentChange = {
        id: crypto.randomUUID(),
        kind: "command",
        target: target.label,
        description: boundedContext(
          request.description || "Run terminal command",
        ),
        command: boundedContext(request.command, 16_000),
        status: "pending",
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

  private async authorize(
    key: string,
    task: AgentTask,
    change: AgentChange,
  ): Promise<void> {
    if (task.mode === "advice") {
      change.status = "denied";
      this.deps.changed();
      throw new Error("Advice mode does not execute commands or change files");
    }
    if (task.mode === "assisted") {
      task.status = "waiting";
      this.deps.changed();
      const allowed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.approvals.delete(change.id);
          resolve(false);
        }, 10 * 60_000);
        this.approvals.set(change.id, { taskId: task.id, resolve, timer });
      });
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
