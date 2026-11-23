import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, accessSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AiReasoningEffort } from "../../../shared/types/ai";
import type { AgentTask, AgentTodo, ExternalRunner, ExternalRunnerPreset } from "../../../shared/types/aiHub";
import type { HermesModelConfig } from "../HermesManager";
import type { AgentRuntime, RunEvent } from "./AgentRuntime";
import type { FinalRunEvent } from "./RunOutcome";
import type { LocalMcpServer } from "./LocalMcpServer";
import { boundedContext, boundedPrompt, safeError } from "./privacy";

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

/**
 * What an agent says it used, as the hub counts it. The protocol leaves this to the agent: some
 * report it with the answer to the prompt (`usage`, also under `_meta`), in either spelling.
 */
export function acpUsage(reported: unknown): Record<string, number> | undefined {
  if (!reported || typeof reported !== "object") return undefined;
  const u = reported as Record<string, unknown>;
  const read = (...names: string[]): number | undefined => {
    for (const name of names) if (typeof u[name] === "number" && Number.isFinite(u[name]) && (u[name] as number) >= 0) return Math.round(u[name] as number);
    return undefined;
  };
  const input = read("inputTokens", "input_tokens");
  const output = read("outputTokens", "output_tokens");
  if (input === undefined && output === undefined) return undefined;
  const cacheRead = read("cachedReadTokens", "cacheReadTokens", "cache_read_input_tokens");
  const cacheWrite = read("cachedWriteTokens", "cacheCreationTokens", "cache_creation_input_tokens");
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    ...(cacheRead !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
  };
}

function acpOutcome(reason: string | undefined, text: string): FinalRunEvent {
  const output = text || undefined;
  switch (reason) {
    case "end_turn":
      return { type: "run.completed", output: output ?? "The agent ended without a report." };
    case "cancelled":
      return { type: "run.cancelled", output };
    case "refusal":
      return { type: "run.failed", output, error: "The agent refused the request." };
    case "max_tokens":
    case "max_turn_requests":
      return { type: "run.interrupted", output, error: `The agent reached its limit (${reason}) before completing the work.` };
    default:
      return { type: "run.interrupted", output, error: "The agent ended without confirming completion." };
  }
}

export const ACP_PROTOCOL_VERSION = 1;
/** How long a started agent is given to answer the greeting (the first start of an npx package can be slow). */
const GREETING_TIMEOUT_MS = 2 * 60_000;

/** The characters cmd.exe gives a meaning of its own. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * How a runner's program is started. Directly, with its words as they are, wherever that works;
 * on Windows a .cmd or .bat file (npx, for one) can only be run through cmd.exe, and there every
 * word is quoted and each of cmd's own characters escaped, so a path with a space is one word and
 * an argument such as `x & calc` is text, not a second command. The way cross-spawn does it.
 */
