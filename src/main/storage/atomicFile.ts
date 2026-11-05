import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // On Windows a virus scanner or indexer can hold the target open for a moment; a short wait normally clears it.
      if (process.platform !== 'win32' || attempt >= RENAME_ATTEMPTS || !code || !RENAME_RETRY_CODES.has(code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

/**
 * Writes `data` so that a reader (or a crash) sees either the old file or the new one, never a truncated mix:
 * a temp file in the same directory is written, fsynced and renamed over the target. A symlink at `filePath` is
 * followed, so the link stays a link (`~/.ssh/config` is often one). The file mode is `options.mode`, else the
 * existing file's mode, else 0600. The parent directory is created if missing.
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Uint8Array,
  options: { mode?: number } = {}
): Promise<void> {
  let target = filePath;
  try {
    target = await fs.realpath(filePath);
  } catch {
    // Does not exist yet (or a dangling link): write to the path as given.
  }
  await fs.mkdir(path.dirname(target), { recursive: true });

  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = (await fs.stat(target)).mode & 0o777;
    } catch {
      mode = 0o600;
    }
  }

  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'wx', mode);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The open() mode is subject to the umask and ignored for an existing file; set it explicitly.
    await fs.chmod(tmp, mode).catch(() => {
      // Non-POSIX filesystem.
    });
    await renameWithRetry(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

  if (process.platform !== 'win32') {
    // Make the rename itself durable. Best effort: not every filesystem allows fsync on a directory.
    try {
      const dir = await fs.open(path.dirname(target), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // Ignore.
    }
  }
}

/**
 * Keeps a copy of a config file that could not be parsed, as `<file>.corrupt`, before the caller falls back to
 * defaults (whose next save would otherwise overwrite the only copy). Best effort; never throws.
 */
export async function backupCorruptFile(filePath: string, raw: string): Promise<void> {
  try {
    await writeFileAtomic(`${filePath}.corrupt`, raw, { mode: 0o600 });
  } catch {
    // Best effort only.
  }
}
