import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { SessionStore } from '../../src/main/session/SessionStore';
import type { SessionData } from '../../src/shared/types/session';

describe('SessionStore', () => {
  let tempDir: string;
  let sessionFile: string;
  let store: SessionStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multissh-session-test-'));
    sessionFile = path.join(tempDir, 'session.json');
    store = new SessionStore(sessionFile);
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('never writes file manager connection secrets to disk, even from a caller that did not sanitize', async () => {
    await store.saveSession({
      tabs: [
        {
          id: 'fm1',
          type: 'filemanager',
          title: 'FM',
          initialSSHConfig: { id: 'c', host: 'h', username: 'u', authType: 'password', password: 'pw-secret', passphrase: 'pp-secret' }, // pragma: allowlist secret
          initialS3Config: { id: 's', name: 'S', region: 'r', accessKeyId: 'AKIA', secretAccessKey: 's3-secret', sessionToken: 'tok-secret' }, // pragma: allowlist secret
        },
      ],
      activeTabId: 'fm1',
    } as unknown as SessionData);

    const onDisk = await fs.readFile(sessionFile, 'utf-8');
    for (const secret of ['pw-secret', 'pp-secret', 's3-secret', 'tok-secret']) {
      expect(onDisk).not.toContain(secret);
    }
    expect(onDisk).toContain('"host": "h"');
  });

  it('returns null when session file does not exist', async () => {
    const session = await store.getSession();
    expect(session).toBeNull();
  });

  it('saves and retrieves session data with tabs and activeTabId', async () => {
    const data: SessionData = {
      tabs: [
        { id: 'tab-1', type: 'terminal', title: 'Prod Server' },
        { id: 'tab-2', type: 'filemanager', title: 'Filhanterare 1' },
      ],
      activeTabId: 'tab-2',
      lastPaths: {
        local: '/home/user/docs',
        'sftp-123': '/var/www',
      },
      panes: {
        left: { sourceType: 'local', providerId: 'local', label: 'Lokal disk', path: '/home/user' },
        right: { sourceType: 'sftp', providerId: 'sftp-123', label: 'Prod', path: '/var/www' },
      },
    };

    await store.saveSession(data);
    const loaded = await store.getSession();

    expect(loaded).toEqual(data);
  });

  it('returns null if file is corrupt JSON', async () => {
    await fs.writeFile(sessionFile, 'corrupt {json', 'utf-8');
    const loaded = await store.getSession();
    expect(loaded).toBeNull();
  });

  it('also strips the PIN and the proxy password from session data on save', async () => {
    const data: SessionData = {
      tabs: [
        {
          id: 'tab-1',
          type: 'terminal',
          title: 'Prod',
          paneTree: {
            type: 'leaf',
            id: 'p1',
            config: {
              id: 'c1',
              host: 'h',
              username: 'u',
              authType: 'smartcard',
              pin: '123456',
              proxy: { type: 'http', host: 'proxy', port: 3128, username: 'pu', password: 'proxy-secret' }, // pragma: allowlist secret
            },
          },
        },
      ],
      activeTabId: 'tab-1',
    } as any;

    await store.saveSession(data);
    const raw = await fs.readFile(sessionFile, 'utf-8');

    expect(raw).not.toContain('123456');
    expect(raw).not.toContain('proxy-secret');
    expect(raw).toContain('"host": "proxy"');
  });

  it('strips password and passphrase from session data on save', async () => {
    const dataWithSecrets: SessionData = {
      tabs: [
        {
          id: 'tab-ssh',
          type: 'terminal',
          title: 'Secret Server',
          paneTree: {
            type: 'leaf',
            id: 'leaf-1',
            config: {
              id: 'prof-1',
              name: 'Prod',
              host: 'example.com',
              port: 22,
              username: 'admin',
              authType: 'password',
              password: 'super-secret-password',
              passphrase: 'secret-key-passphrase',
            },
          },
        },
      ],
      activeTabId: 'tab-ssh',
    };

    await store.saveSession(dataWithSecrets);

    // Read the raw file from disk to ensure it was stripped before writing
    const rawOnDisk = await fs.readFile(sessionFile, 'utf-8');
    expect(rawOnDisk).not.toContain('super-secret-password');
    expect(rawOnDisk).not.toContain('secret-key-passphrase');

    const loaded = await store.getSession();
    const leaf = loaded?.tabs[0].paneTree as any;
    expect(leaf.config.password).toBeUndefined();
    expect(leaf.config.passphrase).toBeUndefined();
    expect(leaf.config.username).toBe('admin');
  });

  describe('per-window sessions', () => {
    const tab = (id: string) => ({ id, type: 'terminal' as const, title: id });

    it('keeps the main window and secondary windows apart across saves', async () => {
      await store.saveSessionForWindow(null, { tabs: [tab('a')], activeTabId: 'a' });
      await store.saveSessionForWindow('w-1', { tabs: [tab('b')], activeTabId: 'b' });
      await store.saveSessionForWindow(null, { tabs: [tab('a'), tab('c')], activeTabId: 'c' });

      expect((await store.getSessionForWindow(null))?.tabs.map((t) => t.id)).toEqual(['a', 'c']);
      expect((await store.getSessionForWindow('w-1'))?.tabs.map((t) => t.id)).toEqual(['b']);
      expect((await store.getSession())?.windows?.[0].key).toBe('w-1');
    });

    it('saves bounds and restores them next to the tabs', async () => {
      const bounds = { x: 5, y: 6, width: 700, height: 500 };
      await store.saveWindowBounds('w-1', bounds, true);
      await store.saveSessionForWindow('w-1', { tabs: [tab('b')], activeTabId: 'b' });
      await store.saveWindowBounds(null, bounds, false);

      const stored = await store.getSession();
      expect(stored?.windows?.[0]).toMatchObject({ key: 'w-1', bounds, maximized: true });
      expect(stored?.mainBounds).toEqual(bounds);
    });

    it('does not let a late save bring back a window that was closed on purpose', async () => {
      await store.saveSessionForWindow('w-1', { tabs: [tab('b')], activeTabId: 'b' });
      await store.forgetWindow('w-1');
      await store.saveSessionForWindow('w-1', { tabs: [tab('b')], activeTabId: 'b' });
      await store.saveWindowBounds('w-1', { x: 0, y: 0, width: 500, height: 400 }, false);

      expect((await store.getSession())?.windows).toBeUndefined();
    });

    it('ignores a save without a tab list', async () => {
      await store.saveSessionForWindow('w-1', { activeTabId: 'x' } as unknown as SessionData);
      expect(await store.getSession()).toBeNull();
    });

    it('still reads an old single-window session file as the main window', async () => {
      await fs.writeFile(sessionFile, JSON.stringify({ tabs: [tab('a')], activeTabId: 'a' }));
      expect((await store.getSessionForWindow(null))?.tabs).toHaveLength(1);
      expect((await store.getSessionForWindow('w-1'))?.tabs).toEqual([]);
    });
  });
});
