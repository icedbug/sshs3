import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as AgentRegistry from '../ssh/AgentRegistry';
import { createLogger } from '../log';
const askpassLog = createLogger('askpass');

/** Carried on a re-prompt after a wrong PIN, so the UI can show "Incorrect PIN, 2 attempts left" inline instead of failing silently. */
export interface AskpassPromptRetryContext {
  error: string;
  attempt: number;
  maxAttempts: number;
}

export type AskpassPromptHandler = (
  prompt: string,
  retry?: AskpassPromptRetryContext
) => Promise<string> | string;

export interface AskpassServerOptions {
  promptHandler?: AskpassPromptHandler;
  onPresence?: (prompt: string) => void;
  token?: string;
}

export class AskpassServer extends EventEmitter {
  private server: net.Server | null = null;
  private port: number = 0;
  /**
   * Unix domain socket path used on non-Windows platforms (LOW finding, code
   * review): a loopback TCP port has no OS-level access control of its own —
   * any local user on a shared multi-user Linux host can connect to it, so
   * the random token is the only thing standing between them and this
   * server (not practically exploitable given the 128-bit token and
   * constant-time comparison, but still a gap a Unix socket closes for
   * free). The socket file lives inside `tempDir`, created with mode 0700,
   * so only this OS user can even open() it, before the token is ever
   * checked. Windows has no equivalent of a mode-restricted Unix socket
   * file, so it keeps the original TCP loopback behavior.
   */
  private socketPath: string | null = null;
  private token: string;
  private promptHandler?: AskpassPromptHandler;
  private onPresence?: (prompt: string) => void;
  private tempDir: string | null = null;
  private scriptPath: string | null = null;
  private activeSockets: Set<net.Socket> = new Set();
  private running: boolean = false;
  private registryId: string | null = null;

  constructor(options?: AskpassServerOptions) {
    super();
    this.promptHandler = options?.promptHandler;
    this.onPresence = options?.onPresence;
    this.token = options?.token ?? crypto.randomBytes(16).toString('hex');
  }

  /**
   * Sets or updates the prompt callback handler.
   */
  public setPromptHandler(handler: AskpassPromptHandler): void {
    this.promptHandler = handler;
  }

  /**
   * Sets or updates the presence callback handler.
   */
  public setOnPresence(handler?: (prompt: string) => void): void {
    this.onPresence = handler;
  }

