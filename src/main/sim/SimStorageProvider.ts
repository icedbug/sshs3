import { Readable, Writable } from "node:stream";
import crypto from "node:crypto";
import type { FileEntry, IStorageProvider, SpaceInfo, StorageType, WriteStreamOptions } from "../../shared/types/storage";
import { basename, normalizePath, type SimHost } from "./SimHost";
import { simWorld } from "./SimWorld";

/**
 * The files of a simulated server, as the file manager sees them: the same
 * state the terminal works on, so a file edited here is the file `cat` shows,
 * and one a command wrote is here at the next look. Signed in as the server's
 * login user, as over SFTP: what that user may not read or write is refused.
 */
export class SimStorageProvider implements IStorageProvider {
  readonly type: StorageType = "sftp";

  constructor(
    readonly id: string,
    readonly name: string,
    /** Names the server goes by: looked up at every call, since a scenario can end. */
    private readonly refs: string[],
  ) {}

  private host(): SimHost {
    const host = simWorld().host(...this.refs);
    if (!host) throw new Error("This server belonged to a scenario that has ended.");
    return host;
  }

  private entry(host: SimHost, path: string): FileEntry {
    const file = host.read(path);
    if (!file && !host.isDir(path)) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    const mode = file ? file.mode : 0o755;
    const bits = "rwxrwxrwx".split("").map((c, i) => (mode & (1 << (8 - i)) ? c : "-")).join("");
    const mtimeMs = file?.mtime ?? host.now();
    return {
      name: basename(path) || "/",
      path,
      size: file ? host.sizeOf(file) : 0,
      isDirectory: !file,
      mtime: new Date(mtimeMs).toISOString(),
      mtimeMs,
      permissions: `${file ? "-" : "d"}${bits}`,
    } as FileEntry;
  }

  async list(remotePath: string): Promise<FileEntry[]> {
    const host = this.host();
    const dir = normalizePath(remotePath || "/");
    if (!host.isDir(dir)) throw new Error(`ENOENT: no such directory '${dir}'`);
    return host
      .list(dir)
      .map((e) => this.entry(host, dir === "/" ? `/${e.name}` : `${dir}/${e.name}`))
      .sort((a, b) => (a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name)));
  }

  async stat(remotePath: string): Promise<FileEntry> {
    return this.entry(this.host(), normalizePath(remotePath || "/"));
  }

  async createFolder(remotePath: string): Promise<void> {
    const host = this.host();
    const path = normalizePath(remotePath);
    if (!simWorld().shell(host).mayWrite(`${path}/x`, false)) throw new Error(`EACCES: permission denied, mkdir '${path}'`);
    host.mkdir(path);
    host.settle();
  }

  async delete(remotePath: string): Promise<void> {
    const host = this.host();
    const path = normalizePath(remotePath);
    const shell = simWorld().shell(host);
    const all = host.read(path) ? [path] : host.under(path);
    for (const p of all) if (!shell.mayWrite(p, false)) throw new Error(`EACCES: permission denied, unlink '${p}'`);
    if (!host.read(path) && !shell.mayWrite(`${path}/x`, false)) throw new Error(`EACCES: permission denied, rmdir '${path}'`);
    host.remove(path);
    host.settle();
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const host = this.host();
    const from = normalizePath(oldPath);
    const to = normalizePath(newPath);
    const file = host.read(from);
    if (!file) throw new Error(host.isDir(from) ? "Folders of a simulated server are renamed in its terminal (mv)." : `ENOENT: '${from}'`);
    const shell = simWorld().shell(host);
    if (!shell.mayWrite(from, false) || !shell.mayWrite(to, false)) throw new Error(`EACCES: permission denied, rename '${from}'`);
    host.write(to, file.content, { pad: file.pad, mode: file.mode, owner: file.owner });
    host.remove(from);
    host.settle();
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const host = this.host();
    const path = normalizePath(remotePath);
    const file = host.read(path);
    if (!file) throw new Error(`ENOENT: no such file '${path}'`);
    if (!simWorld().shell(host).mayRead(path, false)) throw new Error(`EACCES: permission denied, open '${path}'`);
    return Buffer.from(file.content, "utf8");
  }

  async writeFile(remotePath: string, data: Buffer | Uint8Array, _options?: WriteStreamOptions): Promise<void> {
    const host = this.host();
    const path = normalizePath(remotePath);
    const wrong = simWorld().shell(host).writeFile(path, Buffer.from(data).toString("utf8"), false, false);
    if (wrong) throw new Error(`${wrong === "Permission denied" ? "EACCES" : wrong === "No space left on device" ? "ENOSPC" : "ENOENT"}: ${wrong.toLowerCase()}, open '${path}'`);
    host.settle();
  }

  async createReadStream(remotePath: string, start?: number, end?: number): Promise<NodeJS.ReadableStream> {
    const buf = await this.readFile(remotePath);
    return Readable.from(start !== undefined || end !== undefined ? buf.subarray(start ?? 0, end !== undefined ? end + 1 : buf.length) : buf);
  }

  async createWriteStream(remotePath: string, options?: WriteStreamOptions): Promise<NodeJS.WritableStream> {
    const chunks: Buffer[] = [];
    return new Writable({
      write: (chunk, _encoding, callback) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        this.writeFile(remotePath, Buffer.concat(chunks), options).then(() => callback(), callback);
      },
    });
  }

  async getChecksum(remotePath: string, algorithm: "sha256" | "md5" = "sha256"): Promise<string | undefined> {
    return crypto.createHash(algorithm).update(await this.readFile(remotePath)).digest("hex");
  }

  async getHomeDir(): Promise<string> {
    return simWorld().shell(this.host()).home();
  }

  async getSpace(): Promise<SpaceInfo | undefined> {
    const host = this.host();
    const disk = host.diskOf("/");
    if (!disk) return undefined;
    const use = host.diskUse(disk);
    return { totalBytes: disk.sizeKb * 1024, freeBytes: use.availKb * 1024 };
  }

  async disconnect(): Promise<void> {}
}
