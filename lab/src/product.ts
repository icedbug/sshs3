import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentMode, AgentTask, HubRequest, HubSnapshot } from '../../src/shared/types/aiHub';
import type { LabState } from './lab';
import { exec } from './ssh';
import { trustBundle } from './tls';
import { must, openSession, type CapturedEvent, type WebSession } from './webClient';

/**
 * The product under test: the shipped web server (`dist-web/server.mjs`), started as its own process
 * and driven the way the browser drives it. Nothing here reaches into the server's code: what a test
 * learns, a person at the page could have seen.
 */

export type { CapturedEvent } from './webClient';

export interface ModelSettings {
  reasoningEffort?: 'low' | 'medium' | 'high';
  contextWindowTokens?: number;
}

export interface Account {
  id: string;
  name: string;
  hub(req: HubRequest): Promise<HubSnapshot>;
  events: CapturedEvent[];
  /** The model, through the lab's model proxy, under the run's name. */
  /** The model through the lab's proxy; the reasoning level and context window only when a campaign names them. */
  useModel(model: string, runId: string, proxyUrl: string, settings?: ModelSettings): Promise<void>;
  /** The account's key on every lab server, and the servers' host keys in the account's known hosts. */
  trustLab(lab: LabState): Promise<void>;
  /** One shared SSH profile per lab server. */
  saveProfiles(lab: LabState): Promise<void>;
  /** Opens a terminal on a lab server and waits for its shell prompt. Returns the session id. */
  openTerminal(server: string): Promise<string>;
  /** Starts a conversation, as the panel's send button does. Returns the task id. */
  start(opts: { prompt: string; mode: AgentMode; sessionId?: string }): Promise<string>;
  task(taskId: string): Promise<AgentTask>;
  answer(taskId: string, changeId: string, approved: boolean, note?: string): Promise<void>;
  close(): void;
}

export interface Team {
  maria: Account;
  omar: Account;
  lina: Account;
}

export interface Product {
  dataDir: string;
  baseUrl: string;
  /** The version of the Node the web server runs on. */
  node: string;
  /** The commit of the product code the web server was built from. */
  commit: string;
  team(): Promise<Team>;
  stop(): Promise<void>;
}

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(REPO, 'dist-web', 'server.mjs');
const STAMP = path.join(REPO, 'dist-web', 'lab-build.json');
/** What the web build is made from: a change to any of it means the build is out of date. */
const PRODUCT_SOURCES = ['src', 'scripts/build-web.mjs', 'package.json', 'package-lock.json'];
/** The embedding model the product is given: the one the design names for knowledge base search. */
const EMBEDDING_MODEL = 'text-embedding-3-small';
const PASSWORDS = { maria: 'lab-maria-password-1', omar: 'lab-omar-password-1', lina: 'lab-lina-password-1' } as const; // pragma: allowlist secret

function git(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd: REPO }, (error, stdout, stderr) => (error ? reject(new Error(`git ${args.join(' ')}: ${stderr || error.message}`)) : resolve(stdout.trim()))),
  );
}

/** The last commit that changed the product's own code. */
export async function lastSourceCommit(): Promise<string> {
  return git(['log', '-1', '--format=%H', '--', ...PRODUCT_SOURCES]);
}

/** Uncommitted changes to the product's own code, as `git status` lists them. */
async function sourceChanges(): Promise<string> {
  return git(['status', '--porcelain', '--', ...PRODUCT_SOURCES]);
}

