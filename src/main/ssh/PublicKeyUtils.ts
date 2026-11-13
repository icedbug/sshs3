import crypto from 'node:crypto';
import type { ProbeErrorKind } from '../../shared/types/ssh';

/** Key types that may be installed. Certificates (`*-cert-v01@openssh.com`) and unknown types are rejected. */
const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
]);
const BASE64_BLOB = /^[A-Za-z0-9+/]{16,}={0,3}$/;
/** The comment is limited to printable ASCII. */
const SAFE_COMMENT = /^[\x20-\x7e]{0,200}$/;

export interface ParsedPublicKey {
  /** Normalized line: `<type> <base64>[ <comment>]`. */
  line: string;
  type: string;
  /** OpenSSH fingerprint, `SHA256:...`. */
  fingerprint: string;
  comment: string;
  base64: string;
}

/** Parses a public key line. Returns null unless it is a plain, single-line public key without an options prefix. */
export function parsePublicKeyLine(raw: string): ParsedPublicKey | null {
  if (typeof raw !== 'string' || /[\r\n\0]/.test(raw.trim())) return null;
  const line = raw.trim();
  // `<type> <base64> [comment]`: a single line, no options prefix.
  const [type, base64, ...rest] = line.split(' ');
  const comment = rest.join(' ');
  if (!KEY_TYPES.has(type) || !BASE64_BLOB.test(base64 ?? '') || !SAFE_COMMENT.test(comment)) return null;
  const blob = Buffer.from(base64, 'base64');
  if (blob.length < 12) return null;
  // The key blob starts with a length-prefixed type string that must match the type on the line.
  const typeLen = blob.readUInt32BE(0);
  if (typeLen > blob.length - 4 || blob.subarray(4, 4 + typeLen).toString('latin1') !== type) return null;
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { line: comment ? `${type} ${base64} ${comment}` : `${type} ${base64}`, type, fingerprint, comment, base64 };
}

