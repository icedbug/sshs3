import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import type { AgentTask, ShellKind, TerminalSession } from "../../../shared/types/aiHub";
import { SHELL_KINDS } from "../../../shared/types/aiHub";
import type { HubService } from "../hub/HubService";
import type { ToolRequest } from "../hub/ToolBroker";
import { safeError } from "../hub/privacy";

type Hub = Pick<HubService, "initialize" | "terminals" | "broker" | "store" | "changed">;
export interface NativeOwner { profileHome: string; sessionId: string }
export interface NativeBinding { owner: NativeOwner; task: AgentTask }
export interface NativeToolSnapshot { selected?: TerminalSession; bindings: NativeBinding[] }

/** Native backend identities are trusted inputs; model arguments never select a PTY or grant. */
export class NativeToolBridge {
  private server?: http.Server;
  private starting?: Promise<Record<string, string>>;
  private capability = crypto.randomBytes(32).toString("hex");
  private selected?: Pick<TerminalSession, "id" | "generation">;
  private owners = new Map<string, NativeOwner>();
  private grants = new Map<string, string>();
  private launches = new Map<string, Promise<unknown>>();
  private runChanges = new Map<string, number>();
  private hub?: Hub;
  private disposed = false;

  constructor(private readonly getHub: () => Hub, private readonly changed: () => void) {}

