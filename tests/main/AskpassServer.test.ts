import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AskpassServer } from '../../src/main/smartcard/AskpassServer';
import * as AgentRegistry from '../../src/main/ssh/AgentRegistry';

describe('AskpassServer', () => {
  let server: AskpassServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  // Connects the same way the generated askpass-worker.cjs script does: a
  // Unix domain socket on POSIX (LOW finding, code review — closes the
  // "any local user can reach the loopback TCP port" gap on shared
  // multi-user Linux hosts), TCP loopback on Windows.
  async function sendClientRequest(
    endpoint: { port: number; socketPath: string | null },
    request: Record<string, any>
  ): Promise<Record<string, any>> {
    const connectOptions = endpoint.socketPath ? { path: endpoint.socketPath } : { port: endpoint.port, host: '127.0.0.1' };
    return new Promise((resolve, reject) => {
      const client = net.createConnection(connectOptions, () => {
        client.write(JSON.stringify(request) + '\n');
      });

      let response = '';
      client.on('data', (chunk) => {
        response += chunk.toString();
        if (response.includes('\n')) {
          try {
            const data = JSON.parse(response.trim());
            client.end();
            resolve(data);
          } catch (err) {
            client.end();
            reject(err);
          }
        }
      });

      client.on('error', reject);
    });
  }

  it('resolves a normal PIN prompt via promptHandler', async () => {
    const promptHandler = vi.fn().mockResolvedValue('secret-pin-123');
    server = new AskpassServer({ promptHandler, token: 'test-token' });
    const { port } = await server.start();
    const endpoint = { port, socketPath: server.getSocketPath() };

    const res = await sendClientRequest(endpoint, {
      token: 'test-token',
      prompt: 'Enter PIN for authenticator: ',
    });

    expect(promptHandler).toHaveBeenCalledWith('Enter PIN for authenticator: ');
    expect(res).toEqual({ pin: 'secret-pin-123' });
  });

  it('resolves pure presence prompt (promptType="none") immediately without calling promptHandler', async () => {
    const promptHandler = vi.fn().mockResolvedValue('should-not-be-called');
    const onPresence = vi.fn();
    server = new AskpassServer({ promptHandler, onPresence, token: 'test-token' });
    const { port } = await server.start();
    const endpoint = { port, socketPath: server.getSocketPath() };

    let presenceEmitted = false;
    server.on('presence', (prompt) => {
      expect(prompt).toContain('Confirm user presence');
      presenceEmitted = true;
    });

    const res = await sendClientRequest(endpoint, {
      token: 'test-token',
      prompt: 'Confirm user presence for key ED25519-SK SHA256:abc',
      promptType: 'none',
    });

    expect(promptHandler).not.toHaveBeenCalled();
    expect(onPresence).toHaveBeenCalledWith('Confirm user presence for key ED25519-SK SHA256:abc');
    expect(presenceEmitted).toBe(true);
    expect(res).toEqual({ pin: '' });
  });

  it('resolves pure presence prompt by text content even without promptType="none"', async () => {
    const promptHandler = vi.fn().mockResolvedValue('should-not-be-called');
    const onPresence = vi.fn();
    server = new AskpassServer({ promptHandler, onPresence, token: 'test-token' });
    const { port } = await server.start();
    const endpoint = { port, socketPath: server.getSocketPath() };

    const res = await sendClientRequest(endpoint, {
      token: 'test-token',
      prompt: 'Confirm user presence for key ED25519-SK SHA256:xyz',
    });

    expect(promptHandler).not.toHaveBeenCalled();
    expect(onPresence).toHaveBeenCalledWith('Confirm user presence for key ED25519-SK SHA256:xyz');
    expect(res).toEqual({ pin: '' });
  });

  it('calls promptHandler when presence is requested alongside a PIN', async () => {
    const promptHandler = vi.fn().mockResolvedValue('fido-pin-456');
    const onPresence = vi.fn();
    server = new AskpassServer({ promptHandler, onPresence, token: 'test-token' });
    const { port } = await server.start();
    const endpoint = { port, socketPath: server.getSocketPath() };

    const res = await sendClientRequest(endpoint, {
      token: 'test-token',
      prompt: 'Enter PIN and confirm user presence for ED25519-SK key SHA256:abc: ',
    });

    expect(promptHandler).toHaveBeenCalledWith(
      'Enter PIN and confirm user presence for ED25519-SK key SHA256:abc: '
    );
    expect(res).toEqual({ pin: 'fido-pin-456' });
  });

  it('rejects unauthorized tokens', async () => {
    const promptHandler = vi.fn();
    server = new AskpassServer({ promptHandler, token: 'valid-token' });
    const { port } = await server.start();
    const endpoint = { port, socketPath: server.getSocketPath() };

    const res = await sendClientRequest(endpoint, {
      token: 'wrong-token',
      prompt: 'Enter PIN:',
    });

    expect(promptHandler).not.toHaveBeenCalled();
    expect(res).toEqual({ error: 'Unauthorized token' });
  });

  // LOW finding (code review): a loopback TCP port has no OS-level access
  // control of its own — any local user on a shared multi-user Linux host
  // could connect to it. A Unix domain socket, inside a directory only this
  // OS user can even open() (mode 0700), closes that gap. Windows keeps TCP.
  it.skipIf(process.platform === 'win32')(
    'listens on a Unix domain socket inside a directory only this user can access',
    async () => {
      server = new AskpassServer({ promptHandler: vi.fn(), token: 'test-token' });
      await server.start();

      const socketPath = server.getSocketPath();
      expect(socketPath).not.toBeNull();

      const dirStat = await fs.stat(path.dirname(socketPath!));
      expect(dirStat.mode & 0o777).toBe(0o700);
    }
  );

  describe('crash-recovery registration', () => {
    let registryDir: string;

    afterEach(async () => {
      AgentRegistry._resetRegistryDir();
      if (registryDir) {
        await fs.rm(registryDir, { recursive: true, force: true });
      }
    });

    it('registers its tempDir on start and removes the record on stop', async () => {
      registryDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'agent-registry-askpass-test-'));
      AgentRegistry.configureRegistryDir(registryDir);

      server = new AskpassServer({ promptHandler: vi.fn(), token: 'test-token' });
      await server.start();

      const files = fsSync.readdirSync(registryDir);
      expect(files).toHaveLength(1);
      const entry = JSON.parse(fsSync.readFileSync(path.join(registryDir, files[0]), 'utf-8'));
      expect(entry.kind).toBe('askpass');
      expect(entry.ownerPid).toBe(process.pid);

      await server.stop();
      server = null;

      expect(fsSync.readdirSync(registryDir)).toHaveLength(0);
    });
  });

  // Low finding (code review 2026-11-03): a start that failed after the private temp folder was created left the
  // folder and the registry entry behind.
  it('removes its temp folder and registry entry when it cannot start listening', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'askpass-fail-'));
    const tmpdir = vi.spyOn(os, 'tmpdir').mockReturnValue(parent);
    const unregister = vi.spyOn(AgentRegistry, 'unregisterEntry');
    const failing = Object.assign(new EventEmitter(), {
      listen: () => void process.nextTick(() => failing.emit('error', new Error('listen EADDRINUSE'))),
      close: (cb?: () => void) => cb?.(),
    });
    const createServer = vi.spyOn(net, 'createServer').mockReturnValue(failing as unknown as net.Server);
    try {
      server = new AskpassServer({ promptHandler: async () => '' });
      await expect(server.start()).rejects.toThrow('EADDRINUSE');

      expect(await fs.readdir(parent)).toEqual([]);
      expect(unregister).toHaveBeenCalled();
    } finally {
      createServer.mockRestore();
      tmpdir.mockRestore();
      unregister.mockRestore();
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