/** Builds the web server and notes which commit of the product it was built from. */
export async function buildProduct(): Promise<{ sourceCommit: string; builtAt: string }> {
  if (await sourceChanges()) throw new Error('The product code has uncommitted changes: a build of it would name no commit. Commit or stash them first.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', '-s', 'build:web'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out = (out + c).slice(-4000)));
    child.stderr.on('data', (c) => (out = (out + c).slice(-4000)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm run build:web failed (${code}): ${out}`))));
  });
  const stamp = { sourceCommit: await lastSourceCommit(), builtAt: new Date().toISOString() };
  await fs.writeFile(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
  return stamp;
}

/**
 * The build the lab tests: built from the product code as it is committed now. A build that is
 * missing or older than the last change to the product code is made again first.
 */
export async function productBuild(): Promise<{ sourceCommit: string; builtAt: string }> {
  const want = await lastSourceCommit();
  try {
    await fs.access(SERVER);
    const stamp = JSON.parse(await fs.readFile(STAMP, 'utf8')) as { sourceCommit: string; builtAt: string };
    if (stamp.sourceCommit === want && !(await sourceChanges())) return stamp;
  } catch {
    // No build, or one the lab did not make: it is made again.
  }
  return buildProduct();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, log: () => string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`The web server stopped (${child.exitCode}) before it answered: ${log()}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The web server did not answer /api/health within ${timeoutMs / 1000} s: ${log()}`);
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
// Terminal control sequences (colours, bracketed paste) around a prompt.
const CONTROL_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
/** A terminal whose last text, without its control sequences, ends the way a bash prompt does. */
const atShellPrompt = (text: string): boolean => /[$#] $/.test(text.replace(CONTROL_SEQUENCE, ''));

function makeAccount(product: { dataDir: string }, user: { id: string; username: string }, session: WebSession): Account {
  const hub = (req: HubRequest) => session.invoke<HubSnapshot>('ai-hub:request', req);
  const sshDir = path.join(product.dataDir, 'users', user.id.replace(/[^a-zA-Z0-9_-]/g, ''), '.ssh');

  const account: Account = {
    id: user.id,
    name: user.username,
    hub,
    events: session.events,

    async useModel(model, runId, proxyUrl, settings) {
      const tuning = {
        ...(settings?.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
        ...(settings?.contextWindowTokens ? { contextWindowTokens: settings.contextWindowTokens } : {}),
      };
      // A Claude model as a person sets one up: the Anthropic provider, here at the lab's proxy, with the
      // run's dummy key, which the proxy swaps for the lab's own. Anthropic has no embeddings: the
      // knowledge base then searches by words, as it does for any Claude user.
      if (model.startsWith('claude-')) {
        await hub({ action: 'configure', config: { enabled: true, provider: 'anthropic', model, baseUrl: proxyUrl, apiKey: `lab-${runId}`, ...tuning } });
        return;
      }
      await hub({
        action: 'configure',
        config: {
          enabled: true,
          provider: 'openai-compatible',
          model,
          baseUrl: `${proxyUrl}/v1`,
          // The product talks to OpenAI over the Responses API; at a base URL other than OpenAI's own
          // it would pick Chat Completions on its own, which is not what a person using OpenAI gets.
          apiProtocol: 'responses',
          apiKey: `lab-${runId}`,
          embeddingModel: EMBEDDING_MODEL,
          ...tuning,
        },
      });
    },

    async trustLab(lab) {
      const publicKey = (await fs.readFile(path.join(sshDir, 'id_ed25519.pub'), 'utf8')).trim();
      if (!/^ssh-ed25519 \S+/.test(publicKey)) throw new Error(`${user.username} has no SSH key the lab can use.`);
      const add = `install -d -m 700 -o ops -g ops /home/ops/.ssh && touch /home/ops/.ssh/authorized_keys && (grep -qxF ${shellQuote(publicKey)} /home/ops/.ssh/authorized_keys || echo ${shellQuote(publicKey)} >> /home/ops/.ssh/authorized_keys) && chown ops:ops /home/ops/.ssh/authorized_keys && chmod 600 /home/ops/.ssh/authorized_keys`;
      for (const s of lab.servers.filter((x) => x.role !== 's3')) {
        const r = await exec(s.ip, add);
        if (r.code !== 0) throw new Error(`Could not put ${user.username}'s key on ${s.name}: ${r.stderr || r.stdout}`);
      }
      const knownHosts = path.join(sshDir, 'known_hosts');
      const have = await fs.readFile(knownHosts, 'utf8').catch(() => '');
      const lines = lab.hostKeys.split('\n').map((l) => l.trim()).filter((l) => l && !have.split('\n').includes(l));
      if (lines.length) await fs.appendFile(knownHosts, `${have && !have.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`, { mode: 0o600 });
    },

    async saveProfiles(lab) {
      for (const s of lab.servers.filter((x) => x.role !== 's3'))
        await session.invoke('profiles:save-ssh', {
          id: s.name,
          name: s.name,
          host: s.ip,
          port: 22,
          username: s.user,
          // No password and no key file: ssh offers the account's own key (the web server's account setup).
          authType: 'agent',
          tags: [...s.tags],
          description: s.description,
          shared: true,
        });
    },

    async openTerminal(server) {
      const profiles = await session.invoke<{ ssh: Array<Record<string, unknown> & { id: string; name: string }> }>('profiles:get');
      const profile = profiles.ssh.find((p) => p.name === server || p.id === server);
      if (!profile) throw new Error(`${user.username} has no server profile named ${server}.`);
      // What the page sends: a fresh id for the terminal, the profile's id beside it.
      let shown = '';
      let sessionId = '';
      const early: string[] = [];
      const atPrompt = new Promise<void>((resolve) => {
        const stop = session.onEvent((e) => {
          if (e.channel !== 'terminal:data') return;
          const [id, data] = e.args as [string, string];
          if (!sessionId) {
            early.push(`${id}\u0000${data}`);
            return;
          }
          if (id !== sessionId) return;
          shown = (shown + data).slice(-4000);
          if (atShellPrompt(shown)) {
            stop();
            resolve();
          }
        });
      });
      const created = await session.invoke<{ sessionId: string }>('terminal:create', {
        config: { ...profile, id: crypto.randomUUID() },
        profileId: profile.id,
        ptyOptions: { cols: 160, rows: 48 },
      });
      sessionId = created.sessionId;
      for (const item of early) {
        const [id, data] = item.split('\u0000') as [string, string];
        if (id === sessionId) shown += data;
      }
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`No shell prompt on ${server} within 30 s. The terminal showed: ${shown.slice(-400)}`)), 30_000).unref(),
      );
      if (!atShellPrompt(shown)) await Promise.race([atPrompt, timeout]);
      return sessionId;
    },

    async start(opts) {
      const snapshot = await hub({ action: 'start', task: { prompt: opts.prompt, sessionId: opts.sessionId, mode: opts.mode } });
      const taskId = snapshot.reply?.started?.taskId;
      if (!taskId) throw new Error('The server started no conversation.');
      return taskId;
    },

    async task(taskId) {
      // The list holds the run's state; the conversation whole (a snapshot holds only its last
      // messages) comes from task-read.
      const snapshot = await hub({ action: 'snapshot' });
      const listed = snapshot.tasks.find((t) => t.id === taskId);
      if (!listed) throw new Error(`${user.username} has no conversation ${taskId}.`);
      const whole = (await hub({ action: 'task-read', taskId })).reply?.task;
      return whole ? { ...listed, messages: whole.messages, changes: whole.changes, messagesTail: undefined } : listed;
    },

    async answer(taskId, changeId, approved, note) {
      await hub({ action: 'approve', taskId, changeId, approved, ...(note ? { note } : {}) });
    },

    close: () => session.close(),
  };
  return account;
}