export function runnerSpawn(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = (file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32") return { file: command, args, verbatim: false };
  const resolved = resolveOnWindows(command, env, exists) ?? command;
  if (!/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args, verbatim: false };
  const quote = (word: string): string =>
    `"${word.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
  const line = [path.win32.normalize(resolved).replace(CMD_META, "^$1"), ...args.map(quote)].join(" ");
  return { file: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** Where Windows finds a program named without its extension or folder: PATH, tried with each of PATHEXT. */
function resolveOnWindows(command: string, env: NodeJS.ProcessEnv, exists: (file: string) => boolean): string | undefined {
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const withExts = (base: string): string[] => (path.win32.extname(base) ? [base] : exts.map((e) => base + e));
  if (/[\\/:]/.test(command)) return withExts(command).find(exists);
  const dirs = (env.Path || env.PATH || "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const hit = withExts(path.win32.join(dir, command)).find(exists);
    if (hit) return hit;
  }
  return undefined;
}

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
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    note: "Needs OpenCode installed and configured on this computer.",
  },
];
const MAX_LINE_BYTES = 8_000_000;

export interface OsSandboxOptions {
  /** Opt-in OS sandbox wrapping. Defaults to false (pass-through). */
  enabled?: boolean;
  /** Working directory allowed for read/write inside the sandbox. */
  cwd?: string;
  /** Additional readable paths inside the sandbox. */
  readPaths?: string[];
  /** Additional writable paths inside the sandbox. */
  writePaths?: string[];
  /** Allowed outbound hostnames/domains (loopback-only or empty restricts network when supported). */
  allowedDomains?: string[];
  /** Whether outbound network is permitted when supported by the sandbox backend. */
  allowNetwork?: boolean;
  /** Throw instead of falling back to unsandboxed execution when no backend is available. */
  failIfUnavailable?: boolean;
  /** Injectable platform override for testing (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Injectable binary availability check for testing. */
  hasBinary?: (binary: string) => boolean;
  /** Injectable environment for PATH lookups. */
  env?: NodeJS.ProcessEnv;
}

export interface WrappedSpawn {
  command: string;
  args: string[];
  sandboxed: boolean;
  backend: "sandbox-exec" | "bwrap" | "none";
  reason?: string;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackOnlyList(domains: string[] | undefined): boolean {
  if (!domains || domains.length === 0) return false;
  return domains.every((d) => LOOPBACK_HOSTS.has(d.trim().toLowerCase()));
}

function defaultHasBinary(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const checkFile = (candidate: string): boolean => {
    try {
      if (!statSync(candidate).isFile()) return false;
      if (process.platform !== "win32") accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  // On Windows a program is found by its name with one of the extensions that run there (npx is npx.cmd).
  const names =
    process.platform === "win32"
      ? [binary, ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => binary + ext.toLowerCase())]
      : [binary];
  if (/[\\/]/.test(binary)) return names.some(checkFile);
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (names.some((name) => checkFile(path.join(dir, name)))) return true;
  }
  return false;
}

/** What `probeRunner` found. `detail` is for the person: one or two sentences. */
export interface RunnerProbe {
  ok: boolean;
  detail: string;
}

/**
 * Whether an external agent's program is there and answers as one. It is started, greeted and
 * stopped again: nothing is asked of it, no session is opened, and nothing in its folder is touched.
 */
export function probeRunner(
  runner: Pick<ExternalRunner, "name" | "command" | "args" | "cwd" | "env">,
  options: {
    timeoutMs?: number;
    clientVersion?: string;
    env?: NodeJS.ProcessEnv;
    /** Where the program runs, as the person is told: "on this computer", or the server in the web app. */
    where?: string;
  } = {},
): Promise<RunnerProbe> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const where = options.where ?? "on this computer";
  if (!defaultHasBinary(runner.command, env))
    return Promise.resolve({ ok: false, detail: `The program "${runner.command}" was not found ${where}. Install it there, or give its full path.` });
  const cwd = runner.cwd?.trim();
  if (cwd) {
    try {
      if (!statSync(cwd).isDirectory()) throw new Error("not a folder");
    } catch {
      return Promise.resolve({ ok: false, detail: `The working folder "${cwd}" does not exist ${where}.` });
    }
  }
  return new Promise<RunnerProbe>((resolve) => {
    let done = false;
    let stderr = "";
    let buffer = "";
    let child: ChildProcessWithoutNullStreams | undefined;
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          detail: `"${runner.command}" started but did not answer within ${seconds} second${seconds === 1 ? "" : "s"}. It may not speak the Agent Client Protocol, or it is still installing itself: try again in a moment.`,
        }),
      timeoutMs,
    );
    const finish = (result: RunnerProbe): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child) killRunner(child);
      } catch {
        // Already gone.
      }
      resolve(result);
    };
    try {
      const plan = runnerSpawn(runner.command, runner.args ?? [], process.platform, env);
      child = spawn(plan.file, plan.args, {
        cwd: cwd || os.tmpdir(),
        env: childEnv(env, runner.env),
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: plan.verbatim,
        windowsHide: true,
      });
    } catch (error) {
      return finish({ ok: false, detail: `Could not start "${runner.command}": ${safeError(error)}` });
    }
    child.once("error", (error) => finish({ ok: false, detail: `Could not start "${runner.command}": ${safeError(error)}` }));
    child.once("exit", (code) =>
      finish({
        ok: false,
        detail: `"${runner.command}" started and ended at once (exit ${code ?? "?"}), without answering.${stderr.trim() ? ` It said: ${boundedContext(stderr.trim(), 300)}` : ""}`,
      }),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_LINE_BYTES) buffer = "";
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: { protocolVersion?: number; agentInfo?: { name?: string; version?: string } }; error?: { message?: string } };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue; // Not protocol: a program that prints to stdout before it answers.
        }
        if (message.id !== 1) continue;
        if (message.error) return finish({ ok: false, detail: `"${runner.command}" answered with an error: ${boundedContext(String(message.error.message ?? "unknown"), 300)}` });
        const version = message.result?.protocolVersion;
        if (version !== undefined && version !== ACP_PROTOCOL_VERSION)
          return finish({ ok: false, detail: `"${runner.name}" speaks protocol version ${version}; sshS3 speaks ${ACP_PROTOCOL_VERSION}.` });
        const who = [message.result?.agentInfo?.name, message.result?.agentInfo?.version].filter(Boolean).join(" ");
        return finish({
          ok: true,
          detail: `It started and answered as an agent${who ? ` (${boundedContext(who, 80)})` : ""}.${cwd ? "" : ` No working folder is set for it ${where}: it needs one before it can be given work.`}`,
        });
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientInfo: { name: "sshs3", version: options.clientVersion ?? "0" },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
      })}\n`,
    );
  });
}

