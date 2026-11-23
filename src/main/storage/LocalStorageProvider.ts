import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  BaseStorageProvider,
  formatDate,
  getMimeType,
} from './StorageProvider';
import { buildAttribFlags, parseAttribOutput, unappliedAttributes } from './winAttributes';
import type {
  FileEntry,
  SpaceInfo,
  StorageType,
  VolumeInfo,
  WinAttributes,
  WriteStreamOptions,
} from '../../shared/types/storage';
import { defineTargetSettled, defineTargetTouched } from './targetTouched';
import { isInside } from '../web/tenantBoundary';

const execFileAsync = promisify(execFile);

export interface LocalStorageProviderOptions {
  id?: string;
  name?: string;
  basePath?: string;
  /**
   * Web server only: `basePath` is one account's folder, and nothing outside it may be reached. Every
   * path is then followed through links before it is used, the home folder is the base folder, and the
   * server's disks are not listed.
   */
  confined?: boolean;
}

/**
 * Windows has no real POSIX permission bits — Node synthesizes a mode from
 * just the read-only file attribute, so showing it as a raw octal number
 * (e.g. "666") is meaningless there. Show the read-only attribute in plain
 * words instead, and keep the real octal mode on POSIX platforms.
 */
function formatPermissions(mode: number): string {
  if (process.platform === 'win32') {
    return (mode & 0o200) === 0 ? 'Read-only' : '';
  }
  return (mode & 0o777).toString(8).padStart(3, '0');
}

/** Filesystem types that are never worth listing as a volume (Linux /proc/self/mounts). */
const PSEUDO_FS = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'pstore', 'bpf', 'debugfs',
  'tracefs', 'securityfs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'autofs', 'binfmt_misc',
  'overlay', 'squashfs', 'efivarfs', 'ramfs', 'nsfs', 'rpc_pipefs', 'fuse.gvfsd-fuse', 'fuse.portal',
]);

/** A drive that is offline (disconnected network share, empty card reader) can block statfs for a long time. */
const STATFS_TIMEOUT_MS = 2000;

async function spaceOf(dir: string): Promise<SpaceInfo | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const st = await Promise.race([
      fsp.statfs(dir),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('statfs timeout')), STATFS_TIMEOUT_MS);
      }),
    ]);
    if (!st.blocks) return undefined;
    return { totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** /proc/self/mounts escapes space, tab, newline and backslash as octal (\040). */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Probes Windows drive roots in an isolated child process so offline network
 * shares cannot block the main process's 4-thread libuv pool inside `statfs`.
 */
const WIN_STATFS_PROBE_SCRIPT = [
  "const fs = require('node:fs/promises');",
  'Promise.all(process.argv.slice(1).map(async (p) => {',
  '  try {',
  '    const st = await fs.statfs(p);',
  '    if (st.blocks) process.stdout.write(JSON.stringify({ path: p, totalBytes: st.blocks * st.bsize, freeBytes: st.bavail * st.bsize }) + "\\n");',
  '  } catch {',
  '    // Offline or unreadable drive',
  '  }',
  '}));',
].join('\n');

async function getWindowsDriveCandidates(): Promise<Array<{ path: string; label: string }>> {
  try {
    const { stdout } = await execFileAsync('fsutil', ['fsinfo', 'drives'], {
      timeout: STATFS_TIMEOUT_MS,
      windowsHide: true,
    });
    const matches = stdout.match(/[A-Za-z]:\\/g);
    if (matches && matches.length > 0) {
      const seen = new Set<string>();
      const drives: Array<{ path: string; label: string }> = [];
      for (const m of matches) {
        const upper = `${m[0].toUpperCase()}:\\`;
        if (seen.has(upper)) continue;
        seen.add(upper);
        drives.push({ path: upper, label: `${upper[0]}:` });
      }
      return drives;
    }
  } catch {
    // Fall back to probing all drive letters if fsutil is unavailable.
  }
  return Array.from({ length: 26 }, (_, i) => {
    const letter = String.fromCharCode(65 + i);
    return { path: `${letter}:\\`, label: `${letter}:` };
  });
}

async function listWindowsVolumes(): Promise<VolumeInfo[]> {
  const candidates = await getWindowsDriveCandidates();
  if (candidates.length === 0) return [];
  const labelByPath = new Map(candidates.map((c) => [c.path, c.label]));
  const found = new Map<string, VolumeInfo>();

  await new Promise<void>((resolve) => {
    let settled = false;
    let buf = '';
    const child = spawn(
      process.execPath,
      ['-e', WIN_STATFS_PROBE_SCRIPT, ...candidates.map((c) => c.path)],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          UV_THREADPOOL_SIZE: String(Math.max(4, candidates.length)),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      }
    );

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore if already exited.
      }
      finish();
    }, STATFS_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      buf += chunk.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { path?: string; totalBytes?: number; freeBytes?: number };
          if (parsed.path && typeof parsed.totalBytes === 'number' && typeof parsed.freeBytes === 'number') {
            const label = labelByPath.get(parsed.path) ?? parsed.path.slice(0, 2);
            found.set(parsed.path, {
              path: parsed.path,
              label,
              totalBytes: parsed.totalBytes,
              freeBytes: parsed.freeBytes,
            });
          }
        } catch {
          // Ignore malformed probe output.
        }
      }
    });

    child.on('error', finish);
    child.on('close', finish);
  });

  return candidates.flatMap((c) => {
    const info = found.get(c.path);
    return info ? [info] : [];
  });
}

