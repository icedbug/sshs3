import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MissionAgent, WorkTicket } from "../../src/shared/types/aiHub";
import {
  TICKET_CLAIM_TTL_MS,
  addUsage,
  mergeItems,
  nextForHeartbeat,
  splitRemovals,
  sumUsage,
  withRemovals,
  ticketPrompt,
  tokensLeft,
  whyNotRunnable,
  wouldCycle,
} from "../../src/main/ai/hub/WorkBoard";
import { WorkSync } from "../../src/main/ai/hub/WorkSync";
import type { QueueStore } from "../../src/main/ai/hub/LearningQueue";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const agent = (id: string, extra: Partial<MissionAgent> = {}): MissionAgent => ({
  id,
  name: id,
  role: "role",
  mission: "m",
  systemPrompt: "",
  defaultMode: "advice",
  updatedAt: 1,
  ...extra,
});
const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: id,
  description: "do it",
  status: "todo",
  assigneeAgentId: "a1",
  createdBy: "jacob",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

function memoryBucket(): QueueStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    list: async (dir) =>
      [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    read: async (p) => files.get(p),
    write: async (p, c) => void files.set(p, c),
    remove: async (p) => void files.delete(p),
  };
}

describe("board rules", () => {
  it("merges two copies per item, newest wins, and a removal travels like any change", () => {
    const local = [ticket("a", { updatedAt: 5, title: "mine" }), ticket("b", { updatedAt: 1 })];
    const remote = [ticket("a", { updatedAt: 3, title: "theirs" }), ticket("b", { updatedAt: 9, deleted: true }), ticket("c", { updatedAt: 2 })];
    const merged = mergeItems(local, remote);
    const by = new Map(merged.items.map((t) => [t.id, t]));
    expect(by.get("a")!.title).toBe("mine");
    expect(by.get("b")!.deleted).toBe(true);
    expect(by.has("c")).toBe(true);
    expect(merged.changed).toBe(true);
    expect(merged.newerLocally.map((t) => t.id)).toEqual(["a"]);
  });

  it("says why a ticket cannot run: no agent, paused, out of budget, taken, waiting for another ticket", () => {
    const agents = [agent("a1"), agent("paused", { enabled: false }), agent("broke", { monthlyTokenBudget: 1000 })];
    const usage = addUsage({}, "broke", 1000);
    const base = { agents, usage, client: "me", now: Date.now() };
    const tickets = [ticket("first", { status: "todo" }), ticket("second", { blockedBy: ["first"] })];
    expect(whyNotRunnable(ticket("x", { assigneeAgentId: undefined }), { ...base, tickets })).toMatch(/No agent/);
    expect(whyNotRunnable(ticket("x", { assigneeAgentId: "paused" }), { ...base, tickets })).toMatch(/paused/);
    expect(whyNotRunnable(ticket("x", { assigneeAgentId: "broke" }), { ...base, tickets })).toMatch(/budget/);
    expect(
      whyNotRunnable(ticket("x", { claim: { by: "erik", client: "other", at: 0, seenAt: base.now - 1000 } }), { ...base, tickets }),
    ).toBe("erik is running it.");
    // A claim nobody refreshed no longer holds the ticket.
    expect(
      whyNotRunnable(ticket("x", { claim: { by: "erik", client: "other", at: 0, seenAt: base.now - TICKET_CLAIM_TTL_MS - 1 } }), { ...base, tickets }),
    ).toBeUndefined();
    expect(whyNotRunnable(tickets[1], { ...base, tickets })).toMatch(/Waiting for: first/);
    expect(nextForHeartbeat({ ...base, tickets })!.id).toBe("first");
    expect(tokensLeft(agents[2], usage)).toBe(0);
    // Last month's spending does not count against this month.
    expect(tokensLeft(agents[2], { broke: { month: "2000-01", tokens: 99999, runs: 3 } })).toBe(1000);
  });

  it("refuses a reporting line that closes a circle", () => {
    const agents = [agent("lead"), agent("mid", { reportsTo: "lead" }), agent("leaf", { reportsTo: "mid" })];
    expect(wouldCycle(agents, "lead", "leaf")).toBe(true);
    expect(wouldCycle(agents, "leaf", "lead")).toBe(false);
  });

  it("wakes an agent with the goal, the ticket and who it can hand work to", () => {
    const agents = [agent("lead", { name: "Lead" }), agent("worker", { name: "Worker", reportsTo: "lead" })];
    const text = ticketPrompt(
      ticket("t1", { title: "Find the slow query", description: "Look at pg_stat_statements." }),
      { id: "g", title: "Halve p95 latency", status: "active", createdAt: 1, updatedAt: 1 },
      { tickets: [], agents, agent: agents[0] },
    );
    expect(text).toContain("Halve p95 latency");
    expect(text).toContain("Look at pg_stat_statements.");
    expect(text).toContain("These agents report to you: Worker");
    expect(text).toContain("parent=t1");
  });
});