  /**
   * Starts the local TCP Askpass server and creates the executable wrapper script.
   */
  public async start(): Promise<{ port: number; scriptPath: string }> {
    if (this.running && this.scriptPath) {
      return { port: this.port, scriptPath: this.scriptPath };
    }

    try {
      // 1. Create the private (mode 0700) temp directory first — on POSIX the
      // server's Unix socket file lives inside it, so it must exist before
      // the server starts listening.
      this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sshs3-askpass-'));
      await fs.chmod(this.tempDir, 0o700);
      this.registryId = await AgentRegistry.registerEntry({
        kind: 'askpass',
        ownerPid: process.pid,
        tempDir: this.tempDir,
        createdAt: new Date().toISOString(),
      });

      const isWindows = process.platform === 'win32';

      // 2. Start the server: a Unix domain socket on POSIX, TCP loopback on
      // Windows (which has no equivalent mode-restricted socket file).
      await new Promise<void>((resolve, reject) => {
        const server = net.createServer((socket) => {
          this.handleConnection(socket);
        });

        server.once('error', reject);

        if (isWindows) {
          server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address && typeof address === 'object') {
              this.port = address.port;
              this.server = server;
              resolve();
            } else {
              reject(new Error('Failed to obtain server address'));
            }
          });
        } else {
          const socketPath = path.join(this.tempDir!, 'askpass.sock');
          server.listen(socketPath, () => {
            this.socketPath = socketPath;
            this.server = server;
            resolve();
          });
        }
      });

      // 3. Create the askpass script.
      this.scriptPath = await this.generateAskpassScript(this.tempDir, this.token, {
        port: this.port,
        socketPath: this.socketPath,
      });
      this.running = true;
    } catch (err) {
      // Whatever was set up before the failure (temp folder, registry entry, half-started server) must not stay behind.
      await this.stop().catch(() => {});
      throw err;
    }

    return { port: this.port, scriptPath: this.scriptPath };
  }

  /**
   * Returns environment variables required for OpenSSH to invoke this Askpass server.
   */
  public getEnv(): Record<string, string> {
    if (!this.scriptPath) {
      throw new Error('AskpassServer is not started');
    }

    return {
      SSH_ASKPASS: this.scriptPath,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
    };
  }

  /**
   * Returns the listening TCP port.
   */
  public getPort(): number {
    return this.port;
  }

  /**
   * Returns the Unix domain socket path in use on non-Windows platforms, or
   * null on Windows (which uses getPort()/TCP instead).
   */
  public getSocketPath(): string | null {
    return this.socketPath;
  }

  /**
   * Returns the path to the executable askpass script.
   */
  public getScriptPath(): string {
    if (!this.scriptPath) {
      throw new Error('AskpassServer is not started');
    }
    return this.scriptPath;
  }

  /**
   * Returns whether the server is currently running.
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Stops the server, terminates open sockets, and removes temporary script files.
   */
  public async stop(): Promise<void> {
    this.running = false;

    // Close all open client sockets
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    // Close TCP server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }

    // Clean up temporary files
    if (this.tempDir) {
      try {
        await fs.rm(this.tempDir, { recursive: true, force: true });
      } catch {
        // Ignore deletion errors on cleanup
      }
      this.tempDir = null;
      this.scriptPath = null;
    }

    await AgentRegistry.unregisterEntry(this.registryId);
    this.registryId = null;
  }

  private handleConnection(socket: net.Socket): void {
    this.activeSockets.add(socket);

    socket.on('error', () => {
      // Prevent process crash on ECONNRESET / EPIPE
      socket.destroy();
    });

    socket.on('close', () => {
      this.activeSockets.delete(socket);
    });

    let buffer = '';
    const MAX_BUFFER_LENGTH = 65536;

    socket.on('data', async (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > MAX_BUFFER_LENGTH) {
        socket.destroy();
        return;
      }
      if (!buffer.includes('\n')) return;

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const req = JSON.parse(line.trim());

          let authorized = false;
          if (typeof req.token === 'string') {
            const tokenBuf = Buffer.from(req.token);
            const expectedBuf = Buffer.from(this.token);
            if (tokenBuf.length === expectedBuf.length && crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
              authorized = true;
            }
          }

          if (!authorized) {
            socket.write(JSON.stringify({ error: 'Unauthorized token' }) + '\n');
            socket.end();
            return;
          }

          const prompt = req.prompt || '';
          const promptType = req.promptType || '';
          const isPurePresence =
            promptType === 'none' ||
            (/^confirm user presence/i.test(prompt) && !/pin|password|passphrase/i.test(prompt));

          if (isPurePresence) {
            askpassLog.info(`received pure presence notification (promptType="${promptType}", prompt="${prompt}") - resolving immediately without prompting for PIN`
            );
            this.emit('presence', prompt);
            this.onPresence?.(prompt);
            socket.write(JSON.stringify({ pin: '' }) + '\n');
            socket.end();
            return;
          }

          const pin = await this.resolvePin(prompt);
          socket.write(JSON.stringify({ pin }) + '\n');
        } catch (err: any) {
          socket.write(JSON.stringify({ error: err.message || 'Internal error' }) + '\n');
        } finally {
          socket.end();
        }
      }
    });
  }

  private async resolvePin(prompt: string): Promise<string> {
    // Logs the prompt text and the *length* only of whatever was resolved (never the PIN/passphrase
    // itself) — this is diagnostic output for tracking down cases like an OpenSSH child receiving an
    // empty answer despite the user having typed something into the renderer's modal (e.g. two
    // concurrent askpass flows racing for the same single modal queue).
    if (this.promptHandler) {
      const answer = await this.promptHandler(prompt);
      askpassLog.info(`resolved prompt "${prompt}" -> ${answer ? `${answer.length} char(s)` : '(empty)'}`);
      return answer;
    }

    if (this.listenerCount('prompt') > 0) {
      return new Promise<string>((resolve) => {
        this.emit('prompt', prompt, (response: string) => {
          askpassLog.info(`resolved prompt "${prompt}" -> ${response ? `${response.length} char(s)` : '(empty)'}`
          );
          resolve(response);
        });
      });
    }

    askpassLog.info(`resolved prompt "${prompt}" -> (empty, no handler registered)`);
    return '';
  }

  private async generateAskpassScript(
    dir: string,
    token: string,
    endpoint: { port: number; socketPath: string | null }
  ): Promise<string> {
    const isWindows = process.platform === 'win32';
    const jsPath = path.join(dir, 'askpass-worker.cjs');

    const connectOptions = endpoint.socketPath
      ? { path: endpoint.socketPath }
      : { port: endpoint.port, host: '127.0.0.1' };

    const jsContent = `
const net = require('net');
const prompt = process.argv[2] || '';
const promptType = process.env.SSH_ASKPASS_PROMPT || '';
const token = ${JSON.stringify(token)};

const client = net.createConnection(${JSON.stringify(connectOptions)}, () => {
  client.write(JSON.stringify({ token, prompt, promptType }) + '\\n');
});

let response = '';
client.on('data', (chunk) => {
  response += chunk.toString();
  if (response.includes('\\n')) {
    try {
      const data = JSON.parse(response.trim());
      if (data.error) {
        process.exit(1);
      }
      if (data.pin !== undefined && data.pin !== null) {
        process.stdout.write(String(data.pin));
      }
      client.end();
      process.exit(0);
    } catch {
      process.stdout.write(response.trim());
      client.end();
      process.exit(0);
    }
  }
});

client.on('error', () => {
  process.exit(1);
});
`;

    await fs.writeFile(jsPath, jsContent, { encoding: 'utf-8', mode: 0o600 });
    await fs.chmod(jsPath, 0o600);

    if (isWindows) {
      const batPath = path.join(dir, 'askpass.bat');
      const batContent = `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${jsPath}" %*\r\n`;
      await fs.writeFile(batPath, batContent, { encoding: 'utf-8', mode: 0o700 });
      return batPath;
    } else {
      const shPath = path.join(dir, 'askpass.sh');
      const shContent = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${process.execPath}" "${jsPath}" "$@"\n`;
      await fs.writeFile(shPath, shContent, { encoding: 'utf-8', mode: 0o700 });
      await fs.chmod(shPath, 0o700);
      return shPath;
    }
  }
}
