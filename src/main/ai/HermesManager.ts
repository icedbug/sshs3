import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { createLogger } from '../log';
const hermesLog = createLogger('hermes');

/**
 * Runs the Hermes Agent (Nous Research, MIT) that ships inside sshs3 as a private sidecar:
 * a relocatable Python runtime under <resources>/hermes, built by scripts/hermes/build-runtime.mjs.
 *
 * sshs3 starts it on demand with its OpenAI-compatible API server bound to 127.0.0.1 on a free
 * port, with a fresh random key per start that only lives in this process, and stops it on quit.
 * Hermes keeps its memory, sessions and scheduled jobs in its own home under the app's userData.
 * Model credentials are passed through the child's environment, never written to Hermes' files.
 *
 * Guardrails, re-applied on every start (see HERMES_POLICY):
 * - Only memory, past-session search and a to-do list are enabled. Every tool that acts on the
 *   machine or the network (terminal, files, code execution, browser, computer use, delegation,
 *   cron, MCP servers, …) is switched off, and every shell command is on Hermes' deny list.
 * - The child gets a minimal environment: no SSH agent socket, cloud credentials or the user's
 *   home directory, so nothing sshs3 can reach is reachable from Hermes.
 */

export interface HermesManifest {
  tag: string;
  commit: string;
  /** Interpreter path relative to the runtime directory. */
  python: string;
}

/** Which model Hermes itself uses: Anthropic directly, or any OpenAI-compatible server. */
export type HermesModelConfig =
  | { kind: 'anthropic'; model: string; apiKey: string }
  | { kind: 'custom'; model: string; baseUrl: string; apiKey?: string };

export interface HermesEndpoint {
  baseUrl: string;
  apiKey: string;
}

type SpawnFn = typeof nodeSpawn;
type FetchFn = typeof fetch;

export interface HermesManagerOptions {
  runtimeDir?: string;
  homeDir?: string;
  spawn?: SpawnFn;
  fetch?: FetchFn;
  /** How long to wait for /health after starting. */
  startTimeoutMs?: number;
}

const HEALTH_POLL_MS = 250;

export class HermesManager {
  private readonly runtimeDir: string;
  private readonly homeDir: string;
  private readonly spawnImpl: SpawnFn;
  private readonly fetchImpl: FetchFn;
  private readonly startTimeoutMs: number;
  private child: ChildProcess | null = null;
  private endpoint: HermesEndpoint | null = null;
  /** The model config the running child was started with; a change restarts it. */
  private runningModelKey = '';
  private starting: Promise<HermesEndpoint> | null = null;

  constructor(options: HermesManagerOptions = {}) {
    this.runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
    this.homeDir = options.homeDir ?? defaultHomeDir();
    this.spawnImpl = options.spawn ?? nodeSpawn;
    this.fetchImpl = options.fetch ?? fetch;
    this.startTimeoutMs = options.startTimeoutMs ?? 60_000;
  }

