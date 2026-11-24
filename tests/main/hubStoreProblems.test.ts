import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * A store file that is empty, broken or cannot be read never turns into "fresh start" or "all is
 * well" without a word. A secret that cannot be decrypted on one start is still there on the next.
 * A save that fails says so and does not take the app down.
 */

const keyring = vi.hoisted(() => ({
  available: false,
  /** Set to make every decrypt fail, as with a key that is missing or was replaced. */
  broken: false,
  /** As on the web server: a credential may never be written unencrypted. */
  mustEncrypt: false,
}));

vi.mock("electron", () => {
  const safeStorage = {
    isEncryptionAvailable: () => keyring.available,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`, "utf8"),
    decryptString: (buf: Buffer) => {
      if (keyring.broken) throw new Error("private key cannot be opened");
      return buf.toString("utf8").replace(/^cipher:/, "");
    },
    get requiresEncryptedPersistence() {
      return keyring.mustEncrypt;
    },
  };
  const mock = { safeStorage, powerMonitor: undefined, app: undefined };
  return { ...mock, default: mock };
});

import { HubStore } from "../../src/main/ai/hub/HubStore";

const dirs: string[] = [];
beforeEach(() => {
  keyring.available = false;
  keyring.broken = false;
  keyring.mustEncrypt = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function tmp(): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-store-problems-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "hub.json") };
}

const memory = { id: "m", kind: "memory", scope: "workspace", title: "keep me", text: "x", updatedAt: 1 } as never;
const grafana = (token: string) => ({ id: "m1", name: "Grafana", transport: "http" as const, url: "https://grafana.internal/mcp", headers: { Authorization: token }, env: { GRAFANA_TOKEN: token }, enabled: true });
const TOKEN = "Bearer glsa_abcdefghijklmnop"; // pragma: allowlist secret

describe("a store file that cannot be used", () => {
  it("says nothing while all is well, also on a first start with no file", async () => {
    const { file } = await tmp();
    const store = new HubStore(file);
    await store.load();
    expect(store.problem).toBeUndefined();
    await store.save();
    expect(store.problem).toBeUndefined();
  });

  it("says that the file is missing when the folder still holds what the hub wrote beside it", async () => {
    const { dir, file } = await tmp();
    await fs.mkdir(path.join(dir, "audit"));
    await fs.writeFile(path.join(dir, "audit", "audit-client-1.jsonl"), "{}\n");
    await fs.mkdir(path.join(dir, "recordings"));
    await fs.writeFile(path.join(dir, "recordings", "run-1.cast"), "{}\n");
    // An empty folder of the hub's is no sign of an earlier start.
    await fs.mkdir(path.join(dir, "facts"));
    const store = new HubStore(file);
    await store.load();
    expect(store.problem).toBe(
      `The AI hub's data file is missing, though its folder still holds the audit log, terminal recordings: it was moved or deleted. The hub started fresh: conversations, memory, settings and safety rules are at their defaults. If you have a copy, close sshs3, put it back as ${file} and start sshs3 again.`,
    );
    expect(store.data.memories).toEqual([]);
    // It goes on and saves: there was nothing there to write over.
    store.data.memories.push(memory);
    await store.save();
    const again = new HubStore(file);
    await again.load();
    expect(again.data.memories).toHaveLength(1);
    expect(again.problem).toBeUndefined();
  });

  it("keeps an empty file beside it and says that the hub started fresh", async () => {
    const { dir, file } = await tmp();
    await fs.writeFile(file, "");
    const store = new HubStore(file);
    await store.load();
    const copy = (await fs.readdir(dir)).find((n) => n.startsWith("hub.json.corrupt-"));
    expect(copy).toBeDefined();
    expect(store.problem).toMatch(/data file was empty, so the hub started fresh/);
    expect(store.problem).toMatch(/safety rules are at their defaults/);
    expect(store.problem).toContain(copy!);
    // It can be saved again from here.
    store.data.memories.push(memory);
    await store.save();
    expect(JSON.parse(await fs.readFile(file, "utf8")).memories).toHaveLength(1);
  });

  it("keeps a file that is not a store beside it and says so", async () => {
    const { dir, file } = await tmp();
    await fs.writeFile(file, '{"version":1,"tasks":[{"id":"t1"');
    const store = new HubStore(file);
    await store.load();
    const copy = (await fs.readdir(dir)).find((n) => n.startsWith("hub.json.corrupt-"))!;
    expect(await fs.readFile(path.join(dir, copy), "utf8")).toBe('{"version":1,"tasks":[{"id":"t1"');
    expect(store.problem).toMatch(/could not be understood, so the hub started fresh/);
    expect(store.problem).toContain(copy);
  });

  it("says that nothing is saved while the file cannot be read, and saves nothing", async () => {
    const { file } = await tmp();
    const first = new HubStore(file);
    await first.load();
    first.data.memories.push(memory);
    await first.save();
    const before = await fs.readFile(file, "utf8");

    const store = new HubStore(file);
    vi.spyOn(fs, "readFile").mockImplementationOnce(async () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });
    await expect(store.load()).rejects.toThrow(/could not be read/);
    vi.restoreAllMocks();
    expect(store.problem).toMatch(/could not be read \(EBUSY: resource busy or locked\)/);
    expect(store.problem).toMatch(/runs with default settings and safety rules, and saves nothing until this is fixed/);
    store.data.memories.push({ ...(memory as object), id: "other", title: "written over" } as never);
    await store.save();
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("is told to the person in the hub's snapshot", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const { dir, file } = await tmp();
    await fs.writeFile(file, "{ not json");
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        aiConfigFilePath: path.join(dir, "ai.json"),
        workspaceServers: async () => [],
        closeSession: () => {},
        manageAppSettings: async () => ({}),
      } as never,
      dir,
    );
    try {
      const snapshot = await hub.snapshot();
      expect(snapshot.storeProblem).toMatch(/could not be understood, so the hub started fresh/);
    } finally {
      await hub.dispose();
      setDemoModeForTesting(undefined);
    }
  });
});

