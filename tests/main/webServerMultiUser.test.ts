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

      // 10. Per-user home directory & ssh-copy-id public key discovery prioritize tenant's own key
      const jacobHome = await jacobWs.invoke('app:get-homedir');
      const erikHome = await erikWs.invoke('app:get-homedir');
      expect(jacobHome).toContain(jacobSetup.user.id);
      expect(erikHome).toContain(erikReg.user.id);
      expect(jacobHome).not.toBe(erikHome);

      const jacobPubKeys = await jacobWs.invoke('ssh:list-public-keys');
      const erikPubKeys = await erikWs.invoke('ssh:list-public-keys');
      expect(jacobPubKeys).toHaveLength(1);
      expect(erikPubKeys).toHaveLength(1);
      expect(jacobPubKeys[0]?.line).toBe(jacobSetup.user.sshPublicKey);
      expect(erikPubKeys[0]?.line).toBe(erikReg.user.sshPublicKey);

      // 10b. Personal SSH profile (shared: false) never leaks into shared-profiles.json or shared-workspace.json
      await jacobWs.invoke('profiles:save-ssh', {
        id: 'jacob-personal-vm',
        name: 'Jacob Personal VM',
        host: '192.168.99.99',
        port: 22,
        username: 'jacob',
        authType: 'privateKey',
        shared: false,
      });
      await jacobWs.invoke('ai-hub:request', { action: 'snapshot' });
      const erikProfilesCheckPersonal = await erikWs.invoke('profiles:get');
      expect(erikProfilesCheckPersonal.ssh.some((p: any) => p.id === 'jacob-personal-vm')).toBe(false);
      const erikSnapCheckPersonal = await erikWs.invoke('ai-hub:request', { action: 'snapshot' });
      expect(erikSnapCheckPersonal.workspaceServers.some((s: any) => s.id === 'jacob-personal-vm')).toBe(false);

      // 11. ControlMaster socket path includes privateKeyPath so two web users never share a mux socket
      const { SSHPtyManager } = await import('../../src/main/ssh/SSHPtyManager');
      const jacobProfiles = await jacobWs.invoke('profiles:get');
      const jacobVm = jacobProfiles.ssh.find((p: any) => p.id === 'shared-prod-vm');
      const sockJacob = SSHPtyManager.getControlPath(jacobVm);
      const sockErik = SSHPtyManager.getControlPath(sharedVm);
      // Extract the 8-char hash prefix s3m-<hash>-<uuid>.sock
      const hashJacob = path.basename(sockJacob).split('-')[1];
      const hashErik = path.basename(sockErik).split('-')[1];
      expect(hashJacob).toBeTruthy();
      expect(hashErik).toBeTruthy();
      expect(hashJacob).not.toBe(hashErik);

      // 12. Shared folders and S3 profiles propagate (and delete cleanly) across tenants
      await jacobWs.invoke('profiles:save-folder', 'Production Cluster');
      await jacobWs.invoke('profiles:save-s3', {
        id: 'team-s3-1',
        name: 'Team Backup Bucket',
        bucket: 'team-backups',
        region: 'eu-north-1',
        accessKeyId: 'AKIA123',
      });
      const erikProfilesAfterFolder = await erikWs.invoke('profiles:get');
      expect(erikProfilesAfterFolder.folders).toContain('Production Cluster');
      expect(erikProfilesAfterFolder.s3.some((s: any) => s.id === 'team-s3-1')).toBe(true);

      await erikWs.invoke('profiles:delete-folder', 'Production Cluster');
      await erikWs.invoke('profiles:delete-s3', 'team-s3-1');
      const jacobProfilesAfterFolderDel = await jacobWs.invoke('profiles:get');
      expect(jacobProfilesAfterFolderDel.folders ?? []).not.toContain('Production Cluster');
      expect(jacobProfilesAfterFolderDel.s3.some((s: any) => s.id === 'team-s3-1')).toBe(false);

      // 13. Even after Erik saves a personal copy of shared-prod-vm (e.g. on connect),
      // Jacob's topology updates and deletion propagate to Erik without zombie resurrection
      await erikWs.invoke('profiles:save-ssh', {
        ...sharedVm,
        lastUsedAt: new Date().toISOString(),
      });
      await jacobWs.invoke('profiles:save-ssh', {
        id: 'shared-prod-vm',
        name: 'Prod API Server v2',
        host: '10.20.30.50',
        port: 22,
        username: 'ubuntu',
        authType: 'privateKey',
      });
      const erikProfilesAfterUpdate = await erikWs.invoke('profiles:get');
      const updatedSharedVm = erikProfilesAfterUpdate.ssh.find((p: any) => p.id === 'shared-prod-vm');
      expect(updatedSharedVm?.name).toBe('Prod API Server v2');
      expect(updatedSharedVm?.host).toBe('10.20.30.50');

      await jacobWs.invoke('profiles:delete-ssh', 'shared-prod-vm');
      const erikProfilesAfterDel = await erikWs.invoke('profiles:get');
      expect(erikProfilesAfterDel.ssh.some((p: any) => p.id === 'shared-prod-vm')).toBe(false);
      const stateAfterDel = await erikWs.invoke('ai-hub:request', { action: 'snapshot' });
      expect(stateAfterDel.workspaceServers.some((s: any) => s.id === 'shared-prod-vm')).toBe(false);

      // 14. Password change & Invite revocation
      await apiJson(
        '/api/user/password',
        {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: 'erik-password-123',
            newPassword: 'erik-new-password-456',
          }),
        },
        erikReg.token
      );
      const erikReLogin = await apiJson('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'erik', password: 'erik-new-password-456' }),
      });
      expect(erikReLogin.user.username).toBe('erik');

      const inviteToRevoke = await apiJson(
        '/api/admin/invites',
        {
          method: 'POST',
          body: JSON.stringify({ role: 'member', maxUses: 2, note: 'Temp invite' }),
        },
        jacobSetup.token
      );
      await apiJson(
        `/api/admin/invites/${encodeURIComponent(inviteToRevoke.invite.token)}`,
        { method: 'DELETE' },
        jacobSetup.token
      );
      await expect(
        apiJson('/api/auth/register-invite', {
          method: 'POST',
          body: JSON.stringify({
            inviteToken: inviteToRevoke.invite.token,
            username: 'latecomer',
            password: 'password123',
          }),
        })
      ).rejects.toThrow();

      // 15. CSWSH protection rejects WebSocket upgrade from untrusted Origin
      const httpMod = await import('node:http');
      const cswshStatus = await new Promise<number>((resolve, reject) => {
        const u = new URL(`${baseUrl}/api/ws?token=${encodeURIComponent(jacobSetup.token)}`);
        const req = httpMod.request({
          hostname: u.hostname,
          port: u.port,
          path: u.pathname + u.search,
          method: 'GET',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': Buffer.from('1234567890123456').toString('base64'),
            'Sec-WebSocket-Version': '13',
            Origin: 'https://evil.example.com',
          },
        });
        req.on('response', (res) => {
          resolve(res.statusCode || 0);
          res.resume();
        });
        req.on('upgrade', (_res, sock) => {
          sock.destroy();
          resolve(101);
        });
        req.on('error', reject);
        req.end();
      });
      expect(cswshStatus).toBe(403);

      // 16. Deleting a user via Admin API disposes their active tenant, closes their WebSocket, and removes their data directory
      await apiJson(
        `/api/admin/users/${encodeURIComponent(erikReg.user.id)}`,
        { method: 'DELETE' },
        jacobSetup.token
      );
      const erikAuthCheck = await apiJson('/api/auth/status', {}, erikReg.token);
      expect(erikAuthCheck.authenticated).toBe(false);
      await expect(fs.stat(erikHome)).rejects.toThrow();
    } finally {
      jacobWs.close();
      erikWs.close();
    }
  }, 20000);
});
