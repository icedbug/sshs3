import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { routeAlert } from "../../src/main/ai/hub/AlertIntake";
import type { MissionAgent } from "../../src/shared/types/aiHub";

/** What a round of people trying the workspace found missing in the hub, and what it does now. */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

async function makeHub(host: Record<string, unknown> = {}, demo = false) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(demo);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-found-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), ...host } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const inner = hub as unknown as { kbNetwork: unknown; audit(): { entries(): Promise<Array<{ what?: string; target?: string }>> } };
  inner.kbNetwork = { fetchImpl: fetch, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };
  return { hub, inner };
}
const audited = async (inner: Awaited<ReturnType<typeof makeHub>>["inner"]): Promise<string[]> => (await inner.audit().entries()).map((e) => e.what ?? "");

describe("a ticket a person works", () => {
  it("can be brought back after it was removed", async () => {
    const { hub } = await makeHub();
    const made = await hub.request({ action: "ticket-save", ticket: { title: "Rotate the backup key" } });
    const id = made.workTickets![0].id;
    const removed = await hub.request({ action: "ticket-delete", id });
    expect(removed.workTickets!.some((t) => t.id === id)).toBe(false);
    const back = await hub.request({ action: "ticket-restore", id });
    expect(back.reply?.notes).toEqual(['Brought back "Rotate the backup key".']);
    expect(back.workTickets!.find((t) => t.id === id)).toMatchObject({ title: "Rotate the backup key", status: "backlog" });
    await expect(hub.request({ action: "ticket-restore", id: "t-nope" })).rejects.toThrow("That ticket is not here any more.");
  });

  it("takes the person's own report as its result", async () => {
    const { hub } = await makeHub();
    const id = (await hub.request({ action: "ticket-save", ticket: { title: "nginx is down" } })).workTickets![0].id;
    await expect(hub.request({ action: "ticket-result", id, result: "   " })).rejects.toThrow("Write what was wrong and what you did.");
    const done = await hub.request({ action: "ticket-result", id, result: "The zone was named api_limit and used as api. Fixed the name, nginx is up." });
    const ticket = done.workTickets!.find((t) => t.id === id)!;
    expect(ticket.result).toBe("The zone was named api_limit and used as api. Fixed the name, nginx is up.");
    expect(ticket.comments!.at(-1)!.text).toBe("Wrote the report.");
  });

  it("is ready for its agent once it has one", async () => {
    const { hub } = await makeHub();
    const agents = (await hub.snapshot()).agents;
    const id = (await hub.request({ action: "ticket-save", ticket: { title: "Check the certificates" } })).workTickets![0].id;
    expect((await hub.snapshot()).workTickets!.find((t) => t.id === id)!.status).toBe("backlog");
    const given = await hub.request({ action: "ticket-save", ticket: { id, title: "Check the certificates", assigneeAgentId: agents![0].id } });
    expect(given.workTickets!.find((t) => t.id === id)!.status).toBe("todo");
  });
});

describe("a scenario worked by hand", () => {
  it("passes its last check on the report the person wrote on the ticket", async () => {
    const { hub } = await makeHub({}, true);
    const { runLines } = await import("../../src/main/sim/Scenario");
    const { SCENARIOS, stopScenario } = await import("../../src/main/sim/lab");
    const { simWorld } = await import("../../src/main/sim/SimWorld");
    disposals.push(() => stopScenario());
    const scenario = SCENARIOS.find((s) => s.id === "nginx-bad-config")!;
    const started = await hub.request({ action: "sim-start", scenarioId: scenario.id });
    runLines(simWorld(), scenario.solutions.careful);
    const ticketId = started.simulation!.running!.ticketId!;
    expect((await hub.snapshot()).simulation!.running!.checks.filter((c) => !c.pass).map((c) => c.id)).toEqual(["report"]);
    const reported = await hub.request({ action: "ticket-result", id: ticketId, result: "The limit_req zone had two names in the config, so nginx refused it after the nightly restart. Fixed the name." });
    expect(reported.simulation!.running!.passed).toBe(4);
  });

  it("gives the alert to the agent bound to the server's cluster", () => {
    const agents = [
      { id: "linux", name: "Linux", role: "Linux SRE", enabled: true },
      { id: "ceph", name: "Ceph", role: "Storage specialist", targetCluster: "Ceph-NVMe-Block-Pool", enabled: true },
    ] as unknown as MissionAgent[];
    const alert = { title: "nearfull", source: "Alertmanager", labels: {} } as never;
    const servers = [{ name: "ceph-admin-01", host: "10.30.40.5", cluster: "Ceph-NVMe-Block-Pool" }];
    expect(routeAlert(alert, "ceph-admin-01", [], agents, servers)?.id).toBe("ceph");
    expect(routeAlert(alert, "ceph-admin-01", [], agents)?.id).toBe("linux");
  });
});

