import { quoteShellArg } from '../search/shellQuote';
import type { ArchiveKind } from '../../shared/archiveNames';

export { detectArchiveKind, stripArchiveExtension } from '../../shared/archiveNames';

export type ArchiveFormat = 'tar.gz' | 'zip';

/** A program invocation: executed directly (local) or quoted into one shell line (SFTP). */
export interface ArchiveCommand {
  file: string;
  args: string[];
  /** Working directory; `undefined` runs in the process' own. */
  cwd?: string;
  /** Non-zero exit codes that still mean success (unzip exits 1 for warnings after extracting everything). */
  okExitCodes?: number[];
}

export function archiveExtension(format: ArchiveFormat): string {
  return format === 'zip' ? '.zip' : '.tar.gz';
}

/** Default archive name: the entry's own name for one entry, "archive" for several. */
export function defaultArchiveBaseName(names: string[]): string {
  return names.length === 1 ? names[0] : 'archive';
}

/**
 * A single path segment: not empty, not "." / "..", no separators or NUL. A backslash is refused on every platform: it
 * separates paths on Windows, and GNU tar reads it as an escape sequence in a name given on the command line (`a\\b`
 * becomes `a<backspace>`), which no portable flag turns off. Used for every name that is joined onto a directory.
 */
export function isSafeSegment(name: unknown): name is string {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

/** True when `err` is a process exit whose code `command` lists as acceptable. */
export function isAcceptedExit(err: unknown, command: ArchiveCommand): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' && (command.okExitCodes ?? []).includes(code);
}

/**
 * `name`, or `name (1)`, `name (2)`, ... — the first variant `exists` reports free. The suffix goes before the
 * archive extension so "a.zip" becomes "a (1).zip".
 */
export async function pickFreeName(
  baseName: string,
  extension: string,
  exists: (candidate: string) => Promise<boolean>
): Promise<string> {
  for (let n = 0; n < 1000; n += 1) {
    const candidate = n === 0 ? `${baseName}${extension}` : `${baseName} (${n})${extension}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not find a free file name');
}

/**
 * Packs `names` (direct children of `parentDir`) into `archivePath`. Entries are stored relative to `parentDir`,
 * so extracting yields the names themselves rather than their full paths.
 * `zip` has no portable CLI: Windows and macOS ship a `tar` that writes zip (`-a`), elsewhere the `zip` tool is used.
 */
export function buildCompressCommand(
  format: ArchiveFormat,
  parentDir: string,
  names: string[],
  archivePath: string,
  platform: NodeJS.Platform
): ArchiveCommand {
  if (format === 'tar.gz') {
    return { file: 'tar', args: ['-czf', archivePath, '-C', parentDir, '--', ...names] };
  }
  if (platform === 'win32' || platform === 'darwin') {
    return { file: 'tar', args: ['-a', '-cf', archivePath, '-C', parentDir, '--', ...names] };
  }
  return { file: 'zip', args: ['-r', '-y', '-q', archivePath, '--', ...names], cwd: parentDir };
}

/**
 * Unpacks `archivePath` into the existing `destDir`. Ownership from the archive is not applied; GNU/bsd tar and unzip
 * themselves refuse absolute and `..` member paths, which keeps members inside `destDir`.
 */
export function buildExtractCommand(
  kind: ArchiveKind,
  archivePath: string,
  destDir: string,
  platform: NodeJS.Platform
): ArchiveCommand {
  if (kind === 'zip' && platform !== 'win32' && platform !== 'darwin') {
    return { file: 'unzip', args: ['-q', archivePath, '-d', destDir], okExitCodes: [1] };
  }
  return { file: 'tar', args: ['-xf', archivePath, '-C', destDir, '--no-same-owner'] };
}

/**
 * The two listings a web server reads before it unpacks an archive into an account's folder: the member
 * names, one per line, and the long listing whose lines start with the member's kind, as `ls -l` does.
 */
export function buildListCommands(kind: ArchiveKind, archivePath: string, platform: NodeJS.Platform): { names: ArchiveCommand; kinds: ArchiveCommand } {
  if (kind === 'zip' && platform !== 'win32' && platform !== 'darwin') {
    return {
      names: { file: 'unzip', args: ['-Z', '-1', archivePath] },
      kinds: { file: 'unzip', args: ['-Z', archivePath] },
    };
  }
  return { names: { file: 'tar', args: ['-tf', archivePath] }, kinds: { file: 'tar', args: ['-tvf', archivePath] } };
}

/**
 * Why an archive with these listings is not unpacked into an account's folder, or nothing when it may be.
 * A symbolic link in it could point anywhere on the server, a hard link gives a second name to a file
 * the account cannot otherwise reach, and a name that climbs with `..` or starts at the root lands
 * outside the folder. A line of the long listing starts with the member's kind: `l` is a symbolic link
 * and `h` a hard link, for GNU tar, bsdtar and zipinfo alike. A member name cannot change the first
 * letter of its own line, so a name that looks like a listing line only makes this stricter.
 */
export function archiveRefusal(names: string, kinds: string): string | undefined {
  for (const line of kinds.split(/\r?\n/)) {
    if (line.startsWith('l') && /^l[rwxsStT-]{9}/.test(line)) return 'This archive holds a link to another place. An archive with links is not unpacked on the sshs3 web server.';
    if (line.startsWith('h') && /^h[rwxsStT-]{9}/.test(line)) return 'This archive holds a hard link. An archive with links is not unpacked on the sshs3 web server.';
  }
  for (const name of names.split(/\r?\n/)) {
    if (!name) continue;
    if (name.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(name) || name.split(/[\\/]/).includes('..')) {
      return 'This archive holds a file that would be unpacked outside its folder. It is not unpacked on the sshs3 web server.';
    }
  }
  return undefined;
}

/** One POSIX shell line for a remote `ssh host <line>` invocation: `cd <cwd> && prog 'arg' ...`. */
export function toShellCommand(command: ArchiveCommand): string {
  const run = [command.file, ...command.args.map(quoteShellArg)].join(' ');
  return command.cwd ? `cd ${quoteShellArg(command.cwd)} && ${run}` : run;
}

/**
 * The useful part of a failed `execFile` error. Node's message is "Command failed: <command line>\n<stderr>", and the
 * command line (host, control path) is noise for the user, so only the stderr lines are kept.
 */
export function summarizeExecError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const lines = message.split('\n');
  const detail = (lines[0].startsWith('Command failed:') ? lines.slice(1) : lines).join('\n').trim();
  if (!detail) return fallback;
  return detail.length > 500 ? `${detail.slice(0, 500)}…` : detail;
}
