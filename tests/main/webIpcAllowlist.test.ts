import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

vi.mock('electron', async () => await import('../../src/main/web/electronShim'));

import { safeStorage } from '../../src/main/web/electronShim';
import {
  DESKTOP_ONLY_CHANNELS,
  WEB_ALLOWED_CHANNELS,
  WEB_CHANNEL_REFUSED,
  WEB_FIXED_ANSWERS,
  unlistedChannels,
  webChannelKind,
} from '../../src/main/web/webIpcChannels';
import { startWebServer, type WebServerKit } from '../helpers/webServerKit';

/**
 * C1 / W1: a signed-in member reached every IPC handler, and one of them read any file of the server.
 * A web client now reaches only the channels on a list, and every registered handler has to be on one.
 */
describe('web server: which handlers a signed-in account may call', () => {
  let kit: WebServerKit;

  beforeEach(async () => {
    kit = await startWebServer();
  });

  afterEach(async () => {
    await kit.stop();
  });

  it('has every registered handler in exactly one list, and no list names a handler that is gone', async () => {
    const { adminId } = await kit.team();
    const admin = (await kit.server.auth.listUsers()).find((u) => u.id === adminId)!;
    const tenant = await kit.server.tenants.getOrCreateTenant(admin);
    const registered = tenant.ipcMain.channels();
    expect(registered.length).toBeGreaterThan(200);

    // A handler in no list: somebody added one and has not decided whether a web client may call it.
    expect(unlistedChannels(registered)).toEqual([]);

    const lists = [[...WEB_ALLOWED_CHANNELS], [...WEB_FIXED_ANSWERS.keys()], [...DESKTOP_ONLY_CHANNELS]];
    const all = lists.flat();
    // In two lists at once: the first one would win without anybody having meant it.
    expect(all.filter((channel, i) => all.indexOf(channel) !== i)).toEqual([]);
    // Named in a list but not registered: a renamed or removed handler left its name behind.
    expect(all.filter((channel) => !registered.includes(channel)).sort()).toEqual([]);
  });

  it('notices a handler nobody has listed', async () => {
    const { adminId } = await kit.team();
    const admin = (await kit.server.auth.listUsers()).find((u) => u.id === adminId)!;
    const tenant = await kit.server.tenants.getOrCreateTenant(admin);
    tenant.ipcMain.handle('files:read-anything', async () => 'not decided yet');
    expect(unlistedChannels(tenant.ipcMain.channels())).toEqual(['files:read-anything']);
    expect(webChannelKind('files:read-anything')).toBe('unlisted');

    // And a web client does not reach it, although the handler is there.
    const client = await kit.connect((await kit.send('POST', '/api/auth/login', { username: 'maria', password: 'maria-password-123' })).cookie); // pragma: allowlist secret
    await expect(client.invoke('files:read-anything')).rejects.toThrow(WEB_CHANNEL_REFUSED);
    client.close();
  });

  it('a member cannot read the account file, the credential key, another account\'s SSH key or /etc/passwd', async () => {
    const { adminCookie, adminId, memberCookie } = await kit.team();
    const adminInvite = await kit.send('POST', '/api/admin/invites', { role: 'admin', maxUses: 1 }, adminCookie);
    expect(adminInvite.status).toBe(200);
    safeStorage.encryptString('x'); // the credential key exists once anything was encrypted
    const targets = [
      path.join(kit.dataDir, 'web-users.json'),
      path.join(kit.dataDir, 'server-master.key'),
      path.join(kit.dataDir, 'users', adminId, '.ssh', 'id_ed25519'),
      '/etc/passwd',
    ];
    // The files are there to be read: without the list, the member got all of them.
    for (const file of targets.slice(0, 3)) await expect(fs.stat(file)).resolves.toBeTruthy();

    const omar = await kit.connect(memberCookie);
    await expect(omar.invoke('dotfiles:read-sources', targets)).rejects.toThrow(WEB_CHANNEL_REFUSED);

    // The handlers that work on "local" files see the account's own folder and nothing else.
    await omar.invoke('storage:connect', { id: 'local', name: 'Local', type: 'local' });
    for (const file of targets) {
      await expect(omar.invoke('file:read', 'local', file)).rejects.toThrow(/outside the allowed base directory/);
      await expect(omar.invoke('storage:stat', 'local', file)).rejects.toThrow(/outside the allowed base directory/);
      await expect(omar.invoke('file:tail:start', 'local', file)).rejects.toThrow();
    }
    await expect(omar.invoke('file:read', 'local', '../../web-users.json')).rejects.toThrow(/outside the allowed base directory/);
    await expect(omar.invoke('file:save', 'local', path.join(kit.dataDir, 'written-by-member.txt'), 'x')).rejects.toThrow(/outside the allowed base directory/);
    await expect(fs.stat(path.join(kit.dataDir, 'written-by-member.txt'))).rejects.toThrow();

    // So the invite the administrator made stays unread: its token is not in anything the member got.
    const everything = JSON.stringify(await omar.invoke('storage:list', 'local', ''));
    expect(everything).not.toContain(adminInvite.body.invite.token);
    omar.close();
  });

  it('refuses the handlers that act on the server itself, with a plain message', async () => {
    const { memberCookie } = await kit.team();
    const omar = await kit.connect(memberCookie);
    const refused: Array<[string, ...unknown[]]> = [
      ['git:configure-signing', { name: 'x', email: 'x@example.invalid' }],
      ['git:get-signing-config'],
      ['profiles:import-ssh-config'],
      ['log:get-diagnostics'],
      ['smartcard:validate', '/etc/passwd'],
      ['x11:start-server', { customPath: '/bin/sh', customArgs: '-c id' }],
      ['file:open-external', 'local', 'x'],
      ['ssh-tunnel:start', {}, {}],
      ['k8s-port-forward:start', {}],
      ['aws-sso:login', 'https://example.invalid/start', 'eu-north-1'],
      ['update:install'],
      ['fido2:generate-key', {}],
      ['team-vault:unlock', 'v', 'r', '/etc/passwd'],
      ['no:such-channel'],
    ];
    for (const [channel, ...args] of refused) {
      await expect(omar.invoke(channel, ...args), channel).rejects.toThrow(WEB_CHANNEL_REFUSED);
    }
    // What the page asks when it loads is answered, the same way every time, and no card is read.
    expect(await omar.invoke('smartcard:detect')).toEqual([]);
    expect(await omar.invoke('smartcard:list-cached')).toEqual([]);
    expect(await omar.invoke('smartcard:unlock-at-startup')).toEqual({ started: false });
    expect(await omar.invoke('app:detect-local-shells')).toEqual({ pwsh: false, wsl: false, wslDistros: [] });
    // The settings ask about an X server with a path of the account's choosing: nothing is looked at.
    expect(await omar.invoke('x11:get-status', '/etc/passwd')).toEqual({ available: false, running: false, managedByApp: false, display: '' });
    expect(await omar.invoke('app:check-x11-server', ':0')).toEqual({ running: false, display: '' });
    // An ordinary call still works.
    expect(await omar.invoke('app:get-platform')).toBe(process.platform);
    omar.close();
  });

  it('git never runs on the server\'s own disk, and "home" is the account\'s own files folder', async () => {
    const { memberCookie, memberId } = await kit.team();
    const omar = await kit.connect(memberCookie);
    // The repository this test runs in is a git repository on the server's disk.
    expect(await omar.invoke('git:get-status', process.cwd())).toEqual({ isRepo: false });
    expect(await omar.invoke('git:get-status', process.cwd(), 'local')).toEqual({ isRepo: false });
    expect(await omar.invoke('git:pull', process.cwd())).toMatchObject({ success: false, error: expect.stringMatching(/not on the sshs3 server itself/) });
    expect(await omar.invoke('git:clone', { url: 'https://example.invalid/x.git', targetDirectory: process.cwd() })).toMatchObject({ success: false, error: expect.stringMatching(/not on the sshs3 server itself/) });

    const files = path.join(kit.dataDir, 'users', memberId, 'files');
    expect(await omar.invoke('app:get-homedir')).toBe(files);
    expect(await omar.invoke('storage:get-homedir', 'local')).toBe(files);
    await omar.invoke('storage:connect', { id: 'local', name: 'Local', type: 'local' });
    // The file pane opens at "home": that folder can be listed, and the server's disks are not.
    expect(await omar.invoke('storage:list', 'local', files)).toEqual([]);
    expect(await omar.invoke('storage:list-volumes', 'local')).toEqual([]);
    omar.close();
  });
});
