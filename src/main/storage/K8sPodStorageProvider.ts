import path from 'node:path';
import stream, { PassThrough, Writable } from 'node:stream';
import type * as k8s from '@kubernetes/client-node';
import { loadK8sClient } from '../services/k8sClient';
import { loadKubeConfigForContext } from '../services/k8sKubeConfig';
import {
  BaseStorageProvider,
  formatDate,
  getMimeType,
} from './StorageProvider';
import type {
  FileEntry,
  StorageType,
  WriteStreamOptions,
} from '../../shared/types/storage';
import type { K8sStorageConfig } from '../../shared/types/kubernetes';
import { defineTargetTouched } from './targetTouched';

/** How long a write stream waits, after its last byte, for the command in the pod to report back. */
const WRITE_FINISH_TIMEOUT_MS = 60_000;

/**
 * Runs in the pod for every write ($1 = path, $2 = optional octal mode). `cat` must be allowed to fail the
 * script: without `|| exit $?` the status of the trailing `if` (0 when there is no mode) hid a failed write
 * such as "Permission denied" or "No space left on device", and the editor reported the file as saved.
 * A failing `chmod` still fails the script, so a file is never silently left with the wrong permissions.
 */
export const POD_WRITE_SCRIPT = `
mkdir -p "$(dirname "$1")" 2>/dev/null
cat > "$1" || exit $?
if [ -n "$2" ]; then chmod "$2" "$1" 2>/dev/null; fi
`;

export class K8sPodStorageProvider extends BaseStorageProvider {
  readonly id: string;
  readonly name: string;
  readonly type: StorageType = 'k8s';
  readonly config: K8sStorageConfig;
  private kubeConfigPath?: string;
  private execClient?: k8s.Exec;

  constructor(config: K8sStorageConfig, kubeConfigPath?: string) {
    super();
    this.config = config;
    this.id = config.id || `k8s-${config.contextName}/${config.namespace}/${config.podName}/${config.containerName}`;
    this.name = config.name || `${config.podName} (${config.containerName})`;
    this.kubeConfigPath = kubeConfigPath;
  }

  private async getExec(): Promise<k8s.Exec> {
    if (this.execClient) return this.execClient;
    const [kc, { Exec }] = await Promise.all([
      loadKubeConfigForContext(this.config.contextName, this.kubeConfigPath),
      loadK8sClient(),
    ]);
    this.execClient = new Exec(kc);
    return this.execClient;
  }