/** The same `ssh-add -L` / `.pub` text as several keys; invalid lines are skipped. */
export function parsePublicKeyLines(text: string): ParsedPublicKey[] {
  const out: ParsedPublicKey[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const parsed = parsePublicKeyLine(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * POSIX script that runs on the target host. Reads one key per line from stdin and appends each to
 * `~/.ssh/authorized_keys` unless the blob is already there. Prints `S3M:<n>:installed|present` per line.
 * Must not contain single quotes: it runs as `sh -c '<script>'` so that fish/csh as the login shell
 * can handle it too.
 */
const REMOTE_SCRIPT =
  'umask 077; ' +
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys || exit 1; ' +
  '[ -z "$(tail -c1 ~/.ssh/authorized_keys)" ] || echo >> ~/.ssh/authorized_keys; ' +
  'i=0; ' +
  'while IFS= read -r k; do ' +
  'i=$((i+1)); [ -n "$k" ] || continue; ' +
  'b=$(printf "%s" "$k" | cut -d" " -f2); ' +
  'if grep -qF -- "$b" ~/.ssh/authorized_keys; then echo "S3M:$i:present"; ' +
  'else printf "%s\\n" "$k" >> ~/.ssh/authorized_keys && echo "S3M:$i:installed"; fi; ' +
  'done; ' +
  'command -v restorecon >/dev/null 2>&1 && restorecon -R ~/.ssh >/dev/null 2>&1 || true';

export const REMOTE_INSTALL_COMMAND = `sh -c '${REMOTE_SCRIPT}'`;

/** Quotes a string for a POSIX shell with single quotes. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * A readable command to paste on the host when it cannot be reached from the app. Does only what
 * `ssh-copy-id` does: creates `~/.ssh/authorized_keys` with the right permissions and adds each key
 * that is not there yet. Throws if any key is invalid.
 */
export function buildInstallCommand(publicKeys: string[]): string {
  const parsed = publicKeys.map((k) => {
    const p = parsePublicKeyLine(k);
    if (!p) throw new Error('Invalid public key');
    return p;
  });
  if (parsed.length === 0) throw new Error('No key selected');
  const noun = parsed.length === 1 ? 'key' : 'keys';
  return [
    `# Adds ${parsed.length} public ${noun} to ~/.ssh/authorized_keys (same as ssh-copy-id). Nothing else is changed.`,
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys',
    '[ -z "$(tail -c1 ~/.ssh/authorized_keys)" ] || echo >> ~/.ssh/authorized_keys',
    ...parsed.map((p) => `grep -qF ${shQuote(p.base64)} ~/.ssh/authorized_keys || echo ${shQuote(p.line)} >> ~/.ssh/authorized_keys`),
  ].join('\n');
}

export type InstallLineStatus = 'installed' | 'present';

/** Parses the `S3M:<n>:<status>` lines from the remote script into a status per (1-based) key index. */
export function parseInstallOutput(stdout: string): Map<number, InstallLineStatus> {
  const map = new Map<number, InstallLineStatus>();
  for (const m of stdout.matchAll(/^S3M:(\d+):(installed|present)\s*$/gm)) {
    map.set(Number(m[1]), m[2] as InstallLineStatus);
  }
  return map;
}

/**
 * Is the private key passphrase-protected? Covers the OpenSSH format (cipher name != "none") and
 * PEM (`ENCRYPTED`). An unknown format counts as encrypted so that we never try to verify needlessly.
 */
export function isPrivateKeyEncrypted(text: string): boolean {
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(text); // pragma: allowlist secret
  if (m) {
    const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
    const magic = 'openssh-key-v1\0';
    if (buf.length < magic.length + 4 || buf.subarray(0, magic.length).toString('latin1') !== magic) return true;
    const len = buf.readUInt32BE(magic.length);
    const cipher = buf.subarray(magic.length + 4, magic.length + 4 + len).toString('latin1');
    return cipher !== 'none';
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return /ENCRYPTED/.test(text);
  return true;
}

export interface ParsedProbe {
  reachable: boolean;
  methods: string[];
  hostKeyChanged: boolean;
  errorKind?: ProbeErrorKind;
  error?: string;
}

/**
 * Parses stderr from `ssh -o PreferredAuthentications=none ... true`. `Permission denied (publickey,password).`
 * means the host was reached and lists the methods it allows; other messages are classified as error causes.
 */
export function parseProbeOutput(stderr: string, exitCode: number | null): ParsedProbe {
  if (exitCode === 0) return { reachable: true, methods: ['none'], hostKeyChanged: false };

  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return {
      reachable: true,
      methods: [],
      hostKeyChanged: true,
      errorKind: 'hostkey-changed',
      error: 'The host key has changed. This can mean the host was reinstalled, or that someone is intercepting the connection.',
    };
  }
  const denied = /Permission denied \(([^)]*)\)/i.exec(stderr);
  if (denied) {
    const methods = denied[1]
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    return { reachable: true, methods, hostKeyChanged: false };
  }

  const lastLine = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ').trim();
  const classify = (kind: ProbeErrorKind, error: string): ParsedProbe => ({
    reachable: false,
    methods: [],
    hostKeyChanged: false,
    errorKind: kind,
    error,
  });
  if (/Could not resolve hostname/i.test(stderr)) return classify('dns', 'The host name could not be resolved.');
  if (/Connection refused/i.test(stderr)) return classify('refused', 'The host refused the connection (is SSH running on that port?).');
  if (/timed out|Connection timeout/i.test(stderr)) return classify('timeout', 'The connection timed out.');
  if (/No route to host|Network is unreachable/i.test(stderr)) return classify('unreachable', 'There is no network route to the host.');
  if (/Host key verification failed/i.test(stderr)) {
    return { ...classify('hostkey-rejected', 'The host key was not trusted.'), reachable: true };
  }
  if (/Connection closed by|kex_exchange_identification|stdio forwarding failed|channel \d+: open failed/i.test(stderr)) {
    return classify('closed', 'The connection was closed before login (check the jump host and its access to the target).');
  }
  return classify('unknown', lastLine || `ssh exited with code ${exitCode}`);
}

// Shared with the renderer, which shows the order to the user.
export { chooseLoginOrder } from '../../shared/loginOrder';
