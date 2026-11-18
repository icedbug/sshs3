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
import type { HubRequest, HubSnapshot } from '../../src/shared/types/aiHub';

/**
 * Two people with accounts on one sshS3 web server, and no team bucket.
 *
 * What a team shares, they share: one board, one set of agents, one knowledge base. What is a
 * person's own stays that person's: the model and its key, the safety rules, the conversations.
 * Each account is asked the way its browser asks: over its own websocket.
 */
describe('two accounts on one web server, without a bucket', () => {
  let tmpDir: string;
  let server: Sshs3WebServer;
  let baseUrl: string;
  let wsBaseUrl: string;
  const closers: Array<() => void> = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-two-users-'));
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

  /** An account's own way to its hub, as its browser has it. */
  async function browser(cookie: string): Promise<{ hub: (request: HubRequest) => Promise<HubSnapshot>; changes: () => number }> {
    const { ticket } = (await post('/api/ws-ticket', {}, cookie)).body;
    const ws = new WebSocket(`${wsBaseUrl}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let seq = 1;
    let changes = 0;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'response' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      } else if (msg.type === 'event' && msg.channel === 'ai-hub:changed') changes++;
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('websocket failed'));
    });
    closers.push(() => ws.close());
    return {
      hub: (request) =>
        new Promise((resolve, reject) => {
          const id = `r${seq++}`;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ type: 'invoke', id, channel: 'ai-hub:request', args: [request] }));
        }),
      changes: () => changes,
    };
  }

  async function twoAccounts() {
    const admin = await post('/api/auth/setup', { username: 'maria', displayName: 'Maria Ek', password: 'maria-password-123' }); // pragma: allowlist secret
    const invite = (await post('/api/admin/invites', { role: 'member', maxUses: 1 }, admin.cookie)).body.invite.token;
    const member = await post('/api/auth/register-invite', { inviteToken: invite, username: 'omar', displayName: 'Omar Lind', password: 'omar-password-123' }); // pragma: allowlist secret
    return { maria: await browser(admin.cookie), omar: await browser(member.cookie) };
  }

  /** What the other account sees once it has been told: asked until it is there, for a moment at most. */
  async function seenBy<T>(who: { hub: (r: HubRequest) => Promise<HubSnapshot> }, read: (snap: HubSnapshot) => T | undefined): Promise<T> {
    const until = Date.now() + 4000;
    for (;;) {
      const found = read(await who.hub({ action: 'snapshot' }));
      if (found !== undefined) return found;
      if (Date.now() > until) throw new Error('The other account never saw it.');
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  it('gives both one board: a ticket one of them writes is the other\'s too, with its comments, until one removes it', async () => {
    const { maria, omar } = await twoAccounts();
    expect((await maria.hub({ action: 'snapshot' })).workBoardSync).toMatchObject({ shared: true, via: 'server' });
    expect((await omar.hub({ action: 'snapshot' })).workBoardSync).toMatchObject({ shared: true, via: 'server' });

    const told = omar.changes();
    await maria.hub({ action: 'ticket-save', ticket: { title: 'Renew the certificate on web-prod-01', description: 'It runs out on Friday.' } });
    // Omar's browser is told, and his board has it: within a moment, not at the next slow look.
    const started = Date.now();
    const his = await seenBy(omar, (snap) => snap.workTickets?.find((t) => t.title === 'Renew the certificate on web-prod-01'));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(his.description).toBe('It runs out on Friday.');
    expect(omar.changes()).toBeGreaterThan(told);

    // What he writes on it is hers too, under his name.
    await omar.hub({ action: 'ticket-comment', id: his.id, text: 'I will take it after lunch.' });
    const comment = await seenBy(maria, (snap) => snap.workTickets?.find((t) => t.id === his.id)?.comments?.find((c) => c.text === 'I will take it after lunch.'));
    expect(comment.author).toBe('Omar Lind');

    // Removed by one, gone for both.
    await maria.hub({ action: 'ticket-delete', id: his.id });
    await seenBy(omar, (snap) => (snap.workTickets?.some((t) => t.id === his.id) ? undefined : true));
  }, 30_000);

  it('gives both one set of agents and one knowledge base', async () => {
    const { maria, omar } = await twoAccounts();
    await maria.hub({
      action: 'agent-save',
      agent: { name: 'Certificate keeper', role: 'Certificates', mission: 'Keeps certificates from running out.', defaultMode: 'assisted', allowedTools: ['all'], enabled: true },
    } as HubRequest);
    const agent = await seenBy(omar, (snap) => snap.agents?.find((a) => a.name === 'Certificate keeper'));
    expect(agent).toMatchObject({ role: 'Certificates', defaultMode: 'assisted' });

    await omar.hub({ action: 'kb-ingest-text', title: 'How we renew certificates', text: 'certbot renew --dry-run first. Port 80 must be open for the challenge.' });
    const doc = await seenBy(maria, (snap) => snap.kbDocuments?.find((d) => d.title === 'How we renew certificates'));
    // She can open what he wrote.
    const read = await maria.hub({ action: 'kb-read', id: doc.id });
    expect(read.reply?.kbDocument?.content).toContain('Port 80 must be open for the challenge.');
  }, 30_000);

  it('keeps what is a person\'s own with that person: the model and its key, the safety rules, the conversations', async () => {
    const { maria, omar } = await twoAccounts();
    await maria.hub({ action: 'configure', config: { enabled: true, provider: 'openai-compatible', model: 'marias-model', baseUrl: 'https://93.184.216.34/v1', apiKey: 'marias-own-key' } });
    await maria.hub({ action: 'safety-policy-save', policy: { autoApproveSafeReadOnly: false, commandAllowPrefixes: ['df -h'] } });
    // Something on the board, so that Omar's hub has synced after all of the above.
    await maria.hub({ action: 'ticket-save', ticket: { title: 'A marker' } });
    await seenBy(omar, (snap) => snap.workTickets?.find((t) => t.title === 'A marker'));

    const his = await omar.hub({ action: 'snapshot' });
    expect(his.config.model).not.toBe('marias-model');
    expect(his.config.hasApiKey).toBe(false);
    expect(JSON.stringify(his)).not.toContain('marias-own-key');
    expect(his.safetyPolicy?.commandAllowPrefixes ?? []).not.toContain('df -h');
    expect(his.safetyPolicy?.autoApproveSafeReadOnly).not.toBe(false);
    // Her conversations are hers: none of them is in what he is sent.
    const hers = await maria.hub({ action: 'snapshot' });
    expect(hers.config.model).toBe('marias-model');
    expect(his.tasks.map((t) => t.id).filter((id) => hers.tasks.some((t) => t.id === id))).toEqual([]);
  }, 30_000);

  it('keeps the board in a folder of the server\'s own, one small file an item', async () => {
    const { maria, omar } = await twoAccounts();
    await maria.hub({ action: 'ticket-save', ticket: { title: 'Kept on the server' } });
    const ticket = await seenBy(omar, (snap) => snap.workTickets?.find((t) => t.title === 'Kept on the server'));
    const kept = await fs.readdir(path.join(tmpDir, 'shared-workspace', 'board', 'work', 'tickets'));
    expect(kept).toContain(`${ticket.id}.json`);
    // Nothing of either person's own account is in the shared folder.
    const all = await fs.readdir(path.join(tmpDir, 'shared-workspace', 'board', 'work'));
    expect(all.sort()).toEqual(expect.arrayContaining(['tickets']));
    for (const name of all) expect(['goals', 'tickets', 'agents', 'kb', 'edges', 'pages', 'evals', 'usage', 'pageuse', 'claims', 'once', 'facts']).toContain(name);
  }, 30_000);
});