/**
 * Wraps a child-process command and arguments with an OS-level sandbox
 * (`sandbox-exec` on macOS, `bwrap` on Linux) when opted in. Falls back cleanly
 * on Windows or when the sandbox binary is absent unless `failIfUnavailable` is set.
 */
export function wrapWithOsSandbox(
  command: string,
  args: string[],
  options: OsSandboxOptions = {},
): WrappedSpawn {
  if (!options.enabled) {
    return { command, args, sandboxed: false, backend: "none" };
  }
  const platform = options.platform ?? process.platform;
  const hasBinary = options.hasBinary ?? ((bin: string) => defaultHasBinary(bin, options.env));
  const uniquePaths = (items: Array<string | undefined>): string[] => [
    ...new Set(items.map((p) => p?.trim()).filter((p): p is string => Boolean(p))),
  ];
  const writePaths = uniquePaths([options.cwd, ...(options.writePaths ?? [])]);
  const readPaths = uniquePaths(options.readPaths ?? []);

  if (platform === "darwin") {
    const sandboxBin = hasBinary("sandbox-exec")
      ? "sandbox-exec"
      : hasBinary("/usr/bin/sandbox-exec")
        ? "/usr/bin/sandbox-exec"
        : undefined;
    if (!sandboxBin) {
      if (options.failIfUnavailable) {
        throw new Error("OS sandbox unavailable: sandbox-exec was not found.");
      }
      return { command, args, sandboxed: false, backend: "none", reason: "sandbox-exec unavailable" };
    }
    const lines = [
      "(version 1)",
      "(allow default)",
      '(deny file-write* (subpath "/"))',
      '(allow file-write* (subpath "/dev"))',
      '(allow file-write* (subpath "/tmp"))',
      '(allow file-write* (subpath "/private/tmp"))',
      ...writePaths.map((p) => `(allow file-write* (subpath ${JSON.stringify(p)}))`),
    ];
    if (options.allowNetwork === false || (options.allowedDomains !== undefined && options.allowedDomains.length === 0)) {
      lines.push("(deny network-outbound)");
    } else if (isLoopbackOnlyList(options.allowedDomains)) {
      lines.push("(deny network-outbound)");
      lines.push('(allow network-outbound (remote ip "localhost:*"))');
      lines.push('(allow network-outbound (remote ip "127.0.0.1:*"))');
    }
    return {
      command: sandboxBin,
      args: ["-p", lines.join("\n"), command, ...args],
      sandboxed: true,
      backend: "sandbox-exec",
    };
  }

  if (platform === "linux") {
    const bwrapBin = hasBinary("bwrap")
      ? "bwrap"
      : hasBinary("/usr/bin/bwrap")
        ? "/usr/bin/bwrap"
        : undefined;
    if (!bwrapBin) {
      if (options.failIfUnavailable) {
        throw new Error("OS sandbox unavailable: bwrap was not found.");
      }
      return { command, args, sandboxed: false, backend: "none", reason: "bwrap unavailable" };
    }
    const bwrapArgs: string[] = [
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
    ];
    for (const r of readPaths) {
      bwrapArgs.push("--ro-bind", r, r);
    }
    for (const w of writePaths) {
      bwrapArgs.push("--bind", w, w);
    }
    // Only unshare network when network is explicitly disabled; loopback-only
    // bridges (such as LocalMcpServer) rely on the host loopback interface.
    if (options.allowNetwork === false || (options.allowedDomains !== undefined && options.allowedDomains.length === 0)) {
      bwrapArgs.push("--unshare-net");
    }
    bwrapArgs.push("--", command, ...args);
    return {
      command: bwrapBin,
      args: bwrapArgs,
      sandboxed: true,
      backend: "bwrap",
    };
  }

  if (options.failIfUnavailable) {
    throw new Error(`OS sandbox unavailable on platform "${platform}".`);
  }
  return {
    command,
    args,
    sandboxed: false,
    backend: "none",
    reason: `OS sandbox unsupported on ${platform}`,
  };
}

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

