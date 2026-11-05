import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => {
  const mockObj = { app: { getPath: vi.fn().mockReturnValue('/tmp/user-data') } };
  return { ...mockObj, default: mockObj };
});

import { SmartcardDetector } from '../../src/main/smartcard/SmartcardDetector';
import * as SmartcardCertificateReader from '../../src/main/smartcard/SmartcardCertificateReader';
import type { SmartcardCertificateDetails } from '../../src/main/smartcard/CertificateParser';
import { AgentLifecycleManager } from '../../src/main/ssh/AgentLifecycleManager';
import { AppAgent, KeysLockedWhileLoadingError } from '../../src/main/ssh/AppAgent';
import { SmartcardCoordinator, TokenNotInsertedError, type SmartcardDeps } from '../../src/main/smartcard/SmartcardCoordinator';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';
import type { SFTPConfig } from '../../src/shared/types/storage';

const LIB = '/usr/lib/opensc-pkcs11.so';

function makeDeps(calls: string[] = []): SmartcardDeps {
  return {
    settingsStore: { getSettings: vi.fn().mockResolvedValue({ smartcardAuthMode: 'agent-global' }) } as any,
    profileStore: { getProfiles: vi.fn().mockResolvedValue({ ssh: [], s3: [] }) } as any,
    sessionStore: {} as any,
    syncConfigStore: { getConfig: vi.fn().mockResolvedValue({}) } as any,
    sshPtyManager: {} as any,
    getWebContents: () => null,
    promptForPin: vi.fn().mockResolvedValue('123456'),
    waitForToken: vi.fn().mockResolvedValue(true),
    makePresenceNotifier: vi.fn().mockReturnValue({ onPresenceRequested: vi.fn(), onPresenceCleared: vi.fn() }),
    clearPresence: vi.fn((id: string) => void calls.push(`clearPresence:${id}`)),
    syncAgentBlock: vi.fn(async (entries: unknown) => void calls.push(`syncAgentBlock:${entries === null ? 'null' : 'entries'}`)),
  };
}

function makeFakeAgent(calls: string[] = []) {
  return {
    setHandlers: vi.fn(),
    setOnExit: vi.fn(),
    ensure: vi.fn().mockResolvedValue('/run/sshs3/agent.sock'),
    getSocketPath: vi.fn().mockReturnValue('/run/sshs3/agent.sock'),
    list: vi.fn().mockResolvedValue([]),
    addPkcs11: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    removeIdentities: vi.fn().mockResolvedValue(0),
    adoptIdentities: vi.fn().mockResolvedValue(undefined),
    evictIdentities: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(async () => void calls.push('appAgent.shutdown')),
  };
}

function build(calls: string[] = []) {
  const deps = makeDeps(calls);
  const coordinator = new SmartcardCoordinator(deps);
  const agent = makeFakeAgent(calls);
  // White-box: the app agent is private state; swap it for a fake after construction.
  (coordinator as any).appAgent = agent;
  return { coordinator, deps, agent };
}

