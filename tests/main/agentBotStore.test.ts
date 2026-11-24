import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', async () => {
  const shim = await import('../../src/main/web/electronShim');
  return shim;
});

import { setHeadlessUserDataPath } from '../../src/main/web/electronShim';
import { AgentBotStore } from '../../src/main/web/chatAgent/AgentBotStore';

/**
 * The agent bot's own tokens: apart from the context bot's, encrypted at rest, in a file only the
 * server reads, and never in what the interface is shown.
 */

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

const LOCAL = { server: false, allowPrivate: true };
const BOT = 'xoxb-1111-2222-agentsecret';
const APP = 'xapp-1-A111-3333-appsecret';

async function fresh(guard: () => { server: boolean; allowPrivate: boolean } = () => LOCAL) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-agent-bot-'));
  dirs.push(dir);
  setHeadlessUserDataPath(dir);
  return { dir, store: new AgentBotStore(dir, { guard, clock: () => 1_000 }) };
}

describe('AgentBotStore', () => {
  it('keeps the Slack tokens encrypted, in a file only the server reads, and never shows them', async () => {
    const { dir, store } = await fresh();
    const view = await store.save({ service: 'slack', token: BOT, appToken: APP });
    expect(view).toEqual({ service: 'slack', enabled: true, hasToken: true, hasAppToken: true, savedAt: 1_000 });
    expect(JSON.stringify(store.view())).not.toContain('secret');

    const file = path.join(dir, 'chat-agent', 'connections.json');
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain(BOT);
    expect(raw).not.toContain(APP);
    expect(raw).toMatch(/enc:v1:/);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    // The context bot's file is somewhere else and is not touched.
    await expect(fs.stat(path.join(dir, 'team-chat', 'connections.json'))).rejects.toThrow();

    const again = new AgentBotStore(dir, { guard: () => LOCAL });
    await again.initialize();
    expect(again.slack()).toEqual({ botToken: BOT, appToken: APP });
  });

  it('takes only tokens of the right kind', async () => {
    const { store } = await fresh();
    await expect(store.save({ service: 'slack', token: 'xoxp-a-person', appToken: APP })).rejects.toThrow('starts with xoxb-');
    await expect(store.save({ service: 'slack', token: BOT, appToken: 'xoxb-not-an-app-token' })).rejects.toThrow('starts with xapp-');
    await expect(store.save({ service: 'slack', token: BOT })).rejects.toThrow('app-level token is needed');
    await expect(store.save({ service: 'slack', appToken: APP })).rejects.toThrow("agent bot's token is needed");
    // Slack's rotating app tokens start differently.
    await store.save({ service: 'slack', token: BOT, appToken: 'xoxe.xapp-1-rotating' });
    expect(store.slack()?.appToken).toBe('xoxe.xapp-1-rotating');
  });

  it('keeps a saved token when the form leaves it empty, and asks who the bot is again after a new one', async () => {
    const { store } = await fresh();
    await store.save({ service: 'slack', token: BOT, appToken: APP });
    await store.setIdentity('slack', { userId: 'UAGENT', botId: 'BAGENT', name: 'agent', team: 'Acme' });
    await store.save({ service: 'slack', enabled: true });
    expect(store.slack()).toEqual({ botToken: BOT, appToken: APP });
    expect(store.identity('slack')).toEqual({ userId: 'UAGENT', botId: 'BAGENT', name: 'agent', team: 'Acme' });
    await store.save({ service: 'slack', token: 'xoxb-another-app' });
    expect(store.identity('slack')).toBeUndefined();
  });

  it('checks the Mattermost address when it is saved, and does not send a token to a new address', async () => {
    const lookups = async () => [{ address: '10.0.0.8', family: 4 }];
    const { store } = await fresh(() => ({ server: true, allowPrivate: false, lookup: lookups }) as never);
    await expect(store.save({ service: 'mattermost', baseUrl: 'https://chat.internal', token: 'mm-token-123456' })).rejects.toThrow(/private network/);
    expect(store.view()).toEqual([]);

    const ok = await fresh();
    await ok.store.save({ service: 'mattermost', baseUrl: 'http://127.0.0.1:8065/', token: 'mm-token-123456' });
    expect(ok.store.view()).toEqual([{ service: 'mattermost', enabled: true, hasToken: true, baseUrl: 'http://127.0.0.1:8065', savedAt: 1_000 }]);
    await expect(ok.store.save({ service: 'mattermost', baseUrl: 'http://127.0.0.1:9999' })).rejects.toThrow('has to be entered again');
    expect(ok.store.mattermost()).toEqual({ baseUrl: 'http://127.0.0.1:8065', token: 'mm-token-123456' });
  });

  it('takes a Mattermost token only of letters, digits and signs, since it goes in a header', async () => {
    const { store } = await fresh();
    for (const bad of ['abc\ndef-ghijklmnop', 'token with spaces', 'tökenwithumlaut1234', 'short'])
      await expect(store.save({ service: 'mattermost', baseUrl: 'http://127.0.0.1:8065', token: bad })).rejects.toThrow('does not look like a Mattermost token');
    await store.save({ service: 'mattermost', baseUrl: 'http://127.0.0.1:8065', token: 'abcdefghijklmnopqrstuvwxyz' });
    // The user name is kept with who the bot is: mentions of it are taken out of the text.
    await store.setIdentity('mattermost', { userId: 'abcdefghijklmnopqrstuvwxyz', username: 'agentbot', name: 'Agent' });
    expect(store.view()[0].identity).toEqual({ userId: 'abcdefghijklmnopqrstuvwxyz', username: 'agentbot', name: 'Agent' });
  });

  it('turns a connection off, keeps the last error without a token, and removes it', async () => {
    const { store } = await fresh();
    await store.save({ service: 'slack', token: BOT, appToken: APP });
    await store.setEnabled('slack', false);
    expect(store.slack()).toBeUndefined();
    expect(store.slack(true)).toEqual({ botToken: BOT, appToken: APP });
    await store.setError('slack', `Slack said the token ${BOT} is bad`);
    const view = store.view()[0];
    expect(view.lastError).toContain('[token]');
    expect(view.lastError).not.toContain('agentsecret');
    expect(view.lastErrorAt).toBe(1_000);
    await store.setError('slack', undefined);
    expect(store.view()[0].lastError).toBeUndefined();
    await store.remove('slack');
    expect(store.view()).toEqual([]);
  });

  it('counts a token encrypted on another machine as not saved', async () => {
    const { dir } = await fresh();
    await fs.mkdir(path.join(dir, 'chat-agent'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'chat-agent', 'connections.json'),
      JSON.stringify({ version: 1, connections: [{ service: 'slack', token: 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==', appToken: 'enc:v1:AAAA', enabled: true }] }),
    );
    const store = new AgentBotStore(dir, { guard: () => LOCAL });
    await store.initialize();
    expect(store.slack()).toBeUndefined();
    expect(store.view()[0]).toMatchObject({ hasToken: false, hasAppToken: false });
  });

  it('keeps tokens it could not open on one start, says so, and reads them again with the right key', async () => {
    const { dir, store } = await fresh();
    await store.save({ service: 'slack', token: BOT, appToken: APP });
    await store.setIdentity('slack', { userId: 'UAGENT', name: 'agent' });
    const file = path.join(dir, 'chat-agent', 'connections.json');
    const stored = async (): Promise<{ token: string; appToken: string; enabled: boolean }> => JSON.parse(await fs.readFile(file, 'utf8')).connections[0];
    const sealed = await stored();

    // A start with another key: the key file is not the one the tokens were saved with.
    const key = path.join(dir, 'server-master.key');
    await fs.rename(key, `${key}.right`);
    setHeadlessUserDataPath(dir);
    const wrongKey = new AgentBotStore(dir, { guard: () => LOCAL, clock: () => 2_000 });
    await wrongKey.initialize();
    expect(wrongKey.slack(true)).toBeUndefined();
    const view = wrongKey.view()[0];
    expect(view).toMatchObject({ hasToken: false, hasAppToken: false, identity: { userId: 'UAGENT', name: 'agent' } });
    expect(view.lastError).toBe(
      "The agent bot's Slack tokens could not be read on this start: the server's key (SSHS3_MASTER_KEY, or the key file in the data folder) did not open what is stored. It is kept as it is. Start the server with the key that was used when they were saved, or enter the tokens again.",
    );
    // Everything that saves the file on such a start writes the tokens back as they were stored.
    await wrongKey.setEnabled('slack', false);
    await wrongKey.setError('slack', 'Slack did not answer');
    await wrongKey.setIdentity('slack', { userId: 'UAGENT', name: 'agent' });
    expect(await stored()).toMatchObject({ token: sealed.token, appToken: sealed.appToken, enabled: false });
    // The note about the tokens stays in front of any other error.
    expect(wrongKey.view()[0].lastError).toContain('could not be read on this start');
    // A form that leaves the tokens empty cannot be saved: there is nothing to keep using.
    await expect(wrongKey.save({ service: 'slack', enabled: true })).rejects.toThrow("agent bot's token is needed");
    expect(await stored()).toMatchObject({ token: sealed.token, appToken: sealed.appToken });

    // The next start has the right key again: the tokens are there, and nothing says otherwise.
    await fs.rm(key, { force: true });
    await fs.rename(`${key}.right`, key);
    setHeadlessUserDataPath(dir);
    const rightKey = new AgentBotStore(dir, { guard: () => LOCAL });
    await rightKey.initialize();
    expect(rightKey.slack(true)).toEqual({ botToken: BOT, appToken: APP });
    expect(rightKey.view()[0]).toMatchObject({ hasToken: true, hasAppToken: true, lastError: 'Slack did not answer' });
  });

  it('lets a person enter new tokens over ones that could not be opened', async () => {
    const { dir, store } = await fresh();
    await store.save({ service: 'mattermost', baseUrl: 'http://127.0.0.1:8065', token: 'mm-token-123456' });
    const file = path.join(dir, 'chat-agent', 'connections.json');
    const before = JSON.parse(await fs.readFile(file, 'utf8')).connections[0].token as string;
    await fs.rm(path.join(dir, 'server-master.key'));
    setHeadlessUserDataPath(dir);
    const next = new AgentBotStore(dir, { guard: () => LOCAL });
    await next.initialize();
    expect(next.view()[0].lastError).toBe(
      "The agent bot's Mattermost token could not be read on this start: the server's key (SSHS3_MASTER_KEY, or the key file in the data folder) did not open what is stored. It is kept as it is. Start the server with the key that was used when it was saved, or enter the token again.",
    );
    await next.save({ service: 'mattermost', token: 'mm-new-token-7890' });
    expect(next.view()[0]).toMatchObject({ hasToken: true });
    expect(next.view()[0].lastError).toBeUndefined();
    expect(next.mattermost()).toEqual({ baseUrl: 'http://127.0.0.1:8065', token: 'mm-new-token-7890' });
    const after = JSON.parse(await fs.readFile(file, 'utf8')).connections[0].token as string;
    expect(after).not.toBe(before);
    // Removing the connection forgets what could not be opened too.
    await next.remove('mattermost');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).connections).toEqual([]);
  });

  it('writes one at a time, so the file holds the last change', async () => {
    const { dir, store } = await fresh();
    await store.save({ service: 'slack', token: BOT, appToken: APP });
    await Promise.all([store.setError('slack', 'one'), store.setError('slack', 'two'), store.setEnabled('slack', false)]);
    const again = new AgentBotStore(dir, { guard: () => LOCAL });
    await again.initialize();
    expect(again.view()[0]).toMatchObject({ enabled: false, lastError: 'two' });
  });
});
