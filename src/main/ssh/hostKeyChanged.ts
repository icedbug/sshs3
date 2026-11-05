import { execFile } from 'node:child_process';
import type { HostKeyPromptInfo } from './HostKeyVerifier';

export interface HostKeyChangedInfo {
  keyType: string;
  fingerprint: string;
}

// eslint-disable-next-line no-control-regex -- strips terminal escape sequences from ssh's PTY output
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * True when a session's output contains OpenSSH's "REMOTE HOST IDENTIFICATION HAS CHANGED" warning.
 * Terminal output is attacker-influenced (a remote shell can print the same text), so this is only a
 * trigger: whether the key really changed is decided by `probeChangedHostKey`, never by this text.
 */
export function isHostKeyChangedOutput(output: string): boolean {
  return /REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output.replace(ANSI_RE, ''));
}

/** The known_hosts pattern OpenSSH stores a host under: `host`, or `[host]:port` for a non-default port. */
export function knownHostsPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Rejects hosts that ssh tools could parse as a flag or that smuggle whitespace/control characters. */
function assertSafeHost(host: string): void {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (!host || /^-|[\s\x00-\x1f]/.test(host)) throw new Error('Invalid host name');
}

const keygenBinary = () => (process.platform === 'win32' ? 'ssh-keygen.exe' : 'ssh-keygen');
const keyscanBinary = () => (process.platform === 'win32' ? 'ssh-keyscan.exe' : 'ssh-keyscan');

/**
 * Parses `ssh-keygen` fingerprint output into keyType -> fingerprint. Two formats occur: `-l -f` prints
 * "256 SHA256:xxx host (ED25519)", while `-F <host> -l` prints "host ED25519 SHA256:xxx".
 */
export function parseKeygenFingerprints(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of output.split('\n')) {
    const text = line.trim();
    const m = /^\d+ (SHA256:\S+) .*\((\S+)\)$/.exec(text);
    if (m) {
      result.set(m[2], m[1]);
      continue;
    }
    const f = /^\S+ (\S+) (SHA256:\S+)$/.exec(text);
    if (f) result.set(f[1], f[2]);
  }
  return result;
}

/**
 * The first scanned key whose type is already in known_hosts with a different fingerprint. Key types
 * known_hosts does not have yet are not a change (OpenSSH's UpdateHostKeys adds those).
 */
export function findChangedKey(known: Map<string, string>, scanned: Map<string, string>): HostKeyChangedInfo | null {
  for (const [keyType, fingerprint] of scanned) {
    const stored = known.get(keyType);
    if (stored !== undefined && stored !== fingerprint) return { keyType, fingerprint };
  }
  return null;
}

function run(binary: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/**
 * Checks independently of the session's terminal output whether the host's key differs from the one in
 * known_hosts: scans the host's keys directly and compares fingerprints. Null when the key is unchanged
 * or cannot be checked (unreachable host, jump host or proxy in between).
 */
export async function probeChangedHostKey(host: string, port: number): Promise<HostKeyChangedInfo | null> {
  try {
    assertSafeHost(host);
    const known = parseKeygenFingerprints(await run(keygenBinary(), ['-F', knownHostsPattern(host, port), '-l']));
    if (known.size === 0) return null;
    const scannedKeys = await run(keyscanBinary(), ['-T', '5', '-p', String(port), '--', host]);
    const scanned = parseKeygenFingerprints(await run(keygenBinary(), ['-l', '-f', '-'], scannedKeys));
    return findChangedKey(known, scanned);
  } catch {
    return null;
  }
}

/** Removes every known_hosts entry for the host (`ssh-keygen -R`), so the next connection asks about the new key. */
export async function removeKnownHost(host: string, port: number): Promise<void> {
  assertSafeHost(host);
  await run(keygenBinary(), ['-R', knownHostsPattern(host, port)]);
}

export interface HostKeyChangedDeps {
  promptHostKeyTrust: (info: HostKeyPromptInfo) => Promise<boolean>;
  /** Writes a notice into the session's terminal. */
  notify: (message: string) => void;
  probeChangedHostKey?: (host: string, port: number) => Promise<HostKeyChangedInfo | null>;
  removeKnownHost?: (host: string, port: number) => Promise<void>;
}

/**
 * Confirms the key change independently, then asks whether to replace the stored key; on yes removes the
 * old entry so the next connect re-verifies. The fingerprint shown comes from the probe, not the terminal.
 */
export async function handleHostKeyChanged(
  target: { host: string; port: number },
  deps: HostKeyChangedDeps
): Promise<boolean> {
  const changed = await (deps.probeChangedHostKey ?? probeChangedHostKey)(target.host, target.port);
  if (!changed) {
    deps.notify(
      `\r\n\x1b[33m[sshs3: could not confirm the key change independently. ` +
        `To replace the stored key yourself, run: ssh-keygen -R ${knownHostsPattern(target.host, target.port)}]\x1b[0m\r\n`
    );
    return false;
  }
  const replace = await deps.promptHostKeyTrust({
    host: target.host,
    port: target.port,
    keyType: changed.keyType,
    fingerprint: changed.fingerprint,
    status: 'mismatch',
  });
  if (!replace) return false;
  try {
    await (deps.removeKnownHost ?? removeKnownHost)(target.host, target.port);
  } catch (err) {
    deps.notify(`\r\n\x1b[31m[sshs3: could not remove the old host key: ${(err as Error).message}]\x1b[0m\r\n`);
    return false;
  }
  deps.notify(
    `\r\n\x1b[32m[sshs3: old host key for ${target.host} removed. Reconnect to verify and trust the new key.]\x1b[0m\r\n`
  );
  return true;
}