  /**
   * Executes a non-interactive command inside the pod container.
   * Resolves with stdout buffer and stderr string when the status channel completes or socket closes.
   */
  public async runCommand(
    command: string[],
    stdin: stream.Readable | null = null,
    timeoutMs = 30000
  ): Promise<{ stdout: Buffer; stderr: string }> {
    const exec = await this.getExec();

    return new Promise((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();

      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      stdoutStream.on('data', (chunk: Buffer) => {
        stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stderrStream.on('data', (chunk: Buffer) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      const finish = (status?: any) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (status?.status === 'Failure') {
          const exitCode = status.details?.causes?.find((c: any) => c.reason === 'ExitCode')?.message;
          const msg = stderr.trim() || status.message || `Command failed with exit code ${exitCode}`;
          const err = new Error(msg);
          (err as any).status = status;
          (err as any).exitCode = exitCode ? parseInt(exitCode, 10) : undefined;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`Command timed out after ${timeoutMs}ms: ${command.join(' ')}`));
          }
        }, timeoutMs);
      }

      exec
        .exec(
          this.config.namespace,
          this.config.podName,
          this.config.containerName,
          command,
          stdoutStream,
          stderrStream,
          stdin,
          false,
          (status) => {
            finish(status);
          }
        )
        .then((conn) => {
          conn.on('close', () => {
            setTimeout(() => finish(), 25);
          });
          conn.on('error', (err: any) => {
            if (!settled) {
              settled = true;
              if (timer) clearTimeout(timer);
              reject(err);
            }
          });
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            if (timer) clearTimeout(timer);
            reject(err);
          }
        });
    });
  }

  public async list(remotePath: string): Promise<FileEntry[]> {
    const targetDir = remotePath && remotePath.trim() !== '' ? path.posix.normalize(remotePath) : '/';
    const script = `
dir="$1"
cd "$dir" 2>/dev/null || exit 2
for f in .* *; do
  [ "$f" = "." ] || [ "$f" = ".." ] && continue
  [ ! -e "$f" ] && [ ! -L "$f" ] && continue
  if [ -d "$f" ]; then isDir="1"; else isDir="0"; fi
  if [ -L "$f" ]; then isLink="1"; else isLink="0"; fi
  if [ -f "$f" ]; then isReg="1"; else isReg="0"; fi
  out=$(stat -c "%s %Y %a" "$f" 2>/dev/null || stat -f "%z %m %p" "$f" 2>/dev/null)
  [ -n "$out" ] || out="0 0 755"
  printf "%s\t%s\t%s\t%s\t%s\n" "$f" "$isDir" "$out" "$isLink" "$isReg"
done
`;

    let res: { stdout: Buffer; stderr: string };
    try {
      res = await this.runCommand(['sh', '-c', script, '--', targetDir]);
    } catch (err: any) {
      if (err.exitCode === 2 || err.message?.includes('exit code 2')) {
        throw new Error(`Directory not found or permission denied: ${targetDir}`, { cause: err });
      }
      throw err;
    }

    const lines = res.stdout.toString('utf-8').split('\n');
    const entries: FileEntry[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const name = parts[0];
      const isDirectory = parts[1] === '1';
      // Trailing flags (absent in older output): symlink / regular-file. Symlinks must be reported
      // so TransferPipeline.scanDirectory skips them instead of following them out of the tree.
      const isSymlink = parts[3]?.trim() === '1';
      const isSpecial = parts[4] !== undefined && !isDirectory && parts[4].trim() !== '1';
      const statParts = parts[2].trim().split(/\s+/);
      const size = parseInt(statParts[0], 10) || 0;
      const mtimeSec = parseInt(statParts[1], 10);
      const mtimeMs = !isNaN(mtimeSec) && mtimeSec > 0 ? mtimeSec * 1000 : Date.now();
      const rawMode = statParts[2] || '';
      const permissions = rawMode ? rawMode.slice(-3) : isDirectory ? '755' : '644';

      const entryPath = targetDir === '/' ? `/${name}` : `${targetDir}/${name}`;

      entries.push({
        name,
        path: entryPath,
        size: isDirectory ? 0 : size,
        isDirectory,
        mtime: formatDate(new Date(mtimeMs)),
        mtimeMs,
        mimeType: isDirectory ? undefined : getMimeType(name),
        permissions,
        isSymlink,
        isSpecial,
      });
    }

    return entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  public async stat(remotePath: string): Promise<FileEntry> {
    const targetPath = remotePath && remotePath.trim() !== '' ? path.posix.normalize(remotePath) : '/';
    if (targetPath === '/' || targetPath === '.') {
      return {
        name: '/',
        path: '/',
        size: 0,
        isDirectory: true,
        mtime: formatDate(new Date()),
        mtimeMs: Date.now(),
        permissions: '755',
      };
    }

    const script = `
f="$1"
if [ ! -e "$f" ] && [ ! -L "$f" ]; then
  exit 2
fi
if [ -d "$f" ]; then isDir="1"; else isDir="0"; fi
if [ -L "$f" ]; then isLink="1"; else isLink="0"; fi
if [ -f "$f" ]; then isReg="1"; else isReg="0"; fi
out=$(stat -c "%s %Y %a" "$f" 2>/dev/null || stat -f "%z %m %p" "$f" 2>/dev/null)
[ -n "$out" ] || out="0 0 755"
printf "%s\t%s\t%s\t%s\n" "$isDir" "$out" "$isLink" "$isReg"
`;

    let res: { stdout: Buffer; stderr: string };
    try {
      res = await this.runCommand(['sh', '-c', script, '--', targetPath]);
    } catch (err: any) {
      if (err.exitCode === 2 || err.message?.includes('exit code 2')) {
        throw new Error(`File or directory not found: ${targetPath}`, { cause: err });
      }
      throw err;
    }

    const line = res.stdout.toString('utf-8').trim();
    if (!line) {
      throw new Error(`Could not stat path: ${targetPath}`);
    }

    const [isDirStr, statDetails, isLinkStr, isRegStr] = line.split('\t');
    const isDirectory = isDirStr === '1';
    const isSymlink = isLinkStr?.trim() === '1';
    const isSpecial = isRegStr !== undefined && !isDirectory && isRegStr.trim() !== '1';
    const statParts = (statDetails || '').trim().split(/\s+/);
    const size = parseInt(statParts[0], 10) || 0;
    const mtimeSec = parseInt(statParts[1], 10);
    const mtimeMs = !isNaN(mtimeSec) && mtimeSec > 0 ? mtimeSec * 1000 : Date.now();
    const rawMode = statParts[2] || '';
    const permissions = rawMode ? rawMode.slice(-3) : isDirectory ? '755' : '644';
    const name = path.posix.basename(targetPath);

    return {
      name,
      path: targetPath,
      size: isDirectory ? 0 : size,
      isDirectory,
      mtime: formatDate(new Date(mtimeMs)),
      mtimeMs,
      mimeType: isDirectory ? undefined : getMimeType(name),
      permissions,
      isSymlink,
      isSpecial,
    };
  }

  public async createFolder(remotePath: string): Promise<void> {
    const targetPath = path.posix.normalize(remotePath);
    await this.runCommand(['sh', '-c', 'mkdir -p -- "$1"', '--', targetPath]);
  }

  public async delete(remotePath: string, isDirectory: boolean): Promise<void> {
    const targetPath = path.posix.normalize(remotePath);
    if (targetPath === '/' || targetPath === '.') {
      throw new Error('Refusing to delete container root directory');
    }
    const cmd = isDirectory ? 'rm -rf -- "$1"' : 'rm -f -- "$1"';
    await this.runCommand(['sh', '-c', cmd, '--', targetPath]);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    const from = path.posix.normalize(oldPath);
    const to = path.posix.normalize(newPath);
    await this.runCommand(['sh', '-c', 'mv -- "$1" "$2"', '--', from, to]);
  }

  public async chmod(remotePath: string, mode: number | string): Promise<void> {
    const targetPath = path.posix.normalize(remotePath);
    const modeStr = typeof mode === 'number' ? (mode & 0o777).toString(8) : String(mode);
    await this.runCommand(['sh', '-c', 'chmod "$2" -- "$1"', '--', targetPath, modeStr]);
  }

  public async readFile(remotePath: string): Promise<Buffer> {
    const targetPath = path.posix.normalize(remotePath);
    const res = await this.runCommand(['sh', '-c', 'cat -- "$1"', '--', targetPath]);
    return res.stdout;
  }

  public async writeFile(
    remotePath: string,
    data: Buffer | Uint8Array,
    options?: WriteStreamOptions
  ): Promise<void> {
    const targetPath = path.posix.normalize(remotePath);
    const modeStr = options?.mode ? (options.mode & 0o777).toString(8) : '';
    const inStream = stream.Readable.from([Buffer.from(data)]);
    await this.runCommand(['sh', '-c', POD_WRITE_SCRIPT, '--', targetPath, modeStr], inStream);
  }

  public async createReadStream(
    remotePath: string,
    start?: number,
    end?: number
  ): Promise<NodeJS.ReadableStream> {
    const targetPath = path.posix.normalize(remotePath);
    const exec = await this.getExec();
    const outStream = new PassThrough();
    const errStream = new PassThrough();
    const stderrChunks: Buffer[] = [];

    errStream.on('data', (c: Buffer) => stderrChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));

    let cmd: string[];
    if (start !== undefined && end !== undefined) {
      const count = end - start + 1;
      cmd = ['sh', '-c', 'dd if="$1" bs=1 skip=$2 count=$3 2>/dev/null', '--', targetPath, String(start), String(count)];
    } else if (start !== undefined) {
      cmd = ['sh', '-c', 'dd if="$1" bs=1 skip=$2 2>/dev/null', '--', targetPath, String(start)];
    } else {
      cmd = ['sh', '-c', 'cat -- "$1"', '--', targetPath];
    }

    try {
      const conn = await exec.exec(
        this.config.namespace,
        this.config.podName,
        this.config.containerName,
        cmd,
        outStream,
        errStream,
        null,
        false,
        (status) => {
          if (status?.status === 'Failure') {
            const msg = Buffer.concat(stderrChunks).toString('utf-8').trim() || status.message || 'Failed to read file from pod';
            outStream.destroy(new Error(msg));
          }
        }
      );

      conn.on('error', (err: any) => {
        outStream.destroy(err);
      });
    } catch (err) {
      outStream.destroy(err instanceof Error ? err : new Error(String(err)));
    }

    return outStream;
  }

  public async createWriteStream(
    remotePath: string,
    options?: WriteStreamOptions
  ): Promise<NodeJS.WritableStream> {
    const targetPath = path.posix.normalize(remotePath);
    const exec = await this.getExec();
    const inStream = new PassThrough();
    const errStream = new PassThrough();
    const stderrChunks: Buffer[] = [];

    errStream.on('data', (c: Buffer) => stderrChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));

    // Settles when the command in the pod has exited. The stream must not report 'finish' before that:
    // a PassThrough finishes once its last chunk is buffered, while `cat` is still writing to the pod's
    // disk, so the caller would verify (and report success on) a file that is not complete yet and
    // would never see a write error such as "No space left on device".
    let settleRemote!: { resolve: () => void; reject: (err: Error) => void };
    let execConnection: { close?: () => void } | undefined;
    /** Ends the exec session, so `cat` in the pod does not outlive a write that has already failed. */
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let execClosed = false;
    // `cat > file` truncates the target as soon as the command starts in the pod.
    let execStarted = false;
    const closeExec = (): void => {
      if (execClosed) return;
      execClosed = true;
      try {
        execConnection?.close?.();
      } catch {
        // already closed
      }
    };
    let remoteSettled = false;
    const remoteDone = new Promise<void>((resolve, reject) => {
      settleRemote = {
        resolve: () => {
          remoteSettled = true;
          resolve();
        },
        reject: (err) => {
          remoteSettled = true;
          reject(err);
        },
      };
    });
    remoteDone.catch(() => {}); // surfaced through the stream; never an unhandled rejection

    // What callers get: it feeds the exec's stdin and only finishes once the command has reported back.
    const out = new Writable({
      write(chunk, encoding, callback) {
        inStream.write(chunk, encoding, callback);
      },
      final(callback) {
        inStream.end();
        // All data has been handed over, so the command should exit promptly; do not wait on it forever.
        finishTimer = setTimeout(() => {
          settleRemote.reject(new Error('Timed out waiting for the pod to finish writing the file'));
          closeExec();
        }, WRITE_FINISH_TIMEOUT_MS);
        remoteDone.then(
          () => {
            clearTimeout(finishTimer);
            callback();
          },
          (remoteErr) => {
            clearTimeout(finishTimer);
            callback(remoteErr);
          }
        );
      },
      destroy(err, callback) {
        clearTimeout(finishTimer); // a write abandoned while final() waits must not leave its timer behind
        inStream.destroy();
        // An aborted or failed write ends the session; a finished one (destroyed automatically afterwards)
        // has nothing left to end, its command has already exited.
        if (!out.writableFinished) closeExec();
        callback(err);
      },
    });
    inStream.on('error', (err) => out.destroy(err));

    const modeStr = options?.mode ? (options.mode & 0o777).toString(8) : '';

    try {
      const conn = await exec.exec(
        this.config.namespace,
        this.config.podName,
        this.config.containerName,
        ['sh', '-c', POD_WRITE_SCRIPT, '--', targetPath, modeStr],
        null,
        errStream,
        inStream,
        false,
        (status) => {
          if (status?.status === 'Failure') {
            const msg = Buffer.concat(stderrChunks).toString('utf-8').trim() || status.message || 'Failed to write file to pod';
            const failure = new Error(msg);
            settleRemote.reject(failure);
            out.destroy(failure);
          } else {
            settleRemote.resolve();
          }
        }
      );

      execConnection = conn;
      execStarted = true;
      if (execClosed) {
        // The write was already abandoned while the session was still being opened.
        try {
          conn.close?.();
        } catch {
          // already closed
        }
      }
      conn.on('error', (err: any) => {
        settleRemote.reject(err instanceof Error ? err : new Error(String(err)));
        out.destroy(err instanceof Error ? err : new Error(String(err)));
      });
      conn.on('close', () => {
        // No status message before the socket closed: fail the writer now. Nothing reads the exec's stdin
        // any more, so a write in progress would otherwise wait for room in the buffer for ever.
        if (remoteSettled) return;
        const failure = new Error('Connection to the pod closed before the write finished');
        settleRemote.reject(failure);
        if (!out.destroyed) out.destroy(failure);
      });
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err));
      settleRemote.reject(failure);
      out.destroy(failure);
    }

    return defineTargetTouched(out, () => execStarted);
  }

  public async disconnect(): Promise<void> {
    this.execClient = undefined;
  }
}
