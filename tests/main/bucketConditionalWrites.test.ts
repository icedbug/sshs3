import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { S3WorkspaceSyncService } from "../../src/main/ai/hub/S3WorkspaceSyncService";
import { WorkSync, type ConditionalQueueStore } from "../../src/main/ai/hub/WorkSync";
import type { FileEntry, IStorageProvider } from "../../src/shared/types/storage";

/**
 * A ticket is run by one installation, and a thing that is done once is done by one. Both rest on the
 * store refusing the second of two writes. Amazon S3 does; a store that only speaks its protocol may
 * take the condition and write anyway. So the bucket is tried, once, and where it does not refuse, who
 * won is read back.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

type Honours = { ifNoneMatch: boolean; ifMatch: boolean };

/** A bucket that looks at a write's conditions, or takes them and writes anyway. */
class Bucket implements IStorageProvider {
  readonly id = "mem";
  readonly name = "mem";
  readonly type = "s3" as const;
  readonly objects = new Map<string, Buffer>();
  readonly writes: Array<{ key: string; ifMatch?: string; ifNoneMatch?: string }> = [];
  failWrites = false;
  private version = 0;
  private readonly etags = new Map<string, string>();
  constructor(private readonly honours: Honours) {}
  private n(p: string): string {
    return p.replace(/^\/+|\/+$/g, "");
  }
  private missing(): Error {
    return Object.assign(new Error("NoSuchKey"), { code: "NoSuchKey" });
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async createFolder(): Promise<void> {}
  async rename(): Promise<void> {}
  async list(dir: string): Promise<FileEntry[]> {
    const prefix = this.n(dir);
    return [...this.objects.entries()].filter(([k]) => k.startsWith(`${prefix}/`)).map(([k, v]) => ({ name: k.slice(prefix.length + 1), path: k, isDirectory: false, size: v.length, mtime: "m" }));
  }
  async stat(p: string): Promise<FileEntry> {
    const v = this.objects.get(this.n(p));
    if (!v) throw this.missing();
    return { name: path.posix.basename(p), path: p, isDirectory: false, size: v.length, mtime: "m", etag: this.etags.get(this.n(p)) };
  }
  async delete(p: string): Promise<void> {
    this.objects.delete(this.n(p));
    this.etags.delete(this.n(p));
  }
  async readFile(p: string): Promise<Buffer> {
    const v = this.objects.get(this.n(p));
    if (!v) throw this.missing();
    return v;
  }
  async writeFile(p: string, data: Buffer | Uint8Array, given?: unknown): Promise<void> {
    if (this.failWrites) throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const options = given as { ifMatch?: string; ifNoneMatch?: string } | undefined;
    const key = this.n(p);
    this.writes.push({ key, ifMatch: options?.ifMatch, ifNoneMatch: options?.ifNoneMatch });
    const refused = (): Error => Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    if (this.honours.ifNoneMatch && options?.ifNoneMatch && this.objects.has(key)) throw refused();
    if (this.honours.ifMatch && options?.ifMatch && this.etags.get(key) !== options.ifMatch) throw refused();
    this.objects.set(key, Buffer.from(data));
    this.etags.set(key, `"v${++this.version}"`);
  }
  async createReadStream(p: string): Promise<Readable> {
    return Readable.from(await this.readFile(p));
  }
  async createWriteStream(): Promise<Writable> {
    return new Writable({ write: (_c, _e, cb) => cb() });
  }
}

function service(bucket: Bucket) {
  const svc = new S3WorkspaceSyncService(
    path.join(os.tmpdir(), `sshs3-conditional-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    {
      getLocalState: async () => ({ actor: "anna", servers: [], memories: [], activityLog: [], deletedServerIds: {}, deletedMemoryIds: {}, activeTerminals: [] }),
      applyMergedState: async () => undefined,
      onStateChanged: () => undefined,
    },
    { providerFactory: () => bucket, publishPresence: false },
  );
  (svc as unknown as { config: Record<string, unknown> }).config = { enabled: true, region: "r", bucket: "team", prefix: "ws", accessKeyId: "K", secretAccessKey: "S", forcePathStyle: true };
  disposals.push(() => svc.dispose());
  return svc;
}

describe("whether a bucket refuses a write that lost", () => {
  it("is tried on the bucket itself, once, and leaves nothing behind", async () => {
    const bucket = new Bucket({ ifNoneMatch: true, ifMatch: true });
    const svc = service(bucket);
    expect(await svc.objects.conditionalWrites()).toBe(true);
    // An object was written, then written again both ways, and taken away.
    expect(bucket.writes.map((w) => [w.ifNoneMatch, w.ifMatch])).toEqual([[undefined, undefined], ["*", undefined], [undefined, '"not-this-objects-version"']]);
    expect(bucket.writes.every((w) => w.key.startsWith("team/ws/work/probe/conditional-"))).toBe(true);
    expect([...bucket.objects.keys()]).toEqual([]);
    // Asked again, and by several at once: not tried again.
    await Promise.all([svc.objects.conditionalWrites(), svc.objects.conditionalWrites()]);
    expect(bucket.writes).toHaveLength(3);
  });

  it("is no for a bucket that takes the condition and writes anyway, in either of the two ways", async () => {
    for (const honours of [
      { ifNoneMatch: false, ifMatch: false },
      { ifNoneMatch: true, ifMatch: false },
      { ifNoneMatch: false, ifMatch: true },
    ]) {
      const bucket = new Bucket(honours);
      expect(await service(bucket).objects.conditionalWrites(), JSON.stringify(honours)).toBe(false);
      expect([...bucket.objects.keys()]).toEqual([]);
    }
  });

  it("is no for now when the bucket cannot be tried, and is tried again the next time", async () => {
    const bucket = new Bucket({ ifNoneMatch: true, ifMatch: true });
    const svc = service(bucket);
    bucket.failWrites = true;
    expect(await svc.objects.conditionalWrites()).toBe(false);
    bucket.failWrites = false;
    expect(await svc.objects.conditionalWrites()).toBe(true);
  });

  it("is found out again when the bucket's settings change", async () => {
    const bucket = new Bucket({ ifNoneMatch: true, ifMatch: true });
    const svc = service(bucket);
    await svc.objects.conditionalWrites();
    const tries = bucket.writes.length;
    // The settings were read again and are not the same: the provider is made anew.
    await (svc as unknown as { resetProvider(): Promise<void> }).resetProvider();
    await svc.objects.conditionalWrites();
    expect(bucket.writes.length).toBe(tries * 2);
  });
});

/** The store WorkSync is given for such a bucket: it says what the try came to, and takes every write. */
function unconditionalStore(): ConditionalQueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    conditionalWrites: async () => false,
    list: async (dir: string) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p: string) => files.get(p),
    readWithMeta: async (p: string) => (files.has(p) ? { buffer: files.get(p)!, etag: "always-the-same" } : undefined),
    write: async (p: string, c: Buffer) => void files.set(p, Buffer.from(c)),
    remove: async (p: string) => void files.delete(p),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("on a bucket that does not refuse", () => {
  it("two installations that take a ticket at the same moment are told the same holder", async () => {
    const store = unconditionalStore();
    const a = new WorkSync(store);
    const b = new WorkSync(store);
    // Both read "no claim" before either writes.
    const [ca, cb] = await Promise.all([a.claim("t-1", { by: "Anna", client: "A" }, 1000, { settle }), b.claim("t-1", { by: "Sara", client: "B" }, 1000, { settle })]);
    expect(ca.client).toBe(cb.client);
    expect(["A", "B"]).toContain(ca.client);
    // The one that does not hold it is told so when it says it is still at work.
    const loser = ca.client === "A" ? "B" : "A";
    expect(await a.refresh("t-1", ca.client, 2000)).toBe(true);
    expect(await b.refresh("t-1", loser, 2000)).toBe(false);
  });

  it("a thing that is done once is done by one of two that reach for it together", async () => {
    const store = unconditionalStore();
    const a = new WorkSync(store);
    const b = new WorkSync(store);
    const answers = await Promise.all([a.markOnce("nightly-2026-11-23", "A", settle), b.markOnce("nightly-2026-11-23", "B", settle)]);
    expect(answers.sort()).toEqual([false, true]);
    // And by nobody afterwards.
    expect(await a.markOnce("nightly-2026-11-23", "A", settle)).toBe(false);
  });

  it("an installation whose ticket was taken over between its read and its write is told it no longer holds it", async () => {
    const store = unconditionalStore();
    const a = new WorkSync(store);
    await a.claim("t-2", { by: "Anna", client: "A" }, 1000, { settle });
    // Sara's installation takes the ticket over while Anna's is writing that it is still at work.
    const write = store.write;
    store.write = async (p, c, o) => {
      await write(p, c, o);
      if (p === "work/claims/t-2.json") store.files.set(p, Buffer.from(JSON.stringify({ by: "Sara", client: "B", at: 5000, seenAt: 5000 })));
    };
    expect(await a.refresh("t-2", "A", 5000)).toBe(false);
  });

  it("is not asked to settle where the store does refuse, as before", async () => {
    const files = new Map<string, Buffer>();
    let asked = 0;
    const refusing: ConditionalQueueStore = {
      conditionalWrites: async () => {
        asked++;
        return true;
      },
      list: async () => [],
      read: async (p) => files.get(p),
      write: async (p, c, o) => {
        if (o?.ifNoneMatch && files.has(p)) throw Object.assign(new Error("412"), { name: "PreconditionFailed" });
        files.set(p, Buffer.from(c));
      },
      remove: async (p) => void files.delete(p),
    };
    let settled = 0;
    const work = new WorkSync(refusing);
    expect(await work.markOnce("k", "A", async () => void settled++)).toBe(true);
    expect((await work.claim("t-3", { by: "Anna", client: "A" }, 1000, { settle: async () => void settled++ })).client).toBe("A");
    expect(settled).toBe(0);
    expect(asked).toBeGreaterThan(0);
  });
});
