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

describe('Sshs3WebServer Multi-User Hybrid Mode', () => {
  let tmpDir: string;
  let server: Sshs3WebServer;
  let baseUrl: string;
  let wsBaseUrl: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-web-test-'));
    setHeadlessUserDataPath(tmpDir);
    const staticDir = path.join(tmpDir, 'static');
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><html><body>sshs3 web</body></html>', 'utf-8');

    server = new Sshs3WebServer({
      port: 0, // random free port
      host: '127.0.0.1',
      dataDir: tmpDir,
      staticDir,
    });
    const info = await server.start();
    baseUrl = `http://127.0.0.1:${info.port}`;
    wsBaseUrl = `ws://127.0.0.1:${info.port}`;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  async function apiJson(urlPath: string, options: RequestInit = {}, token?: string): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(`${baseUrl}${urlPath}`, {
      ...options,
      headers,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    return body;
  }

  function createWsClient(token: string): Promise<{
    invoke: (channel: string, ...args: any[]) => Promise<any>;
    onEvent: (channel: string, cb: (...args: any[]) => void) => void;
    close: () => void;
  }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBaseUrl}/api/ws?token=${encodeURIComponent(token)}`);
      const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
      const listeners = new Map<string, Set<(...args: any[]) => void>>();
      let seq = 1;

      ws.onopen = () => {
        resolve({
          invoke: (channel: string, ...args: any[]) =>
            new Promise((res, rej) => {
              const id = `test_${seq++}`;
              pending.set(id, { resolve: res, reject: rej });
              ws.send(JSON.stringify({ type: 'invoke', id, channel, args }));
            }),
          onEvent: (channel: string, cb: (...args: any[]) => void) => {
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel)!.add(cb);
          },
          close: () => ws.close(),
        });
      };

      ws.onerror = (err) => reject(err);

      ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (msg.type === 'response' && msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(msg.error));
        } else if (msg.type === 'event' && msg.channel) {
          const set = listeners.get(msg.channel);
          if (set) {
            for (const fn of set) fn(...(msg.args || []));
          }
        }
      };
    });
  }

  it('supports First-Run Admin setup, Invite redemption, per-user SSH keys, and Hybrid Multi-User WebSocket sharing', async () => {
    // 1. Check initial status -> uninitialized
    const initStatus = await apiJson('/api/auth/status');
    expect(initStatus.initialized).toBe(false);
    expect(initStatus.authenticated).toBe(false);

    // 2. Setup initial admin (Jacob)
    const jacobSetup = await apiJson('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        username: 'jacob',
        displayName: 'Jacob Admin',
        password: 'super-secret-password',
      }),
    });
    expect(jacobSetup.token).toBeTruthy();
    expect(jacobSetup.user.username).toBe('jacob');
    expect(jacobSetup.user.role).toBe('admin');
    expect(jacobSetup.user.sshPublicKey).toContain('ssh-ed25519 ');

    // 3. Jacob creates an invite link for his friend Erik
    const inviteRes = await apiJson(
      '/api/admin/invites',
      {
        method: 'POST',
        body: JSON.stringify({ role: 'member', maxUses: 3, note: 'Friend invite' }),
      },
      jacobSetup.token
    );
    expect(inviteRes.invite.token).toBeTruthy();

    // 4. Erik registers using the invite token
    const erikReg = await apiJson('/api/auth/register-invite', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: inviteRes.invite.token,
        username: 'erik',
        displayName: 'Erik Kompis',
        password: 'erik-password-123',
      }),
    });
    expect(erikReg.token).toBeTruthy();
    expect(erikReg.user.username).toBe('erik');
    expect(erikReg.user.role).toBe('member');
    expect(erikReg.user.sshPublicKey).toContain('ssh-ed25519 ');
    // Each user has their own distinct server-side SSH key!
    expect(erikReg.user.sshPublicKey).not.toBe(jacobSetup.user.sshPublicKey);

    // 5. Both Jacob and Erik connect simultaneously over WebSocket
    const jacobWs = await createWsClient(jacobSetup.token);
    const erikWs = await createWsClient(erikReg.token);

    try {
      let erikHubChangedCount = 0;
      erikWs.onEvent('ai-hub:changed', () => {
        erikHubChangedCount += 1;
      });

      // 6. Jacob saves a shared SSH profile
      await jacobWs.invoke('profiles:save-ssh', {
        id: 'shared-prod-vm',
        name: 'Prod API Server',
        host: '10.20.30.40',
        port: 22,
        username: 'ubuntu',
        authType: 'key',
      });

      // Erik immediately sees the shared VM profile, with Erik's own personal SSH key path filled in!
      const erikProfiles = await erikWs.invoke('profiles:get');
      const sharedVm = erikProfiles.ssh.find((p: any) => p.id === 'shared-prod-vm');
      expect(sharedVm).toBeDefined();
      expect(sharedVm.host).toBe('10.20.30.40');
      expect(sharedVm.privateKeyPath).toContain(erikReg.user.id);

      // 7. Jacob creates a shared AI Memory in the Hub
      await jacobWs.invoke('ai-hub:request', {
        action: 'memory-save',
        entry: {
          kind: 'memory',
          scope: 'workspace',
          title: 'Nginx Restart SOP',
          text: 'Always run nginx -t before systemctl reload nginx',
        },
      });

      // Wait briefly for cross-tenant broadcast
      await new Promise((r) => setTimeout(r, 120));
      expect(erikHubChangedCount).toBeGreaterThan(0);

      // 8. Erik queries AI Hub snapshot -> sees Jacob's shared memory AND sees both Jacob and Erik in live presence!
      const state = await erikWs.invoke('ai-hub:request', { action: 'snapshot' });
      expect(state.memories.some((m: any) => m.title === 'Nginx Restart SOP')).toBe(true);

      const presenceNames = state.presence.map((p: any) => p.actor);
      expect(presenceNames).toContain('Erik Kompis');
      expect(presenceNames).toContain('Jacob Admin');

      // 9. Personal settings remain isolated per user
      await jacobWs.invoke('settings:save', { theme: 'dark', fontSize: 16 });
      await erikWs.invoke('settings:save', { theme: 'light', fontSize: 13 });

      const jacobSettings = await jacobWs.invoke('settings:get');
      const erikSettings = await erikWs.invoke('settings:get');
      expect(jacobSettings.fontSize).toBe(16);
      expect(erikSettings.fontSize).toBe(13);
    } finally {
      jacobWs.close();
      erikWs.close();
    }
  });
});
