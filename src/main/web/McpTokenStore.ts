import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * The keys that let somebody's own agent reach this sshs3 over MCP.
 *
 * A key is shown once, when it is made, and never again: only its hash is
 * kept. It names the person it acts for, so everything done with it is done
 * as them and lands in their own workspace; and it carries what it may do —
 * which tools, and, where a command may be run, which one server. A key that
 * can do everything the person can do is not offered: the point of a separate
 * key is that it can do less.
 *
 * The file is this installation's own (0600) and is never shared with the
 * team: a key is a credential of one person on one machine.
 */

/** What a key may do. `read` is always allowed; the rest is opt-in. */
export type McpScope = 'read' | 'tickets' | 'run';
export const MCP_SCOPES: McpScope[] = ['read', 'tickets', 'run'];

export interface McpTokenRecord {
  id: string;
  userId: string;
  /** What a person called it, so a key can be recognised and revoked. */
  name: string;
  hash: string;
  scopes: McpScope[];
  /**
   * The one server a command from this key may touch, by its profile id.
   * Without it the key cannot run commands at all, whatever its scopes say:
   * a key that may run "wherever" is a key that may run anywhere.
   */
  serverId?: string;
  createdAt: number;
  createdBy: string;
  lastUsedAt?: number;
  /** How many calls were made with it, so an unused key shows. */
  uses?: number;
  expiresAt?: number;
  revokedAt?: number;
  /** Only these tools, when set: a key can be narrower than its scopes. */
  tools?: string[];
}

/** A key as it may be shown: never its secret, never its hash. */
export interface McpTokenView {
  id: string;
  name: string;
  scopes: McpScope[];
  serverId?: string;
  createdAt: number;
  createdBy: string;
  lastUsedAt?: number;
  uses: number;
  expiresAt?: number;
  expired: boolean;
  tools?: string[];
}

interface StoredTokens {
  version: 1;
  tokens: McpTokenRecord[];
}

const PREFIX = 's3k';
const MAX_PER_USER = 20;
const hashOf = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * The three parts of a key as it is written: `s3k_<user>.<id>.<secret>`. The
 * user and the key's id are there so that the right hash can be looked up
 * without comparing against every key there is.
 */
export function parseMcpToken(raw: string): { userId: string; id: string; secret: string } | undefined {
  const text = raw.trim();
  if (!text.startsWith(`${PREFIX}_`)) return undefined;
  const parts = text.slice(PREFIX.length + 1).split('.');
  if (parts.length !== 3) return undefined;
  const [userId, id, secret] = parts;
  if (!userId || !id || secret.length < 20) return undefined;
  return { userId, id, secret };
}

export const tokenView = (t: McpTokenRecord, now = Date.now()): McpTokenView => ({
  id: t.id,
  name: t.name,
  scopes: t.scopes,
  serverId: t.serverId,
  createdAt: t.createdAt,
  createdBy: t.createdBy,
  lastUsedAt: t.lastUsedAt,
  uses: t.uses ?? 0,
  expiresAt: t.expiresAt,
  expired: Boolean(t.expiresAt && t.expiresAt < now),
  ...(t.tools ? { tools: t.tools } : {}),
});

export class McpTokenStore {
  private readonly file: string;
  private data: StoredTokens = { version: 1, tokens: [] };
  private loaded = false;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, 'mcp-tokens.json');
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try {
      const raw = (await fsp.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '').trim();
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<StoredTokens>;
        this.data = { version: 1, tokens: Array.isArray(parsed.tokens) ? parsed.tokens : [] };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    const content = JSON.stringify(this.data, null, 2);
    const write = async (): Promise<void> => {
      const temporary = `${this.file}.tmp-${process.pid}`;
      await fsp.writeFile(temporary, content, { mode: 0o600 });
      await fsp.rename(temporary, this.file);
    };
    this.writes = this.writes.then(write, write);
    await this.writes;
  }

  list(userId: string, now = Date.now()): McpTokenView[] {
    return this.data.tokens
      .filter((t) => t.userId === userId && !t.revokedAt)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => tokenView(t, now));
  }

  /**
   * A new key. The secret is returned once, in the only form it will ever
   * have; what is kept is its hash. A key that may run commands must name the
   * one server it may run them on.
   */
  async create(input: {
    userId: string;
    name: string;
    createdBy: string;
    scopes: McpScope[];
    serverId?: string;
    expiresInDays?: number;
    tools?: string[];
    now?: number;
  }): Promise<{ token: string; view: McpTokenView }> {
    await this.initialize();
    const now = input.now ?? Date.now();
    const name = input.name.trim().slice(0, 60) || 'Agent key';
    const mine = this.data.tokens.filter((t) => t.userId === input.userId && !t.revokedAt);
    if (mine.length >= MAX_PER_USER) throw new Error(`There are already ${MAX_PER_USER} keys. Revoke one before making another.`);
    const scopes = MCP_SCOPES.filter((s) => s === 'read' || input.scopes.includes(s));
    if (scopes.includes('run') && !input.serverId)
      throw new Error('A key that may run commands has to name the one server it may run them on.');
    const id = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    const record: McpTokenRecord = {
      id,
      userId: input.userId,
      name,
      hash: hashOf(secret),
      scopes,
      serverId: scopes.includes('run') ? input.serverId : undefined,
      createdAt: now,
      createdBy: input.createdBy,
      expiresAt: input.expiresInDays ? now + Math.min(3650, Math.max(1, input.expiresInDays)) * 24 * 3600_000 : undefined,
      ...(input.tools?.length ? { tools: [...new Set(input.tools.map((t) => t.trim()).filter(Boolean))].slice(0, 40) } : {}),
    };
    this.data.tokens.push(record);
    await this.save();
    return { token: `${PREFIX}_${input.userId}.${id}.${secret}`, view: tokenView(record, now) };
  }

  async revoke(userId: string, id: string, now = Date.now()): Promise<boolean> {
    await this.initialize();
    const found = this.data.tokens.find((t) => t.id === id && t.userId === userId && !t.revokedAt);
    if (!found) return false;
    found.revokedAt = now;
    await this.save();
    return true;
  }

  /**
   * The key behind an Authorization header, or undefined. A wrong key, a
   * revoked one and an expired one are all the same answer: nothing is said
   * about which part was wrong, and the hashes are compared in constant time.
   */
  verify(raw: string | undefined, now = Date.now()): McpTokenRecord | undefined {
    if (!raw) return undefined;
    const parsed = parseMcpToken(raw);
    if (!parsed) return undefined;
    const found = this.data.tokens.find((t) => t.id === parsed.id && t.userId === parsed.userId);
    if (!found || found.revokedAt || (found.expiresAt && found.expiresAt < now)) return undefined;
    return sameHash(found.hash, hashOf(parsed.secret)) ? found : undefined;
  }

  /** Notes that a key was used. Written at most once a minute: a busy agent must not rewrite the file on every call. */
  async noteUse(id: string, now = Date.now()): Promise<void> {
    const found = this.data.tokens.find((t) => t.id === id);
    if (!found) return;
    const last = found.lastUsedAt ?? 0;
    found.uses = (found.uses ?? 0) + 1;
    found.lastUsedAt = now;
    if (now - last > 60_000) await this.save().catch(() => undefined);
  }

  /** Every key of a user that was removed goes with them. */
  async forgetUser(userId: string): Promise<void> {
    await this.initialize();
    const before = this.data.tokens.length;
    this.data.tokens = this.data.tokens.filter((t) => t.userId !== userId);
    if (this.data.tokens.length !== before) await this.save();
  }
}
