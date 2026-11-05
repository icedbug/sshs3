import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { SmartcardDetector } from '../../smartcard/SmartcardDetector';
import { AskpassServer } from '../../smartcard/AskpassServer';
import { SftpPacketProtocol } from './SftpPacketProtocol';
import type { HostKeyPromptInfo } from '../../ssh/HostKeyVerifier';
import type { SFTPConfig } from '../../../shared/types/storage';
import type { SSHConnectionConfig } from '../../../shared/types/ssh';
import { createLogger } from '../../log';
const sftpLog = createLogger('sftp');

export interface OpenSshProcessOptions {
  config: SFTPConfig;
  controlPath?: string;
  onPresence?: (prompt: string) => void;
  onPresenceCleared?: () => void;
  pinPromptHandler?: (prompt: string) => Promise<string> | string;
  /** Asked when OpenSSH wants to trust an unknown host key. Absent => rejected (fail closed). */
  hostKeyPromptHandler?: (info: HostKeyPromptInfo) => Promise<boolean>;
}

/** SFTPConfig är en delmängd av SSHConnectionConfig; OpenSSH-argumentbyggaren kräver id/name. */
function toSshConfig(config: SFTPConfig): SSHConnectionConfig {
  // Saved tunnels are only started from the Tunnels panel, never by an SFTP channel. Besides racing the panel
  // for the port, a -L/-R on a multiplexed client makes the master refuse it and ssh then falls back to a
  // brand-new connection (a second authentication) instead of sharing the master.
  return {
    ...config,
    id: config.id ?? '',
    name: config.name ?? config.host,
    tunnels: undefined,
  } as unknown as SSHConnectionConfig;
}

const HOST_KEY_CONFIRM_RE = /are you sure you want to continue connecting/i;

