import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { createLogger } from "../log";
import { wrapWithOsSandbox, type OsSandboxOptions } from "./hub/AcpRuntime";
import { boundedContext } from "./hub/privacy";
const hermesLog = createLogger("hermes");

/**
 * Runs the pinned Hermes distribution as a private, task-local Python sidecar.
 * Local API and broker capabilities are random per run. Only the sshs3 toolset
 * is enabled; terminal and file authority remains in ToolBroker.
 * Model credentials are passed in a minimal environment. Hermes homes are
 * removed after runs; durable, redacted history belongs to HubStore.
 * This process configuration is not an operating-system sandbox.
 */

export interface HermesManifest {
  tag: string;
  commit: string;
  /** Interpreter path relative to the runtime directory. */
  python: string;
}

/** Which model Hermes itself uses: Anthropic (optionally through the user's own endpoint), or any OpenAI-compatible server. */
export type HermesModelConfig = (
  | { kind: "anthropic"; model: string; apiKey: string; baseUrl?: string }
  | { kind: "custom"; model: string; baseUrl: string; apiKey?: string }
  | { kind: "openai-codex"; model: string; baseUrl?: string }
) & {
  apiProtocol?: import("../../shared/types/ai").AiApiProtocol;
  profileId?: string;
  egressPolicy?: import("../../shared/types/ai").AiEgressPolicy;
  zdrConfirmed?: boolean;
  fallbackProfileIds?: string[];
};

export interface HermesEndpoint {
  baseUrl: string;
  apiKey: string;
}

type SpawnFn = typeof nodeSpawn;
type FetchFn = typeof fetch;

export interface HermesSandboxOptions {
  /** Opt-in OS sandbox wrapping for the local Hermes sidecar process. */
  enabled?: boolean;
  /**
   * Hardened mode: refuse to start unsandboxed when no OS sandbox backend
   * (`sandbox-exec` / `bwrap`) is available. When false (default), desktop
   * dev environments gracefully fall back to unsandboxed execution.
   */
  hardened?: boolean;
  /** Outbound domain allowlist enforced/propagated to the sidecar spawn. */
  allowedDomains?: string[];
  /** Additional readable paths inside the OS sandbox. */
  readPaths?: string[];
  /** Additional writable paths inside the OS sandbox. */
  writePaths?: string[];
  /** Injectable platform override for unit tests. */
  platform?: NodeJS.Platform;
  /** Injectable binary availability check for unit tests. */
  hasBinary?: (binary: string) => boolean;
}

export interface HermesSpawnInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface HermesSpawnPlan extends HermesSpawnInput {
  sandboxed: boolean;
  backend: "sandbox-exec" | "bwrap" | "custom" | "none";
  allowedDomains: string[];
  reason?: string;
}

export type HermesSpawnWrapper = (
  plan: HermesSpawnPlan,
) => HermesSpawnPlan | Promise<HermesSpawnPlan>;

export interface HermesManagerOptions {
  toolEndpoint?: { url: string; key: string };
  runtimeDir?: string;
  homeDir?: string;
  spawn?: SpawnFn;
  fetch?: FetchFn;
  /** How long to wait for /health after starting. */
  startTimeoutMs?: number;
  /** Optional OS sandbox / domain-allowlist configuration for the sidecar spawn. */
  sandbox?: HermesSandboxOptions;
  /** Convenience outbound domain allowlist for the sidecar spawn. */
  allowedDomains?: string[];
  /** Optional custom wrapper hook for sidecar spawns (e.g. proxy or custom sandbox). */
  spawnWrapper?: HermesSpawnWrapper;
}

const HEALTH_POLL_MS = 250;

function normalizeDomainEntry(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    if (trimmed.includes("://")) return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  const withoutPort = trimmed.replace(/:\d+$/, "").toLowerCase();
  return withoutPort || undefined;
}

/**
 * Computes the normalized outbound domain allowlist for a Hermes sidecar run:
 * always permits loopback for local API / ToolBroker calls, plus the active
 * model endpoint host and any explicitly configured domains.
 */
export function resolveHermesAllowedDomains(
  model?: HermesModelConfig,
  extraDomains?: string[],
  toolEndpointUrl?: string,
): string[] {
  const domains = new Set<string>(["127.0.0.1", "localhost"]);
  const add = (value: string | undefined): void => {
    if (!value) return;
    const normalized = normalizeDomainEntry(value);
    if (normalized) domains.add(normalized);
  };
  add(toolEndpointUrl);
  if (model) {
    if ("baseUrl" in model && model.baseUrl) {
      add(model.baseUrl);
    } else if (model.kind === "anthropic") {
      domains.add("api.anthropic.com");
    } else if (model.kind === "openai-codex") {
      domains.add("chatgpt.com");
      domains.add("api.openai.com");
    }
  }
  for (const entry of extraDomains ?? []) add(entry);
  return [...domains];
}

