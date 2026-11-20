import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', async () => {
  const shim = await import('../../src/main/web/electronShim');
  return shim;
});

import { setHeadlessUserDataPath } from '../../src/main/web/electronShim';
import { Sshs3WebServer } from '../../src/main/web/WebServer';
import { AgentBotApi } from '../../src/main/web/chatAgent/AgentBotApi';
import { socketTransports } from '../../src/main/web/chatAgent/ChatAgentService';
import { SLACK_APPROVE_ACTION } from '../../src/main/web/chatAgent/chatFormat';
import { connectWs } from '../../src/main/net/wsClient';
import { setDemoModeForTesting } from '../../src/main/demo/demoMode';
import { DemoVirtualPty } from '../../src/main/demo/DemoVirtualPty';
import { FileTools } from '../../src/main/ai/hub/FileTools';
import { FileEditorService } from '../../src/main/editor/FileEditorService';
import { StorageRegistry } from '../../src/main/storage/StorageRegistry';
import { SimStorageProvider } from '../../src/main/sim/SimStorageProvider';
import { simWorld } from '../../src/main/sim/SimWorld';
import { scenarioById, startScenario, stopScenario } from '../../src/main/sim/lab';
import { scoreScenario, type ScenarioScore } from '../../src/main/sim/Scenario';
import type { HubService } from '../../src/main/ai/hub/HubService';
import type { IpcBridge } from '../../src/main/IpcBridge';
import type { StorageConnectConfig } from '../../src/shared/types/ipc';
import type { IStorageProvider } from '../../src/shared/types/storage';
import type { AgentTask, ChatAnsweringRequest, HubRequest } from '../../src/shared/types/aiHub';
import { startFakeSlack, type FakeSlack, type FakeSlackPost } from '../helpers/fakeSlack';

/**
 * The agent bot with a REAL model, through the real web server and a stand-in Slack. Opt in: it runs
 * only when SSHS3_CHAT_REAL_MODEL=1 and SSHS3_SIM_API_KEY and SSHS3_SIM_BASE_URL are set (SSHS3_SIM_MODEL
 * names the model). The two SIM variables alone, as `npm run sim -- <id> --agent` reads them, do not turn
 * it on. It spends real model calls, so it is never part of a normal run.
 *
 *   SSHS3_CHAT_REAL_MODEL=1 SSHS3_SIM_API_KEY=... SSHS3_SIM_BASE_URL=https://api.openai.com/v1 \
 *     SSHS3_SIM_MODEL=gpt-6-luna npx vitest run tests/main/chatAgentRealModel.test.ts
 *
 * One incident of the demo lab (SSHS3_SIM_SCENARIO, default nginx-bad-config) is started. The
 * terminals and files the chat agent opens on its servers are the lab's simulated servers, which keep
 * state: a change the agent makes is there at the next command, and the scenario's own checks say at
 * the end whether the incident was solved. Slack is the stand-in on this machine; the model is real.
 *
 * Maria, an administrator who linked her Slack account, lets #ops-web ask for changes on the scenario's
 * servers. Omar, who did not link his, asks what is wrong. Each card the agent posts, Maria approves by
 * pressing its button. When the agent has reported and the incident still stands, she writes once in
 * the thread: "Go ahead and fix it." The run is capped at 40 commands (terminal commands, file writes
 * and app actions), 60 model calls, 1,000,000 tokens and 12 minutes. Reaching a cap fails the test.
 *
 * It checks the whole path: a card was posted and Maria's approval from Slack was counted, the run
 * ended as completed, every check of the scenario passes, and the thread shows the stored answer.
 *
 * What the bot posted, each command, the model calls and the tokens are written to SSHS3_SIM_TRANSCRIPT
 * (a .md file), or to a file in the system's temporary folder.
 */

const ENABLED = process.env.SSHS3_CHAT_REAL_MODEL === '1';
const KEY = process.env.SSHS3_SIM_API_KEY;
const BASE_URL = process.env.SSHS3_SIM_BASE_URL;
const MODEL = process.env.SSHS3_SIM_MODEL || 'gpt-6-luna';
const SCENARIO = process.env.SSHS3_SIM_SCENARIO || 'nginx-bad-config';
const MAX_COMMANDS = 40;
const MAX_MODEL_CALLS = 60;
const MAX_TOKENS = 1_000_000;
const MAX_MINUTES = 12;
const LOCAL = { server: false, allowPrivate: true };
const CHANNEL = { id: 'COPS', name: 'ops-web' };
const FOLLOW_UP = 'Go ahead and fix it.';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ENDED = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

