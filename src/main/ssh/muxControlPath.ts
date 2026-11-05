import crypto from 'node:crypto';
import path from 'node:path';
import { ensureSecureDir, resolveAppAgentDir } from './AppAgent';

/** sun_path is 104 bytes on macOS/BSD (108 on Linux); ssh also appends a 17-character temp suffix while it binds. */
const SOCKET_PATH_LIMIT = 104;
const SSH_BIND_SUFFIX = 17;

/**
 * The ControlPath for one multiplexed ssh connection inside `dir`, or undefined when even a short name would not
 * fit in a Unix socket path (ssh would refuse to start; better to connect without multiplexing).
 */
export function buildMuxControlPath(dir: string, id: string): string | undefined {
  for (const name of [`s3m-${id}.sock`, `m-${id.slice(0, 4)}.sock`]) {
    const candidate = path.join(dir, name);
    if (Buffer.byteLength(candidate) + SSH_BIND_SUFFIX < SOCKET_PATH_LIMIT) return candidate;
  }
  return undefined;
}

/**
 * A fresh multiplexing socket path in the app's private folder (the same 0700, owner-checked folder as the app
 * ssh-agent socket), never in the shared temp folder where another user could pre-create or watch the name.
 * Undefined when that folder cannot be used safely or the path would be too long: the connection then simply
 * runs without multiplexing.
 */
export async function createMuxControlPath(): Promise<string | undefined> {
  const dir = resolveAppAgentDir();
  try {
    await ensureSecureDir(dir);
  } catch {
    return undefined;
  }
  return buildMuxControlPath(dir, crypto.randomUUID().slice(0, 8));
}
