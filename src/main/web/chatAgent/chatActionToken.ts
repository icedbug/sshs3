import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ChatServiceName } from '../../../shared/types/aiHub';
import { decryptSecretValue, encryptSecretValue } from '../../crypto/SecretFieldCrypto';
import { writeFileAtomic } from '../../storage/atomicFile';

/**
 * What an Approve or Deny button in a chat thread carries. The chat service hands the value back when
 * somebody presses it, and anybody who can post to the bot's socket or action address could send one,
 * so it is signed: it names the one thread, card, conversation and change or plan it answers, what it
 * answers with, and until when. Who pressed it is not in it: the chat service says that, and the
 * caller looks that person up.
 *
 * Short keys, because a Slack button value is at most 2000 characters.
 */
export interface ChatActionPayload {
  v: 1;
  /** The chat service. */
  svc: ChatServiceName;
  /** The channel the card was posted in. */
  ch: string;
  /** The thread the card was posted in. */
  th: string;
  /** The card's own post. */
  card: string;
  /** Whose hub the conversation runs in: the chat agent's, or a linked person's own. */
  hub: 'agent' | `user:${string}`;
  /** The conversation. */
  task: string;
  /** The change or the plan. */
  id: string;
  kind: 'change' | 'plan';
  act: 'approve' | 'deny';
  /** Unix time in milliseconds after which the button does nothing. */
  exp: number;
}

export type ChatActionCheck =
  | { ok: true; payload: ChatActionPayload }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired'; message: string };

/** A button is good for a day: a change that waits longer is answered in sshs3, or posted again. */
export const CHAT_ACTION_TTL_MS = 24 * 3600_000;
const MAX_TOKEN_LENGTH = 1900;

const mac = (secret: Buffer, body: string): Buffer => crypto.createHmac('sha256', secret).update(body, 'utf8').digest();

/** The payload in a fixed key order, so the same answer always signs the same way. */
function compact(p: ChatActionPayload): string {
  return JSON.stringify({ v: p.v, svc: p.svc, ch: p.ch, th: p.th, card: p.card, hub: p.hub, task: p.task, id: p.id, kind: p.kind, act: p.act, exp: p.exp });
}

export function signChatAction(
  secret: Buffer,
  payload: Omit<ChatActionPayload, 'v' | 'exp'> & { exp?: number },
  now = Date.now(),
): string {
  if (secret.length < 32) throw new Error('The signing secret is too short.');
  const full: ChatActionPayload = { ...payload, v: 1, exp: payload.exp ?? now + CHAT_ACTION_TTL_MS };
  if (!wellFormed(full)) throw new Error('That button cannot be made: a part of it is missing.');
  const body = Buffer.from(compact(full), 'utf8').toString('base64url');
  const token = `${body}.${mac(secret, body).toString('base64url')}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('That button would be too long for the chat service.');
  return token;
}

const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

function wellFormed(p: Partial<ChatActionPayload> | null | undefined): p is ChatActionPayload {
  return Boolean(
    p &&
      p.v === 1 &&
      (p.svc === 'slack' || p.svc === 'mattermost') &&
      text(p.ch) &&
      text(p.th) &&
      text(p.card) &&
      (p.hub === 'agent' || (text(p.hub) && /^user:[A-Za-z0-9_-]+$/.test(p.hub))) &&
      text(p.task) &&
      text(p.id) &&
      (p.kind === 'change' || p.kind === 'plan') &&
      (p.act === 'approve' || p.act === 'deny') &&
      typeof p.exp === 'number' &&
      Number.isFinite(p.exp),
  );
}

/**
 * Whether a button's value is one this server signed and is still good. The signature is checked
 * first, in constant time, and nothing in the value is read before it matches. The caller still checks
 * that the press came from the channel, thread and post the value names.
 */
export function verifyChatAction(secret: Buffer, token: unknown, now = Date.now()): ChatActionCheck {
  const malformed: ChatActionCheck = { ok: false, reason: 'malformed', message: 'That button is not one of ours.' };
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return malformed;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return malformed;
  const [body, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(signature)) return malformed;
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(secret, body);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return { ok: false, reason: 'signature', message: 'That button is not one of ours.' };
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return malformed;
  }
  if (!wellFormed(payload as Partial<ChatActionPayload>)) return malformed;
  const checked = payload as ChatActionPayload;
  if (checked.exp <= now)
    return { ok: false, reason: 'expired', message: 'This button is too old. Answer in sshs3 instead.' };
  return { ok: true, payload: checked };
}

/** What the thread map keeps of a card: who answered it from the chat, and when. */
export interface ChatCardAnswers {
  answered?: Record<string, number>;
}

/**
 * A press counts once per person per card. Records it and says true the first time; false when this
 * chat user already answered this card (a second press, or a replayed button value).
 */
export function claimChatAction(card: ChatCardAnswers, chatUserId: string, now = Date.now()): boolean {
  if (!chatUserId) return false;
  const answered = (card.answered ??= {});
  if (Object.prototype.hasOwnProperty.call(answered, chatUserId)) return false;
  answered[chatUserId] = now;
  return true;
}

/**
 * The key buttons are signed with. Random, made once, and kept encrypted in `<dir>/action-secret.json`, a
 * file nothing else writes: a writer of other settings that worked from an older copy could otherwise
 * drop it, and every button already posted would stop working. A key that cannot be read here any more
 * (the file came from another machine) is replaced: buttons already posted then do nothing, and a new
 * card is posted when asked.
 *
 * Read once per folder and process: callers at the same time share one load, so a signer and a
 * verifier never hold two different keys.
 */
export function loadChatActionSecret(dir: string): Promise<Buffer> {
  const key = path.resolve(dir);
  let loading = secrets.get(key);
  if (!loading) {
    loading = readOrMakeSecret(key).catch((err: unknown) => {
      secrets.delete(key);
      throw err;
    });
    secrets.set(key, loading);
  }
  return loading;
}

const secrets = new Map<string, Promise<Buffer>>();

async function readOrMakeSecret(dir: string): Promise<Buffer> {
  const file = path.join(dir, 'action-secret.json');
  let kept: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, '') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) kept = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (typeof kept.secret === 'string') {
    const plain = decryptSecretValue(kept.secret);
    const secret = plain ? Buffer.from(plain, 'base64url') : Buffer.alloc(0);
    if (secret.length >= 32) return secret;
  }
  const secret = crypto.randomBytes(32);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify({ version: 1, secret: encryptSecretValue(secret.toString('base64url')) }, null, 2), { mode: 0o600 });
  return secret;
}
