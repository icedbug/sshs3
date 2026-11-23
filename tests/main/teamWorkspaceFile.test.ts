import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { S3WorkspaceSyncService, type S3WorkspaceRemotePayload } from "../../src/main/ai/hub/S3WorkspaceSyncService";
import type { MemoryEntry } from "../../src/shared/types/aiHub";
import type { FileEntry, IStorageProvider } from "../../src/shared/types/storage";

/**
 * The team's workspace file in the bucket (servers, memories, activity). One that cannot be read (cut
 * off, or written over by something else) must not stop the team's sync for good: every installation
 * has its own copy of what was in it.
 */

const services: S3WorkspaceSyncService[] = [];
afterEach(async () => {
  for (const svc of services.splice(0)) await svc.dispose();
});

class Bucket implements IStorageProvider {
  readonly id = "mem";
  readonly name = "mem";
  readonly type = "s3" as const;
  constructor(
    readonly objects: Map<string, Buffer>,
    /** Whether an object's version is told, as a real bucket does (an ETag). */
    private readonly withEtag = true,
  ) {}
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
    return { name: path.posix.basename(p), path: p, isDirectory: false, size: v.length, mtime: String(v.length), ...(this.withEtag ? { etag: `e${v.length}-${v.subarray(0, 8).toString("hex")}` } : {}) };
  }
  async delete(p: string): Promise<void> {
    this.objects.delete(this.n(p));
  }
  async readFile(p: string): Promise<Buffer> {
    const v = this.objects.get(this.n(p));
    if (!v) throw this.missing();
    return v;
  }
  async writeFile(p: string, data: Buffer | Uint8Array, given?: unknown): Promise<void> {
    const options = given as { ifMatch?: string; ifNoneMatch?: string } | undefined;
    const key = this.n(p);
    const there = this.objects.get(key);
    const refused = (): Error => Object.assign(new Error("PreconditionFailed"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } });
    if (options?.ifNoneMatch && there) throw refused();
    if (options?.ifMatch && (!there || (await this.stat(p)).etag !== options.ifMatch)) throw refused();
    this.objects.set(key, Buffer.from(data));
  }
  async createReadStream(p: string): Promise<Readable> {
    return Readable.from(await this.readFile(p));
  }
  async createWriteStream(): Promise<Writable> {
    return new Writable({ write: (_c, _e, cb) => cb() });
  }
}

const FILE = "team/sshs3-workspace/workspace.json";
const KEPT = "team/sshs3-workspace/workspace.broken.json";
const memory = (id: string, text: string): MemoryEntry => ({ id, kind: "memory", scope: "workspace", title: id, text, updatedAt: 5 }) as MemoryEntry;

function installation(objects: Map<string, Buffer>, actor: string, memories: MemoryEntry[], withEtag = true) {
  const state = { memories, applied: 0 };
  const svc = new S3WorkspaceSyncService(
    path.join(os.tmpdir(), `sshs3-workspace-file-${actor}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    {
      getLocalState: async () => ({ actor, servers: [], memories: state.memories, activityLog: [], deletedServerIds: {}, deletedMemoryIds: {}, activeTerminals: [] }),
      applyMergedState: async (merged) => {
        state.applied++;
        state.memories = merged.memories;
      },
      onStateChanged: () => undefined,
    },
    { providerFactory: () => new Bucket(objects, withEtag), publishPresence: false },
  );
  (svc as unknown as { config: Record<string, unknown> }).config = { enabled: true, region: "r", bucket: "team", prefix: "sshs3-workspace", accessKeyId: "K", secretAccessKey: "S", forcePathStyle: true };
  services.push(svc);
  return { svc, state };
}

const stored = (objects: Map<string, Buffer>): S3WorkspaceRemotePayload => JSON.parse(objects.get(FILE)!.toString("utf8")) as S3WorkspaceRemotePayload;

describe("a workspace file in the bucket that cannot be read", () => {
  for (const [what, content] of [
    ["cut off in the middle", '{"version":1,"servers":[{"id":"s1"'],
    ["a list, not a workspace", "[1,2,3]"],
    ["the word null", "null"],
    ["something else's file", "<html><body>503</body></html>"],
  ] as const) {
    it(`is written again from this installation's copy, and kept beside it: ${what}`, async () => {
      for (const withEtag of [true, false]) {
        const objects = new Map<string, Buffer>([[FILE, Buffer.from(content, "utf8")]]);
        const anna = installation(objects, "anna", [memory("m1", "pg-01 needs a restart after an upgrade")], withEtag);
        // It used to fail here, every time, for everybody.
        await anna.svc.syncNow();
        expect(anna.state.applied).toBeGreaterThan(0);
        expect(stored(objects).memories.map((m) => m.id)).toEqual(["m1"]);
        expect(objects.get(KEPT)!.toString("utf8")).toBe(content);
        const status = anna.svc.getStatus();
        expect(status.error).toBeUndefined();
        expect(status.connected).toBe(true);
        expect(status.notice).toMatch(/^The team's workspace file in the bucket could not be read on \d{4}-\d\d-\d\d \d\d:\d\d UTC: it was not a valid workspace file\. A copy of it was kept in the bucket as workspace\.broken\.json/);
        // The next sync finds a good file and writes nothing.
        const before = objects.get(FILE)!;
        await anna.svc.syncNow();
        expect(objects.get(FILE)).toBe(before);
        // A teammate's copy comes back into it when their installation syncs.
        const sara = installation(objects, "sara", [memory("m2", "web-03 is behind the old proxy")], withEtag);
        await sara.svc.syncNow();
        expect(stored(objects).memories.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
        expect(sara.svc.getStatus().notice).toBeUndefined();
        await anna.svc.syncNow();
        expect(anna.state.memories.map((m) => m.id).sort()).toEqual(["m1", "m2"]);
      }
    });
  }

  it("is still read as a workspace when it is one, and an empty file is written as before", async () => {
    const good = { version: 1, updatedAt: 1, servers: [], memories: [memory("m9", "kept")], activityLog: [] };
    const objects = new Map<string, Buffer>([[FILE, Buffer.from(JSON.stringify(good), "utf8")]]);
    const anna = installation(objects, "anna", []);
    await anna.svc.syncNow();
    expect(anna.state.memories.map((m) => m.id)).toEqual(["m9"]);
    expect(objects.has(KEPT)).toBe(false);
    expect(anna.svc.getStatus().notice).toBeUndefined();

    const empty = new Map<string, Buffer>([[FILE, Buffer.from("  \n", "utf8")]]);
    const sara = installation(empty, "sara", [memory("m1", "x")], false);
    await sara.svc.syncNow();
    expect(stored(empty).memories.map((m) => m.id)).toEqual(["m1"]);
    expect(empty.has(KEPT)).toBe(false);
  });

  it("lets go of the notice when the bucket is changed", async () => {
    const objects = new Map<string, Buffer>([[FILE, Buffer.from("{", "utf8")]]);
    const anna = installation(objects, "anna", [memory("m1", "x")]);
    await anna.svc.syncNow();
    expect(anna.svc.getStatus().notice).toBeTruthy();
    await anna.svc.disconnect();
    expect(anna.svc.getStatus().notice).toBeUndefined();
  });
});