/** Only the lab's servers have files here: a terminal on one of them reads and writes that server's state. */
class LabFiles extends StorageRegistry {
  override async getOrCreate(config: StorageConnectConfig, connection: { controlPath?: string; profileId?: string } = {}): Promise<IStorageProvider> {
    const known = this.get(config.id);
    if (known) return known;
    const sftp = config.type === 'sftp' ? config.sftpConfig : undefined;
    const refs = [sftp?.name, sftp?.host, connection.profileId].filter((r): r is string => !!r);
    if (!sftp || !simWorld().host(...refs)) throw new Error('Only the lab servers have files in this test.');
    const provider = new SimStorageProvider(config.id, sftp.name || sftp.host, refs);
    this.register(provider);
    return provider;
  }
}

/** Every text a Slack post or edit shows, blocks included, in order. */
function shown(post: FakeSlackPost | undefined): string {
  if (!post) return '';
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') parts.push(record.text);
    else if (record.text && typeof record.text === 'object') walk(record.text);
    if (record.type === 'button' && record.text && typeof record.text === 'object') return;
    for (const key of ['fields', 'elements', 'blocks']) if (record[key]) walk(record[key]);
  };
  walk(post.blocks);
  const body = parts.join('\n').trim();
  return body && body !== post.text.trim() ? `${post.text}\n${body}` : post.text;
}

const fence = (text: string): string => `\`\`\`\n${text.replace(/```/g, "'''").trimEnd()}\n\`\`\``;

