import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { IStorageProvider } from '../../shared/types/storage';
import { isMissingPathError } from '../ipc/ipcHelpers';
import { LocalStorageProvider } from '../storage/LocalStorageProvider';
import { SFTPStorageProvider } from '../storage/SFTPStorageProvider';
import { detectArchiveKind, stripArchiveExtension } from '../../shared/archiveNames';
import {
  archiveExtension,
  archiveRefusal,
  buildCompressCommand,
  buildExtractCommand,
  buildListCommands,
  defaultArchiveBaseName,
  isAcceptedExit,
  isSafeSegment,
  pickFreeName,
  summarizeExecError,
  toShellCommand,
  type ArchiveCommand,
  type ArchiveFormat,
} from './archiveCommands';

/** Where archive commands run: this machine (spawned directly) or an SFTP host (one quoted shell line over ssh). */
interface ArchiveTarget {
  /** Absolute path in the target's own syntax. */
  resolve(p: string): Promise<string>;
  join(dir: string, name: string): string;
  dirname(p: string): string;
  basename(p: string): string;
  run(command: ArchiveCommand): Promise<void>;
  platform: NodeJS.Platform;
}

function execLocal(command: ArchiveCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { cwd: command.cwd, maxBuffer: 1024 * 1024, windowsHide: true }, (err, _stdout, stderr) => {
      if (!err || isAcceptedExit(err, command)) return resolve();
      // stderr is what tar/zip/unzip complain about; ENOENT (tool missing) has none, so fall back to the error text.
      reject(new Error(stderr.trim() || summarizeExecError(err, `${command.file} failed`)));
    });
  });
}

/** What a listing command printed. An archive too big to list is one this does not unpack. */
function listLocal(command: ArchiveCommand): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve(String(stdout));
      reject(new Error(String(stderr).trim() || summarizeExecError(err, `${command.file} could not read the archive`)));
    });
  });
}

/**
 * Removes every link under `dir` that the unpacking left there: a symbolic link, and a file that has
 * another name outside `dir` (a hard link). The listing is checked before unpacking, so this finds
 * nothing unless the tool unpacked something its listing did not show. Links are never followed.
 */
export async function removeLinksUnder(dir: string): Promise<void> {
  const byFile = new Map<string, { names: string[]; links: number }>();
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        await fsp.unlink(full).catch(() => undefined);
      } else if (entry.isDirectory()) {
        await walk(full);
      } else {
        const stat = await fsp.lstat(full);
        if (stat.nlink > 1) {
          const key = `${stat.dev}:${stat.ino}`;
          const seen = byFile.get(key) ?? { names: [], links: stat.nlink };
          seen.names.push(full);
          byFile.set(key, seen);
        }
      }
    }
  };
  await walk(dir);
  // Every name of the file is inside the folder: an ordinary hard link between two unpacked files.
  for (const { names, links } of byFile.values())
    if (names.length < links) for (const name of names) await fsp.unlink(name).catch(() => undefined);
}

function targetFor(provider: IStorageProvider): ArchiveTarget {
  if (provider instanceof LocalStorageProvider) {
    return {
      resolve: async (p) => provider.resolvePath(p),
      join: (dir, name) => path.join(dir, name),
      dirname: (p) => path.dirname(p),
      basename: (p) => path.basename(p),
      run: execLocal,
      platform: process.platform,
    };
  }
  if (provider instanceof SFTPStorageProvider) {
    return {
      resolve: (p) => provider.resolveRemotePath(p),
      join: (dir, name) => path.posix.join(dir, name),
      dirname: (p) => path.posix.dirname(p),
      basename: (p) => path.posix.basename(p),
      run: async (command) => {
        try {
          await provider.exec(toShellCommand(command));
        } catch (err) {
          if (isAcceptedExit(err, command)) return;
          throw new Error(summarizeExecError(err, `${command.file} failed on the remote host`), { cause: err });
        }
      },
      // Remote hosts are POSIX; only the zip tool differs from the local default.
      platform: 'linux',
    };
  }
  throw new Error('Archives are only supported on local disks and SFTP connections');
}

async function pathExists(provider: IStorageProvider, absPath: string): Promise<boolean> {
  try {
    await provider.stat(absPath);
    return true;
  } catch (err) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
}

/** Packs `names` (children of `parentDir`) into a new archive next to them; returns the archive's file name. */
export async function compressEntries(
  provider: IStorageProvider,
  parentDir: string,
  names: string[],
  format: ArchiveFormat
): Promise<string> {
  const target = targetFor(provider);
  if (names.length === 0 || !names.every((n) => isSafeSegment(n))) throw new Error('Invalid file names');
  const dir = await target.resolve(parentDir);
  const archiveName = await pickFreeName(defaultArchiveBaseName(names), archiveExtension(format), (candidate) =>
    pathExists(provider, target.join(dir, candidate))
  );
  const archivePath = target.join(dir, archiveName);
  try {
    await target.run(buildCompressCommand(format, dir, names, archivePath, target.platform));
  } catch (err) {
    // The name was free a moment ago, so whatever is there now is the unfinished archive.
    await provider.delete(archivePath, false).catch(() => undefined);
    throw err;
  }
  return archiveName;
}

/** Unpacks an archive into a new folder named after it, beside it; returns the folder's name. */
export async function extractArchive(provider: IStorageProvider, archivePath: string): Promise<string> {
  const target = targetFor(provider);
  const absArchive = await target.resolve(archivePath);
  const archiveFile = target.basename(absArchive);
  const kind = detectArchiveKind(archiveFile);
  if (!kind) throw new Error('Not a supported archive (.zip, .tar, .tar.gz, .tgz, .tar.bz2, .tar.xz)');
  const parent = target.dirname(absArchive);
  const folderName = await pickFreeName(stripArchiveExtension(archiveFile), '', (candidate) =>
    pathExists(provider, target.join(parent, candidate))
  );
  const destDir = target.join(parent, folderName);
  // An account's folder on a web server: nothing that could lead out of it is unpacked into it.
  const confined = provider instanceof LocalStorageProvider && provider.confined;
  if (confined) {
    const list = buildListCommands(kind, absArchive, target.platform);
    const refusal = archiveRefusal(await listLocal(list.names), await listLocal(list.kinds));
    if (refusal) throw new Error(refusal);
  }
  await provider.createFolder(destDir);
  try {
    await target.run(buildExtractCommand(kind, absArchive, destDir, target.platform));
    if (confined) await removeLinksUnder(destDir);
  } catch (err) {
    if (confined) await removeLinksUnder(destDir).catch(() => undefined);
    // Only an empty folder is removed; anything already unpacked stays for the user to look at.
    const leftovers = await provider.list(destDir).catch(() => undefined);
    if (leftovers?.length === 0) await provider.delete(destDir, true).catch(() => undefined);
    throw err;
  }
  return folderName;
}
