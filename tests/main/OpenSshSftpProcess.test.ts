import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { FXP } from '../../src/main/storage/sftp/SftpConstants';

const { mockSpawn, resetMockChild } = vi.hoisted(() => {
  let child: any = null;
  return {
    mockSpawn: vi.fn((_bin: string, _args: string[], _opts: any) => child),
    getMockChild: () => child,
    setMockChild: (c: any) => {
      child = c;
    },
    resetMockChild: () => {
      const c = new EventEmitter() as any;
      c.stdin = new PassThrough();
      c.stdout = new PassThrough();
      c.stderr = new PassThrough();
      c.kill = vi.fn();
      child = c;
      return c;
    },
  };
});

vi.mock('node:child_process', () => {
  return {
    spawn: mockSpawn,
    execFile: vi.fn(),
  };
});

vi.mock('../../src/main/smartcard/AskpassServer', () => {
  class MockAskpassServer {
    public start = vi.fn().mockResolvedValue(undefined);
    public stop = vi.fn().mockResolvedValue(undefined);
    public getEnv = vi.fn().mockReturnValue({ SSH_ASKPASS: '/tmp/askpass', SSH_ASKPASS_REQUIRE: 'force' });
  }
  return {
    AskpassServer: MockAskpassServer,
  };
});

import { OpenSshSftpProcess, resolveSshBinary, parseHostKeyPrompt } from '../../src/main/storage/sftp/OpenSshSftpProcess';

