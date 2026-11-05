import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DetectedSmartcardLib, SSHConnectionConfig } from '../../shared/types/ssh';
import { isAllowedExtraOption } from '../ssh/blockedSshDirectives';
import { createLogger } from '../log';
const smartcardLog = createLogger('smartcard');

export interface DetectOptions {
  customPaths?: Array<{ name: string; path: string; platform: 'linux' | 'win32' }>;
  onlyExisting?: boolean;
}

/**
 * Whether a string is safe to embed, unquoted, inside an OpenSSH
 * `ProxyCommand=...` value that is executed via `/bin/sh -c` (or `cmd.exe`)
 * by the `ssh` client itself. This gates both `config.host` (substituted by
 * ssh's own `%h` expansion into the ProxyCommand string) and `config.proxy.host`
 * (interpolated directly by buildSSHArguments below) — any character outside
 * this allowlist could otherwise break out of the command and execute
 * arbitrary shell commands when the connection is established.
 * Restricted to characters valid in a DNS hostname or IPv4/IPv6 literal.
 */
function isSafeHostToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && /^[A-Za-z0-9.\-_[\]:]+$/.test(value);
}

// One ProxyJump hop: [user@]host[:port]. ssh turns -J into a shell-run ProxyCommand, so older
// OpenSSH versions can be tricked by shell metacharacters in the user/host parts.
// eslint-disable-next-line security/detect-unsafe-regex -- bounded username followed by @ delimiter prevents backtracking
const PROXY_JUMP_HOP = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.\-_[\]:]+$/;
// Algorithm lists (Ciphers/KexAlgorithms/MACs): names plus the ssh_config list prefixes ^ + -.
const ALGORITHM_LIST = /^[A-Za-z0-9@.,+^\-_]+$/;

