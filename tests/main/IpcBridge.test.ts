import { captureLogs } from './helpers/captureLogs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fsp from 'node:fs/promises';

const { mockIpcRenderer, mockExposeInMainWorld } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  return {
    mockExposeInMainWorld: vi.fn(),
    mockIpcRenderer: {
      invoke: vi.fn().mockImplementation(async (channel: string, ...args: any[]) => {
        return { invoked: channel, args };
      }),
      on: vi.fn().mockImplementation((channel: string, listener: (...args: any[]) => void) => {
        if (!listeners.has(channel)) {
          listeners.set(channel, new Set());
        }
        listeners.get(channel)!.add(listener);
      }),
      removeListener: vi.fn().mockImplementation((channel: string, listener: (...args: any[]) => void) => {
        listeners.get(channel)?.delete(listener);
      }),
    },
  };
});

vi.mock('electron', () => {
  const mockObj = {
    ipcRenderer: mockIpcRenderer,
    contextBridge: {
      exposeInMainWorld: mockExposeInMainWorld,
    },
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    },
    app: {
      getVersion: vi.fn().mockReturnValue('0.1.0'),
      getPath: vi.fn().mockReturnValue('/tmp/user-data'),
    },
    dialog: {
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/chosen/file.pem'] }),
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/chosen/export.json' }),
    },
    shell: {
      openPath: vi.fn().mockResolvedValue(''),
    },
    BrowserWindow: vi.fn(),
  };
  return {
    ...mockObj,
    default: mockObj,
  };
});

vi.mock('../../src/main/ssh/KeyInstallService', () => ({
  installPublicKeys: vi.fn(),
  verifyKeyLogin: vi.fn(),
  probeHost: vi.fn(),
  testLogin: vi.fn(),
}));

import { installPublicKeys, probeHost, testLogin } from '../../src/main/ssh/KeyInstallService';
import { IpcBridge } from '../../src/main/IpcBridge';
import { IPC_CHANNELS } from '../../src/shared/types/ipc';
import { api as preloadApi, exposePreloadApi } from '../../src/preload/index';
import { SmartcardDetector } from '../../src/main/smartcard/SmartcardDetector';
import * as SmartcardAgentLoader from '../../src/main/smartcard/SmartcardAgentLoader';
import * as SmartcardCertificateReader from '../../src/main/smartcard/SmartcardCertificateReader';
import * as Fido2DeviceDetector from '../../src/main/smartcard/Fido2DeviceDetector';
import { fingerprintOfKeyBlob } from '../../src/main/ssh/AppAgent';
import type { IStorageProvider, FileEntry } from '../../src/shared/types/storage';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

// Mock IpcMain implementation for main process testing
class MockIpcMain {
  handlers: Map<string, (...args: any[]) => any> = new Map();
  /**
   * senderFrame simulated by invoke() below, standing in for a call from
   * the trusted main window (see H3's assertTrustedSender). Tests that
   * exercise the untrusted-frame rejection path call the registered
   * handler directly instead of going through invoke() — see the "IPC
   * sender frame validation (H3)" tests.
   */
  defaultSenderFrame: unknown = {};

  handle(channel: string, listener: (...args: any[]) => any) {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }

