import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleAppAction } from "../../src/main/ai/hub/AppActions";
import type { AgentTask } from "../../src/shared/types/aiHub";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const session = (id: string, at: number, extra: Partial<AgentTask>): AgentTask => ({
  id,
  title: id,
  mode: "assisted",
  status: "completed",
  messages: [],
  changes: [],
  sources: [],
  createdAt: at,
  updatedAt: at,
  maxCommands: 5,
  maxMinutes: 5,
  verification: "not-verified",
  ...extra,
});

async function hubWith(tasks: AgentTask[]) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-sessions-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") },
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });
  await hub.initialize();
  hub.store.data.tasks.push(...tasks);
  return hub;
}

const current = session("now", 9000, { title: "current conversation about nginx", status: "running" });
const search = (hub: Awaited<ReturnType<typeof hubWith>>, payload: Record<string, unknown>) =>
  handleAppAction(hub.appActionHost(), current, { action: "sshs3_session_search", payload } as never) as Promise<Record<string, any>>;

const sessions = [
  session("old-nginx", 1000, {
    title: "SSE streams drop",
    target: { sessionId: "s", generation: "g", label: "prod-api-01" },
    messages: [
      { id: "1", role: "user", text: "SSE streams drop after 60s on prod-api-01", at: 1000 },
      { id: "2", role: "assistant", text: "Raised proxy_read_timeout to 120s in nginx.", at: 1100 },
    ],
    changes: [{ id: "c", kind: "command", target: "prod-api-01", description: "", command: "nginx -t", status: "completed", exitCode: 0, output: "syntax is ok", at: 1050 }],
    todos: [{ id: "t1", content: "Raise timeout", status: "completed", note: "nginx -t ok" }],
    verification: "verified",
  }),
  session("new-nginx", 5000, { title: "nginx bind fails", messages: [{ id: "1", role: "user", text: "nginx cannot bind 443", at: 5000 }] }),
  session("postgres", 3000, { title: "Postgres connections", messages: [{ id: "1", role: "user", text: "raise max_connections", at: 3000 }] }),
  session("specialist", 6000, { title: "nginx specialist run", workforceRunId: "wf-1" }),
  session("memory-run", 7000, { title: "nginx memory run", distillSourceId: "task:x" }),
  current,
];

describe("sshs3_session_search", () => {
  it("finds the user's earlier conversations that mention every word, newest first, with the matching lines", async () => {
    const hub = await hubWith(sessions);
    const result = await search(hub, { query: "nginx" });
    // Not this conversation, and not the runs the hub started itself.
    expect(result.conversations.map((c: { id: string }) => c.id)).toEqual(["new-nginx", "old-nginx"]);
    expect(result.conversations[1]).toMatchObject({ title: "SSE streams drop", target: "prod-api-01", status: "completed" });
    expect(result.conversations[1].matching.join(" ")).toContain("Raised proxy_read_timeout to 120s in nginx.");

    const both = await search(hub, { query: "nginx timeout" });
    expect(both.conversations.map((c: { id: string }) => c.id)).toEqual(["old-nginx"]);
    expect((await search(hub, { query: "kafka" })).found).toBe(0);
    expect((await search(hub, { query: "nginx", limit: 1 })).conversations).toHaveLength(1);
  });

  it("reads one conversation in full: what was said, the task list, and the commands with their results", async () => {
    const hub = await hubWith(sessions);
    const full = await search(hub, { id: "old-nginx" });
    expect(full).toMatchObject({ id: "old-nginx", target: "prod-api-01", verification: "verified" });
    expect(full.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(full.todos[0]).toMatchObject({ content: "Raise timeout", note: "nginx -t ok" });
    expect(full.changes[0]).toMatchObject({ command: "nginx -t", exitCode: 0, output: "syntax is ok" });
  });

  it("refuses an id that is not one of the user's conversations, and a call with nothing to look for", async () => {
    const hub = await hubWith(sessions);
    await expect(search(hub, { id: "specialist" })).rejects.toThrow(/No earlier conversation/);
    await expect(search(hub, { id: "now" })).rejects.toThrow(/No earlier conversation/);
    await expect(search(hub, {})).rejects.toThrow(/query or an id/);
  });
});