describe('SmartcardCoordinator', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(SmartcardCertificateReader, 'readSmartcardCertificates').mockResolvedValue(new Map());
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads a card into the app agent once and records it as unlocked', async () => {
    const { coordinator, agent } = build();

    const socket = await coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => '123456');

    expect(socket).toBe('/run/sshs3/agent.sock');
    expect(agent.addPkcs11).toHaveBeenCalledTimes(1);
    await expect(coordinator.getUnlockedCardSocket(LIB)).resolves.toBe('/run/sshs3/agent.sock');
    expect(coordinator.appAgentSocketIfUnlocked()).toBe('/run/sshs3/agent.sock');
    expect(coordinator.unlockedPivSocket()).toBe('/run/sshs3/agent.sock');
  });

  it('shares one in-flight load between concurrent connections to the same card', async () => {
    const { coordinator, agent } = build();
    let release!: () => void;
    agent.addPkcs11.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));

    const first = coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'pin');
    const second = coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'pin');
    await vi.waitFor(() => expect(agent.addPkcs11).toHaveBeenCalledTimes(1));
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(['/run/sshs3/agent.sock', '/run/sshs3/agent.sock']);
    expect(agent.addPkcs11).toHaveBeenCalledTimes(1);
  });

  describe('card not plugged in', () => {
    it('waits for the card, then loads it', async () => {
      const { coordinator, deps, agent } = build();
      vi.spyOn(SmartcardCertificateReader, 'isSmartcardTokenPresent').mockResolvedValue(false);

      await coordinator.getOrLoadGlobalSmartcardAgent(LIB, 'session-1', 'connect to host');

      expect(deps.waitForToken).toHaveBeenCalledWith('smartcard', 'connect to host', expect.any(Function));
      expect(agent.addPkcs11).toHaveBeenCalledTimes(1);
    });

    it('does not ask when the card is there or presence is unknown', async () => {
      for (const present of [true, undefined]) {
        const { coordinator, deps } = build();
        vi.spyOn(SmartcardCertificateReader, 'isSmartcardTokenPresent').mockResolvedValue(present);
        await coordinator.getOrLoadGlobalSmartcardAgent(LIB, 'session-1', 'connect');
        expect(deps.waitForToken).not.toHaveBeenCalled();
      }
    });

    it('also waits before a private-agent load that names its purpose (e.g. profile sync)', async () => {
      const { coordinator, deps } = build();
      vi.spyOn(SmartcardCertificateReader, 'isSmartcardTokenPresent').mockResolvedValue(false);
      vi.mocked(deps.waitForToken).mockResolvedValue(false);

      await expect(
        coordinator.loadSmartcardIntoPrivateAgentWithPresence(LIB, async () => 'pin', undefined, 'Remote Profile Sync')
      ).rejects.toBeInstanceOf(TokenNotInsertedError);
      expect(deps.waitForToken).toHaveBeenCalledWith('smartcard', 'Remote Profile Sync', expect.any(Function));
    });

    it('checks the default PIV module for flows without a library of their own (Team Vault)', async () => {
      const { coordinator, deps } = build();
      vi.spyOn(SmartcardDetector, 'detectAvailableLibraries').mockResolvedValue([
        { name: 'p11-kit', path: '/usr/lib/p11-kit-proxy.so', platform: 'linux', exists: true },
        { name: 'OpenSC', path: LIB, platform: 'linux', exists: true },
      ]);
      const present = vi.spyOn(SmartcardCertificateReader, 'isSmartcardTokenPresent').mockResolvedValue(false);

      await coordinator.ensureDefaultPivPresent('Team Vault: Acme');

      expect(present).toHaveBeenCalledWith('/usr/lib/p11-kit-proxy.so');
      expect(deps.waitForToken).toHaveBeenCalledWith('smartcard', 'Team Vault: Acme', expect.any(Function));
    });

    it('stops without a PIN prompt or a cooldown when the user dismisses the prompt', async () => {
      const { coordinator, deps, agent } = build();
      vi.spyOn(SmartcardCertificateReader, 'isSmartcardTokenPresent').mockResolvedValue(false);
      vi.mocked(deps.waitForToken).mockResolvedValue(false);

      await expect(coordinator.getOrLoadGlobalSmartcardAgent(LIB, 'session-1', 'connect')).rejects.toBeInstanceOf(
        TokenNotInsertedError
      );
      await expect(coordinator.getOrLoadGlobalSmartcardAgent(LIB, 'session-1', 'connect')).rejects.toBeInstanceOf(
        TokenNotInsertedError
      );
      expect(deps.waitForToken).toHaveBeenCalledTimes(2);
      expect(agent.addPkcs11).not.toHaveBeenCalled();
    });
  });

  describe('Windows shared agent', () => {
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const LIB2 = 'C:/OpenSC/opensc-pkcs11.dll';
    const card = (fingerprint: string) =>
      new Map([[fingerprint, { authCapable: true } as unknown as SmartcardCertificateDetails]]);
    const identity = (fingerprint: string) => ({ fingerprint, keyType: 'ecdsa-sha2-nistp256' }) as any;

    beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }));
    afterEach(() => Object.defineProperty(process, 'platform', origPlatform));

    it('evicts a key left in the service by an earlier run and loads the card afresh', async () => {
      const { coordinator, agent } = build();
      vi.mocked(SmartcardCertificateReader.readSmartcardCertificates).mockResolvedValue(card('SHA256:old'));
      agent.list.mockResolvedValue([identity('SHA256:old')]);

      await coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'pin');

      expect(agent.evictIdentities).toHaveBeenCalledWith(['SHA256:old']);
      expect(agent.addPkcs11).toHaveBeenCalledTimes(1);
      expect(agent.adoptIdentities).toHaveBeenCalledWith(new Set(['SHA256:old']));
    });

    it('lets a second module for the same card wait instead of evicting the keys the first just added', async () => {
      const { coordinator, agent } = build();
      vi.mocked(SmartcardCertificateReader.readSmartcardCertificates).mockResolvedValue(card('SHA256:card'));
      // Empty for the first load's "before" snapshot; the card's key is in the agent from then on.
      agent.list.mockResolvedValueOnce([]).mockResolvedValue([identity('SHA256:card')]);
      let release!: () => void;
      agent.addPkcs11.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));

      const first = coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'pin');
      await vi.waitFor(() => expect(agent.addPkcs11).toHaveBeenCalledTimes(1));
      const second = coordinator.getOrLoadGlobalSmartcardAgent(LIB2, async () => 'pin');
      // The second load has not looked at the agent while the first is still adding its key.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(agent.list).toHaveBeenCalledTimes(1);

      release();
      await Promise.all([first, second]);

      expect(agent.evictIdentities).not.toHaveBeenCalled();
      expect(agent.addPkcs11).toHaveBeenCalledTimes(1);
    });

    it('does not wait for earlier loads on other platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { coordinator, agent } = build();
      let release!: () => void;
      agent.addPkcs11.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));

      const first = coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'pin');
      await vi.waitFor(() => expect(agent.addPkcs11).toHaveBeenCalledTimes(1));
      const second = coordinator.getOrLoadGlobalSmartcardAgent(LIB2, async () => 'pin');
      await vi.waitFor(() => expect(agent.addPkcs11).toHaveBeenCalledTimes(2));

      release();
      await Promise.all([first, second]);
    });

    it('a failed earlier load does not stop the next one', async () => {
      const { coordinator, agent } = build();
      let fail!: (err: Error) => void;
      agent.addPkcs11.mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)));

      const first = coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'pin');
      const firstResult = first.catch((err: Error) => err.message);
      await vi.waitFor(() => expect(agent.addPkcs11).toHaveBeenCalledTimes(1));
      const second = coordinator.getOrLoadGlobalSmartcardAgent(LIB2, async () => 'pin');

      fail(new Error('wrong PIN'));
      await expect(firstResult).resolves.toBe('wrong PIN');
      await expect(second).resolves.toBe('/run/sshs3/agent.sock');
    });
  });

  it('cools down for 30 s after a failed load instead of prompting for the PIN again', async () => {
    const { coordinator, agent } = build();
    agent.addPkcs11.mockRejectedValueOnce(new Error('wrong PIN'));

    await expect(coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'bad')).rejects.toThrow('wrong PIN');
    expect(coordinator.isInLoadCooldown(LIB)).toBe(true);
    await expect(coordinator.getUnlockedCardSocket(LIB)).resolves.toBeUndefined();

    await expect(coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'again')).rejects.toThrow(/cooling down/);
    expect(agent.addPkcs11).toHaveBeenCalledTimes(1);
  });

  it('does not start a cooldown for a load that the user cancelled by locking the keys (M12)', async () => {
    const { coordinator, agent } = build();
    agent.addPkcs11.mockRejectedValueOnce(new KeysLockedWhileLoadingError());

    await expect(coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => '123456')).rejects.toBeInstanceOf(KeysLockedWhileLoadingError);

    expect(coordinator.isInLoadCooldown(LIB)).toBe(false);
  });

  it('forgets a card after a failed use, but not when a private agent was involved', async () => {
    const { coordinator, agent, deps } = build();
    await coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => '123456');
    (coordinator as any).globalSmartcardCerts.set(LIB, new Map());

    coordinator.forgetGlobalCardAfterFailure(LIB, 4242);
    await expect(coordinator.getUnlockedCardSocket(LIB)).resolves.toBe('/run/sshs3/agent.sock');

    coordinator.forgetGlobalCardAfterFailure(LIB, undefined);
    await expect(coordinator.getUnlockedCardSocket(LIB)).resolves.toBeUndefined();
    expect((coordinator as any).globalSmartcardCerts.has(LIB)).toBe(false);
    expect(agent.remove).toHaveBeenCalledWith(LIB);
    await (coordinator as any).agentConfigRefresh;
    expect(deps.syncAgentBlock).toHaveBeenCalled();
  });

  describe('prepareSmartcardConfig / prepareSftpSmartcardConfig — smartcardLibPath fallback', () => {
    // Regression found via real-world use: a shared Team Vault smartcard profile has no
    // pkcs11LibPath of its own (it's a personal, per-machine setting, never a security boundary
    // — see the connection-manager plan's correction), so without this fallback the connection
    // silently disabled PKCS11Provider instead of using the member's own configured default.
    it("falls back to settings.smartcardLibPath when the profile's own pkcs11LibPath is empty (SSH)", async () => {
      const { coordinator, deps, agent } = build();
      (deps.settingsStore.getSettings as any).mockResolvedValue({
        smartcardAuthMode: 'agent-global',
        smartcardLibPath: LIB,
      });

      const prepared = await coordinator.prepareSmartcardConfig({
        id: 'c1',
        name: 'shared',
        host: 'h',
        username: 'u',
        authType: 'smartcard',
      } as any);

      expect(prepared.pkcs11LibPath).toBe(LIB);
      expect(agent.addPkcs11).toHaveBeenCalledWith(LIB, expect.anything(), expect.anything());
    });

    it("a profile's own pkcs11LibPath always wins over the settings default", async () => {
      const { coordinator, deps, agent } = build();
      const ownPath = '/opt/custom/own-pkcs11.so';
      (deps.settingsStore.getSettings as any).mockResolvedValue({
        smartcardAuthMode: 'agent-global',
        smartcardLibPath: LIB,
      });

      const prepared = await coordinator.prepareSmartcardConfig({
        id: 'c1',
        name: 'own',
        host: 'h',
        username: 'u',
        authType: 'smartcard',
        pkcs11LibPath: ownPath,
      } as any);

      expect(prepared.pkcs11LibPath).toBe(ownPath);
      expect(agent.addPkcs11).toHaveBeenCalledWith(ownPath, expect.anything(), expect.anything());
    });

    it('leaves the config untouched when neither the profile nor settings has a library path', async () => {
      const { coordinator, deps, agent } = build();
      (deps.settingsStore.getSettings as any).mockResolvedValue({ smartcardAuthMode: 'agent-global' });

      const prepared = await coordinator.prepareSmartcardConfig({
        id: 'c1',
        name: 'none',
        host: 'h',
        username: 'u',
        authType: 'smartcard',
      } as any);

      expect(prepared.pkcs11LibPath).toBeUndefined();
      expect(agent.addPkcs11).not.toHaveBeenCalled();
    });

    it('applies the same fallback for an SFTP connection', async () => {
      const { coordinator, deps, agent } = build();
      (deps.settingsStore.getSettings as any).mockResolvedValue({
        smartcardAuthMode: 'agent-global',
        smartcardLibPath: LIB,
      });

      const prepared = await coordinator.prepareSftpSmartcardConfig(
        { id: 's1', name: 'shared', host: 'h', username: 'u', authType: 'smartcard' } as any,
        'provider-1'
      );

      expect(prepared.pkcs11LibPath).toBe(LIB);
      expect(agent.addPkcs11).toHaveBeenCalledWith(LIB, expect.anything(), expect.anything());
    });

    it('is a no-op for a non-smartcard authType', async () => {
      const { coordinator, deps } = build();
      (deps.settingsStore.getSettings as any).mockResolvedValue({ smartcardLibPath: LIB });

      const prepared = await coordinator.prepareSmartcardConfig({
        id: 'c1',
        name: 'pw',
        host: 'h',
        username: 'u',
        authType: 'password',
      } as any);

      expect(prepared.pkcs11LibPath).toBeUndefined();
    });
  });

  describe('awaitStartupUnlock', () => {
    it('returns at once when no startup unlock is running', async () => {
      const { coordinator } = build();
      await expect(coordinator.awaitStartupUnlock()).resolves.toBeUndefined();
    });

    it('waits for a running startup unlock and ignores its failure', async () => {
      const { coordinator } = build();
      let done = false;
      (coordinator as any).startupUnlockPromise = new Promise<void>((_, reject) =>
        setTimeout(() => {
          done = true;
          reject(new Error('card not present'));
        }, 5)
      );

      await expect(coordinator.awaitStartupUnlock()).resolves.toBeUndefined();
      expect(done).toBe(true);
    });
  });

  describe('dispose', () => {
    it('ends session agents, forgets the cards, removes the agent block and only then shuts the app agent down', async () => {
      const calls: string[] = [];
      const { coordinator, agent } = build(calls);
      const unload = vi.spyOn(AgentLifecycleManager, 'unloadCard').mockResolvedValue(undefined as any);
      const kill = vi.spyOn(AgentLifecycleManager, 'killPrivateAgent').mockImplementation(() => {
        calls.push('killPrivateAgent');
      });
      (coordinator as any).smartcardSessionAgents.set('sess-1', {
        pid: 99,
        socketPath: '/tmp/agent-sess-1.sock',
        kind: 'pkcs11',
        pkcs11LibPath: LIB,
      });
      await coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => '123456');
      calls.length = 0;

      await coordinator.dispose();

      expect(unload).toHaveBeenCalledWith('/tmp/agent-sess-1.sock', LIB);
      expect(kill).toHaveBeenCalledWith(99);
      expect(coordinator.listSessionAgents()).toEqual([]);
      await expect(coordinator.getUnlockedCardSocket(LIB)).resolves.toBeUndefined();
      expect(agent.shutdown).toHaveBeenCalledTimes(1);
      expect(calls.indexOf('syncAgentBlock:null')).toBeGreaterThan(calls.indexOf('killPrivateAgent'));
      expect(calls.indexOf('appAgent.shutdown')).toBeGreaterThan(calls.indexOf('syncAgentBlock:null'));
    });
  });

  describe('dispose waits for card eviction', () => {
    it('does not shut the app agent down before a pending unloadCard has finished', async () => {
      const calls: string[] = [];
      const { coordinator } = build(calls);
      let finishUnload!: () => void;
      vi.spyOn(AgentLifecycleManager, 'unloadCard').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishUnload = () => {
              calls.push('unloadCard:done');
              resolve();
            };
          })
      );
      vi.spyOn(AgentLifecycleManager, 'killPrivateAgent').mockImplementation(() => {});
      (coordinator as any).smartcardSessionAgents.set('sess-1', {
        pid: 0,
        socketPath: '\\\\.\\pipe\\openssh-ssh-agent',
        kind: 'pkcs11',
        pkcs11LibPath: LIB,
      });

      let disposed = false;
      const pending = coordinator.dispose().then(() => {
        disposed = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(disposed).toBe(false);
      expect(calls).not.toContain('appAgent.shutdown');

      finishUnload();
      await pending;
      expect(calls.indexOf('appAgent.shutdown')).toBeGreaterThan(calls.indexOf('unloadCard:done'));
    });
  });

  it('lists the session agents without exposing the entries', () => {
    const { coordinator } = build();
    (coordinator as any).smartcardSessionAgents.set('a', { pid: 1, socketPath: '/tmp/a.sock', kind: 'fido2' });
    expect(coordinator.listSessionAgents()).toEqual([{ kind: 'fido2', socketPath: '/tmp/a.sock' }]);
  });

  describe('constructor wiring of the app agent', () => {
    it('routes the agent\'s own PIN prompts to the renderer with the "App ssh-agent" context', async () => {
      const setHandlers = vi.spyOn(AppAgent.prototype, 'setHandlers').mockImplementation(() => {});
      vi.spyOn(AppAgent.prototype, 'setOnExit').mockImplementation(() => {});
      const deps = makeDeps();
      new SmartcardCoordinator(deps);

      const handlers = setHandlers.mock.calls[0][0] as any;
      await handlers.promptHandler('Enter PIN for authenticator ED25519-SK  ', undefined);

      expect(deps.promptForPin).toHaveBeenCalledWith('Enter PIN for authenticator ED25519-SK', 'fido2', 'App ssh-agent', undefined);
    });

    it('shows and auto-clears a touch banner when the agent asks for presence', () => {
      vi.useFakeTimers();
      const setHandlers = vi.spyOn(AppAgent.prototype, 'setHandlers').mockImplementation(() => {});
      vi.spyOn(AppAgent.prototype, 'setOnExit').mockImplementation(() => {});
      const requested = vi.fn();
      const cleared = vi.fn();
      const deps = makeDeps();
      (deps.makePresenceNotifier as any).mockReturnValue({ onPresenceRequested: requested, onPresenceCleared: cleared });
      new SmartcardCoordinator(deps);

      (setHandlers.mock.calls[0][0] as any).onPresence();
      expect(requested).toHaveBeenCalledTimes(1);
      expect(cleared).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20_000);
      expect(cleared).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('forgets all cards and refreshes the ssh config block when the agent exits', async () => {
      vi.spyOn(AppAgent.prototype, 'setHandlers').mockImplementation(() => {});
      const setOnExit = vi.spyOn(AppAgent.prototype, 'setOnExit').mockImplementation(() => {});
      const calls: string[] = [];
      const deps = makeDeps(calls);
      const coordinator = new SmartcardCoordinator(deps);
      (coordinator as any).globalCards.set(LIB, { fingerprints: new Set() });
      (coordinator as any).globalSmartcardCerts.set(LIB, new Map());

      (setOnExit.mock.calls[0][0] as () => void)();
      await (coordinator as any).agentConfigRefresh;

      expect((coordinator as any).globalCards.size).toBe(0);
      expect((coordinator as any).globalSmartcardCerts.size).toBe(0);
      expect(deps.syncAgentBlock).toHaveBeenCalled();
    });
  });

  describe('getUnlockedCardSocket', () => {
    it('answers undefined, without starting the agent, for a card that is not unlocked', async () => {
      const { coordinator, agent } = build();
      await expect(coordinator.getUnlockedCardSocket(LIB)).resolves.toBeUndefined();
      expect(agent.ensure).not.toHaveBeenCalled();
    });

    it('re-checks after ensure(): an agent that had to be restarted lost its cards', async () => {
      const { coordinator, agent } = build();
      await coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => '123456');
      // ensure() restarting a dead agent triggers onExit, which clears the card state.
      agent.ensure.mockImplementationOnce(async () => {
        (coordinator as any).globalCards.clear();
        return '/run/sshs3/new-agent.sock';
      });

      await expect(coordinator.getUnlockedCardSocket(LIB)).resolves.toBeUndefined();
    });
  });

  describe('load cooldown', () => {
    it('ends after 30 seconds', async () => {
      const { coordinator, agent } = build();
      agent.addPkcs11.mockRejectedValueOnce(new Error('wrong PIN'));
      await expect(coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'bad')).rejects.toThrow('wrong PIN');
      expect(coordinator.isInLoadCooldown(LIB)).toBe(true);

      const realNow = Date.now;
      vi.spyOn(Date, 'now').mockReturnValue(realNow() + 31_000);
      expect(coordinator.isInLoadCooldown(LIB)).toBe(false);
      await expect(coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => 'good')).resolves.toBe('/run/sshs3/agent.sock');
    });

    it('is tracked separately for the FIDO2 key and for each card', () => {
      const { coordinator } = build();
      expect(coordinator.isInLoadCooldown(LIB)).toBe(false);
      (coordinator as any).globalSmartcardAgentFailures.set('__fido2__', Date.now());
      expect(coordinator.isInLoadCooldown('__fido2__')).toBe(true);
      expect(coordinator.isInLoadCooldown(LIB)).toBe(false);
    });
  });

  describe('after dispose', () => {
    it('does not respawn the app agent for a prompt that resolves during quit, and writes no agent block', async () => {
      const { coordinator, agent, deps } = build();
      let release!: () => void;
      agent.addPkcs11.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
      const pending = coordinator.getOrLoadGlobalSmartcardAgent(LIB, async () => '123456');
      await vi.waitFor(() => expect(agent.addPkcs11).toHaveBeenCalledTimes(1));

      await coordinator.dispose();
      agent.ensure.mockClear();
      (deps.syncAgentBlock as any).mockClear();
      release();

      await expect(pending).rejects.toThrow(/disposed/);
      expect(agent.ensure).not.toHaveBeenCalled();
      coordinator.refreshAgentSshConfig();
      await (coordinator as any).agentConfigRefresh;
      expect(deps.syncAgentBlock).not.toHaveBeenCalled();
    });
  });

  describe('prepareSshCaConfig / prepareSftpSshCaConfig', () => {
    it('sets agentPath and attaches active certificateFile for agent profiles with useSshCa', async () => {
      const { coordinator } = build();
      const mockCaService = {
        getActiveCertificateFilePath: vi.fn().mockReturnValue('/tmp/certs/piv-cert.pub'),
      } as any;
      coordinator.setSshCaService(mockCaService);

      const sshConfig: SSHConnectionConfig = {
        id: 'cfg-1',
        name: 'CA Target',
        host: 'ca.example.com',
        username: 'alun',
        authType: 'agent',
        useSshCa: true,
      };

      const prepared = await coordinator.prepareSshCaConfig(sshConfig);
      expect(prepared.agentPath).toBe('/run/sshs3/agent.sock');
      expect(prepared.certificateFile).toBe('/tmp/certs/piv-cert.pub');

      const sftpConfig: SFTPConfig = {
        id: 'cfg-sftp',
        name: 'CA SFTP Target',
        host: 'sftp.example.com',
        port: 22,
        username: 'alun',
        authType: 'agent',
        useSshCa: true,
      };

      const preparedSftp = await coordinator.prepareSftpSshCaConfig(sftpConfig);
      expect(preparedSftp.agentPath).toBe('/run/sshs3/agent.sock');
      expect(preparedSftp.certificateFile).toBe('/tmp/certs/piv-cert.pub');
    });

    it('leaves configs untouched when useSshCa is false or authType is not agent', async () => {
      const { coordinator } = build();
      const sshConfig: SSHConnectionConfig = {
        id: 'cfg-2',
        name: 'Plain Key',
        host: 'server.example.com',
        username: 'alun',
        authType: 'privateKey',
        privateKeyPath: '/home/alun/.ssh/id_rsa',
      };

      const prepared = await coordinator.prepareSshCaConfig(sshConfig);
      expect(prepared).toBe(sshConfig);
    });

    describe('with a PIV card also unlocked in the app agent', () => {
      const PIV_PUB = '/run/sshs3/keys/piv.pub';
      const sshCaProfile: SSHConnectionConfig = {
        id: 'cfg-3', name: 'CA Target', host: 'ca.example.com', username: 'alun', authType: 'agent', useSshCa: true,
      };
      const sftpCaProfile: SFTPConfig = {
        id: 'cfg-4', name: 'CA SFTP', host: 'sftp.example.com', port: 22, username: 'alun', authType: 'agent', useSshCa: true,
      };

      function withUnlockedPivCard(certFile: string | undefined) {
        const { coordinator, agent } = build();
        (agent as any).writePublicKeyFiles = vi.fn().mockResolvedValue([PIV_PUB]);
        (coordinator as any).globalCards.set(LIB, { fingerprints: new Set(['SHA256:piv']) });
        coordinator.setSshCaService({ getActiveCertificateFilePath: vi.fn().mockReturnValue(certFile) } as any);
        return coordinator;
      }

      it('pins a PIV session to the card key (IdentitiesOnly + its public key file)', async () => {
        const coordinator = withUnlockedPivCard('/run/sshs3/certs/piv-cert.pub');

        const ssh = await coordinator.prepareSshCaConfig(sshCaProfile);
        const sftp = await coordinator.prepareSftpSshCaConfig(sftpCaProfile);

        expect(ssh.agentIdentityFiles).toEqual([PIV_PUB]);
        expect(ssh.certificateFile).toBe('/run/sshs3/certs/piv-cert.pub');
        expect(sftp.agentIdentityFiles).toEqual([PIV_PUB]);
      });

      it('does not pin an ephemeral-key session, so its certified key in the agent stays offered', async () => {
        const coordinator = withUnlockedPivCard(undefined);

        const ssh = await coordinator.prepareSshCaConfig(sshCaProfile);
        const sftp = await coordinator.prepareSftpSshCaConfig(sftpCaProfile);

        expect(ssh.agentIdentityFiles).toBeUndefined();
        expect(ssh.agentPath).toBe('/run/sshs3/agent.sock');
        expect(sftp.agentIdentityFiles).toBeUndefined();
      });
    });
  });
});