describe("what a person changes about the team's rules and memory", () => {
  it("is in the audit log: a memory saved, changed and forgotten", async () => {
    const { hub, inner } = await makeHub();
    const saved = await hub.request({ action: "memory-save", entry: { kind: "memory", scope: "workspace", title: "Reload nginx after a config change", text: "nginx -t first." } as never });
    const entry = saved.memories.find((m) => m.title === "Reload nginx after a config change")!;
    await hub.request({ action: "memory-save", entry: { ...entry, text: "nginx -t first, then reload." } as never });
    await hub.request({ action: "memory-delete", id: entry.id });
    await hub.request({ action: "memory-save", entry: { kind: "memory", scope: "personal", title: "Mine", text: "Only for me." } as never });
    const log = await audited(inner);
    expect(log.filter((w) => w.includes("Reload nginx after a config change"))).toEqual([
      'Saved the team memory "Reload nginx after a config change"',
      'Changed the team memory "Reload nginx after a config change"',
      'Forgot the team memory "Reload nginx after a config change"',
    ]);
    expect(log.some((w) => w.includes("Mine"))).toBe(false);
  });

  it("says which cluster's rules moved, and from what to what", async () => {
    const { hub, inner } = await makeHub();
    const policy = (await hub.snapshot()).safetyPolicy;
    const changed = await hub.request({ action: "safety-policy-save", policy: { ...policy, clusterPolicies: { "Web-Prod": { maxMode: "assisted", requireCheckAndRollback: true } } } } as never);
    expect((await audited(inner)).at(-1)).toBe('Safety policy: rules for "Web-Prod": none → at most "Ask first", check and rollback');
    expect(changed.activityLog!.at(-1)!.summary).toContain('Changed the safety rules: rules for "Web-Prod"');
  });
});

describe("asking whether a model answers", () => {
  it("names the address and what to do when nothing is there, and keeps nothing", async () => {
    const { hub, inner } = await makeHub();
    (inner as unknown as { kbNetwork: { fetchImpl: typeof fetch; lookup: unknown } }).kbNetwork.fetchImpl = (async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });
    }) as never;
    const before = (await hub.snapshot()).config;
    const asked = await hub.request({ action: "ai-probe", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(asked.reply?.probe).toEqual({ ok: false, detail: "No model answered: 127.0.0.1:11434 did not answer. Start the local model (for Ollama: ollama serve), or choose another one in AI settings." });
    expect((await hub.snapshot()).config).toEqual(before);
  });

  it("lists the models of one that answers", async () => {
    const { hub, inner } = await makeHub();
    (inner as unknown as { kbNetwork: { fetchImpl: typeof fetch } }).kbNetwork.fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder:14b" }, { id: "llama3.3" }] }), { status: 200 })) as never;
    const asked = await hub.request({ action: "ai-probe", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(asked.reply?.probe).toEqual({ ok: true, detail: "127.0.0.1:11434 answers. It offers 2 models.", models: ["qwen2.5-coder:14b", "llama3.3"] });
  });

  it("says the assistant is off when it is", async () => {
    const { hub } = await makeHub();
    expect((await hub.request({ action: "ai-probe" })).reply?.probe).toEqual({ ok: false, detail: "The assistant is switched off. Switch it on in AI settings." });
  });
});

describe("the demo lab", () => {
  it("makes a test of one of its example conversations", async () => {
    const { hub } = await makeHub({}, true);
    const from = (await hub.snapshot()).tasks.find((t) => t.messages.length > 1 && !["queued", "running", "waiting"].includes(t.status))!;
    const made = await hub.request({ action: "eval-case-save", fromTaskId: from.id, title: "From the example" } as never);
    expect(made.evalCases!.map((c) => c.title)).toContain("From the example");
  });

  it("answers a chat from its script when no model is set up, and runs one of its example jobs now", async () => {
    const { hub } = await makeHub({}, true);
    await hub.request({ action: "configure", config: { enabled: true } } as never);
    // No key and no address: outside the demo lab this is refused; here the scripted example answers.
    const started = await hub.request({ action: "start", task: { prompt: "How is the storage doing?", mode: "advice" } } as never);
    expect(started.reply?.started?.taskId).toBeTruthy();
    const example = (await hub.snapshot()).schedules.find((s) => s.id.startsWith("demo-sched-"))!;
    const ran = await hub.request({ action: "schedule-run-now", id: example.id });
    expect(ran.reply?.notes?.[0] ?? "").not.toContain("not here any more");
  });

  it("tells the interface when something was run on a scenario's server", async () => {
    const changed = vi.fn();
    const { hub } = await makeHub({ changed }, true);
    const { stopScenario } = await import("../../src/main/sim/lab");
    const { simWorld } = await import("../../src/main/sim/SimWorld");
    disposals.push(() => stopScenario());
    await hub.request({ action: "sim-start", scenarioId: "nginx-bad-config" });
    changed.mockClear();
    const world = simWorld();
    world.shell(world.host("web-prod-01")!).run("sudo nginx -t");
    await new Promise((r) => setTimeout(r, 600));
    expect(changed).toHaveBeenCalled();
  });
});
