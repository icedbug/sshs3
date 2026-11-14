import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryEntry, MissionAgent, WorkspaceServerSummary } from "../../src/shared/types/aiHub";
import type { FileEntry, IStorageProvider } from "../../src/shared/types/storage";
import { mergeS3WorkspacePayload } from "../../src/main/ai/hub/S3WorkspaceSyncService";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";

/**
 * The removal rule of the team-sync round (a removal newer than the version an edit started from
 * wins over the edit, and the editor is told who removed it) for team memories, shared servers and
 * agents: two hubs sharing one bucket.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** The team bucket as the workspace sync sees it. */
function bucketProvider(objects: Map<string, Buffer>): IStorageProvider {
  const norm = (p: string): string => p.replace(/^\/+|\/+$/g, "");
  const missing = (key: string): Error => Object.assign(new Error(`NoSuchKey: ${key}`), { code: "NoSuchKey" });
  return {
    id: "mem-s3",
    name: "bucket",
    type: "s3",
    connect: async () => {},
    disconnect: async () => {},
    createFolder: async () => {},
    list: async (dir: string): Promise<FileEntry[]> => {
      const prefix = `${norm(dir)}/`;
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map(([k, v]) => ({ name: k.slice(prefix.length), path: k, isDirectory: false, size: v.length, mtime: "2026-01-01T00:00:00Z" }));
    },
    stat: async (p: string): Promise<FileEntry> => {
      const v = objects.get(norm(p));
      if (!v) throw missing(p);
      return { name: path.basename(p), path: norm(p), isDirectory: false, size: v.length, mtime: `${v.length}` };
    },
    readFile: async (p: string) => {
      const v = objects.get(norm(p));
      if (!v) throw missing(p);
      return v;
    },
    writeFile: async (p: string, content: Buffer) => void objects.set(norm(p), Buffer.from(content)),
    delete: async (p: string) => void objects.delete(norm(p)),
  } as unknown as IStorageProvider;
}

/** A computer's own server list (the profile store), as createHub keeps it in step with the team's. */
function profileStore() {
  const profiles = new Map<string, WorkspaceServerSummary>();
  const time = (s?: string): number => Date.parse(s ?? "") || 0;
  return {
    profiles,
    host: {
      workspaceServers: async () => [...profiles.values()],
      upsertServer: async (input: Partial<WorkspaceServerSummary>) => {
        const id = input.id?.trim() || crypto.randomUUID();
        const saved = { ...profiles.get(id), ...input, id, port: input.port || 22, shared: input.shared ?? true, updatedAt: new Date().toISOString() } as WorkspaceServerSummary;
        profiles.set(id, saved);
        return saved;
      },
      deleteServer: async (id: string) => void profiles.delete(id),
      syncSharedServersFromS3: async (servers: WorkspaceServerSummary[], deleted: Record<string, string>) => {
        for (const [id, iso] of Object.entries(deleted)) {
          const p = profiles.get(id);
          if (p && p.shared !== false && time(iso) >= time(p.updatedAt)) profiles.delete(id);
        }
        for (const s of servers) {
          const p = profiles.get(s.id);
          if (p?.shared === false) continue;
          // The profile store keeps its own fields, not the edit's base.
          const { baseAt: _base, ...copy } = s;
          if (!p || time(s.updatedAt) > time(p.updatedAt)) profiles.set(s.id, copy);
        }
      },
    },
  };
}

type WorkspaceInner = { s3Workspace: { syncNow: () => Promise<void> } };

async function workspaceHub(name: string, bucket: Map<string, Buffer>) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `sshs3-teamsync4-${name.split(" ")[0]}-`));
  const store = profileStore();
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai-config.json"),
      defaultActorName: name,
      s3ProviderFactory: () => bucketProvider(bucket),
      ...store.host,
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  await hub.request({
    action: "workspace-s3-configure",
    config: { enabled: true, region: "eu-north-1", bucket: "team", prefix: "ws", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "x" }, // pragma: allowlist secret
  } as never);
  const sync = () => (hub as unknown as WorkspaceInner).s3Workspace.syncNow();
  return { hub, profiles: store.profiles, sync };
}

