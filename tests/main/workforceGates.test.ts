import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Pause, budget and outside text, however an agent or a ticket gets going. From the review of feature 5. */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

async function hub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-gates-"));
  const h = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), workspaceServers: async () => [] } as never,
    dir,
  );
  disposals.push(async () => {
    await h.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await h.initialize();
  return h;
}

const agent = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, role: "r", mission: "m", systemPrompt: "", defaultMode: "assisted", ...extra }) as never;

describe("an agent that is paused or out of budget", () => {
  it("is not started by a chat, a handoff or a workforce run that names it", async () => {
    const h = await hub();
    await h.request({ action: "agent-save", agent: agent("sleeper", { enabled: false }) });
    await h.request({ action: "agent-save", agent: agent("broke", { monthlyTokenBudget: 1000 }) });
    (h as unknown as { store: { data: { agentUsage: Record<string, unknown> } } }).store.data.agentUsage = {
      broke: { month: new Date().toISOString().slice(0, 7), tokens: 5000, runs: 1 },
    };
    await expect(h.request({ action: "start", task: { prompt: "hi", agentId: "sleeper" } as never })).rejects.toThrow(/paused/);
    await expect(h.request({ action: "start", task: { prompt: "hi", agentId: "broke" } as never })).rejects.toThrow(/token budget/);
    const select = (ids: string[]) => (h as unknown as { selectWorkforceAgents: (o: { agentIds: string[] }) => Array<{ id: string }> }).selectWorkforceAgents({ agentIds: ids });
    // Naming only a paused agent runs nobody, not everybody else.
    expect(() => select(["sleeper"])).toThrow(/None of sleeper can run/);
    // Out of budget: left out.
    expect(select(["broke", "sleeper"]).map((a) => a.id)).toEqual([]);
  });
});

describe("work that came from outside the team", () => {
  it("is marked, and a ticket an agent splits off it waits in Backlog for a person", async () => {
    const h = await hub();
    await h.request({ action: "agent-save", agent: agent("fixer") });
    let snap = await h.request({ action: "ticket-save", ticket: { title: "From a key", status: "backlog", outside: "an MCP key of Jacob" } });
    const parent = snap.workTickets!.find((t) => t.title === "From a key")!;
    expect(parent.outside).toBe("an MCP key of Jacob");
    const child = await h.saveTicketFrom({ title: "Do what it says", assigneeAgentId: "fixer", parentId: parent.id }, "fixer", true);
    expect(child.status).toBe("backlog");
    expect(child.outside).toContain("From a key");
    // A person assigning the same work puts it in To do as always.
    const byPerson = await h.saveTicketFrom({ title: "Do what it says", assigneeAgentId: "fixer", parentId: parent.id });
    expect(byPerson.status).toBe("todo");
    snap = await h.request({ action: "snapshot" });
    expect(snap.workTickets!.filter((t) => t.outside).length).toBe(3);
  });
});
