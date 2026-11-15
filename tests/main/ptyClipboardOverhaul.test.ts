import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import type { IPty, IDisposable } from 'node-pty';
import type { SSHConnectionConfig } from '../../src/shared/types/ssh';

const { mockIsEncryptionAvailable, mockEncryptString, mockPtyInstances } = vi.hoisted(() => ({
  mockIsEncryptionAvailable: vi.fn().mockReturnValue(true),
  mockEncryptString: vi.fn((v: string) => Buffer.from(`cipher:${v}`, 'utf-8')),
  mockPtyInstances: [] as any[],
}));

vi.mock('electron', () => {
  const mockObj = {
    app: { getPath: () => os.tmpdir() },
    safeStorage: {
      isEncryptionAvailable: mockIsEncryptionAvailable,
      encryptString: mockEncryptString,
      decryptString: (b: Buffer) => b.toString('utf-8').replace(/^cipher:/, ''),
    },
  };
  return { ...mockObj, default: mockObj };
});

vi.mock('../../src/main/ssh/AgentLifecycleManager', () => ({
  AgentLifecycleManager: {
    ensureAgent: vi.fn().mockResolvedValue({ isRunning: false, isManaged: false, platform: process.platform }),
  },
}));

class MockPty implements Partial<IPty> {
  pid = 43210;
  cols = 80;
  rows = 24;
  process = 'ssh';
  handleFlowControl = false;

  private dataListeners: ((data: string) => void)[] = [];
  private exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  write = vi.fn();
  resize = vi.fn((cols: number, rows: number) => {
    this.cols = cols;
    this.rows = rows;
  });
  kill = vi.fn((signal?: string) => {
    this.emitExit(0, signal ? 15 : undefined);
  });
  clear = vi.fn();
  pause = vi.fn();
  resume = vi.fn();

  onData = vi.fn((listener: (data: string) => void): IDisposable => {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.dataListeners.indexOf(listener);
        if (index >= 0) this.dataListeners.splice(index, 1);
      },
    };
  });

  onExit = vi.fn(
    (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
      this.exitListeners.push(listener);
      return {
        dispose: () => {
          const index = this.exitListeners.indexOf(listener);
          if (index >= 0) this.exitListeners.splice(index, 1);
        },
      };
    }
  );

  emitData(data: string) {
    for (const listener of [...this.dataListeners]) {
      listener(data);
    }
  }

  emitExit(exitCode: number, signal?: number) {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode, signal });
    }
  }
}

vi.mock('node-pty', () => {
  const spawn = vi.fn((file: string, args: string[] | string, options: any) => {
    const mock = new MockPty();
    (mock as any)._spawnArgs = { file, args, options };
    mockPtyInstances.push(mock);
    return mock as unknown as IPty;
  });
  return {
    default: { spawn },
    spawn,
  };
});

import {
  SSHPtyManager,
  InternalSSHPtySession,
  CONPTY_WRITE_CHUNK_BYTES,
  DEFAULT_SERVER_ALIVE_INTERVAL,
  DEFAULT_SERVER_ALIVE_COUNT_MAX,
  applySshKeepaliveDefaults,
  splitConPtyChunks,
  writeChunked,
} from '../../src/main/ssh/SSHPtyManager';
import {
  TerminalRegistry,
  atShellPrompt,
} from '../../src/main/ai/hub/TerminalRegistry';
import {
  CommandFrames,
  buildHandshakeCommand,
  commandEnvelope,
  detectShellFromHint,
  getShellAdapterCapabilities,
  parseOscMarkers,
} from '../../src/main/ai/hub/shellAdapters';
import {
  ClipboardHistoryStore,
  DEFAULT_CLIPBOARD_SECRET_TTL_MS,
  classifyClipboardSecret,
} from '../../src/main/clipboard/ClipboardHistoryStore';
import { SmartcardDetector } from '../../src/main/smartcard/SmartcardDetector';