function isValidTunnelPort(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Command prefix that runs proxyCli.cjs. On POSIX it is this app's own binary in Node mode
 * (ELECTRON_RUN_AS_NODE=1 comes from buildProxyEnv, so no shell env-assignment syntax is needed),
 * which works without a system Node.js and can't be hijacked through PATH. Windows keeps the
 * PATH `node`: its ProxyCommand goes through cmd.exe, whose handling of several quoted
 * tokens is unverified here.
 */
function proxyCliLauncher(): string {
  if (process.platform === 'win32') return 'node ';
  // The path is embedded inside double quotes in a shell string; refuse anything the shell
  // would interpret rather than trying to escape it.
  if (/["$`\\\n\r%]/.test(process.execPath)) {
    throw new Error('Cannot build ProxyCommand: application path contains shell-special characters');
  }
  return `"${process.execPath}" `;
}

const PROXY_TYPES = new Set(['http', 'socks4', 'socks5']);

export class SmartcardDetector {
  private static readonly LINUX_LIBRARIES: Array<{ name: string; path: string; platform: 'linux' }> = [
    // p11-kit (prioritized: proxies all system-registered PKCS#11 modules)
    { name: 'p11-kit', path: '/usr/lib64/p11-kit-proxy.so', platform: 'linux' },
    { name: 'p11-kit', path: '/usr/lib/x86_64-linux-gnu/p11-kit-proxy.so', platform: 'linux' },
    { name: 'p11-kit', path: '/usr/lib/p11-kit-proxy.so', platform: 'linux' },
    { name: 'p11-kit', path: '/usr/local/lib/p11-kit-proxy.so', platform: 'linux' },
    // Yubico PIV Tool / YubiKey Manager (libykcs11) — official Yubico PKCS#11
    // module, works out of the box for YubiKey PIV without installing OpenSC.
    // Note: Linux package managers (Fedora/RHEL, Debian/Ubuntu, Arch) package the
    // runtime library with its SONAME (libykcs11.so.2 or libykcs11.so.1); the unversioned
    // .so symlink is only provided when development packages (-devel / -dev) are installed.
    { name: 'YubiKey (libykcs11)', path: '/usr/lib64/libykcs11.so', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib64/libykcs11.so.2', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib64/libykcs11.so.1', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/x86_64-linux-gnu/libykcs11.so', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/x86_64-linux-gnu/libykcs11.so.2', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/x86_64-linux-gnu/libykcs11.so.1', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/aarch64-linux-gnu/libykcs11.so', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/aarch64-linux-gnu/libykcs11.so.2', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/libykcs11.so', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/libykcs11.so.2', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/lib/libykcs11.so.1', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/local/lib/libykcs11.so', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/local/lib/libykcs11.so.2', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/local/lib64/libykcs11.so', platform: 'linux' },
    { name: 'YubiKey (libykcs11)', path: '/usr/local/lib64/libykcs11.so.2', platform: 'linux' },
    // Net iD
    { name: 'Net iD', path: '/usr/lib/libiidp11.so', platform: 'linux' },
    { name: 'Net iD', path: '/usr/lib64/libiidp11.so', platform: 'linux' },
    { name: 'Net iD', path: '/usr/local/lib/libiidp11.so', platform: 'linux' },
    { name: 'Net iD', path: '/usr/lib/x86_64-linux-gnu/libiidp11.so', platform: 'linux' },
    // OpenSC
    { name: 'OpenSC', path: '/usr/lib64/pkcs11/opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib64/pkcs11/onepin-opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib64/opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib64/onepin-opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib/x86_64-linux-gnu/onepin-opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib/x86_64-linux-gnu/pkcs11/opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib/aarch64-linux-gnu/opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib/opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/lib/pkcs11/opensc-pkcs11.so', platform: 'linux' },
    { name: 'OpenSC', path: '/usr/local/lib/opensc-pkcs11.so', platform: 'linux' },
  ];

  private static readonly WINDOWS_LIBRARIES: Array<{ name: string; path: string; platform: 'win32' }> = [
    // Net iD
    { name: 'Net iD', path: 'C:\\Program Files\\Net iD\\iidp11.dll', platform: 'win32' },
    { name: 'Net iD', path: 'C:\\Program Files (x86)\\Net iD\\iidp11.dll', platform: 'win32' },
    // OpenSC — listed before Yubico's module on purpose: the first detected library is what
    // auto-detect and Remote Profile Sync linking pick, and Windows' ssh-agent refuses to load
    // libykcs11 (`ssh-add -s` fails with "agent refused operation" before any PIN reaches the card),
    // while OpenSC drives the same YubiKey PIV applet fine.
    {
      name: 'OpenSC',
      path: 'C:\\Program Files\\OpenSC Project\\OpenSC\\pkcs11\\opensc-pkcs11.dll',
      platform: 'win32',
    },
    {
      name: 'OpenSC',
      path: 'C:\\Program Files (x86)\\OpenSC Project\\OpenSC\\pkcs11\\opensc-pkcs11.dll',
      platform: 'win32',
    },
    {
      name: 'OpenSC',
      path: 'C:\\Program Files\\OpenSC Project\\OpenSC\\pkcs11\\onepin-opensc-pkcs11.dll',
      platform: 'win32',
    },
    {
      name: 'OpenSC',
      path: 'C:\\Program Files (x86)\\OpenSC Project\\OpenSC\\pkcs11\\onepin-opensc-pkcs11.dll',
      platform: 'win32',
    },
    // Yubico PIV Tool / YubiKey Manager (libykcs11) — official Yubico PKCS#11 module. Usable
    // directly with ssh -I, but not through Windows' ssh-agent (see above).
    { name: 'YubiKey (libykcs11)', path: 'C:\\Program Files\\Yubico\\Yubico PIV Tool\\bin\\libykcs11.dll', platform: 'win32' },
    {
      name: 'YubiKey (libykcs11)',
      path: 'C:\\Program Files (x86)\\Yubico\\Yubico PIV Tool\\bin\\libykcs11.dll',
      platform: 'win32',
    },
  ];

  /**
   * Returns a list of known default library paths for a given platform.
   */
  public static getKnownLibraryPaths(
    platform?: 'linux' | 'win32'
  ): Array<{ name: string; path: string; platform: 'linux' | 'win32' }> {
    const targetPlatform = platform ?? (process.platform === 'win32' ? 'win32' : 'linux');
    if (targetPlatform === 'win32') {
      return [...this.WINDOWS_LIBRARIES];
    }
    return [...this.LINUX_LIBRARIES];
  }

  /**
   * Validates whether a file exists at the given path and is a file.
   */
  public static async validateLibraryPath(libraryPath: string): Promise<boolean> {
    if (!libraryPath || typeof libraryPath !== 'string') {
      return false;
    }
    try {
      const stat = await fs.stat(libraryPath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Detects available smartcard PKCS#11 libraries on the system.
   */
  public static async detectAvailableLibraries(
    platform?: 'linux' | 'win32',
    options?: DetectOptions
  ): Promise<DetectedSmartcardLib[]> {
    const targetPlatform = platform ?? (process.platform === 'win32' ? 'win32' : 'linux');
    const candidates = options?.customPaths ?? this.getKnownLibraryPaths(targetPlatform);

    const results: DetectedSmartcardLib[] = await Promise.all(
      candidates.map(async (candidate) => {
        const exists = await this.validateLibraryPath(candidate.path);
        return {
          name: candidate.name,
          path: candidate.path,
          platform: candidate.platform,
          exists,
        };
      })
    );

    if (options?.onlyExisting) {
      const existing = results.filter((lib) => lib.exists);
      const seen = new Set<string>();
      const deduped: DetectedSmartcardLib[] = [];
      for (const lib of existing) {
        let key = `${lib.name}:${lib.path}`;
        try {
          const canonical = await fs.realpath(lib.path);
          key = `${lib.name}:${canonical}`;
        } catch {
          // Fall back to original path if realpath fails
        }
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(lib);
        }
      }
      return deduped;
    }

    return results;
  }

  /**
   * Generates command-line arguments for OpenSSH (ssh) client.
   *
   * Expects `config.pkcs11LibPath` to already be resolved (profile's own value, or this
   * machine's `AppSettings.smartcardLibPath` default substituted in) — see
   * `SmartcardCoordinator.prepareSmartcardConfig`/`prepareSftpSmartcardConfig`, which every
   * caller of this function runs first.
   */
  public static buildSSHArguments(config: SSHConnectionConfig, controlPath?: string): string[] {
    if (!config.host || typeof config.host !== 'string' || config.host.startsWith('-')) {
      throw new Error('Invalid SSH host: host cannot start with "-"');
    }
    // The destination host is also substituted (via ssh's own %h expansion)
    // into the ProxyCommand shell string built below when a proxy is
    // configured, so it must be restricted to safe hostname/IP characters
    // even when no proxy is in use — a config can be edited to add one later.
    if (!isSafeHostToken(config.host)) {
      throw new Error('Invalid SSH host: contains characters not allowed in a hostname');
    }

    const port = config.port ?? 22;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Invalid SSH port: port must be between 1 and 65535');
    }

    const args: string[] = [];

    // OpenSSH connection multiplexing (master mode, Unix only)
    if (controlPath && process.platform !== 'win32') {
      args.push('-o', 'ControlMaster=auto');
      args.push('-o', `ControlPath=${controlPath}`);
      args.push('-o', 'ControlPersist=120');
    }

    // Port argument
    args.push('-p', String(port));

    // Jump host / ProxyJump (-J <proxyJump>)
    if (config.proxyJump && config.proxyJump.trim()) {
      const hops = config.proxyJump.trim().split(',').map((h) => h.trim());
      if (hops.some((h) => h.startsWith('-') || !PROXY_JUMP_HOP.test(h))) {
        throw new Error('Invalid ProxyJump: expected comma-separated [user@]host[:port] entries');
      }
      args.push('-J', hops.join(','));
    }

    // Smartcard authentication
    if (config.authType === 'smartcard' && config.pkcs11LibPath) {
      smartcardLog.info(`buildSSHArguments: authType=smartcard, agentPath=${config.agentPath ?? '(none — using direct -I)'}`
      );
      if (config.agentPath) {
        // A private agent was pre-loaded with the smartcard's key (agent-per-session
        // mode) — authenticate through it instead of a second direct PKCS#11 login,
        // so the PIN is only entered once for the whole session. Deliberately no
        // IdentitiesOnly here: that option restricts ssh to *explicitly configured*
        // identity files, hiding whatever the agent offers (including our just-loaded
        // smartcard key) unless separately referenced with -i — the opposite of what
        // we want. A per-session/per-card agent holds only this one key, so letting ssh
        // use whatever it offers is safe. The app-wide agent holds every unlocked card,
        // though: there `agentIdentityFiles` (public key files) pins the connection to
        // this card's keys — IdentitiesOnly *plus* `-i <key>.pub`, which makes ssh pick
        // the matching agent identity (below, shared by FIDO2 and smartcard).
        //
        // On Windows, `-o IdentityAgent=<named pipe>` is passed to the process env
        // (SSHPtyManager sets SSH_AUTH_SOCK=config.agentPath) instead of as a ssh
        // argument here: confirmed by hand that Win32-OpenSSH 9.5p2's IdentityAgent
        // *config* value can't resolve a raw named-pipe path at all
        // (`ssh_get_authentication_socket: No such file or directory`, reproduced
        // even typed directly in a terminal), while the exact same pipe works
        // perfectly via the SSH_AUTH_SOCK *environment variable*. Passing both would
        // make the (broken) explicit value win and silently fall through to no
        // agent at all.
        if (process.platform !== 'win32') {
          args.push('-o', `IdentityAgent=${config.agentPath}`);
        }
      } else {
        args.push('-I', config.pkcs11LibPath);
        // Prevent the desktop's own ssh-agent/wallet (e.g. gnome-keyring, KWallet)
        // from independently prompting for the same smartcard's PIN alongside
        // our own askpass-driven -I flow.
        args.push('-o', 'IdentitiesOnly=yes');
        args.push('-o', 'IdentityAgent=none');
      }
    } else {
      // Prevent OpenSSH from picking up a PKCS11Provider configured in ~/.ssh/config for this host
      // (e.g. when connecting via FIDO2, password, or privateKey to a host that has a PKCS11Provider defined).
      args.push('-o', 'PKCS11Provider=none');
    }

    // FIDO2 resident-key authentication: the credential was pre-loaded into a private
    // agent by IpcBridge (see prepareFido2Config) since there's no key file on disk to
    // point -i at. A non-resident FIDO2 profile instead has privateKeyPath set and is
    // handled by the generic -i argument below, exactly like a plain SSH key file.
    if (config.authType === 'fido2' && config.fido2Resident && config.agentPath) {
      // See the matching comment on the smartcard branch above for why this is skipped
      // on Windows (SSH_AUTH_SOCK env var instead, set by SSHPtyManager).
      if (process.platform !== 'win32') {
        args.push('-o', `IdentityAgent=${config.agentPath}`);
      }
    }

    // Agent authentication (custom agentPath or SSH CA certificate loaded into app agent)
    if (config.authType === 'agent' && config.agentPath) {
      if (process.platform !== 'win32') {
        args.push('-o', `IdentityAgent=${config.agentPath}`);
      }
    }

    // Shared (app-wide) agent: restrict ssh to this connection's own keys so it neither exhausts the
    // server's MaxAuthTries with every unlocked card's keys nor touches an unrelated security key.
    if (config.agentPath && config.agentIdentityFiles && config.agentIdentityFiles.length > 0) {
      args.push('-o', 'IdentitiesOnly=yes');
      for (const file of config.agentIdentityFiles) {
        args.push('-i', file);
      }
    }

    // Certificate file for SSH CA authentication (e.g. a PIV smartcard paired with a signed cert)
    if (config.certificateFile) {
      if (/[\r\n]/.test(config.certificateFile) || config.certificateFile.startsWith('-')) {
        throw new Error('Invalid CertificateFile: path contains illegal characters');
      }
      args.push('-o', `CertificateFile=${config.certificateFile}`);
    }

    // Identity file / private key argument (-i <path>)
    if (config.privateKeyPath) {
      args.push('-i', config.privateKeyPath);
    }

    // Windows only: the OS has a single shared ssh-agent, which may already hold an unlocked PIV key.
    // ssh offers agent identities before -i, so a FIDO2 key-file profile would silently authenticate
    // with that PIV key instead of the security key. IdentitiesOnly makes it use just this key file.
    if (process.platform === 'win32' && config.authType === 'fido2' && config.privateKeyPath) {
      args.push('-o', 'IdentitiesOnly=yes');
    }

    // Password profiles: don't offer keys from the user's default agent / ~/.ssh. An agent holding a
    // touch- or PIN-protected key (FIDO2, PIV) would otherwise block the login before the
    // password is ever tried.
    if (config.authType === 'password') {
      args.push('-o', 'PubkeyAuthentication=no');
      args.push('-o', 'PreferredAuthentications=password,keyboard-interactive');
    }

    // SSH Agent forwarding (-o ForwardAgent=yes/no)
    if (config.forwardAgent !== undefined) {
      args.push('-o', `ForwardAgent=${config.forwardAgent ? 'yes' : 'no'}`);
    }

    // X11 Forwarding (-Y / ForwardX11Trusted yes)
    if (config.x11Forwarding) {
      args.push('-Y');
    }

    // Compression (-o Compression=yes/no)
    if (config.compression !== undefined) {
      args.push('-o', `Compression=${config.compression ? 'yes' : 'no'}`);
    }

    // ServerAliveInterval (-o ServerAliveInterval=...)
    if (config.serverAliveInterval && config.serverAliveInterval > 0) {
      args.push('-o', `ServerAliveInterval=${config.serverAliveInterval}`);
    }

    // Ciphers (-o Ciphers=...)
    if (config.ciphers?.trim()) {
      if (!ALGORITHM_LIST.test(config.ciphers.trim())) {
        throw new Error('Invalid Ciphers: contains characters not allowed in an algorithm list');
      }
      args.push('-o', `Ciphers=${config.ciphers.trim()}`);
    }

    // KexAlgorithms (-o KexAlgorithms=...)
    if (config.kexAlgorithms?.trim()) {
      if (!ALGORITHM_LIST.test(config.kexAlgorithms.trim())) {
        throw new Error('Invalid KexAlgorithms: contains characters not allowed in an algorithm list');
      }
      args.push('-o', `KexAlgorithms=${config.kexAlgorithms.trim()}`);
    }

    // MACs (-o MACs=...)
    if (config.macs?.trim()) {
      if (!ALGORITHM_LIST.test(config.macs.trim())) {
        throw new Error('Invalid MACs: contains characters not allowed in an algorithm list');
      }
      args.push('-o', `MACs=${config.macs.trim()}`);
    }

    // SSH Tunnels (Port forwarding: -L, -R, -D)
    if (config.tunnels && config.tunnels.length > 0) {
      for (const tunnel of config.tunnels) {
        if (tunnel.enabled === false) continue;
        if (!isValidTunnelPort(tunnel.localPort)) {
          throw new Error(`Invalid tunnel local port: ${String(tunnel.localPort)}`);
        }
        if (tunnel.type !== 'dynamic') {
          if (tunnel.remoteHost && !isSafeHostToken(tunnel.remoteHost)) {
            throw new Error('Invalid tunnel remote host: contains characters not allowed in a hostname');
          }
          if (tunnel.remotePort !== undefined && !isValidTunnelPort(tunnel.remotePort)) {
            throw new Error(`Invalid tunnel remote port: ${String(tunnel.remotePort)}`);
          }
        }
        if (tunnel.type === 'local') {
          args.push('-L', `${tunnel.localPort}:${tunnel.remoteHost || 'localhost'}:${tunnel.remotePort || 80}`);
        } else if (tunnel.type === 'remote') {
          args.push('-R', `${tunnel.localPort}:${tunnel.remoteHost || 'localhost'}:${tunnel.remotePort || 80}`);
        } else if (tunnel.type === 'dynamic') {
          args.push('-D', String(tunnel.localPort));
        }
      }
    }

    // Extra SSH options (-o Key=Value)
    if (config.extraOptions) {
      for (const [key, value] of Object.entries(config.extraOptions)) {
        const trimmedKey = key.trim();
        const trimmedVal = String(value).trim();
        if (!trimmedKey || !trimmedVal) continue;
        // Allowlist, not blocklist: extraOptions may come from a synced/imported profile (see
        // ALLOWED_SSH_EXTRA_OPTIONS). Exact option names only, so a key such as
        // "ProxyCommand touch x #" (ssh splits `-o` at the first whitespace/'=') never matches.
        if (!isAllowedExtraOption(trimmedKey)) {
          smartcardLog.warn(`buildSSHArguments: ignored SSH option not on the allowlist "${trimmedKey}"`);
          continue;
        }
        if (/[\r\n]/.test(trimmedKey) || /[\r\n]/.test(trimmedVal)) {
          smartcardLog.warn(`buildSSHArguments: blocked SSH option with newline "${trimmedKey}"`);
          continue;
        }
        args.push('-o', `${trimmedKey}=${trimmedVal}`);
      }
    }

    // Outgoing proxy option (-o ProxyCommand=...)
    // Always routed through proxyCli.cjs (a small Node script that speaks the
    // HTTP/SOCKS4/SOCKS5 handshake itself) rather than the external `nc`
    // binary, since `nc` isn't available on Windows and isn't guaranteed
    // elsewhere either.
    //
    // SECURITY: OpenSSH always runs the ProxyCommand value through a shell
    // (`/bin/sh -c` / `cmd.exe`), even though `ssh` itself is spawned here
    // via an argv array with no shell involved. Every piece of this string
    // must therefore either be a fixed, app-controlled literal, or be
    // strictly validated against a safe charset before interpolation —
    // proxy username/password are user-supplied free text (and, via profile
    // sync, potentially attacker-supplied), so they are never embedded in
    // the command string at all and are instead passed to proxyCli.cjs
    // through the child process's environment (see the env vars set in
    // SSHPtyManager), which involves no shell parsing.
    if (config.proxy?.enabled && config.proxy.host) {
      const p = config.proxy;

      if (!PROXY_TYPES.has(p.type)) {
        throw new Error(`Invalid proxy type: ${String(p.type)}`);
      }
      if (!isSafeHostToken(p.host)) {
        throw new Error('Invalid proxy host: contains characters not allowed in a hostname');
      }
      const port = p.port || (p.type === 'http' ? 8080 : 1080);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Invalid proxy port: port must be between 1 and 65535');
      }

      const currentDir =
        typeof __dirname !== 'undefined'
          ? __dirname
          : path.dirname(fileURLToPath(import.meta.url));
      const devPath = path.resolve(currentDir, '../proxy/proxyCli.cjs');
      const distPath = path.resolve(currentDir, 'proxyCli.cjs');
      const cliPath = fsSync.existsSync(distPath) ? distPath : devPath;
      args.push('-o', `ProxyCommand=${proxyCliLauncher()}"${cliPath}" ${p.type} ${p.host} ${port} %h %p`);
    }

    // Destination target (username@host or host), preceded by '--' to prevent flag injection
    const destination = config.username ? `${config.username}@${config.host}` : config.host;
    args.push('--');
    args.push(destination);

    return args;
  }

  /**
   * Environment variables carrying the proxy username/password for
   * proxyCli.cjs (invoked as the SSH ProxyCommand). Passed via the child
   * process environment rather than the ProxyCommand string itself so that
   * arbitrary characters in these fields (quotes, `$`, backticks, `;`, ...)
   * can never be interpreted by the shell that OpenSSH uses to run
   * ProxyCommand — see the comment in buildSSHArguments.
   */
  public static buildProxyEnv(config: SSHConnectionConfig): Record<string, string> {
    if (!config.proxy?.enabled || !config.proxy.host) {
      return {};
    }
    const env: Record<string, string> = {};
    // proxyCli.cjs is launched through this app's own binary in Node mode (see proxyCliLauncher).
    if (process.platform !== 'win32') env.ELECTRON_RUN_AS_NODE = '1';
    if (config.proxy.username) env.SSHS3_PROXY_USERNAME = config.proxy.username;
    if (config.proxy.password) env.SSHS3_PROXY_PASSWORD = config.proxy.password;
    return env;
  }
}
