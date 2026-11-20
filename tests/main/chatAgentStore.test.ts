import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ChatAgentStore, LINK_CODE_TTL_MS, THREAD_IDLE_MS, type ChatThread } from '../../src/main/web/chatAgent/ChatAgentStore';

/**
 * Who in chat is who in sshs3, and which chat thread is which conversation. A person links their chat
 * account with a short code made in sshs3; the server keeps only its hash, for ten minutes, and stops a
 * chat user who keeps guessing.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-20T12:00:00Z');

async function store() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-chat-store-'));
  dirs.push(dir);
  const clock = { now: NOW };
  // Accounts that are turned off or removed: the server's word, as WebServer gives it.
  const off = new Set<string>();
  const options = { usable: (id: string) => !off.has(id), clock: () => clock.now };
  const made = new ChatAgentStore(dir, options);
  await made.initialize();
  const again = async () => {
    const read = new ChatAgentStore(dir, options);
    await read.initialize();
    return read;
  };
  return { dir, clock, off, store: made, again };
}

const thread = (over: Partial<ChatThread> = {}): Omit<ChatThread, 'lastAt'> => ({
  owner: 'agent',
  taskId: 'task-1',
  cards: {},
  askedBy: { chatUserId: 'U-OMAR', name: 'Omar Lind' },
  ...over,
});

describe('linking a chat account', () => {
  it('keeps a code for ten minutes and a quiet thread for 30 days', () => {
    expect(LINK_CODE_TTL_MS).toBe(10 * 60_000);
    expect(THREAD_IDLE_MS).toBe(30 * 24 * 3600_000);
  });

  it('links with a code that is good for ten minutes, once, and keeps only its hash', async () => {
    const { dir, clock, store: s, again } = await store();
    const { code, expiresAt } = await s.linkCode('usr_maria', 'slack');
    expect(code).toMatch(/^[A-Z2-7]{8}$/);
    expect(expiresAt).toBe(NOW + LINK_CODE_TTL_MS);
    const file = await fs.readFile(path.join(dir, 'chat-agent', 'links.json'), 'utf8');
    expect(file).not.toContain(code);
    expect(JSON.parse(file).codes).toEqual([{ hash: expect.stringMatching(/^[a-f0-9]{64}$/), accountId: 'usr_maria', service: 'slack', expiresAt }]);

    // A code for Slack is not one for Mattermost.
    expect(await s.redeem('mattermost', 'mm-maria', 'maria', code)).toMatchObject({ ok: false, reason: 'wrong' });
    // Typed the way people copy it: lower case, with a space.
    clock.now += 60_000;
    const typed = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`;
    const linked = await s.redeem('slack', 'U-MARIA', 'Maria Ek', typed);
    expect(linked).toEqual({ ok: true, replaced: [], link: { service: 'slack', chatUserId: 'U-MARIA', chatName: 'Maria Ek', accountId: 'usr_maria', linkedAt: NOW + 60_000 } });
    expect(s.linkOf('slack', 'U-MARIA')).toMatchObject({ accountId: 'usr_maria' });
    // Used once: the same code again is wrong.
    expect(await s.redeem('slack', 'U-OMAR', 'Omar', code)).toMatchObject({ ok: false, reason: 'wrong' });
    // Kept: a restart reads the link back.
    const read = await again();
    expect(read.linkOf('slack', 'U-MARIA')).toMatchObject({ accountId: 'usr_maria', chatName: 'Maria Ek' });
    expect(read.linksOf('usr_maria')).toHaveLength(1);
  });

  it('lets a code end after ten minutes', async () => {
    const { clock, store: s } = await store();
    const { code } = await s.linkCode('usr_maria', 'slack');
    clock.now += 10 * 60_000;
    expect(await s.redeem('slack', 'U-MARIA', 'Maria Ek', code)).toMatchObject({ ok: false, reason: 'wrong' });
    expect(s.linkOf('slack', 'U-MARIA')).toBeUndefined();
  });

  it('keeps one live code per account and service', async () => {
    const { store: s } = await store();
    const first = await s.linkCode('usr_maria', 'slack');
    const other = await s.linkCode('usr_maria', 'mattermost');
    const second = await s.linkCode('usr_maria', 'slack');
    expect(await s.redeem('slack', 'U-MARIA', 'Maria Ek', first.code)).toMatchObject({ ok: false, reason: 'wrong' });
    expect(await s.redeem('slack', 'U-MARIA', 'Maria Ek', second.code)).toMatchObject({ ok: true });
    // The code for the other service still works.
    expect(await s.redeem('mattermost', 'mm-maria', 'maria', other.code)).toMatchObject({ ok: true });
    expect(s.linksOf('usr_maria').map((l) => l.service).sort()).toEqual(['mattermost', 'slack']);
  });

  it('stops a chat user after five wrong codes in ten minutes, even with the right one', async () => {
    const { clock, store: s } = await store();
    const { code } = await s.linkCode('usr_maria', 'slack');
    for (let i = 0; i < 5; i++) expect(await s.redeem('slack', 'U-GUESS', 'guess', `AAAAAAA${i + 2}`)).toMatchObject({ ok: false, reason: 'wrong' });
    expect(await s.redeem('slack', 'U-GUESS', 'guess', code)).toMatchObject({ ok: false, reason: 'limited' });
    // Somebody else is not held up by it.
    expect(await s.redeem('slack', 'U-MARIA', 'Maria Ek', code)).toMatchObject({ ok: true });
    // Ten minutes later the guesser may try again.
    clock.now += 10 * 60_000 + 1;
    const fresh = await s.linkCode('usr_omar', 'slack');
    expect(await s.redeem('slack', 'U-GUESS', 'Omar Lind', fresh.code)).toMatchObject({ ok: true, link: { accountId: 'usr_omar' } });
  });

  it('does not let a right code of their own wipe out the wrong ones', async () => {
    const { store: s } = await store();
    // Omar can make codes for his own account. Four guesses, his own code, and one guess more.
    for (let i = 0; i < 4; i++) expect(await s.redeem('slack', 'U-OMAR', 'Omar Lind', `AAAAAAA${i + 2}`)).toMatchObject({ ok: false, reason: 'wrong' });
    expect(await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code)).toMatchObject({ ok: true });
    expect(await s.redeem('slack', 'U-OMAR', 'Omar Lind', 'AAAAAAA6')).toMatchObject({ ok: false, reason: 'wrong' });
    // That is five in ten minutes: even Maria's right code is not looked at.
    const maria = await s.linkCode('usr_maria', 'slack');
    expect(await s.redeem('slack', 'U-OMAR', 'Omar Lind', maria.code)).toMatchObject({ ok: false, reason: 'limited' });
  });

  it('voids a code written where others can read it', async () => {
    const { store: s } = await store();
    const { code } = await s.linkCode('usr_maria', 'slack');
    expect(await s.voidCode('slack', code)).toBe(true);
    expect(await s.voidCode('slack', code)).toBe(false);
    expect(await s.redeem('slack', 'U-MARIA', 'Maria Ek', code)).toMatchObject({ ok: false, reason: 'wrong' });
  });

  it('replaces an older link when somebody links again', async () => {
    const { store: s } = await store();
    await s.redeem('slack', 'U-MARIA', 'Maria Ek', (await s.linkCode('usr_maria', 'slack')).code);
    // The same chat user links to another account: one link for that chat user.
    const moved = await s.redeem('slack', 'U-MARIA', 'Maria Ek', (await s.linkCode('usr_omar', 'slack')).code);
    expect(moved).toMatchObject({ ok: true, link: { accountId: 'usr_omar' }, replaced: [{ chatUserId: 'U-MARIA', accountId: 'usr_maria' }] });
    // The account links another chat user: one link for that account.
    const other = await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code);
    expect(other).toMatchObject({ ok: true, replaced: [{ chatUserId: 'U-MARIA', accountId: 'usr_omar' }] });
    expect(s.allLinks()).toEqual([expect.objectContaining({ chatUserId: 'U-OMAR', accountId: 'usr_omar' })]);
  });

  it('counts a turned off account as not linked, always', async () => {
    const { off, store: s } = await store();
    await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code);
    off.add('usr_omar');
    expect(s.linkOf('slack', 'U-OMAR')).toBeUndefined();
    expect(s.linksOf('usr_omar')).toEqual([]);
    off.clear();
    expect(s.linkOf('slack', 'U-OMAR')).toMatchObject({ accountId: 'usr_omar' });
  });

  it('links nobody with a code made before its account was turned off, and uses the code up', async () => {
    const { off, store: s } = await store();
    const { code } = await s.linkCode('usr_omar', 'slack');
    off.add('usr_omar');
    expect(await s.redeem('slack', 'U-OMAR', 'Omar Lind', code)).toMatchObject({ ok: false, reason: 'unusable' });
    expect(s.allLinks()).toEqual([]);
    // Turned on again, the old code is gone all the same.
    off.clear();
    expect(await s.redeem('slack', 'U-OMAR', 'Omar Lind', code)).toMatchObject({ ok: false, reason: 'wrong' });
  });

  it('lets a person unlink their own, an administrator anybody\'s, and nobody else', async () => {
    const { store: s, again } = await store();
    await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code);
    await s.redeem('slack', 'U-LINA', 'Lina Berg', (await s.linkCode('usr_lina', 'slack')).code);
    await expect(s.unlink({ service: 'slack', chatUserId: 'U-OMAR' }, { accountId: 'usr_lina', admin: false })).rejects.toThrow('only unlink your own');
    expect(await s.unlink({ service: 'slack', accountId: 'usr_omar' }, { accountId: 'usr_omar', admin: false })).toBe(true);
    expect(await s.unlink({ service: 'slack', chatUserId: 'U-LINA' }, { accountId: 'usr_maria', admin: true })).toBe(true);
    expect(await s.unlink({ service: 'slack', chatUserId: 'U-LINA' }, { accountId: 'usr_maria', admin: true })).toBe(false);
    expect(s.allLinks()).toEqual([]);
    // Kept: a restart does not bring the links back.
    expect((await again()).allLinks()).toEqual([]);
  });

  it('forgets a removed account: its links and its codes', async () => {
    const { store: s, again } = await store();
    await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code);
    const pending = await s.linkCode('usr_omar', 'mattermost');
    await s.redeem('slack', 'U-LINA', 'Lina Berg', (await s.linkCode('usr_lina', 'slack')).code);
    await s.forgetAccount('usr_omar');
    expect(s.linkOf('slack', 'U-OMAR')).toBeUndefined();
    expect(await s.redeem('mattermost', 'mm-omar', 'omar', pending.code)).toMatchObject({ ok: false });
    expect(s.linkOf('slack', 'U-LINA')).toMatchObject({ accountId: 'usr_lina' });
    const read = await again();
    expect(read.linkOf('slack', 'U-OMAR')).toBeUndefined();
    expect(read.linkOf('slack', 'U-LINA')).toMatchObject({ accountId: 'usr_lina' });
  });

  it('keeps its files to the server alone', async () => {
    if (process.platform === 'win32') return;
    const { dir, store: s } = await store();
    await s.linkCode('usr_maria', 'slack');
    await s.setThread('slack', 'C-OPS', '1.0', thread());
    expect((await fs.stat(path.join(dir, 'chat-agent'))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, 'chat-agent', 'links.json'))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.join(dir, 'chat-agent', 'threads.json'))).mode & 0o777).toBe(0o600);
    // Written whole: no temporary files left behind.
    expect((await fs.readdir(path.join(dir, 'chat-agent'))).sort()).toEqual(['links.json', 'threads.json']);
  });
});

describe('the thread map', () => {
  it('finds a thread again, counts a card once per person, and forgets threads idle for 30 days', async () => {
    const { clock, store: s, again } = await store();
    await s.setThread('slack', 'C-OPS', '1.0', thread({ cards: { 'change-1': { post: '1.2', kind: 'change', answered: {} } } }));
    await s.setThread('mattermost', 'town', 'root-1', thread({ owner: 'agent', taskId: 'task-2' }));
    expect(s.thread('slack', 'C-OPS', '1.0')).toMatchObject({ owner: 'agent', taskId: 'task-1', lastAt: NOW });
    expect(s.thread('slack', 'C-OPS', '2.0')).toBeUndefined();

    clock.now += 1000;
    expect(await s.claimCard('slack', 'C-OPS', '1.0', 'change-1', 'U-MARIA')).toBe(true);
    // Kept at once: after a restart a replayed press is not counted again.
    expect(await (await again()).claimCard('slack', 'C-OPS', '1.0', 'change-1', 'U-MARIA')).toBe(false);
    expect(await s.claimCard('slack', 'C-OPS', '1.0', 'change-1', 'U-MARIA')).toBe(false);
    expect(await s.claimCard('slack', 'C-OPS', '1.0', 'change-2', 'U-MARIA')).toBe(false);
    expect(s.thread('slack', 'C-OPS', '1.0')).toMatchObject({ lastAt: NOW + 1000, cards: { 'change-1': { answered: { 'U-MARIA': NOW + 1000 } } } });
    // A card that shows its outcome takes no more answers.
    const kept = s.thread('slack', 'C-OPS', '1.0')!;
    kept.cards['change-1'].final = true;
    await s.setThread('slack', 'C-OPS', '1.0', kept);
    expect(await s.claimCard('slack', 'C-OPS', '1.0', 'change-1', 'U-LINA')).toBe(false);
    // What is read back is a copy: changing it changes nothing kept.
    kept.taskId = 'other';
    expect(s.thread('slack', 'C-OPS', '1.0')?.taskId).toBe('task-1');

    // The Slack thread was written in a moment ago; the Mattermost one 30 days ago.
    clock.now = NOW + THREAD_IDLE_MS + 500;
    expect(await s.pruneThreads()).toBe(1);
    expect(s.thread('mattermost', 'town', 'root-1')).toBeUndefined();
    expect(s.thread('slack', 'C-OPS', '1.0')).toBeDefined();
    const read = await again();
    expect(read.thread('mattermost', 'town', 'root-1')).toBeUndefined();
    expect(read.thread('slack', 'C-OPS', '1.0')).toMatchObject({ taskId: 'task-1' });
  });

  it('keeps a thread that was quiet for 29 days', async () => {
    const { clock, store: s } = await store();
    await s.setThread('slack', 'C-OPS', '1.0', thread());
    clock.now = NOW + 29 * 24 * 3600_000;
    expect(await s.pruneThreads()).toBe(0);
    expect(s.thread('slack', 'C-OPS', '1.0')).toBeDefined();
    clock.now = NOW + 30 * 24 * 3600_000;
    expect(await s.pruneThreads()).toBe(1);
  });

  it('gives an answer back when it was refused, so the person can answer again', async () => {
    const { store: s, again } = await store();
    await s.setThread('slack', 'C-OPS', '1.0', thread({ cards: { 'change-1': { post: '1.2', kind: 'change', answered: {} } } }));
    expect(await s.claimCard('slack', 'C-OPS', '1.0', 'change-1', 'U-MARIA')).toBe(true);
    expect(await s.claimCard('slack', 'C-OPS', '1.0', 'change-1', 'U-LINA')).toBe(true);
    await s.releaseCard('slack', 'C-OPS', '1.0', 'change-1', 'U-MARIA');
    // Kept: a restart reads the released answer back as not given, and Lina's as given.
    const read = await again();
    expect(read.thread('slack', 'C-OPS', '1.0')?.cards['change-1'].answered).toEqual({ 'U-LINA': NOW });
    expect(await s.claimCard('slack', 'C-OPS', '1.0', 'change-1', 'U-MARIA')).toBe(true);
    // Nothing to give back: no change.
    await s.releaseCard('slack', 'C-OPS', '1.0', 'change-2', 'U-MARIA');
    await s.releaseCard('slack', 'C-OPS', '9.9', 'change-1', 'U-MARIA');
  });
});

describe('a conversation in a person\'s own hub', () => {
  /** Omar is linked on Slack, and his direct message runs in his own hub. */
  async function omarsDm() {
    const made = await store();
    await made.store.redeem('slack', 'U-OMAR', 'Omar Lind', (await made.store.linkCode('usr_omar', 'slack')).code);
    await made.store.setThread('slack', 'D-OMAR', '5.0', thread({ owner: 'user:usr_omar', taskId: 'dm-1' }));
    // A channel thread he asked in runs in the chat agent's hub: it is never his.
    await made.store.setThread('slack', 'C-OPS', '6.0', thread({ owner: 'agent', taskId: 'channel-1' }));
    expect(made.store.thread('slack', 'D-OMAR', '5.0')).toMatchObject({ owner: 'user:usr_omar', taskId: 'dm-1' });
    return made;
  }

  it('is not found while his account is turned off', async () => {
    const { off, store: s } = await omarsDm();
    off.add('usr_omar');
    expect(s.thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
    expect(s.thread('slack', 'C-OPS', '6.0')).toMatchObject({ taskId: 'channel-1' });
    off.clear();
    expect(s.thread('slack', 'D-OMAR', '5.0')).toMatchObject({ taskId: 'dm-1' });
  });

  it('ends when he unlinks', async () => {
    const { store: s, again } = await omarsDm();
    await s.unlink({ service: 'slack', chatUserId: 'U-OMAR' }, { accountId: 'usr_omar', admin: false });
    expect(s.thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
    // Linked again, the old conversation is not taken up again: it was forgotten with the link.
    await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code);
    expect(s.thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
    expect((await again()).thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
    expect(s.thread('slack', 'C-OPS', '6.0')).toMatchObject({ taskId: 'channel-1' });
  });

  it('ends when his chat account is linked to somebody else\'s account', async () => {
    const { store: s, again } = await omarsDm();
    await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_lina', 'slack')).code);
    expect(s.thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
    expect((await again()).thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
  });

  it('ends when his account links another chat user', async () => {
    const { store: s } = await omarsDm();
    await s.redeem('slack', 'U-OTHER', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code);
    expect(s.thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
  });

  it('carries on when he links the same account again', async () => {
    const { store: s } = await omarsDm();
    await s.redeem('slack', 'U-OMAR', 'Omar Lind', (await s.linkCode('usr_omar', 'slack')).code);
    expect(s.thread('slack', 'D-OMAR', '5.0')).toMatchObject({ taskId: 'dm-1' });
  });

  it('is forgotten with his account', async () => {
    const { store: s, again } = await omarsDm();
    await s.forgetAccount('usr_omar');
    expect(s.thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
    const read = await again();
    expect(read.thread('slack', 'D-OMAR', '5.0')).toBeUndefined();
    expect(read.thread('slack', 'C-OPS', '6.0')).toMatchObject({ taskId: 'channel-1' });
    // Gone from the file, not only hidden.
    expect(JSON.stringify(JSON.parse(await fs.readFile(path.join(read.dir, 'threads.json'), 'utf8')))).not.toContain('usr_omar');
  });
});