export type AcpModelConfig = (
  | HermesModelConfig
  | { model?: string; kind?: string; baseUrl?: string; apiKey?: string }
) & {
  reasoningEffort?: AiReasoningEffort;
};

export interface AcpMcpHttpServer {
  type: "http" | "sse";
  name: string;
  url: string;
  headers: Array<{ name: string; value: string }>;
}

export interface AcpMcpStdioServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export type AcpMcpServer = AcpMcpHttpServer | AcpMcpStdioServer;

export interface AcpLocalMcpBridge {
  /** Running LocalMcpServer instance or explicit loopback URL. */
  server?: Pick<LocalMcpServer, "address">;
  url?: string;
  /** Scoped least-privilege token sent via Authorization header (never via child env). */
  token?: string;
  /** Server name exposed to the ACP agent (defaults to "sshs3"). */
  name?: string;
  transport?: "http" | "sse";
  /** Optional least-privilege scope metadata (e.g. ["read"]). */
  scopes?: string[];
  /** Optional least-privilege tool allowlist metadata. */
  tools?: string[];
}

export interface AcpSessionStore {
  get(taskId: string): string | undefined;
  set(taskId: string, sessionId: string): void;
  delete?(taskId: string): void;
}

export interface AcpRuntimeOptions {
  /** Put before the user's message: who the agent is here and what it is working towards. */
  preface: string;
  ask: PermissionAsk;
  clientVersion?: string;
  /** How a tool call the person was asked about ended, as the agent reported it. */
  settled?: (toolCallId: string, outcome: { failed: boolean; output: string }) => void;
  /** Optional model override when `start()` is invoked without an explicit model config. */
  model?: string;
  /** Optional reasoning effort level passed to session init/config. */
  reasoningEffort?: AiReasoningEffort;
  /** Persisted ACP session ID to resume via `session/load` before falling back to `session/new`. */
  sessionId?: string;
  /** Callback invoked when an ACP session ID is resumed or created. */
  onSessionId?: (sessionId: string, taskId: string) => void | Promise<void>;
  /** Optional external session store keyed by `task.id`. */
  sessionStore?: AcpSessionStore;
  /** Scoped least-privilege LocalMcpServer bridge exposed in `session/new` / `session/load` `mcpServers`. */
  localMcp?: AcpLocalMcpBridge;
  /** Additional ACP `mcpServers` entries to include alongside `localMcp`. */
  mcpServers?: AcpMcpServer[];
  /** Opt-in OS sandbox wrapper configuration for spawning the external runner. */
  sandbox?: OsSandboxOptions;
}

interface AcpSessionResponse {
  sessionId?: string;
  models?: {
    currentModelId?: string;
    availableModels?: Array<{ modelId?: string; name?: string }>;
  };
  configOptions?: Array<{
    id?: string;
    category?: string;
    currentValue?: unknown;
  }>;
}

interface AcpInitResponse {
  protocolVersion?: number;
  agentCapabilities?: {
    loadSession?: boolean;
    models?: boolean;
    configOptions?: boolean;
    sessionCapabilities?: {
      setModel?: boolean;
      setConfigOption?: boolean;
    };
  };
}

/**
 * Builds the `mcpServers` list for ACP `session/new` and `session/load`, bridging a
 * scoped least-privilege `LocalMcpServer` over loopback HTTP without touching child env.
 */
export function buildAcpMcpServers(options: {
  localMcp?: AcpLocalMcpBridge;
  mcpServers?: AcpMcpServer[];
}): AcpMcpServer[] {
  const servers: AcpMcpServer[] = [...(options.mcpServers ?? [])];
  const bridge = options.localMcp;
  if (!bridge) return servers;
  const rawUrl = bridge.url?.trim() || bridge.server?.address()?.trim();
  if (!rawUrl) return servers;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("LocalMcpServer bridge URL is invalid.");
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`LocalMcpServer bridge must use a loopback host (got "${parsed.hostname}").`);
  }
  servers.push({
    type: bridge.transport ?? "http",
    name: bridge.name?.trim() || "sshs3",
    url: parsed.toString(),
    headers: bridge.token ? [{ name: "Authorization", value: `Bearer ${bridge.token}` }] : [],
  });
  return servers;
}

