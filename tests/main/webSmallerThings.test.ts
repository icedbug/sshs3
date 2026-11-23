import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { app } from '../../src/main/web/electronShim';
import { packageVersion } from '../../src/main/web/appVersion';
import { DEFAULT_KEY_DAYS, McpTokenStore } from '../../src/main/web/McpTokenStore';
import { TooManySignInAttempts, WebAuthService } from '../../src/main/web/WebAuthService';
import { ADMIN_PASSWORD, startWebServer, type WebServerKit } from '../helpers/webServerKit';

const DAY = 24 * 3600_000;

describe('web server: smaller things', () => {
  let kit: WebServerKit;

  beforeEach(async () => {
    kit = await startWebServer();
  });

  afterEach(async () => {
    await kit.stop();
  });

  it('a body that is not JSON is the caller\'s mistake, said in plain words', async () => {
    await kit.send('POST', '/api/auth/setup', { username: 'maria', password: ADMIN_PASSWORD });
    const broken = await kit.send('POST', '/api/auth/login', undefined, undefined, { raw: '{"username": ' });
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ error: 'The request body is not valid JSON.' });
    // Nothing of the parser's own words ("Unexpected end of JSON input", a position) is passed on.
    expect(broken.text).not.toMatch(/Unexpected|position|JSON input/);
    for (const raw of ['null', '7', '"text"', '[1,2]']) {
      const res = await kit.send('POST', '/api/auth/login', undefined, undefined, { raw });
      expect(res.status, raw).toBe(400);
      expect(res.body.error, raw).toBe('The request body must be a JSON object.');
    }
    const large = await kit.send('POST', '/api/auth/login', undefined, undefined, { raw: JSON.stringify({ username: 'x'.repeat(300_000) }) });
    expect(large.status).toBe(413);
    expect(large.body.error).toBe('The request is too large.');
  });

  it('a WebSocket message that is JSON but not an object is ignored', async () => {
    const { memberCookie } = await kit.team();
    const omar = await kit.connect(memberCookie);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      for (const text of ['null', '7', '"text"', 'true', '[]', 'not json at all']) omar.raw(text);
      // The connection still answers, and nothing was left unhandled on the way.
      expect(await omar.invoke('app:get-platform')).toBe(process.platform);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      omar.close();
    }
  });

  it('says the version it really is', async () => {
    const real = (JSON.parse(await fs.readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;
    expect(packageVersion()).toBe(real);
    expect(app.getVersion()).toBe(real);
    const { memberCookie } = await kit.team();
    const omar = await kit.connect(memberCookie);
    expect(await omar.invoke('app:get-version')).toBe(real);
    omar.close();
    const key = await kit.send('POST', '/api/mcp-keys', { name: 'laptop', scopes: ['read'] }, memberCookie);
    const hello = await fetch(`${kit.baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.body.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    });
    const body = (await hello.json()) as { result: { serverInfo: { name: string; version: string } } };
    expect(body.result.serverInfo).toMatchObject({ name: 'sshs3', version: real });
  });

  it('an MCP key stops working after 30 days unless it is said otherwise', async () => {
    const { memberCookie } = await kit.team();
    const make = async (extra: Record<string, unknown>): Promise<number | undefined> => {
      const res = await kit.send('POST', '/api/mcp-keys', { name: 'k', scopes: ['read'], ...extra }, memberCookie);
      expect(res.status).toBe(200);
      return res.body.key.expiresAt as number | undefined;
    };
    const now = Date.now();
    const near = (at: number | undefined, days: number): void => {
      expect(at).toBeGreaterThan(now + days * DAY - 60_000);
      expect(at).toBeLessThan(now + days * DAY + 60_000);
    };
    near(await make({}), 30);
    near(await make({ expiresInDays: 7 }), 7);
    // Nothing useful as a number of days: still 30, never "for ever" by accident.
    near(await make({ expiresInDays: 0 }), 30);
    near(await make({ expiresInDays: '' }), 30);
    near(await make({ expiresInDays: null }), 30);
    near(await make({ neverExpires: 'yes' }), 30);
    // Never, when the request says so in so many words.
    expect(await make({ neverExpires: true })).toBeUndefined();

    // The same through the app's own settings (the key for a local agent): the hub's request.
    const omar = await kit.connect(memberCookie);
    const viaHub = async (extra: Record<string, unknown>): Promise<number | undefined> => {
      const snap = (await omar.invoke('ai-hub:request', { action: 'mcp-key-create', name: 'k', scopes: ['read'], ...extra })) as { reply?: { mcpKey?: { key: { expiresAt?: number } } } };
      expect(snap.reply?.mcpKey).toBeTruthy();
      return snap.reply!.mcpKey!.key.expiresAt;
    };
    near(await viaHub({}), 30);
    near(await viaHub({ expiresInDays: 90 }), 90);
    expect(await viaHub({ neverExpires: true })).toBeUndefined();
    // "Never" in the settings sends 0 days.
    expect(await viaHub({ expiresInDays: 0 })).toBeUndefined();
    omar.close();
  });
});

describe('MCP key store', () => {
  it('gives a key 30 days when its request says nothing about how long', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-keys-'));
    try {
      const store = new McpTokenStore(dir);
      const now = 1_800_000_000_000;
      const base = { userId: 'u1', name: 'k', createdBy: 'x', scopes: ['read' as const], now };
      expect(DEFAULT_KEY_DAYS).toBe(30);
      expect((await store.create(base)).view.expiresAt).toBe(now + 30 * DAY);
      expect((await store.create({ ...base, expiresInDays: 0 })).view.expiresAt).toBe(now + 30 * DAY);
      expect((await store.create({ ...base, expiresInDays: 5 })).view.expiresAt).toBe(now + 5 * DAY);
      expect((await store.create({ ...base, expiresInDays: 99_999 })).view.expiresAt).toBe(now + 3650 * DAY);
      expect((await store.create({ ...base, neverExpires: true })).view.expiresAt).toBeUndefined();
      // The default key is refused once its days are over.
      const made = await store.create(base);
      expect(store.verify(made.token, now + 29 * DAY)).toBeTruthy();
      expect(store.verify(made.token, now + 31 * DAY)).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('sign-in', () => {
  let dir: string;
  let auth: WebAuthService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sign-in-'));
    auth = new WebAuthService(dir);
    await auth.initialize();
    await auth.setupInitialAdmin({ username: 'maria', password: ADMIN_PASSWORD });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does the same password work for a name that has no account as for one that has', async () => {
    const scrypt = vi.spyOn(crypto, 'scryptSync');
    await expect(auth.login('maria', 'a-wrong-password', '203.0.113.1')).rejects.toThrow('Wrong user name or password'); // pragma: allowlist secret
    const forKnown = scrypt.mock.calls.length;
    scrypt.mockClear();
    await expect(auth.login('nobody', 'a-wrong-password', '203.0.113.2')).rejects.toThrow('Wrong user name or password'); // pragma: allowlist secret
    expect(forKnown).toBe(1);
    expect(scrypt.mock.calls.length).toBe(forKnown);
    // With the same cost settings: the work is the same, not only the count.
    expect(scrypt.mock.calls[0]![2]).toBe(64);
  });

  it('forgets failed attempts that have run out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
    // A name without an account is counted against the address only.
    for (let i = 0; i < 40; i++) await auth.login(`nobody-${i}`, 'x', `198.51.100.${i}`).catch(() => undefined);
    expect(auth.countedSignInAttempts()).toBe(40);
    vi.setSystemTime(new Date('2026-11-23T10:02:00Z'));
    await auth.login('nobody', 'x', '198.51.100.200').catch(() => undefined);
    expect(auth.countedSignInAttempts()).toBe(1);
  });

  it('says when the limiter begins to refuse, once for each address and minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T10:00:00Z'));
    const firsts: boolean[] = [];
    for (let i = 0; i < 35; i++) {
      const error = await auth.login(`nobody-${i}`, 'x', '198.51.100.7').catch((e: unknown) => e);
      if (error instanceof TooManySignInAttempts) firsts.push(error.first);
    }
    expect(firsts).toEqual([true, false, false, false, false]);
    // A minute later the count starts again, and so does the notice.
    vi.setSystemTime(new Date('2026-11-23T10:01:30Z'));
    const later: boolean[] = [];
    for (let i = 0; i < 32; i++) {
      const error = await auth.login(`nobody-${i}`, 'x', '198.51.100.7').catch((e: unknown) => e);
      if (error instanceof TooManySignInAttempts) later.push(error.first);
    }
    expect(later).toEqual([true, false]);
  });
});