const workspaceJson = (bucket: Map<string, Buffer>) => {
  const key = [...bucket.keys()].find((k) => k.endsWith("workspace.json"))!;
  return JSON.parse(bucket.get(key)!.toString("utf8")) as {
    memories: MemoryEntry[];
    servers: WorkspaceServerSummary[];
    deletedMemoryIds: Record<string, number>;
    deletedServerIds: Record<string, string>;
    deletedMemoryBy?: Record<string, string>;
    deletedServerBy?: Record<string, string>;
  };
};

const memory = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  kind: "memory",
  scope: "workspace",
  title: "Backups",
  text: "Backups run at 02:00.",
  updatedAt: 100,
  ...extra,
});

describe("the workspace merge: a removal and an edit made on a view from before it", () => {
  const empty = { version: 1 as const, updatedAt: 1, servers: [], memories: [], activityLog: [] };

  it("keeps a team memory removed, one step above the edit, with who removed it", () => {
    // Sara removed it at 200; Anna's edit at 300 was made on the version of 100.
    const edit = memory("m1", { text: "Backups run at 03:00.", updatedAt: 300, baseAt: 100 });
    const removal = { ...empty, deletedMemoryIds: { m1: 200 }, deletedMemoryBy: { m1: "Sara Nyberg" } };
    const onAnna = mergeS3WorkspacePayload({ ...empty, memories: [edit] }, removal);
    expect(onAnna.merged.memories).toEqual([]);
    expect(onAnna.merged.deletedMemoryIds?.m1).toBe(301);
    expect(onAnna.merged.deletedMemoryBy).toEqual({ m1: "Sara Nyberg" });
    // The other way round (the edit reached the bucket first): the same.
    const onSara = mergeS3WorkspacePayload(removal, { ...empty, memories: [edit] });
    expect(onSara.merged.memories).toEqual([]);
    expect(onSara.merged.deletedMemoryIds?.m1).toBe(301);
    // An edit made after the removal was seen (a new memory under the id, or no base known) stays.
    expect(mergeS3WorkspacePayload({ ...empty, memories: [{ ...edit, baseAt: 250 }] }, removal).merged.memories).toHaveLength(1);
    expect(mergeS3WorkspacePayload({ ...empty, memories: [{ ...edit, baseAt: undefined }] }, removal).merged.memories).toHaveLength(1);
  });

  it("keeps a shared server removed, and the server list says so", () => {
    const server: WorkspaceServerSummary = {
      id: "s1",
      name: "db-01",
      host: "10.0.0.5",
      port: 22,
      username: "ops",
      shared: true,
      updatedAt: "2026-11-14T10:05:00.000Z",
      baseAt: "2026-11-14T10:00:00.000Z",
    };
    const removal = { ...empty, deletedServerIds: { s1: "2026-11-14T10:02:00.000Z" }, deletedServerBy: { s1: "Sara Nyberg" } };
    const out = mergeS3WorkspacePayload({ ...empty, servers: [server] }, removal);
    expect(out.activeServers).toEqual([]);
    expect(Date.parse(out.merged.deletedServerIds?.s1 ?? "")).toBe(Date.parse(server.updatedAt!) + 1);
    expect(out.merged.servers[0].deletedAt).toBe(out.merged.deletedServerIds?.s1);
    expect(out.merged.deletedServerBy).toEqual({ s1: "Sara Nyberg" });
    expect(mergeS3WorkspacePayload({ ...empty, servers: [{ ...server, baseAt: "2026-11-14T10:03:00.000Z" }] }, removal).activeServers).toHaveLength(1);
  });
});

