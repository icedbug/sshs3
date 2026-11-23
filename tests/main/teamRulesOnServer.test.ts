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
import type { AgentTask, HubRequest, HubSnapshot } from '../../src/shared/types/aiHub';
import type { HubService } from '../../src/main/ai/hub/HubService';

/**
 * The rules an administrator sets for everyone on a server several people sign in to.
 *
 * Two people on a change card or a file write on production, and a change freeze. They hold for a
 * member who never switched anything on, a member cannot set them, and a freeze stops a change card in
 * the broker itself: nothing of it is typed. A plain command is covered by neither: it runs, and nobody
 * is asked. Each account is asked over its own websocket, as its browser would.
 */
describe('rules an administrator sets for everyone on one web server', () => {
  let tmpDir: string;
  let server: Sshs3WebServer;
  let baseUrl: string;
  let wsBaseUrl: string;
  const closers: Array<() => void> = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-team-rules-'));
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
  async function runOn(who: Account): Promise<{
    task: AgentTask;
    ran: string[];
    /** A plain command: it runs at once, with nobody asked. */
    ask: (command: string) => Promise<{ exitCode: number; output: string }>;
    /** The same as a change card, with its check and its rollback: what the rules are about. */
    card: (command: string) => Promise<{ exitCode: number; output: string }>;
  }> {
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
      // The terminal prints "done" for everything, so that is what the check expects.
      card: (command) =>
        hub.broker.invoke(capability.key, {
          action: 'change',
          command,
          description: 'Restart the web server',
          check: { command: 'systemctl is-active nginx', expected: 'done' },
          rollback: 'sudo systemctl stop nginx',
        }) as Promise<{ exitCode: number; output: string }>,
    };
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


  it('holds the two-person rule for a member who never switched it on, and only an administrator sets it', async () => {
    const { maria, omar } = await team();
    await expect(omar.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: true })).rejects.toThrow(
      'Only an administrator of this server sets the rules that hold for everyone.',
    );
    const before = await omar.hub({ action: 'snapshot' });
    expect(before.teamRules).toMatchObject({ requirePeerApprovalOnProd: false, canChange: false });
    expect(before.safetyPolicy?.requirePeerApprovalOnProd).toBeFalsy();

    const set = await maria.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: true });
    expect(set.teamRules).toMatchObject({ requirePeerApprovalOnProd: true, canChange: true, changedBy: 'Maria Ek' });

    // It holds for the member at once, and nothing was written into the member's own rules.
    const after = await omar.hub({ action: 'snapshot' });
    expect(after.teamRules).toMatchObject({ requirePeerApprovalOnProd: true, canChange: false });
    expect(after.safetyPolicy?.requirePeerApprovalOnProd).toBe(true);
    expect(omar.own.store.data.safetyPolicy?.requirePeerApprovalOnProd).toBeFalsy();

    // The member's change card on production waits for a second person, and the administrator is asked.
    const run = await runOn(omar);
    // A plain command on production needs nobody: the rule is about change cards and file writes.
    await expect(run.ask('sudo systemctl restart nginx')).resolves.toMatchObject({ exitCode: 0 });
    expect(run.task.changes[0].requiredApprovals).toBeUndefined();
    expect((await maria.hub({ action: 'snapshot' })).peerApprovals ?? []).toEqual([]);
    void run.card('sudo systemctl restart nginx').catch(() => undefined);
    const change = await until(() => run.task.changes.find((c) => c.status === 'pending'), 'the change waits');
    expect(change.requiredApprovals).toBe(2);
    const asked = await until(async () => (await maria.hub({ action: 'snapshot' })).peerApprovals?.[0], 'the administrator is asked');
    // What the second person is shown carries no rating of the command.
    expect(asked).not.toHaveProperty('risk');

    // It is kept in the server's shared folder, so it is there after a restart.
    const kept = JSON.parse(await fs.readFile(path.join(tmpDir, 'shared-workspace', 'team-rules.json'), 'utf8'));
    expect(kept.requirePeerApprovalOnProd).toBe(true);
    // And the team sees who changed it.
    expect((await omar.hub({ action: 'snapshot' })).activityLog?.some((e) => /Changed the rules for everyone on this server: two people on a change card or a file write on production: off → on/.test(e.summary))).toBe(true);

    await maria.hub({ action: 'team-rules-save', requirePeerApprovalOnProd: false });
    expect((await omar.hub({ action: 'snapshot' })).safetyPolicy?.requirePeerApprovalOnProd).toBeFalsy();
  });

  it('stops a member\'s change card during a freeze without typing it, lets a command through, and asks again when the freeze is ended', async () => {
    const { maria, omar } = await team();
    await expect(omar.hub({ action: 'team-rules-save', freeze: { hours: 2 } })).rejects.toThrow('Only an administrator');
    await expect(maria.hub({ action: 'team-rules-save', freeze: { hours: 0 } })).rejects.toThrow('A change freeze lasts a number of hours');
    const started = Date.now();
    const set = await maria.hub({ action: 'team-rules-save', freeze: { hours: 2, why: 'Release weekend' } });
    const freeze = set.teamRules?.freezes?.['*'];
    expect(freeze).toMatchObject({ by: 'Maria Ek', why: 'Release weekend' });
    expect(freeze!.until).toBeGreaterThanOrEqual(started + 2 * 3_600_000);
    expect((await omar.hub({ action: 'snapshot' })).teamRules?.freezes?.['*']?.why).toBe('Release weekend');

    const run = await runOn(omar);
    await expect(run.card('sudo systemctl restart nginx')).rejects.toThrow(/A change freeze holds on web-prod-01 until .*no change card and no file write is run there until then\. Commands still run/);
    // Nothing of the card was typed: not its check either.
    expect(run.ran).toEqual([]);
    const refused = run.task.changes.at(-1)!;
    expect(refused).toMatchObject({ status: 'denied', decidedHow: 'policy' });
    expect(refused.output).toMatch(/^A change freeze holds here until /);

    // A command still runs, whatever it does: nothing looks at what a command does.
    const looked = await run.ask('systemctl status nginx');
    expect(looked.exitCode).toBe(0);
    expect(run.ran.length).toBe(1);
    const ranAnyway = await run.ask('sudo systemctl restart nginx');
    expect(ranAnyway.exitCode).toBe(0);
    expect(run.ran.length).toBe(2);

    // Ended by the administrator: the same card is asked about again, as any change card in this mode.
    await maria.hub({ action: 'team-rules-save', endFreeze: '*' });
    expect((await omar.hub({ action: 'snapshot' })).teamRules?.freezes).toBeUndefined();
    void run.card('sudo systemctl restart nginx').catch(() => undefined);
    await until(() => run.task.changes.find((c) => c.status === 'pending'), 'the change is asked about again');
  });

  it('enforces the tag rule and its check requirement at execution', async () => {
    const { maria } = await team();
    await maria.hub({action:'safety-policy-save', policy:{clusterPolicies:{'tag:prod':{requireCheckAndRollback:true}}}});
    const run = await runOn(maria);
    const broker = maria.own.broker;
    const change = (over: Record<string, unknown>) => ({ id: 'c', kind: 'command', target: 'web-prod-01', description: 'x', status: 'pending', at: Date.now(), ...over }) as never;
    // A file write carries no check and no rollback: it is refused there.
    expect(() => broker.checkCurrentPolicy(run.task, change({ kind: 'file' }))).toThrow(/checked change/);
    // So is a call to a tool of another system.
    expect(() => broker.checkCurrentPolicy(run.task, change({ toolCall: true }))).toThrow(/checked change/);
    // A change card carries both.
    expect(() => broker.checkCurrentPolicy(run.task, change({ check: { command: 'a', expected: 'b' }, rollback: { command: 'c' } }))).not.toThrow();
    // A plain command is not a change: the rule does not hold it, and it runs.
    await expect(run.ask('sudo systemctl restart nginx')).resolves.toMatchObject({ exitCode: 0 });
    expect(run.ran).toHaveLength(1);
  });

  it('checks a freeze again after the person answers', async () => {
    const { maria, omar } = await team();
    const run = await runOn(omar);
    const pending = run.card('sudo systemctl restart nginx');
    const done = expect(pending).rejects.toThrow(/freeze/i);
    const change = await until(() => run.task.changes.find(c => c.status === 'pending'), 'an approval');
    await maria.hub({action:'team-rules-save', freeze:{hours:1}});
    await omar.hub({action:'approve', taskId:run.task.id, changeId:change.id, approved:true});
    await done;
    expect(run.ran).toHaveLength(0);
  });

  it('limits the only eligible administrator to a recorded one-change exception', async () => {
    const { maria } = await team();
    await maria.hub({action:'team-rules-save', requirePeerApprovalOnProd:true});
    const run = await runOn(maria);
    const pending = run.card('sudo systemctl restart nginx');
    const change = await until(() => run.task.changes.find(c => c.adminExceptionAvailable), 'an exception choice');
    const answer = {action:'approve' as const, taskId:run.task.id, changeId:change.id, approved:true};
    await expect(maria.hub(answer)).rejects.toThrow(/reason/i);
    await maria.hub({...answer, adminException:true, note:'Scheduled service repair'});
    await pending;
    // The check before, the change once, the check after.
    expect(run.ran).toHaveLength(3);
    const entries = await maria.own.audit().entries();
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ changeId:change.id, outcome:'intent', detail:'Scheduled service repair' })]));
  });

  it('freezes one cluster and leaves the others alone', async () => {
    const { maria, omar } = await team();
    await maria.invoke('profiles:save-ssh', { id: 'pg-prod-01', name: 'pg-prod-01', host: '10.30.70.31', port: 22, username: 'ops', authType: 'key', cluster: 'DB-Prod', shared: true });
    await maria.hub({ action: 'team-rules-save', freeze: { cluster: 'DB-Prod', hours: 1 } });
    await omar.hub({ action: 'snapshot' });
    const frozen = (label: string): number | undefined => omar.own.resolveSafetyContext({} as never, label).clusterPolicy?.frozenUntil;
    await until(() => (frozen('pg-prod-01') ? true : undefined), 'the database cluster is frozen for the member');
    expect(frozen('web-prod-01')).toBeUndefined();
    expect((await omar.hub({ action: 'snapshot' })).teamRules?.freezes).toHaveProperty('db-prod');
  });

  it('lets a member change their own rules, and refuses only what is the administrator\'s', async () => {
    const { omar } = await team();
    // The whole set, as a settings page that shows every switch would send it: nothing but one switch moved.
    const whole = { requireApprovalOnProdTags: true, requirePeerApprovalOnProd: false, clusterPolicies: {} };
    const saved = await omar.hub({ action: 'safety-policy-save', policy: whole });
    expect(saved.safetyPolicy).toEqual({ requireApprovalOnProdTags: true, requirePeerApprovalOnProd: false, clusterPolicies: {} });
    // An older window still sends the switches about commands: a member is not refused for them, and none is kept.
    const older = await omar.hub({ action: 'safety-policy-save', policy: { ...whole, autoApproveSafeReadOnly: false, blockDestructiveWithoutConfirm: false, commandAllowPrefixes: ['rm'] } as never });
    expect(older.safetyPolicy).toEqual({ requireApprovalOnProdTags: true, requirePeerApprovalOnProd: false, clusterPolicies: {} });
    // Their own two-person rule is theirs to switch on and off again.
    await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: true } });
    expect((await omar.hub({ action: 'safety-policy-save', policy: { requirePeerApprovalOnProd: false } })).safetyPolicy?.requirePeerApprovalOnProd).toBeFalsy();
    await expect(omar.hub({ action: 'safety-policy-save', policy: { clusterPolicies: { 'web-prod-01': { maxMode: 'autonomous' } } } })).rejects.toThrow('Only an administrator of this server changes cluster policies on a shared server');
    await expect(omar.hub({ action: 'safety-policy-save', policy: { requireApprovalOnProdTags: false } })).rejects.toThrow('Only an administrator of this server switches off');
  });

  it('reads a rules file an older version wrote, and keeps none of what it said about commands', async () => {
    // The server of every test starts empty. This one starts again over a file as an older version may have left it.
    await server.stop();
    const file = path.join(tmpDir, 'shared-workspace', 'team-rules.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ requirePeerApprovalOnProd: true, blockDestructiveWithoutConfirm: true, autoApproveSafeReadOnly: false, commandAllowPrefixes: ['rm -rf'], changedBy: 'Maria Ek', changedAt: 1_700_000_000_000 }),
    );
    server = new Sshs3WebServer({ port: 0, host: '127.0.0.1', dataDir: tmpDir, staticDir: path.join(tmpDir, 'static') });
    const info = await server.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
    wsBaseUrl = `ws://127.0.0.1:${info.port}`;

    const { maria, omar } = await team();
    // It loaded: the rule it did hold is in force, and nothing of the rest is shown to anybody.
    for (const who of [maria, omar]) {
      const snap = await who.hub({ action: 'snapshot' });
      expect(snap.teamRules).toEqual({ requirePeerApprovalOnProd: true, changedBy: 'Maria Ek', changedAt: 1_700_000_000_000, canChange: who === maria });
      expect(snap.safetyPolicy).toEqual({ requireApprovalOnProdTags: true, requirePeerApprovalOnProd: true });
    }
    // The next save writes the file as this version knows it.
    await maria.hub({ action: 'team-rules-save', freeze: { hours: 1 } });
    const kept = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(kept).sort()).toEqual(['changedAt', 'changedBy', 'freezes', 'requirePeerApprovalOnProd']);
  });
});
