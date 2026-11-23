import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import type { ChatTransportFactory } from '../../src/main/web/chatAgent/ChatAgentService';
import { READ_ONLY_ACTIONS } from '../../src/main/ai/hub/hubShared';
import { chatPrompt } from '../../src/main/ai/hub/chatFence';
import { encryptSecretValue } from '../../src/main/crypto/SecretFieldCrypto';
import type { AgentTask, ChatAnsweringRequest, HubRequest, HubSnapshot } from '../../src/shared/types/aiHub';
import type { HubService } from '../../src/main/ai/hub/HubService';
import { startFakeSlack, type FakeSlack } from '../helpers/fakeSlack';
import { startFakeMattermost } from '../helpers/fakeMattermost';

/**
 * The agent bot's requests through the real web server: who may set it up (an administrator), who may
 * link (anybody, their own), what only reads, that no token ever reaches a snapshot, and the route
 * Mattermost posts a button press to, with its limits.
 */
describe('the agent bot in chat, asked through the web server', () => {
  let tmpDir: string;
  let server: Sshs3WebServer;
  let baseUrl: string;
  let slack: FakeSlack;
  let lines: string[];
  const envBefore = { ...process.env };

  const LOCAL = { server: false, allowPrivate: true };

  async function startServer(): Promise<void> {
    const staticDir = path.join(tmpDir, 'static');
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><html><body>sshs3 web</body></html>', 'utf-8');
    const api = new AgentBotApi({ guard: () => LOCAL });
    api.slackBase = slack.base;
    // Lines are not opened in these tests: only which services the server would open one for.
    const transport: ChatTransportFactory = (service) => ({
      start: () => void lines.push(`start:${service}`),
      stop: async () => void lines.push(`stop:${service}`),
    });
    server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, staticDir, chatAgent: { api, transport, tryWaitMs: 3000 } });
    const info = await server.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-chat-answering-'));
    setHeadlessUserDataPath(tmpDir);
    slack = await startFakeSlack();
    lines = [];
    await startServer();
  });

  afterEach(async () => {
    process.env = { ...envBefore };
    if (server) await server.stop();
    await slack.close();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function send(method: string, urlPath: string, body?: unknown, cookie?: string, raw?: string): Promise<{ status: number; body: any; cookie: string }> {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  }

  async function post(urlPath: string, body: unknown, cookie?: string): Promise<{ body: any; cookie: string }> {
    const res = await send('POST', urlPath, body, cookie);
    if (res.status >= 400) throw new Error(res.body?.error || `HTTP ${res.status}`);
    return res;
  }

  interface Person {
    id: string;
    hub: HubService;
    ask: (request: ChatAnsweringRequest | HubRequest) => Promise<HubSnapshot>;
  }

  async function person(id: string): Promise<Person> {
    const user = (await server.auth.listUsers()).find((u) => u.id === id)!;
    const hub = (await server.tenants.getOrCreateTenant(user)).hub;
    return { id, hub, ask: (request) => hub.request(request as HubRequest) };
  }

  /** Maria, the administrator; with `withOmar`, Omar, a member, too. */
  async function team(withOmar = true): Promise<{ maria: Person; omar?: Person; mariaCookie: string }> {
    const admin = await post('/api/auth/setup', { username: 'maria', displayName: 'Maria Ek', password: 'maria-password-123' }); // pragma: allowlist secret
    const maria = await person(admin.body.user.id);
    let omar: Person | undefined;
    if (withOmar) {
      const invite = await post('/api/admin/invites', { role: 'member', maxUses: 1 }, admin.cookie);
      const made = await post('/api/auth/register-invite', { inviteToken: invite.body.invite.token, username: 'omar', displayName: 'Omar Lind', password: 'omar-password-123' }); // pragma: allowlist secret
      omar = await person(made.body.user.id);
    }
    return { maria, omar, mariaCookie: admin.cookie };
  }

  const AGENT = () => ({ service: 'slack' as const, token: slack.apps.agent.botToken, appToken: slack.apps.agent.appToken });

  it('lets only an administrator set the bot up, and lets anybody link their own chat account', async () => {
    const { maria, omar } = await team();
    const refusedForMember: ChatAnsweringRequest[] = [
      { action: 'chat-answering-save', input: { enabled: true } },
      { action: 'chat-answering-connect', input: AGENT() },
      { action: 'chat-answering-disconnect', service: 'slack' },
      { action: 'chat-answering-rotate-key' },
      { action: 'chat-answering-copy-model' },
      { action: 'chat-answering-runs' },
      { action: 'chat-answering-task', taskId: 'x' },
      { action: 'chat-answering-try', channel: 'COPS', as: 'guest', text: 'hello' },
    ];
    for (const request of refusedForMember)
      await expect(omar!.ask(request), request.action).rejects.toThrow('Only an administrator of this server can set up the agent bot.');
    // Nothing was changed by the refused requests.
    expect(server.chatAnswering.bots.view()).toEqual([]);
    expect(server.chatAnswering.answering.settings().enabled).toBe(false);
    expect(slack.calls).toEqual([]);

    // A member's snapshot says whether the bot answers and shows their own links, and nothing of the setup.
    const plain = await omar!.ask({ action: 'snapshot' });
    expect(plain.chatAnswering).toEqual({ enabled: false, services: [], links: [], waiting: [] });
    // A code to link, shown once; sent to the bot it links Omar's chat account to his own account.
    const coded = await omar!.ask({ action: 'chat-link-code', service: 'slack' });
    const code = coded.reply?.chatLinkCode;
    expect(code).toMatchObject({ service: 'slack', code: expect.stringMatching(/^[A-Z2-7]{4}-?[A-Z2-7]{4}$/) });
    expect((await server.chatAgent.redeem('slack', 'U2OMAR', 'Omar', code!.code)).ok).toBe(true);
    expect((await omar!.ask({ action: 'snapshot' })).chatAnswering?.links).toEqual([{ service: 'slack', chatName: 'Omar', linkedAt: expect.any(Number) }]);
    // An administrator sees who is linked, by name.
    const admin = (await maria.ask({ action: 'snapshot' })).chatAnswering?.admin;
    expect(admin?.linked).toEqual([expect.objectContaining({ service: 'slack', chatUserId: 'U2OMAR', accountId: omar!.id, accountName: 'Omar Lind' })]);
    expect(admin?.canTry).toBe(true);
    expect(admin?.mattermostAnswers).toBe('reactions');

    // A member ends only their own link; an administrator may end anybody's.
    await expect(omar!.ask({ action: 'chat-unlink', service: 'slack', chatUserId: 'U1MARIA' })).rejects.toThrow('Only an administrator');
    await omar!.ask({ action: 'chat-unlink', service: 'slack' });
    expect(server.chatAgent.allLinks()).toEqual([]);
    await expect(omar!.ask({ action: 'chat-unlink', service: 'slack' })).rejects.toThrow('Your Slack account is not linked.');
    const again = (await omar!.ask({ action: 'chat-link-code', service: 'slack' })).reply!.chatLinkCode!;
    expect((await server.chatAgent.redeem('slack', 'U2OMAR', 'Omar', again.code)).ok).toBe(true);
    await maria.ask({ action: 'chat-unlink', service: 'slack', chatUserId: 'U2OMAR' });
    expect(server.chatAgent.allLinks()).toEqual([]);
    const audit = await fs.readFile(path.join(tmpDir, 'audit', 'server.jsonl'), 'utf8').catch(async () => {
      const files = await fs.readdir(path.join(tmpDir, 'audit'));
      return (await Promise.all(files.map((f) => fs.readFile(path.join(tmpDir, 'audit', f), 'utf8').catch(() => '')))).join('\n');
    });
    expect(audit).toContain('unlinked the Slack account Omar');
  }, 30_000);

  it('tries the connection before it is saved, refuses the context bot\'s token, and never shows a token', async () => {
    // The context bot reads with its own Slack app (saved before anybody's hub reads its file).
    await fs.mkdir(path.join(tmpDir, 'team-chat'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'team-chat', 'connections.json'),
      JSON.stringify({ connections: [{ service: 'slack', token: encryptSecretValue(slack.apps.context.botToken), enabled: false }] }),
    );
    const { maria } = await team(false);
    await expect(
      maria.ask({ action: 'chat-answering-connect', input: { service: 'slack', token: slack.apps.context.botToken, appToken: slack.apps.context.appToken } }),
    ).rejects.toThrow("That is the context bot's token.");
    // A token Slack does not take is not saved.
    await expect(maria.ask({ action: 'chat-answering-connect', input: { service: 'slack', token: 'xoxb-not-a-real-one', appToken: 'xapp-1-nope' } })).rejects.toThrow(
      'Slack did not take the bot token',
    );
    // A token of the wrong kind is refused before anything is asked.
    const before = slack.calls.length;
    await expect(maria.ask({ action: 'chat-answering-connect', input: { service: 'slack', token: 'xoxp-a-person', appToken: 'xapp-1-x' } })).rejects.toThrow('starts with xoxb-');
    expect(slack.calls.length).toBe(before);
    expect(server.chatAnswering.bots.view()).toEqual([]);
    expect(lines).toEqual([]);

    const done = await maria.ask({ action: 'chat-answering-connect', input: AGENT() });
    expect(done.reply?.chatAgentConnect).toEqual({ service: 'slack', bot: 'agent-bot', team: 'Acme', notes: [] });
    expect(slack.calls.map((c) => `${c.app}:${c.method}`)).toEqual(expect.arrayContaining(['agent:auth.test', 'agent:apps.connections.open']));
    // The line to Slack is opened at once.
    expect(lines).toEqual(['start:slack']);
    const snapshot = await maria.ask({ action: 'snapshot' });
    const admin = snapshot.chatAnswering?.admin;
    expect(admin?.bots).toEqual([expect.objectContaining({ service: 'slack', enabled: true, hasToken: true, hasAppToken: true, identity: expect.objectContaining({ userId: 'UAGENT' }) })]);
    // The chat agent's key was made when the bot was connected, for the administrator to put on servers.
    expect(admin?.publicKey).toMatch(/^ssh-ed25519 \S+ svc:chat-agent@sshs3-web$/);
    // No token anywhere in what a window is sent, nor in the file in plain text.
    const shown = JSON.stringify(snapshot);
    for (const secret of [slack.apps.agent.botToken, slack.apps.agent.appToken, slack.apps.context.botToken]) expect(shown).not.toContain(secret);
    const kept = await fs.readFile(path.join(tmpDir, 'chat-agent', 'connections.json'), 'utf8');
    expect(kept).not.toContain(slack.apps.agent.botToken);
    // With a bot connected, "try it" is for the demo only.
    expect(admin?.canTry).toBe(false);
    await expect(maria.ask({ action: 'chat-answering-try', channel: 'COPS', as: 'guest', text: 'hello' })).rejects.toThrow('"Try it" is for the demo');

    const rotated = await maria.ask({ action: 'chat-answering-rotate-key' });
    expect(rotated.reply?.chatAgentKey?.publicKey).toMatch(/^ssh-ed25519 /);
    expect(rotated.reply?.chatAgentKey?.publicKey).not.toBe(admin?.publicKey);

    await maria.ask({ action: 'chat-answering-disconnect', service: 'slack' });
    expect(lines).toEqual(['start:slack', 'stop:slack']);
    expect(server.chatAnswering.bots.view()).toEqual([]);
  }, 30_000);

  it('connects a Mattermost bot account, and says cards are answered with reactions without a public address', async () => {
    const mm = await startFakeMattermost();
    try {
      const { maria } = await team(false);
      await expect(maria.ask({ action: 'chat-answering-connect', input: { service: 'mattermost', baseUrl: mm.base, token: 'wrongtoken12345' } })).rejects.toThrow(
        'Mattermost did not take the token',
      );
      const done = await maria.ask({ action: 'chat-answering-connect', input: { service: 'mattermost', baseUrl: mm.base, token: mm.bots.agent.token } });
      expect(done.reply?.chatAgentConnect).toMatchObject({ service: 'mattermost', notes: [expect.stringContaining('answered with reactions')] });
      expect(lines).toEqual(['start:mattermost']);
      const shown = JSON.stringify((await maria.ask({ action: 'snapshot' })).chatAnswering);
      expect(shown).toContain(mm.base);
      expect(shown).not.toContain(mm.bots.agent.token);
    } finally {
      await mm.close();
    }
  }, 30_000);

  it('turns answering on only where the chat agent\'s data policy lets answers go', async () => {
    const { maria } = await team(false);
    await maria.ask({ action: 'chat-answering-connect', input: AGENT() });
    const agentDir = path.join(tmpDir, 'service', 'chat-agent');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'ai-config.json'), JSON.stringify({ egressPolicy: 'local-only' }));
    await expect(maria.ask({ action: 'chat-answering-save', input: { enabled: true } })).rejects.toThrow(
      'Answering in chat stays off. Slack: You chose to send nothing outside your own network.',
    );
    expect(server.chatAnswering.answering.settings().enabled).toBe(false);
    expect((await maria.ask({ action: 'snapshot' })).chatAnswering?.admin?.dataPolicy).toEqual([
      expect.objectContaining({ service: 'slack', allowed: false }),
    ]);

    await fs.writeFile(path.join(agentDir, 'ai-config.json'), JSON.stringify({ egressPolicy: 'standard' }));
    await maria.ask({
      action: 'chat-answering-save',
      input: {
        enabled: true,
        approvalWaitMinutes: 15,
        channels: { slack: [{ channelId: 'COPS', channelName: 'ops', servers: ['web-dev-01'], clusters: [], reach: 'ask', approvers: 'admins', historyFrom: [] }] },
      },
    });
    const view = (await maria.ask({ action: 'snapshot' })).chatAnswering;
    expect(view?.enabled).toBe(true);
    expect(view?.services).toEqual(['slack']);
    expect(view?.admin?.settings).toMatchObject({ enabled: true, approvalWaitMinutes: 15, changedBy: 'Maria Ek' });
    expect(view?.admin?.settings.channels.slack[0]).toMatchObject({ channelId: 'COPS', approvers: 'admins' });
    // The wait the administrator chose is the chat agent's.
    await maria.ask({ action: 'chat-answering-runs' });
    const agent = await server.tenants.getChatAgentTenant();
    expect(agent.hub.store.data.preferences.approvalWaitMinutes).toBe(15);
    await maria.ask({ action: 'chat-answering-save', input: { approvalWaitMinutes: 30 } });
    expect(agent.hub.store.data.preferences.approvalWaitMinutes).toBe(30);
  }, 30_000);

  it('says whether the chat agent has a model, and offers only its own agents for a channel', async () => {
    const { maria } = await team(false);
    const agentDir = path.join(tmpDir, 'service', 'chat-agent');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'ai-config.json'), JSON.stringify({ egressPolicy: 'standard' }));
    let admin = (await maria.ask({ action: 'snapshot' })).chatAnswering?.admin;
    expect(admin?.model).toEqual({ set: false });
    await fs.writeFile(
      path.join(agentDir, 'ai-config.json'),
      JSON.stringify({ enabled: true, provider: 'openai-compatible', model: 'team-model-1', baseUrl: 'https://model.example.com/v1' }),
    );
    admin = (await maria.ask({ action: 'snapshot' })).chatAnswering?.admin;
    expect(admin?.model).toEqual({ set: true, name: 'team-model-1' });

    // The agents offered are the chat agent's own, not Maria's: an agent she made is not there.
    (maria.hub.store.data.agents ??= []).push({ id: 'marias-own', name: 'Maria own agent', role: 'r', mission: 'm', systemPrompt: 's', defaultMode: 'assisted', updatedAt: 1 } as never);
    const offered = admin?.agents ?? [];
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.some((a) => a.id === 'marias-own')).toBe(false);
    expect(offered.every((a) => !('runnerId' in a))).toBe(true);
    const row = { channelId: 'COPS', channelName: 'ops', servers: ['web-dev-01'], clusters: [], reach: 'ask' as const, approvers: 'linked' as const, historyFrom: [] };
    await expect(maria.ask({ action: 'chat-answering-save', input: { channels: { slack: [{ ...row, agentId: 'marias-own' }] } } })).rejects.toThrow(
      'For #ops, that agent is not one the chat agent has.',
    );
    expect(server.chatAnswering.answering.settings().channels.slack).toEqual([]);
    await maria.ask({ action: 'chat-answering-save', input: { channels: { slack: [{ ...row, agentId: offered[0].id }] } } });
    expect(server.chatAnswering.answering.settings().channels.slack[0]?.agentId).toBe(offered[0].id);
  }, 30_000);

  it('lists the chat agent\'s conversations for an administrator, and reads one without writing', async () => {
    const { maria } = await team(false);
    expect(READ_ONLY_ACTIONS.has('chat-answering-task')).toBe(true);
    expect(READ_ONLY_ACTIONS.has('chat-answering-runs')).toBe(true);
    const agent = await server.tenants.getChatAgentTenant();
    const chat = {
      service: 'slack' as const,
      channelId: 'COPS',
      channelName: 'ops',
      threadId: '1700000000.000100',
      kind: 'channel' as const,
      askedBy: { chatUserId: 'U2OMAR', name: 'Omar Lind' },
      fence: { servers: ['web-dev-01'], clusters: [], reach: 'read' as const },
    };
    agent.hub.store.data.tasks.push({
      id: 'chat-run-1',
      title: 'Disk on web-dev-01',
      mode: 'assisted',
      status: 'completed',
      // Stored as the hub starts it: the preface for the agent, then what the person wrote.
      messages: [{ id: 'u1', role: 'user', text: chatPrompt(chat, 'How full is the disk on web-dev-01?'), at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
      maxCommands: 0,
      maxMinutes: 0,
      verification: 'not-verified',
      chat,
    } as unknown as AgentTask);
    const listed = await maria.ask({ action: 'chat-answering-runs' });
    expect(listed.reply?.chatRuns).toEqual([
      expect.objectContaining({ taskId: 'chat-run-1', channelName: 'ops', askedBy: 'Omar Lind', reach: 'read', waiting: 0, status: 'completed' }),
    ]);
    const save = vi.spyOn(maria.hub.store, 'save');
    const read = await maria.ask({ action: 'chat-answering-task', taskId: 'chat-run-1' });
    expect(read.reply?.chatTask).toMatchObject({ taskId: 'chat-run-1', chat: { channelName: 'ops' }, messages: [expect.objectContaining({ text: 'How full is the disk on web-dev-01?' })] });
    // What the agent was told is apart from the question, for the page to fold away.
    expect(read.reply?.chatTask?.messages[0]?.told).toContain('Omar Lind asked you in #ops on Slack.');
    expect(read.reply?.chatTask?.messages[0]?.told).not.toContain('How full is the disk');
    // The conversation as stored keeps the whole message the agent was given.
    expect(agent.hub.store.data.tasks.find((t) => t.id === 'chat-run-1')?.messages[0]?.text).toContain('Omar Lind asked you');
    expect(save).not.toHaveBeenCalled();
    await expect(maria.ask({ action: 'chat-answering-task', taskId: 'nope' })).rejects.toThrow("not one of the chat agent's");
  }, 30_000);

  it('answers a change of the chat agent\'s in the app by the same rules as from chat', async () => {
    const { maria, omar } = await team();
    const tenant = await server.tenants.getOrCreateTenant((await server.auth.listUsers()).find((u) => u.id === maria.id)!);
    await tenant.invokeFromClient(-1, 'profiles:save-ssh', { id: 'web-prod-01', name: 'web-prod-01', host: '10.30.70.21', port: 22, username: 'ops', authType: 'key', tags: ['prod'], shared: true });
    const hub = (await server.tenants.getChatAgentTenant()).hub;
    await hub.request({ action: 'snapshot' });
    const ran: string[] = [];
    hub.terminals.register({ id: 'term-1', label: 'web-prod-01', kind: 'ssh', profileId: 'web-prod-01' }, (data) => {
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (!nonce) return;
      ran.push(data);
      queueMicrotask(() => hub.terminals.feed('term-1', `\x1b]777;SSHS3;${nonce};BEGIN\x07done\r\n\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`));
    });
    hub.terminals.feed('term-1', 'ops@web-prod-01:~$ ');
    await hub.terminals.ensureReady('term-1', 'bash');
    const session = hub.terminals.get('term-1')!;
    const task = {
      id: 'chat-run-1',
      title: 'Restart nginx',
      mode: 'assisted',
      status: 'running',
      messages: [{ id: 'u1', role: 'user', text: 'Restart nginx on web-prod-01', at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 0,
      maxMinutes: 0,
      verification: 'not-verified',
      target: { sessionId: 'term-1', generation: session.generation, label: 'web-prod-01' },
      chat: {
        service: 'slack',
        channelId: 'COPS',
        channelName: 'ops',
        threadId: '1700000000.000100',
        kind: 'channel',
        askedBy: { chatUserId: 'U2OMAR', name: 'Omar Lind' },
        fence: { servers: ['web-prod-01'], clusters: [], reach: 'ask' },
      },
    } as unknown as AgentTask;
    hub.store.data.tasks.push(task);
    hub.terminals.claim('term-1', session.generation, task.id);
    const capability = await hub.broker.issue(task);
    ran.length = 0;
    let outcome: { exitCode: number } | undefined;
    // A change card: what a person is asked about. The terminal prints "done" for everything.
    void (hub.broker.invoke(capability.key, { action: 'change', command: 'sudo systemctl restart nginx', description: 'Restart the web server', check: { command: 'systemctl is-active nginx', expected: 'done' }, rollback: 'sudo systemctl stop nginx' }) as Promise<{ exitCode: number }>).then(
      (r) => (outcome = r),
      () => undefined,
    );
    const until = async <T,>(read: () => T | undefined, what: string): Promise<T> => {
      const end = Date.now() + 4000;
      for (;;) {
        const found = read();
        if (found !== undefined) return found;
        if (Date.now() > end) throw new Error(`Never happened: ${what}`);
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    const change = await until(() => task.changes.find((c) => c.status === 'pending'), 'the change waits');

    // A member may not answer a change to production: it is not in his list, and his answer is refused.
    expect((await omar!.ask({ action: 'snapshot' })).chatAnswering?.waiting).toEqual([]);
    const no = await omar!.ask({ action: 'chat-answering-answer', taskId: 'chat-run-1', id: change.id, kind: 'change', approved: true });
    expect(no.reply?.chatAnswer).toMatchObject({ outcome: 'refused', message: expect.stringContaining('On production') });
    expect(ran).toEqual([]);
    // The administrator sees it waiting for her, and answers it in the app: it runs.
    const waiting = (await maria.ask({ action: 'snapshot' })).chatAnswering?.waiting;
    expect(waiting).toEqual([
      expect.objectContaining({ taskId: 'chat-run-1', id: change.id, kind: 'change', channelName: 'ops', askedBy: 'Omar Lind', command: 'sudo systemctl restart nginx', requiredApprovals: 1 }),
    ]);
    const yes = await maria.ask({ action: 'chat-answering-answer', taskId: 'chat-run-1', id: change.id, kind: 'change', approved: true });
    expect(yes.reply?.chatAnswer).toEqual({ outcome: 'approved', message: 'Maria Ek approved.' });
    await until(() => outcome, 'the command runs');
    // The check before, the change once, the check after.
    expect(ran).toHaveLength(3);
    // Given in the app: the record says who, and no chat service.
    expect(change.approvals).toEqual([expect.objectContaining({ actor: 'Maria Ek', actorId: `user:${maria.id}`, allowed: true })]);
    expect(change.approvals?.[0]?.via).toBeUndefined();
  }, 30_000);

  it('lets an administrator try the bot in a simulated chat before one is connected', async () => {
    const { maria } = await team(false);
    await maria.ask({
      action: 'chat-answering-save',
      input: { enabled: true, channels: { slack: [{ channelId: 'COPS', channelName: 'ops', servers: '*', clusters: [], reach: 'read', approvers: 'linked', historyFrom: [] }] } },
    });
    // A channel that was not chosen gets the short reply, and nothing runs.
    const tried = await maria.ask({ action: 'chat-answering-try', channel: 'CQUIET', as: 'guest', text: 'How full is the disk?' });
    expect(tried.reply?.chatTry).toMatchObject({ channelId: 'CQUIET', settled: true });
    expect(tried.reply?.chatTry?.posts.map((p) => p.text)).toEqual(['I do not answer in this channel yet. An administrator can turn it on in sshs3.']);
    // "help" in a direct message, as the administrator, linked in the tried chat only.
    const dm = await maria.ask({ action: 'chat-answering-try', channel: 'dm', as: 'me', text: 'help' });
    expect(dm.reply?.chatTry?.thread).toBe('dm');
    expect(dm.reply?.chatTry?.posts[0]?.text).toContain('link, unlink, help');
    expect(server.chatAgent.allLinks()).toEqual([]);
    // Nothing went to a real chat.
    expect(slack.calls).toEqual([]);
    await expect(maria.ask({ action: 'chat-answering-try', channel: 'not a channel!', as: 'guest', text: 'x' })).rejects.toThrow('Choose a channel');
    // A message is all that can be tried: a request that names a card to press or react to, and has no text, does nothing.
    const posted = dm.reply!.chatTry!.posts[0].id;
    const press = { action: 'chat-answering-try', channel: 'COPS', as: 'me', text: '', interaction: { kind: 'react', postId: posted, emoji: ':not-checked:' } };
    await expect(maria.ask(press as never)).rejects.toThrow('Write something for the agent bot.');
  }, 30_000);

  it('forgets the links of an account that is removed', async () => {
    const { maria, omar, mariaCookie } = await team();
    const code = (await omar!.ask({ action: 'chat-link-code', service: 'slack' })).reply!.chatLinkCode!;
    expect((await server.chatAgent.redeem('slack', 'U2OMAR', 'Omar', code.code)).ok).toBe(true);
    expect((await send('DELETE', `/api/admin/users/${omar!.id}`, undefined, mariaCookie)).status).toBe(200);
    expect(server.chatAgent.allLinks()).toEqual([]);
    expect((await maria.ask({ action: 'snapshot' })).chatAnswering?.admin?.linked).toEqual([]);
  }, 30_000);

  describe('the route Mattermost posts a button press to', () => {
    const press = { user_id: 'umariaxxxxxxxxxxxxxxxxxxxx', channel_id: 'chopsxxxxxxxxxxxxxxxxxxxxx', post_id: 'postxxxxxxxxxxxxxxxxxxxxxx', context: { t: 'not-a-token' } };
    // The address Mattermost's server posts from: without it, no press is taken at all.
    beforeEach(() => {
      process.env.SSHS3_MATTERMOST_ACTION_FROM = '127.0.0.1';
    });

    it('takes only a POST of JSON of at most 32 kB, without a session, and answers what the person alone sees', async () => {
      expect((await send('GET', '/api/chat/mattermost/action')).status).toBe(405);
      expect((await send('POST', '/api/chat/mattermost/action', undefined, undefined, '{not json')).status).toBe(400);
      expect((await send('POST', '/api/chat/mattermost/action', undefined, undefined, JSON.stringify({ ...press, pad: 'x'.repeat(40_000) }))).status).toBe(413);
      expect((await send('POST', '/api/chat/mattermost/action', { user_id: 'u' })).status).toBe(400);
      const answered = await send('POST', '/api/chat/mattermost/action', press);
      expect(answered.status).toBe(200);
      expect(answered.body).toEqual({ ephemeral_text: expect.any(String) });
      expect(answered.body.ephemeral_text.length).toBeGreaterThan(0);
      expect(answered.body).not.toHaveProperty('update');
    });

    it('takes at most 60 presses a minute from one address', async () => {
      for (let i = 0; i < 60; i++) expect((await send('POST', '/api/chat/mattermost/action', press)).status).toBe(200);
      const over = await send('POST', '/api/chat/mattermost/action', press);
      expect(over.status).toBe(429);
    });

    it('takes presses only from the addresses an administrator listed, and none without a list', async () => {
      delete process.env.SSHS3_MATTERMOST_ACTION_FROM;
      const off = await send('POST', '/api/chat/mattermost/action', press);
      expect(off.status).toBe(403);
      expect(off.body.error).toContain('Buttons are off');
      process.env.SSHS3_MATTERMOST_ACTION_FROM = '10.0.0.5, 10.0.0.6';
      expect((await send('POST', '/api/chat/mattermost/action', press)).status).toBe(403);
      process.env.SSHS3_MATTERMOST_ACTION_FROM = '10.0.0.5,127.0.0.1';
      expect((await send('POST', '/api/chat/mattermost/action', press)).status).toBe(200);
    });
  });
});