  /** The bundled runtime, or null when this build doesn't include one (e.g. a dev checkout). */
  public async getManifest(): Promise<HermesManifest | null> {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(this.runtimeDir, 'manifest.json'), 'utf-8')) as HermesManifest;
      if (typeof manifest.python !== 'string' || !manifest.python || path.isAbsolute(manifest.python) || manifest.python.includes('..')) {
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
  public async ensureRunning(model: HermesModelConfig): Promise<HermesEndpoint> {
    const key = modelKey(model);
    if (this.starting) {
      const endpoint = await this.starting;
      if (key === this.runningModelKey) return endpoint;
    }
    if (this.endpoint && this.child && key === this.runningModelKey) return this.endpoint;
    if (this.child) await this.stop();
    this.starting = this.start(model).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  public async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.endpoint = null;
    this.runningModelKey = '';
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  private async start(model: HermesModelConfig): Promise<HermesEndpoint> {
    const manifest = await this.getManifest();
    if (!manifest) throw new Error('This build of sshs3 does not include the Hermes runtime.');

    await fs.mkdir(this.homeDir, { recursive: true, mode: 0o700 });
    await writeManagedConfig(path.join(this.homeDir, 'config.yaml'), model);

    const port = await freePort();
    const apiKey = crypto.randomBytes(32).toString('hex');
    const env: NodeJS.ProcessEnv = {
      ...hermesBaseEnvironment(process.env, this.homeDir),
      HERMES_HOME: this.homeDir,
      HERMES_GATEWAY_NO_SUPERVISE: '1',
      API_SERVER_ENABLED: 'true',
      API_SERVER_HOST: '127.0.0.1',
      API_SERVER_PORT: String(port),
      API_SERVER_KEY: apiKey,
      PYTHONNOUSERSITE: '1',
      ...(model.kind === 'anthropic' ? { ANTHROPIC_API_KEY: model.apiKey } : {}),
      ...(model.kind === 'custom' && model.apiKey ? { SSHS3_MODEL_API_KEY: model.apiKey } : {}),
    };

    const python = path.join(this.runtimeDir, manifest.python);
    hermesLog.info('Starting Hermes', { tag: manifest.tag, port });
    const child = this.spawnImpl(python, ['-I', '-m', 'hermes_cli.main', 'gateway', 'run', '--no-supervise'], {
      cwd: this.homeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    const tail: string[] = [];
    const collect = (chunk: Buffer): void => {
      tail.push(...chunk.toString('utf-8').split('\n').filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 20));
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    let exited = false;
    child.once('exit', (code) => {
      exited = true;
      if (this.child === child) {
        this.child = null;
        this.endpoint = null;
        this.runningModelKey = '';
      }
      hermesLog.info('Hermes exited', { code });
    });

    const endpoint: HermesEndpoint = { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey };
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        hermesLog.warn('Hermes exited during startup', { output: tail.join('\n') });
        throw new Error(`Hermes stopped while starting: ${tail[tail.length - 1] ?? 'no output'}`);
      }
      if (await this.healthy(port)) {
        this.endpoint = endpoint;
        this.runningModelKey = modelKey(model);
        return endpoint;
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    await this.stop();
    throw new Error('Hermes did not start in time.');
  }

  private async healthy(port: number): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}

function modelKey(model: HermesModelConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify(model)).digest('hex');
}

/** YAML double-quoted scalar; JSON string escaping is a valid subset. */
const yamlString = (value: string): string => JSON.stringify(value);

/** The only Hermes toolsets sshs3 enables: they read and write Hermes' own notes, nothing else. */
export const HERMES_ENABLED_TOOLSETS = ['memory', 'session_search', 'todo'];

/**
 * Switched off globally as well (agent.disabled_toolsets wins over every other toolset setting),
 * so a toolset can't come back through a platform default or a later Hermes release.
 */
export const HERMES_DISABLED_TOOLSETS = [
  'terminal',
  'file',
  'code_execution',
  'browser',
  'computer_use',
  'web',
  'delegation',
  'cronjob',
  'skills',
  'connections',
  'kanban',
  'clarify',
  'vision',
  'video',
  'image_gen',
  'video_gen',
  'tts',
  'x_search',
  'homeassistant',
  'spotify',
  'discord',
  'discord_admin',
  'yuanbao',
];

/**
 * sshs3's policy for the bundled Hermes, written over these top-level keys of config.yaml on
 * every start so neither Hermes nor an edit to the file can loosen it between starts.
 */
export function hermesPolicyBlocks(): string {
  const list = (names: string[]): string => `[${names.map(yamlString).join(', ')}]`;
  return [
    'platform_toolsets:',
    `  api_server: ${list(HERMES_ENABLED_TOOLSETS)}`,
    'toolsets: []',
    'agent:',
    `  disabled_toolsets: ${list(HERMES_DISABLED_TOOLSETS)}`,
    'mcp_servers: {}',
    // No tool_search/tool_call bridge: the model is offered exactly the tools above, nothing to discover.
    'tools:',
    '  tool_search:',
    '    enabled: "off"',
    'approvals:',
    '  mode: "manual"',
    '  cron_mode: "deny"',
    '  single_query_mode: "deny"',
    '  unattended_mode: "deny"',
    '  deny: ["*"]',
    'command_allowlist: []',
    '',
  ].join('\n');
}

export function modelConfigBlock(model: HermesModelConfig): string {
  const lines = ['model:', `  provider: ${model.kind === 'anthropic' ? '"anthropic"' : '"custom"'}`, `  default: ${yamlString(model.model)}`];
  if (model.kind === 'custom') {
    lines.push(`  base_url: ${yamlString(model.baseUrl)}`);
    if (model.apiKey) lines.push('  key_env: "SSHS3_MODEL_API_KEY"');
  }
  return `${lines.join('\n')}\n`;
}

/** Top-level keys of config.yaml that sshs3 owns; everything else Hermes keeps there survives. */
const MANAGED_KEYS = new Set([
  'model',
  'platform_toolsets',
  'toolsets',
  'agent',
  'mcp_servers',
  'tools',
  'approvals',
  'command_allowlist',
]);

/**
 * Rewrites the keys sshs3 manages in Hermes' config.yaml (the model and the policy) and keeps the
 * rest. Never contains a secret: keys go through the environment.
 */
export async function writeManagedConfig(file: string, model: HermesModelConfig): Promise<void> {
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf-8');
  } catch {
    // First start.
  }
  const kept: string[] = [];
  let skipping = false;
  for (const line of existing.split('\n')) {
    // A line starting in column 0 opens a top-level key; indented lines belong to the one above.
    if (/^\S/.test(line)) skipping = MANAGED_KEYS.has(/^([\w-]+)\s*:/.exec(line)?.[1] ?? '');
    if (!skipping) kept.push(line);
  }
  const rest = kept.join('\n').replace(/^\n+/, '');
  await fs.writeFile(file, modelConfigBlock(model) + hermesPolicyBlocks() + (rest ? `\n${rest}` : ''), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Variables the Hermes child may inherit from sshs3: what Python and HTTPS need, nothing more. */
const INHERITED_ENV = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
]);

/**
 * The environment Hermes starts from: an allowlist of the parent's variables, with the home
 * directory pointed at Hermes' own folder. Leaves out SSH_AUTH_SOCK, AWS_*, KUBECONFIG and every
 * other credential sshs3 itself may have, so the agent can't reach them.
 */
export function hermesBaseEnvironment(parent: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
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
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))));
    });
  });
}

function defaultRuntimeDir(): string {
  try {
    if (app.isPackaged) return path.join(process.resourcesPath, 'hermes');
    return path.join(app.getAppPath(), 'build-resources', 'hermes');
  } catch {
    return path.join(process.cwd(), 'build-resources', 'hermes');
  }
}

function defaultHomeDir(): string {
  try {
    return path.join(app.getPath('userData'), 'hermes');
  } catch {
    return path.join(os.homedir(), '.sshs3', 'hermes');
  }
}
