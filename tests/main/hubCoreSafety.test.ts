import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../../src/main/ai/hub/HubStore";

/** The hub's own store and the team's shared file. From the review of feature 13. */

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-core-"));
  dirs.push(d);
  return d;
};

describe("the hub's store", () => {
  it("is never written over when it could not be read, and says so", async () => {
    const dir = await tmp();
    const file = path.join(dir, "hub.json");
    const first = new HubStore(file);
    await first.load();
    first.data.memories.push({ id: "m", kind: "memory", scope: "workspace", title: "keep me", text: "x", updatedAt: 1 } as never);
    await first.save();
    const store = new HubStore(file);
    const readFile = fs.readFile;
    vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });
    await expect(store.load()).rejects.toThrow(/could not be read/);
    await store.save();
    vi.restoreAllMocks();
    const onDisk = JSON.parse(await readFile(file, "utf8")) as { memories: { title: string }[] };
    expect(onDisk.memories.map((m) => m.title)).toEqual(["keep me"]);
  });

  it("keeps a file that is not a store aside before it starts afresh", async () => {
    const dir = await tmp();
    const file = path.join(dir, "hub.json");
    await fs.writeFile(file, "{ not json");
    const store = new HubStore(file);
    await store.load();
    expect((await fs.readdir(dir)).some((n) => n.startsWith("hub.json.corrupt-"))).toBe(true);
  });
});

describe("the team's shared workspace file", () => {
  it("carries a server's topology only, and is not rewritten when nothing changed", async () => {
    const dir = await tmp();
    const shared = path.join(dir, "shared.json");
    const store = new HubStore(path.join(dir, "hub.json"));
    await store.load();
    const server = {
      id: "s1",
      name: "prod",
      host: "10.0.0.1",
      port: 22,
      username: "ops",
      privateKeyPath: "/home/me/.ssh/id_prod",
      proxyJump: "bastion",
      extraOptions: "-o X",
      tunnels: [{ id: "t", localPort: 1 }],
      shared: true,
      updatedAt: "2026-01-01T00:00:00Z",
    } as never;
    await store.syncSharedFile(shared, [server]);
    const text = await fs.readFile(shared, "utf8");
    expect(text).not.toContain("id_prod");
    expect(text).not.toContain("bastion");
    expect(text).not.toContain("tunnels");
    const before = (await fs.stat(shared)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.syncSharedFile(shared, [server]);
    expect((await fs.stat(shared)).mtimeMs).toBe(before);
  });
});
