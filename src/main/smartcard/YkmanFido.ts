import { spawn } from 'node:child_process';
import { withPkcs11Lock } from './Pkcs11Lock';

export interface YkmanFidoCredential {
  credentialId: string;
  rpId: string;
  userName: string;
  userDisplayName: string;
}

/**
 * Runs a `ykman` subcommand, feeding the FIDO2 PIN over stdin (matching
 * ykman's own interactive prompt, confirmed by hand: with `--pin` omitted it
 * reads a line from stdin via `getpass`, tty or not) rather than passing it
 * as a `-P`/`--pin` argument — an argv value is visible to any other local
 * process via `/proc/<pid>/cmdline` or `ps`, a stdin pipe we control is not.
 */
function runYkman(args: string[], pin: string, timeoutMs = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('ykman', args);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // ykman may exit before it reads the PIN; that surfaces as EPIPE here and as a non-zero exit via 'close' below.
    child.stdin.on('error', () => {});
    child.stdin.write(`${pin}\n`);
    child.stdin.end();

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`ykman ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

export function isYkmanAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ykman', ['--version']);
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Parses one line of RFC4180-ish CSV as emitted by `ykman`'s own `csv.writer`
 * (Python's stdlib csv module) — quotes a field only when it contains a
 * comma, quote, or newline, and escapes an embedded quote by doubling it.
 * A naive `split(',')` would break the moment a user's display name
 * contains a comma.
 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Lists the FIDO2 discoverable credentials on the connected YubiKey via
 * `ykman fido credentials list --csv` — unlike `ssh-add -K` (see
 * Fido2KeyManager.listFido2ResidentKeys), this gives back a stable
 * `credentialId` per entry, which is what `ykman ... credentials delete`
 * needs, plus the human-readable `rpId` (the `-O application=` scope set at
 * generation time) instead of just a raw SSH key fingerprint.
 */
export async function listYkmanFidoCredentials(pin: string): Promise<YkmanFidoCredential[]> {
  const stdout = await withPkcs11Lock(() => runYkman(['fido', 'credentials', 'list', '--csv'], pin));
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return [];
  lines.shift(); // header: credential_id,rp_id,user_name,user_display_name,user_id
  return lines.map((line) => {
    const [credentialId, rpId, userName, userDisplayName] = parseCsvLine(line);
    return { credentialId, rpId, userName, userDisplayName };
  });
}

/**
 * Deletes one FIDO2 discoverable credential from the connected YubiKey by
 * its full credential ID. `--force` skips ykman's own interactive
 * confirmation prompt — the app's own UI is expected to have already
 * confirmed this with the user before calling this.
 */
export async function deleteYkmanFidoCredential(credentialId: string, pin: string): Promise<void> {
  await withPkcs11Lock(() => runYkman(['fido', 'credentials', 'delete', credentialId, '--force'], pin));
}