/**
 * Wraps a Hermes sidecar spawn with an OS sandbox (`sandbox-exec` / `bwrap`)
 * and domain-allowlist metadata. Falls back gracefully on desktop dev
 * environments when an OS sandbox is unavailable unless `hardened` is true.
 */
export async function wrapHermesSidecarSpawn(
  input: HermesSpawnInput,
  options: HermesSandboxOptions & { spawnWrapper?: HermesSpawnWrapper } = {},
): Promise<HermesSpawnPlan> {
  const sandboxRequested = Boolean(options.enabled || options.hardened);
  const allowedDomains = options.allowedDomains ?? ["127.0.0.1", "localhost"];
  const env: NodeJS.ProcessEnv = { ...input.env };
  if (sandboxRequested || (options.allowedDomains && options.allowedDomains.length > 0)) {
    env.SSHS3_ALLOWED_DOMAINS = allowedDomains.join(",");
  }

  const sandboxOpts: OsSandboxOptions = {
    enabled: sandboxRequested,
    failIfUnavailable: Boolean(options.hardened),
    cwd: input.cwd,
    readPaths: options.readPaths,
    writePaths: options.writePaths,
    allowedDomains,
    allowNetwork: allowedDomains.length > 0 || !options.hardened,
    platform: options.platform,
    hasBinary: options.hasBinary,
    env,
  };
  const wrapped = wrapWithOsSandbox(input.command, input.args, sandboxOpts);
  let plan: HermesSpawnPlan = {
    command: wrapped.command,
    args: wrapped.args,
    cwd: input.cwd,
    env,
    sandboxed: wrapped.sandboxed,
    backend: wrapped.backend,
    allowedDomains,
    reason: wrapped.reason,
  };
  if (options.spawnWrapper) {
    plan = await options.spawnWrapper(plan);
  }
  return plan;
}

export class HermesManager {
  private readonly runtimeDir: string;
  private readonly homeDir: string;
  private readonly spawnImpl: SpawnFn;
  private readonly fetchImpl: FetchFn;
  private readonly startTimeoutMs: number;
  private readonly sandbox?: HermesSandboxOptions;
  private readonly allowedDomains?: string[];
  private readonly spawnWrapper?: HermesSpawnWrapper;
  private child: ChildProcess | null = null;
  private generation = 0;
  private endpoint: HermesEndpoint | null = null;
  /** The model config the running child was started with; a change restarts it. */
  private runningModelKey = "";
  private starting: Promise<HermesEndpoint> | null = null;
  private readonly toolEndpoint?: { url: string; key: string };

  constructor(options: HermesManagerOptions = {}) {
    this.toolEndpoint = options.toolEndpoint;
    this.runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
    this.homeDir = options.homeDir ?? defaultHomeDir();
    this.spawnImpl = options.spawn ?? nodeSpawn;
    this.fetchImpl = options.fetch ?? fetch;
    this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
    this.sandbox = options.sandbox;
    this.allowedDomains = options.allowedDomains;
    this.spawnWrapper = options.spawnWrapper;
  }