describe("a secret of an MCP server that cannot be read on one start", () => {
  it("is kept as it was stored and written back unchanged, and is there again when the key is back", async () => {
    keyring.available = true;
    const { file } = await tmp();
    const first = new HubStore(file);
    await first.load();
    first.data.mcpServers = [grafana(TOKEN)];
    await first.save();
    const stored = JSON.parse(await fs.readFile(file, "utf8")).mcpServers[0];
    expect(stored.headers.Authorization).toMatch(/^enc:v1:/);

    // A start with the key broken: the secret cannot be read.
    keyring.broken = true;
    const second = new HubStore(file);
    await second.load();
    expect(second.data.mcpServers![0].headers).toEqual({ Authorization: "" });
    expect(second.problem).toMatch(/3 secrets of MCP servers could not be read on this start/);
    expect(second.problem).toMatch(/kept as stored/);
    // The hub saves, as it does every few seconds.
    second.data.memories.push(memory);
    await second.save();
    const after = JSON.parse(await fs.readFile(file, "utf8"));
    expect(after.mcpServers[0].headers.Authorization).toBe(stored.headers.Authorization);
    expect(after.mcpServers[0].env.GRAFANA_TOKEN).toBe(stored.env.GRAFANA_TOKEN);
    expect(after.mcpServers[0].url).toBe(stored.url);
    expect(after.memories).toHaveLength(1);

    // The key is fixed: the secret is read again.
    keyring.broken = false;
    const third = new HubStore(file);
    await third.load();
    expect(third.data.mcpServers![0].headers).toEqual({ Authorization: TOKEN });
    expect(third.problem).toBeUndefined();
  });

  it("is replaced when the person enters it again, and gone with a server that was removed", async () => {
    keyring.available = true;
    const { file } = await tmp();
    const first = new HubStore(file);
    await first.load();
    first.data.mcpServers = [grafana(TOKEN), { ...grafana(TOKEN), id: "m2", name: "Other" }];
    await first.save();

    keyring.broken = true;
    const second = new HubStore(file);
    await second.load();
    keyring.broken = false;
    second.data.mcpServers![0].headers = { Authorization: "Bearer new-token-entered-again" }; // pragma: allowlist secret
    second.data.mcpServers = [second.data.mcpServers![0]];
    await second.save();
    const third = new HubStore(file);
    await third.load();
    expect(third.data.mcpServers).toHaveLength(1);
    expect(third.data.mcpServers![0].headers).toEqual({ Authorization: "Bearer new-token-entered-again" }); // pragma: allowlist secret
    // The fields that were not entered again are still the stored ones.
    expect(third.data.mcpServers![0].env).toEqual({ GRAFANA_TOKEN: TOKEN });
  });
});

describe("a save that cannot go through", () => {
  it("never throws: it comes back as a rejected promise, and the hub says what was not saved", async () => {
    const { file } = await tmp();
    const store = new HubStore(file);
    await store.load();
    // Something that cannot be written as JSON at all.
    (store.data as unknown as { broken: unknown }).broken = 10n;
    let returned: Promise<void> | undefined;
    expect(() => {
      returned = store.save();
    }).not.toThrow();
    await expect(returned).rejects.toThrow();
    expect(store.problem).toMatch(/could not be saved/);
    // Fixed: the next save goes through and the notice is gone.
    Reflect.deleteProperty(store.data, "broken");
    await store.save();
    expect(store.problem).toBeUndefined();
  });

  it("on a server whose key is broken: saves everything but the secret it cannot encrypt, and says so", async () => {
    // The web server: no credential is ever written unencrypted, and its key cannot be used.
    keyring.available = false;
    keyring.mustEncrypt = true;
    const { file } = await tmp();
    const store = new HubStore(file);
    await store.load();
    store.data.memories.push(memory);
    store.data.mcpServers = [grafana(TOKEN)];
    let returned: Promise<void> | undefined;
    expect(() => {
      returned = store.save();
    }).not.toThrow();
    await expect(returned).resolves.toBeUndefined();
    const raw = await fs.readFile(file, "utf8");
    expect(JSON.parse(raw).memories).toHaveLength(1);
    expect(raw).not.toContain("glsa_abcdefghijklmnop");
    expect(store.problem).toMatch(/A secret of an MCP server could not be saved \(Cannot save this credential securely/);
    expect(store.problem).toMatch(/The rest was saved/);
  });

  it("leaves no temporary file behind, and the file is the owner's alone", async () => {
    const { dir, file } = await tmp();
    const store = new HubStore(file);
    await store.load();
    await Promise.all([store.save(), store.save(), store.save()]);
    expect(await fs.readdir(dir)).toEqual(["hub.json"]);
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
