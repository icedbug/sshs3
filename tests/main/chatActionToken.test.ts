import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => {
  const shim = await import('../../src/main/web/electronShim');
  return shim;
});

import { setHeadlessUserDataPath } from '../../src/main/web/electronShim';
import { decryptSecretValue } from '../../src/main/crypto/SecretFieldCrypto';
import {
  CHAT_ACTION_TTL_MS,
  claimChatAction,
  loadChatActionSecret,
  signChatAction,
  verifyChatAction,
  type ChatActionPayload,
} from '../../src/main/web/chatAgent/chatActionToken';

/**
 * An Approve or Deny button in a chat thread. Anybody who can reach the bot could send a button's
 * value, so it is signed by the server, names the one thread, card and change it answers, ends, and
 * is counted once per person per card.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const NOW = Date.parse('2026-11-20T12:00:00Z');
const SECRET = crypto.randomBytes(32);
const BUTTON: Omit<ChatActionPayload, 'v' | 'exp'> = {
  svc: 'slack',
  ch: 'C-OPS',
  th: '1700000000.000100',
  card: '1700000000.000200',
  hub: 'agent',
  task: 'task-1',
  id: 'change-1',
  kind: 'change',
  act: 'approve',
};

const body = (token: string): Record<string, unknown> => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
const withBody = (token: string, next: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify(next), 'utf8').toString('base64url')}.${token.split('.')[1]}`;

describe('signed chat buttons', () => {
  it('reads back what it signed, until it ends', () => {
    const token = signChatAction(SECRET, BUTTON, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThan(2000);
    const check = verifyChatAction(SECRET, token, NOW + 1000);
    expect(check).toEqual({ ok: true, payload: { ...BUTTON, v: 1, exp: NOW + CHAT_ACTION_TTL_MS } });
    expect(verifyChatAction(SECRET, token, NOW + CHAT_ACTION_TTL_MS)).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a value somebody made up, or changed', () => {
    const token = signChatAction(SECRET, BUTTON, NOW);
    // Approve turned into an answer for another change, or for another hub: the signature no longer fits.
    expect(verifyChatAction(SECRET, withBody(token, { ...body(token), id: 'change-2' }), NOW)).toMatchObject({ ok: false, reason: 'signature' });
    expect(verifyChatAction(SECRET, withBody(token, { ...body(token), hub: 'user:usr_maria' }), NOW)).toMatchObject({ ok: false, reason: 'signature' });
    expect(verifyChatAction(SECRET, withBody(token, { ...body(token), exp: NOW + 10 * CHAT_ACTION_TTL_MS }), NOW)).toMatchObject({ ok: false, reason: 'signature' });
    // A value signed with a key of its own.
    const forged = signChatAction(crypto.randomBytes(32), { ...BUTTON, act: 'deny' }, NOW);
    expect(verifyChatAction(SECRET, forged, NOW)).toMatchObject({ ok: false, reason: 'signature' });
    // A signature cut short, or none at all, or not a value of ours at all.
    expect(verifyChatAction(SECRET, `${token.split('.')[0]}.${token.split('.')[1].slice(0, 10)}`, NOW)).toMatchObject({ ok: false, reason: 'signature' });
    expect(verifyChatAction(SECRET, token.split('.')[0], NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyChatAction(SECRET, 'approve', NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyChatAction(SECRET, undefined, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyChatAction(SECRET, `${token}.x`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('refuses a signed value that is not a whole button', () => {
    // Signed with the right key, but something is missing or of the wrong kind: never taken.
    const sign = (payload: Record<string, unknown>): string => {
      const b = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      return `${b}.${crypto.createHmac('sha256', SECRET).update(b).digest('base64url')}`;
    };
    const good = { ...BUTTON, v: 1, exp: NOW + 1000 };
    expect(verifyChatAction(SECRET, sign(good), NOW)).toMatchObject({ ok: true });
    expect(verifyChatAction(SECRET, sign({ ...good, act: 'run' }), NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyChatAction(SECRET, sign({ ...good, hub: 'user:../../x' }), NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyChatAction(SECRET, sign({ ...good, v: 2 }), NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    const { task: _task, ...noTask } = good;
    expect(verifyChatAction(SECRET, sign(noTask), NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(() => signChatAction(SECRET, { ...BUTTON, ch: '' }, NOW)).toThrow();
    expect(() => signChatAction(Buffer.alloc(8), BUTTON, NOW)).toThrow();
  });

  it('counts a press once per person per card', () => {
    const card: { answered?: Record<string, number> } = {};
    expect(claimChatAction(card, 'U-MARIA', NOW)).toBe(true);
    // The same person again, or the same value replayed: not counted.
    expect(claimChatAction(card, 'U-MARIA', NOW + 5)).toBe(false);
    // Somebody else is a person of their own.
    expect(claimChatAction(card, 'U-LINA', NOW + 6)).toBe(true);
    expect(claimChatAction(card, '', NOW + 7)).toBe(false);
    expect(card.answered).toEqual({ 'U-MARIA': NOW, 'U-LINA': NOW + 6 });
  });

  it('refuses a value too long to be one of ours, before anything else', () => {
    expect(verifyChatAction(SECRET, `${'A'.repeat(1901)}.B`, NOW)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('keeps its key encrypted in a file of its own, and makes it once', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-chat-token-'));
    dirs.push(dir);
    setHeadlessUserDataPath(dir);
    const where = path.join(dir, 'chat-agent');
    // Other settings of the chat agent's are in a file of their own, which this never writes.
    await fs.mkdir(where, { recursive: true });
    const settings = JSON.stringify({ version: 1, limits: { perPerson: 10 } });
    await fs.writeFile(path.join(where, 'answering.json'), settings);
    // Asked for twice at once on a first start: one key, not two.
    const [first, same] = await Promise.all([loadChatActionSecret(where), loadChatActionSecret(where)]);
    expect(first.length).toBe(32);
    expect(same.equals(first)).toBe(true);
    expect(await fs.readFile(path.join(where, 'answering.json'), 'utf8')).toBe(settings);
    const kept = JSON.parse(await fs.readFile(path.join(where, 'action-secret.json'), 'utf8'));
    expect(kept.secret).toMatch(/^enc:v1:/);
    expect(kept.secret).not.toContain(first.toString('base64url'));
    if (process.platform !== 'win32') expect((await fs.stat(path.join(where, 'action-secret.json'))).mode & 0o777).toBe(0o600);
    // What is kept is that key: buttons already posted keep working after a restart.
    expect(Buffer.from(decryptSecretValue(kept.secret), 'base64url').equals(first)).toBe(true);
    const again = await loadChatActionSecret(where);
    expect(again.equals(first)).toBe(true);
    const token = signChatAction(first, BUTTON, NOW);
    expect(verifyChatAction(again, token, NOW)).toMatchObject({ ok: true });
  });

  it('replaces a key that cannot be read here any more', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-chat-token-'));
    dirs.push(dir);
    setHeadlessUserDataPath(dir);
    const where = path.join(dir, 'chat-agent');
    await fs.mkdir(where, { recursive: true });
    // Encrypted on another machine: it does not decrypt here.
    await fs.writeFile(path.join(where, 'action-secret.json'), JSON.stringify({ version: 1, secret: 'enc:v1:AAAA' }));
    const secret = await loadChatActionSecret(where);
    expect(secret.length).toBe(32);
    const kept = JSON.parse(await fs.readFile(path.join(where, 'action-secret.json'), 'utf8'));
    expect(kept.secret).toMatch(/^enc:v1:/);
    expect(kept.secret).not.toBe('enc:v1:AAAA');
    expect(Buffer.from(decryptSecretValue(kept.secret), 'base64url').equals(secret)).toBe(true);
  });
});
