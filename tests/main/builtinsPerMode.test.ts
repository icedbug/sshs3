import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setDemoModeForTesting } from "../../src/main/demo/demoMode";
import {
  getBuiltinAgents,
  getBuiltinKbDocuments,
  getBuiltinSkillsAndMemories,
  getBuiltinSnippets,
} from "../../src/main/ai/hub/demoWorkspace";
import { SnippetStore } from "../../src/main/snippets/SnippetStore";
import { registerSnippetHandlers, type AppDataHost } from "../../src/main/ipc/appDataHandlers";
import { IPC_CHANNELS } from "../../src/shared/types/ipc";
import type { Snippet } from "../../src/shared/types/snippets";
import type { HubHost } from "../../src/main/ai/hub/HubService";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  setDemoModeForTesting(undefined);
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Words and addresses of the demo lab (NetApp/Acme, 10.30.x) that neutral defaults must not contain. */
const DEMO_CONTENT = /netapp|ontap|acme|storagegrid|trident|ceph|truenas|zfs|10\.30\./i;
/** Swedish letters: the neutral defaults are English. */
const SWEDISH_LETTERS = /[åäöÅÄÖ]/;

describe("built-ins per mode", () => {
  it("outside demo mode are a few neutral, generic, English defaults", () => {
    setDemoModeForTesting(false);
    const agents = getBuiltinAgents();
    const snippets = getBuiltinSnippets();

    expect(agents.map((a) => a.id)).toEqual(["builtin-agent-general"]);
    expect(agents[0]).toMatchObject({ defaultMode: "assisted", kbDocIds: [], mcpServerIds: [] });
    expect(snippets.length).toBeGreaterThanOrEqual(4);
    expect(snippets.length).toBeLessThanOrEqual(10);
    const commands = snippets.map((s) => s.command);
    expect(commands).toContain("df -h");
    expect(commands.some((c) => c.startsWith("ps "))).toBe(true);
    expect(commands.some((c) => c.startsWith("journalctl -p err"))).toBe(true);
    expect(commands.some((c) => c.startsWith("kubectl get pods") && c.includes("status.phase!=Running"))).toBe(true);
    expect(getBuiltinKbDocuments()).toEqual([]);
    expect(getBuiltinSkillsAndMemories()).toEqual([]);

    const text = JSON.stringify([agents, snippets]);
    expect(text).not.toMatch(DEMO_CONTENT);
    expect(text).not.toMatch(SWEDISH_LETTERS);
    expect([...agents, ...snippets].some((item) => item.id.startsWith("demo-"))).toBe(false);
    expect(new Set(snippets.map((s) => s.id)).size).toBe(snippets.length);
  });

  it("hands out fresh copies, so a caller cannot change the defaults", () => {
    setDemoModeForTesting(false);
    const [agent] = getBuiltinAgents();
    agent.name = "changed";
    agent.allowedTools?.push("changed");
    getBuiltinSnippets()[0].command = "changed";
    expect(getBuiltinAgents()[0].name).not.toBe("changed");
    expect(getBuiltinAgents()[0].allowedTools).toEqual(["all"]);
    expect(getBuiltinSnippets()[0].command).toBe("df -h");
  });

  it("in demo mode are the demo workspace's fixtures, without the neutral defaults", () => {
    setDemoModeForTesting(true);
    const agentIds = getBuiltinAgents().map((a) => a.id);
    const snippetIds = getBuiltinSnippets().map((s) => s.id);
    expect(agentIds).toContain("demo-agent-ontap-architect");
    expect(agentIds).not.toContain("builtin-agent-general");
    expect(getBuiltinKbDocuments().map((d) => d.id)).toContain("demo-kb-ontap-cli-qos");
    expect(getBuiltinSkillsAndMemories().map((m) => m.id)).toContain("demo-skill-ontap-latency");
    expect(snippetIds).toContain("demo-snip-ontap-latency");
    expect(snippetIds).not.toContain("builtin-snip-disk-usage");
  });
});

