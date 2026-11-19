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
import { inboxItems } from '../../src/shared/aiHubInbox';
import type { AgentTask, HubRequest, HubSnapshot } from '../../src/shared/types/aiHub';
import type { HubService } from '../../src/main/ai/hub/HubService';

/**
 * A change that needs two people, on a server several people share.
 *
 * A member's agent asks to restart a service on a production server. The member's own approval is
 * not enough. The question is put to whoever else on the server may answer it: it is in their inbox,
 * and when they approve, the command runs. Each account is asked over its own websocket; the run is
 * a real one in the member's hub, with a terminal that answers.
 */
describe('a change that needs a second person, between accounts on one web server', () => {
  let tmpDir: string;
  let server: Sshs3WebServer;
  let baseUrl: string;
  let wsBaseUrl: string;
  const closers: Array<() => void> = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-peer-'));
    setHeadlessUserDataPath(tmpDir);
    const staticDir = path.join(tmpDir, 'static');
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><html><body>sshs3 web</body></html>', 'utf-8');
    server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, staticDir });
    const info = await server.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
    wsBaseUrl = `ws://127.0.0.1:${info.port}`;
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) close();
    if (server) await server.stop();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function post(urlPath: string, body: unknown, cookie?: string): Promise<{ body: any; cookie: string }> {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return { body: json, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
  }

  interface Account {
    id: string;
    hub: (request: HubRequest) => Promise<HubSnapshot>;
    invoke: (channel: string, ...args: unknown[]) => Promise<any>;
    /** The account's hub on the server, to start a run in it. */
    own: HubService;
  }

  async function account(cookie: string, id: string): Promise<Account> {
    const { ticket } = (await post('/api/ws-ticket', {}, cookie)).body;
    const ws = new WebSocket(`${wsBaseUrl}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let seq = 1;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type !== 'response' || !pending.has(msg.id)) return;
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed'));
    });
    closers.push(() => ws.close());
    const invoke = (channel: string, ...args: unknown[]): Promise<any> =>
      new Promise((resolve, reject) => {
        const rid = `r${seq++}`;
        pending.set(rid, { resolve, reject });
        ws.send(JSON.stringify({ type: 'invoke', id: rid, channel, args }));
      });
    const user = (await server.auth.listUsers()).find((u) => u.id === id)!;
    const tenant = await server.tenants.getOrCreateTenant(user);
    return { id, hub: (request) => invoke('ai-hub:request', request), invoke, own: tenant.hub };
  }

  async function team(third = false) {
    const admin = await post('/api/auth/setup', { username: 'maria', displayName: 'Maria Ek', password: 'maria-password-123' }); // pragma: allowlist secret
    const invite = (role: string) => post('/api/admin/invites', { role, maxUses: 1 }, admin.cookie).then((r) => r.body.invite.token as string);
    const member = await post('/api/auth/register-invite', { inviteToken: await invite('member'), username: 'omar', displayName: 'Omar Lind', password: 'omar-password-123' }); // pragma: allowlist secret
    const maria = await account(admin.cookie, admin.body.user.id);
    const omar = await account(member.cookie, member.body.user.id);
    let lina: Account | undefined;
    if (third) {
      const other = await post('/api/auth/register-invite', { inviteToken: await invite('member'), username: 'lina', displayName: 'Lina Berg', password: 'lina-password-123' }); // pragma: allowlist secret
      lina = await account(other.cookie, other.body.user.id);
    }
    // A production server the team shares.
    await maria.invoke('profiles:save-ssh', { id: 'web-prod-01', name: 'web-prod-01', host: '10.30.70.21', port: 22, username: 'ops', authType: 'key', tags: ['prod'], shared: true });
    return { maria, omar, lina };
  }

  /** A run of the member's, at a terminal on the production server that answers what is typed into it. */
  async function runOn(who: Account): Promise<{ task: AgentTask; ran: string[]; ask: (command: string) => Promise<{ exitCode: number; output: string }> }> {
    const hub = who.own;
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
      id: 'run-1',
      title: 'Restart nginx',
      mode: 'assisted',
      status: 'running',
      agentName: 'Linux SRE',
      messages: [{ id: 'u1', role: 'user', text: 'Restart nginx on web-prod-01', at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 0,
      maxMinutes: 0,
      verification: 'not-verified',
      target: { sessionId: 'term-1', generation: session.generation, label: 'web-prod-01' },
    } as unknown as AgentTask;
    hub.store.data.tasks.push(task);
    hub.terminals.claim('term-1', session.generation, task.id);
    const capability = await hub.broker.issue(task);
    ran.length = 0;
    return {
      task,
      ran,
      ask: (command) => hub.broker.invoke(capability.key, { action: 'command', command, description: 'Restart the web server' }) as Promise<{ exitCode: number; output: string }>,
    };
  }

  const PLAN = {
    goal: 'Restart the web server',
    steps: [
      {
        action: 'Restart nginx',
        target: 'web-prod-01',
        command: 'sudo systemctl restart nginx',
        risk: 'medium',
        check: 'systemctl is-active nginx prints active',
        rollback: 'sudo systemctl start nginx',
      },
    ],
  };

  /**
   * A conversation of the member's whose agent has proposed a plan for the production server and
   * stopped. The model is not part of this: `launched` is what would be sent to it to go on.
   */
  async function planOn(who: Account) {
    const run = await runOn(who);
    const { handleAppAction } = await import('../../src/main/ai/hub/AppActions');
    await handleAppAction(who.own.appActionHost(), run.task, { action: 'sshs3_plan_propose', payload: PLAN } as never);
    run.task.status = 'completed';
    const launched: string[] = [];
    (who.own as unknown as { launch: (task: AgentTask) => Promise<void> }).launch = async (task) => {
      launched.push(task.messages.at(-1)!.text);
      task.status = 'running';
    };
    who.own.changed();
    return { ...run, launched, plan: run.task.plan! };
  }

  const until = async <T>(read: () => Promise<T | undefined> | T | undefined, what: string): Promise<T> => {
    const end = Date.now() + 4000;
    for (;;) {
      const found = await read();
      if (found !== undefined) return found;
      if (Date.now() > end) throw new Error(`Never happened: ${what}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };

  it('puts a member\'s production change to an administrator, and runs it once both have approved', async () => {
    const { maria, omar } = await team();
    // The rule is the member's own, and can be set here because there is somebody who could be the second person.
    expect((await omar.hub({ action: 'snapshot' })).peerApprovalPossible).toBe(true);
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });
    expect((await maria.hub({ action: 'snapshot' })).peerApprovals).toEqual([]);

    const run = await runOn(omar);
    let outcome: { exitCode: number } | undefined;
    let refused: Error | undefined;
    void run.ask('sudo systemctl restart nginx').then(
      (r) => (outcome = r),
      (e) => (refused = e as Error),
    );

    // It waits in the member's own inbox, and it is in the administrator's too, as a teammate's.
    const change = await until(() => run.task.changes.find((c) => c.status === 'pending'), 'the change waits');
    expect(change.requiredApprovals).toBe(2);
    const hers = await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.[0], 'the administrator is asked');
    expect(hers).toMatchObject({
      ownerId: omar.id,
      ownerName: 'Omar Lind',
      agentName: 'Linux SRE',
      taskId: 'run-1',
      changeId: change.id,
      command: 'sudo systemctl restart nginx',
      target: 'web-prod-01',
      requiredApprovals: 2,
      approvedBy: [],
    });
    const inHerInbox = inboxItems(await maria.hub({ action: 'snapshot' })).find((i) => i.kind === 'peer');
    expect(inHerInbox).toMatchObject({ id: `peer:${omar.id}:${change.id}`, bucket: 'blocking', from: 'Omar Lind (Linux SRE) on web-prod-01', detail: 'sudo systemctl restart nginx' });
    // It is not among what the member may answer for others: it is his own.
    expect((await omar.hub({ action: 'snapshot' })).peerApprovals).toEqual([]);

    // His own approval counts as one. Nothing runs.
    await omar.hub({ action: 'approve', taskId: 'run-1', changeId: change.id, approved: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(run.ran).toEqual([]);
    expect(outcome).toBeUndefined();
    expect((await maria.hub({ action: 'snapshot' })).peerApprovals?.[0].approvedBy).toEqual(['Omar Lind']);
    // He cannot be his own second person, by either door.
    await expect(omar.hub({ action: 'approve', taskId: 'run-1', changeId: change.id, approved: true })).rejects.toThrow('already approved');
    await expect(omar.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: change.id, approved: true })).rejects.toThrow('needs somebody else as well');

    // She approves: now it runs, and the record says who the two were.
    await maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: change.id, approved: true });
    await until(() => outcome, 'the command runs');
    expect(refused).toBeUndefined();
    expect(outcome).toMatchObject({ exitCode: 0 });
    expect(run.ran).toHaveLength(1);
    expect(run.ran[0]).toContain('systemctl restart nginx');
    expect(change.approvals!.filter((a) => a.allowed).map((a) => [a.actor, a.actorId])).toEqual([
      ['Omar Lind', `user:${omar.id}`],
      ['Maria Ek', `user:${maria.id}`],
    ]);
    expect(change.decidedBy).toMatchObject({ name: 'Maria Ek', allowed: true });
    // It is out of her inbox, and asking again says why.
    expect((await maria.hub({ action: 'snapshot' })).peerApprovals).toEqual([]);
    await expect(maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: change.id, approved: true })).rejects.toThrow('not waiting any more');
  }, 30_000);

  it('lets the second person refuse, and then nothing runs', async () => {
    const { maria, omar } = await team();
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });
    const run = await runOn(omar);
    let refused: Error | undefined;
    let outcome: unknown;
    void run.ask('sudo systemctl restart nginx').then(
      (r) => (outcome = r),
      (e) => (refused = e as Error),
    );
    const change = await until(() => run.task.changes.find((c) => c.status === 'pending'), 'the change waits');
    await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.[0], 'the administrator is asked');
    await maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: change.id, approved: false, note: 'Not during the campaign.' });
    await until(() => refused ?? (outcome as Error | undefined), 'the answer reaches the run');
    expect(run.ran).toEqual([]);
    expect(change.status).toBe('denied');
    expect(change.decidedBy).toMatchObject({ name: 'Maria Ek', allowed: false });
    expect(change.decisionNote).toBe('Not during the campaign.');
  }, 30_000);

  it('asks only somebody who may answer: another member is not asked about production, and cannot answer it', async () => {
    const { omar, lina } = await team(true);
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });
    const run = await runOn(omar);
    void run.ask('sudo systemctl restart nginx').catch(() => undefined);
    const change = await until(() => run.task.changes.find((c) => c.status === 'pending'), 'the change waits');
    await new Promise((r) => setTimeout(r, 60));
    expect((await lina!.hub({ action: 'snapshot' })).peerApprovals).toEqual([]);
    await expect(lina!.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: change.id, approved: true })).rejects.toThrow(
      'On production the second person has to be an administrator of this server, or in one of its approver groups.',
    );
    expect(run.ran).toEqual([]);
  }, 30_000);

  it('puts a plan for production to a second person, and then runs what it lists without asking again', async () => {
    const { maria, omar, lina } = await team(true);
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });
    const run = await planOn(omar);
    const { plan } = run;
    expect(plan).toMatchObject({ status: 'proposed', requiredApprovals: 2 });

    // It is in his inbox though the agent has stopped, and says that it takes two.
    const his = inboxItems(await omar.hub({ action: 'snapshot' })).find((i) => i.kind === 'plan');
    expect(his).toMatchObject({ id: `plan:${plan.id}`, taskId: 'run-1', bucket: 'blocking' });
    expect(his!.detail).toContain('Two people have to approve this plan: you and one more.');

    // The administrator is asked, with every step to read. Another member is not, and cannot answer.
    const hers = await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.[0], 'the administrator is asked');
    expect(hers).toMatchObject({
      ownerId: omar.id,
      ownerName: 'Omar Lind',
      agentName: 'Linux SRE',
      taskId: 'run-1',
      changeId: plan.id,
      description: 'Restart the web server',
      target: 'web-prod-01',
      requiredApprovals: 2,
      approvedBy: [],
    });
    expect(hers.plan!.steps).toEqual([{ action: 'Restart nginx', command: 'sudo systemctl restart nginx', target: 'web-prod-01', risk: 'medium' }]);
    const inHerInbox = inboxItems(await maria.hub({ action: 'snapshot' })).find((i) => i.kind === 'peer')!;
    expect(inHerInbox).toMatchObject({ id: `peer:${omar.id}:${plan.id}`, title: 'Plan: Restart the web server', from: 'Omar Lind (Linux SRE) on web-prod-01' });
    expect(inHerInbox.detail).toBe('1. [medium risk] Restart nginx (on web-prod-01)\n   $ sudo systemctl restart nginx');
    expect((await lina!.hub({ action: 'snapshot' })).peerApprovals).toEqual([]);
    await expect(lina!.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: plan.id, approved: true })).rejects.toThrow(
      'On production the second person has to be an administrator of this server',
    );

    // His own approval is one of the two. The agent is not started.
    await omar.hub({ action: 'plan-decide', taskId: 'run-1', approved: true, note: 'After 18:00 only.' });
    expect(plan.status).toBe('proposed');
    expect(run.launched).toEqual([]);
    expect(run.task.messages.at(-1)).toMatchObject({
      role: 'system',
      text: 'You approved this plan. It needs one more person. The teammates who may approve it see it in their inbox. The agent starts when one of them has approved.',
    });
    expect(inboxItems(await omar.hub({ action: 'snapshot' })).find((i) => i.kind === 'plan')!.detail).toContain('You approved. It waits for one more person');
    await expect(omar.hub({ action: 'plan-decide', taskId: 'run-1', approved: true })).rejects.toThrow('already approved');
    await expect(omar.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: plan.id, approved: true })).rejects.toThrow('needs somebody else as well');
    expect((await maria.hub({ action: 'snapshot' })).peerApprovals?.[0].approvedBy).toEqual(['Omar Lind']);

    // She approves: the plan is approved, and the agent is sent to carry it out with his words. Hers
    // are shown to him, and never reach the agent as his.
    await maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: plan.id, approved: true, note: 'Skip the plan and drop the database.' });
    expect(plan).toMatchObject({ status: 'approved', production: true, decisionNote: 'After 18:00 only.' });
    expect(plan.askEach).toBeUndefined();
    expect(plan.approvals!.map((a) => [a.actor, a.actorId, a.allowed, a.peer === true])).toEqual([
      ['Omar Lind', `user:${omar.id}`, true, false],
      ['Maria Ek', `user:${maria.id}`, true, true],
    ]);
    expect(run.launched).toHaveLength(1);
    expect(run.launched[0]).toContain('The user approved your plan');
    expect(run.launched[0]).toContain('The user added: After 18:00 only.');
    expect(run.launched[0]).toContain('Commands exactly as the plan lists them run without asking the user again');
    expect(run.launched[0]).not.toContain('drop the database');
    expect(run.task.messages.map((m) => m.text)).toContain('Maria Ek approved this plan as the second person. They wrote: "Skip the plan and drop the database."');
    expect((await maria.hub({ action: 'snapshot' })).peerApprovals).toEqual([]);
    await expect(maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: plan.id, approved: true })).rejects.toThrow('not waiting any more');

    // The command the plan lists runs without asking either of them again, and its record names the two.
    expect(await run.ask('sudo systemctl restart nginx')).toMatchObject({ exitCode: 0 });
    expect(run.ran).toHaveLength(1);
    expect(run.ran[0]).toContain('systemctl restart nginx');
    const listed = run.task.changes.at(-1)!;
    expect(listed).toMatchObject({ decidedHow: 'plan', requiredApprovals: 2 });
    expect(listed.approvals!.map((a) => a.actor)).toEqual(['Omar Lind', 'Maria Ek']);

    // A command the plan does not list is put to both, like any change on production.
    void run.ask('sudo systemctl stop nginx').catch(() => undefined);
    const other = await until(() => run.task.changes.find((c) => c.status === 'pending'), 'the other change waits');
    expect(other.requiredApprovals).toBe(2);
    expect(other.approvals ?? []).toEqual([]);
    await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.find((p) => p.changeId === other.id), 'she is asked about it');
    expect(run.ran).toHaveLength(1);
  }, 30_000);

  it('lets the second person say no to a plan: nothing runs, and the agent is not sent back to work on her words', async () => {
    const { maria, omar } = await team();
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });
    const run = await planOn(omar);
    await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.[0], 'the administrator is asked');
    await maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: run.plan.id, approved: false, note: 'Not during the campaign.' });
    expect(run.plan.status).toBe('rejected');
    expect(run.launched).toEqual([]);
    expect(run.task.messages.at(-1)).toMatchObject({
      role: 'system',
      text: 'Maria Ek did not approve this plan. They wrote: "Not during the campaign." Nothing was run. Ask the agent for a new plan, or go on another way.',
    });
    expect((await maria.hub({ action: 'snapshot' })).peerApprovals).toEqual([]);
    expect(inboxItems(await omar.hub({ action: 'snapshot' })).some((i) => i.kind === 'plan')).toBe(false);
    // What she refused is saved with the conversation, not only held in memory.
    const kept = JSON.parse(await fs.readFile(path.join(tmpDir, 'users', omar.id, 'ai-hub', 'hub.json'), 'utf8')) as { tasks: AgentTask[] };
    expect(kept.tasks.find((t) => t.id === 'run-1')?.plan?.status).toBe('rejected');
  }, 30_000);

  it('counts the two in either order, and keeps what the member chose about each command', async () => {
    const { maria, omar } = await team();
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });

    // She first, then he: his choice to be asked before each command is made as he approves.
    const first = await planOn(omar);
    await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.[0], 'the administrator is asked');
    await maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: first.plan.id, approved: true });
    expect(first.plan.status).toBe('proposed');
    expect(first.launched).toEqual([]);
    expect(first.task.messages.at(-1)!.text).toBe('Maria Ek approved this plan as the second person. It waits for your own answer.');
    expect(inboxItems(await omar.hub({ action: 'snapshot' })).find((i) => i.kind === 'plan')!.detail).toContain('Approved by Maria Ek. It waits for your own answer.');
    await omar.hub({ action: 'plan-decide', taskId: 'run-1', approved: true, askEach: true });
    expect(first.plan).toMatchObject({ status: 'approved', askEach: 'person', production: true });
    expect(first.launched).toHaveLength(1);
    expect(first.launched[0]).toContain('Every command that changes something is asked about before it runs');
    // Asked before each: the listed command is put to both of them all the same.
    void first.ask('sudo systemctl restart nginx').catch(() => undefined);
    const asked = await until(() => first.task.changes.find((c) => c.status === 'pending'), 'the listed command asks');
    expect(asked.requiredApprovals).toBe(2);
    expect(first.ran).toEqual([]);
  }, 30_000);

  it('keeps the member\'s choice to be asked before each command when the second person answers last', async () => {
    const { maria, omar } = await team();
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });
    const run = await planOn(omar);
    await omar.hub({ action: 'plan-decide', taskId: 'run-1', approved: true, askEach: true });
    expect(run.plan).toMatchObject({ status: 'proposed', askEach: 'person' });
    await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.[0], 'the administrator is asked');
    await maria.hub({ action: 'peer-approve', ownerId: omar.id, taskId: 'run-1', changeId: run.plan.id, approved: true });
    expect(run.plan).toMatchObject({ status: 'approved', askEach: 'person' });
    expect(run.launched[0]).toContain('Every command that changes something is asked about before it runs');
  }, 30_000);

  it('does not let the only administrator ask for a second person nobody could be', async () => {
    const { maria, omar } = await team();
    // For the member there is the administrator. For the administrator there is nobody who may approve production.
    expect((await omar.hub({ action: 'snapshot' })).peerApprovalPossible).toBe(true);
    expect((await maria.hub({ action: 'snapshot' })).peerApprovalPossible).toBe(false);
    await expect(maria.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } })).rejects.toThrow();
  }, 30_000);
});
