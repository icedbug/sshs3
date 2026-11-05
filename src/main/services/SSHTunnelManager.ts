import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { SmartcardDetector } from '../smartcard/SmartcardDetector';
import { AskpassServer } from '../smartcard/AskpassServer';
import { isHostKeyConfirmPrompt, savedAskpassAnswer } from '../ssh/askpassPrompt';
import type { SSHConnectionConfig, SSHTunnelConfig } from '../../shared/types/ssh';
import type { SSHActiveTunnel } from '../../shared/types/ssh';

interface TunnelSession {
  id: string;
  connectionId: string;
  connectionName: string;
  tunnel: SSHTunnelConfig;
  child?: ChildProcess;
  askpassServer?: AskpassServer;
  startedAt: string;
  status: 'active' | 'error';
  error?: string;
}

/**
 * Starts and stops standalone SSH port-forward tunnels (-L/-R/-D), each as its
 * own headless `ssh -N` process independent of any open terminal session, so a
 * tunnel's lifetime is controlled directly rather than riding along with a PTY.
 */
export class SSHTunnelManager extends EventEmitter {
  private sessions: Map<string, TunnelSession> = new Map();

  constructor() {
    super();
    // Last-resort safety net: the graceful `stopAll()` path (app 'before-quit' -> IpcBridge.dispose())
    // covers a normal quit, but a dev-server restart, a renderer crash the app doesn't recover from, or
    // any other path that ends the main process via process.exit() would otherwise leave these `ssh -N`
    // children running as orphans — they're independent OS processes, not tied to our lifetime by default.
    // 'exit' fires synchronously right before the process actually dies, so a plain kill() (itself
    // synchronous — it only sends the signal) is all that's safe to do here. Mirrors
    // AgentLifecycleManager's installExitHandlers().
    process.once('exit', () => this.killAllSync());
  }

  private killAllSync(): void {
    for (const session of this.sessions.values()) {
      if (session.child && session.child.exitCode === null) {
        try {
          session.child.kill('SIGTERM');
        } catch {
          // Already gone
        }
      }
    }
  }

