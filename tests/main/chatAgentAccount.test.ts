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
import { CHAT_AGENT_ID } from '../../src/main/web/WebTenantManager';
import type { AgentChange, AgentPlan, AgentTask, ChatFence, ChatOrigin } from '../../src/shared/types/aiHub';
import type { HubService } from '../../src/main/ai/hub/HubService';

/**
 * The chat agent: the account the server keeps for itself, that a conversation asked for in a chat
 * channel runs in. It is nobody: nobody signs in as it, it is not in the administrator's list, it is not
 * somebody who is here, and it is never one of the two people a change needs. Its changes are answered
 * by people who linked their chat account, by the same rules as a second person in the app.
 */
describe('the chat agent account on a web server', () => {
  let tmpDir: string;
  let server: Sshs3WebServer;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-chat-agent-'));
    setHeadlessUserDataPath(tmpDir);
    const staticDir = path.join(tmpDir, 'static');
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><html><body>sshs3 web</body></html>', 'utf-8');
    server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, staticDir });
    const info = await server.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
  });

  afterEach(async () => {
    if (server) await server.stop();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function send(method: string, urlPath: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie: string }> {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    cookie: string;
    hub: HubService;
  }

  /** Maria (administrator) and Omar (member); with `more`, Eva (administrator) and Lina (member) too. */
  async function team(more = false) {
    const admin = await post('/api/auth/setup', { username: 'maria', displayName: 'Maria Ek', password: 'maria-password-123' }); // pragma: allowlist secret
    const invite = (role: string) => post('/api/admin/invites', { role, maxUses: 1 }, admin.cookie).then((r) => r.body.invite.token as string);
    const join = async (role: string, username: string, displayName: string): Promise<{ id: string; cookie: string }> => {
      const made = await post('/api/auth/register-invite', { inviteToken: await invite(role), username, displayName, password: `${username}-password-123` });
      return { id: made.body.user.id, cookie: made.cookie };
    };
    const person = async (who: { id: string; cookie: string }): Promise<Person> => {
      const user = (await server.auth.listUsers()).find((u) => u.id === who.id)!;
      return { ...who, hub: (await server.tenants.getOrCreateTenant(user)).hub };
    };
    const maria = await person({ id: admin.body.user.id, cookie: admin.cookie });
    const omar = await person(await join('member', 'omar', 'Omar Lind'));
    const eva = more ? await person(await join('admin', 'eva', 'Eva Holm')) : undefined;
    const lina = more ? await person(await join('member', 'lina', 'Lina Berg')) : undefined;
    // A production server and a test server the team shares.
    await maria.hub.request({ action: 'snapshot' });
    const tenant = await server.tenants.getOrCreateTenant((await server.auth.listUsers()).find((u) => u.id === maria.id)!);
    await tenant.invokeFromClient(-1, 'profiles:save-ssh', { id: 'web-prod-01', name: 'web-prod-01', host: '10.30.70.21', port: 22, username: 'ops', authType: 'key', tags: ['prod'], shared: true });
    await tenant.invokeFromClient(-1, 'profiles:save-ssh', { id: 'web-dev-01', name: 'web-dev-01', host: '10.30.70.31', port: 22, username: 'ops', authType: 'key', tags: ['dev'], shared: true });
    return { maria, omar, eva, lina };
  }

  const origin = (servers: string[], fence: Partial<ChatFence> = {}): ChatOrigin => ({
    service: 'slack',
    channelId: 'C-OPS',
    channelName: 'ops',
    threadId: '1700000000.000100',
    kind: 'channel',
    askedBy: { chatUserId: 'U-OMAR', name: 'Omar Lind' },
    fence: { servers, clusters: [], reach: 'ask', ...fence },
  });

  /** A conversation asked for in #ops, running in the chat agent's hub at a terminal on `server` that answers. */
  async function chatRun(server_: string, id = 'chat-run-1') {
    const tenant = await server.tenants.getChatAgentTenant();
    const hub = tenant.hub;
    await hub.request({ action: 'snapshot' });
    expect(hub.getKnownServers().map((s) => s.id)).toContain(server_);
    const ran: string[] = [];
    const sessionId = `term-${id}`;
    hub.terminals.register({ id: sessionId, label: server_, kind: 'ssh', profileId: server_ }, (data) => {
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (!nonce) return;
      ran.push(data);
      queueMicrotask(() => hub.terminals.feed(sessionId, `\x1b]777;SSHS3;${nonce};BEGIN\x07done\r\n\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`));
    });
    hub.terminals.feed(sessionId, `ops@${server_}:~$ `);
    await hub.terminals.ensureReady(sessionId, 'bash');
    const session = hub.terminals.get(sessionId)!;
    const task = {
      id,
      title: 'Restart nginx',
      mode: 'assisted',
      status: 'running',
      agentName: 'Linux SRE',
      messages: [{ id: 'u1', role: 'user', text: `Restart nginx on ${server_}`, at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 0,
      maxMinutes: 0,
      verification: 'not-verified',
      target: { sessionId, generation: session.generation, label: server_ },
      chat: origin([server_]),
    } as unknown as AgentTask;
    hub.store.data.tasks.push(task);
    hub.terminals.claim(sessionId, session.generation, task.id);
    const capability = await hub.broker.issue(task);
    ran.length = 0;
    let outcome: { exitCode: number } | undefined;
    let refused: Error | undefined;
    void (hub.broker.invoke(capability.key, { action: 'command', command: 'sudo systemctl restart nginx', description: 'Restart the web server' }) as Promise<{ exitCode: number }>).then(
      (r) => (outcome = r),
      (e) => (refused = e as Error),
    );
    const change = await until(() => task.changes.find((c) => c.status === 'pending'), 'the change waits');
    return { hub, task, change, ran, outcome: () => outcome, refused: () => refused };
  }

  const until = async <T,>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> => {
    const end = Date.now() + 4000;
    for (;;) {
      const found = await read();
      if (found !== undefined) return found;
      if (Date.now() > end) throw new Error(`Never happened: ${what}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };

  const answer = (who: Person, change: AgentChange, over: Record<string, unknown> = {}) =>
    server.tenants.answerForChatAgent(who.id, { taskId: 'chat-run-1', id: change.id, kind: 'change', approved: true, via: 'slack', ...over });

  it('is nobody: not an account, not in the list, not here, not woken, not reachable over MCP or the alert hook', async () => {
    const { maria } = await team();
    const agent = await server.tenants.getChatAgentTenant();
    expect(agent.user).toMatchObject({ id: CHAT_AGENT_ID, username: 'svc:chat-agent', displayName: 'Chat agent', role: 'member' });
    // Its folder is the server's own, outside the accounts' folders, and no account record names it.
    expect(agent.userDir).toBe(path.join(tmpDir, 'service', 'chat-agent'));
    expect(await fs.readdir(path.join(tmpDir, 'users'))).not.toContain(CHAT_AGENT_ID);
    expect(await fs.readFile(path.join(tmpDir, 'web-users.json'), 'utf8')).not.toContain('chat-agent');

    expect((await server.auth.listUsers()).map((u) => u.username).sort()).toEqual(['maria', 'omar']);
    expect(server.auth.userCount()).toBe(2);
    expect(server.auth.accountsBrief().map((a) => a.id)).not.toContain(CHAT_AGENT_ID);
    const listed = await send('GET', '/api/admin/users', undefined, maria.cookie);
    expect(listed.status).toBe(200);
    expect(listed.body.users.map((u: { id: string }) => u.id)).not.toContain(CHAT_AGENT_ID);
    expect(server.tenants.runningUserIds()).not.toContain(CHAT_AGENT_ID);
    expect(await server.wakeUsers()).toBe(2);

    // A terminal of its own is not somebody here.
    agent.hub.terminals.register({ id: 'agent-term', label: 'web-prod-01', kind: 'ssh', profileId: 'web-prod-01' }, () => {});
    expect(agent.hub.terminals.list().find((t) => t.id === 'agent-term')?.state).not.toBe('disconnected');
    // What it would tell the team's bucket about who is here: no terminals of a person's.
    const local = await (agent.hub.s3Workspace as unknown as { callbacks: { getLocalState(): Promise<{ activeTerminals: unknown[] }> } }).callbacks.getLocalState();
    expect(local.activeTerminals).toEqual([]);
    expect(server.tenants.getAllLocalTenantsPresence().map((p) => p.actor)).not.toContain('Chat agent');
    const snapshot = await maria.hub.request({ action: 'snapshot' });
    expect(JSON.stringify(snapshot.presence ?? [])).not.toContain('Chat agent');
    // With a team bucket it would write no presence of its own there; a person's hub does.
    const presenceOption = (hub: HubService) => (hub.s3Workspace as unknown as { options: { publishPresence?: boolean } }).options.publishPresence;
    expect(presenceOption(agent.hub)).toBe(false);
    expect(presenceOption(maria.hub)).not.toBe(false);

    // Nobody signs in as it, and a tenant of it cannot be started as an account's.
    expect((await send('POST', '/api/auth/login', { username: 'svc:chat-agent', password: 'anything-at-all' })).status).toBeGreaterThanOrEqual(400);
    await expect(server.tenants.getOrCreateTenant({ ...agent.user })).rejects.toThrow('belongs to the server');

    // Its alert hook address leads nowhere, even with the right secret.
    const made = await agent.hub.request({ action: 'alert-hook-create' });
    const hookPath = made.reply?.alertHook?.path ?? '';
    expect(hookPath).toMatch(new RegExp(`^/api/hooks/${CHAT_AGENT_ID}\\.`));
    expect((await send('POST', hookPath, { title: 'Disk full on web-prod-01' })).status).toBe(404);

    // A key made for it (it cannot be made through the app) reaches no hub.
    const { token } = await server.mcpTokens.create({ userId: CHAT_AGENT_ID, name: 'stray', createdBy: 'test', scopes: ['read'] });
    const rpc = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' }),
    });
    expect(JSON.stringify(await rpc.json())).toContain('no longer on this server');
  }, 30_000);

  it('cannot be removed: the request is refused and nothing is stopped', async () => {
    const { maria, omar } = await team();
    const agent = await server.tenants.getChatAgentTenant();
    // Refused by the route itself, before any step of removing an account is taken.
    const steps = [
      vi.spyOn(server.auth, 'deleteUserByAdmin'),
      vi.spyOn(server.tenants, 'disposeTenant'),
      vi.spyOn(server.mcpTokens, 'forgetUser'),
      vi.spyOn(server.chatAgent, 'forgetAccount'),
    ];
    const removed = await send('DELETE', `/api/admin/users/${CHAT_AGENT_ID}`, undefined, maria.cookie);
    expect(removed.status).toBe(400);
    expect(removed.body.error).toContain('cannot be removed');
    const byBody = await send('DELETE', '/api/admin/users', { userId: 'svc_anything' }, maria.cookie);
    expect(byBody.status).toBe(400);
    for (const step of steps) {
      expect(step).not.toHaveBeenCalled();
      step.mockRestore();
    }
    await expect(server.auth.deleteUserByAdmin(CHAT_AGENT_ID, maria.id)).rejects.toThrow('cannot be removed');
    // Still the same running hub, with its folder.
    expect(await server.tenants.getChatAgentTenant()).toBe(agent);
    await expect(agent.hub.request({ action: 'snapshot' })).resolves.toBeDefined();
    await expect(fs.stat(path.join(tmpDir, 'service', 'chat-agent', '.ssh', 'id_ed25519'))).resolves.toBeDefined();

    // Removing a person forgets their chat link as well.
    const { code } = await server.chatAgent.linkCode(omar.id, 'slack');
    await server.chatAgent.redeem('slack', 'U-OMAR', 'Omar Lind', code);
    expect(server.chatAgent.linkOf('slack', 'U-OMAR')).toBeDefined();
    expect((await send('DELETE', `/api/admin/users/${omar.id}`, undefined, maria.cookie)).status).toBe(200);
    expect(server.chatAgent.linkOf('slack', 'U-OMAR')).toBeUndefined();
    expect(server.chatAgent.allLinks()).toEqual([]);
  }, 30_000);

  it('counts an account that is turned off as not linked, and lets nobody link to it', async () => {
    const { omar } = await team();
    const { code } = await server.chatAgent.linkCode(omar.id, 'slack');
    await server.auth.deprovisionUser(omar.id);
    expect(await server.chatAgent.redeem('slack', 'U-OMAR', 'Omar Lind', code)).toMatchObject({ ok: false, reason: 'unusable' });
    expect(server.chatAgent.allLinks()).toEqual([]);
  }, 30_000);

  it('has an SSH key of its own, in its own folder, that can be rotated', async () => {
    await team();
    const agent = await server.tenants.getChatAgentTenant();
    const sshDir = path.join(tmpDir, 'service', 'chat-agent', '.ssh');
    expect(agent.user.sshPrivateKeyPath).toBe(path.join(sshDir, 'id_ed25519'));
    const first = await server.tenants.chatAgentPublicKey();
    // A comment no person's key can have: no username has a ":".
    expect(first).toMatch(/^ssh-ed25519 \S+ svc:chat-agent@sshs3-web$/);
    expect(agent.user.sshPublicKey).toBe(first);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(sshDir, 'id_ed25519'))).mode & 0o777).toBe(0o600);
    const before = await fs.readFile(path.join(sshDir, 'id_ed25519'), 'utf8');
    const rotated = await server.tenants.rotateChatAgentKey();
    expect(rotated).not.toBe(first);
    expect(rotated).toMatch(/^ssh-ed25519 \S+ svc:chat-agent@sshs3-web$/);
    if (process.platform !== 'win32') expect((await fs.stat(path.join(sshDir, 'id_ed25519'))).mode & 0o777).toBe(0o600);
    // Written whole: no temporary files left beside the key.
    expect((await fs.readdir(sshDir)).sort()).toEqual(['id_ed25519', 'id_ed25519.pub']);
    expect(await server.tenants.chatAgentPublicKey()).toBe(rotated);
    expect(await fs.readFile(path.join(sshDir, 'id_ed25519'), 'utf8')).not.toBe(before);
    expect((await fs.readFile(path.join(sshDir, 'id_ed25519.pub'), 'utf8')).trim()).toBe(rotated);
    expect(agent.user.sshPublicKey).toBe(rotated);
    // The same key after a restart: it is kept, not made again.
    await server.stop();
    server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, staticDir: path.join(tmpDir, 'static') });
    const info = await server.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
    expect((await server.tenants.getChatAgentTenant()).user.sshPublicKey).toBe(rotated);
  }, 30_000);

  it('needs two people who may answer before a change of its own can ask for two', async () => {
    const { maria, omar } = await team();
    const agent = (await server.tenants.getChatAgentTenant()).hub;
    // A person's own run counts its owner as the first: one administrator is enough for Omar.
    expect(omar.hub.peerApprovalPossible(['production'])).toBe(true);
    // The chat agent is nobody: one administrator is not two people for production.
    expect(agent.peerApprovalPossible(['production'])).toBe(false);
    // Off production, Maria and Omar are two people.
    expect(agent.peerApprovalPossible([])).toBe(true);

    const evaInvite = await post('/api/admin/invites', { role: 'admin', maxUses: 1 }, maria.cookie);
    const eva = await post('/api/auth/register-invite', { inviteToken: evaInvite.body.invite.token, username: 'eva', displayName: 'Eva Holm', password: 'eva-password-123' }); // pragma: allowlist secret
    expect(agent.peerApprovalPossible(['production'])).toBe(true);
    // A turned off account is nobody either.
    await server.auth.deprovisionUser(eva.body.user.id);
    expect(agent.peerApprovalPossible(['production'])).toBe(false);
    // It administers nothing, and its own hub never puts other people's changes to it.
    expect(agent.host.teamAdmin?.()).toBe(false);
    expect(agent.host.soleUser?.()).toBe(false);
    expect(agent.host.peerWaiting).toBeUndefined();
    expect(agent.host.peerDecide).toBeUndefined();
    expect(agent.host.serviceAccount).toBe(true);
    await expect(agent.host.teamRules!.write({ requirePeerApprovalOnProd: true })).rejects.toThrow('administrator');
    // Its votes are not people's: its own id is never somebody's second approval.
    expect(agent.host.peerStillEligible?.(`user:${CHAT_AGENT_ID}`, [])).toBe(false);
    expect(agent.host.peerStillEligible?.(`user:${maria.id}`, ['production'])).toBe(true);
    // Not in a person's hub either, off production too: it is never a second person for anybody.
    expect(maria.hub.host.peerStillEligible?.(`user:${CHAT_AGENT_ID}`, [])).toBe(false);
    expect(omar.hub.host.peerStillEligible?.(`user:${CHAT_AGENT_ID}`, [])).toBe(false);
    expect(omar.hub.host.peerStillEligible?.('user:svc_anything', [])).toBe(false);
    expect(omar.hub.host.peerStillEligible?.(`user:${maria.id}`, [])).toBe(true);
  }, 30_000);

  it('counts only administrators in a channel that takes answers from administrators only', async () => {
    const { maria } = await team();
    const agent = (await server.tenants.getChatAgentTenant()).hub;
    const admins = { chat: origin(['web-dev-01'], { approvers: 'admins' }) };
    // Off production, Maria and Omar are two people, but only Maria may answer in that channel.
    expect(agent.peerApprovalPossible([], { chat: origin(['web-dev-01']) })).toBe(true);
    expect(agent.peerApprovalPossible([], admins)).toBe(false);
    const invite = await post('/api/admin/invites', { role: 'admin', maxUses: 1 }, maria.cookie);
    await post('/api/auth/register-invite', { inviteToken: invite.body.invite.token, username: 'eva', displayName: 'Eva Holm', password: 'eva-password-123' }); // pragma: allowlist secret
    expect(agent.peerApprovalPossible([], admins)).toBe(true);
  }, 30_000);

  it('is never alone on the server, even with one administrator', async () => {
    // Only Maria: her own hub is hers alone, the chat agent's is still a shared server's.
    await post('/api/auth/setup', { username: 'maria', displayName: 'Maria Ek', password: 'maria-password-123' }); // pragma: allowlist secret
    const agent = (await server.tenants.getChatAgentTenant()).hub;
    expect(agent.host.soleUser?.()).toBe(false);
    expect(agent.sharedServer()).toBe(true);
    expect(agent.safetyPolicy().requireApprovalOnProdTags).toBe(true);
    expect(agent.safetyPolicy().blockDestructiveWithoutConfirm).toBe(true);
    expect(agent.outboundGuard().server).toBe(true);
  }, 30_000);

  it('does none of the team\'s learning, whatever its preferences say', async () => {
    const { maria } = await team();
    const agent = (await server.tenants.getChatAgentTenant()).hub;
    expect(agent.store.data.preferences.proposeMemories).toBe(false);
    // Even with a model and learning switched back on, its timer neither hands over, reads the
    // team's queue, nor learns from activity.
    agent.store.data.preferences.proposeMemories = true;
    const learning = (hub: HubService) =>
      (['recoverUnreadSessions', 'maybeLearnFromOwnActivity', 'queueTeamActivity', 'readLearningQueue'] as const).map((name) =>
        vi.spyOn(hub, name).mockResolvedValue(undefined),
      );
    const tick = async (hub: HubService) => {
      vi.spyOn(hub.config, 'getView').mockResolvedValue({ ...(await hub.config.getView()), enabled: true });
      vi.spyOn(hub, 'nightly').mockResolvedValue(undefined);
      await (hub as unknown as { tick(): Promise<void> }).tick();
      await new Promise((r) => setTimeout(r, 20));
    };
    const agentLearning = learning(agent);
    await tick(agent);
    for (const spy of agentLearning) expect(spy).not.toHaveBeenCalled();
    // A person's hub does.
    const mariaLearning = learning(maria.hub);
    await tick(maria.hub);
    for (const spy of mariaLearning) expect(spy).toHaveBeenCalled();
    vi.restoreAllMocks();

    // Its nightly upkeep never takes the team's mark for the day, nor tidies the team's memory.
    const markOnce = vi.fn(async () => true);
    vi.spyOn(agent, 'work').mockReturnValue({ markOnce, pruneMarks: vi.fn(async () => 0) } as unknown as ReturnType<HubService['work']>);
    const asked = vi.spyOn(agent, 'request');
    await agent.nightly(new Date(2026, 10, 20, 4, 0).getTime());
    expect(markOnce).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'self-learn-reflect' }));
    expect(agent.store.data.dailyReport?.day).toBe('2026-11-20');
    vi.restoreAllMocks();
  }, 30_000);

  it('hands over no conversation asked in a channel when it reads back what it missed', async () => {
    const { maria } = await team();
    const hub = maria.hub;
    const done = (id: string, chat?: ChatOrigin) =>
      ({
        id,
        title: `Run ${id}`,
        mode: 'assisted',
        status: 'completed',
        messages: [{ id: 'a1', role: 'assistant', text: 'x'.repeat(700), at: Date.now() }],
        changes: [],
        sources: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(chat ? { chat } : {}),
      }) as unknown as AgentTask;
    hub.store.data.tasks.push(done('own-run'), done('channel-run', origin(['web-dev-01'])));
    (hub as unknown as { recoveredSessions: boolean }).recoveredSessions = false;
    const handed = vi.spyOn(hub, 'queueForLearning').mockResolvedValue(undefined);
    await hub.recoverUnreadSessions(Date.now());
    expect(handed.mock.calls.map(([source]) => source.id)).toEqual(['task:own-run']);
    vi.restoreAllMocks();
  }, 30_000);

  it('takes an answer from chat only from somebody who may give it, as a second person in the app', async () => {
    const { maria, omar, eva } = await team(true);
    // Turned off before the change is asked: who may answer is part of the rules it was asked under.
    await server.auth.deprovisionUser(eva!.id);
    const run = await chatRun('web-prod-01');
    const subject = run.hub.chatApprovalSubject('chat-run-1', run.change.id);
    expect(subject).toMatchObject({ kind: 'change', setting: false, waiting: true, requiredApprovals: 1 });
    expect(subject.targetTags).toContain('prod');

    // A member is not enough for production.
    expect(await answer(omar, run.change)).toEqual({
      outcome: 'refused',
      message: 'You cannot approve this. On production it has to be an administrator of this server, or somebody in one of its approver groups.',
    });
    // A turned off account cannot answer, administrator or not.
    expect(await answer(eva!, run.change)).toMatchObject({ outcome: 'refused', message: expect.stringContaining('turned off') });
    // Somebody who is not an account at all, or the chat agent itself.
    expect(await server.tenants.answerForChatAgent('usr_nobody', { taskId: 'chat-run-1', id: run.change.id, kind: 'change', approved: true, via: 'slack' })).toMatchObject({ outcome: 'refused' });
    expect(await server.tenants.answerForChatAgent(CHAT_AGENT_ID, { taskId: 'chat-run-1', id: run.change.id, kind: 'change', approved: true, via: 'slack' })).toMatchObject({ outcome: 'refused' });
    // Asked as a plan, it is not one.
    expect(await answer(maria, run.change, { kind: 'plan' })).toEqual({
      outcome: 'refused',
      message: 'That is not waiting any more: it was answered, or its run was stopped.',
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(run.ran).toEqual([]);
    expect(run.change.approvals ?? []).toEqual([]);

    // An administrator is, in a channel for administrators only as well: it runs, and the record says
    // it was her, from Slack.
    expect(await answer(maria, run.change, { approvers: 'admins' })).toEqual({ outcome: 'approved', message: 'Maria Ek approved.' });
    await until(() => run.outcome(), 'the command runs');
    expect(run.refused()).toBeUndefined();
    expect(run.ran).toHaveLength(1);
    expect(run.change.approvals).toEqual([expect.objectContaining({ actor: 'Maria Ek', actorId: `user:${maria.id}`, allowed: true, via: 'slack' })]);
    // Answered: a second press says so.
    expect(await answer(maria, run.change)).toMatchObject({ outcome: 'refused', message: expect.stringContaining('not waiting any more') });
  }, 30_000);

  it('refuses a change to sshs3\'s own rules from chat, and in an admins-only channel a member', async () => {
    const { maria, omar } = await team();
    const run = await chatRun('web-dev-01');
    // Off production a member may answer, but not in a channel that takes answers from administrators only.
    expect(await answer(omar, run.change, { approvers: 'admins' })).toEqual({ outcome: 'refused', message: 'In this channel only an administrator can answer.' });
    expect(run.change.approvals ?? []).toEqual([]);
    expect(await answer(omar, run.change, { approved: false, note: 'Not during the demo.' })).toEqual({ outcome: 'denied', message: 'Omar Lind said no. Nothing runs.' });
    await until(() => run.refused(), 'the agent is told no');
    expect(run.ran).toEqual([]);

    // A change to sshs3's own rules waits in the same conversation: it is only answered in the app.
    run.task.changes.push({ id: 'rules-1', kind: 'setting', status: 'pending', description: 'Turn off the two person rule', risk: 'high', createdAt: Date.now() } as unknown as AgentChange);
    expect(await answer(maria, { id: 'rules-1' } as AgentChange)).toEqual({ outcome: 'refused', message: 'A change to sshs3\'s own rules can only be answered in the app.' });
  }, 30_000);

  it('counts one person once when a change needs two', async () => {
    const { maria, eva } = await team(true);
    await maria.hub.request({ action: 'team-rules-save', requirePeerApprovalOnProd: true } as never);
    const run = await chatRun('web-prod-01');
    expect(run.change.requiredApprovals).toBe(2);
    expect(await answer(maria, run.change)).toEqual({ outcome: 'waiting', remaining: 1, message: 'Maria Ek approved. It needs one more person.' });
    // Her second press is not the second person.
    expect(await answer(maria, run.change)).toEqual({ outcome: 'refused', message: 'You already answered this.' });
    await new Promise((r) => setTimeout(r, 50));
    expect(run.ran).toEqual([]);
    expect(await answer(eva!, run.change)).toEqual({ outcome: 'approved', message: 'Eva Holm approved.' });
    await until(() => run.outcome(), 'the command runs');
    expect(run.ran).toHaveLength(1);
    expect(run.change.approvals!.filter((a) => a.allowed).map((a) => a.actorId)).toEqual([`user:${maria.id}`, `user:${eva!.id}`]);
  }, 30_000);

  /** A finished conversation in the chat agent's hub with a plan that waits for an answer. */
  function planTask(id: string, steps: AgentPlan['steps'], servers = ['web-prod-01']) {
    const task = {
      id,
      title: 'Restart nginx',
      mode: 'plan',
      status: 'completed',
      agentName: 'Linux SRE',
      messages: [{ id: 'u1', role: 'user', text: 'Restart nginx', at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 0,
      maxMinutes: 0,
      verification: 'not-verified',
      chat: origin(servers),
      plan: { id: `plan-${id}`, goal: 'Restart nginx', steps, status: 'proposed', revision: 1, createdAt: Date.now() },
    } as unknown as AgentTask;
    return task;
  }
  const restartOn = (target: string): AgentPlan['steps'][number] =>
    ({ action: `Restart nginx on ${target}`, target, command: 'sudo systemctl restart nginx', risk: 'medium', check: 'systemctl is-active nginx' }) as AgentPlan['steps'][number];
  const answerPlan = (who: Person, task: AgentTask, over: Record<string, unknown> = {}) =>
    server.tenants.answerForChatAgent(who.id, { taskId: task.id, id: task.plan!.id, kind: 'plan', approved: true, via: 'slack', ...over });

  it('takes an answer to a plan from chat by the same rules, and records it', async () => {
    const { maria, omar } = await team();
    const hub = (await server.tenants.getChatAgentTenant()).hub;
    await hub.request({ action: 'snapshot' });
    const denied = planTask('chat-plan-1', [restartOn('web-prod-01')]);
    const approved = planTask('chat-plan-2', [restartOn('web-prod-01')]);
    hub.store.data.tasks.push(denied, approved);
    const subject = hub.chatApprovalSubject(denied.id, denied.plan!.id);
    expect(subject).toMatchObject({ kind: 'plan', waiting: true });
    expect(subject.targetTags).toContain('prod');

    expect(await answerPlan(omar, denied)).toEqual({
      outcome: 'refused',
      message: 'You cannot approve this. On production it has to be an administrator of this server, or somebody in one of its approver groups.',
    });
    // A plan id sent as a change is not one.
    expect(await answerPlan(maria, denied, { kind: 'change' })).toEqual({
      outcome: 'refused',
      message: 'That is not waiting any more: it was answered, or its run was stopped.',
    });
    expect(denied.plan!.approvals ?? []).toEqual([]);

    // Deny means no.
    expect(await answerPlan(maria, denied, { approved: false, note: 'Use reload.' })).toEqual({ outcome: 'denied', message: 'Maria Ek said no. Nothing runs.' });
    expect(denied.plan!.status).toBe('rejected');
    expect(denied.plan!.approvals![0]).toMatchObject({ actorId: `user:${maria.id}`, allowed: false, via: 'slack', note: 'Use reload.' });

    // Approve means yes.
    expect(await answerPlan(maria, approved)).toMatchObject({ outcome: 'approved' });
    expect(approved.plan!.status).toBe('approved');
    expect(approved.plan!.approvals![0]).toMatchObject({ actorId: `user:${maria.id}`, allowed: true, via: 'slack' });
  }, 30_000);

  it('holds a plan to production when any of its steps is on a production server', async () => {
    const { maria, omar } = await team();
    // Tagged production, with nothing in its name that says so.
    const tenant = await server.tenants.getOrCreateTenant((await server.auth.listUsers()).find((u) => u.id === maria.id)!);
    await tenant.invokeFromClient(-1, 'profiles:save-ssh', { id: 'db-main-01', name: 'db-main-01', host: '10.30.70.41', port: 22, username: 'ops', authType: 'key', tags: ['prod'], shared: true });
    const hub = (await server.tenants.getChatAgentTenant()).hub;
    await hub.request({ action: 'snapshot' });
    expect(hub.getKnownServers().map((s) => s.id)).toContain('db-main-01');
    // Its first step is on a test server.
    const task = planTask('chat-plan-3', [restartOn('web-dev-01'), restartOn('db-main-01')], ['web-dev-01', 'db-main-01']);
    hub.store.data.tasks.push(task);
    expect(hub.chatApprovalSubject(task.id, task.plan!.id).targetTags).toContain('prod');
    expect(await answerPlan(omar, task)).toEqual({
      outcome: 'refused',
      message: 'You cannot approve this. On production it has to be an administrator of this server, or somebody in one of its approver groups.',
    });
    expect(task.plan!.status).toBe('proposed');
    expect(task.plan!.approvals ?? []).toEqual([]);
  }, 30_000);
});