describe("HubService built-ins", () => {
  async function createHub(dir: string) {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const host: HubHost = {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai-config.json"),
    };
    const hub = new HubService(host, dir);
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      await hub.dispose();
    };
    disposals.unshift(dispose);
    await hub.initialize();
    return { hub, dispose };
  }

  it("shows only the neutral defaults outside demo mode, and the demo workspace in demo mode", async () => {
    setDemoModeForTesting(false);
    const { hub } = await createHub(await tempDir("sshs3-builtins-hub-"));
    const normal = await hub.snapshot();
    expect((normal.agents ?? []).map((a) => a.id)).toEqual(["builtin-agent-general"]);
    expect(normal.kbDocuments).toEqual([]);
    expect(normal.memories).toEqual([]);

    setDemoModeForTesting(true);
    const demo = await hub.snapshot();
    expect(demo.agents?.some((a) => a.id === "demo-agent-ontap-architect")).toBe(true);
    expect(demo.agents?.some((a) => a.id === "builtin-agent-general")).toBe(false);
    expect(demo.kbDocuments?.some((d) => d.id === "demo-kb-ontap-cli-qos")).toBe(true);
    expect(demo.memories.some((m) => m.id === "demo-skill-ontap-latency")).toBe(true);
  });

  it("keeps a deleted built-in hidden across restarts, and records only built-in ids as dismissed", async () => {
    setDemoModeForTesting(false);
    const dir = await tempDir("sshs3-builtins-dismiss-");
    const first = await createHub(dir);

    await first.hub.request({
      action: "agent-save",
      agent: {
        id: "my-agent",
        name: "My agent",
        role: "Watcher",
        mission: "Watch my servers.",
        systemPrompt: "Only read.",
        defaultMode: "assisted",
      },
    });
    const afterOwnDelete = await first.hub.request({ action: "agent-delete", id: "my-agent" });
    expect(afterOwnDelete.agents?.some((a) => a.id === "my-agent")).toBe(false);
    expect(afterOwnDelete.preferences.dismissedBuiltinIds ?? []).toEqual([]);

    const afterBuiltinDelete = await first.hub.request({ action: "agent-delete", id: "builtin-agent-general" });
    expect(afterBuiltinDelete.agents ?? []).toEqual([]);
    expect(afterBuiltinDelete.preferences.dismissedBuiltinIds).toEqual(["builtin-agent-general"]);
    await first.dispose();

    const second = await createHub(dir);
    expect((await second.hub.snapshot()).agents ?? []).toEqual([]);
    const restored = await second.hub.request({ action: "restore-builtins" });
    expect((restored.agents ?? []).map((a) => a.id)).toEqual(["builtin-agent-general"]);
  });
});

describe("SnippetStore built-ins", () => {
  const builtins: Snippet[] = [
    { id: "builtin-a", name: "Disk usage", command: "df -h" },
    { id: "builtin-b", name: "Memory usage", command: "free -h" },
  ];

  async function newStore() {
    const file = path.join(await tempDir("sshs3-snip-builtins-"), "snippets.json");
    return { file, store: new SnippetStore(file) };
  }

  const readFile = async (file: string) => JSON.parse(await fs.readFile(file, "utf-8")) as Record<string, unknown>;

  it("lists the built-ins after the user's own snippets without storing them", async () => {
    const { file, store } = await newStore();
    const own = await store.save({ name: "Uptime", command: "uptime" });
    expect(await store.listWithBuiltins(builtins)).toEqual([own, ...builtins]);
    expect(await store.list()).toEqual([own]);
    expect(await readFile(file)).toEqual({ version: 1, snippets: [own] });
  });

  it("keeps a deleted built-in hidden, also for a new store on the same file", async () => {
    const { file, store } = await newStore();
    await store.hideBuiltin("builtin-a");
    await store.hideBuiltin("builtin-a");
    expect(await store.listWithBuiltins(builtins)).toEqual([builtins[1]]);
    expect(await new SnippetStore(file).listWithBuiltins(builtins)).toEqual([builtins[1]]);
    expect((await readFile(file)).hiddenBuiltinIds).toEqual(["builtin-a"]);
  });

  it("stores an edited built-in under its id, which replaces it instead of listing it twice", async () => {
    const { store } = await newStore();
    const edited = await store.save(
      { id: "builtin-a", name: "Disk usage (types)", command: "df -hT" },
      { replacesBuiltin: true },
    );
    expect(edited.id).toBe("builtin-a");
    expect(await store.listWithBuiltins(builtins)).toEqual([edited, builtins[1]]);

    // An unknown id that is not a built-in still gets a fresh one.
    const other = await store.save({ id: "not-stored", name: "x", command: "x" });
    expect(other.id).not.toBe("not-stored");

    // Deleting the built-in also deletes the user's edited copy of it.
    await store.hideBuiltin("builtin-a");
    expect(await store.listWithBuiltins(builtins)).toEqual([other, builtins[1]]);
  });

  it("replaces a built-in on every connection when its edited copy is limited to one", async () => {
    const { store } = await newStore();
    const edited = await store.save(
      { id: "builtin-a", name: "Disk usage", command: "df -h /srv", hostKey: "ssh:1", hostLabel: "one" },
      { replacesBuiltin: true },
    );
    expect(await store.listWithBuiltins(builtins, "ssh:1")).toEqual([edited, builtins[1]]);
    expect(await store.listWithBuiltins(builtins, "ssh:2")).toEqual([builtins[1]]);
  });

  it("reads files from before hidden built-ins existed, and ignores malformed hidden ids", async () => {
    const { file } = await newStore();
    const own: Snippet = { id: "own-1", name: "Uptime", command: "uptime" };
    await fs.writeFile(file, JSON.stringify({ version: 1, snippets: [own] }));
    expect(await new SnippetStore(file).listWithBuiltins(builtins)).toEqual([own, ...builtins]);

    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, snippets: [], hiddenBuiltinIds: ["builtin-a", 42, "", null, "builtin-a"] }),
    );
    const store = new SnippetStore(file);
    expect(await store.listWithBuiltins(builtins)).toEqual([builtins[1]]);
    await store.save({ name: "Uptime", command: "uptime" });
    expect((await readFile(file)).hiddenBuiltinIds).toEqual(["builtin-a"]);
  });
});