describe("the team's setup in a bucket", () => {
  it("shares an agent with a teammate, and a removal reaches them instead of the agent coming back", async () => {
    const bucket = memoryBucket();
    const mine = new WorkSync(bucket);
    const theirs = new WorkSync(bucket);
    // I create an agent; my teammate's app picks it up.
    await mine.reconcile("agents", withRemovals([agent("watch", { updatedAt: 10 })], {}));
    let got = splitRemovals((await theirs.reconcile("agents", withRemovals([] as MissionAgent[], {}))).items);
    expect(got.alive.map((a) => a.id)).toEqual(["watch"]);
    // They remove it. Without the marker my copy would be uploaded again.
    await theirs.reconcile("agents", withRemovals([] as MissionAgent[], { watch: 20 }));
    got = splitRemovals((await mine.reconcile("agents", withRemovals([agent("watch", { updatedAt: 10 })], {}))).items);
    expect(got.alive).toEqual([]);
    expect(got.removed).toEqual({ watch: 20 });
    // Saved again later, it is back for everyone.
    await mine.reconcile("agents", withRemovals([agent("watch", { updatedAt: 30 })], got.removed));
    got = splitRemovals((await theirs.reconcile("agents", withRemovals([] as MissionAgent[], { watch: 20 }))).items);
    expect(got.alive.map((a) => a.id)).toEqual(["watch"]);
    expect(got.removed).toEqual({});
  });

  it("adds up what every installation spent, so a budget holds for the whole team", async () => {
    const bucket = memoryBucket();
    const sync = new WorkSync(bucket);
    const month = new Date().toISOString().slice(0, 7);
    await sync.putUsage("laptop", { a1: { month, tokens: 600, runs: 1 } });
    await sync.putUsage("server", { a1: { month, tokens: 500, runs: 2 }, old: { month: "2000-01", tokens: 9, runs: 1 } });
    const others = await sync.readOtherUsage("laptop");
    const total = sumUsage([{ a1: { month, tokens: 600, runs: 1 } }, ...others]);
    expect(total).toEqual({ a1: { month, tokens: 1100, runs: 3 } });
    expect(tokensLeft(agent("a1", { monthlyTokenBudget: 1000 }), total)).toBe(0);
  });
});

describe("the board in a bucket", () => {
  it("lets only one of two apps check a ticket out, and frees it when the runner stops reporting", async () => {
    const bucket = memoryBucket();
    const a = new WorkSync(bucket);
    const b = new WorkSync(bucket);
    const first = await a.claim("t1", { by: "jacob", client: "A" }, 1000);
    expect(first.client).toBe("A");
    expect((await b.claim("t1", { by: "erik", client: "B" }, 2000)).client).toBe("A");
    // A keeps it alive; B still cannot take it.
    await a.refresh("t1", "A", 1000 + TICKET_CLAIM_TTL_MS - 10);
    expect((await b.claim("t1", { by: "erik", client: "B" }, 1000 + TICKET_CLAIM_TTL_MS + 5)).client).toBe("A");
    // A goes away: after the time limit B gets it.
    const late = 1000 + TICKET_CLAIM_TTL_MS * 3;
    expect((await b.claim("t1", { by: "erik", client: "B" }, late)).client).toBe("B");
    // B's release does not remove a claim that is no longer B's.
    await a.release("t1", "A");
    expect((await b.readClaim("t1"))?.client).toBe("B");
  });

  it("brings two computers' tickets together in both directions", async () => {
    const bucket = memoryBucket();
    const mine = new WorkSync(bucket);
    const theirs = new WorkSync(bucket);
    await theirs.put("tickets", ticket("theirs", { updatedAt: 10 }));
    const first = await mine.reconcile("tickets", [ticket("mine", { updatedAt: 5 })]);
    expect(first.items.map((t) => t.id).sort()).toEqual(["mine", "theirs"]);
    expect(first.changed).toBe(true);
    // My ticket was uploaded: the other computer now sees it.
    const other = await theirs.reconcile("tickets", [ticket("theirs", { updatedAt: 10 })]);
    expect(other.items.map((t) => t.id).sort()).toEqual(["mine", "theirs"]);
    // An unreadable object is skipped, not fatal.
    bucket.files.set("work/tickets/broken.json", Buffer.from("{not json"));
    expect((await mine.reconcile("tickets", first.items)).items).toHaveLength(2);
  });
});

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    }),
    { status: 200 },
  );
}
const say = (text: string): Response =>
  sse([
    { type: "message_start", message: { usage: { input_tokens: 700 } } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "message_delta", usage: { output_tokens: 300 } },
  ]);
