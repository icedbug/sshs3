import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCENARIOS, scenarioById, stopScenario } from "../../src/main/sim/lab";
import { fakeOpenAi, type FakeModelStep } from "../helpers/fakeOpenAi";

/**
 * A model working one of the lab's incidents through the real hub: the model's side is scripted
 * (tests/helpers/fakeOpenAi), everything else is what a run in the app goes through. The ticket is
 * started, the agent gets a terminal on the simulated server, its commands run there, a person is
 * asked before a change, the report lands on the ticket, and the scenario's checks read the outcome.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  stopScenario();
});

async function lab() {
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(true);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-agent-run-"));
  disposals.push(async () => {
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const { runAgentOnScenario } = await import("../../src/main/sim/agentRun");
  return { dir, runAgentOnScenario };
}

/** A solution said by a model: one command a turn, then the report. */
function asModel(lines: string[], report: string): FakeModelStep[] {
  return [
    ...lines.map((line) => ({ tool: "terminal_command", args: { command: line.replace(/^[\w.-]+:\s/, ""), description: "Scripted step" } })),
    { text: report },
  ];
}

describe("an agent run by a model on a scenario", () => {
  it("solves it through the real hub: terminal, approvals, report and score", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("nginx-bad-config")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story));
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fake-1", apiKey: "not-a-real-key", dir, pollMs: 20 });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.mode).toBe("assisted");
    // Every command of the solution ran in the simulated server's terminal, in order.
    const ran = result.events.filter((e) => e.kind === "command").map((e) => (e.kind === "command" ? e.command : ""));
    expect(ran).toEqual(scenario.solutions.careful.map((l) => l.replace(/^[\w.-]+:\s/, "")));
    expect(result.events.find((e) => e.kind === "started")).toMatchObject({ target: scenario.target });
    // The changes were asked about, the reads were not.
    const asked = result.events.filter((e) => e.kind === "approval").map((e) => (e.kind === "approval" ? e.ask.command : ""));
    expect(asked.some((c) => c.includes("sed -i"))).toBe(true);
    expect(asked.some((c) => c.startsWith("systemctl status"))).toBe(false);
    expect(result.approvals).toEqual({ asked: asked.length, allowed: asked.length });
    // The scenario's own checks, read off the lab and the report.
    expect(result.score.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result.score.passed).toBe(result.score.total);
    expect(result.report).toBe(scenario.story);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.otherRuns).toBe(0);
    // The model was sent the tools and a real conversation, with the key.
    expect((model.requests[0].tools as unknown[]).length).toBeGreaterThan(3);
  }, 60_000);

  it.each(SCENARIOS.map((s) => s.id))("%s: the careful solution passes every check, the careless one walks into the trap", async (id) => {
    const scenario = scenarioById(id)!;
    const careful = await lab();
    const good = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story));
    disposals.push(() => good.close());
    const solved = await careful.runAgentOnScenario({ scenarioId: id, baseUrl: good.url, model: "fake-1", dir: careful.dir, pollMs: 20 });
    expect(solved.error).toBeUndefined();
    expect(solved.events.find((e) => e.kind === "started")).toMatchObject({ target: scenario.target });
    expect(solved.score.checks.filter((c) => !c.pass)).toEqual([]);
    expect(solved.score.unsupported).toEqual([]);

    stopScenario();
    const careless = await lab();
    const bad = await fakeOpenAi(asModel(scenario.solutions.careless, "Done."));
    disposals.push(() => bad.close());
    const trapped = await careless.runAgentOnScenario({ scenarioId: id, baseUrl: bad.url, model: "fake-1", dir: careless.dir, pollMs: 20 });
    // Everything the careless agent asked for was let through: what it broke is its own doing.
    const failed = trapped.score.checks.filter((c) => !c.pass).map((c) => c.id);
    for (const trap of scenario.solutions.carelessFails) expect(failed).toContain(trap);
  }, 120_000);

  it("works with a service that takes its limits the way OpenAI's newer models do", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("pg-wal-full")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story), { strict: true });
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fake-1", dir, pollMs: 20 });

    expect(result.error).toBeUndefined();
    expect(result.score.passed).toBe(result.score.total);
    // Refused at the start, then asked the way it was told, and never refused again.
    const last = model.requests.at(-1)!;
    expect(last).not.toHaveProperty("max_tokens");
    expect(last).not.toHaveProperty("temperature");
    expect(last).not.toHaveProperty("reasoning_effort");
    expect(last.max_completion_tokens).toBeGreaterThan(0);
    expect(model.requests.filter((r) => "max_tokens" in r).length).toBe(1);
  }, 60_000);

  it("says that nobody worked on the ticket when the lab has no model", async () => {
    const { dir } = await lab();
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const hub = new HubService(
      { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
      dir,
    );
    disposals.unshift(() => hub.dispose());
    await hub.initialize();
    // The assistant is on, and no key was ever given: the demo's scripted answers stand in.
    await hub.request({ action: "configure", config: { enabled: true } });
    const sim = (await hub.request({ action: "sim-start", scenarioId: "nginx-bad-config" })).simulation!.running!;
    const taskId = (await hub.request({ action: "ticket-start", id: sim.ticketId! })).reply!.started!.taskId;
    const task = hub.store.data.tasks.find((t) => t.id === taskId)!;
    await vi.waitFor(() => expect(task.status).toBe("completed"), { timeout: 10_000 });

    const said = task.messages.filter((m) => m.role === "assistant").at(-1)!.text;
    expect(said).toContain("No agent worked on this ticket");
    expect(said).toContain("nothing was looked at and nothing was changed");
    // Not a word of another incident's canned findings, and nothing ran.
    expect(said).not.toContain("latency");
    expect(task.changes).toEqual([]);
  }, 30_000);

  it("leaves the incident unsolved when nobody lets the change through", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("nginx-bad-config")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, "I could not change anything: the change was refused."));
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fake-1", dir, approve: "none", pollMs: 20 });

    expect(result.status).toBe("completed");
    expect(result.approvals.asked).toBeGreaterThan(0);
    expect(result.approvals.allowed).toBe(0);
    expect(result.events.some((e) => e.kind === "command" && e.status === "denied")).toBe(true);
    expect(result.score.checks.find((c) => c.kind === "resolved")).toMatchObject({ pass: false });
  }, 60_000);

  it("is stopped at its limit of commands", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("nginx-bad-config")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story));
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fake-1", dir, maxCommands: 3, pollMs: 20 });

    expect(result.stoppedBy).toBe("commands");
    expect(result.status).toBe("interrupted");
    expect(result.commands).toBeLessThan(scenario.solutions.careful.length);
    expect(result.score.passed).toBeLessThan(result.score.total);
  }, 60_000);
});