/** Max concurrent stat() calls while listing a directory (bounded to stay clear of EMFILE). */
const LIST_STAT_CONCURRENCY = 32;

export class LocalStorageProvider extends BaseStorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageType = 'local';
  readonly basePath?: string;
  /** See LocalStorageProviderOptions.confined. */
  readonly confined: boolean;

  constructor(options?: LocalStorageProviderOptions | string, name?: string) {
    super();
    this.confined = typeof options === 'object' && options !== null && options.confined === true && !!options.basePath;
    if (typeof options === 'object' && options !== null) {
      this.id = options.id ?? 'local';
      this.name = options.name ?? 'Local Storage';
      this.basePath = options.basePath ? path.resolve(options.basePath) : undefined;
    } else {
      this.id = options ?? 'local';
      this.name = name ?? 'Local Storage';
      this.basePath = undefined;
    }
  }

  /**
   * Resolves a path against basePath if relative, or normalizes it if absolute.
   * Supports Linux (/) and Windows (C:\) paths.
   *
   * When basePath is set, it's a hard sandbox boundary, not just a base for
   * relative paths: an absolute remotePath elsewhere on disk, or a relative
   * one whose "../" segments walk outside it, must never resolve to a path
   * outside basePath. Every read/write/list/delete method in this class
   * goes through this one function, so the check lives here once rather
   * than being (easy to forget to) repeated at every call site.
   */
  public resolvePath(remotePath: string): string {
    const resolved = this.resolveUnchecked(remotePath);
    if (this.basePath) {
      const withSep = this.basePath.endsWith(path.sep) ? this.basePath : this.basePath + path.sep;
      if (resolved !== this.basePath && !resolved.startsWith(withSep)) {
        throw new Error(`Path is outside the allowed base directory: ${remotePath}`);
      }
      // The check above reads the path as text. A link inside the folder (unpacked from an archive, say)
      // can still lead out of it, so on a web server the path is followed to where it really is.
      if (this.confined && !isInside(this.basePath, resolved)) {
        throw new Error(`Path is outside the allowed base directory: ${remotePath}`);
      }
    }
    return resolved;
  }

  private resolveUnchecked(remotePath: string): string {
    if (!remotePath) {
      return this.basePath ?? process.cwd();
    }
    // Detect Windows drive root like C:\ or C:/ even on non-Windows environments
    if (/^[a-zA-Z]:[/\\]/.test(remotePath)) {
      return path.normalize(remotePath);
    }
    if (path.isAbsolute(remotePath)) {
      return path.normalize(remotePath);
    }
    if (this.basePath) {
      return path.resolve(this.basePath, remotePath);
    }
    return path.resolve(remotePath);
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const fullPath = this.resolvePath(remotePath);
    const stats = await fsp.stat(fullPath);

    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${remotePath}`);
    }

    const entries = await fsp.readdir(fullPath, { withFileTypes: true });
    const results: FileEntry[] = new Array(entries.length);

    // stat() each entry with bounded concurrency: a sequential await per entry costs ~70 µs of
    // libuv round trip each (≈0.7 s for 10 000 files), unbounded Promise.all risks EMFILE.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const index = next++;
        const entry = entries[index];
        const entryFullPath = path.join(fullPath, entry.name);
        const entryRelativePath = path.join(remotePath, entry.name);
        // Dirent.isSymbolicLink() reflects lstat, not the stat() below (which
        // follows the link) — this is the only way to know an entry is a
        // symlink at all, since a followed stat() reports the target's own
        // type instead (see the H6 code-review finding).
        const isSymlink = entry.isSymbolicLink();

        try {
          // On a web server a link is listed as a link and never followed: what it points at may be outside.
          if (this.confined && isSymlink) throw new Error('A link is not followed here');
          const itemStats = await fsp.stat(entryFullPath);
          const isDir = itemStats.isDirectory();
          results[index] = {
            name: entry.name,
            path: entryRelativePath,
            size: itemStats.size,
            isDirectory: isDir,
            isSymlink,
            // FIFO, socket or device (after following a link, so a link to one counts too): reading it blocks.
            isSpecial: !isDir && !itemStats.isFile(),
            mtime: formatDate(itemStats.mtime),
            mtimeMs: itemStats.mtime.getTime(),
            mimeType: isDir ? undefined : getMimeType(entry.name),
            permissions: formatPermissions(itemStats.mode),
          };
        } catch {
          // Fallback for unreadable items / broken symlinks
          const isDir = entry.isDirectory();
          results[index] = {
            name: entry.name,
            path: entryRelativePath,
            size: 0,
            isDirectory: isDir,
            isSymlink,
            isSpecial: !isDir && !isSymlink && !entry.isFile(),
            mimeType: isDir ? undefined : getMimeType(entry.name),
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIST_STAT_CONCURRENCY, entries.length) }, worker));

    // Sort directories first, then alphabetical by name
    results.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  }

  async stat(remotePath: string): Promise<FileEntry> {
    const fullPath = this.resolvePath(remotePath);
    const stats = await fsp.stat(fullPath);
    const isDir = stats.isDirectory();
    const name = path.basename(fullPath) || fullPath;

    return {
      name,
      path: remotePath,
      size: stats.size,
      isDirectory: isDir,
      isSpecial: !isDir && !stats.isFile(),
      mtime: formatDate(stats.mtime),
      mtimeMs: stats.mtime.getTime(),
      mimeType: isDir ? undefined : getMimeType(name),
      permissions: formatPermissions(stats.mode),
    };
  }

  async createFolder(remotePath: string): Promise<void> {
    const fullPath = this.resolvePath(remotePath);
    await fsp.mkdir(fullPath, { recursive: true });
  }

  async delete(remotePath: string, isDirectory: boolean): Promise<void> {
    const fullPath = this.resolvePath(remotePath);
    const parsed = path.parse(fullPath);
    if (fullPath === parsed.root || (this.basePath && fullPath === this.basePath)) {
      throw new Error(`Cannot delete root directory: ${remotePath}`);
    }

    const stats = await fsp.lstat(fullPath);

    if (isDirectory) {
      if (!stats.isDirectory()) {
        throw new Error(`Expected directory but found file: ${remotePath}`);
      }
      await fsp.rm(fullPath, { recursive: true });
    } else {
      if (stats.isDirectory()) {
        throw new Error(`Expected file but found directory: ${remotePath}`);
      }
      await fsp.unlink(fullPath);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const fullOld = this.resolvePath(oldPath);
    const fullNew = this.resolvePath(newPath);
    await fsp.rename(fullOld, fullNew);
  }

  async createReadStream(
    remotePath: string,
    start?: number,
    end?: number,
  ): Promise<NodeJS.ReadableStream> {
    const fullPath = this.resolvePath(remotePath);
    const stats = await fsp.stat(fullPath);

    if (stats.isDirectory()) {
      throw new Error(`Cannot read directory as stream: ${remotePath}`);
    }

    const options: { start?: number; end?: number } = {};
    if (typeof start === 'number') options.start = start;
    if (typeof end === 'number') options.end = end;

    return fs.createReadStream(fullPath, options);
  }

  async createWriteStream(
    remotePath: string,
    _options?: WriteStreamOptions,
  ): Promise<NodeJS.WritableStream> {
    const fullPath = this.resolvePath(remotePath);
    const parentDir = path.dirname(fullPath);
    await fsp.mkdir(parentDir, { recursive: true });
    const stream = fs.createWriteStream(fullPath);
    // 'open' means the file was opened for writing (and truncated); a failed open leaves the target alone. The open is already
    // under way when this returns, so `targetSettled` lets a failed transfer wait for it (bounded, see settleTargetTouched)
    // before it decides whether the target was touched. Not awaited here: a FIFO or a stalled mount would block the cancel.
    // (`stream.pending` is not usable: it turns true again once the stream has closed.)
    let opened = false;
    const settled = new Promise<void>((resolve) => {
      stream.once('open', () => {
        opened = true;
        resolve();
      });
      // No 'error' listener on purpose: it would count as a handler and hide an unhandled error from a caller that has none.
      // A failed open emits 'error' and then 'close', so 'close' settles it.
      stream.once('close', () => resolve());
    });
    return defineTargetSettled(defineTargetTouched(stream, () => opened), () => settled);
  }

  async writeFile(
    remotePath: string,
    data: Buffer | Uint8Array,
    options?: WriteStreamOptions,
  ): Promise<void> {
    const fullPath = this.resolvePath(remotePath);
    const parentDir = path.dirname(fullPath);
    await fsp.mkdir(parentDir, { recursive: true });
    await fsp.writeFile(fullPath, data, { mode: options?.mode, flag: options?.exclusive ? 'wx' : 'w' });
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const fullPath = this.resolvePath(remotePath);
    return fsp.readFile(fullPath);
  }

  async chmod(remotePath: string, mode: number | string): Promise<void> {
    const fullPath = this.resolvePath(remotePath);
    const numericMode = typeof mode === 'string' ? parseInt(mode, 8) : mode;
    if (Number.isNaN(numericMode)) {
      throw new Error(`Invalid chmod mode: ${mode}`);
    }
    await fsp.chmod(fullPath, numericMode);
  }

  /** Windows only: reads the R/H/S/A attributes of a file or folder with `attrib`. */
  async getWinAttributes(remotePath: string): Promise<WinAttributes> {
    if (process.platform !== 'win32') throw new Error('Windows attributes are only available on Windows');
    const { stdout } = await execFileAsync('attrib', [this.resolvePath(remotePath)], { windowsHide: true });
    return parseAttribOutput(stdout);
  }

  /** Windows only: applies the given attribute changes with `attrib`, optionally to a folder's whole tree. */
  async setWinAttributes(remotePath: string, changes: Partial<WinAttributes>, recursive = false): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Windows attributes are only available on Windows');
    const fullPath = this.resolvePath(remotePath);
    const flags = buildAttribFlags(changes, await this.getWinAttributes(remotePath));
    if (flags.length === 0) return;
    // No shell is involved, so the path cannot be interpreted as anything but an argument.
    await execFileAsync('attrib', [...flags, fullPath], { windowsHide: true });
    // `attrib` can exit 0 without changing anything (hidden/system files), so the result is read back.
    const unapplied = unappliedAttributes(changes, await this.getWinAttributes(remotePath));
    if (unapplied.length > 0) throw new Error(`Windows did not apply: ${unapplied.join(', ')}`);
    if (recursive && (await fsp.stat(fullPath)).isDirectory()) {
      // Only what was asked for: items inside keep their own H/S, so `attrib` skips hidden/system ones.
      await execFileAsync('attrib', [...buildAttribFlags(changes), path.join(fullPath, '*'), '/S', '/D'], { windowsHide: true });
    }
  }

  async setModifiedTime(remotePath: string, mtimeMs: number): Promise<void> {
    const fullPath = this.resolvePath(remotePath);
    const mtime = new Date(mtimeMs);
    await fsp.utimes(fullPath, mtime, mtime);
  }

  /**
   * Computes a cryptographic checksum for a file on local storage.
   */
  async getChecksum(remotePath: string, algorithm: 'sha256' | 'md5' = 'sha256'): Promise<string> {
    const fullPath = this.resolvePath(remotePath);
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash(algorithm);
      const stream = fs.createReadStream(fullPath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  async getHomeDir(): Promise<string> {
    // The account's own folder, never the server user's home.
    return this.confined && this.basePath ? this.basePath : os.homedir();
  }

  async getSpace(remotePath: string): Promise<SpaceInfo | undefined> {
    return spaceOf(this.resolvePath(remotePath));
  }

  /** Windows drive letters, or real mounted filesystems on Linux/macOS, each with free/total space. */
  async listVolumes(): Promise<VolumeInfo[]> {
    // The server's disks and mounts are the server's business.
    if (this.confined) return [];
    if (process.platform === 'win32') {
      return listWindowsVolumes();
    }
    let candidates: Array<{ path: string; label: string }> = [];
    if (process.platform === 'darwin') {
      candidates = [{ path: '/', label: '/' }];
      try {
        for (const name of await fsp.readdir('/Volumes')) {
          candidates.push({ path: `/Volumes/${name}`, label: name });
        }
      } catch {
        // No /Volumes: root only
      }
    } else {
      try {
        const seen = new Set<string>();
        for (const line of (await fsp.readFile('/proc/self/mounts', 'utf-8')).split('\n')) {
          const [device, mountRaw, fsType] = line.split(' ');
          if (!device || !mountRaw || PSEUDO_FS.has(fsType)) continue;
          if (device.startsWith('/dev/loop') || mountRaw.startsWith('/snap/')) continue;
          const mount = unescapeMount(mountRaw);
          if (seen.has(mount)) continue;
          seen.add(mount);
          candidates.push({ path: mount, label: mount });
        }
        if (!seen.has('/')) {
          candidates.unshift({ path: '/', label: '/' });
        }
      } catch {
        candidates = [{ path: '/', label: '/' }];
      }
    }
    const spaces = await Promise.all(candidates.map((c) => spaceOf(c.path)));
    const volumes: VolumeInfo[] = [];
    candidates.forEach((c, i) => {
      const space = spaces[i];
      if (space) volumes.push({ ...c, ...space });
    });
    return volumes;
  }

  async disconnect(): Promise<void> {
    // No persistent connection to close for local filesystem
  }
}