const callTool = (name: string, input: Record<string, unknown>): Response =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  ]);

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-board-"));
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
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  });
  return hub;
}
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("working a ticket", () => {
  it("sets up a team from a template: agents with reporting lines, a goal and first tickets", async () => {
    const hub = await makeHub();
    const snap = await hub.request({ action: "workforce-template-apply", templateId: "operate-system", goalTitle: "Keep prod healthy" });
    const team = (snap.agents ?? []).filter((a) => a.id.startsWith("wf-operate-system-"));
    const lead = team.find((a) => a.name === "Operations lead")!;
    expect(team).toHaveLength(5);
    expect(team.filter((a) => a.reportsTo === lead.id)).toHaveLength(4);
    expect(snap.workGoals!.map((g) => g.title)).toEqual(["Keep prod healthy"]);
    expect(snap.workTickets!.every((t) => t.goalId === snap.workGoals![0].id && t.assigneeName)).toBe(true);
  });

  it("runs the agent on the ticket, puts its report up for review, counts the tokens, and lets a person decide", async () => {
    const hub = await makeHub();
    let snap = await hub.request({ action: "workforce-template-apply", templateId: "develop-product" });
    const lead = snap.agents!.find((a) => a.name === "Product lead")!;
    const first = snap.workTickets!.find((t) => t.assigneeAgentId === lead.id)!;
    const bodies: string[] = [];
    let turn = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        // The lead hands a piece of the work to the builder, then reports.
        return turn++ === 0
          ? callTool("sshs3_tickets", { operation: "create", title: "Build the login form", description: "Done when the tests pass.", assignee: "builder" })
          : say("I split the goal into one ticket for the Builder. Nothing was verified yet.");
      }),
    );
    snap = await hub.request({ action: "ticket-start", id: first.id });
    // The stubbed model answers at once, so the run may already be over.
    expect(["in_progress", "review"]).toContain(snap.workTickets!.find((t) => t.id === first.id)!.status);
    await waitFor(() => hub.store.data.workTickets!.find((t) => t.id === first.id)!.status === "review");

    snap = await hub.request({ action: "snapshot" });
    const done = snap.workTickets!.find((t) => t.id === first.id)!;
    expect(done.result).toContain("I split the goal into one ticket");
    expect(done.claim).toBeUndefined();
    expect(done.tokens).toBeGreaterThan(0);
    expect(snap.agentUsage![lead.id].runs).toBe(1);
    expect(snap.agentUsage![lead.id].tokens).toBe(done.tokens);
    // The agent was told the goal, and the ticket it handed out hangs on this one.
    expect(bodies[0]).toContain("Ship the next version");
    const child = snap.workTickets!.find((t) => t.title === "Build the login form")!;
    expect(child).toMatchObject({ parentId: first.id, goalId: first.goalId, assigneeName: "Builder", status: "todo", createdBy: "Product lead" });

    // Sent back with a note: the ticket is to do again and the note is on it.
    snap = await hub.request({ action: "ticket-review", id: first.id, approve: false, note: "Split it further." });
    const back = snap.workTickets!.find((t) => t.id === first.id)!;
    expect(back.status).toBe("todo");
    expect(back.comments!.at(-1)!.text).toBe("Sent back: Split it further.");
  });

  it("does not start a ticket whose agent is paused or over budget, and says why", async () => {
    const hub = await makeHub();
    let snap = await hub.request({ action: "workforce-template-apply", templateId: "develop-product" });
    const lead = snap.agents!.find((a) => a.name === "Product lead")!;
    const first = snap.workTickets![0];
    await hub.request({ action: "agent-pause", id: lead.id, paused: true });
    await expect(hub.request({ action: "ticket-start", id: first.id })).rejects.toThrow(/paused/);
    await hub.request({ action: "agent-save", agent: { ...lead, enabled: true, monthlyTokenBudget: 5000 } });
    hub.store.data.agentUsage = addUsage({}, lead.id, 5000);
    await expect(hub.request({ action: "ticket-start", id: first.id })).rejects.toThrow(/budget/);
    snap = await hub.request({ action: "snapshot" });
    expect(snap.workTickets!.find((t) => t.id === first.id)!.status).toBe("todo");
  });
});