/**
 * The Node the product asks for (package.json engines: 24.15 or later in 24), which need not be the one
 * the lab runs on: LAB_PRODUCT_NODE, else /opt/node24, else the lab's own if it qualifies.
 */
export async function productNode(): Promise<{ path: string; version: string }> {
  const candidates = [process.env.LAB_PRODUCT_NODE, '/opt/node24/bin/node', process.execPath].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    const version = await new Promise<string>((resolve) => execFile(candidate, ['-v'], (error, stdout) => resolve(error ? '' : stdout.trim())));
    if (/^v24\.(?:1[5-9]|[2-9]\d)\./.test(version)) return { path: candidate, version };
  }
  throw new Error('No Node 24.15 or later for the web server: set LAB_PRODUCT_NODE to one.');
}

/**
 * The build as it is, never built again: for a campaign, which builds once at its start. A build of
 * another commit, or product code changed since, is refused.
 */
export async function builtProduct(expectCommit: string): Promise<{ sourceCommit: string; builtAt: string }> {
  const stamp = JSON.parse(await fs.readFile(STAMP, 'utf8').catch(() => '{}')) as { sourceCommit?: string; builtAt?: string };
  if (stamp.sourceCommit !== expectCommit) throw new Error(`The web server's build is of ${String(stamp.sourceCommit).slice(0, 10)}, not of ${expectCommit.slice(0, 10)}, the commit this campaign runs on.`);
  if (await sourceChanges()) throw new Error('The product code has changed since this campaign started: its runs would not be comparable.');
  return { sourceCommit: stamp.sourceCommit, builtAt: stamp.builtAt ?? '' };
}