const persistedSessions = new Map<string, string>();

export class AcpRuntime implements AgentRuntime {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessionId?: string;
  private stopped = false;
  private exited = false;
  /**
   * True while the agent loads an earlier session. The protocol has it send the whole earlier
   * conversation again as updates before it answers the load: that is history the conversation
   * already holds, not this run's answer, and none of it is shown or counted again.
   */
  private replaying = false;
  private stderr = "";
  /** Each tool call the agent announced: its title, input (parsed and as text) and kind, by its id. */
  private tools = new Map<string, { title: string; input: string; raw?: unknown; kind?: string }>();

  /** Clears the in-process ACP `task.id -> sessionId` cache (primarily for tests). */
  static clearSessionCache(): void {
    persistedSessions.clear();
  }

  constructor(
    private readonly runner: ExternalRunner,
    private readonly options: AcpRuntimeOptions,
  ) {}

  private sessionCacheKey(taskId: string): string {
    return `${this.runner.id}\0${taskId}`;
  }

  private resolvePersistedSessionId(task: AgentTask): string | undefined {
    const taskField = (task as AgentTask & { acpSessionId?: string }).acpSessionId;
    return (
      this.options.sessionId?.trim() ||
      taskField?.trim() ||
      this.options.sessionStore?.get(task.id)?.trim() ||
      persistedSessions.get(this.sessionCacheKey(task.id))
    );
  }

  private async persistSessionId(task: AgentTask, sessionId: string): Promise<void> {
    persistedSessions.set(this.sessionCacheKey(task.id), sessionId);
    this.options.sessionStore?.set(task.id, sessionId);
    await this.options.onSessionId?.(sessionId, task.id);
  }

  private async applySessionModelAndConfig(
    sessionId: string,
    session: AcpSessionResponse,
    init: AcpInitResponse,
    selectedModel: string | undefined,
    selectedReasoningEffort: AiReasoningEffort | undefined,
    gone: Promise<never>,
  ): Promise<void> {
    const caps = init.agentCapabilities;
    const supportsSetModel = Boolean(session.models || caps?.models || caps?.sessionCapabilities?.setModel);
    const supportsSetConfig = Boolean(
      Array.isArray(session.configOptions) || caps?.configOptions || caps?.sessionCapabilities?.setConfigOption,
    );

    if (selectedModel && supportsSetModel && session.models?.currentModelId !== selectedModel) {
      await Promise.race([
        this.request("session/set_model", { sessionId, modelId: selectedModel }),
        gone,
      ]).catch((error: unknown) => {
        if (this.exited || this.stopped) throw error;
      });
    }

    if (selectedReasoningEffort && supportsSetConfig) {
      const opt = session.configOptions?.find(
        (c) =>
          c.category === "thought_level" ||
          c.id === "reasoning_effort" ||
          c.id === "reasoningEffort" ||
          c.id === "thought_level",
      );
      if (opt?.id ? opt.currentValue !== selectedReasoningEffort : Boolean(caps?.configOptions || caps?.sessionCapabilities?.setConfigOption)) {
        await Promise.race([
          this.request("session/set_config_option", {
            sessionId,
            configId: opt?.id ?? "reasoning_effort",
            value: selectedReasoningEffort,
          }),
          gone,
        ]).catch((error: unknown) => {
          if (this.exited || this.stopped) throw error;
        });
      }
    }

    if (selectedModel && !supportsSetModel && Array.isArray(session.configOptions)) {
      const modelOpt = session.configOptions.find((c) => c.category === "model" || c.id === "model");
      if (modelOpt?.id && modelOpt.currentValue !== selectedModel) {
        await Promise.race([
          this.request("session/set_config_option", {
            sessionId,
            configId: modelOpt.id,
            value: selectedModel,
          }),
          gone,
        ]).catch((error: unknown) => {
          if (this.exited || this.stopped) throw error;
        });
      }
    }
  }

