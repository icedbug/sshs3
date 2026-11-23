import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ListedObject } from "./LearningQueue";
import type { ConditionalQueueStore } from "./WorkSync";

/**
 * The team's shared items kept in a folder, for a server several people share that has no bucket.
 *
 * It is the same store the board uses in a team's bucket (one small file per goal, ticket, agent,
 * document, page, dependency and claim), with the same promises: a write that names the version it
 * replaces (`ifMatch`) or asks that nothing be there yet (`ifNoneMatch`) either happens whole or is
 * refused, so two people's apps that reach for the same ticket in the same instant cannot both win.
 *
 * Every account on the server is a hub in the same process, and they are all given this one object:
 * the promise is kept by doing one write to a path at a time, here. It would not hold between two
 * server processes on the same folder, which is not a way sshS3 is run.
 */
export class FileQueueStore implements ConditionalQueueStore {
  readonly supportsConditionalWrite = true;
  /** The last write to each path that is still going on: the next one to that path waits for it. */
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  /** Where a path of the store is on disk. A path that would leave the folder is refused. */
  private at(relative: string): string {
    const clean = relative.replace(/\\/g, "/").replace(/^\/+/, "");
    const target = path.resolve(this.root, clean);
    const base = path.resolve(this.root);
    if (target !== base && !target.startsWith(base + path.sep)) throw new Error("A path outside the shared folder was asked for.");
    return target;
  }

  /** One thing at a time for a path, in the order asked. */
  private alone<T>(file: string, work: () => Promise<T>): Promise<T> {
    const before = this.busy.get(file) ?? Promise.resolve();
    const mine = before.then(work, work);
    const settled = mine.catch(() => undefined);
    this.busy.set(file, settled);
    void settled.then(() => {
      if (this.busy.get(file) === settled) this.busy.delete(file);
    });
    return mine;
  }

  private static version(content: Buffer): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private static refused(why: string): Error {
    // The words and numbers the bucket uses for the same refusal: whoever asked reads them the same way.
    return Object.assign(new Error(why), { name: "PreconditionFailed", code: "PreconditionFailed", statusCode: 412 });
  }

  private static async readOrNothing(file: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return undefined;
      throw error;
    }
  }

  async list(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.at(dir), { withFileTypes: true });
      // A file being written has a name of its own until it is whole: it is not one of the items.
      return entries.filter((e) => e.isFile() && !e.name.endsWith(".tmp")).map((e) => e.name);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
  }

  /**
   * The listing with a mark for each file that changes when the file does. A write puts a new file in
   * the old one's place, so the file's own number, its size and its time together tell every change.
   */
  async listWithMeta(dir: string): Promise<ListedObject[]> {
    const names = await this.list(dir);
    const folder = this.at(dir);
    const listed = await Promise.all(
      names.map(async (name): Promise<ListedObject | undefined> => {
        try {
          const stat = await fs.stat(path.join(folder, name), { bigint: true });
          return { name, version: `${stat.ino}:${stat.size}:${stat.mtimeNs}` };
        } catch {
          // Removed since it was listed: it is not there.
          return undefined;
        }
      }),
    );
    return listed.filter((entry): entry is ListedObject => Boolean(entry));
  }

  async read(relative: string): Promise<Buffer | undefined> {
    return FileQueueStore.readOrNothing(this.at(relative));
  }

  async readWithMeta(relative: string): Promise<{ buffer: Buffer; etag?: string } | undefined> {
    const buffer = await FileQueueStore.readOrNothing(this.at(relative));
    return buffer ? { buffer, etag: FileQueueStore.version(buffer) } : undefined;
  }

  async write(relative: string, content: Buffer, options?: { ifMatch?: string; ifNoneMatch?: string }): Promise<void> {
    const file = this.at(relative);
    return this.alone(file, async () => {
      if (options?.ifNoneMatch || options?.ifMatch) {
        const there = await FileQueueStore.readOrNothing(file);
        if (options.ifNoneMatch && there) throw FileQueueStore.refused("It is there already.");
        if (options.ifMatch && (!there || FileQueueStore.version(there) !== options.ifMatch.replace(/^"|"$/g, "")))
          throw FileQueueStore.refused("It was changed by somebody else in the meantime.");
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Written beside it and moved into place: a reader sees the old file or the new one, never half of one.
      const partial = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      try {
        await fs.writeFile(partial, content);
        await fs.rename(partial, file);
      } catch (error) {
        await fs.rm(partial, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async writeIfNoneMatch(relative: string, content: Buffer): Promise<boolean> {
    try {
      await this.write(relative, content, { ifNoneMatch: "*" });
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "PreconditionFailed") return false;
      throw error;
    }
  }

  async remove(relative: string): Promise<void> {
    const file = this.at(relative);
    return this.alone(file, () => fs.rm(file, { force: true }));
  }

  /**
   * The same store for one of the accounts that share it: `wrote` is called after that account has
   * written or removed something the others should fetch (an item of the board, not a claim's
   * heartbeat or a count of use), so they are told at once instead of finding out at their next look.
   */
  forAccount(wrote: () => void): ConditionalQueueStore {
    const tell = (relative: string): void => {
      if (/^work\/(goals|tickets|agents|kb|edges|pages|evals)\//.test(relative.replace(/\\/g, "/").replace(/^\/+/, ""))) wrote();
    };
    return {
      supportsConditionalWrite: true,
      list: (dir) => this.list(dir),
      listWithMeta: (dir) => this.listWithMeta(dir),
      read: (relative) => this.read(relative),
      readWithMeta: (relative) => this.readWithMeta(relative),
      write: async (relative, content, options) => {
        await this.write(relative, content, options);
        tell(relative);
      },
      writeIfNoneMatch: async (relative, content) => {
        const done = await this.writeIfNoneMatch(relative, content);
        if (done) tell(relative);
        return done;
      },
      remove: async (relative) => {
        await this.remove(relative);
        tell(relative);
      },
    };
  }
}