  /** The bundled runtime, or null when this build doesn't include one (e.g. a dev checkout). */
  public async getManifest(): Promise<HermesManifest | null> {
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(this.runtimeDir, "manifest.json"), "utf-8"),
      ) as HermesManifest;
      if (manifest.commit !== "f97608f178d1ffeca59860195ab7da295f7c8e5f") // pragma: allowlist secret
        return null;
      if (
        typeof manifest.python !== "string" ||
        !manifest.python ||
        path.isAbsolute(manifest.python) ||
        manifest.python.includes("..")
      ) {
        return null;
      }
      await fs.access(path.join(this.runtimeDir, manifest.python));
      return manifest;
    } catch {
      return null;
    }
  }

  public isRunning(): boolean {
    return this.child !== null && this.endpoint !== null;
  }

  /** Starts Hermes if needed (or restarts it when the model changed) and returns its local endpoint. */
  public async ensureRunning(
    model: HermesModelConfig,
  ): Promise<HermesEndpoint> {
    const key = modelKey(model);
    if (this.starting) {
      const endpoint = await this.starting;
      if (key === this.runningModelKey) return endpoint;
    }
    if (this.endpoint && this.child && key === this.runningModelKey)
      return this.endpoint;
    if (this.child) await this.stop();
    this.starting = this.start(model).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  public async stop(): Promise<void> {
    this.generation++;
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.runningModelKey = "";
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  private async start(model: HermesModelConfig): Promise<HermesEndpoint> {
    const generation = this.generation;
    const manifest = await this.getManifest();
    if (!manifest)
      throw new Error(
        "This build of sshs3 does not include the Hermes runtime.",
      );

    await fs.mkdir(this.homeDir, { recursive: true, mode: 0o700 });
    await writeManagedConfig(path.join(this.homeDir, "config.yaml"), model);

    const port = await freePort();
    const apiKey = crypto.randomBytes(32).toString("hex");
    const env: NodeJS.ProcessEnv = {
      ...hermesBaseEnvironment(process.env, this.homeDir),
      HERMES_HOME: this.homeDir,
      HERMES_GATEWAY_NO_SUPERVISE: "1",
      API_SERVER_ENABLED: "true",
      API_SERVER_HOST: "127.0.0.1",
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: apiKey,
      PYTHONNOUSERSITE: "1",
      ...(this.toolEndpoint
        ? {
            SSHS3_TOOL_URL: this.toolEndpoint.url,
            SSHS3_TOOL_KEY: this.toolEndpoint.key,
          }
        : {}),
      ...(model.kind === "anthropic" && !model.baseUrl
        ? { ANTHROPIC_API_KEY: model.apiKey }
        : {}),
      ...(model.baseUrl && "apiKey" in model && model.apiKey
        ? { SSHS3_MODEL_API_KEY: model.apiKey }
        : {}),
    };

    if (generation !== this.generation)
      throw new Error("Hermes startup cancelled");
    const python = path.join(this.runtimeDir, manifest.python);
    const baseArgs = [
      "-I",
      path.join(this.runtimeDir, "sshs3_bootstrap.py"),
      "gateway",
      "run",
      "--no-supervise",
    ];
    const configuredDomains = this.sandbox?.allowedDomains ?? this.allowedDomains;
    const effectiveDomains =
      this.sandbox?.enabled || this.sandbox?.hardened || configuredDomains || this.spawnWrapper
        ? resolveHermesAllowedDomains(model, configuredDomains, this.toolEndpoint?.url)
        : undefined;
    const spawnPlan = await wrapHermesSidecarSpawn(
      { command: python, args: baseArgs, cwd: this.homeDir, env },
      {
        ...this.sandbox,
        ...(effectiveDomains ? { allowedDomains: effectiveDomains } : {}),
        readPaths: [this.runtimeDir, ...(this.sandbox?.readPaths ?? [])],
        writePaths: [this.homeDir, ...(this.sandbox?.writePaths ?? [])],
        spawnWrapper: this.spawnWrapper,
      },
    );
    if (!spawnPlan.sandboxed && (this.sandbox?.enabled || this.sandbox?.hardened)) {
      hermesLog.warn("Hermes OS sandbox unavailable; falling back to unsandboxed sidecar", {
        reason: spawnPlan.reason,
      });
    }
    hermesLog.info("Starting Hermes", {
      tag: manifest.tag,
      port,
      sandboxed: spawnPlan.sandboxed,
      backend: spawnPlan.backend,
    });
    const child = this.spawnImpl(spawnPlan.command, spawnPlan.args, {
      cwd: spawnPlan.cwd,
      env: spawnPlan.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const tail: string[] = [];
    const collect = (chunk: Buffer): void => {
      tail.push(...chunk.toString("utf-8").split("\n").filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 20));
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let exited = false;
    child.once("error", () => {
      exited = true;
    });
    child.once("exit", (code) => {
      exited = true;
      if (this.child === child) {
        this.child = null;
        this.endpoint = null;
        this.runningModelKey = "";
      }
      hermesLog.info("Hermes exited", { code });
    });

    const endpoint: HermesEndpoint = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey,
    };
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (this.child !== child) throw new Error("Hermes startup cancelled");
      if (exited) {
        hermesLog.warn("Hermes exited during startup", {
          output: boundedContext(tail.join("\n")),
        });
        throw new Error(
          `Hermes stopped while starting: ${tail[tail.length - 1] ?? "no output"}`,
        );
      }
      if (await this.healthy(port)) {
        this.endpoint = endpoint;
        this.runningModelKey = modelKey(model);
        return endpoint;
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    await this.stop();
    throw new Error("Hermes did not start in time.");
  }

  private async healthy(port: number): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function modelKey(model: HermesModelConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(model))
    .digest("hex");
}

/** YAML double-quoted scalar; JSON string escaping is a valid subset. */
const yamlString = (value: string): string => JSON.stringify(value);

/** The only Hermes toolsets sshs3 enables: they read and write Hermes' own notes, nothing else. */
export const HERMES_ENABLED_TOOLSETS = ["sshs3"];

/**
 * Switched off globally as well (agent.disabled_toolsets wins over every other toolset setting),
 * so a toolset can't come back through a platform default or a later Hermes release.
 */
export const HERMES_DISABLED_TOOLSETS = [
  "memory",
  "session_search",
  "todo",
  "terminal",
  "file",
  "code_execution",
  "browser",
  "computer_use",
  "web",
  "delegation",
  "cronjob",
  "skills",
  "connections",
  "kanban",
  "clarify",
  "vision",
  "video",
  "image_gen",
  "video_gen",
  "tts",
  "x_search",
  "homeassistant",
  "spotify",
  "discord",
  "discord_admin",
  "yuanbao",
];

/**
 * sshs3's policy for the bundled Hermes, written over these top-level keys of config.yaml on
 * every start so neither Hermes nor an edit to the file can loosen it between starts.
 */
export function hermesPolicyBlocks(): string {
  const list = (names: string[]): string =>
    `[${names.map(yamlString).join(", ")}]`;
  return [
    "platform_toolsets:",
    `  api_server: ${list(HERMES_ENABLED_TOOLSETS)}`,
    "toolsets: []",
    "agent:",
    `  disabled_toolsets: ${list(HERMES_DISABLED_TOOLSETS)}`,
    "mcp_servers: {}",
    // No tool_search/tool_call bridge: the model is offered exactly the tools above, nothing to discover.
    "tools:",
    "  tool_search:",
    '    enabled: "off"',
    "approvals:",
    '  mode: "manual"',
    '  cron_mode: "deny"',
    '  single_query_mode: "deny"',
    '  unattended_mode: "deny"',
    '  deny: ["*"]',
    "command_allowlist: []",
    "",
  ].join("\n");
}

export function modelConfigBlock(model: HermesModelConfig): string {
  if (model.kind === "openai-codex") {
    return `${[
      "model:",
      '  provider: "openai-codex"',
      `  default: ${yamlString(model.model)}`,
    ].join("\n")}\n`;
  }
  const { baseUrl } = model;
  // Hermes' "anthropic" provider only honours base URLs it recognises and otherwise calls
  // api.anthropic.com, which would bypass the user's gateway. So an Anthropic endpoint goes
  // in as a custom endpoint that speaks the Messages API.
  const lines = [
    "model:",
    `  provider: ${baseUrl ? '"custom"' : '"anthropic"'}`,
    `  default: ${yamlString(model.model)}`,
  ];
  if (baseUrl) {
    lines.push(`  base_url: ${yamlString(baseUrl)}`);
    if (model.kind === "anthropic")
      lines.push('  api_mode: "anthropic_messages"');
    if (model.apiKey) lines.push('  key_env: "SSHS3_MODEL_API_KEY"');
  }
  return `${lines.join("\n")}\n`;
}

/** Top-level keys of config.yaml that sshs3 owns; everything else Hermes keeps there survives. */
const MANAGED_KEYS = new Set([
  "model",
  "platform_toolsets",
  "toolsets",
  "agent",
  "mcp_servers",
  "tools",
  "approvals",
  "command_allowlist",
]);

/**
 * Rewrites the keys sshs3 manages in Hermes' config.yaml (the model and the policy) and keeps the
 * rest. Never contains a secret: keys go through the environment.
 */
export async function writeManagedConfig(
  file: string,
  model: HermesModelConfig,
): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf-8");
  } catch {
    // First start.
  }
  const kept: string[] = [];
  let skipping = false;
  for (const line of existing.split("\n")) {
    // A line starting in column 0 opens a top-level key; indented lines belong to the one above.
    if (/^\S/.test(line))
      skipping = MANAGED_KEYS.has(/^([\w-]+)\s*:/.exec(line)?.[1] ?? "");
    if (!skipping) kept.push(line);
  }
  const rest = kept.join("\n").replace(/^\n+/, "");
  await fs.writeFile(
    file,
    modelConfigBlock(model) + hermesPolicyBlocks() + (rest ? `\n${rest}` : ""),
    {
      encoding: "utf-8",
      mode: 0o600,
    },
  );
}

/** Variables the Hermes child may inherit from sshs3: what Python and HTTPS need, nothing more. */
const INHERITED_ENV = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
]);

/**
 * The environment Hermes starts from: an allowlist of the parent's variables, with the home
 * directory pointed at Hermes' own folder. Leaves out SSH_AUTH_SOCK, AWS_*, KUBECONFIG and every
 * other credential sshs3 itself may have, so the agent can't reach them.
 */
export function hermesBaseEnvironment(
  parent: NodeJS.ProcessEnv,
  homeDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && INHERITED_ENV.has(name)) env[name] = value;
  }
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No free port")),
      );
    });
  });
}

function defaultRuntimeDir(): string {
  try {
    if (app.isPackaged) return path.join(process.resourcesPath, "hermes");
    return path.join(app.getAppPath(), "build-resources", "hermes");
  } catch {
    return path.join(process.cwd(), "build-resources", "hermes");
  }
}

function defaultHomeDir(): string {
  try {
    return path.join(app.getPath("userData"), "hermes");
  } catch {
    return path.join(os.homedir(), ".sshs3", "hermes");
  }
}