  async start(
    task: AgentTask,
    model: AcpModelConfig | undefined,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    const cwd = this.runner.cwd?.trim();
    if (!cwd) throw new Error(`"${this.runner.name}" has no working folder set on this computer.`);
    const selectedModel = model?.model?.trim() || this.options.model?.trim() || undefined;
    const selectedReasoningEffort =
      (model && "reasoningEffort" in model ? model.reasoningEffort : undefined) ??
      this.options.reasoningEffort;
    const mcpServers = buildAcpMcpServers({
      localMcp: this.options.localMcp,
      mcpServers: this.options.mcpServers,
    });

    let text = "";
    try {
      const sandboxed = this.options.sandbox?.enabled
        ? wrapWithOsSandbox(this.runner.command, this.runner.args ?? [], { cwd, ...this.options.sandbox })
        : { command: this.runner.command, args: this.runner.args ?? [] };
      const plan = runnerSpawn(sandboxed.command, sandboxed.args);
      this.child = spawn(plan.file, plan.args, {
        cwd,
        // The agent gets what a program needs to run and what its runner's settings name: no SSH
        // agent socket, no cloud keys, no tokens it was never given (see childEnv).
        env: childEnv(process.env, this.runner.env),
        stdio: ["pipe", "pipe", "pipe"],
        // npx and friends are .cmd files on Windows: cmd.exe runs them, with the line quoted for it.
        windowsVerbatimArguments: plan.verbatim,
        windowsHide: true,
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

    const sessionMeta =
      selectedModel || selectedReasoningEffort
        ? {
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
          }
        : undefined;

    // A program that never answers the greeting is not waited for for ever.
    let greetTimer: NodeJS.Timeout | undefined;
    const unanswered = new Promise<never>((_, reject) => {
      greetTimer = setTimeout(
        () => reject(new Error(`"${this.runner.name}" started but did not answer within ${Math.round(GREETING_TIMEOUT_MS / 60_000)} minutes. It may not speak the Agent Client Protocol.`)),
        GREETING_TIMEOUT_MS,
      );
    });
    unanswered.catch(() => undefined);
    const init = (await Promise.race([
      unanswered,
      this.request("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: "sshs3", version: this.options.clientVersion ?? "0" },
        // The agent uses its own file access and its own shell; sshS3 offers neither.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        ...(sessionMeta ? { _meta: sessionMeta } : {}),
      }),
      gone,
    ]).finally(() => clearTimeout(greetTimer))) as AcpInitResponse;
    if (init?.protocolVersion !== undefined && init.protocolVersion !== ACP_PROTOCOL_VERSION)
      throw new Error(
        `"${this.runner.name}" speaks protocol version ${init.protocolVersion}; sshS3 speaks ${ACP_PROTOCOL_VERSION}.`,
      );

    let session: AcpSessionResponse | undefined;
    let resumed = false;
    const candidateSessionId = this.resolvePersistedSessionId(task);
    const shouldAttemptLoad =
      Boolean(candidateSessionId) &&
      (init?.agentCapabilities?.loadSession === true ||
        (init?.agentCapabilities?.loadSession !== false &&
          Boolean(this.options.sessionId || this.options.sessionStore)));

    if (shouldAttemptLoad && candidateSessionId) {
      this.replaying = true;
      try {
        const loaded = (await Promise.race([
          this.request("session/load", {
            sessionId: candidateSessionId,
            cwd,
            mcpServers,
            ...(sessionMeta ? { _meta: sessionMeta } : {}),
          }),
          gone,
        ])) as AcpSessionResponse | undefined;
        session = { ...loaded, sessionId: loaded?.sessionId ?? candidateSessionId };
        resumed = true;
      } catch (error) {
        if (this.exited || this.stopped) throw error;
        // Session could not be loaded (expired/unknown/unsupported); fall back to session/new.
      } finally {
        this.replaying = false;
      }
    }

    if (!session) {
      try {
        session = (await Promise.race([
          this.request("session/new", {
            cwd,
            mcpServers,
            ...(sessionMeta ? { _meta: sessionMeta } : {}),
          }),
          gone,
        ])) as AcpSessionResponse;
      } catch (error) {
        const reason = safeError(error);
        throw new Error(
          /auth/i.test(reason)
            ? `"${this.runner.name}" is not signed in on this computer. Start it once in a terminal and sign in, then try again. (${reason})`
            : reason,
          { cause: error },
        );
      }
    }
    if (!session?.sessionId) throw new Error(`"${this.runner.name}" opened no session.`);
    this.sessionId = session.sessionId;
    await this.persistSessionId(task, this.sessionId);

    if (selectedModel || selectedReasoningEffort) {
      await this.applySessionModelAndConfig(
        this.sessionId,
        session,
        init ?? {},
        selectedModel,
        selectedReasoningEffort,
        gone,
      );
    }

    const last = task.messages.filter((m) => m.role === "user").at(-1);
    const earlier = resumed
      ? []
      : task.messages
          .filter((m) => m.id !== last?.id && m.role !== "system" && m.text.trim())
          .slice(-6)
          .map((m) => `${m.role === "user" ? "User" : "You"}: ${boundedContext(m.text, 1500)}`);
    const prompt = [
      this.options.preface,
      earlier.length ? `Earlier in this conversation:\n${earlier.join("\n")}` : "",
      boundedPrompt(last?.text ?? "", 24_000),
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = (await Promise.race([
      this.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: prompt }],
      }),
      gone,
    ])) as { stopReason?: string; usage?: unknown; _meta?: { usage?: unknown } };