describe("snippet IPC handlers", () => {
  function snippetIpc(file: string) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const host = {
      registerHandler: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
      snippetStore: new SnippetStore(file),
    } as unknown as AppDataHost;
    registerSnippetHandlers(host);
    const invoke = async (channel: string, ...args: unknown[]) => await handlers.get(channel)!({}, ...args);
    return {
      list: async (hostKey?: string) => (await invoke(IPC_CHANNELS.SNIPPETS_LIST, hostKey)) as Snippet[],
      save: async (snippet: Partial<Snippet>) => (await invoke(IPC_CHANNELS.SNIPPETS_SAVE, snippet)) as Snippet,
      remove: async (id: string) => {
        await invoke(IPC_CHANNELS.SNIPPETS_DELETE, id);
      },
    };
  }

  it("lists the neutral built-ins, and a deleted one does not come back", async () => {
    setDemoModeForTesting(false);
    const file = path.join(await tempDir("sshs3-snip-ipc-"), "snippets.json");
    const ipc = snippetIpc(file);
    const defaults = getBuiltinSnippets();

    const own = await ipc.save({ name: "Uptime", command: "uptime" });
    expect(await ipc.list()).toEqual([own, ...defaults]);

    await ipc.remove("builtin-snip-disk-usage");
    const expected = [own, ...defaults.filter((s) => s.id !== "builtin-snip-disk-usage")];
    expect(await ipc.list()).toEqual(expected);
    // Still hidden after a restart (a new store and handlers on the same file).
    expect(await snippetIpc(file).list()).toEqual(expected);

    // Deleting the user's own snippet just deletes it.
    await ipc.remove(own.id);
    expect(await ipc.list()).toEqual(expected.slice(1));
    expect(JSON.parse(await fs.readFile(file, "utf-8"))).toEqual({
      version: 1,
      snippets: [],
      hiddenBuiltinIds: ["builtin-snip-disk-usage"],
    });
  });

  it("saves an edited built-in in its place instead of adding a second snippet", async () => {
    setDemoModeForTesting(false);
    const ipc = snippetIpc(path.join(await tempDir("sshs3-snip-ipc-edit-"), "snippets.json"));
    const [first, ...rest] = getBuiltinSnippets();

    const edited = await ipc.save({ id: first.id, name: first.name, command: "df -hT" });
    expect(edited).toEqual({ id: first.id, name: first.name, command: "df -hT" });
    expect(await ipc.list()).toEqual([edited, ...rest]);
  });

  it("lists the demo workspace's snippets in demo mode and none of the neutral defaults", async () => {
    setDemoModeForTesting(true);
    const ipc = snippetIpc(path.join(await tempDir("sshs3-snip-ipc-demo-"), "snippets.json"));
    const ids = (await ipc.list()).map((s) => s.id);
    expect(ids).toContain("demo-snip-ontap-latency");
    expect(ids).not.toContain("builtin-snip-disk-usage");
  });
});