describe.skipIf(!ENABLED || !KEY || !BASE_URL)('the agent bot with a real model, on a demo lab incident asked in a Slack channel', () => {
  it(
    'investigates, posts a change card, runs what an administrator approved in the thread, and answers',
    async () => {
      const scenario = scenarioById(SCENARIO);
      if (!scenario) throw new Error(`The demo lab has no scenario "${SCENARIO}".`);
      const envBefore = { ...process.env };
      delete process.env.SSHS3_PUBLIC_URL;
      delete process.env.SSHS3_MATTERMOST_ACTION_FROM;
      setDemoModeForTesting(false);
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-chat-real-model-'));
      setHeadlessUserDataPath(tmpDir);
      const world = startScenario(scenario);
      const slack: FakeSlack = await startFakeSlack();
      slack.channels.push({ id: CHANNEL.id, name: CHANNEL.name, members: ['agent', 'context'] });
      let server: Sshs3WebServer | undefined;
      const started = Date.now();
      const log: string[] = [];
      const note = (line: string): void => void log.push(`- ${new Date().toISOString().slice(11, 19)} ${line}`);
      let modelCalls = 0;
      let spent = 0;
      let stoppedBy: string | undefined;
      let root = '';
      let agent: HubService | undefined;
      let score: ScenarioScore | undefined;
      let answer = '';
      const clicked: string[] = [];
      let followedUp = false;

      try {
        const staticDir = path.join(tmpDir, 'static');
        await fs.mkdir(staticDir, { recursive: true });
        await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><html><body>sshs3 web</body></html>', 'utf-8');
        const api = new AgentBotApi({ guard: () => LOCAL });
        api.slackBase = slack.base;
        const transport = socketTransports({
          api,
          bots: { slack: () => server!.chatAnswering.bots.slack(), mattermost: () => server!.chatAnswering.bots.mattermost() },
          guard: () => LOCAL,
          connect: (url, o) => connectWs(url, { ...o, pingEveryMs: 0 }),
          backoff: { minMs: 20, maxMs: 200 },
        });
        server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, staticDir, chatAgent: { api, transport } });
        const baseUrl = `http://127.0.0.1:${(await server.start()).port}`;
        const post = async (urlPath: string, body: unknown, cookie?: string): Promise<{ body: any; cookie: string }> => {
          const res = await fetch(`${baseUrl}${urlPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
            body: JSON.stringify(body),
          });
          const json = await res.json().catch(() => ({}));
          if (res.status >= 400) throw new Error(json?.error || `HTTP ${res.status}`);
          return { body: json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
        };

        // Maria makes the server and sets up the model. Omar joins as a member: the server is a shared one.
        const admin = await post('/api/auth/setup', { username: 'maria', displayName: 'Maria Ek', password: 'maria-password-123' }); // pragma: allowlist secret
        const mariaUser = (await server.auth.listUsers()).find((u) => u.id === admin.body.user.id)!;
        const mariaTenant = await server.tenants.getOrCreateTenant(mariaUser);
        const maria = (request: ChatAnsweringRequest | HubRequest) => mariaTenant.hub.request(request as HubRequest);
        await maria({
          action: 'configure',
          config: { enabled: true, provider: 'openai-compatible', model: MODEL, baseUrl: BASE_URL!, apiKey: KEY! },
          preferences: { proposeMemories: false, autoSaveMemories: false, workforceAutopilot: false },
        } as HubRequest);
        const invite = (await post('/api/admin/invites', { role: 'member', maxUses: 1 }, admin.cookie)).body.invite.token as string;
        await post('/api/auth/register-invite', { inviteToken: invite, username: 'omar', displayName: 'Omar Lind', password: 'omar-password-123' }); // pragma: allowlist secret

        // The scenario's servers, shared with the team under their names.
        for (const s of scenario.servers)
          await mariaTenant.invokeFromClient(-1, 'profiles:save-ssh', { id: s.name, name: s.name, host: s.host, port: 22, username: s.username, authType: 'key', tags: [...(s.tags ?? [])], description: s.description, shared: true });

        await maria({ action: 'chat-answering-connect', input: { service: 'slack', token: slack.apps.agent.botToken, appToken: slack.apps.agent.appToken } });
        await slack.waitForSocket(1);
        await maria({
          action: 'chat-answering-save',
          input: {
            enabled: true,
            channels: { slack: [{ channelId: CHANNEL.id, channelName: CHANNEL.name, servers: scenario.servers.map((s) => s.name), clusters: [], reach: 'ask', approvers: 'linked', historyFrom: [] }] },
          },
        });
        await maria({ action: 'chat-answering-copy-model' });

        // The chat agent's terminals and files are the lab's servers.
        agent = (await server.tenants.getChatAgentTenant()).hub;
        const hub = agent;
        const host = hub.host as unknown as {
          openServerTerminal?: (profileId: string) => Promise<string>;
          closeSession?: (id: string) => void;
          sessionAlive?: (id: string) => boolean | undefined;
          file?: (...args: unknown[]) => Promise<unknown>;
          onModelRequest?: () => void;
        };
        const ptys = new Map<string, DemoVirtualPty>();
        const configOf = new Map<string, { id: string; name: string; host: string; username: string; port: number }>();
        let opened = 0;
        host.openServerTerminal = async (profileId) => {
          const s = scenario.servers.find((x) => x.name === profileId || x.id === profileId);
          if (!s) throw new Error(`The lab has no server "${profileId}".`);
          const id = `lab-terminal-${++opened}`;
          const config = { id: s.name, name: s.name, host: s.host, username: s.username, port: 22 };
          const pty = new DemoVirtualPty({ ...config, authType: 'agent' } as never, 100, 30);
          ptys.set(id, pty);
          configOf.set(id, config);
          hub.terminals.register({ id, label: s.name, kind: 'ssh', profileId: s.name }, (data) => pty.write(data));
          pty.onData((data) => hub.terminals.feed(id, data));
          await hub.terminals.armAtPrompt(id, 'bash');
          note(`Opened a terminal on ${s.name}.`);
          return id;
        };
        host.closeSession = (id) => {
          ptys.get(id)?.kill();
          ptys.delete(id);
        };
        host.sessionAlive = (id) => ptys.has(id);
        const files = new FileTools(
          {
            storageRegistry: new LabFiles(),
            fileEditorService: new FileEditorService({ baseTempDir: path.join(tmpDir, 'editor') }),
            sshPtyManager: { getSession: (id: string) => (configOf.has(id) ? { config: configOf.get(id) } : undefined) },
            smartcard: { prepareSftpSmartcardConfig: async (c: unknown) => c, prepareFido2SftpConfig: async (c: unknown) => c },
          } as unknown as IpcBridge,
          hub.terminals,
          () => {},
        );
        host.file = (...args: unknown[]) => (files.invoke as (...a: unknown[]) => Promise<unknown>)(...args);
        // At most MAX_MODEL_CALLS model calls: the loop below stops the run once this is reached. File reads,
        // context, memory and skills calls do not pass beforeAction, so they are held only by this cap.
        host.onModelRequest = () => {
          if (++modelCalls >= MAX_MODEL_CALLS) stoppedBy ??= `the limit of ${MAX_MODEL_CALLS} model calls`;
        };
        // At most MAX_COMMANDS actions: past that, every action is refused and the run told to stop.
        const deps = (hub.broker as unknown as { deps: { beforeAction?: (task: AgentTask) => void } }).deps;
        const before = deps.beforeAction;
        deps.beforeAction = (task) => {
          if (spent >= MAX_COMMANDS) {
            stoppedBy ??= `the limit of ${MAX_COMMANDS} commands`;
            throw new Error('This test run reached its command limit.');
          }
          spent++;
          before?.(task);
        };

        // Maria links her Slack account with a code from the app, in a direct message to the agent bot.
        const code = (await maria({ action: 'chat-link-code', service: 'slack' })).reply!.chatLinkCode!.code;
        slack.say('DMARIA', `link ${code}`, { user: 'U1MARIA', im: true });
        await vi.waitFor(() => expect(slack.posts.some((p) => p.channel === 'DMARIA' && p.text.startsWith('Linked.'))).toBe(true), { timeout: 10_000 });
        note('Maria linked her Slack account.');

        // Omar asks in the channel.
        const question = scenario.alert ? `${scenario.alert.summary}. What is wrong?` : `${scenario.prompt.split('.')[0]}. What is wrong?`;
        root = slack.say(CHANNEL.id, question, { user: 'U2OMAR' }).ts;
        note(`Omar asked in #${CHANNEL.name}: "${question}"`);

        const lastEdit = (ts: string): FakeSlackPost | undefined => slack.updates.filter((u) => u.ts === ts).at(-1);
        const inThread = (): FakeSlackPost[] => slack.posts.filter((p) => p.app === 'agent' && p.channel === CHANNEL.id && p.thread_ts === root);
        const task = (): AgentTask | undefined => hub.store.data.tasks.find((t) => t.chat?.threadId === root);
        const deadline = started + MAX_MINUTES * 60_000;
        let endedSince = 0;
        for (;;) {
          if (Date.now() > deadline) {
            stoppedBy ??= `the limit of ${MAX_MINUTES} minutes`;
            const t = task();
            if (t && !ENDED.has(t.status)) await hub.request({ action: 'stop', taskId: t.id } as HubRequest).catch(() => undefined);
            break;
          }
          // A card with buttons not pressed yet: Maria approves it.
          for (const p of inThread()) {
            if (clicked.includes(p.ts)) continue;
            const blocks = (lastEdit(p.ts)?.blocks ?? p.blocks ?? []) as Array<{ type: string; elements?: Array<{ value: string; action_id: string }> }>;
            const approve = blocks.find((b) => b.type === 'actions')?.elements?.find((e) => e.action_id === SLACK_APPROVE_ACTION);
            if (!approve) continue;
            clicked.push(p.ts);
            note(`A card was posted (${p.ts}). Maria pressed Approve.`);
            slack.click(CHANNEL.id, p.ts, { user: 'U1MARIA', value: approve.value, actionId: SLACK_APPROVE_ACTION, thread: root });
          }
          const t = task();
          if (t && (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0) > MAX_TOKENS) stoppedBy ??= `the limit of ${MAX_TOKENS} tokens`;
          if (stoppedBy && t && !ENDED.has(t.status)) await hub.request({ action: 'stop', taskId: t.id } as HubRequest).catch(() => undefined);
          if (t && ENDED.has(t.status)) {
            // Give the bot a moment to post the answer and the last status.
            endedSince ||= Date.now();
            if (Date.now() - endedSince > 4000) {
              const now = scoreScenario(scenario, { world });
              const solved = now.checks.filter((c) => c.kind !== 'report').every((c) => c.pass);
              if (followedUp || solved || stoppedBy || t.status !== 'completed') break;
              followedUp = true;
              endedSince = 0;
              slack.say(CHANNEL.id, FOLLOW_UP, { user: 'U1MARIA', thread: root });
              note(`The agent had reported and the incident still stood. Maria wrote in the thread: "${FOLLOW_UP}"`);
              // Until the bot took the reply: the conversation has it, or runs again. Not a fixed pause, which a
              // slow socket or outbox could outlast, so the loop would end before the second run started.
              await vi.waitFor(
                () => {
                  const now = task()!;
                  expect(now.messages.some((m) => m.role === 'user' && m.text.includes(FOLLOW_UP)) || !ENDED.has(now.status)).toBe(true);
                },
                { timeout: 30_000, interval: 250 },
              );
              continue;
            }
          } else endedSince = 0;
          await sleep(500);
        }
        await sleep(1500);
        const t = task();
        answer = [...(t?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.text.trim())?.text ?? '';
        score = scoreScenario(scenario, { world, report: answer });

        // What it shows: the conversation ran from chat, in the chat agent's hub, a card was answered there,
        // the approved change ran and solved the incident, and the answer was posted in the thread.
        expect(t?.chat).toMatchObject({ service: 'slack', channelId: CHANNEL.id, kind: 'channel', askedBy: { chatUserId: 'U2OMAR' } });
        expect(modelCalls).toBeGreaterThan(0);
        expect(stoppedBy).toBeUndefined();
        expect(t?.status).toBe('completed');
        expect(clicked.length).toBeGreaterThan(0);
        expect(t?.changes.some((c) => (c.approvals ?? []).some((a) => a.allowed && a.via === 'slack'))).toBe(true);
        expect(score!.checks.filter((c) => c.kind !== 'report').every((c) => c.pass)).toBe(true);
        // The thread shows the stored answer (as Slack's format writes it: marks and escapes aside).
        const plain = (text: string): string => text.replace(/&amp;|&lt;|&gt;|[*_`~[\]<>&]/g, '').replace(/\s+/g, ' ').trim();
        const posted = plain(inThread().map((p) => shown(lastEdit(p.ts) ?? p)).join('\n'));
        const firstLine = plain(answer.split('\n').find((line) => line.trim()) ?? '');
        expect(firstLine).not.toBe('');
        expect(posted).toContain(firstLine.slice(0, 40));
      } finally {
        const out = process.env.SSHS3_SIM_TRANSCRIPT || path.join(os.tmpdir(), `sshs3-chat-real-model-${Date.now()}.md`);
        await fs.mkdir(path.dirname(out), { recursive: true }).catch(() => undefined);
        await fs.writeFile(out, transcript(), 'utf-8').catch(() => undefined);
        console.log(`Transcript: ${out}`);
        if (server) await server.stop().catch(() => undefined);
        await slack.close();
        stopScenario();
        process.env = { ...envBefore };
        setDemoModeForTesting(undefined);
        await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
      }

      function transcript(): string {
        const t = agent?.store.data.tasks.find((x) => x.chat?.threadId === root);
        const lines: string[] = [];
        lines.push(`# The agent bot with a real model: ${scenario!.id}`, '');
        lines.push(`Model: ${MODEL} at ${BASE_URL}. Date: ${new Date(started).toISOString()}. Took ${Math.round((Date.now() - started) / 1000)} seconds.`, '');
        lines.push(
          'Real: the web server, the chat agent account and its hub, the agent bot code (sockets, outbox, cards, signed buttons), the model.',
          'Stand-ins: Slack is the test stand-in on this machine (tests/helpers/fakeSlack.ts). The server is a simulated server of the demo lab, with state: its terminal and its files are the lab, not SSH.',
          `Caps of this test: ${MAX_COMMANDS} commands, ${MAX_MODEL_CALLS} model calls, ${MAX_TOKENS} tokens, ${MAX_MINUTES} minutes.${stoppedBy ? ` Stopped by ${stoppedBy}.` : ''}`,
          '',
        );
        lines.push('## What happened', '', ...log, '');
        lines.push(`## The thread in #${CHANNEL.name}`, '');
        // People's messages: the stand-in keeps the bot's own posts in the history too, and they are listed below.
        const history = (slack.history[CHANNEL.id] ?? []).filter((m) => m.user && !m.bot_id && (m.ts === root || m.thread_ts === root));
        const posts = slack.posts.filter((p) => p.channel === CHANNEL.id && p.app === 'agent' && p.thread_ts === root);
        const all = [
          ...history.map((m) => ({ ts: m.ts, who: slack.users[m.user ?? ''] ?? m.user ?? 'someone', text: m.text, edited: '' })),
          ...posts.map((p) => {
            const last = slack.updates.filter((u) => u.ts === p.ts).at(-1);
            return { ts: p.ts, who: 'agent bot', text: shown(p), edited: last ? shown(last) : '' };
          }),
        ].sort((a, b) => Number(a.ts) - Number(b.ts));
        for (const m of all) {
          lines.push(`### ${m.who} (${m.ts})`, '', fence(m.text), '');
          if (m.edited && m.edited !== m.text) lines.push('Last edited to:', '', fence(m.edited), '');
        }
        const notes = slack.ephemerals.filter((e) => e.channel === CHANNEL.id);
        if (notes.length) {
          lines.push('### Notes only one person saw', '');
          for (const e of notes) lines.push(`- to ${slack.users[e.user] ?? e.user}: ${e.text.replace(/\n/g, ' ')}`);
          lines.push('');
        }
        lines.push('## Commands and changes the agent made', '');
        for (const c of t?.changes ?? []) {
          const approvals = (c.approvals ?? []).filter((a) => a.allowed).map((a) => `${a.actor}${a.via ? ` in ${a.via}` : ''}`);
          lines.push(
            `### ${c.ref ?? c.id} ${c.kind} on ${c.target}: ${c.status}${c.exitCode !== undefined ? `, exit ${c.exitCode}` : ''}${approvals.length ? `, approved by ${approvals.join(' and ')}` : ''}`,
            '',
            c.description,
            '',
            fence(c.command ?? c.description),
            '',
          );
          if (c.output?.trim()) lines.push('Output:', '', fence(c.output.length > 1500 ? `${c.output.slice(0, 1500)}\n[cut]` : c.output), '');
        }
        lines.push('## Lines run on the lab servers', '');
        for (const s of scenario!.servers) {
          const h = world.host(s.name);
          if (!h) continue;
          lines.push(`${s.name}:`, '', fence(world.ran(h).map((r) => `[exit ${r.code}${r.root ? ', as root' : ''}] ${r.line}`).join('\n') || '(nothing)'), '');
        }
        const usage = t?.usage;
        lines.push('## Model calls and tokens', '');
        lines.push(`- Model calls of the conversation (each HTTP request the run made, retries counted): ${modelCalls}`);
        if (usage) {
          lines.push(`- Input tokens: ${usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)} (of which cached: ${usage.cacheReadTokens ?? 0})`);
          lines.push(`- Output tokens: ${usage.outputTokens}`);
          if (usage.costUsd !== undefined) lines.push(`- Cost as the app counts it: $${usage.costUsd.toFixed(4)}`);
        }
        if (t?.chatBackgroundTokens) lines.push(`- Background runs of the conversation: ${t.chatBackgroundTokens} tokens`);
        lines.push(`- Commands counted against the cap: ${spent}`);
        lines.push('');
        lines.push('## The scenario checks', '');
        if (score) {
          for (const c of score.checks) lines.push(`- ${c.pass ? 'PASS' : 'FAIL'} ${c.title}: ${c.why}`);
          lines.push(`- ${score.passed} of ${score.total} pass.`);
          if (score.unsupported.length) lines.push(`- Asked for and not simulated: ${score.unsupported.map((u) => `\`${u}\``).join(', ')}`);
        } else lines.push('The run did not get as far as the checks.');
        lines.push('', '## The answer as stored in the hub', '', answer ? fence(answer) : '(none)', '');
        return lines.join('\n');
      }
    },
    (MAX_MINUTES + 3) * 60_000,
  );
});