  async invoke(channel: string, ...args: any[]): Promise<any> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No handler registered for channel "${channel}"`);
    }
    return await handler({ senderFrame: this.defaultSenderFrame } as any, ...args);
  }
}

// Mock WebContents
class MockWebContents {
  events: Array<{ channel: string; args: any[] }> = [];
  destroyed = false;
  /** Stands in for the real WebFrameMain the H3 sender-frame check compares against. */
  mainFrame = { url: 'file:///app/index.html' };

  send(channel: string, ...args: any[]) {
    if (!this.destroyed) {
      this.events.push({ channel, args });
    }
  }

  isDestroyed() {
    return this.destroyed;
  }
}

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
/** The app-agent code paths under test are Linux/macOS-only (on Windows the agent is the shared OpenSSH service). */
const pretendUnix = () => Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

function makeFakeAppAgent() {
  const socketPath = '/tmp/app-agent.sock';
  const fake = {
    identities: [] as Array<{ bits: string; fingerprint: string; comment: string; keyType: string }>,
    setHandlers: vi.fn(),
    setOnExit: vi.fn(),
    getSocketPath: vi.fn().mockReturnValue(socketPath),
    ensure: vi.fn().mockResolvedValue(socketPath),
    list: vi.fn(async () => fake.identities),
    addPkcs11: vi.fn().mockResolvedValue(undefined),
    addFido2Resident: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    lockAll: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    writePublicKeyFiles: vi.fn().mockResolvedValue([]),
    removeIdentities: vi.fn().mockResolvedValue(0),
    adoptIdentities: vi.fn().mockResolvedValue(undefined),
    evictIdentities: vi.fn().mockResolvedValue(undefined),
    noteLoadedLibrary: vi.fn(),
  };
  return fake;
}

describe('IpcBridge', () => {
  let fakeAppAgent: ReturnType<typeof makeFakeAppAgent>;
  afterEach(() => {
    Object.defineProperty(process, 'platform', hostPlatform);
  });
  let syncAgentBlockSpy: ReturnType<typeof vi.fn>;
  let mockIpc: MockIpcMain;
  let mockWebContents: MockWebContents;
  let mockPtyManager: any;
  let mockStorageRegistry: any;
  let mockTransferQueue: any;
  let mockProfileStore: any;
  let mockSessionStore: any;
  let mockSettingsStore: any;
  let mockAwsSsoAuthService: any;
  let bridge: IpcBridge;

  beforeEach(() => {
    mockIpc = new MockIpcMain();
    mockWebContents = new MockWebContents();
    // Card / key presence checks would read sysfs or spawn a PKCS#11 worker: tests run with the token plugged in.
    vi.spyOn(Fido2DeviceDetector, 'isFido2DeviceConnected').mockResolvedValue(true);
    vi.spyOn(SmartcardCertificateReader, 'isSmartcardTokenPresent').mockResolvedValue(true);
    mockIpc.defaultSenderFrame = mockWebContents.mainFrame;

    const ptyEmitter = new EventEmitter();
    mockPtyManager = Object.assign(ptyEmitter, {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-123' }),
      createShellSession: vi.fn().mockResolvedValue({ sessionId: 'local-session-123' }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      killAll: vi.fn().mockResolvedValue(undefined),
    });

    const mockProvider: IStorageProvider = {
      id: 'test-storage',
      name: 'Test Storage',
      type: 'local',
      list: vi.fn().mockResolvedValue([{ name: 'file.txt', path: '/file.txt', size: 100, isDirectory: false }]),
      stat: vi.fn().mockResolvedValue({ name: 'file.txt', path: '/file.txt', size: 100, isDirectory: false }),
      createFolder: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
      createReadStream: vi.fn(),
      createWriteStream: vi.fn(),
      getHomeDir: vi.fn().mockResolvedValue('/home/testuser'),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };

    mockStorageRegistry = {
      providers: new Map<string, IStorageProvider>([['test-storage', mockProvider]]),
      getOrCreate: vi.fn().mockImplementation(async (config: any) => {
        mockStorageRegistry.providers.set(config.id, mockProvider);
        return mockProvider;
      }),
      get: vi.fn().mockImplementation((id: string) => mockStorageRegistry.providers.get(id)),
      disconnect: vi.fn().mockResolvedValue(undefined),
      disconnectAll: vi.fn().mockResolvedValue(undefined),
    };

    const transferEmitter = new EventEmitter();
    mockTransferQueue = Object.assign(transferEmitter, {
      addJob: vi.fn().mockReturnValue({ id: 'job-123' }),
      pauseJob: vi.fn(),
      resumeJob: vi.fn(),
      cancelJob: vi.fn(),
      getJobs: vi.fn().mockReturnValue([
        {
          id: 'job-123',
          progress: {
            jobId: 'job-123',
            fileName: 'file.txt',
            transferredBytes: 50,
            totalBytes: 100,
            percentage: 50,
            bytesPerSecond: 10,
            status: 'running',
          },
        },
      ]),
      clearCompleted: vi.fn(),
      cancelAll: vi.fn(),
      getActiveTransferCount: vi.fn().mockReturnValue(0),
      hasActiveTransfers: vi.fn().mockReturnValue(false),
    });

    mockProfileStore = {
      getProfiles: vi.fn().mockResolvedValue({ ssh: [], s3: [] }),
      saveSSH: vi.fn().mockResolvedValue(undefined),
      deleteSSH: vi.fn().mockResolvedValue(undefined),
      saveS3: vi.fn().mockResolvedValue(undefined),
      deleteS3: vi.fn().mockResolvedValue(undefined),
    };

    mockSessionStore = {
      getSession: vi.fn().mockResolvedValue({ tabs: [], activeTabId: 't1' }),
      saveSession: vi.fn().mockResolvedValue(undefined),
      getSessionForWindow: vi.fn().mockResolvedValue({ tabs: [], activeTabId: 't1' }),
      saveSessionForWindow: vi.fn().mockResolvedValue(undefined),
    };

    mockSettingsStore = {
      getSettings: vi.fn().mockResolvedValue({ theme: 'system', terminal: { fontSize: 14, fontFamily: 'monospace' }, defaultTabType: 'terminal' }),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };

    mockAwsSsoAuthService = {
      login: vi.fn().mockImplementation(() => new Promise(() => {})),
      listAccounts: vi.fn().mockResolvedValue([{ accountId: '123', accountName: 'Prod' }]),
      listAccountRoles: vi.fn().mockResolvedValue([{ roleName: 'Admin' }]),
    };

    bridge = new IpcBridge({
      ipcMain: mockIpc as any,
      sshPtyManager: mockPtyManager,
      storageRegistry: mockStorageRegistry,
      transferQueue: mockTransferQueue,
      profileStore: mockProfileStore,
      sessionStore: mockSessionStore,
      settingsStore: mockSettingsStore,
      awsSsoAuthService: mockAwsSsoAuthService,
      getWebContents: () => mockWebContents as any,
    });

    fakeAppAgent = makeFakeAppAgent();
    (bridge as any).smartcard.appAgent = fakeAppAgent;
    // Never read the developer's real sync config when filtering a card's keys.
    vi.spyOn(bridge.syncConfigStore, 'getConfig').mockResolvedValue({} as any);
    // The default ProfileSyncService would read/write the developer's real ~/.ssh/config.
    syncAgentBlockSpy = vi.fn().mockResolvedValue(undefined);
    (bridge as any).profileSyncService.syncAgentBlockToLocalSshConfig = syncAgentBlockSpy;
    (bridge as any).profileSyncService.autoSyncLocalSshConfig = vi.fn().mockResolvedValue(undefined);
    bridge.register();
  });

  afterEach(async () => {
    await bridge.dispose();
    vi.mocked(Fido2DeviceDetector.isFido2DeviceConnected).mockRestore?.();
  });

  // Regression test for the H3 finding (code review): registerHandler now
  // wraps every IPC handler with a check that the calling frame is the
  // trusted main window frame, as defense-in-depth against a future
  // regression that lets a second frame or a <webview> reach this
  // privileged API. Bypasses MockIpcMain.invoke() (which always simulates a
  // trusted call) to invoke the raw registered handler directly with a
  // forged senderFrame.
  describe('IPC sender frame validation (H3)', () => {
    it('rejects a call whose senderFrame does not match the main window', async () => {
      const handler = mockIpc.handlers.get(IPC_CHANNELS.SMARTCARD_LOCK_ALL)!;
      const untrustedEvent = { senderFrame: { url: 'https://evil.example.com' } } as any;
      await expect(handler(untrustedEvent)).rejects.toThrow(/untrusted frame/i);
    });

    it('still allows a call whose senderFrame matches the main window', async () => {
      const handler = mockIpc.handlers.get(IPC_CHANNELS.SMARTCARD_LOCK_ALL)!;
      const trustedEvent = { senderFrame: mockWebContents.mainFrame } as any;
      await expect(handler(trustedEvent)).resolves.toBeDefined();
    });
  });

  describe('Terminal IPC Handlers & Events', () => {
    it('handles terminalCreate', async () => {
      const config: SSHConnectionConfig = {
        id: 'conn-1',
        name: 'SSH 1',
        host: 'localhost',
        username: 'user',
        authType: 'password',
      };
      const res = await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { config, ptyOptions: { cols: 100, rows: 40 } });
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(config, { cols: 100, rows: 40 });
      expect(res).toEqual({ sessionId: 'session-123' });
    });

    it('forwards the agent/OpenSSH\'s own raw prompt text for a FIDO2 resident connect, rather than replacing it with a fixed string', async () => {
      // Regression test: prepareFido2Config used to build its own fixed "Enter your security
      // key's PIN to connect to X:" string and pass that to promptForPin instead of the actual
      // raw prompt ssh-add/the agent asked for — silently discarding wording like "Confirm user
      // presence for key ..." that the renderer's touch-hint UI depends on to detect that a
      // physical touch, not just a PIN, is needed for this specific prompt.
      let capturedPromptHandler: ((prompt: string) => Promise<string> | string) | undefined;
      const loadSpy = vi
        .spyOn(SmartcardAgentLoader, 'loadFido2ResidentKeysIntoPrivateAgent')
        .mockImplementation((promptHandler) => {
          capturedPromptHandler = promptHandler;
          return new Promise(() => {}); // never resolves; only the captured handler matters here
        });
      mockPtyManager.promptForPin = vi.fn().mockResolvedValue('123456');

      const config: SSHConnectionConfig = {
        id: 'fido2-conn-1',
        name: 'gnarg fido2',
        host: 'gnarg.example.com',
        username: 'alun',
        authType: 'fido2',
        fido2Resident: true,
      };
      void mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { config, ptyOptions: { cols: 100, rows: 40 } });
      await new Promise((resolve) => setImmediate(resolve));

      expect(capturedPromptHandler).toBeTypeOf('function');
      await capturedPromptHandler!('Confirm user presence for key ED25519-SK SHA256:abc123');

      expect(mockPtyManager.promptForPin).toHaveBeenCalledWith(
        'fido2-conn-1',
        expect.stringContaining('Confirm user presence for key ED25519-SK SHA256:abc123'),
        'fido2',
        'connecting to gnarg fido2',
        undefined
      );

      loadSpy.mockRestore();
    });

    it('caches FIDO2 resident keys globally across connections when smartcardAuthMode is agent-global', async () => {
      mockSettingsStore.getSettings = vi.fn().mockResolvedValue({
        smartcardAuthMode: 'agent-global',
      });
      fakeAppAgent.addFido2Resident.mockImplementation(async () => {
        fakeAppAgent.identities = [{ bits: '256', fingerprint: 'SHA256:sk1', comment: 'sk', keyType: 'ED25519-SK' }];
      });
      fakeAppAgent.writePublicKeyFiles.mockResolvedValue(['/tmp/keys/sk1.pub']);

      const config1: SSHConnectionConfig = {
        id: 'fido2-conn-1',
        name: 'host1',
        host: 'host1.example.com',
        username: 'alun',
        authType: 'fido2',
        fido2Resident: true,
      };

      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { config: config1, ptyOptions: { cols: 100, rows: 40 } });
      expect(fakeAppAgent.addFido2Resident).toHaveBeenCalledTimes(1);
      // The shared agent holds every unlocked card, so the connection is pinned to this key's public file.
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentPath: '/tmp/app-agent.sock', agentIdentityFiles: ['/tmp/keys/sk1.pub'] }),
        expect.anything()
      );
      expect(fakeAppAgent.writePublicKeyFiles).toHaveBeenCalledWith(new Set(['SHA256:sk1']));

      // Second connection reuses the loaded keys without loading again
      const config2: SSHConnectionConfig = {
        id: 'fido2-conn-2',
        name: 'host2',
        host: 'host2.example.com',
        username: 'alun',
        authType: 'fido2',
        fido2Resident: true,
      };

      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { config: config2, ptyOptions: { cols: 100, rows: 40 } });
      expect(fakeAppAgent.addFido2Resident).toHaveBeenCalledTimes(1);
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentPath: '/tmp/app-agent.sock' }),
        expect.anything()
      );

      // Locking smartcards makes the agent forget its keys (the agent itself keeps running)
      const lockedResult = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_LOCK_ALL);
      expect(lockedResult).toEqual({ locked: 1 });
      expect(fakeAppAgent.lockAll).toHaveBeenCalledTimes(1);
      expect(fakeAppAgent.shutdown).not.toHaveBeenCalled();
    });

    it('pins a smartcard profile to its own card\'s keys when connecting through the app agent', async () => {
      mockSettingsStore.getSettings = vi.fn().mockResolvedValue({ smartcardAuthMode: 'agent-global' });
      const certs = new Map([['SHA256:piv1', { fingerprint: 'SHA256:piv1' } as any]]);
      const readCertsSpy = vi.spyOn(SmartcardCertificateReader, 'readSmartcardCertificates').mockResolvedValue(certs);
      fakeAppAgent.writePublicKeyFiles.mockResolvedValue(['/tmp/keys/piv1.pub']);

      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, {
        config: {
          id: 'sc-1',
          name: 'card host',
          host: 'card.example.com',
          username: 'alun',
          authType: 'smartcard',
          pkcs11LibPath: '/usr/lib/opensc-pkcs11.so',
        } as SSHConnectionConfig,
        ptyOptions: { cols: 100, rows: 40 },
      });

      expect(fakeAppAgent.addPkcs11).toHaveBeenCalledTimes(1);
      expect(fakeAppAgent.writePublicKeyFiles).toHaveBeenCalledWith(new Set(['SHA256:piv1']));
      expect(mockPtyManager.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ agentPath: '/tmp/app-agent.sock', agentIdentityFiles: ['/tmp/keys/piv1.pub'] }),
        expect.anything()
      );
      readCertsSpy.mockRestore();
    });

    describe('local ~/.ssh/config agent block', () => {
      const flush = async () => {
        await (bridge as any).smartcard.agentConfigRefresh;
      };

      it('points unlocked PIV and FIDO2 profiles at the app agent, and removes the block on lock and dispose', async () => {
        pretendUnix();
        mockSettingsStore.getSettings = vi.fn().mockResolvedValue({ smartcardAuthMode: 'agent-global' });
        mockProfileStore.getProfiles.mockResolvedValue({
          ssh: [
            { id: 'p1', name: 'piv host', host: 'a.example.com', username: 'u', authType: 'smartcard', pkcs11LibPath: '/usr/lib/opensc-pkcs11.so' },
            { id: 'p2', name: 'fido host', host: 'b.example.com', username: 'u', authType: 'fido2', fido2Resident: true },
            { id: 'p3', name: 'password host', host: 'c.example.com', username: 'u', authType: 'password' },
            { id: 'p4', name: 'locked card', host: 'd.example.com', username: 'u', authType: 'smartcard', pkcs11LibPath: '/usr/lib/other.so' },
          ],
          s3: [],
        });
        fakeAppAgent.writePublicKeyFiles.mockImplementation(async (fps: Iterable<string>) => [`/k/${[...fps][0]}.pub`]);
        (bridge as any).smartcard.globalCards.set('/usr/lib/opensc-pkcs11.so', { fingerprints: new Set(['SHA256:piv']) });
        (bridge as any).smartcard.globalCards.set('__fido2__', { fingerprints: new Set(['SHA256:sk']) });

        bridge.smartcard.refreshAgentSshConfig();
        await flush();

        const entries = syncAgentBlockSpy.mock.calls.at(-1)![0];
        expect(entries).toEqual([
          { alias: 'piv-host', agentSocket: '/tmp/app-agent.sock', identityFiles: ['/k/SHA256:piv.pub'] },
          { alias: 'fido-host', agentSocket: '/tmp/app-agent.sock', identityFiles: ['/k/SHA256:sk.pub'] },
        ]);

        await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_LOCK_ALL);
        await flush();
        expect(syncAgentBlockSpy.mock.calls.at(-1)![0]).toBeNull();

        (bridge as any).smartcard.globalCards.set('__fido2__', { fingerprints: new Set(['SHA256:sk']) });
        bridge.smartcard.refreshAgentSshConfig();
        await flush();
        expect(syncAgentBlockSpy.mock.calls.at(-1)![0]).not.toBeNull();

        await bridge.dispose();
        expect(syncAgentBlockSpy.mock.calls.at(-1)![0]).toBeNull();
        mockProfileStore.getProfiles.mockResolvedValue({ ssh: [], s3: [] });
      });

      it('refreshes the block after every managed-block sync, including a remote pull', async () => {
        mockSettingsStore.getSettings = vi.fn().mockResolvedValue({ smartcardAuthMode: 'agent-global' });
        (bridge as any).smartcard.globalCards.set('__fido2__', { fingerprints: new Set(['SHA256:sk']) });
        syncAgentBlockSpy.mockClear();

        // ProfileSyncService calls this hook from autoSyncLocalSshConfig (profile edits and pulls alike).
        (bridge as any).profileSyncService.onLocalSshConfigSynced();
        await flush();

        expect(syncAgentBlockSpy).toHaveBeenCalledTimes(1);
      });

      it('writes no block outside agent-global mode', async () => {
        mockSettingsStore.getSettings = vi.fn().mockResolvedValue({ smartcardAuthMode: 'always-prompt' });
        (bridge as any).smartcard.globalCards.set('__fido2__', { fingerprints: new Set(['SHA256:sk']) });
        bridge.smartcard.refreshAgentSshConfig();
        await flush();
        expect(syncAgentBlockSpy.mock.calls.at(-1)![0]).toBeNull();
      });
    });

    it('throws when creating terminal without config', async () => {
      await expect(mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, null as any)).rejects.toThrow();
    });

    it('local shell terminals get no SSH_AUTH_SOCK override when no smartcard is cached globally', async () => {
      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { local: true, ptyOptions: { cols: 80, rows: 24 } });
      expect(mockPtyManager.createShellSession).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    });

    it('local shell terminals point SSH_AUTH_SOCK at the app agent under agent-global, even while it is empty', async () => {
      pretendUnix();
      mockSettingsStore.getSettings = vi.fn().mockResolvedValue({ smartcardAuthMode: 'agent-global' });

      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { local: true, ptyOptions: { cols: 80, rows: 24 } });

      expect(fakeAppAgent.ensure).toHaveBeenCalled();
      expect(mockPtyManager.createShellSession).toHaveBeenCalledWith({
        cols: 80,
        rows: 24,
        env: { SSH_AUTH_SOCK: '/tmp/app-agent.sock' },
      });
    });

    it('local shell terminals keep the default agent when the app agent cannot start', async () => {
      mockSettingsStore.getSettings = vi.fn().mockResolvedValue({ smartcardAuthMode: 'agent-global' });
      fakeAppAgent.ensure.mockRejectedValue(new Error('no ssh-agent binary'));

      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { local: true, ptyOptions: { cols: 80, rows: 24 } });

      expect(mockPtyManager.createShellSession).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    });

    it('local shell terminals leave SSH_AUTH_SOCK alone in System Only mode or outside agent-global', async () => {
      mockSettingsStore.getSettings = vi
        .fn()
        .mockResolvedValue({ smartcardAuthMode: 'agent-global', localTerminalAgentMode: 'system' });
      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { local: true, ptyOptions: { cols: 80, rows: 24 } });
      expect(mockPtyManager.createShellSession).toHaveBeenLastCalledWith({ cols: 80, rows: 24 });

      mockSettingsStore.getSettings = vi.fn().mockResolvedValue({ smartcardAuthMode: 'always-prompt' });
      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_CREATE, { local: true, ptyOptions: { cols: 80, rows: 24 } });
      expect(mockPtyManager.createShellSession).toHaveBeenLastCalledWith({ cols: 80, rows: 24 });
      expect(fakeAppAgent.ensure).not.toHaveBeenCalled();
    });

    it('handles terminalWrite, resize, and kill', async () => {
      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_WRITE, 'session-123', 'ls -la\n');
      expect(mockPtyManager.write).toHaveBeenCalledWith('session-123', 'ls -la\n');

      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_RESIZE, 'session-123', 120, 30);
      expect(mockPtyManager.resize).toHaveBeenCalledWith('session-123', 120, 30);

      await mockIpc.invoke(IPC_CHANNELS.TERMINAL_KILL, 'session-123');
      expect(mockPtyManager.kill).toHaveBeenCalledWith('session-123');
    });

    it('forwards pty data events to webContents', () => {
      mockPtyManager.emit('data', { sessionId: 'session-123', data: 'hello world' });
      expect(mockWebContents.events).toContainEqual({
        channel: IPC_CHANNELS.TERMINAL_DATA,
        args: ['session-123', 'hello world'],
      });
    });

    it('forwards pty exit events to webContents', () => {
      mockPtyManager.emit('exit', { sessionId: 'session-123', exitCode: 0, signal: undefined });
      expect(mockWebContents.events).toContainEqual({
        channel: IPC_CHANNELS.TERMINAL_EXIT,
        args: ['session-123', { exitCode: 0, signal: undefined }],
      });
    });

    it('forwards pty presence events to webContents as PRESENCE_PROMPT', () => {
      mockPtyManager.emit('presence', { sessionId: 'session-123', prompt: 'Confirm user presence for key ED25519-SK' });
      expect(mockWebContents.events).toContainEqual({
        channel: IPC_CHANNELS.PRESENCE_PROMPT,
        args: [
          expect.objectContaining({
            sessionId: 'session-123',
            message: 'Touch your security key to confirm',
          }),
        ],
      });
    });

    it('does not send pty events if webContents is destroyed', () => {
      mockWebContents.destroyed = true;
      mockPtyManager.emit('data', { sessionId: 'session-123', data: 'dropped' });
      expect(mockWebContents.events).toHaveLength(0);
    });
  });

  describe('Smartcard & Askpass Handlers & Events', () => {
    it('handles smartcardDetect', async () => {
      const libs = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_DETECT);
      expect(Array.isArray(libs)).toBe(true);
    });

    it('handles smartcardValidate', async () => {
      const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_VALIDATE, '/non/existent/path.so');
      expect(res.valid).toBe(false);
      expect(res.error).toBeDefined();
    });

    describe('smartcardUnlockAtStartup', () => {
      let tokenPresentSpy: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        // The card/key presence checks spawn a real worker / read sysfs: pin them to "present".
        tokenPresentSpy = vi.spyOn(SmartcardCertificateReader, 'isSmartcardTokenPresent').mockResolvedValue(true);
      });
      afterEach(() => tokenPresentSpy.mockRestore());

      it('does nothing when the setting is off', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: false, smartcardAuthMode: 'agent-global' });
        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        expect(res).toEqual({ started: false });
      });

      describe('waitForTokenDirect', () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        it('prompts, polls, and dismisses the prompt once the token shows up', async () => {
          const isPresent = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);

          const waiting = bridge.waitForTokenDirect('fido2', 'SSH: host', isPresent, 100);
          const prompt = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.INSERT_TOKEN_PROMPT);
          expect(prompt?.args[0]).toMatchObject({ kind: 'fido2', context: 'SSH: host' });

          await vi.advanceTimersByTimeAsync(100);
          expect(isPresent).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(100);

          await expect(waiting).resolves.toBe(true);
          expect(mockWebContents.events).toContainEqual({
            channel: IPC_CHANNELS.INSERT_TOKEN_DISMISS,
            args: [{ id: prompt!.args[0].id }],
          });
          expect(bridge.pendingInsertTokens.size).toBe(0);
        });

        it('resolves false when the user cancels, and stops polling', async () => {
          const isPresent = vi.fn().mockResolvedValue(false);

          const waiting = bridge.waitForTokenDirect('smartcard', undefined, isPresent, 100);
          const id = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.INSERT_TOKEN_PROMPT)!.args[0].id;
          await mockIpc.invoke(IPC_CHANNELS.INSERT_TOKEN_CANCEL, id);

          await expect(waiting).resolves.toBe(false);
          await vi.advanceTimersByTimeAsync(500);
          expect(isPresent).not.toHaveBeenCalled();
        });
      });

      it('does not prompt for a PIN when the module reports no card in the reader', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
        ]);
        tokenPresentSpy.mockResolvedValue(false);
        fakeAppAgent.addPkcs11.mockClear();

        expect(await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP)).toEqual({ started: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fakeAppAgent.addPkcs11).not.toHaveBeenCalled();

        detectSpy.mockRestore();
      });

      it('does not load FIDO2 keys (or prompt for a PIN) when no security key is connected', async () => {
        pretendUnix(); // Windows skips the FIDO2 startup step altogether
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([]);
        const fidoSpy = vi.spyOn(Fido2DeviceDetector, 'isFido2DeviceConnected').mockResolvedValue(false);
        mockProfileStore.getProfiles.mockResolvedValue({
          ssh: [{ id: 'p', name: 'fido host', host: 'h', username: 'u', authType: 'fido2', fido2Resident: true }],
        });
        fakeAppAgent.addFido2Resident.mockClear();

        expect(await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP)).toEqual({ started: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fakeAppAgent.addFido2Resident).not.toHaveBeenCalled();

        detectSpy.mockRestore();
        fidoSpy.mockRestore();
      });

      it('the on-demand Unlock runs even when the "unlock at startup" setting is off', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: false, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
        ]);
        const readCertsSpy = vi.spyOn(SmartcardCertificateReader, 'readSmartcardCertificates').mockResolvedValue(new Map());
        fakeAppAgent.addPkcs11.mockImplementation(() => new Promise(() => {}));

        expect(await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP)).toEqual({ started: false });
        expect(await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_NOW)).toEqual({ started: true });
        await new Promise((resolve) => setImmediate(resolve));
        expect(fakeAppAgent.addPkcs11).toHaveBeenCalledWith('/usr/lib/opensc-pkcs11.so', expect.any(Function), expect.any(Object));

        detectSpy.mockRestore();
        readCertsSpy.mockRestore();
      });

      it('the on-demand Unlock ignores the cooldown a just-failed attempt set', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: false, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
        ]);
        const readCertsSpy = vi.spyOn(SmartcardCertificateReader, 'readSmartcardCertificates').mockResolvedValue(new Map());
        fakeAppAgent.addPkcs11.mockImplementation(() => new Promise(() => {}));
        (bridge as any).smartcard.globalSmartcardAgentFailures.set('/usr/lib/opensc-pkcs11.so', Date.now());

        expect(await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_NOW)).toEqual({ started: true });
        await new Promise((resolve) => setImmediate(resolve));
        expect(fakeAppAgent.addPkcs11).toHaveBeenCalledTimes(1);

        detectSpy.mockRestore();
        readCertsSpy.mockRestore();
      });

      it('a second unlock request does not release the guard that a pending PIN prompt still holds', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: false, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
        ]);
        const readCertsSpy = vi.spyOn(SmartcardCertificateReader, 'readSmartcardCertificates').mockResolvedValue(new Map());
        fakeAppAgent.addPkcs11.mockImplementation(() => new Promise(() => {})); // PIN prompt never answered

        await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_NOW);
        await new Promise((resolve) => setImmediate(resolve));
        // Same card again while the first is still loading: nothing new to start...
        expect(await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_NOW)).toEqual({ started: false });

        // ...and terminals/SFTP created now must still wait for the first prompt.
        let released = false;
        void (bridge as any).smartcard.startupUnlockPromise.then(() => {
          released = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(released).toBe(false);

        detectSpy.mockRestore();
        readCertsSpy.mockRestore();
      });

      it('the on-demand Unlock still does nothing outside agent-global mode', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'always-prompt' });
        expect(await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_NOW)).toEqual({ started: false });
      });

      it('does nothing when PIN caching mode is not agent-global', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'always-prompt' });
        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        expect(res).toEqual({ started: false });
      });

      it('does nothing when zero PKCS#11 libraries are detected', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([]);

        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        expect(res).toEqual({ started: false });

        detectSpy.mockRestore();
      });

      it('does nothing when several non-p11-kit libraries are detected with no way to pick one', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
          { name: 'Net iD', path: '/usr/lib/libiidp11.so', platform: 'linux', exists: true },
        ]);

        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        expect(res).toEqual({ started: false });

        detectSpy.mockRestore();
      });

      it('prefers p11-kit even when a more specific library (e.g. OpenSC) is also detected', async () => {
        // p11-kit-proxy.so and opensc-pkcs11.so commonly coexist on the same
        // system (p11-kit proxies opensc among others) — this is one physical
        // card reachable two ways, not two different cards to disambiguate.
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
          { name: 'p11-kit', path: '/usr/lib/p11-kit-proxy.so', platform: 'linux', exists: true },
        ]);
        const loadSpy = fakeAppAgent.addPkcs11.mockImplementation(() => new Promise(() => {}));
        const readCertsSpy = vi
          .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
          .mockResolvedValue(new Map());

        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        expect(res).toEqual({ started: true });
        // readSmartcardCertificates runs (and must resolve) before loadSmartcardIntoPrivateAgent —
        // flush the microtask queue so that ordering has had a chance to play out.
        await new Promise((resolve) => setImmediate(resolve));
        expect(loadSpy).toHaveBeenCalledWith('/usr/lib/p11-kit-proxy.so', expect.any(Function), expect.any(Object));

        detectSpy.mockRestore();
        loadSpy.mockRestore();
        readCertsSpy.mockRestore();
      });

      it('starts loading the single detected card into the global agent', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
        ]);
        const loadSpy = fakeAppAgent.addPkcs11.mockImplementation(() => new Promise(() => {})); // never resolves; only started:true matters here
        const readCertsSpy = vi
          .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
          .mockResolvedValue(new Map());

        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        expect(res).toEqual({ started: true });
        await new Promise((resolve) => setImmediate(resolve));
        expect(loadSpy).toHaveBeenCalledWith('/usr/lib/opensc-pkcs11.so', expect.any(Function), expect.any(Object));

        detectSpy.mockRestore();
        loadSpy.mockRestore();
        readCertsSpy.mockRestore();
      });

      it('does not start a second load when a card is already cached or loading', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
        ]);
        (bridge as any).smartcard.globalCards.set('/usr/lib/opensc-pkcs11.so', { fingerprints: new Set() });

        const loadSpy = fakeAppAgent.addPkcs11;
        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);

        expect(res).toEqual({ started: false });
        expect(loadSpy).not.toHaveBeenCalled();

        detectSpy.mockRestore();
        loadSpy.mockRestore();
      });

      it('loads all configured smartcard libraries from user profiles during startup unlock', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        mockProfileStore.getProfiles.mockResolvedValue({
          ssh: [
            { id: '1', name: 'OpenSC profile', authType: 'smartcard', pkcs11LibPath: '/usr/lib/opensc-pkcs11.so' } as any,
            { id: '2', name: 'YubiKey profile', authType: 'smartcard', pkcs11LibPath: '/usr/lib64/libykcs11.so.2' } as any,
          ],
        });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
          { name: 'YubiKey (libykcs11)', path: '/usr/lib64/libykcs11.so.2', platform: 'linux', exists: true },
        ]);
        const loadSpy = fakeAppAgent.addPkcs11.mockResolvedValue(undefined);
        const readCertsSpy = vi
          .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
          .mockResolvedValue(new Map());

        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        expect(res).toEqual({ started: true });

        // Await the startup unlock background task
        await (bridge as any).smartcard.startupUnlockPromise;

        expect(loadSpy).toHaveBeenCalledWith('/usr/lib/opensc-pkcs11.so', expect.any(Function), expect.any(Object));
        expect(loadSpy).toHaveBeenCalledWith('/usr/lib64/libykcs11.so.2', expect.any(Function), expect.any(Object));

        detectSpy.mockRestore();
        loadSpy.mockRestore();
        readCertsSpy.mockRestore();
        mockProfileStore.getProfiles.mockResolvedValue({ ssh: [] });
      });

      it('reads every module\'s certificates before the first card is loaded, and only once each', async () => {
        mockSettingsStore.getSettings.mockResolvedValue({ smartcardUnlockAtStartup: true, smartcardAuthMode: 'agent-global' });
        mockProfileStore.getProfiles.mockResolvedValue({
          ssh: [
            { id: '1', name: 'A', authType: 'smartcard', pkcs11LibPath: '/usr/lib/opensc-pkcs11.so' } as any,
            { id: '2', name: 'B', authType: 'smartcard', pkcs11LibPath: '/usr/lib64/libykcs11.so.2' } as any,
          ],
        });
        const detectSpy = vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
          { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux', exists: true },
          { name: 'YubiKey (libykcs11)', path: '/usr/lib64/libykcs11.so.2', platform: 'linux', exists: true },
        ]);
        const loadSpy = fakeAppAgent.addPkcs11.mockResolvedValue(undefined);
        const readCertsSpy = vi
          .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
          .mockResolvedValue(new Map());

        await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_UNLOCK_AT_STARTUP);
        await (bridge as any).smartcard.startupUnlockPromise;

        // Reading a module's certificates opens its own session against the token, which breaks the PIN login
        // of a card the agent already holds; so all reads must come first.
        expect(readCertsSpy).toHaveBeenCalledTimes(2);
        const lastRead = Math.max(...readCertsSpy.mock.invocationCallOrder);
        const firstLoad = Math.min(...loadSpy.mock.invocationCallOrder);
        expect(lastRead).toBeLessThan(firstLoad);
        expect((bridge as any).smartcard.prefetchedSmartcardCerts.size).toBe(0);

        detectSpy.mockRestore();
        loadSpy.mockRestore();
        readCertsSpy.mockRestore();
        mockProfileStore.getProfiles.mockResolvedValue({ ssh: [] });
      });

      it('does not read ahead for a single module, or while the agent already holds a PKCS#11 card', async () => {
        const readCertsSpy = vi
          .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
          .mockResolvedValue(new Map());

        await (bridge as any).smartcard.prefetchSmartcardCertificates(['/usr/lib/opensc-pkcs11.so']);
        expect(readCertsSpy).not.toHaveBeenCalled();

        (bridge as any).smartcard.globalCards.set('/usr/lib/opensc-pkcs11.so', { fingerprints: new Set(['SHA256:abc']) });
        await (bridge as any).smartcard.prefetchSmartcardCertificates(['/usr/lib64/libykcs11.so.2', '/usr/lib/other.so']);
        expect(readCertsSpy).not.toHaveBeenCalled();
        expect((bridge as any).smartcard.prefetchedSmartcardCerts.size).toBe(0);

        readCertsSpy.mockRestore();
      });

      it('does not retain any plaintext PIN in memory after startup unlock finishes', async () => {
        expect((bridge as any).cachedGlobalSmartcardPin).toBeUndefined();
      });
    });

    describe('global smartcard certificate caching', () => {
      const pkcs11LibPath = '/usr/lib/opensc-pkcs11.so';
      const identity = { bits: '256', fingerprint: 'SHA256:abc', comment: 'PIV AUTH pubkey', keyType: 'ECDSA' };
      const certDetails = {
        fingerprint: identity.fingerprint,
        subject: 'CN=Test User',
        issuer: 'CN=Test CA',
        validFrom: '2024-01-01',
        validTo: '2026-01-01',
        upn: 'test.user@example.com',
        authCapable: true,
      };

      it('reads the certificate once when the card is loaded, then serves it from cache on every list call', async () => {
        fakeAppAgent.addPkcs11.mockImplementation(async () => {
          fakeAppAgent.identities = [identity];
        });
        const readCertsSpy = vi
          .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
          .mockResolvedValue(new Map([[certDetails.fingerprint, certDetails]]));

        await (bridge as any).smartcard.getOrLoadGlobalSmartcardAgent(pkcs11LibPath, () => Promise.resolve('1234'));

        expect(readCertsSpy).toHaveBeenCalledTimes(1);
        expect(readCertsSpy).toHaveBeenCalledWith(pkcs11LibPath);
        // The card is attributed its certificate's key, so identities can be grouped per card.
        expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(new Set([identity.fingerprint]));

        fakeAppAgent.list.mockClear();
        const first = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_LIST_CACHED);
        const second = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_LIST_CACHED);

        // The certificate is only ever read once — not again for either "list cached" call.
        expect(readCertsSpy).toHaveBeenCalledTimes(1);
        expect(fakeAppAgent.list).toHaveBeenCalledTimes(2); // identities themselves are still queried live

        for (const res of [first, second]) {
          expect(res).toEqual([
            {
              pkcs11LibPath,
              identities: [
                {
                  ...identity,
                  certificate: {
                    subject: certDetails.subject,
                    issuer: certDetails.issuer,
                    validFrom: certDetails.validFrom,
                    validTo: certDetails.validTo,
                    upn: certDetails.upn,
                  },
                },
              ],
            },
          ]);
        }

        readCertsSpy.mockRestore();
      });

      describe('authentication-key filtering', () => {
        const authDetails = { ...certDetails, fingerprint: 'SHA256:auth', authCapable: true };
        const signDetails = { ...certDetails, fingerprint: 'SHA256:sign', authCapable: false };
        const idFor = (fingerprint: string) => ({ bits: '256', fingerprint, comment: fingerprint, keyType: 'ECDSA' });

        const loadWith = async (certs: Array<typeof authDetails>) => {
          fakeAppAgent.addPkcs11.mockImplementation(async () => {
            fakeAppAgent.identities = certs.map((c) => idFor(c.fingerprint));
          });
          const spy = vi
            .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
            .mockResolvedValue(new Map(certs.map((c) => [c.fingerprint, c])));
          await (bridge as any).smartcard.getOrLoadGlobalSmartcardAgent(pkcs11LibPath, () => Promise.resolve('1234'));
          spy.mockRestore();
        };

        it('attributes only authentication-capable keys to the card and removes the rest from the agent', async () => {
          await loadWith([authDetails, signDetails]);

          expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(new Set(['SHA256:auth']));
          expect(fakeAppAgent.removeIdentities).toHaveBeenCalledWith(['SHA256:sign']);
          // Details of every certificate are still cached (UI/details unchanged).
          expect((bridge as any).smartcard.globalSmartcardCerts.get(pkcs11LibPath).size).toBe(2);
        });

        it('keeps everything, and removes nothing, when no certificate looks authentication-capable', async () => {
          const warn = captureLogs();
          await loadWith([signDetails, { ...signDetails, fingerprint: 'SHA256:sign2' }]);

          expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(
            new Set(['SHA256:sign', 'SHA256:sign2'])
          );
          expect(fakeAppAgent.removeIdentities).not.toHaveBeenCalled();
          warn.restore();
        });

        it('does not remove anything when every certificate is authentication-capable', async () => {
          await loadWith([authDetails, { ...authDetails, fingerprint: 'SHA256:auth2' }]);

          expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(
            new Set(['SHA256:auth', 'SHA256:auth2'])
          );
          expect(fakeAppAgent.removeIdentities).not.toHaveBeenCalled();
        });

        it('keeps the key linked for smartcard sync even when it is not authentication-capable', async () => {
          const signBlob = Buffer.from('sign-key-blob');
          const linkedFingerprint = fingerprintOfKeyBlob(signBlob);
          vi.mocked(bridge.syncConfigStore.getConfig).mockResolvedValue({
            smartcardSync: { pkcs11LibPath, keyBlobBase64: signBlob.toString('base64') },
          } as any);

          await loadWith([authDetails, { ...signDetails, fingerprint: linkedFingerprint }]);

          expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(
            new Set(['SHA256:auth', linkedFingerprint])
          );
          expect(fakeAppAgent.removeIdentities).not.toHaveBeenCalled();
        });

        it('also protects a key linked by an older sync link that only stored keyFingerprint', async () => {
          const signBlob = Buffer.from('legacy-sign-key-blob');
          const linkedFingerprint = fingerprintOfKeyBlob(signBlob);
          vi.mocked(bridge.syncConfigStore.getConfig).mockResolvedValue({
            smartcardSync: {
              pkcs11LibPath,
              keyFingerprint: createHash('sha256').update(signBlob).digest('hex'),
            },
          } as any);

          await loadWith([authDetails, { ...signDetails, fingerprint: linkedFingerprint }]);

          expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(
            new Set(['SHA256:auth', linkedFingerprint])
          );
          expect(fakeAppAgent.removeIdentities).not.toHaveBeenCalled();
        });

        it('ignores a malformed keyFingerprint instead of protecting a wrong key', async () => {
          vi.mocked(bridge.syncConfigStore.getConfig).mockResolvedValue({
            smartcardSync: { pkcs11LibPath, keyFingerprint: 'not-hex' },
          } as any);
          await loadWith([authDetails, signDetails]);

          expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(new Set(['SHA256:auth']));
        });

        it('still filters when the sync config cannot be read', async () => {
          vi.mocked(bridge.syncConfigStore.getConfig).mockRejectedValue(new Error('unreadable'));
          await loadWith([authDetails, signDetails]);

          expect((bridge as any).smartcard.globalCards.get(pkcs11LibPath).fingerprints).toEqual(new Set(['SHA256:auth']));
        });

        it('lists only the card\'s authentication keys in the cached identities', async () => {
          await loadWith([authDetails, signDetails]);
          // The removal itself is best-effort; even if the signing key lingers in the agent it is not shown.
          fakeAppAgent.identities = [idFor('SHA256:auth'), idFor('SHA256:sign')];

          const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_LIST_CACHED);
          expect(res.map((r: any) => r.identities.map((i: any) => i.fingerprint))).toEqual([['SHA256:auth']]);
        });
      });

      it('does not load (or prompt for) a second module that exposes a card already in the agent', async () => {
        const second = '/usr/lib/libykcs11.so';
        const readCertsSpy = vi.spyOn(SmartcardCertificateReader, 'readSmartcardCertificates').mockImplementation(async (lib) =>
          // p11-kit-proxy exposes the card's auth key; libykcs11 exposes the same key plus another one.
          lib === pkcs11LibPath
            ? new Map([[certDetails.fingerprint, certDetails]])
            : new Map([
                [certDetails.fingerprint, certDetails],
                ['SHA256:second', { ...certDetails, fingerprint: 'SHA256:second' }],
              ])
        );
        fakeAppAgent.addPkcs11.mockImplementation(async () => {
          fakeAppAgent.identities = [identity];
        });

        await (bridge as any).smartcard.getOrLoadGlobalSmartcardAgent(pkcs11LibPath, () => Promise.resolve('1234'));
        const socket = await (bridge as any).smartcard.getOrLoadGlobalSmartcardAgent(second, () => Promise.resolve('1234'));

        expect(fakeAppAgent.addPkcs11).toHaveBeenCalledTimes(1);
        expect(socket).toBe('/tmp/app-agent.sock');
        expect((bridge as any).smartcard.globalCards.get(second).fingerprints).toEqual(
          new Set([certDetails.fingerprint, 'SHA256:second'])
        );
        readCertsSpy.mockRestore();
      });

      it('groups the single app agent\'s identities per card and puts security keys under FIDO2', async () => {
        const otherIdentity = { bits: '256', fingerprint: 'SHA256:other', comment: 'other card', keyType: 'ECDSA' };
        const skIdentity = { bits: '256', fingerprint: 'SHA256:sk', comment: 'sk', keyType: 'ED25519-SK' };
        fakeAppAgent.identities = [identity, otherIdentity, skIdentity];
        (bridge as any).smartcard.globalCards.set(pkcs11LibPath, { fingerprints: new Set([identity.fingerprint]) });
        (bridge as any).smartcard.globalCards.set('/usr/lib/other.so', { fingerprints: new Set([otherIdentity.fingerprint]) });
        (bridge as any).smartcard.globalCards.set('__fido2__', { fingerprints: new Set([skIdentity.fingerprint]) });

        const res = await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_LIST_CACHED);

        expect(res.map((r: any) => [r.pkcs11LibPath, r.identities.map((i: any) => i.fingerprint)])).toEqual([
          [pkcs11LibPath, ['SHA256:abc']],
          ['/usr/lib/other.so', ['SHA256:other']],
          ['FIDO2 Security Key', ['SHA256:sk']],
        ]);
      });

      it('drops the cached certificate when the card is locked', async () => {
        const readCertsSpy = vi
          .spyOn(SmartcardCertificateReader, 'readSmartcardCertificates')
          .mockResolvedValue(new Map([[certDetails.fingerprint, certDetails]]));

        await (bridge as any).smartcard.getOrLoadGlobalSmartcardAgent(pkcs11LibPath, () => Promise.resolve('1234'));
        expect((bridge as any).smartcard.globalSmartcardCerts.has(pkcs11LibPath)).toBe(true);

        await mockIpc.invoke(IPC_CHANNELS.SMARTCARD_LOCK_ALL);
        expect((bridge as any).smartcard.globalSmartcardCerts.has(pkcs11LibPath)).toBe(false);
        expect((bridge as any).smartcard.globalCards.size).toBe(0);

        readCertsSpy.mockRestore();
      });
    });

    it('handles askpass prompt and pin submission', async () => {
      let pinResolved: string | null = null;
      mockPtyManager.emit('askpass', {
        sessionId: 'session-123',
        prompt: 'Enter PIN for Smartcard:',
        callback: (pin: string) => {
          pinResolved = pin;
        },
      });

      const promptEvent = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.ASKPASS_PROMPT);
      expect(promptEvent).toBeDefined();
      expect(promptEvent?.args[0]).toHaveProperty('id');
      expect(promptEvent?.args[0].prompt).toBe('Enter PIN for Smartcard:');
      expect(promptEvent?.args[0].sessionId).toBe('session-123');

      const promptId = promptEvent?.args[0].id;
      await mockIpc.invoke(IPC_CHANNELS.ASKPASS_SUBMIT_PIN, promptId, '123456');
      expect(pinResolved).toBe('123456');

      await expect(mockIpc.invoke(IPC_CHANNELS.ASKPASS_SUBMIT_PIN, promptId, '123456')).rejects.toThrow();
    });

    it('pty exit removes pending askpass prompts for that sessionId', async () => {
      let pinResolved: string | null = null;
      mockPtyManager.emit('askpass', {
        sessionId: 'session-to-exit',
        prompt: 'Enter PIN:',
        callback: (pin: string) => {
          pinResolved = pin;
        },
      });

      const promptEvent = mockWebContents.events.find(
        (e) => e.channel === IPC_CHANNELS.ASKPASS_PROMPT && e.args[0].sessionId === 'session-to-exit'
      );
      expect(promptEvent).toBeDefined();
      const promptId = promptEvent?.args[0].id;

      // Session exits before submit
      mockPtyManager.emit('exit', { sessionId: 'session-to-exit', exitCode: 1 });
      expect(pinResolved).toBe('');

      // Trying to submit now should throw not found/expired
      await expect(mockIpc.invoke(IPC_CHANNELS.ASKPASS_SUBMIT_PIN, promptId, '1234')).rejects.toThrow();
    });
  });

  describe('Host key trust-on-first-use prompts', () => {
    it('sends a HOSTKEY_PROMPT event and resolves once HOSTKEY_RESPOND is invoked', async () => {
      const promptPromise = bridge.promptHostKeyTrust({
        host: 'unknown.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc123',
        status: 'unknown',
      });

      const promptEvent = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.HOSTKEY_PROMPT);
      expect(promptEvent).toBeDefined();
      expect(promptEvent?.args[0]).toMatchObject({
        host: 'unknown.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:abc123',
        status: 'unknown',
      });
      const promptId = promptEvent?.args[0].id;
      expect(promptId).toBeDefined();

      await mockIpc.invoke(IPC_CHANNELS.HOSTKEY_RESPOND, promptId, true);
      await expect(promptPromise).resolves.toBe(true);
    });

    it('responding to an unknown/expired prompt id throws', async () => {
      await expect(mockIpc.invoke(IPC_CHANNELS.HOSTKEY_RESPOND, 'no-such-id', true)).rejects.toThrow();
    });

    it('resolves to false without prompting when no webContents is available', async () => {
      const bridgeNoWindow = new IpcBridge({
        ipcMain: new MockIpcMain() as any,
        sshPtyManager: mockPtyManager,
        storageRegistry: mockStorageRegistry,
        transferQueue: mockTransferQueue,
        profileStore: mockProfileStore,
        getWebContents: () => null,
      });
      bridgeNoWindow.register();

      const result = await bridgeNoWindow.promptHostKeyTrust({
        host: 'no-window.example.com',
        port: 22,
        keyType: 'ssh-rsa',
        fingerprint: 'SHA256:xyz',
        status: 'unknown',
      });
      expect(result).toBe(false);

      await bridgeNoWindow.dispose();
    });

    it('dispose() rejects (resolves false) any pending host key prompts', async () => {
      const promptPromise = bridge.promptHostKeyTrust({
        host: 'pending.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:pending',
        status: 'unknown',
      });

      await bridge.dispose();
      await expect(promptPromise).resolves.toBe(false);
    });
  });

  describe('AWS SSO login prompts', () => {
    it('sends an AWS_SSO_PROMPT event and resolves once the device flow completes', async () => {
      let resolveLogin: (value: any) => void = () => {};
      mockAwsSsoAuthService.login.mockImplementation(
        (_startUrl: string, _region: string, options?: { onPrompt?: (p: any) => void }) =>
          new Promise((resolve) => {
            options?.onPrompt?.({
              verificationUri: 'https://verify.example.com',
              verificationUriComplete: 'https://verify.example.com?user_code=ABCD-EFGH',
              userCode: 'ABCD-EFGH',
              expiresIn: 600,
            });
            resolveLogin = resolve;
          })
      );

      const loginPromise = mockIpc.invoke(IPC_CHANNELS.AWS_SSO_LOGIN, 'https://start.example.com', 'us-east-1');
      await Promise.resolve();

      const promptEvent = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.AWS_SSO_PROMPT);
      expect(promptEvent).toBeDefined();
      expect(promptEvent?.args[0]).toMatchObject({
        verificationUri: 'https://verify.example.com',
        userCode: 'ABCD-EFGH',
      });
      expect(promptEvent?.args[0].id).toBeDefined();

      resolveLogin({ accessToken: 'access-token-1', expiresAt: '2099-01-01T00:00:00.000Z' });
      await expect(loginPromise).resolves.toEqual({
        accessToken: 'access-token-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    it('AWS_SSO_LOGIN_CANCEL aborts the pending login', async () => {
      mockAwsSsoAuthService.login.mockImplementation(
        (_startUrl: string, _region: string, options?: { onPrompt?: (p: any) => void; signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.onPrompt?.({
              verificationUri: 'https://verify.example.com',
              verificationUriComplete: 'https://verify.example.com?user_code=X',
              userCode: 'X',
              expiresIn: 600,
            });
            options?.signal?.addEventListener('abort', () => reject(new Error('AWS SSO login was cancelled')));
          })
      );

      const loginPromise = mockIpc.invoke(IPC_CHANNELS.AWS_SSO_LOGIN, 'https://start.example.com', 'us-east-1');
      await Promise.resolve();

      const promptEvent = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.AWS_SSO_PROMPT);
      const id = promptEvent?.args[0].id;
      expect(id).toBeDefined();

      await mockIpc.invoke(IPC_CHANNELS.AWS_SSO_LOGIN_CANCEL, id);
      await expect(loginPromise).rejects.toThrow();
    });

    it('dispose() cancels any pending AWS SSO logins', async () => {
      mockAwsSsoAuthService.login.mockImplementation(
        (_startUrl: string, _region: string, options?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('AWS SSO login was cancelled')));
          })
      );

      const loginPromise = mockIpc.invoke(IPC_CHANNELS.AWS_SSO_LOGIN, 'https://start.example.com', 'us-east-1');
      await Promise.resolve();

      await bridge.dispose();
      await expect(loginPromise).rejects.toThrow();
    });

    const ssoS3Provider = (overrides: Record<string, unknown> = {}) => ({
      id: 's3-sso',
      type: 's3',
      clearCache: vi.fn(),
      list: vi.fn(),
      config: {
        authMode: 'sso',
        region: 'eu-west-1',
        sso: { startUrl: 'https://start.example.com', region: 'eu-north-1', accountId: '1', roleName: 'R' },
        customCaPath: '/ca.pem',
        proxy: { enabled: true, host: 'proxy', port: 3128 },
        ...overrides,
      },
    });

    it('AWS_SSO_RELOGIN_PROVIDER signs in with the provider profile and clears its listing cache', async () => {
      const provider = ssoS3Provider();
      mockStorageRegistry.providers.set('s3-sso', provider);
      mockAwsSsoAuthService.login.mockResolvedValue({ accessToken: 't', expiresAt: '2099-01-01T00:00:00.000Z' });

      await mockIpc.invoke(IPC_CHANNELS.AWS_SSO_RELOGIN_PROVIDER, 's3-sso');

      expect(mockAwsSsoAuthService.login).toHaveBeenCalledWith(
        'https://start.example.com',
        'eu-north-1',
        expect.objectContaining({
          network: { customCaPath: '/ca.pem', rejectUnauthorized: undefined, proxy: provider.config.proxy },
        })
      );
      expect(provider.clearCache).toHaveBeenCalled();
    });

    it('AWS_SSO_RELOGIN_PROVIDER rejects unknown and non-SSO providers without signing in', async () => {
      mockStorageRegistry.providers.set('s3-static', ssoS3Provider({ authMode: 'static' }));
      mockStorageRegistry.providers.set('sftp-1', { id: 'sftp-1', type: 'sftp' });

      for (const id of ['missing', 's3-static', 'sftp-1']) {
        await expect(mockIpc.invoke(IPC_CHANNELS.AWS_SSO_RELOGIN_PROVIDER, id)).rejects.toThrow(
          'does not use AWS SSO'
        );
      }
      expect(mockAwsSsoAuthService.login).not.toHaveBeenCalled();
    });

    it('STORAGE_LIST turns an expired SSO session on an S3 provider into the sign-in message', async () => {
      const provider = ssoS3Provider();
      const err = new Error('The SSO session associated with this profile has expired');
      err.name = 'TokenProviderError';
      provider.list.mockRejectedValue(err);
      mockStorageRegistry.providers.set('s3-sso', provider);

      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LIST, 's3-sso', '/')).rejects.toThrow(
        'AWS SSO session expired'
      );
    });

    it('STORAGE_LIST leaves errors from non-S3 providers untouched', async () => {
      const list = vi.fn().mockRejectedValue(new Error('boom'));
      mockStorageRegistry.providers.set('sftp-1', { id: 'sftp-1', type: 'sftp', list });

      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LIST, 'sftp-1', '/')).rejects.toThrow('boom');
    });

    it('lists accounts and roles via the injected AwsSsoAuthService', async () => {
      const accounts = await mockIpc.invoke(IPC_CHANNELS.AWS_SSO_LIST_ACCOUNTS, 'token', 'us-east-1');
      expect(accounts).toEqual([{ accountId: '123', accountName: 'Prod' }]);
      expect(mockAwsSsoAuthService.listAccounts).toHaveBeenCalledWith('token', 'us-east-1', undefined);

      const roles = await mockIpc.invoke(IPC_CHANNELS.AWS_SSO_LIST_ROLES, 'token', 'us-east-1', '123');
      expect(roles).toEqual([{ roleName: 'Admin' }]);
      expect(mockAwsSsoAuthService.listAccountRoles).toHaveBeenCalledWith('token', 'us-east-1', '123', undefined);
    });
  });

  describe('Storage Handlers', () => {
    it('handles storage connect and disconnect', async () => {
      const res = await mockIpc.invoke(IPC_CHANNELS.STORAGE_CONNECT, {
        id: 's1',
        name: 'Local',
        type: 'local',
      });
      expect(res).toEqual({ id: 's1' });
      expect(mockStorageRegistry.getOrCreate).toHaveBeenCalled();

      await mockIpc.invoke(IPC_CHANNELS.STORAGE_DISCONNECT, 's1');
      expect(mockStorageRegistry.disconnect).toHaveBeenCalledWith('s1');
    });

    it('handles storage operations (list, stat, createFolder, delete, rename)', async () => {
      const list: FileEntry[] = await mockIpc.invoke(IPC_CHANNELS.STORAGE_LIST, 'test-storage', '/');
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('file.txt');

      const stat: FileEntry = await mockIpc.invoke(IPC_CHANNELS.STORAGE_STAT, 'test-storage', '/file.txt');
      expect(stat.size).toBe(100);

      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LOOKUP, 'test-storage', '/file.txt')).resolves.toMatchObject({
        size: 100,
      });

      await mockIpc.invoke(IPC_CHANNELS.STORAGE_CREATE_FOLDER, 'test-storage', '/new-folder');
      await mockIpc.invoke(IPC_CHANNELS.STORAGE_DELETE, 'test-storage', '/file.txt', false);
      await mockIpc.invoke(IPC_CHANNELS.STORAGE_RENAME, 'test-storage', '/file.txt', '/renamed.txt');

      const provider = mockStorageRegistry.get('test-storage');
      expect(provider.createFolder).toHaveBeenCalledWith('/new-folder');
      expect(provider.delete).toHaveBeenCalledWith('/file.txt', false);
      expect(provider.rename).toHaveBeenCalledWith('/file.txt', '/renamed.txt');
    });

    it('storage:lookup resolves to null for a missing path but rejects for other failures', async () => {
      const provider = mockStorageRegistry.get('test-storage');
      provider.stat.mockRejectedValueOnce(Object.assign(new Error('no such file'), { code: 'ENOENT' }));
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LOOKUP, 'test-storage', '/nope')).resolves.toBeNull();

      provider.stat.mockRejectedValueOnce(new Error('Connection lost'));
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LOOKUP, 'test-storage', '/x')).rejects.toThrow('Connection lost');

      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LOOKUP, 'test-storage', 42)).rejects.toThrow('Invalid arguments');
    });

    it('handles storage getHomeDir', async () => {
      const home = await mockIpc.invoke(IPC_CHANNELS.STORAGE_GET_HOMEDIR, 'test-storage');
      expect(home).toBe('/home/testuser');
      const provider = mockStorageRegistry.get('test-storage');
      expect(provider.getHomeDir).toHaveBeenCalled();
    });

    it('throws error when storage provider is not found', async () => {
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_GET_HOMEDIR, 'unknown-id')).rejects.toThrow(
        'Storage provider not found: unknown-id'
      );
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LIST, 'unknown-id', '/')).rejects.toThrow(
        'Storage provider not found: unknown-id'
      );
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_STAT, 'unknown-id', '/')).rejects.toThrow(
        'Storage provider not found: unknown-id'
      );
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_LOOKUP, 'unknown-id', '/')).rejects.toThrow(
        'Storage provider not found: unknown-id'
      );
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_CREATE_FOLDER, 'unknown-id', '/')).rejects.toThrow(
        'Storage provider not found: unknown-id'
      );
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_DELETE, 'unknown-id', '/', false)).rejects.toThrow(
        'Storage provider not found: unknown-id'
      );
      await expect(mockIpc.invoke(IPC_CHANNELS.STORAGE_RENAME, 'unknown-id', '/a', '/b')).rejects.toThrow(
        'Storage provider not found: unknown-id'
      );
    });
  });

  describe('Transfer Handlers & Events', () => {
    it('handles transferAdd with valid providers', async () => {
      mockStorageRegistry.providers.set('target-storage', mockStorageRegistry.providers.get('test-storage'));

      const res = await mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'test-storage',
        sourcePath: '/src/file.txt',
        targetProviderId: 'target-storage',
        targetPath: '/dst/file.txt',
        conflictPolicy: 'overwrite',
      });

      expect(res).toMatchObject({ jobId: 'job-123' });
      expect(mockTransferQueue.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePath: '/src/file.txt',
          targetPath: '/dst/file.txt',
          isDirectory: false,
          totalBytes: 100,
        })
      );
    });

    it('rejects a special file (FIFO, socket, device) in transferAdd and queues nothing (M7)', async () => {
      const special = {
        ...mockStorageRegistry.providers.get('test-storage'),
        stat: vi.fn().mockResolvedValue({ name: 'pipe', path: '/src/pipe', size: 0, isDirectory: false, isSpecial: true }),
      };
      mockStorageRegistry.providers.set('special-storage', special as any);
      mockTransferQueue.addJob.mockClear();

      await expect(
        mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
          sourceProviderId: 'special-storage',
          sourcePath: '/src/pipe',
          targetProviderId: 'test-storage',
          targetPath: '/dst/pipe',
          conflictPolicy: 'overwrite',
        })
      ).rejects.toThrow('Not a regular file: pipe');
      expect(mockTransferQueue.addJob).not.toHaveBeenCalled();
    });

    it('rejects overwriting a file with itself in transferAdd and queues nothing', async () => {
      mockTransferQueue.addJob.mockClear();

      await expect(
        mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
          sourceProviderId: 'test-storage',
          sourcePath: '/src/file.txt',
          targetProviderId: 'test-storage',
          targetPath: '/src//file.txt',
          conflictPolicy: 'overwrite',
        })
      ).rejects.toThrow('Source and target are the same file');
      expect(mockTransferQueue.addJob).not.toHaveBeenCalled();
    });

    it('resolves targetPath when target is a directory in transferAdd', async () => {
      const dirProvider = {
        ...mockStorageRegistry.providers.get('test-storage'),
        stat: vi.fn().mockImplementation(async (p: string) => {
          if (p === '/dst/folder') {
            return { name: 'folder', path: '/dst/folder', size: 0, isDirectory: true };
          }
          return { name: 'photo.png', path: '/src/photo.png', size: 2048, isDirectory: false };
        }),
      };
      mockStorageRegistry.providers.set('target-dir-storage', dirProvider as any);
      mockStorageRegistry.providers.set('src-storage', dirProvider as any);

      const res = await mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'src-storage',
        sourcePath: '/src/photo.png',
        targetProviderId: 'target-dir-storage',
        targetPath: '/dst/folder',
        conflictPolicy: 'overwrite',
      });

      expect(res).toMatchObject({ jobId: 'job-123' });
      expect(mockTransferQueue.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePath: '/src/photo.png',
          targetPath: path.join('/dst/folder', 'photo.png'),
          isDirectory: false,
          totalBytes: 2048,
        })
      );
    });

    it('detects isDirectory: true when source is a directory in transferAdd', async () => {
      const dirProvider = {
        ...mockStorageRegistry.providers.get('test-storage'),
        stat: vi.fn().mockImplementation(async (p: string) => {
          if (p === '/src/my-folder') {
            return { name: 'my-folder', path: '/src/my-folder', size: 0, isDirectory: true };
          }
          if (p === '/dst') {
            return { name: 'dst', path: '/dst', size: 0, isDirectory: true };
          }
          return { name: 'unknown', path: p, size: 0, isDirectory: false };
        }),
      };
      mockStorageRegistry.providers.set('target-dir-storage', dirProvider as any);
      mockStorageRegistry.providers.set('src-storage', dirProvider as any);

      const res = await mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'src-storage',
        sourcePath: '/src/my-folder',
        targetProviderId: 'target-dir-storage',
        targetPath: '/dst',
        conflictPolicy: 'overwrite',
      });

      expect(res).toMatchObject({ jobId: 'job-123' });
      expect(mockTransferQueue.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          sourcePath: '/src/my-folder',
          targetPath: path.join('/dst', 'my-folder'),
          isDirectory: true,
        })
      );
    });

    it('throws error if transfer options or provider IDs are missing', async () => {
      await expect(mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, null as any)).rejects.toThrow(
        'sourceProviderId and targetProviderId are required'
      );

      await expect(
        mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
          sourceProviderId: '',
          sourcePath: '/src',
          targetProviderId: 'test-storage',
          targetPath: '/dst',
        })
      ).rejects.toThrow('sourceProviderId and targetProviderId are required');

      await expect(
        mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
          sourceProviderId: 'test-storage',
          sourcePath: '/src',
          targetProviderId: '',
          targetPath: '/dst',
        })
      ).rejects.toThrow('sourceProviderId and targetProviderId are required');
    });

    it('throws error if transfer source or target provider is missing in registry', async () => {
      await expect(
        mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
          sourceProviderId: 'missing-src',
          sourcePath: '/src',
          targetProviderId: 'test-storage',
          targetPath: '/dst',
        })
      ).rejects.toThrow('Source storage provider not found');

      await expect(
        mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
          sourceProviderId: 'test-storage',
          sourcePath: '/src',
          targetProviderId: 'missing-target',
          targetPath: '/dst',
        })
      ).rejects.toThrow('Target storage provider not found');
    });

    it('handles transfer controls (pause, resume, cancel, getJobs, clearCompleted)', async () => {
      await mockIpc.invoke(IPC_CHANNELS.TRANSFER_PAUSE, 'job-123');
      expect(mockTransferQueue.pauseJob).toHaveBeenCalledWith('job-123');

      await mockIpc.invoke(IPC_CHANNELS.TRANSFER_RESUME, 'job-123');
      expect(mockTransferQueue.resumeJob).toHaveBeenCalledWith('job-123');

      await mockIpc.invoke(IPC_CHANNELS.TRANSFER_CANCEL, 'job-123');
      expect(mockTransferQueue.cancelJob).toHaveBeenCalledWith('job-123');

      const jobs = await mockIpc.invoke(IPC_CHANNELS.TRANSFER_GET_JOBS);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe('job-123');

      await mockIpc.invoke(IPC_CHANNELS.TRANSFER_CLEAR_COMPLETED);
      expect(mockTransferQueue.clearCompleted).toHaveBeenCalled();
    });

    it('forwards transfer progress events to webContents', () => {
      const progress = {
        jobId: 'job-123',
        fileName: 'test.zip',
        transferredBytes: 500,
        totalBytes: 1000,
        percentage: 50,
        bytesPerSecond: 100,
        status: 'running' as const,
      };
      mockTransferQueue.emit('progress', progress);
      expect(mockWebContents.events).toContainEqual({
        channel: IPC_CHANNELS.TRANSFER_PROGRESS,
        args: [progress],
      });
    });
  });

  describe('Transfer conflict resolution', () => {
    function makeConflictProvider() {
      return {
        id: 'conflict-target',
        name: 'Conflict Target',
        type: 'local',
        stat: vi.fn().mockImplementation(async (p: string) => {
          const normalized = p.replace(/\\/g, '/');
          if (normalized === '/dst/exists.txt') {
            return { name: 'exists.txt', path: p, size: 10, isDirectory: false };
          }
          if (normalized === '/dst/exists (1).txt') {
            return { name: 'exists (1).txt', path: p, size: 5, isDirectory: false };
          }
          throw new Error('ENOENT');
        }),
        list: vi.fn(),
        createFolder: vi.fn(),
        delete: vi.fn(),
        rename: vi.fn(),
        createReadStream: vi.fn(),
        createWriteStream: vi.fn(),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
    }

    async function flushMicrotasks() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    it('does not prompt and adds the job directly when the target does not exist', async () => {
      mockStorageRegistry.providers.set('conflict-target', makeConflictProvider() as any);

      const res = await mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'test-storage',
        sourcePath: '/src/file.txt',
        targetProviderId: 'conflict-target',
        targetPath: '/dst/new-file.txt',
      });

      expect(res).toMatchObject({ jobId: 'job-123' });
      expect(res.resolvedPolicy).toBeUndefined();
      expect(mockWebContents.events.some((e) => e.channel === IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT)).toBe(false);
    });

    it('prompts for a conflicting target and applies "overwrite"', async () => {
      mockStorageRegistry.providers.set('conflict-target', makeConflictProvider() as any);

      const resultPromise = mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'test-storage',
        sourcePath: '/src/file.txt',
        targetProviderId: 'conflict-target',
        targetPath: '/dst/exists.txt',
      });

      await flushMicrotasks();
      const promptEvent = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT);
      expect(promptEvent).toBeDefined();
      expect(promptEvent?.args[0]).toMatchObject({
        targetPath: '/dst/exists.txt',
        fileName: 'file.txt',
        isDirectory: false,
      });
      const promptId = promptEvent?.args[0].id;

      await mockIpc.invoke(IPC_CHANNELS.TRANSFER_CONFLICT_RESPOND, promptId, 'overwrite', false);

      const res = await resultPromise;
      expect(res).toMatchObject({ jobId: 'job-123', resolvedPolicy: 'overwrite', appliedToAll: false });
      expect(mockTransferQueue.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ targetPath: '/dst/exists.txt' })
      );
    });

    it('prompts for a conflicting target and applies "skip" without adding a job', async () => {
      mockStorageRegistry.providers.set('conflict-target', makeConflictProvider() as any);
      mockTransferQueue.addJob.mockClear();

      const resultPromise = mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'test-storage',
        sourcePath: '/src/file.txt',
        targetProviderId: 'conflict-target',
        targetPath: '/dst/exists.txt',
      });

      await flushMicrotasks();
      const promptEvent = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT);
      const promptId = promptEvent?.args[0].id;

      await mockIpc.invoke(IPC_CHANNELS.TRANSFER_CONFLICT_RESPOND, promptId, 'skip', true);

      const res = await resultPromise;
      expect(res).toEqual({ jobId: null, skipped: true, resolvedPolicy: 'skip', appliedToAll: true, targetPath: '/dst/exists.txt' });
      expect(mockTransferQueue.addJob).not.toHaveBeenCalled();
    });

    it('prompts for a conflicting target and applies "rename" to a non-conflicting path', async () => {
      mockStorageRegistry.providers.set('conflict-target', makeConflictProvider() as any);

      const resultPromise = mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'test-storage',
        sourcePath: '/src/file.txt',
        targetProviderId: 'conflict-target',
        targetPath: '/dst/exists.txt',
      });

      await flushMicrotasks();
      const promptEvent = mockWebContents.events.find((e) => e.channel === IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT);
      const promptId = promptEvent?.args[0].id;

      await mockIpc.invoke(IPC_CHANNELS.TRANSFER_CONFLICT_RESPOND, promptId, 'rename', false);

      const res = await resultPromise;
      expect(res).toMatchObject({ jobId: 'job-123', resolvedPolicy: 'rename' });
      // "exists.txt" and "exists (1).txt" both already exist on this fake
      // provider, so the resolver should have skipped to "exists (2).txt".
      expect(mockTransferQueue.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ targetPath: path.join('/dst', 'exists (2).txt') })
      );
    });

    it('skips prompting when an explicit conflictPolicy is given', async () => {
      mockStorageRegistry.providers.set('conflict-target', makeConflictProvider() as any);

      const res = await mockIpc.invoke(IPC_CHANNELS.TRANSFER_ADD, {
        sourceProviderId: 'test-storage',
        sourcePath: '/src/file.txt',
        targetProviderId: 'conflict-target',
        targetPath: '/dst/exists.txt',
        conflictPolicy: 'overwrite',
      });

      expect(res).toMatchObject({ jobId: 'job-123', resolvedPolicy: 'overwrite' });
      expect(mockWebContents.events.some((e) => e.channel === IPC_CHANNELS.TRANSFER_CONFLICT_PROMPT)).toBe(false);
    });

    it('resolves to a safe "skip" without prompting when no webContents is available', async () => {
      const bridgeNoWindow = new IpcBridge({
        ipcMain: new MockIpcMain() as any,
        sshPtyManager: mockPtyManager,
        storageRegistry: mockStorageRegistry,
        transferQueue: mockTransferQueue,
        profileStore: mockProfileStore,
        getWebContents: () => null,
      });
      bridgeNoWindow.register();

      const result = await bridgeNoWindow.promptTransferConflict({
        sourcePath: '/src/file.txt',
        targetPath: '/dst/exists.txt',
        fileName: 'file.txt',
        isDirectory: false,
      });
      expect(result).toEqual({ resolution: 'skip', applyToAll: false });

      await bridgeNoWindow.dispose();
    });

    it('dispose() resolves any pending transfer conflict prompts to "skip"', async () => {
      const promptPromise = bridge.promptTransferConflict({
        sourcePath: '/src/file.txt',
        targetPath: '/dst/exists.txt',
        fileName: 'file.txt',
        isDirectory: false,
      });

      await bridge.dispose();
      await expect(promptPromise).resolves.toEqual({ resolution: 'skip', applyToAll: false });
    });
  });

  describe('Profiles Handlers', () => {
    it('handles profiles get, saveSSH, deleteSSH, saveS3, deleteS3', async () => {
      await mockIpc.invoke(IPC_CHANNELS.PROFILES_GET);
      expect(mockProfileStore.getProfiles).toHaveBeenCalled();

      const sshConfig: SSHConnectionConfig = {
        id: 'ssh-1',
        name: 'SSH',
        host: 'host',
        username: 'user',
        authType: 'password',
      };
      await mockIpc.invoke(IPC_CHANNELS.PROFILES_SAVE_SSH, sshConfig);
      expect(mockProfileStore.saveSSH).toHaveBeenCalledWith(sshConfig);

      await mockIpc.invoke(IPC_CHANNELS.PROFILES_DELETE_SSH, 'ssh-1');
      expect(mockProfileStore.deleteSSH).toHaveBeenCalledWith('ssh-1');

      const s3Config = {
        id: 's3-1',
        name: 'S3',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
      };
      await mockIpc.invoke(IPC_CHANNELS.PROFILES_SAVE_S3, s3Config);
      expect(mockProfileStore.saveS3).toHaveBeenCalledWith(s3Config);

      await mockIpc.invoke(IPC_CHANNELS.PROFILES_DELETE_S3, 's3-1');
      expect(mockProfileStore.deleteS3).toHaveBeenCalledWith('s3-1');
    });
  });

  // Regression tests for the H4 finding (code review): these three channels
  // used to accept an optional caller-supplied path forwarded straight to
  // fs.readFile/writeFile, bypassing the save/open dialog. The real UI never
  // passed one, so it was only reachable by a compromised renderer. Both the
  // preload API and the main-process handler now ignore any extra argument
  // entirely and always resolve the path themselves.
  describe('Profile export/import path handling (H4)', () => {
    it('profilesImportSshConfig ignores a caller-supplied path and only ever reads the real ~/.ssh/config', async () => {
      // Call with an extra positional arg the way a compromised renderer
      // would — the preload API no longer even has a parameter to accept
      // it, but the IPC channel itself could still be invoked directly.
      const result = await mockIpc.invoke(IPC_CHANNELS.PROFILES_IMPORT_SSH_CONFIG, '/etc/passwd');
      expect(result.filePath).not.toBe('/etc/passwd');
      expect(result.filePath.endsWith(path.join('.ssh', 'config'))).toBe(true);
    });

    it('profilesExportJson always resolves the path via the save dialog, ignoring a caller-supplied path', async () => {
      const { dialog } = await import('electron');
      const tmpFile = path.join(os.tmpdir(), `sshs3-export-test-${Date.now()}.json`);
      (dialog.showSaveDialog as any).mockResolvedValueOnce({ canceled: false, filePath: tmpFile });

      const result = await mockIpc.invoke(IPC_CHANNELS.PROFILES_EXPORT_JSON, '/etc/should-not-be-used.json');

      expect(dialog.showSaveDialog).toHaveBeenCalled();
      expect(result?.filePath).toBe(tmpFile);
      await fsp.unlink(tmpFile).catch(() => {});
    });

    it('profilesImportJson always resolves the path via the open dialog, ignoring a caller-supplied path', async () => {
      const { dialog } = await import('electron');
      const tmpFile = path.join(os.tmpdir(), `sshs3-import-test-${Date.now()}.json`);
      await fsp.writeFile(tmpFile, JSON.stringify({ ssh: [{ id: 'x', host: 'h' }], s3: [] }), 'utf-8');
      (dialog.showOpenDialog as any).mockResolvedValueOnce({ canceled: false, filePaths: [tmpFile] });

      const result = await mockIpc.invoke(IPC_CHANNELS.PROFILES_IMPORT_JSON, '/etc/should-not-be-used.json');

      expect(dialog.showOpenDialog).toHaveBeenCalled();
      expect(result.count).toBe(1);
      await fsp.unlink(tmpFile).catch(() => {});
    });

    it('preload profilesExportJson/profilesImportJson/profilesImportSshConfig take no arguments and forward none', async () => {
      await preloadApi.profilesImportSshConfig();
      expect(mockIpcRenderer.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PROFILES_IMPORT_SSH_CONFIG);

      await preloadApi.profilesExportJson();
      expect(mockIpcRenderer.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PROFILES_EXPORT_JSON);

      await preloadApi.profilesImportJson();
      expect(mockIpcRenderer.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.PROFILES_IMPORT_JSON);
    });
  });

  describe('General Handlers', () => {
    it('handles app getVersion', async () => {
      const version = await mockIpc.invoke(IPC_CHANNELS.APP_GET_VERSION);
      expect(version).toBe('0.1.0');
    });

    it('returns the chosen path from the native open-file dialog', async () => {
      const path = await mockIpc.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE, { title: 'Välj fil' });
      expect(path).toBe('/chosen/file.pem');
    });

    it('returns null when the open-file dialog is cancelled', async () => {
      const { dialog } = await import('electron');
      (dialog.showOpenDialog as any).mockResolvedValueOnce({ canceled: true, filePaths: [] });

      const path = await mockIpc.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE);
      expect(path).toBeNull();
    });
  });

  describe('Disposal', () => {
    it('disposeStep swallows a rejecting step and never blocks on a hanging one', async () => {
      vi.useFakeTimers();
      const warn = captureLogs();
      try {
        const step = (bridge as any).disposeStep.bind(bridge);
        await expect(step('failing', () => Promise.reject(new Error('boom')))).resolves.toBeUndefined();
        const hang = step('hanging', () => new Promise<void>(() => {}));
        await vi.advanceTimersByTimeAsync(5000);
        await expect(hang).resolves.toBeUndefined();
        expect(warn.lines).toHaveLength(2);
      } finally {
        warn.restore();
        vi.useRealTimers();
      }
    });

    it('cleans up handlers and calls killAll / disconnectAll', async () => {
      await bridge.dispose();
      expect(mockIpc.handlers.size).toBe(0);
      expect(mockPtyManager.killAll).toHaveBeenCalled();
      expect(mockStorageRegistry.disconnectAll).toHaveBeenCalled();
    });

    it('kills every leftover per-session agent and shuts down the app agent on dispose', async () => {
      const { AgentLifecycleManager } = await import('../../src/main/ssh/AgentLifecycleManager');
      const killSpy = vi.spyOn(AgentLifecycleManager, 'killPrivateAgent').mockImplementation(() => {});
      const unloadSpy = vi.spyOn(AgentLifecycleManager, 'unloadCard').mockResolvedValue();

      // One 'agent-per-session' agent left tracked when the app quits (never reaped because the
      // PTY-exit listener that normally drives cleanupSmartcardSessionAgent() is detached before
      // killAll() runs), plus a card cached in the app-wide 'agent-global' agent.
      (bridge as any).smartcard.smartcardSessionAgents.set('session-1', {
        pid: 4242,
        socketPath: '/tmp/session-agent.sock',
        kind: 'pkcs11',
        pkcs11LibPath: '/usr/lib/opensc-pkcs11.so',
      });
      (bridge as any).smartcard.globalCards.set('/usr/lib/opensc-pkcs11.so', { fingerprints: new Set() });

      await bridge.dispose();

      expect(killSpy).toHaveBeenCalledWith(4242);
      expect(unloadSpy).toHaveBeenCalledWith('/tmp/session-agent.sock', '/usr/lib/opensc-pkcs11.so');
      expect(fakeAppAgent.shutdown).toHaveBeenCalledTimes(1);
      expect((bridge as any).smartcard.smartcardSessionAgents.size).toBe(0);
      expect((bridge as any).smartcard.globalCards.size).toBe(0);

      killSpy.mockRestore();
      unloadSpy.mockRestore();
    });
  });

  describe('Preload Bridge API (MultiSSHApi)', () => {
    it('exposes api in main world', () => {
      mockExposeInMainWorld.mockClear();
      exposePreloadApi();
      expect(mockExposeInMainWorld).toHaveBeenCalledWith('sshs3', preloadApi);
      expect(mockExposeInMainWorld).toHaveBeenCalledWith('multissh', preloadApi);
    });

    it('terminal methods invoke correct channels', async () => {
      await preloadApi.terminalCreate({
        config: { id: 'c1', name: 'C1', host: 'h', username: 'u', authType: 'password' },
      });
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.TERMINAL_CREATE,
        expect.anything()
      );

      await preloadApi.terminalWrite('s1', 'ls\n');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_WRITE, 's1', 'ls\n');

      await preloadApi.terminalResize('s1', 80, 24);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_RESIZE, 's1', 80, 24);

      await preloadApi.terminalKill('s1');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_KILL, 's1');
    });

    it('terminal listener subscription returns unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = preloadApi.onTerminalData(cb);
      expect(mockIpcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_DATA, expect.any(Function));

      unsub();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.TERMINAL_DATA,
        expect.any(Function)
      );

      const exitCb = vi.fn();
      const exitUnsub = preloadApi.onTerminalExit(exitCb);
      expect(mockIpcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_EXIT, expect.any(Function));

      exitUnsub();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.TERMINAL_EXIT,
        expect.any(Function)
      );
    });

    it('smartcard and askpass methods invoke correct channels', async () => {
      await preloadApi.smartcardDetect();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SMARTCARD_DETECT);

      await preloadApi.smartcardValidate('/lib/test.so');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.SMARTCARD_VALIDATE,
        '/lib/test.so'
      );

      await preloadApi.submitAskpassPin('p1', '1234');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.ASKPASS_SUBMIT_PIN, 'p1', '1234');

      const askpassCb = vi.fn();
      const unsub = preloadApi.onAskpassPrompt(askpassCb);
      expect(mockIpcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.ASKPASS_PROMPT, expect.any(Function));
      unsub();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.ASKPASS_PROMPT,
        expect.any(Function)
      );
    });

    it('storage methods invoke correct channels', async () => {
      await preloadApi.connectStorage({ id: 'loc', name: 'Loc', type: 'local' });
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_CONNECT, expect.anything());

      await preloadApi.disconnectStorage('loc');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_DISCONNECT, 'loc');

      await preloadApi.storageList('loc', '/');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_LIST, 'loc', '/');

      await preloadApi.storageStat('loc', '/f');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_STAT, 'loc', '/f');

      await preloadApi.storageLookup('loc', '/f');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_LOOKUP, 'loc', '/f');

      await preloadApi.terminalHasSshClient('sess-1');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TERMINAL_HAS_SSH_CLIENT, 'sess-1');

      await preloadApi.storageCreateFolder('loc', '/dir');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_CREATE_FOLDER, 'loc', '/dir');

      await preloadApi.storageDelete('loc', '/dir', true);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_DELETE, 'loc', '/dir', true);

      await preloadApi.storageRename('loc', '/old', '/new');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_RENAME, 'loc', '/old', '/new');

      await preloadApi.storageGetHomeDir('loc');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.STORAGE_GET_HOMEDIR, 'loc');
    });

    it('transfer methods invoke correct channels and handle subscription', async () => {
      await preloadApi.transferAdd({
        sourceProviderId: 's1',
        sourcePath: '/a',
        targetProviderId: 's2',
        targetPath: '/b',
      });
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TRANSFER_ADD, expect.anything());

      await preloadApi.transferPause('j1');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TRANSFER_PAUSE, 'j1');

      await preloadApi.transferResume('j1');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TRANSFER_RESUME, 'j1');

      await preloadApi.transferCancel('j1');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TRANSFER_CANCEL, 'j1');

      await preloadApi.transferGetJobs();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TRANSFER_GET_JOBS);

      await preloadApi.transferClearCompleted();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.TRANSFER_CLEAR_COMPLETED);

      const progressCb = vi.fn();
      const unsub = preloadApi.onTransferProgress(progressCb);
      expect(mockIpcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.TRANSFER_PROGRESS, expect.any(Function));
      unsub();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.TRANSFER_PROGRESS,
        expect.any(Function)
      );
    });

    it('profile methods invoke correct channels', async () => {
      await preloadApi.profilesGet();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.PROFILES_GET);

      const ssh = { id: 's1', name: 'S1', host: 'h', username: 'u', authType: 'password' as const };
      await preloadApi.profilesSaveSSH(ssh);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.PROFILES_SAVE_SSH, ssh);

      await preloadApi.profilesDeleteSSH('s1');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.PROFILES_DELETE_SSH, 's1');

      const s3 = { id: 's3', name: 'S3', region: 'r', accessKeyId: 'k', secretAccessKey: 's' };
      await preloadApi.profilesSaveS3(s3);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.PROFILES_SAVE_S3, s3);

      await preloadApi.profilesDeleteS3('s3');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.PROFILES_DELETE_S3, 's3');
    });

    it('key install methods invoke correct channels', async () => {
      const cfg = { id: 'p1', name: 'P', host: 'h', username: 'u', authType: 'password' as const };
      await preloadApi.listPublicKeys({ config: cfg, includeHardware: true });
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SSH_LIST_PUBLIC_KEYS, {
        config: cfg,
        includeHardware: true,
      });

      await preloadApi.installPublicKeys({ config: cfg, publicKeys: ['k'], loginMethod: 'password' });
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SSH_INSTALL_PUBLIC_KEYS, {
        config: cfg,
        publicKeys: ['k'],
        loginMethod: 'password',
      });

      await preloadApi.sshProbeHost(cfg);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SSH_PROBE_HOST, cfg);

      await preloadApi.sshTestLogin(cfg);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SSH_TEST_LOGIN, cfg);

      await preloadApi.buildInstallCommand(['k']);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SSH_BUILD_INSTALL_COMMAND, ['k']);
    });

    it('connection test methods invoke correct channels', async () => {
      const ssh = { id: 's1', name: 'S1', host: 'h', username: 'u', authType: 'password' as const };
      await preloadApi.testSSHConnection(ssh);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CONNECTION_TEST_SSH, ssh);

      const s3 = { id: 's3', name: 'S3', region: 'r', accessKeyId: 'k', secretAccessKey: 's' };
      await preloadApi.testS3Connection(s3);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.CONNECTION_TEST_S3, s3);
    });

    it('getVersion invokes correct channel', async () => {
      await preloadApi.getVersion();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_GET_VERSION);
    });

    it('storageChmod invokes correct channel', async () => {
      await preloadApi.storageChmod('test-storage', '/test/file.txt', '755');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.STORAGE_CHMOD,
        'test-storage',
        '/test/file.txt',
        '755'
      );
    });

    it('session get and save invoke correct channels', async () => {
      await preloadApi.sessionGet();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_GET);

      const session = { tabs: [], activeTabId: 't1' };
      await preloadApi.sessionSave(session);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_SAVE, session);
    });

    it('settings get and save invoke correct channels', async () => {
      await preloadApi.settingsGet();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_GET);

      const settings = { theme: 'dark' as const, terminal: { fontSize: 16, fontFamily: 'monospace' }, defaultTabType: 'terminal' as const };
      await preloadApi.settingsSave(settings);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SETTINGS_SAVE, settings);
    });

    it('dialogOpenFile invokes correct channel with options', async () => {
      const options = { title: 'Välj fil', filters: [{ name: 'Nycklar', extensions: ['pem'] }] };
      await preloadApi.dialogOpenFile(options);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.DIALOG_OPEN_FILE, options);
    });

    it('file editor methods invoke correct channels', async () => {
      await preloadApi.fileRead('p1', '/path/file.txt', 1000);
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.FILE_READ, 'p1', '/path/file.txt', 1000);

      await preloadApi.fileSave('p1', '/path/file.txt', 'hello');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.FILE_SAVE, 'p1', '/path/file.txt', 'hello');

      await preloadApi.fileOpenExternal('p1', '/path/file.txt');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.FILE_OPEN_EXTERNAL, 'p1', '/path/file.txt');

      await preloadApi.fileCloseExternal('token-123');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.FILE_CLOSE_EXTERNAL, 'token-123');

      const cb = vi.fn();
      const unsub = preloadApi.onExternalFileStatus(cb);
      expect(mockIpcRenderer.on).toHaveBeenCalledWith(IPC_CHANNELS.FILE_EXTERNAL_STATUS, expect.any(Function));
      unsub();
      expect(mockIpcRenderer.removeListener).toHaveBeenCalledWith(
        IPC_CHANNELS.FILE_EXTERNAL_STATUS,
        expect.any(Function)
      );

      await preloadApi.checkX11Server('127.0.0.1:0.0');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.APP_CHECK_X11_SERVER, '127.0.0.1:0.0');

      await preloadApi.x11GetStatus('C:\\tools\\vcxsrv.exe', ':0');
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(
        IPC_CHANNELS.X11_GET_STATUS,
        'C:\\tools\\vcxsrv.exe',
        ':0'
      );

      await preloadApi.x11StartServer({ customPath: 'C:\\tools\\vcxsrv.exe' });
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.X11_START_SERVER, {
        customPath: 'C:\\tools\\vcxsrv.exe',
      });

      await preloadApi.x11StopServer();
      expect(mockIpcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.X11_STOP_SERVER);
    });
  });

  describe('Storage Chmod Handler', () => {
    it('successfully calls provider chmod', async () => {
      const provider = mockStorageRegistry.providers.get('test-storage');
      await mockIpc.invoke(IPC_CHANNELS.STORAGE_CHMOD, 'test-storage', '/var/log/app.log', '644');
      expect(provider.chmod).toHaveBeenCalledWith('/var/log/app.log', '644');
    });

    it('throws error if provider not found or chmod unsupported', async () => {
      await expect(
        mockIpc.invoke(IPC_CHANNELS.STORAGE_CHMOD, 'non-existent', '/file', '755')
      ).rejects.toThrow();
    });
  });

  describe('Session Handlers', () => {
    it('retrieves session data', async () => {
      const data = await mockIpc.invoke(IPC_CHANNELS.SESSION_GET);
      expect(data).toEqual({ tabs: [], activeTabId: 't1' });
      // No window router in this test: the sender counts as the main window (key null).
      expect(mockSessionStore.getSessionForWindow).toHaveBeenCalledWith(null);
    });

    it('saves session data', async () => {
      const session = { tabs: [{ id: 'tab-1', title: 'SSH', type: 'terminal' }], activeTabId: 'tab-1' };
      await mockIpc.invoke(IPC_CHANNELS.SESSION_SAVE, session);
      expect(mockSessionStore.saveSessionForWindow).toHaveBeenCalledWith(null, session);
    });
  });

  describe('Settings Handlers', () => {
    it('retrieves settings data', async () => {
      const settings = await mockIpc.invoke(IPC_CHANNELS.SETTINGS_GET);
      expect(settings).toEqual({ theme: 'system', terminal: { fontSize: 14, fontFamily: 'monospace' }, defaultTabType: 'terminal' });
      expect(mockSettingsStore.getSettings).toHaveBeenCalled();
    });

    it('saves settings data', async () => {
      const settings = { theme: 'light', terminal: { fontSize: 18, fontFamily: 'Fira Code' }, defaultTabType: 'files' };
      await mockIpc.invoke(IPC_CHANNELS.SETTINGS_SAVE, settings);
      expect(mockSettingsStore.saveSettings).toHaveBeenCalledWith(settings);
    });
  });

  describe('Connection Test Handlers', () => {
    it('validates required fields for SSH test', async () => {
      const res1 = await mockIpc.invoke(IPC_CHANNELS.CONNECTION_TEST_SSH, { host: '', username: 'u' });
      expect(res1.success).toBe(false);
      expect(res1.error).toContain('Hostname');

      const res2 = await mockIpc.invoke(IPC_CHANNELS.CONNECTION_TEST_SSH, { host: 'h', username: '' });
      expect(res2.success).toBe(false);
      expect(res2.error).toContain('Username');
    });

    it('validates required fields for S3 test', async () => {
      const res = await mockIpc.invoke(IPC_CHANNELS.CONNECTION_TEST_S3, { region: '', accessKeyId: 'k', secretAccessKey: 's' });
      expect(res.success).toBe(false);
      expect(res.error).toContain('Region');
    });
  });

  describe('Key Install Handlers', () => {
    const profile = { id: 'p1', name: 'Prod', host: 'db.internal', username: 'alice', authType: 'password' as const };
    const KEY = `ssh-ed25519 ${Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from('ssh-ed25519'),
      Buffer.from([0, 0, 0, 32]),
      Buffer.alloc(32, 7),
    ]).toString('base64')} a@b`;

    beforeEach(() => {
      vi.mocked(installPublicKeys).mockReset();
      mockProfileStore.getProfiles.mockResolvedValue({ ssh: [profile], s3: [] });
    });

    it('rejects an invalid config without touching ssh', async () => {
      for (const bad of [
        undefined,
        { ...profile, host: '' },
        { ...profile, username: ' ' },
        { ...profile, authType: 'telepathy' },
        { ...profile, port: 70000 },
        { ...profile, port: 22.5 },
        { ...profile, authType: 'smartcard' },
        { ...profile, authType: 'smartcard', pkcs11LibPath: ' ' },
        { ...profile, authType: 'fido2' },
      ]) {
        await expect(
          mockIpc.invoke(IPC_CHANNELS.SSH_INSTALL_PUBLIC_KEYS, { config: bad, publicKeys: [KEY] })
        ).rejects.toThrow();
        await expect(mockIpc.invoke(IPC_CHANNELS.SSH_PROBE_HOST, bad)).rejects.toThrow();
        await expect(mockIpc.invoke(IPC_CHANNELS.SSH_TEST_LOGIN, bad)).rejects.toThrow();
      }
      expect(installPublicKeys).not.toHaveBeenCalled();
      expect(probeHost).not.toHaveBeenCalled();
      expect(testLogin).not.toHaveBeenCalled();
    });

    it('rejects malformed requests', async () => {
      for (const bad of [
        undefined,
        { config: profile },
        { config: profile, publicKeys: [] },
        { config: profile, publicKeys: [42] },
        { config: profile, publicKeys: Array(51).fill(KEY) },
        { config: profile, publicKeys: [KEY], loginMethod: 'telepathy' },
        { config: profile, publicKeys: [KEY], serverMethods: [1] },
      ]) {
        await expect(mockIpc.invoke(IPC_CHANNELS.SSH_INSTALL_PUBLIC_KEYS, bad)).rejects.toThrow();
      }
      expect(installPublicKeys).not.toHaveBeenCalled();
    });

    it('passes the draft config through but never trusts a renderer-supplied agent socket', async () => {
      vi.mocked(installPublicKeys).mockResolvedValue({
        success: true,
        results: [{ fingerprint: 'SHA256:x', status: 'installed' }],
        loginMethod: 'password',
      });

      const res = await mockIpc.invoke(IPC_CHANNELS.SSH_INSTALL_PUBLIC_KEYS, {
        config: { ...profile, agentPath: '/tmp/evil-agent.sock' },
        publicKeys: [KEY],
        loginMethod: 'password',
        installsOwnKeyOnly: true,
        serverMethods: ['publickey', 'password'],
      });

      expect(res.success).toBe(true);
      const call = vi.mocked(installPublicKeys).mock.calls[0][0];
      expect(call.config.host).toBe('db.internal');
      expect(call.config.agentPath).toBeUndefined();
      expect(call).toMatchObject({
        publicKeys: [KEY],
        loginMethod: 'password',
        installsOwnKeyOnly: true,
        serverMethods: ['publickey', 'password'],
      });
    });

    it('delegates probe and login test to the service', async () => {
      vi.mocked(probeHost).mockResolvedValue({ reachable: true, hostKey: 'trusted', methods: ['password'] });
      vi.mocked(testLogin).mockResolvedValue({ success: true });

      expect(await mockIpc.invoke(IPC_CHANNELS.SSH_PROBE_HOST, profile)).toMatchObject({ methods: ['password'] });
      expect(await mockIpc.invoke(IPC_CHANNELS.SSH_TEST_LOGIN, profile)).toEqual({ success: true });
      expect(vi.mocked(probeHost).mock.calls[0][0].host).toBe('db.internal');
    });

    it('builds the manual fallback command and rejects invalid keys', async () => {
      const cmd = await mockIpc.invoke(IPC_CHANNELS.SSH_BUILD_INSTALL_COMMAND, [KEY]);
      expect(cmd).toContain(KEY);
      await expect(mockIpc.invoke(IPC_CHANNELS.SSH_BUILD_INSTALL_COMMAND, ['garbage'])).rejects.toThrow();
      await expect(mockIpc.invoke(IPC_CHANNELS.SSH_BUILD_INSTALL_COMMAND, [])).rejects.toThrow();
    });
  });

  describe('dotfiles sync policy', () => {
    it("persists 'always' on the saved profile, not on the resolved runtime config", async () => {
      mockSettingsStore.getSettings.mockResolvedValue({ dotfilesPoolEnabled: true });
      const savedProfile = {
        id: 'p1',
        name: 'Prod',
        host: 'prod.example.com',
        username: 'deploy',
        authType: 'smartcard',
        pkcs11LibPath: '/usr/lib/opensc.so',
        poolId: 'pool-1',
        dotfilesSyncPolicy: 'ask',
        proxyJumpProfileId: 'jump-1',
      };
      mockProfileStore.getProfiles.mockResolvedValue({ ssh: [savedProfile], s3: [] });
      (bridge as any).dotfilePoolStore = {
        getPool: vi.fn().mockResolvedValue({ id: 'pool-1', name: 'Pool', files: [{ id: 'f1' }] }),
      };
      (bridge as any).dotfileSyncService = {
        computeDiff: vi.fn().mockResolvedValue({ provider: { disconnect: vi.fn().mockResolvedValue(undefined) }, entries: [{ fileId: 'f1' }] }),
        applyFiles: vi.fn().mockResolvedValue(undefined),
      };
      (bridge as any).promptDotfilesSync = vi.fn().mockResolvedValue('always');
      mockPtyManager.getSession = vi.fn().mockReturnValue(undefined);

      // The runtime config differs from the saved profile: resolved jump host and a live agent socket.
      const runtimeConfig = {
        ...savedProfile,
        agentPath: '/tmp/agent.sock',
        proxyJumpProfileId: undefined,
        proxyJump: 'jump@bastion',
      };
      await (bridge as any).runDotfilesSyncCheck('sess-1', runtimeConfig);

      expect(mockProfileStore.saveSSH).toHaveBeenCalledTimes(1);
      const saved = mockProfileStore.saveSSH.mock.calls[0][0];
      expect(saved).toMatchObject({ id: 'p1', dotfilesSyncPolicy: 'always', proxyJumpProfileId: 'jump-1' });
      expect(saved.agentPath).toBeUndefined();
      expect(saved.proxyJump).toBeUndefined();
    });
  });

  describe('Git pull handler', () => {
    it('resolves the SSH connection of a remote pane from the saved profile', async () => {
      const { RemoteGitService } = await import('../../src/main/git/RemoteGitService');
      const pullSpy = vi.spyOn(RemoteGitService, 'pull').mockResolvedValue({ success: true, output: 'ok' });
      mockProfileStore.getProfiles.mockResolvedValue({
        ssh: [{ id: 'p1', name: 'Prod', host: 'prod.example.com', username: 'deploy', authType: 'privateKey' }],
        s3: [],
      });

      const res = await mockIpc.invoke(IPC_CHANNELS.GIT_PULL, '/srv/app', 'sftp-p1');

      expect(res).toEqual({ success: true, output: 'ok' });
      expect(pullSpy).toHaveBeenCalledWith(
        '/srv/app',
        'sftp-p1',
        expect.objectContaining({ id: 'p1', host: 'prod.example.com', username: 'deploy' })
      );
      pullSpy.mockRestore();
    });

    it('passes no connection for local panes or unknown providers', async () => {
      const { RemoteGitService } = await import('../../src/main/git/RemoteGitService');
      const pullSpy = vi.spyOn(RemoteGitService, 'pull').mockResolvedValue({ success: true });

      await mockIpc.invoke(IPC_CHANNELS.GIT_PULL, '/home/me/repo', 'local');
      await mockIpc.invoke(IPC_CHANNELS.GIT_PULL, '/srv/app', 'sftp-missing');

      expect(pullSpy).toHaveBeenNthCalledWith(1, '/home/me/repo', 'local', undefined);
      expect(pullSpy).toHaveBeenNthCalledWith(2, '/srv/app', 'sftp-missing', undefined);
      pullSpy.mockRestore();
    });
  });

  describe('File Editor Handlers', () => {
    it('delegates fileRead to fileEditorService', async () => {
      vi.spyOn(bridge.fileEditorService, 'readFile').mockResolvedValue({
        content: 'data',
        size: 4,
        isBinary: false,
        truncated: false,
      });

      const res = await mockIpc.invoke(IPC_CHANNELS.FILE_READ, 'test-storage', '/file.txt', 500);
      expect(bridge.fileEditorService.readFile).toHaveBeenCalledWith(
        bridge.storageRegistry,
        'test-storage',
        '/file.txt',
        500
      );
      expect(res.content).toBe('data');
    });

    it('delegates fileSave to fileEditorService', async () => {
      vi.spyOn(bridge.fileEditorService, 'saveFile').mockResolvedValue();

      await mockIpc.invoke(IPC_CHANNELS.FILE_SAVE, 'test-storage', '/file.txt', 'updated');
      expect(bridge.fileEditorService.saveFile).toHaveBeenCalledWith(
        bridge.storageRegistry,
        'test-storage',
        '/file.txt',
        'updated'
      );
    });

    it('delegates fileOpenExternal and fileCloseExternal', async () => {
      vi.spyOn(bridge.fileEditorService, 'openInExternalEditor').mockResolvedValue({
        sessionToken: 'tok-1',
        localPath: '/tmp/f.txt',
      });
      vi.spyOn(bridge.fileEditorService, 'closeExternalEditor').mockResolvedValue();

      const res = await mockIpc.invoke(IPC_CHANNELS.FILE_OPEN_EXTERNAL, 'test-storage', '/file.txt');
      expect(res).toEqual({ sessionToken: 'tok-1', localPath: '/tmp/f.txt' });

      await mockIpc.invoke(IPC_CHANNELS.FILE_CLOSE_EXTERNAL, 'tok-1');
      expect(bridge.fileEditorService.closeExternalEditor).toHaveBeenCalledWith('tok-1');
    });

    // These two do real filesystem probing (`where pwsh.exe`/`where vcxsrv.exe`
    // style execFile lookups) and a real TCP connect attempt to 127.0.0.1,
    // rather than anything mocked — slow/loaded CI runners (observed on
    // Windows) can occasionally exceed vitest's default 5000ms test timeout,
    // so give them more headroom than a pure-mock test needs.
    it('checks X11 server reachability via APP_CHECK_X11_SERVER', async () => {
      const res = await mockIpc.invoke(IPC_CHANNELS.APP_CHECK_X11_SERVER, '127.0.0.1:0.0');
      expect(res).toHaveProperty('running');
      expect(res).toHaveProperty('display', '127.0.0.1:0.0');
    }, 15000);

    it('handles X11 server lifecycle channels (status, start, stop)', async () => {
      const statusRes = await mockIpc.invoke(IPC_CHANNELS.X11_GET_STATUS, undefined, '127.0.0.1:0.0');
      expect(statusRes).toHaveProperty('available');
      expect(statusRes).toHaveProperty('running');

      const stopRes = await mockIpc.invoke(IPC_CHANNELS.X11_STOP_SERVER);
      expect(stopRes).toEqual({ success: true });
    }, 15000);
  });
});