describe('ptyClipboardOverhaul', () => {
  describe('SSHPtyManager ConPTY chunking, keepalives, reconnect grace & observer sharing', () => {
    let manager: SSHPtyManager;

    beforeEach(() => {
      mockPtyInstances.length = 0;
      manager = new SSHPtyManager();
    });

    afterEach(async () => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await manager.killAll();
    });

    it('splits data into <=512-byte ConPTY chunks without breaking surrogate pairs or multi-byte UTF-8', () => {
      const payload = '😀'.repeat(200) + '\x1b[31mhello\x1b[0m'; // each emoji is 4 UTF-8 bytes, 2 UTF-16 code units
      const chunks = splitConPtyChunks(payload, CONPTY_WRITE_CHUNK_BYTES);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join('')).toBe(payload);
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(CONPTY_WRITE_CHUNK_BYTES);
        // No dangling surrogates
        expect(Buffer.from(chunk, 'utf8').toString('utf8')).toBe(chunk);
      }
    });

    it('writes large payloads in 512-byte chunks via writeChunked and manager.writeChunked', async () => {
      const written: string[] = [];
      const big = 'A'.repeat(1300);
      await writeChunked((c) => written.push(c), big, { delayMs: 0 });
      expect(written).toEqual(['A'.repeat(512), 'A'.repeat(512), 'A'.repeat(276)]);

      const session = await manager.createSession({
        id: 'chunk-sess',
        name: 'Chunk Host',
        host: 'chunk.example.com',
        username: 'ops',
        authType: 'password',
      });
      const mockPty = mockPtyInstances[0];
      await manager.writeChunked(session.sessionId, big, { delayMs: 0 });
      expect(mockPty.write).toHaveBeenCalledTimes(3);
      expect(mockPty.write.mock.calls.map((c: any[]) => c[0]).join('')).toBe(big);
    });

    it('automatically chunks >512B writes on win32 in InternalSSHPtySession.write', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const session = (await manager.createSession({
          id: 'win-chunk',
          name: 'Win Chunk',
          host: 'win.example.com',
          username: 'ops',
          authType: 'password',
        })) as InternalSSHPtySession;
        const mockPty = mockPtyInstances[0];
        const largePaste = 'echo ' + 'x'.repeat(1100);
        session.write(largePaste);
        await new Promise((r) => setTimeout(r, 30));
        expect(mockPty.write.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(mockPty.write.mock.calls.map((c: any[]) => c[0]).join('')).toBe(largePaste);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });

    it('applies ServerAliveInterval=30 and ServerAliveCountMax=3 by default on SSH spawns and respects overrides', async () => {
      const baseConfig: SSHConnectionConfig = {
        id: 'ka-default',
        name: 'Keepalive Default',
        host: 'ka.example.com',
        username: 'ops',
        authType: 'password',
      };
      await manager.createSession(baseConfig);
      const { args: defaultArgs } = mockPtyInstances[0]._spawnArgs;
      expect(defaultArgs).toContain(`ServerAliveInterval=${DEFAULT_SERVER_ALIVE_INTERVAL}`);
      expect(defaultArgs).toContain(`ServerAliveCountMax=${DEFAULT_SERVER_ALIVE_COUNT_MAX}`);

      const custom = applySshKeepaliveDefaults({
        ...baseConfig,
        serverAliveInterval: 15,
        extraOptions: { serveralivecountmax: '5' },
      });
      expect(custom.serverAliveInterval).toBe(15);
      expect(custom.extraOptions?.serveralivecountmax).toBe('5');
      expect(custom.extraOptions?.ServerAliveCountMax).toBeUndefined();
    });

    it('tracks reconnecting grace state metadata and restores connected state on reconnect', async () => {
      vi.useFakeTimers();
      const session = (await manager.createSession({
        id: 'grace-sess',
        name: 'Grace Host',
        host: 'grace.example.com',
        username: 'ops',
        authType: 'password',
        autoReconnect: true,
        maxReconnectAttempts: 2,
        reconnectDelayMs: 500,
      })) as InternalSSHPtySession;

      expect(session.getConnectionState()).toBe('connected');
      expect(manager.getSessionState('grace-sess')).toBe('connected');

      mockPtyInstances[0].emitExit(255);
      expect(session.getConnectionState()).toBe('reconnecting');
      const grace = manager.getSessionReconnectState('grace-sess');
      expect(grace).toMatchObject({
        state: 'reconnecting',
        attempt: 1,
        maxAttempts: 2,
      });
      expect(grace?.startedAt).toBeTypeOf('number');
      expect(grace?.graceUntil).toBeGreaterThanOrEqual(grace!.startedAt!);

      await vi.advanceTimersByTimeAsync(550);
      expect(session.getConnectionState()).toBe('connected');
      expect(manager.getSessionReconnectState('grace-sess')?.state).toBe('connected');
    });

    it('enforces read-only observer vs interactive peer sharing and fans out PTY output', async () => {
      await manager.createSession({
        id: 'share-sess',
        name: 'Shared Host',
        host: 'shared.example.com',
        username: 'ops',
        authType: 'password',
      });
      const mockPty = mockPtyInstances[0];
      const shareEvents: any[] = [];
      const fanoutEvents: any[] = [];
      const blockedEvents: any[] = [];
      manager.on('share-changed', (e) => shareEvents.push(e));
      manager.on('fanout-data', (e) => fanoutEvents.push(e));
      manager.on('observer-input-blocked', (e) => blockedEvents.push(e));

      const obsChunks: string[] = [];
      const peerChunks: string[] = [];
      const observer = manager.attachShareClient(
        'share-sess',
        { clientId: 'c-obs', actor: 'bob', role: 'observer' },
        (d) => obsChunks.push(d)
      )!;
      const peer = manager.attachShareClient(
        'share-sess',
        { clientId: 'c-peer', actor: 'alice', role: 'peer' },
        (d) => peerChunks.push(d)
      )!;

      const meta = manager.getSessionShareMetadata('share-sess')!;
      expect(meta.sharingEnabled).toBe(true);
      expect(meta.observerCount).toBe(1);
      expect(meta.peerCount).toBe(1);
      expect(shareEvents.length).toBeGreaterThanOrEqual(2);

      // Output fans out to both observer and peer
      mockPty.emitData('top output\r\n');
      expect(obsChunks).toEqual(['top output\r\n']);
      expect(peerChunks).toEqual(['top output\r\n']);
      expect(fanoutEvents).toHaveLength(1);
      expect(fanoutEvents[0].participants).toHaveLength(2);

      // Read-only observer cannot write; interactive peer can write
      expect(observer.write('rm -rf /\n')).toBe(false);
      expect(mockPty.write).not.toHaveBeenCalled();
      expect(blockedEvents).toEqual([
        { sessionId: 'share-sess', clientId: 'c-obs', actor: 'bob' },
      ]);

      expect(peer.write('uptime\n')).toBe(true);
      expect(mockPty.write).toHaveBeenCalledWith('uptime\n');

      // Promoting observer to peer allows input
      manager.setShareParticipantRole('share-sess', 'c-obs', 'peer');
      expect(manager.writeFromClient('share-sess', 'c-obs', 'whoami\n')).toBe(true);
      expect(mockPty.write).toHaveBeenCalledWith('whoami\n');

      observer.dispose();
      peer.dispose();
      expect(manager.getSessionShareMetadata('share-sess')?.sharingEnabled).toBe(false);
    });
  });

  describe('TerminalRegistry & shellAdapters OSC 133, shell parity, reconnect grace & observer status', () => {
    const registries: TerminalRegistry[] = [];

    afterEach(() => {
      for (const r of registries.splice(0)) r.dispose();
    });

    it('parses OSC 133 prompt/command/exit markers and OSC 7 / OSC 9;9 CWD sequences', () => {
      const parsed = parseOscMarkers(
        '\x1b]7;file://web-01/var/log%20app\x07\x1b]133;A\x07starship> \x1b]133;B\x07'
      );
      expect(parsed.lastPhase).toBe('B');
      expect(parsed.promptActive).toBe(true);
      expect(parsed.cwd).toBe('/var/log app');

      const winCwd = parseOscMarkers('\x1b]9;9;C:\\Users\\ops\\proj\x1b\\\x1b]133;C\x07');
      expect(winCwd.cwd).toBe('C:\\Users\\ops\\proj');
      expect(winCwd.lastPhase).toBe('C');
      expect(winCwd.promptActive).toBe(false);

      const done = parseOscMarkers('\x1b]133;D;42\x07\x1b]133;A\x07');
      expect(done.lastExitCode).toBe(42);
      expect(done.lastPhase).toBe('A');
      expect(done.promptActive).toBe(true);
    });

    it('uses OSC 133 markers in atShellPrompt and CommandFrames lateOutput', () => {
      // Custom Starship/Powerline prompt without traditional $, #, %, >
      expect(atShellPrompt('\x1b]133;A\x07λ ~/repo (main)\x1b]133;B\x07')).toBe(true);
      // Command actively running (phase C) is NOT at prompt
      expect(atShellPrompt('\x1b]133;C\x07running...')).toBe(false);
      // Virtualenv PowerShell prompt
      expect(atShellPrompt('(venv) PS C:\\Projects\\app> ')).toBe(true);

      const nonce = '0123456789abcdef0123456789abcdef';
      const frames = new CommandFrames(nonce, 128_000, {
        command: 'echo hi',
        shell: 'zsh',
        lateOutput: { prompt: 'old-prompt%' },
      });
      expect(frames.feed(`\x1b]777;SSHS3;${nonce};BEGIN\x07\x1b]777;SSHS3;${nonce};END;0;/tmp\x07`)).toBeUndefined();
      // Prompt changed dynamically (git branch), but OSC 133 A...B reveals exact boundary
      const settled = frames.feed('hi\r\n\x1b]133;A\x07zsh (feat)* %\x1b]133;B\x07 ');
      expect(settled).toEqual({ output: 'hi\r\n', exitCode: 0, cwd: '/tmp' });
    });

    it('provides shell adapter parity across powershell, pwsh, cmd, zsh, bash, and fish', () => {
      expect(getShellAdapterCapabilities('pwsh')).toMatchObject({
        family: 'powershell',
        supportsOsc133: true,
        usesStructuredDataFrames: true,
        handshakeCommand: '$null',
      });
      expect(getShellAdapterCapabilities('cmd')).toMatchObject({
        family: 'cmd',
        supportsOsc133: false,
        handshakeCommand: 'ver >nul',
      });
      expect(getShellAdapterCapabilities('zsh')).toMatchObject({
        family: 'posix',
        supportsOsc133: true,
        supportsSubshellIsolation: true,
        handshakeCommand: ':',
      });
      expect(buildHandshakeCommand('fish')).toBe('true');

      expect(detectShellFromHint({ label: 'zsh (prod)', kind: 'ssh' })).toBe('zsh');
      expect(detectShellFromHint({ output: 'Windows PowerShell\r\nPS C:\\Users\\a> ', kind: 'local', platform: 'win32' })).toBe('powershell');
      expect(detectShellFromHint({ shellBinary: 'pwsh.exe', kind: 'local', platform: 'win32' })).toBe('pwsh');
      expect(detectShellFromHint({ output: 'C:\\Windows\\system32>', kind: 'local', platform: 'win32' })).toBe('cmd');

      const nonce = 'fedcba9876543210fedcba9876543210';
      expect(commandEnvelope('zsh', 'echo ok', nonce)).toContain('SSHS3;');
      expect(commandEnvelope('powershell', 'Write-Output ok', nonce)).toContain('$null -ne $LASTEXITCODE');
      expect(commandEnvelope('cmd', 'echo ok', nonce)).toContain('$env:_sshs3_rc -match');
    });

    it('preserves reconnecting grace metadata, OSC 133 failure/CWD tracking, and exposes active shell + observer info', async () => {
      const reg = new TerminalRegistry();
      registries.push(reg);

      reg.register({ id: 't1', label: 'zsh@app-01', kind: 'ssh' }, (data) => {
        const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
        if (n) {
          queueMicrotask(() =>
            reg.feed('t1', `\x1b]777;SSHS3;${n};BEGIN\x07\x1b]777;SSHS3;${n};END;0;/srv/app\x07`)
          );
        }
      });

      // OSC 133 prompt + CWD updates state even with custom prompt
      reg.feed('t1', '\x1b]7;file://app-01/srv/app\x07\x1b]133;A\x07➜\x1b]133;B\x07 ');
      const ready = await reg.ensureReady('t1');
      expect(ready.shell).toBe('zsh');
      expect(ready.cwd).toBe('/srv/app');

      // Simulate an active command interrupted by SSH drop -> reconnecting grace preserves shell & cwd
      reg.claim('t1', ready.generation, 'run-1');
      const hangingReg = new TerminalRegistry();
      registries.push(hangingReg);
      hangingReg.register({ id: 't2', label: 'prod-db', kind: 'ssh', shell: 'bash' }, () => {});
      hangingReg.feed('t2', '\x1b]7;file://prod-db/var/lib/pgsql\x07$ ');
      await Promise.resolve();
      // Arm manually via feed
      const armedPromise = hangingReg.arm('t2', 'bash');
      const execRejects = expect(armedPromise).rejects.toThrow(/reconnect grace period/);
      const grace = hangingReg.markReconnecting('t2', { attempt: 1, maxAttempts: 3, reason: 'network drop' });
      await execRejects;

      expect(grace.reconnecting).toBe(true);
      expect(grace.previousShell).toBe('bash');
      expect(grace.previousCwd).toBe('/var/lib/pgsql');
      expect(hangingReg.isReconnecting('t2')).toBe(true);
      expect(hangingReg.get('t2')?.state).toBe('unknown');

      hangingReg.setObserverStatus('t2', [
        { clientId: 'c1', actor: 'alice', role: 'owner', joinedAt: 100 },
        { clientId: 'c2', actor: 'bob', role: 'observer', joinedAt: 200 },
      ]);

      const info = hangingReg.getActiveShellInfo('t2')!;
      expect(info.reconnecting).toBe(true);
      expect(info.shell).toBe('bash');
      expect(info.cwd).toBe('/var/lib/pgsql');
      expect(info.adapter?.family).toBe('posix');
      expect(info.observers.observerCount).toBe(1);
      expect(info.observers.peerCount).toBe(0);
      expect(hangingReg.listActiveShellInfo()).toHaveLength(1);

      const restored = hangingReg.markReconnected('t2');
      expect(hangingReg.isReconnecting('t2')).toBe(false);
      expect(restored.shell).toBe('bash');
      expect(restored.cwd).toBe('/var/lib/pgsql');

      // OSC 133;D non-zero records failure, OSC 133;D;0 clears
      reg.observeHumanInput('t1', 'systemctl restart nginx\r');
      reg.feed('t1', '\x1b]133;D;3\x07');
      expect(reg.failures().t1?.exitCode).toBe(3);
      reg.feed('t1', '\x1b]133;D\x07');
      expect(reg.failures().t1).toBeUndefined();
    });
  });

  describe('ClipboardHistoryStore secret hygiene (high-entropy & pattern TTL + redaction)', () => {
    let tempDir: string;
    let file: string;

    beforeEach(async () => {
      mockIsEncryptionAvailable.mockReturnValue(true);
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-clip-overhaul-'));
      file = path.join(tempDir, 'clipboard-history.json');
    });

    afterEach(async () => {
      vi.useRealTimers();
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('classifies pattern secrets and high-entropy tokens while sparing normal commands and UUIDs', () => {
      expect(classifyClipboardSecret('kubectl get pods -n prod')).toEqual({
        sensitive: false,
        redactedPreview: 'kubectl get pods -n prod',
      });
      expect(classifyClipboardSecret('550e8400-e29b-41d4-a716-446655440000').sensitive).toBe(false);

      const pat = classifyClipboardSecret('OPENAI_API_KEY=sk-proj-abc123def456ghi789');
      expect(pat.sensitive).toBe(true);
      expect(pat.reason).toBe('pattern');
      expect(pat.redactedPreview).not.toContain('sk-proj-abc123def456ghi789');
      expect(pat.redactedPreview).toContain('[redacted]');

      const ent = classifyClipboardSecret('a9Z_k3Lm8Qp2Rs7Tv1Wx4Yz6Bc9Df2Gh5Jk');
      expect(ent.sensitive).toBe(true);
      expect(ent.reason).toBe('high-entropy');
      expect(ent.redactedPreview).toBe('[redacted]');
    });

    it('marks sensitive copies with redacted preview and short TTL, auto-purging after expiry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-14T12:00:00.000Z'));

      const store = new ClipboardHistoryStore({ customPath: file, secretTtlMs: DEFAULT_CLIPBOARD_SECRET_TTL_MS });
      await store.add('ls -la /var/log', 'h1', 'Host 1');
      await store.add('ghp_1234567890abcdef1234567890abcdef1234', 'h1', 'Host 1');

      const initial = await store.list();
      expect(initial).toHaveLength(2);
      const secretEntry = initial[0];
      expect(secretEntry.sensitive).toBe(true);
      expect(secretEntry.redactedPreview).toBe('[redacted]');
      expect(secretEntry.expiresAt).toBeDefined();
      expect(initial[1].sensitive).toBeUndefined();

      // Advance past 20s TTL -> secret auto-purged, normal entry preserved
      vi.advanceTimersByTime(DEFAULT_CLIPBOARD_SECRET_TTL_MS + 1000);
      const afterTtl = await store.list();
      expect(afterTtl.map((e) => e.text)).toEqual(['ls -la /var/log']);

      // Verify reopened store also stays clean
      const reopened = new ClipboardHistoryStore({ customPath: file });
      expect((await reopened.list()).map((e) => e.text)).toEqual(['ls -la /var/log']);
    });

    it('drops secrets completely when secretPolicy is set to filter', async () => {
      const store = new ClipboardHistoryStore({ customPath: file, secretPolicy: 'filter' });
      await store.add('AKIAIOSFODNN7EXAMPLE', 'h1', 'Host 1');
      await store.add('systemctl status nginx', 'h1', 'Host 1');

      const entries = await store.list();
      expect(entries.map((e) => e.text)).toEqual(['systemctl status nginx']);
    });
  });

  describe('SmartcardDetector bounded timeouts and non-blocking probe cache', () => {
    beforeEach(() => {
      SmartcardDetector.clearCache();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      SmartcardDetector.clearCache();
    });

    it('never stalls when fs.stat hangs beyond timeoutMs', async () => {
      const statSpy = vi.spyOn(fs, 'stat').mockImplementation(() => new Promise(() => {}));
      const started = Date.now();
      const valid = await SmartcardDetector.validateLibraryPath('/mnt/hung-nfs/opensc.so', {
        timeoutMs: 40,
        cacheTtlMs: 0,
      });
      expect(valid).toBe(false);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(statSpy).toHaveBeenCalledTimes(1);
    });

    it('caches detection results, deduplicates in-flight probes, and supports non-blocking stale reads', async () => {
      const statSpy = vi.spyOn(fs, 'stat').mockRejectedValue(new Error('ENOENT'));
      const customPaths = [{ name: 'MockSC', path: '/tmp/nonexistent-sc.so', platform: 'linux' as const }];

      // Concurrent calls share a single in-flight probe
      const [r1, r2] = await Promise.all([
        SmartcardDetector.detectAvailableLibraries('linux', { customPaths, timeoutMs: 100 }),
        SmartcardDetector.detectAvailableLibraries('linux', { customPaths, timeoutMs: 100 }),
      ]);
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(statSpy).toHaveBeenCalledTimes(1);

      // Cached read avoids re-probing
      await SmartcardDetector.detectAvailableLibraries('linux', { customPaths, timeoutMs: 100 });
      expect(statSpy).toHaveBeenCalledTimes(1);

      // Default platform cache exposes sync getCachedLibraries & nonBlocking stale refresh
      await SmartcardDetector.detectAvailableLibraries('linux', { cacheTtlMs: 1 });
      expect(SmartcardDetector.getCachedLibraries('linux')).toBeDefined();
      await new Promise((r) => setTimeout(r, 10));
      const callsBefore = statSpy.mock.calls.length;
      const nonBlocking = await SmartcardDetector.detectAvailableLibraries('linux', {
        nonBlocking: true,
        cacheTtlMs: 1,
      });
      expect(nonBlocking.length).toBeGreaterThan(0);
      // Background refresh triggered asynchronously
      await new Promise((r) => setTimeout(r, 20));
      expect(statSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
