import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentTask, AgentTodo, ExternalRunner, ExternalRunnerPreset } from "../../../shared/types/aiHub";
import type { HermesModelConfig } from "../HermesManager";
import type { AgentRuntime, RunEvent } from "./AgentRuntime";
import { boundedContext, safeError } from "./privacy";

/**
 * Runs a conversation on an external coding agent (Claude Code, Codex, Gemini
 * CLI and others) over the Agent Client Protocol: the agent is a program
 * started on this computer that speaks JSON-RPC, one message per line, on its
 * standard input and output. sshS3 is the client: it sends the prompt, shows
 * what the agent reports, and answers when the agent asks for permission.
 *
 * The agent works in its own way with its own tools, in the folder it was
 * given. What it reads and writes there is not routed through sshS3; what it
 * asks permission for is.
 */

export const ACP_PROTOCOL_VERSION = 1;

/**
 * Agents known to speak ACP. The npm names are the official adapters; a
 * command is only ever run after the user saved it as a runner.
 */
export const EXTERNAL_RUNNER_PRESETS: ExternalRunnerPreset[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    note: "Needs Claude Code signed in on this computer.",
  },
  {
    id: "codex",
    name: "Codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    note: "Needs Codex signed in on this computer.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    note: "Needs the Gemini CLI installed and signed in. Check the flag against your version.",
  },
];
const MAX_LINE_BYTES = 8_000_000;

/** What the agent wants to do, as far as it told us. */
export interface PermissionQuestion {
  title: string;
  kind?: string;
  /** The shell command, when the tool call is one. */
  command?: string;
  /** Everything the agent said it would do, as it said it (masked by the hub before it is shown). */
  rawInput?: string;
  /** The agent's id for the tool call: how it reports, later, how the call ended. */
  toolCallId?: string;
}
/** Resolves true to allow this once, false to refuse. */
export type PermissionAsk = (question: PermissionQuestion) => Promise<boolean>;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function textOf(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as { type?: string; text?: unknown };
  return c.type === "text" && typeof c.text === "string" ? c.text : "";
}

/** The shell command inside a tool call's raw input, under the names agents use for it. */
function commandOf(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const r = rawInput as Record<string, unknown>;
  const value = r.command ?? r.cmd ?? r.script;
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((x) => typeof x === "string")) return value.join(" ");
  return undefined;
}

function toolOutput(content: unknown, rawOutput: unknown): string {
  const parts: string[] = [];
  if (Array.isArray(content))
    for (const item of content) {
      const c = item as { type?: string; content?: unknown; path?: unknown };
      if (c.type === "content") parts.push(textOf(c.content));
      else if (c.type === "diff" && typeof c.path === "string") parts.push(`(changed ${c.path})`);
    }
  if (parts.join("").trim()) return parts.join("\n");
  if (typeof rawOutput === "string") return rawOutput;
  return rawOutput === undefined || rawOutput === null ? "" : JSON.stringify(rawOutput);
}