/**
 * What the web server must not have of the lab's environment: the way out through the environment's
 * proxy (it talks only to the lab), and every real model key. The product gets a dummy key per run;
 * the lab's proxy alone holds the real ones.
 */
const WITHHELD = ['NODE_USE_ENV_PROXY', 'LAB_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'];

export function productEnv(base: NodeJS.ProcessEnv, own: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !WITHHELD.includes(k)) env[k] = v;
  return { ...env, ...own };
}

export async function startProduct(opts: { dataDir: string; port: number; env?: Record<string, string>; expectCommit?: string }): Promise<Product> {
  const build = opts.expectCommit ? await builtProduct(opts.expectCommit) : await productBuild();
  const node = await productNode();
  await fs.mkdir(opts.dataDir, { recursive: true });
  const port = opts.port || (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  let log = '';
  const child = spawn(node.path, [SERVER], {
    cwd: REPO,
    env: productEnv(process.env, {
      SSHS3_DATA_DIR: opts.dataDir,
      SSHS3_WEB_PORT: String(port),
      SSHS3_WEB_HOST: '127.0.0.1',
      SSHS3_ALLOW_PRIVATE_ADDRESSES: '1',
      // The lab's CA: the model proxy answers over https with a certificate it signed.
      NODE_EXTRA_CA_CERTS: await trustBundle(),
      ...opts.env,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (c: Buffer) => (log = (log + c.toString()).slice(-20_000));
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  try {
    await waitForHealth(baseUrl, child, () => log.slice(-2000));
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }

  const accounts: Account[] = [];
  let team: Team | undefined;
  return {
    dataDir: opts.dataDir,
    baseUrl,
    node: node.version,
    commit: build.sourceCommit,
    async team() {
      if (team) return team;
      const product = { dataDir: opts.dataDir };
      const admin = await must(baseUrl, 'POST', '/api/auth/setup', { username: 'maria', displayName: 'Maria', password: PASSWORDS.maria });
      const join = async (username: 'omar' | 'lina') => {
        const invite = await must(baseUrl, 'POST', '/api/admin/invites', { role: 'member', maxUses: 1 }, admin.cookie);
        return must(baseUrl, 'POST', '/api/auth/register-invite', { inviteToken: invite.body.invite.token, username, displayName: username[0]!.toUpperCase() + username.slice(1), password: PASSWORDS[username] });
      };
      const omar = await join('omar');
      const lina = await join('lina');
      const made = await Promise.all(
        [admin, omar, lina].map(async (a) => makeAccount(product, a.body.user as { id: string; username: string }, await openSession(baseUrl, a.cookie))),
      );
      accounts.push(...made);
      team = { maria: made[0]!, omar: made[1]!, lina: made[2]! };
      return team;
    },
    async stop() {
      for (const a of accounts) a.close();
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 10_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}
