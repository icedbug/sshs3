import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { SSHConnectionConfig } from '../../shared/types/ssh';
import { SmartcardDetector } from '../smartcard/SmartcardDetector';
import type { IDotfileTransport } from './DotfileSyncService';
import { quoteShellArg } from '../search/shellQuote';
import { sshClientFileArgs } from '../web/tenantBoundary';

// chmod mode must be a plain octal permission string (e.g. "644", "0750").
// Dotfile pool entries can arrive from remote profile sync — a compromised
// sync target, paired device, or leaked master password — so `mode` is
// untrusted input, not merely interpolated as-is into a remote shell command.
const VALID_CHMOD_MODE = /^[0-7]{3,4}$/;

export class DotfileCliTransport implements IDotfileTransport {
  private controlSocketReady: boolean | null = null;

  constructor(
    private config: SSHConnectionConfig,
    private controlPath?: string,
    private onPresence?: () => void,
    private onPresenceCleared?: () => void
  ) {}

  private async waitForControlPath(): Promise<boolean> {
    if (this.controlSocketReady !== null) {
      return this.controlSocketReady;
    }
    if (!this.controlPath || process.platform === 'win32') {
      this.controlSocketReady = false;
      return false;
    }
    if (fs.existsSync(this.controlPath)) {
      this.controlSocketReady = true;
      return true;
    }

    // Give the master PTY connection a moment (up to 4s) to create the socket
    const start = Date.now();
    while (Date.now() - start < 4000) {
      await new Promise((r) => setTimeout(r, 200));
      if (fs.existsSync(this.controlPath)) {
        this.controlSocketReady = true;
        return true;
      }
    }

    this.controlSocketReady = false;
    return false;
  }

  private async runSshCommand(
    remoteCmd: string,
    stdinContent?: string
  ): Promise<{ stdout: Buffer; stderr: string }> {
    const isWindows = process.platform === 'win32';
    const bin = isWindows ? 'ssh.exe' : 'ssh';

    let args: string[];
    let env: Record<string, string>;

    const hasControlSocket = await this.waitForControlPath();
    if (hasControlSocket && this.controlPath) {
      const target = this.config.username ? `${this.config.username}@${this.config.host}` : this.config.host;
      args = [
        ...sshClientFileArgs(this.config),
        '-o',
        `ControlPath=${this.controlPath}`,
        '-o',
        'ControlMaster=no',
        '-o',
        'BatchMode=yes',
        '--',
        target,
        remoteCmd,
      ];
      env = { ...(process.env as Record<string, string>) };
    } else {
      const baseArgs = SmartcardDetector.buildSSHArguments(this.config);
      args = [...baseArgs, remoteCmd];
      env = {
        ...(process.env as Record<string, string>),
        ...SmartcardDetector.buildProxyEnv(this.config),
      };
      if (this.config.agentPath) {
        env.SSH_AUTH_SOCK = this.config.agentPath;
      }
    }

    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      const stdoutChunks: Buffer[] = [];
      let stderr = '';
      let presencePrompted = false;

      child.stdout?.on('data', (d: Buffer) => {
        stdoutChunks.push(d);
      });

      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString('utf-8');
        stderr += text;
        if (/confirm user presence/i.test(text)) {
          presencePrompted = true;
          this.onPresence?.();
        }
      });

      child.on('error', (err) => {
        if (presencePrompted) {
          this.onPresenceCleared?.();
        }
        reject(err);
      });

      child.on('close', (code) => {
        if (presencePrompted) {
          this.onPresenceCleared?.();
        }
        if (code === 0) {
          resolve({ stdout: Buffer.concat(stdoutChunks), stderr });
        } else {
          reject(
            new Error(
              `SSH command failed (exit code ${code}): ${stderr.trim() || 'unknown error'}`
            )
          );
        }
      });

      if (stdinContent !== undefined) {
        child.stdin?.end(stdinContent, 'utf-8');
      } else {
        child.stdin?.end();
      }
    });
  }

  public async getHomeDir(): Promise<string> {
    const { stdout } = await this.runSshCommand('echo "$HOME"');
    const home = stdout.toString('utf-8').trim();
    if (!home) {
      throw new Error('Failed to resolve remote home directory via SSH');
    }
    return home;
  }

  public async readRemoteFile(remotePath: string): Promise<Buffer> {
    // quoteShellArg (POSIX single-quoting), not JSON.stringify: a
    // double-quoted string still lets the remote shell expand $(...),
    // backticks, and $VAR embedded in remotePath. Single-quoting is inert
    // against all shell metacharacters except the quote character itself,
    // which quoteShellArg escapes.
    const { stdout } = await this.runSshCommand(`cat -- ${quoteShellArg(remotePath)}`);
    return stdout;
  }

  public async writeRemoteFile(remotePath: string, content: string, mode?: string): Promise<void> {
    if (mode !== undefined && !VALID_CHMOD_MODE.test(mode)) {
      throw new Error(`Refusing to apply invalid chmod mode to remote file: ${JSON.stringify(mode)}`);
    }
    const tmp = `${remotePath}.sshs3.tmp`;
    const quotedPath = quoteShellArg(remotePath);
    const quotedTmp = quoteShellArg(tmp);
    const chmodCmd = mode ? ` && chmod ${mode} -- ${quotedPath}` : '';
    const script = `dir=$(dirname -- ${quotedPath}); [ "$dir" != "." ] && [ "$dir" != "/" ] && mkdir -p -- "$dir"; cat > ${quotedTmp} && mv -f -- ${quotedTmp} ${quotedPath}${chmodCmd}`;

    await this.runSshCommand(script, content);
  }

  public async disconnect(): Promise<void> {
    // Multiplexed connection lifecycle is owned by the PTY session.
  }
}