describe("a team memory a teammate removed", () => {
  it("is not brought back by an edit on an old view, on either computer, and a later save is told who removed it", async () => {
    const bucket = new Map<string, Buffer>();
    const anna = await workspaceHub("Anna Lind", bucket);
    const sara = await workspaceHub("Sara Nyberg", bucket);
    await anna.hub.request({ action: "memory-save", entry: { kind: "memory", scope: "workspace", title: "Backups", text: "Backups run at 02:00." } } as never);
    const id = anna.hub.store.data.memories.find((m) => m.title === "Backups")!.id;
    await anna.sync();
    await sara.sync();
    expect(sara.hub.store.data.memories.some((m) => m.id === id)).toBe(true);

    // Sara forgets it; before that reaches the bucket, Anna corrects it on her view.
    await sara.hub.request({ action: "memory-delete", id } as never);
    await new Promise((r) => setTimeout(r, 5));
    await anna.hub.request({ action: "memory-save", entry: { id, kind: "memory", scope: "workspace", title: "Backups", text: "Backups run at 03:00." } } as never);
    await anna.sync();
    await sara.sync();
    await anna.sync();
    expect(sara.hub.store.data.memories.some((m) => m.id === id)).toBe(false);
    expect(anna.hub.store.data.memories.some((m) => m.id === id)).toBe(false);
    const team = workspaceJson(bucket);
    expect(team.memories.some((m) => m.id === id)).toBe(false);
    expect(team.deletedMemoryBy?.[id]).toBe("Sara Nyberg");

    // Saved again from the old view: refused, with who removed it.
    await expect(
      anna.hub.request({ action: "memory-save", entry: { id, kind: "memory", scope: "workspace", title: "Backups", text: "Backups run at 04:00." } } as never),
    ).rejects.toThrow(/This memory was removed by Sara Nyberg at .* UTC, so the change was not saved/);
    expect(anna.hub.store.data.memories.some((m) => m.id === id)).toBe(false);
  });

  it("is refused at once when the removal is already in the bucket", async () => {
    const bucket = new Map<string, Buffer>();
    const anna = await workspaceHub("Anna Lind", bucket);
    const sara = await workspaceHub("Sara Nyberg", bucket);
    await anna.hub.request({ action: "memory-save", entry: { kind: "memory", scope: "workspace", title: "Disks", text: "Disk alerts at 90 %." } } as never);
    const id = anna.hub.store.data.memories.find((m) => m.title === "Disks")!.id;
    await anna.sync();
    await sara.sync();
    await sara.hub.request({ action: "memory-delete", id } as never);
    await sara.sync();
    // Anna has not synced since: the save reads the bucket first.
    expect(anna.hub.store.data.memories.some((m) => m.id === id)).toBe(true);
    await expect(
      anna.hub.request({ action: "memory-save", entry: { id, kind: "memory", scope: "workspace", title: "Disks", text: "Disk alerts at 85 %." } } as never),
    ).rejects.toThrow(/removed by Sara Nyberg/);
    await anna.sync();
    await sara.sync();
    expect(sara.hub.store.data.memories.some((m) => m.id === id)).toBe(false);
  });
});

describe("a shared server a teammate removed", () => {
  it("is not brought back by an edit on an old view, on either computer, and a later save is told who removed it", async () => {
    const bucket = new Map<string, Buffer>();
    const anna = await workspaceHub("Anna Lind", bucket);
    const sara = await workspaceHub("Sara Nyberg", bucket);
    await anna.hub.request({ action: "server-upsert", server: { name: "db-01", host: "10.0.0.5", username: "ops" } } as never);
    const id = [...anna.profiles.values()][0].id;
    await anna.sync();
    await sara.sync();
    expect(sara.profiles.has(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 5));

    // Sara removes it; before that reaches the bucket, Anna describes it on her view.
    await sara.hub.request({ action: "server-delete", profileId: id } as never);
    await new Promise((r) => setTimeout(r, 5));
    await anna.hub.request({ action: "server-upsert", server: { id, name: "db-01", host: "10.0.0.5", username: "ops", description: "Primary database" } } as never);
    await anna.sync();
    await sara.sync();
    await anna.sync();
    expect(sara.profiles.has(id)).toBe(false);
    expect(anna.profiles.has(id)).toBe(false);
    const team = workspaceJson(bucket);
    expect(team.servers.find((s) => s.id === id)?.deletedAt).toBeTruthy();
    expect(team.deletedServerBy?.[id]).toBe("Sara Nyberg");

    await expect(
      anna.hub.request({ action: "server-upsert", server: { id, name: "db-01", host: "10.0.0.5", username: "ops", description: "Still here?" } } as never),
    ).rejects.toThrow(/This server was removed by Sara Nyberg at .* UTC, so the change was not saved/);
    // The connection editor asks the same.
    await expect(anna.hub.assertMayChangeServerProfile({ id, name: "db-01", host: "10.0.0.5" })).rejects.toThrow(/removed by Sara Nyberg/);
    expect(anna.profiles.has(id)).toBe(false);
    // As a person's own server it is theirs to keep.
    await expect(anna.hub.assertMayChangeServerProfile({ id, name: "db-01", host: "10.0.0.5", shared: false })).resolves.toBeUndefined();
  });
});