  public async startTunnel(
    config: SSHConnectionConfig,
    tunnel: SSHTunnelConfig,
    /**
     * Falls back to an interactive prompt (surfaced by the caller, typically via the
     * app's existing Askpass modal) when neither a stored password nor passphrase
     * covers the request — e.g. a non-resident FIDO2/passphrase-protected key, where
     * silently answering with '' just fails signing instead of ever asking the user.
     */
    promptHandler?: (rawPrompt: string) => Promise<string>
  ): Promise<SSHActiveTunnel> {
    if (tunnel.localPort < 1024 && process.getuid && process.getuid() !== 0) {
      throw new Error(
        `Port ${tunnel.localPort} is privileged (< 1024) and requires root/administrator privileges. Please choose a port >= 1024.`
      );
    }

    const id = `tun-${crypto.randomUUID()}`;

    let askpassServer: AskpassServer | undefined;
    let askpassEnv: Record<string, string> = {};
    const needsAskpass =
      config.authType === 'smartcard' ||
      config.authType === 'fido2' ||
      config.authType === 'password' ||
      Boolean(config.password) ||
      Boolean(config.passphrase);

    if (needsAskpass) {
      askpassServer = new AskpassServer({
        promptHandler: async (rawPrompt) => {
          // No trust dialog here: fail closed, and never answer a trust question with a secret.
          if (isHostKeyConfirmPrompt(rawPrompt)) return 'no';
          const saved = savedAskpassAnswer(rawPrompt, config);
          if (saved) return saved;
          if (promptHandler) return promptHandler(rawPrompt);
          return '';
        },
      });
      await askpassServer.start();
      askpassEnv = askpassServer.getEnv();
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...askpassEnv,
      ...SmartcardDetector.buildProxyEnv(config),
    };
    if (config.agentPath) {
      env.SSH_AUTH_SOCK = config.agentPath;
    } else if (config.authType === 'smartcard') {
      delete env.SSH_AUTH_SOCK;
    }

    // Build args for a config carrying only this one tunnel — buildSSHArguments
    // otherwise applies every tunnel saved on the profile, which is right for a
    // terminal session but not for starting one specific tunnel on its own.
    const singleTunnelConfig: SSHConnectionConfig = {
      ...config,
      tunnels: [{ ...tunnel, enabled: true }],
    };
    let child: ChildProcess;
    try {
      const sshArgs = SmartcardDetector.buildSSHArguments(singleTunnelConfig);
      // -N: no remote command (forwarding only). ExitOnForwardFailure: fail fast
      // instead of silently keeping a session open on a port bind error.
      sshArgs.unshift('-N', '-o', 'ExitOnForwardFailure=yes');
      const sshBinary = process.platform === 'win32' ? 'ssh.exe' : 'ssh';

      child = spawn(sshBinary, sshArgs, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      // An invalid port, jump host or proxy throws here; the askpass server started above would otherwise
      // keep its socket, temp directory and registry entry for the rest of the app's life.
      void askpassServer?.stop().catch(() => {});
      throw err;
    }

    const session: TunnelSession = {
      id,
      connectionId: config.id,
      connectionName: config.name,
      tunnel,
      child,
      askpassServer,
      startedAt: new Date().toISOString(),
      status: 'active',
    };
    this.sessions.set(id, session);

    let stderrTail = '';
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    // A missing `ssh` is not thrown by spawn(): it arrives here, and with no listener it would be an uncaught
    // exception in the main process.
    child.on('error', (err) => {
      stderrTail = (stderrTail + err.message).slice(-2000);
    });

    child.on('exit', (code, signal) => {
      const current = this.sessions.get(id);
      if (!current) return;
      current.status = 'error';
      current.error = signal
        ? `Terminated (${signal})`
        : stderrTail.trim() || `ssh exited with code ${code}`;
      current.child = undefined;
      void current.askpassServer?.stop().catch(() => {});
      this.emitChange();
    });

    // Give the process a brief window to fail fast on a bad bind/auth before
    // reporting the tunnel as started.
    const startupError = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 800);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve(stderrTail.trim() || 'ssh exited immediately');
      });
      // spawn failed (e.g. ENOENT): there may be no 'exit' at all.
      child.once('error', () => {
        clearTimeout(timer);
        resolve(stderrTail.trim() || 'ssh could not be started');
      });
    });

    if (startupError) {
      // 'error' is also emitted when a process that is running could not be signalled: do not leave it bound.
      try {
        child.kill();
      } catch {
        // already gone
      }
      this.sessions.delete(id);
      void askpassServer?.stop().catch(() => {});
      // The generic 'exit' handler above already fired and broadcast this session as
      // 'error' (still in the map at that point) to every listening renderer — without this,
      // that phantom entry would linger in the UI forever, since deleting it here alone never
      // tells anyone it's gone.
      this.emitChange();
      throw new Error(startupError);
    }

    this.emitChange();
    return this.toActive(session);
  }

  public async stopTunnel(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;

    this.sessions.delete(id);
    const child = session.child;
    if (child && child.exitCode === null) {
      // Wait for the process to actually exit (not just for the signal to be sent) before
      // resolving: the OS doesn't release the bound local port until the process is really gone,
      // and a caller that stops a tunnel only to immediately start a new one on the same port
      // (e.g. saving an edit to a running tunnel) would otherwise sometimes lose that race and
      // hit "Address already in use" for a port that looks free again a moment later.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          clearTimeout(giveUpTimer);
          resolve();
        };
        child.once('exit', finish);
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          if (child.exitCode === null) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Already gone
            }
          }
        }, 1500);
        // Safety net: never block Stop forever even if 'exit' somehow never fires.
        const giveUpTimer = setTimeout(finish, 3000);
      });
    }
    await session.askpassServer?.stop();
    this.emitChange();
    return true;
  }

  public listActive(): SSHActiveTunnel[] {
    return Array.from(this.sessions.values()).map((s) => this.toActive(s));
  }

  public async stopAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.stopTunnel(id)));
  }

  /**
   * Best-effort probe: tries to bind 127.0.0.1:port and immediately releases it. A free result
   * can still lose a race to something else binding the port between this check and the real
   * `ssh -L/-D` start — this is advisory (surfaced in the UI before starting), not a lock.
   */
  public async isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(true));
      });
    });
  }

  private toActive(s: TunnelSession): SSHActiveTunnel {
    return {
      id: s.id,
      connectionId: s.connectionId,
      connectionName: s.connectionName,
      tunnel: s.tunnel,
      status: s.status,
      startedAt: s.startedAt,
      error: s.error,
      pid: s.child?.pid,
    };
  }

  private emitChange(): void {
    this.emit('change', this.listActive());
  }
}