    // What the agent says it used is saved with the conversation and counted like any run's.
    const usage = acpUsage(result?.usage) ?? acpUsage(result?._meta?.usage);
    onEvent({ ...acpOutcome(result?.stopReason, text), ...(usage ? { usage } : {}) });
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
      if (this.replaying) return;
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
        killRunner(child, "SIGKILL");
        resolve();
      }, 2500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
      setTimeout(() => !this.exited && killRunner(child), 800);
    });
  }
}

/**
 * Ends an agent's program. On Windows a `.cmd` runner (npx) runs under cmd.exe, and ending cmd.exe
 * leaves the program it started running: there the whole tree under it is ended with taskkill.
 */
export function killRunner(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  signal?: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawn = spawn,
): void {
  if (platform === "win32" && child.pid) {
    try {
      run("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => child.kill(signal));
      return;
    } catch {
      // taskkill could not be started: end what can be ended.
    }
  }
  child.kill(signal);
}

/** Never handed over, even when a runner names them: this app's way into the team's servers, and its own settings. */
const WITHHELD = /^(SSH_AUTH_SOCK|SSH_AGENT_PID|SSHS3_)/i;

/**
 * What every external agent's program is given of this app's environment: what a program needs
 * to start and find its own files, its language and terminal, and the way out to the network.
 * Nothing else: cloud keys and tokens that happen to be set where the app was started stay here.
 */
const PASSED = new RegExp(
  "^(" +
    [
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "LC_[A-Z_]+", "TERM", "COLORTERM", "TZ",
      "TMPDIR", "TMP", "TEMP", "XDG_[A-Z_]+",
      // The way out: a proxy, and the certificates it is trusted by.
      "HTTPS?_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
      // Windows: without these no program starts or finds its own folders.
      "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
      "PROGRAMFILES", "PROGRAMFILES\\(X86\\)", "PROGRAMDATA", "PROGRAMW6432", "COMMONPROGRAMFILES", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
    ].join("|") +
    ")$",
  "i",
);

/**
 * The environment an external agent runs with: the variables in PASSED, and those the runner's own
 * settings name (`extra`). The SSH agent and sshs3's own variables are never among them.
 */
export function childEnv(env: NodeJS.ProcessEnv, extra: readonly string[] = []): NodeJS.ProcessEnv {
  const named = new Set(extra.map((name) => name.toUpperCase()));
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env))
    if (!WITHHELD.test(k) && (PASSED.test(k) || named.has(k.toUpperCase()))) out[k] = v;
  return out;
}

/** A name a runner may list in `env`: an ordinary variable name, and not one that is withheld. */
export function runnerEnvNames(names: unknown): string[] {
  const list = Array.isArray(names) ? names : [];
  return [...new Set(list.flatMap((name) => (typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name.trim()) && !WITHHELD.test(name.trim()) ? [name.trim()] : [])))].slice(0, 20);
}

/** The words that say, wherever a runner is set up, what its program is given of the environment. */
export const RUNNER_ENV_NOTE =
  "The program is given the basics of this app's environment only: the path, the home folder, language, terminal, temporary folder and proxy settings. A variable it needs beyond these (its API key, say) is passed when it is listed in `env`. The SSH agent and sshs3's own variables are never passed.";