// ---- agents, through the board's bucket ------------------------------------------------------------

function memoryBucket(): QueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => files.get(p),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}

type BoardInner = {
  workTick: (now?: number) => Promise<void>;
  lastWorkSync: number;
  workSyncStore?: WorkSync;
  s3Workspace: { canUseBucket: () => boolean; objects: QueueStore };
};

async function boardHub(name: string, bucket: QueueStore) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-teamsync4-board-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), defaultActorName: name } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const inner = hub as unknown as BoardInner;
  inner.s3Workspace.canUseBucket = () => true;
  Object.defineProperty(inner.s3Workspace, "objects", { value: bucket });
  inner.workSyncStore = new WorkSync(bucket);
  const sync = async () => {
    inner.lastWorkSync = 0;
    await inner.workTick(Date.now());
  };
  return { hub, sync };
}

const agentInput = (extra: Partial<MissionAgent> = {}) => ({ id: "dba", name: "DBA", role: "Databases", mission: "Keep the databases healthy", systemPrompt: "", defaultMode: "assisted", ...extra });
const agentOf = (hub: { store: { data: { agents?: MissionAgent[] } } }) => (hub.store.data.agents ?? []).find((a) => a.id === "dba");

describe("an agent", () => {
  it("removed by a teammate is not brought back by an edit on an old view, and a later save is told who removed it", async () => {
    const bucket = memoryBucket();
    const anna = await boardHub("Anna Lind", bucket);
    const sara = await boardHub("Sara Nyberg", bucket);
    await anna.hub.request({ action: "agent-save", agent: agentInput() } as never);
    await anna.sync();
    await sara.sync();
    expect(agentOf(sara.hub)).toBeDefined();
    await new Promise((r) => setTimeout(r, 5));

    await sara.hub.request({ action: "agent-delete", id: "dba" } as never);
    await new Promise((r) => setTimeout(r, 5));
    await anna.hub.request({ action: "agent-save", agent: agentInput({ mission: "Keep the databases healthy and backed up" }) } as never);
    await anna.sync();
    await sara.sync();
    await anna.sync();
    expect(agentOf(sara.hub)).toBeUndefined();
    expect(agentOf(anna.hub)).toBeUndefined();
    expect(JSON.parse(bucket.files.get("work/agents/dba.json")!.toString("utf8"))).toMatchObject({ deleted: true, deletedBy: "Sara Nyberg" });

    await expect(anna.hub.request({ action: "agent-save", agent: agentInput({ mission: "Once more" }) } as never)).rejects.toThrow(
      /This agent was removed by Sara Nyberg at .* UTC, so the change was not saved/,
    );
  });

  it("keeps two people's changes of different fields", async () => {
    const bucket = memoryBucket();
    const anna = await boardHub("Anna Lind", bucket);
    const sara = await boardHub("Sara Nyberg", bucket);
    await anna.hub.request({ action: "agent-save", agent: agentInput() } as never);
    await anna.sync();
    await sara.sync();
    await new Promise((r) => setTimeout(r, 5));

    // Within one sync of each other: Sara renames it, Anna (later) changes its mission.
    await sara.hub.request({ action: "agent-save", agent: agentInput({ name: "Database keeper" }) } as never);
    await new Promise((r) => setTimeout(r, 5));
    await anna.hub.request({ action: "agent-save", agent: agentInput({ mission: "Keep the databases backed up" }) } as never);
    await sara.sync();
    await anna.sync();
    await sara.sync();
    for (const side of [anna, sara]) expect(agentOf(side.hub)).toMatchObject({ name: "Database keeper", mission: "Keep the databases backed up" });
  });
});
