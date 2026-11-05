import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => {}) }));
vi.mock('electron', () => ({ shell: { openExternal } }));

import { registerK8sHandlers } from '../../src/main/ipc/k8sHandlers';
import { parseK8sServerArg, parseWebLoginOptions } from '../../src/main/ipc/ipcHelpers';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>;

function setup(webLogin: { probe: Handler; login: Handler; cancel: () => void }) {
  const handlers = new Map<string, Handler>();
  const send = vi.fn();
  const reload = vi.fn();
  const bridge = {
    registerHandler: (channel: string, handler: Handler) => handlers.set(channel, handler),
    broadcast: send,
    k8sDiscoveryService: { reload },
  };
  registerK8sHandlers(bridge as never, { openShiftWebLogin: webLogin as never });
  return { handlers, send, reload };
}

describe('OpenShift browser sign-in handlers', () => {
  beforeEach(() => openExternal.mockClear());

  it('validates the probe arguments before touching the network', async () => {
    const probe = vi.fn(async () => ({ supported: true }));
    const { handlers } = setup({ probe, login: vi.fn() as never, cancel: vi.fn() });
    const handler = handlers.get(IPC_CHANNELS.K8S_OPENSHIFT_PROBE)!;

    await expect(handler({}, '')).rejects.toThrow(/Server URL is required/);
    await expect(handler({}, 42)).rejects.toThrow(/Server URL is required/);
    expect(probe).not.toHaveBeenCalled();

    await expect(handler({}, 'api.cluster.example.com:6443', true)).resolves.toEqual({ supported: true });
    expect(probe).toHaveBeenCalledWith('api.cluster.example.com:6443', true);
  });

  it('rejects invalid sign-in options', async () => {
    const login = vi.fn();
    const { handlers } = setup({ probe: vi.fn() as never, login: login as never, cancel: vi.fn() });
    const handler = handlers.get(IPC_CHANNELS.K8S_OPENSHIFT_WEB_LOGIN)!;

    await expect(handler({}, null)).rejects.toThrow(/Invalid sign-in options/);
    await expect(handler({}, { server: 'https://api.example.com', callbackPort: 80 })).rejects.toThrow(/Callback port/);
    await expect(handler({}, { server: 'https://api.example.com', callbackPort: 70000 })).rejects.toThrow(/Callback port/);
    await expect(handler({}, { server: 'https://api.example.com', insecureSkipTlsVerify: 'yes' })).rejects.toThrow(/TLS option/);
    expect(login).not.toHaveBeenCalled();
  });

  it('only opens https sign-in URLs in the browser', async () => {
    const login = vi.fn(async (_options: unknown, hooks: { onAuthorizeUrl: (url: string) => void }) => {
      hooks.onAuthorizeUrl('http://oauth.example.com/authorize');
      return { token: 't' };
    });
    const { handlers } = setup({ probe: vi.fn() as never, login: login as never, cancel: vi.fn() });
    await expect(
      handlers.get(IPC_CHANNELS.K8S_OPENSHIFT_WEB_LOGIN)!({}, { server: 'https://api.example.com:6443' })
    ).rejects.toThrow(/non-https/);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the authorization URL, stores the token in the kubeconfig and notifies the UI', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-openshift-login-'));
    const kubeConfigPath = path.join(dir, 'config');
    const cluster = http.createServer((req, res) => {
      if (req.url === '/apis/user.openshift.io/v1/users/~') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ metadata: { name: 'alice' } }));
      } else if (req.url === '/apis/project.openshift.io/v1/projects') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ metadata: { name: 'team-a' } }] }));
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => cluster.listen(0, '127.0.0.1', () => resolve()));
    const server = `http://127.0.0.1:${(cluster.address() as AddressInfo).port}`;

    const login = vi.fn(async (_options: unknown, hooks: { onAuthorizeUrl: (url: string) => void }) => {
      hooks.onAuthorizeUrl('https://oauth.example.com/oauth/authorize?client_id=openshift-cli-client');
      return { token: 'sha256~from-browser', expiresAt: '2026-10-22T10:00:00.000Z' };
    });
    const { handlers, send, reload } = setup({ probe: vi.fn() as never, login: login as never, cancel: vi.fn() });

    const previous = process.env.KUBECONFIG;
    process.env.KUBECONFIG = kubeConfigPath;
    try {
      const result = await handlers.get(IPC_CHANNELS.K8S_OPENSHIFT_WEB_LOGIN)!({}, { server });
      expect(openExternal).toHaveBeenCalledWith('https://oauth.example.com/oauth/authorize?client_id=openshift-cli-client');
      expect(result.success).toBe(true);
      expect(result.userName).toContain('alice');
      expect(result.expiresAt).toBe('2026-10-22T10:00:00.000Z');
      expect(fs.readFileSync(kubeConfigPath, 'utf8')).toContain('sha256~from-browser');
      expect(reload).toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.K8S_CONFIG_CHANGED);
    } finally {
      if (previous === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = previous;
      cluster.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forwards cancel to the sign-in service', async () => {
    const cancel = vi.fn();
    const { handlers } = setup({ probe: vi.fn() as never, login: vi.fn() as never, cancel });
    await handlers.get(IPC_CHANNELS.K8S_OPENSHIFT_WEB_LOGIN_CANCEL)!({});
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('sign-in argument validation', () => {
  it('accepts server URLs with or without a scheme', () => {
    expect(parseK8sServerArg(' https://api.example.com:6443 ')).toBe('https://api.example.com:6443');
    expect(parseK8sServerArg('api.example.com:6443')).toBe('api.example.com:6443');
  });

  it('rejects empty, oversized and malformed server URLs', () => {
    expect(() => parseK8sServerArg('   ')).toThrow(/required/);
    expect(() => parseK8sServerArg('x'.repeat(3000))).toThrow(/too long/);
    expect(() => parseK8sServerArg('http://')).toThrow(/Invalid server URL/);
  });

  it('normalizes options and drops an empty namespace', () => {
    expect(
      parseWebLoginOptions({ server: 'https://api.example.com', namespace: '  ', callbackPort: 8250, insecureSkipTlsVerify: false })
    ).toEqual({ server: 'https://api.example.com', callbackPort: 8250, insecureSkipTlsVerify: false });
    expect(parseWebLoginOptions({ server: 'https://api.example.com', namespace: ' dev ' }).namespace).toBe('dev');
  });

  it('rejects non-integer ports and oversized namespaces', () => {
    expect(() => parseWebLoginOptions({ server: 'https://a.example.com', callbackPort: 8250.5 })).toThrow(/Callback port/);
    expect(() => parseWebLoginOptions({ server: 'https://a.example.com', callbackPort: '8250' })).toThrow(/Callback port/);
    expect(() => parseWebLoginOptions({ server: 'https://a.example.com', namespace: 'n'.repeat(300) })).toThrow(/namespace/);
  });
});

describe('saved cluster profile handlers', () => {
  const profile = { id: 'p1', name: 'Prod', server: 'https://api.example.com:6443', namespace: 'team-a' };

  function setupProfiles() {
    const store = {
      list: vi.fn(async () => [profile]),
      save: vi.fn(async (p: unknown) => p),
      delete: vi.fn(async () => {}),
    };
    const handlers = new Map<string, Handler>();
    const bridge = {
      registerHandler: (channel: string, handler: Handler) => handlers.set(channel, handler),
      broadcast: vi.fn(),
      k8sDiscoveryService: { reload: vi.fn() },
    };
    registerK8sHandlers(bridge as never, { openShiftWebLogin: {} as never, profileStore: store as never });
    return { handlers, store };
  }

  it('lists profiles from the store', async () => {
    const { handlers } = setupProfiles();
    await expect(handlers.get(IPC_CHANNELS.K8S_PROFILES_LIST)!({})).resolves.toEqual([profile]);
  });

  it('validates a profile before saving and strips unknown fields', async () => {
    const { handlers, store } = setupProfiles();
    const save = handlers.get(IPC_CHANNELS.K8S_PROFILES_SAVE)!;

    await expect(save({}, { ...profile, id: '../etc' })).rejects.toThrow(/profile id/);
    await expect(save({}, 'nope')).rejects.toThrow(/Invalid profile/);
    expect(store.save).not.toHaveBeenCalled();

    await save({}, { ...profile, token: 'sha256~secret' });
    expect(store.save).toHaveBeenCalledWith(profile);
  });

  it('deletes only by a non-empty string id', async () => {
    const { handlers, store } = setupProfiles();
    const del = handlers.get(IPC_CHANNELS.K8S_PROFILES_DELETE)!;
    await expect(del({}, 42)).rejects.toThrow(/Invalid profile id/);
    await expect(del({}, '')).rejects.toThrow(/Invalid profile id/);
    await del({}, 'p1');
    expect(store.delete).toHaveBeenCalledWith('p1');
  });
});

describe('K8S_LOGIN server validation', () => {
  it('refuses an unsafe server before any token is sent anywhere', async () => {
    const { handlers } = setup({ probe: vi.fn() as never, login: vi.fn() as never, cancel: vi.fn() });
    const login = handlers.get(IPC_CHANNELS.K8S_LOGIN)!;
    await expect(login({}, { server: 'http://api.example.com:6443', token: 't' })).rejects.toThrow(/must use https/);
    await expect(login({}, { server: 'https://u:p@api.example.com', token: 't' })).rejects.toThrow(/user name or password/);
    await expect(login({}, undefined)).rejects.toThrow(/Server URL is required/);
  });
});