  start(): Promise<Record<string, string>> {
    return this.starting ??= (async () => {
      if (this.disposed) throw new Error("Terminal bridge has stopped");
      this.server = http.createServer((req, res) => { void this.handle(req, res); });
      this.server.requestTimeout = 15_000;
      this.server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", resolve);
      });
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("Terminal bridge unavailable");
      return {
        SSHS3_NATIVE_TOOL_URL: `http://127.0.0.1:${address.port}/native-tool`,
        SSHS3_NATIVE_TOOL_KEY: this.capability,
      };
    })();
  }

  /** Called only by the authenticated sshs3 terminal renderer. Existing bindings are untouched. */
  selectTerminal(sessionId?: string): void {
    const session = sessionId ? this.requireHub().terminals.get(sessionId) : undefined;
    if (sessionId && !session) throw new Error("Selected terminal does not exist");
    this.selected = session ? { id: session.id, generation: session.generation } : undefined;
    this.changed();
  }

  async armSelected(shell: ShellKind): Promise<void> {
    const hub = this.requireHub();
    if (!SHELL_KINDS.includes(shell)) throw new Error("Choose a supported shell");
    if (!this.selected) throw new Error("Select a terminal first");
    const selected = hub.terminals.get(this.selected.id);
    if (!selected || selected.generation !== this.selected.generation)
      throw new Error("Selected terminal instance changed; select it again");
    await hub.terminals.arm(selected.id, shell);
    this.selected = { id: selected.id, generation: hub.terminals.get(selected.id)!.generation };
    this.changed();
  }

  snapshot(): NativeToolSnapshot {
    const hub = this.requireHub();
    const selected = this.selected && hub.terminals.get(this.selected.id);
    return {
      selected: selected?.generation === this.selected?.generation ? selected : undefined,
      bindings: [...this.owners].flatMap(([id, owner]) => {
        const task = hub.store.data.tasks.find((item) => item.id === id);
        return task ? [{ owner, task }] : [];
      }),
    };
  }

  approve(taskId: string, changeId: string, approved: boolean): void {
    if (typeof approved !== "boolean") throw new Error("An explicit approval decision is required");
    this.requireNativeTask(taskId);
    this.requireHub().broker.approve(taskId, changeId, approved);
  }

  takeover(taskId: string): void {
    const task = this.requireNativeTask(taskId);
    this.stop(task, "Control returned to the user; inspect the terminal before resuming.");
  }

  /** Explicit UI action. A reconnect is never accepted from a model tool or a tab change. */
  async resume(taskId: string): Promise<void> {
    const hub = this.requireHub();
    const task = this.requireNativeTask(taskId);
    if (["running", "waiting"].includes(task.status)) throw new Error("Task is already active");
    const current = task.target && hub.terminals.get(task.target.sessionId);
    if (!current || current.state !== "ready") throw new Error("Arm the assigned terminal at its idle prompt first");
    if (current.owner && current.owner !== task.id) throw new Error("Another task owns the assigned terminal");
    task.target = { sessionId: current.id, generation: current.generation, label: current.label };
    task.status = "completed";
    task.error = undefined;
    this.notify();
  }

  private requireHub(): Hub {
    if (this.disposed) throw new Error("Terminal bridge is not ready");
    if (!this.hub) {
      this.hub = this.getHub();
      this.hub.terminals.on("invalidated", this.invalidate);
      this.hub.terminals.on("changed", this.changed);
    }
    return this.hub;
  }

  private owner(input: unknown): NativeOwner {
    const value = input as Partial<NativeOwner> | undefined;
    if (!value || typeof value.profileHome !== "string" || !path.isAbsolute(value.profileHome) ||
      value.profileHome.length > 4096 || typeof value.sessionId !== "string" ||
      !value.sessionId || value.sessionId.length > 256 || [...value.profileHome + value.sessionId].some((character) => character.charCodeAt(0) < 32))
      throw new Error("A trusted Hermes profile and session identity are required");
    const home = path.resolve(value.profileHome);
    return { profileHome: process.platform === "win32" ? home.toLowerCase() : home, sessionId: value.sessionId };
  }

  private id(owner: NativeOwner): string {
    return "native-hermes:" + crypto.createHash("sha256").update(JSON.stringify(owner)).digest("hex");
  }

  private find(owner: NativeOwner): AgentTask | undefined {
    const id = this.id(owner);
    const task = this.requireHub().store.data.tasks.find((item) => item.id === id);
    if (task) this.owners.set(id, owner);
    return task;
  }

  private requireNativeTask(id: string): AgentTask {
    if (!this.owners.has(id)) throw new Error("Unknown native Hermes binding");
    const task = this.requireHub().store.data.tasks.find((item) => item.id === id);
    if (!task) throw new Error("Native task no longer exists");
    return task;
  }

  private notify(): void {
    this.requireHub().changed();
    this.changed();
  }

  private invalidate = (taskId: string, reason: string): void => {
    if (!this.owners.has(taskId) || this.disposed) return;
    const task = this.requireNativeTask(taskId);
    task.status = "interrupted";
    task.error = reason;
    task.verification = "incomplete";
    this.requireHub().broker.revoke(task.id);
    this.grants.delete(task.id);
    this.runChanges.delete(task.id);
    this.notify();
  };

  private stop(task: AgentTask, reason: string): void {
    const hub = this.requireHub();
    task.status = "interrupted";
    task.error = reason;
    task.verification = "incomplete";
    hub.broker.revoke(task.id);
    this.grants.delete(task.id);
    this.runChanges.delete(task.id);
    hub.terminals.release(task.id);
    this.notify();
  }

  private begin(owner: NativeOwner, platform: unknown): Promise<unknown> {
    const id = this.id(owner);
    const existing = this.launches.get(id);
    if (existing) return existing;
    const launch = this.bind(owner, platform).finally(() => this.launches.delete(id));
    this.launches.set(id, launch);
    return launch;
  }

  private async bind(owner: NativeOwner, platform: unknown): Promise<unknown> {
    const hub = this.requireHub();
    let task = this.find(owner);
    if (!task) {
      if (platform !== "desktop" || !this.selected) return { bound: false };
      const terminal = hub.terminals.get(this.selected.id);
      task = {
        id: this.id(owner), title: `Hermes · ${terminal?.label ?? "Unavailable terminal"}`,
        target: { sessionId: this.selected.id, generation: this.selected.generation, label: terminal?.label ?? "Unavailable terminal" },
        mode: "assisted", status: "completed", messages: [], changes: [], sources: [],
        createdAt: Date.now(), updatedAt: Date.now(), maxCommands: 30, maxMinutes: 15,
        verification: "not-verified",
      };
      hub.store.data.tasks.push(task);
      this.owners.set(task.id, owner);
    }
    if (["interrupted", "failed", "cancelled"].includes(task.status))
      return { bound: true, active: false, error: task.error ?? "Resume this task explicitly in sshs3", taskId: task.id };
    if (!this.grants.has(task.id)) {
      try {
        if (!task.target) throw new Error("No terminal target was assigned");
        hub.terminals.claim(task.target.sessionId, task.target.generation, task.id);
        task.status = "running";
        task.error = undefined;
        this.runChanges.set(task.id, task.changes.length);
        const grant = await hub.broker.issue(task);
        if (task.status !== "running" || this.disposed) hub.broker.revoke(task.id);
        else this.grants.set(task.id, grant.key);
      } catch (error) {
        this.stop(task, safeError(error));
      }
      this.notify();
    }
    return { bound: true, active: this.grants.has(task.id), taskId: task.id, target: task.target?.label, error: task.error };
  }

  private async dispatch(input: Record<string, unknown>): Promise<unknown> {
    await this.requireHub().initialize();
    const owner = this.owner(input.owner);
    if (input.action === "begin") return this.begin(owner, input.platform);
    const task = this.find(owner);
    if (input.action === "status") return { bound: Boolean(task), taskId: task?.id, status: task?.status };
    if (input.action === "end") {
      await this.launches.get(this.id(owner));
      if (task) {
        const hub = this.requireHub();
        hub.broker.revoke(task.id);
        this.grants.delete(task.id);
        const changes = task.changes.slice(this.runChanges.get(task.id) ?? task.changes.length);
        this.runChanges.delete(task.id);
        const uncertain = changes.some((change) => change.status === "running" || change.status === "uncertain");
        if (input.interrupted || uncertain || task.status === "interrupted") this.stop(task, task.error ?? "Turn interrupted; inspect any unfinished operation before resuming.");
        else {
          task.status = input.failed ? "failed" : "completed";
          task.updatedAt = Date.now();
          hub.terminals.release(task.id);
          this.notify();
        }
      }
      return { bound: Boolean(task) };
    }
    if (input.action !== "tool" || !task) throw new Error("No terminal is bound to this Hermes conversation");
    const key = this.grants.get(task.id);
    if (!key) throw new Error("Terminal authority is inactive; explicitly resume the assigned task");
    const raw = input.request as Record<string, unknown> | undefined;
    if (!raw || typeof raw.action !== "string" || !["context", "command", "verify", "file-read", "file-write"].includes(raw.action))
      throw new Error("Unsupported sshs3 tool");
    const request: ToolRequest = { action: raw.action };
    for (const field of ["command", "query", "path", "content", "expected", "description"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error("Invalid tool arguments");
      request[field] = raw[field] as string | undefined;
    }
    return this.requireHub().broker.invoke(key, request);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const supplied = Buffer.from(bearer);
    const expected = Buffer.from(this.capability);
    if (req.method !== "POST" || req.url !== "/native-tool" || req.headers.origin !== undefined ||
      supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 128_000) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid native tool request");
      const result = await this.dispatch(input as Record<string, unknown>);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: safeError(error) }));
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.hub) {
      for (const id of this.grants.keys()) this.stop(this.requireNativeTask(id), "Application stopping; no commands will be replayed.");
      this.hub.terminals.off("invalidated", this.invalidate);
      this.hub.terminals.off("changed", this.changed);
    }
    this.disposed = true;
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }
}