export function parseHostKeyPrompt(prompt: string, config: SFTPConfig): HostKeyPromptInfo {
  const m = /(\S+) key fingerprint is:? (\S+?)\.?(?:\s|$)/i.exec(prompt);
  // The question can be about a jump host rather than the target: name the host ssh actually asks about.
  const asked = /authenticity of host '(?:\[([^\]']+)\]:(\d+)|([^\s']+))/i.exec(prompt);
  const askedHost = asked?.[1] ?? asked?.[3];
  const sameHost = !askedHost || askedHost === config.host;
  return {
    host: sameHost ? config.host : askedHost,
    port: sameHost ? (config.port ?? 22) : asked?.[2] ? Number(asked[2]) : 22,
    keyType: m?.[1] ?? 'unknown',
    fingerprint: m?.[2] ?? 'unknown',
    status: 'unknown',
  };
}

export function resolveSshBinary(): string {
  if (process.platform === 'win32') {
    const winDefault = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
    if (fs.existsSync(winDefault)) {
      return winDefault;
    }
    return 'ssh.exe';
  }
  return 'ssh';
}

export class OpenSshSftpProcess {
  private child?: ChildProcess;
  private askpassServer?: AskpassServer;
  private protocol?: SftpPacketProtocol;
  private isClosed = false;
  private stderrBuffer = '';
  private controlPath?: string;
  private controlDir?: string;
  private host: string = '';
  private config?: SFTPConfig;

  public async start(options: OpenSshProcessOptions): Promise<SftpPacketProtocol> {
    // close() latches `isClosed`; a retry on the same instance after a failed start (or a
    // later close) must be able to clean up again, otherwise ssh/askpass/temp dir would leak.
    this.isClosed = false;
    this.stderrBuffer = '';
    this.protocol = undefined;
    try {
      return await this.startInner(options);
    } catch (err) {
      // Anything thrown after the control dir / askpass server were created (e.g. building
      // the ssh arguments) must not leave them behind.
      await this.close();
      throw err;
    }
  }

  private async startInner(options: OpenSshProcessOptions): Promise<SftpPacketProtocol> {
    const { config, pinPromptHandler, onPresence, onPresenceCleared, hostKeyPromptHandler } = options;
    this.config = config;
    this.host = config.host;

    // Use or generate controlPath on POSIX
    if (process.platform !== 'win32') {
      if (options.controlPath) {
        this.controlPath = options.controlPath;
      } else {
        // Private 0700 directory + unguessable name, so other local users can't pre-create
        // or reach the multiplexing socket.
        this.controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3m-sftp-'));
        fs.chmodSync(this.controlDir, 0o700);
        this.controlPath = path.join(this.controlDir, `${crypto.randomBytes(8).toString('hex')}.sock`);
      }
    }

    // Determine if AskpassServer is needed
    const needsAskpass =
      config.authType === 'smartcard' ||
      config.authType === 'fido2' ||
      config.authType === 'password' ||
      Boolean(config.password) ||
      Boolean(config.passphrase);

    let askpassEnv: Record<string, string> = {};

    if (needsAskpass) {
      this.askpassServer = new AskpassServer({
        onPresence: (prompt: string) => {
          if (onPresence) onPresence(prompt);
        },
        promptHandler: async (rawPrompt: string) => {
          if (HOST_KEY_CONFIRM_RE.test(rawPrompt)) {
            // Never answer a trust question with a password; ask the user, fail closed otherwise.
            if (!hostKeyPromptHandler) return 'no';
            const info = parseHostKeyPrompt(rawPrompt, config);
            return (await hostKeyPromptHandler(info)) ? 'yes' : 'no';
          }
          if (config.authType === 'password' && config.password) {
            return config.password;
          }
          if (config.passphrase) {
            return config.passphrase;
          }
          if (pinPromptHandler) {
            return await pinPromptHandler(rawPrompt);
          }
          return config.passphrase || config.password || '';
        },
      });

      await this.askpassServer.start();
      askpassEnv = this.askpassServer.getEnv();
    }

    // Build SSH arguments
    const sshArgs = SmartcardDetector.buildSSHArguments(toSshConfig(config), this.controlPath);
    // buildSSHArguments ends with `-- [user@]host`; options must go before that pair,
    // and `-s` makes the trailing word a subsystem name: `ssh ... -s -- user@host sftp`.
    const destination = sshArgs.splice(-2);
    sshArgs.push('-o', 'BatchMode=no', '-s', ...destination, 'sftp');

    const sshBinary = resolveSshBinary();

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...askpassEnv,
      ...SmartcardDetector.buildProxyEnv(toSshConfig(config)),
    };

    if (config.agentPath) {
      env.SSH_AUTH_SOCK = config.agentPath;
    }

    sftpLog.info(`spawning ${sshBinary} ${sshArgs.join(' ')}`);
    const child = spawn(sshBinary, sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.child = child;

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      this.stderrBuffer = (this.stderrBuffer + text).slice(-4096);
      sftpLog.info(`ssh stderr: ${JSON.stringify(text.slice(0, 500))}`);

      if (/confirm user presence|touch (your )?security key/i.test(text)) {
        if (onPresence) onPresence(text.trim());
      }
    });

    const exitPromise = new Promise<never>((_, reject) => {
      child.once('error', (err) => {
        sftpLog.info(`ssh spawn error: ${err.message}`);
        reject(err);
      });
      child.once('exit', (code, signal) => {
        sftpLog.info(`ssh exited code=${code} signal=${signal}`);
        const detail = this.stderrBuffer.trim() || `exit code ${code}${signal ? `, signal ${signal}` : ''}`;
        reject(new Error(`OpenSSH process terminated: ${detail}`));
      });
    });

    if (!child.stdin || !child.stdout) {
      throw new Error('Failed to spawn OpenSSH process with stdio pipes');
    }

    const protocol = new SftpPacketProtocol(child.stdout, child.stdin);
    this.protocol = protocol;

    // Race between protocol handshake and early process death
    try {
      await Promise.race([protocol.init(), exitPromise]);
      exitPromise.catch(() => {});
      sftpLog.info('SFTP subsystem ready (protocol version negotiated)');
      onPresenceCleared?.();
    } catch (err: any) {
      // If ssh died first, the protocol only sees a closed pipe; surface ssh's own stderr instead.
      const stderrText = this.stderrBuffer.trim();
      onPresenceCleared?.();
      await this.close();
      if (stderrText && /SFTP stream closed/.test(String(err?.message))) {
        throw new Error(`OpenSSH process terminated: ${stderrText}`, { cause: err });
      }
      throw err;
    }

    return protocol;
  }

  public getProtocol(): SftpPacketProtocol {
    if (!this.protocol) {
      throw new Error('OpenSshSftpProcess is not started');
    }
    return this.protocol;
  }

  public getControlPath(): string | undefined {
    return this.controlPath;
  }

  /**
   * The ssh command line and environment for one remote command, which must be non-interactive (BatchMode):
   * - Through the live control socket: ssh only talks to the master. `ProxyCommand=false` makes it fail
   *   closed if the socket turns out to be stale; without it ssh falls back to a fresh connection to
   *   `host` on port 22 as the local user, past the profile's port, user, proxy and jump host.
   * - Otherwise (or with `useControlSocket` off) an independent connection built from the profile, with the
   *   proxy credentials and agent socket in the environment like the SFTP process itself (a ProxyCommand
   *   with no ELECTRON_RUN_AS_NODE starts a second copy of the app).
   */
  private buildExecInvocation(
    cmd: string,
    useControlSocket = true
  ): { args: string[]; env?: Record<string, string>; viaControlSocket: boolean } {
    if (useControlSocket && this.controlPath && fs.existsSync(this.controlPath)) {
      return {
        args: ['-S', this.controlPath, '-o', 'BatchMode=yes', '-o', 'ProxyCommand=false', '--', this.host, cmd],
        viaControlSocket: true,
      };
    }
    if (!this.config) {
      throw new Error('Cannot run exec: process configuration not available');
    }
    const args = SmartcardDetector.buildSSHArguments(toSshConfig(this.config));
    // The builder ends with `-- [user@]host`; options go before that pair and the command after it.
    const destination = args.splice(-2);
    args.push('-o', 'BatchMode=yes', ...destination, cmd);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...SmartcardDetector.buildProxyEnv(toSshConfig(this.config)),
    };
    if (this.config.agentPath) {
      env.SSH_AUTH_SOCK = this.config.agentPath;
    }
    return { args, env, viaControlSocket: false };
  }

  /** Asks the master behind the control socket whether it is alive (`ssh -O check`); its answer does not depend on any remote output. */
  private masterIsAlive(sshBinary: string): Promise<boolean> {
    if (!this.controlPath) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      execFile(sshBinary, ['-S', this.controlPath!, '-O', 'check', '--', this.host], { timeout: 5000 }, (err) =>
        resolve(!err)
      );
    });
  }

  public async exec(cmd: string): Promise<{ stdout: Buffer; stderr: string }> {
    const sshBinary = resolveSshBinary();
    // Decided before the command runs, never by retrying afterwards: a failed run says nothing about whether
    // the remote command already ran, and its stderr is the remote side's to write. A socket file whose
    // master is gone is skipped here; the independent connection is built from the profile.
    const useControlSocket = Boolean(this.controlPath && fs.existsSync(this.controlPath)) && (await this.masterIsAlive(sshBinary));
    const { args, env } = this.buildExecInvocation(cmd, useControlSocket);

    return new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
      execFile(sshBinary, args, { maxBuffer: 10 * 1024 * 1024, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout: Buffer.from(stdout), stderr: stderr.toString() });
      });
    });
  }

  public createExecStream(cmd: string): NodeJS.ReadableStream {
    let invocation: ReturnType<OpenSshSftpProcess['buildExecInvocation']>;
    try {
      invocation = this.buildExecInvocation(cmd);
    } catch (err) {
      const errStream = new Readable({ read() {} });
      errStream.destroy(err instanceof Error ? err : new Error(String(err)));
      return errStream;
    }
    const sshBinary = resolveSshBinary();
    const { args, env } = invocation;
    const childProc = spawn(sshBinary, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) });

    childProc.stderr?.resume();
    const stdout = childProc.stdout!;
    // A failed spawn (ssh missing, bad cwd) is reported on the child, not on its pipes: without a
    // listener it would be an uncaught exception in the main process.
    childProc.on('error', (err) => stdout.destroy(err));
    stdout.on('close', () => {
      try {
        if (!childProc.killed) {
          childProc.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
    });

    return stdout;
  }

  public async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.child) {
      try {
        this.child.kill('SIGTERM');
      } catch {
        // Ignore
      }
      this.child = undefined;
    }

    if (this.askpassServer) {
      try {
        await this.askpassServer.stop();
      } catch {
        // Ignore
      }
      this.askpassServer = undefined;
    }

    // A socket handed in by the caller (a terminal's master) is not ours to remove.
    if (this.controlDir && this.controlPath && fs.existsSync(this.controlPath)) {
      try {
        fs.unlinkSync(this.controlPath);
      } catch {
        // Ignore
      }
    }

    if (this.controlDir) {
      try {
        fs.rmSync(this.controlDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
      this.controlDir = undefined;
    }
  }
}