describe('OpenSshSftpProcess', () => {
  let mockChild: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = resetMockChild();
  });

  it('resolves correct ssh binary name', () => {
    const bin = resolveSshBinary();
    if (process.platform === 'win32') {
      expect(bin.endsWith('ssh.exe')).toBe(true);
    } else {
      expect(bin).toBe('ssh');
    }
  });

  it('spawns ssh with sftp subsystem arguments and initializes protocol', async () => {
    const proc = new OpenSshSftpProcess();

    const startPromise = proc.start({
      config: {
        id: 'test-1',
        host: 'myserver.com',
        port: 22,
        username: 'alice',
        authType: 'password',
        password: 'secretpassword', // pragma: allowlist secret
      },
    });

    // Simulate child sending VERSION 3 response
    setTimeout(() => {
      const resp = Buffer.alloc(9);
      resp.writeUInt32BE(5, 0);
      resp.writeUInt8(FXP.VERSION, 4);
      resp.writeUInt32BE(3, 5);
      mockChild.stdout.write(resp);
    }, 10);

    const protocol = await startPromise;
    expect(protocol).toBeDefined();

    // Subsystem name must come after the destination: `ssh ... -s -- user@host sftp`
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs.slice(-5)).toEqual(['BatchMode=no', '-s', '--', 'alice@myserver.com', 'sftp']);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/ssh(\.exe)?$/),
      expect.arrayContaining(['-o', 'BatchMode=no']),
      expect.objectContaining({
        env: expect.objectContaining({
          SSH_ASKPASS: '/tmp/askpass',
        }),
      })
    );

    await proc.close();
    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it.skipIf(process.platform === 'win32')(
    'shares a given control socket and leaves it in place on close',
    async () => {
      const { default: fs } = await import('node:fs');
      const { default: os } = await import('node:os');
      const { default: path } = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-test-'));
      const socket = path.join(dir, 'terminal.sock');
      fs.writeFileSync(socket, '');
      try {
        const proc = new OpenSshSftpProcess();
        const startPromise = proc.start({
          config: {
            id: 't',
            host: 'myserver.com',
            port: 22,
            username: 'alice',
            authType: 'password',
            password: 'x', // pragma: allowlist secret
            tunnels: [{ id: 'tn', type: 'local', localPort: 8443, remoteHost: 'localhost', remotePort: 443 }],
          } as any,
          controlPath: socket,
        });
        setTimeout(() => {
          const resp = Buffer.alloc(9);
          resp.writeUInt32BE(5, 0);
          resp.writeUInt8(FXP.VERSION, 4);
          resp.writeUInt32BE(3, 5);
          mockChild.stdout.write(resp);
        }, 10);
        await startPromise;
        const args = mockSpawn.mock.calls[0][1] as string[];
        expect(args).toContain(`ControlPath=${socket}`);
        // saved tunnels must not ride along: a mux client's -L is refused and ssh then re-authenticates
        expect(args).not.toContain('-L');
        await proc.close();
        expect(fs.existsSync(socket)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('removes its control dir and stops askpass when building the ssh arguments throws, and can start again', async () => {
    const { SmartcardDetector } = await import('../../src/main/smartcard/SmartcardDetector');
    const { default: fs } = await import('node:fs');
    const { default: os } = await import('node:os');
    const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('s3m-sftp-')).length;
    const before = leftovers();
    const buildSpy = vi.spyOn(SmartcardDetector, 'buildSSHArguments').mockImplementationOnce(() => {
      throw new Error('bad config');
    });

    const proc = new OpenSshSftpProcess();
    const config = {
      id: 'test-cleanup',
      host: 'myserver.com',
      port: 22,
      username: 'alice',
      authType: 'password' as const,
      password: 'secretpassword', // pragma: allowlist secret
    };
    await expect(proc.start({ config })).rejects.toThrow('bad config');
    expect(leftovers()).toBe(before);
    expect(mockSpawn).not.toHaveBeenCalled();

    // The same instance must be able to start (and later close) again.
    const second = proc.start({ config });
    setTimeout(() => {
      const resp = Buffer.alloc(9);
      resp.writeUInt32BE(5, 0);
      resp.writeUInt8(FXP.VERSION, 4);
      resp.writeUInt32BE(3, 5);
      mockChild.stdout.write(resp);
    }, 10);
    await second;
    await proc.close();
    expect(mockChild.kill).toHaveBeenCalled();
    expect(leftovers()).toBe(before);
    buildSpy.mockRestore();
  });

  it('detects user presence prompt in stderr and triggers onPresence', async () => {
    const proc = new OpenSshSftpProcess();
    const onPresence = vi.fn();

    const startPromise = proc.start({
      config: {
        id: 'test-fido',
        host: 'fido.com',
        port: 22,
        username: 'bob',
        authType: 'fido2',
      },
      onPresence,
    });

    // Simulate stderr presence message
    mockChild.stderr.write('Confirm user presence for key ED25519-SK\n');

    setTimeout(() => {
      const resp = Buffer.alloc(9);
      resp.writeUInt32BE(5, 0);
      resp.writeUInt8(FXP.VERSION, 4);
      resp.writeUInt32BE(3, 5);
      mockChild.stdout.write(resp);
    }, 10);

    await startPromise;
    expect(onPresence).toHaveBeenCalledWith(expect.stringContaining('Confirm user presence'));
    await proc.close();
  });

  it('parses key type and fingerprint from the OpenSSH host key confirmation prompt', () => {
    const info = parseHostKeyPrompt(
      "The authenticity of host 'h (1.2.3.4)' can't be established.\nED25519 key fingerprint is SHA256:abc123+/=.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
      { host: 'h', port: 2222, username: 'u', authType: 'password' }
    );
    expect(info).toEqual({
      host: 'h',
      port: 2222,
      keyType: 'ED25519',
      fingerprint: 'SHA256:abc123+/=',
      status: 'unknown',
    });
  });

  it('parses the fingerprint when OpenSSH writes "fingerprint is:" and askpass joins lines with a marker', () => {
    const info = parseHostKeyPrompt(
      "The authenticity of host 'h (1.2.3.4)' can't be established. ⏎ ED25519 key fingerprint is: SHA256:WwJD+x5/zn0 ⏎ This key is not known by any other names. ⏎ Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
      { host: 'h', port: 22, username: 'u', authType: 'password' }
    );
    expect(info.keyType).toBe('ED25519');
    expect(info.fingerprint).toBe('SHA256:WwJD+x5/zn0');
  });

  it('names the host ssh asks about when it is a jump host, not the target', () => {
    const cfg = { host: 'target', port: 22, username: 'u', authType: 'password' } as const;
    const bastion = parseHostKeyPrompt(
      "The authenticity of host 'bastion (10.0.0.1)' can't be established.\nED25519 key fingerprint is: SHA256:b.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
      cfg
    );
    expect(bastion.host).toBe('bastion');
    expect(bastion.port).toBe(22);
    const bracketed = parseHostKeyPrompt("The authenticity of host '[bastion]:2222 ([10.0.0.1]:2222)' can't be established.", cfg);
    expect(bracketed).toMatchObject({ host: 'bastion', port: 2222 });
  });
});

describe('OpenSshSftpProcess exec / createExecStream', () => {
  let mockChild: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockChild = resetMockChild();
  });

  async function started(config: Record<string, unknown>, controlPath?: string) {
    const proc = new OpenSshSftpProcess();
    const startPromise = proc.start({ config: config as any, controlPath });
    setTimeout(() => {
      const resp = Buffer.alloc(9);
      resp.writeUInt32BE(5, 0);
      resp.writeUInt8(FXP.VERSION, 4);
      resp.writeUInt32BE(3, 5);
      mockChild.stdout.write(resp);
    }, 10);
    await startPromise;
    return proc;
  }

  const profile = {
    id: 'p',
    host: 'myserver.com',
    port: 2222,
    username: 'alice',
    authType: 'password',
    password: 'x', // pragma: allowlist secret
    proxy: { enabled: true, type: 'http', host: 'proxy.example.com', port: 3128, username: 'pu', password: 'pp' }, // pragma: allowlist secret
    agentPath: '/run/user/1000/agent.sock',
  };

  /** What execFile was called with, after making it answer. */
  function lastExecCall() {
    const call = vi.mocked(execFile).mock.calls.at(-1)!;
    return { args: call[1] as string[], options: call[2] as any };
  }
  function answerExec() {
    vi.mocked(execFile).mockImplementation(((_b: string, _a: string[], _o: any, cb: any) => {
      cb(null, 'out', '');
    }) as any);
  }

  it.skipIf(process.platform === 'win32')(
    'runs through a live control socket without ever opening a connection of its own',
    async () => {
      const { default: fs } = await import('node:fs');
      const { default: os } = await import('node:os');
      const { default: path } = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-test-'));
      const socket = path.join(dir, 'terminal.sock');
      fs.writeFileSync(socket, '');
      try {
        const proc = await started(profile, socket);
        answerExec();
        const result = await proc.exec('echo hi');
        expect(result.stdout.toString()).toBe('out');
        const { args } = lastExecCall();
        // A stale socket would otherwise make ssh connect to host:22 as the local user, past the proxy.
        expect(args).toEqual(['-S', socket, '-o', 'BatchMode=yes', '-o', 'ProxyCommand=false', '--', 'myserver.com', 'echo hi']);
        await proc.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('builds an independent connection from the profile when there is no control socket', async () => {
    const proc = await started(profile);
    answerExec();
    await proc.exec('echo hi');
    const { args, options } = lastExecCall();

    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('2222');
    expect(args.some((a) => a.startsWith('ProxyCommand='))).toBe(true);
    // Non-interactive, destination then command, in that order.
    expect(args.slice(-5)).toEqual(['-o', 'BatchMode=yes', '--', 'alice@myserver.com', 'echo hi']);
    // The environment the SFTP process itself gets: proxy credentials and the agent socket.
    expect(options.env.SSHS3_PROXY_USERNAME).toBe('pu');
    expect(options.env.SSHS3_PROXY_PASSWORD).toBe('pp'); // pragma: allowlist secret
    expect(options.env.SSH_AUTH_SOCK).toBe('/run/user/1000/agent.sock');
    if (process.platform !== 'win32') expect(options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    await proc.close();
  });

  it('gives createExecStream the same command line and environment', async () => {
    const proc = await started(profile);
    const execChild = new EventEmitter() as any;
    execChild.stdout = new PassThrough();
    execChild.stderr = new PassThrough();
    execChild.kill = vi.fn();
    mockSpawn.mockImplementationOnce(() => execChild);

    proc.createExecStream('tail -f x');
    const [, args, options] = mockSpawn.mock.calls.at(-1)! as [string, string[], any];
    expect(args.slice(-5)).toEqual(['-o', 'BatchMode=yes', '--', 'alice@myserver.com', 'tail -f x']);
    expect(args).toContain('-p');
    expect(options.env.SSHS3_PROXY_USERNAME).toBe('pu');
    expect(options.env.SSH_AUTH_SOCK).toBe('/run/user/1000/agent.sock');
    await proc.close();
  });

  it('reports a failed spawn on the stream instead of crashing the main process', async () => {
    const proc = await started(profile);
    const execChild = new EventEmitter() as any;
    execChild.stdout = new PassThrough();
    execChild.stderr = new PassThrough();
    execChild.kill = vi.fn();
    mockSpawn.mockImplementationOnce(() => execChild);

    const stream = proc.createExecStream('tail -f x');
    const failed = new Promise<Error>((resolve) => stream.on('error', resolve));
    // An EventEmitter with no 'error' listener throws here; that is the crash being guarded against.
    execChild.emit('error', new Error('spawn ssh ENOENT'));
    expect((await failed).message).toBe('spawn ssh ENOENT');
    await proc.close();
  });

  it.skipIf(process.platform === 'win32')(
    'asks the master first and uses an independent connection only when it is gone, never by retrying',
    async () => {
      const { default: fs } = await import('node:fs');
      const { default: os } = await import('node:os');
      const { default: path } = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshs3-test-'));
      const socket = path.join(dir, 'terminal.sock');
      fs.writeFileSync(socket, '');
      try {
        const proc = await started(profile, socket);
        const calls: string[][] = [];
        const isCheck = (args: string[]) => args.includes('-O');
        const answer = (masterAlive: boolean, runResult: { err?: unknown; stderr?: string } = {}) =>
          vi.mocked(execFile).mockImplementation(((_b: string, args: string[], _o: any, cb: any) => {
            calls.push(args);
            if (isCheck(args)) return cb(masterAlive ? null : Object.assign(new Error('no master'), { code: 255 }), '', '');
            cb(runResult.err ?? null, 'out', runResult.stderr ?? '');
          }) as any);

        // Master alive: the command goes through the socket, once.
        answer(true);
        await proc.exec('echo hi');
        expect(calls.map((c) => (isCheck(c) ? 'check' : c[0] === '-S' ? 'socket' : 'independent'))).toEqual(['check', 'socket']);
        expect(calls[0]).toEqual(['-S', socket, '-O', 'check', '--', 'myserver.com']);

        // Master gone (the socket file is left over): the independent connection, once.
        calls.length = 0;
        answer(false);
        const result = await proc.exec('echo hi');
        expect(result.stdout.toString()).toBe('out');
        expect(calls.map((c) => (isCheck(c) ? 'check' : c[0] === '-S' ? 'socket' : 'independent'))).toEqual(['check', 'independent']);

        // A failing command is never run again, whatever its stderr says (the remote side writes it).
        calls.length = 0;
        answer(true, {
          err: Object.assign(new Error('exit'), { code: 255 }),
          stderr: 'Control socket connect(/x): Connection refused\nConnection closed by UNKNOWN port 65535\n',
        });
        await expect(proc.exec('rm x')).rejects.toThrow('exit');
        expect(calls.filter((c) => !isCheck(c))).toHaveLength(1);
        await proc.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('refuses to run before it has been started', async () => {
    const proc = new OpenSshSftpProcess();
    await expect(proc.exec('echo hi')).rejects.toThrow('process configuration not available');
    const errored = new Promise<Error>((resolve) => proc.createExecStream('x').on('error', resolve));
    expect((await errored).message).toBe('Cannot run exec: process configuration not available');
  });
});
