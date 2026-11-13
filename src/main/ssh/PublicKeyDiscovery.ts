import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LocalPublicKey, PublicKeySource } from '../../shared/types/ssh';
import { parsePublicKeyLines } from './PublicKeyUtils';

const execFileAsync = promisify(execFile);

const MAX_PUB_FILES = 100;
const MAX_PUB_BYTES = 16 * 1024;

function toLocalKey(
  p: ReturnType<typeof parsePublicKeyLines>[number],
  source: PublicKeySource,
  label: string,
  privateKeyPath?: string
): LocalPublicKey {
  return {
    id: p.fingerprint,
    line: p.line,
    type: p.type,
    fingerprint: p.fingerprint,
    comment: p.comment,
    source,
    label,
    privateKeyPath,
  };
}

/** `~/.ssh/*.pub` plus `<privateKeyPath>.pub` for a profile's key file. Invalid files are skipped. */
export async function listFilePublicKeys(extraPrivateKeyPath?: string, homeDir?: string): Promise<LocalPublicKey[]> {
  const sshDir = path.join(homeDir || os.homedir(), '.ssh');
  const pubFiles = new Set<string>();
  if (extraPrivateKeyPath?.trim()) pubFiles.add(`${extraPrivateKeyPath.trim()}.pub`);
  try {
    const names = await fs.readdir(sshDir);
    for (const name of names.filter((n) => n.endsWith('.pub')).slice(0, MAX_PUB_FILES)) {
      pubFiles.add(path.join(sshDir, name));
    }
  } catch {
    // no ~/.ssh
  }

  const keys: LocalPublicKey[] = [];
  for (const file of pubFiles) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_PUB_BYTES) continue;
      const parsed = parsePublicKeyLines(await fs.readFile(file, 'utf-8'));
      // A .pub file normally holds one key; the private key is assumed to sit beside it without .pub.
      for (const p of parsed.slice(0, 1)) {
        const priv = file.slice(0, -'.pub'.length);
        const hasPriv = await fs
          .stat(priv)
          .then((s) => s.isFile())
          .catch(() => false);
        keys.push(toLocalKey(p, 'file', path.basename(file), hasPriv ? priv : undefined));
      }
    } catch {
      // unreadable file
    }
  }
  return keys;
}

/** Public keys held by an ssh-agent (`ssh-add -L`). An empty list if the agent is missing or empty. */
export async function listAgentPublicKeys(
  source: PublicKeySource,
  label: string,
  socketPath?: string
): Promise<LocalPublicKey[]> {
  const env = { ...process.env } as Record<string, string>;
  if (socketPath) env.SSH_AUTH_SOCK = socketPath;
  if (!env.SSH_AUTH_SOCK) return [];
  const bin = process.platform === 'win32' ? 'ssh-add.exe' : 'ssh-add';
  const { stdout } = await execFileAsync(bin, ['-L'], { env, timeout: 15000 }).catch(() => ({ stdout: '' }));
  return parsePublicKeyLines(stdout).map((p) => toLocalKey(p, source, p.comment || label));
}

/** Which source gets to "own" a key found in several places: hardware first, the agent last. */
const SOURCE_PRIORITY: Record<PublicKeySource, number> = {
  smartcard: 4,
  fido2: 4,
  file: 3,
  agent: 2,
  manual: 1,
  github: 1,
  gitlab: 1,
  'git-custom': 1,
};

/**
 * Merges lists and removes duplicates by fingerprint. The same key is often in the desktop's agent,
 * in a file and on the card at once; the source with the highest priority is kept (card/FIDO2 > file > agent),
 * but the path to a private key file is preserved from the occurrence that has one.
 */
export function dedupeKeys(...lists: LocalPublicKey[][]): LocalPublicKey[] {
  const seen = new Map<string, LocalPublicKey>();
  for (const k of lists.flat()) {
    const existing = seen.get(k.fingerprint);
    if (!existing) {
      seen.set(k.fingerprint, { ...k });
      continue;
    }
    const privateKeyPath = existing.privateKeyPath ?? k.privateKeyPath;
    if (SOURCE_PRIORITY[k.source] > SOURCE_PRIORITY[existing.source]) {
      seen.set(k.fingerprint, { ...k, privateKeyPath });
    } else {
      existing.privateKeyPath = privateKeyPath;
    }
  }
  return [...seen.values()];
}