export class AcpRuntime implements AgentRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionId?: string;
  private stopped = false;
  private exited = false;
  private stderr = "";
  /** Each tool call the agent announced: its title, input (parsed and as text) and kind, by its id. */
  private tools = new Map<string, { title: string; input: string; raw?: unknown; kind?: string }>();

  constructor(
    private readonly runner: ExternalRunner,
    private readonly options: {
      /** Put before the user's message: who the agent is here and what it is working towards. */
      preface: string;
      ask: PermissionAsk;
      clientVersion?: string;
      /** How a tool call the person was asked about ended, as the agent reported it. */
      settled?: (toolCallId: string, outcome: { failed: boolean; output: string }) => void;
    },
  ) {}

  async start(
    task: AgentTask,
    _model: HermesModelConfig | undefined,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    const cwd = this.runner.cwd?.trim();
    if (!cwd) throw new Error(`"${this.runner.name}" has no working folder set on this computer.`);
    let text = "";
    try {
      this.child = spawn(this.runner.command, this.runner.args ?? [], {
        cwd,
        // The agent gets what a program needs to run, not this app's own credentials: no SSH agent
        // socket, no cloud keys, no tokens it was never given.
        env: childEnv(process.env),
        stdio: ["pipe", "pipe", "pipe"],
        // npx and friends are .cmd files on Windows.
        shell: process.platform === "win32",
      });
    } catch (error) {
      throw new Error(`Could not start "${this.runner.command}": ${safeError(error)}`, { cause: error });
    }
    const child = this.child;
    const gone = new Promise<never>((_, reject) => {
      child.once("error", (error) =>
        reject(new Error(`Could not start "${this.runner.command}": ${safeError(error)}`)),
      );
      child.once("exit", (code) => {
        this.exited = true;
        const error = new Error(
          this.stopped
            ? "Stopped"
            : `"${this.runner.name}" ended unexpectedly (exit ${code ?? "?"}). ${boundedContext(this.stderr.trim(), 600)}`,
        );
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
        reject(error);
      });
    });
    gone.catch(() => undefined);
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000);
    });

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) {
        buffer = "";
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue; // Not protocol: an agent that prints to stdout by mistake.
        }
        void this.receive(message, onEvent, (delta) => (text += delta));
      }
    });

    const init = (await Promise.race([
      this.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: "sshs3", version: this.options.clientVersion ?? "0" },
        // The agent uses its own file access and its own shell; sshS3 offers neither.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      gone,
    ])) as { protocolVersion?: number };
    if (init?.protocolVersion !== undefined && init.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new Error(
        `"${this.runner.name}" speaks protocol version ${init.protocolVersion}; sshS3 speaks ${ACP_PROTOCOL_VERSION}.`,
      );

    let session: { sessionId?: string };
    try {
      session = (await Promise.race([
        this.request("session/new", { cwd, mcpServers: [] }),
        gone,
      ])) as { sessionId?: string };
    } catch (error) {
      const reason = safeError(error);
      throw new Error(
        /auth/i.test(reason)
          ? `"${this.runner.name}" is not signed in on this computer. Start it once in a terminal and sign in, then try again. (${reason})`
          : reason,
        { cause: error },
      );
    }
    if (!session?.sessionId) throw new Error(`"${this.runner.name}" opened no session.`);
    this.sessionId = session.sessionId;

    const last = task.messages.filter((m) => m.role === "user").at(-1);
    const earlier = task.messages
      .filter((m) => m.id !== last?.id && m.role !== "system" && m.text.trim())
      .slice(-6)
      .map((m) => `${m.role === "user" ? "User" : "You"}: ${boundedContext(m.text, 1500)}`);
    const prompt = [
      this.options.preface,
      earlier.length ? `Earlier in this conversation:\n${earlier.join("\n")}` : "",
      boundedContext(last?.text ?? "", 24_000),
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = (await Promise.race([
      this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: prompt }],
      }),
      gone,
    ])) as { stopReason?: string };

    const reason = result?.stopReason ?? "end_turn";
    if (reason === "cancelled") onEvent({ type: "run.cancelled", output: text || undefined });
    else if (reason === "refusal")
      onEvent({ type: "run.failed", output: text || undefined, error: "The agent refused the request." });
    else
      onEvent({
        type: "run.completed",
        output:
          (text || "The agent ended without a report.") +
          (reason === "max_tokens" || reason === "max_turn_requests"
            ? `\n\n(The agent stopped at its own limit: ${reason}. The work may be unfinished.)`
            : ""),
      });
  }

  private async receive(
    message: Record<string, unknown>,
    onEvent: (event: RunEvent) => void,
    addText: (delta: string) => void,
  ): Promise<void> {
    const id = message.id as number | string | undefined;
    const method = message.method as string | undefined;
    if (!method) {
      const waiting = typeof id === "number" ? this.pending.get(id) : undefined;
      if (!waiting) return;
      this.pending.delete(id as number);
      const error = message.error as { message?: string; data?: unknown } | undefined;
      if (error)
        waiting.reject(
          new Error(
            `${error.message ?? "The agent reported an error"}${error.data ? `: ${boundedContext(JSON.stringify(error.data), 400)}` : ""}`,
          ),
        );
      else waiting.resolve(message.result);
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (method === "session/update") {
      const update = (params.update ?? {}) as Record<string, unknown>;
      const kind = update.sessionUpdate;
      if (kind === "agent_message_chunk") {
        const delta = textOf(update.content);
        if (delta) {
          addText(delta);
          onEvent({ type: "message.delta", delta });
        }
      } else if (kind === "plan" && Array.isArray(update.entries)) {
        const todos: AgentTodo[] = (update.entries as Array<Record<string, unknown>>)
          .filter((e) => typeof e.content === "string")
          .slice(0, 40)
          .map((e, i) => ({
            id: `p${i + 1}`,
            content: boundedContext(e.content as string, 300),
            status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending",
          })) as AgentTodo[];
        onEvent({ type: "todos.updated", todos });
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        const callId = String(update.toolCallId ?? "");
        const known = this.tools.get(callId);
        const title = typeof update.title === "string" ? update.title : (known?.title ?? "tool");
        const hasRaw = update.rawInput !== undefined && update.rawInput !== null;
        const input = hasRaw ? boundedContext(JSON.stringify(update.rawInput), 2000) : (known?.input ?? "");
        this.tools.set(callId, {
          title,
          input,
          raw: hasRaw ? update.rawInput : known?.raw,
          kind: typeof update.kind === "string" ? update.kind : known?.kind,
        });
        if (update.status === "completed" || update.status === "failed") {
          this.tools.delete(callId);
          this.options.settled?.(callId, {
            failed: update.status === "failed",
            output: boundedContext(toolOutput(update.content, update.rawOutput), 4000),
          });
          onEvent({
            type: "tool.result",
            tool: {
              name: title,
              input,
              output: boundedContext(
                (update.status === "failed" ? "(failed) " : "") + toolOutput(update.content, update.rawOutput),
                4000,
              ),
            },
          });
        }
      }
      return;
    }
    if (id === undefined) return; // A notification we do not know: nothing to answer.
    if (method === "session/request_permission") {
      const call = (params.toolCall ?? {}) as Record<string, unknown>;
      const options = (Array.isArray(params.options) ? params.options : []) as Array<{
        optionId?: string;
        kind?: string;
      }>;
      const callId = String(call.toolCallId ?? "");
      const known = this.tools.get(callId);
      // A permission request may carry only the call's id: what it would do was said when the call was announced.
      const raw = call.rawInput ?? known?.raw;
      let allowed = false;
      try {
        allowed =
          !this.stopped &&
          (await this.options.ask({
            title: typeof call.title === "string" ? call.title : (known?.title ?? "An action"),
            kind: typeof call.kind === "string" ? call.kind : known?.kind,
            command: commandOf(raw),
            rawInput: raw !== undefined && raw !== null ? JSON.stringify(raw).slice(0, 8000) : undefined,
            toolCallId: callId || undefined,
          }));
      } catch {
        allowed = false;
      }
      // Never "always": each action is asked about on its own.
      const pick = options.find((o) => o.kind === (allowed ? "allow_once" : "reject_once"));
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          outcome: pick?.optionId ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" },
        },
      });
      return;
    }
    // File access, terminals and anything else: not offered.
    this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `sshS3 does not provide ${method}` } });
  }

  private send(message: Record<string, unknown>): void {
    if (this.exited || !this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async steer(): Promise<void> {
    throw new Error("An external agent cannot be given a message mid-run. Stop it, then reply.");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.sessionId) this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    const child = this.child;
    if (!child || this.exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
      setTimeout(() => !this.exited && child.kill(), 800);
    });
  }
}

/**
 * Names of variables an external agent is not handed: this app's way into the
 * team's servers (the SSH agent that holds the keys sshs3 logs in with) and
 * sshs3's own settings. Its model key and the tools it needs for the code it
 * works on stay: it runs as the person, in their checkout.
 */
const WITHHELD = /^(SSH_AUTH_SOCK|SSH_AGENT_PID|SSHS3_)/i;

/** The environment an external agent runs with: everything but sshs3's own way into the servers. */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!WITHHELD.test(k)) out[k] = v;
  return out;
}
