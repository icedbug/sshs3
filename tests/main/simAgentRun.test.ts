import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SCENARIOS, scenarioById, stopScenario } from "../../src/main/sim/lab";
import { fakeOpenAi, type FakeModelStep } from "../helpers/fakeOpenAi";

/**
 * A model working one of the lab's incidents through the real hub: the model's side is scripted
 * (tests/helpers/fakeOpenAi), everything else is what a run in the app goes through. The ticket is
 * started, the agent gets a terminal on the simulated server, its commands run there without anybody
 * being asked, a person is asked about a change card, the report lands on the ticket, and the
 * scenario's checks read the outcome.
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

type Card = { check: { command: string; expected: string }; rollback: string };

/**
 * A solution said by a model: one command a turn, then the report. A line that holds one of the keys
 * of `cards` is made as a change card with that check and rollback, as an agent is told to make a
 * change; every other line is a plain command.
 */
function asModel(lines: string[], report: string, cards: Record<string, Card> = {}): FakeModelStep[] {
  return [
    ...lines.map((line) => {
      const command = line.replace(/^[\w.-]+:\s/, "");
      const card = Object.entries(cards).find(([part]) => command.includes(part))?.[1];
      return card
        ? { tool: "sshs3_change", args: { command, description: "Scripted change", ...card } }
        : { tool: "terminal_command", args: { command, description: "Scripted step" } };
    }),
    { text: report },
  ];
}

/** The one change of the nginx incident's careful solution, as a change card: the edit of the site's file. */
const NGINX_FIX: Record<string, Card> = {
  "sed -i": {
    check: { command: "sudo nginx -t", expected: "syntax is ok" },
    rollback: "sudo sed -i 's/limit_req zone=api_limit /limit_req zone=api /' /etc/nginx/conf.d/shop.conf",
  },
};

describe("an agent run by a model on a scenario", () => {
  it("solves it through the real hub: terminal, approvals, report and score", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("nginx-bad-config")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story, NGINX_FIX));
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fake-1", apiKey: "not-a-real-key", dir, pollMs: 20 });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.mode).toBe("assisted");
    // Every command of the solution ran in the simulated server's terminal, in order.
    const ran = result.events.filter((e) => e.kind === "command").map((e) => (e.kind === "command" ? e.command : ""));
    expect(ran).toEqual(scenario.solutions.careful.map((l) => l.replace(/^[\w.-]+:\s/, "")));
    expect(result.events.find((e) => e.kind === "started")).toMatchObject({ target: scenario.target });
    // The change card was asked about, with its check and its rollback. No plain command was: not the
    // look at the service, and not the start of it either. Nothing looks at what a command does.
    const asks = result.events.filter((e) => e.kind === "approval").map((e) => (e.kind === "approval" ? e.ask : undefined));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.command).toContain("sed -i");
    expect(asks[0]).toMatchObject({ check: NGINX_FIX["sed -i"].check.command, rollback: NGINX_FIX["sed -i"].rollback });
    expect(asks[0]).not.toHaveProperty("risk");
    expect(result.approvals).toEqual({ asked: 1, allowed: 1 });
    // The scenario's own checks, read off the lab and the report.
    expect(result.score.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result.score.passed).toBe(result.score.total);
    expect(result.report).toBe(scenario.story);
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    expect(result.otherRuns).toBe(0);
    // The model was sent the tools and a real conversation, with the key.
    expect((model.requests[0].tools as unknown[]).length).toBeGreaterThan(3);
    // What the agent always has at hand, and the team's memories, are in what it was sent once, as text:
    // not a second time inside the snapshot's JSON.
    const sent = String((model.requests[0].messages as Array<{ content: unknown }>)[1].content);
    expect(sent).toContain("Sources this agent always has at hand");
    expect(sent).toContain('"kbBoundDocuments":"(given below, as what this agent always has at hand)"');
    expect(sent).toContain("Team memory (what the team has learned");
    expect(sent).toContain('"memoryTiers":"(given above as team memory');
    expect(sent).not.toContain('"formatted":');
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

  it("can trace a confirmed incident diagnosis to the terminal output actually sent to the model", async () => {
    const { dir, runAgentOnScenario } = await lab();
    let usedRef: string | undefined;
    const cause = "The nginx rate-limit configuration references an undefined zone.";
    const model = await fakeOpenAi(({ messages }) => {
      const replies = messages.filter(message => message.role === "tool");
      if (!replies.length) return { tool: "terminal_command", args: { command: "nginx -t", description: "Validate the nginx configuration" } };
      if (replies.length === 1) {
        const result = String(replies[0].content);
        usedRef = /\[(S\d+)\]/.exec(result)?.[1];
        if (usedRef && result.includes("zone")) return { tool: "sshs3_hypotheses", args: { hypotheses: [
          { id: "h-zone", text: cause, status: "confirmed", evidence: [
            { id: "config-check", supports: true, text: "The configuration check reported a zero-size zone.", sourceRef: usedRef },
          ] },
        ] } };
      }
      return { text: cause };
    });
    disposals.push(() => model.close());
    const result = await runAgentOnScenario({ scenarioId: "nginx-bad-config", baseUrl: model.url, model: "fixture", dir, pollMs: 20 });
    expect(usedRef).toMatch(/^S\d+$/);
    expect(result.status).toBe("completed");
    expect(result.diagnosis).toMatchObject({ status: "confirmed", hypothesisId: "h-zone", cause });
  }, 60_000);

  it("leaves an inconclusive investigation on the scenario ticket with the next observation, even after the run completes", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const nextObservation = "Compare the nginx configuration test output on the web host with the last passing deployment.";
    const model = await fakeOpenAi([
      { tool: "sshs3_hypotheses", args: { hypotheses: [{ id: "h1", text: "The deployment changed nginx.conf", status: "open" }], nextObservation } },
      { text: "The incident needs another observation. " + nextObservation },
    ]);
    disposals.push(() => model.close());
    const result = await runAgentOnScenario({ scenarioId: "nginx-bad-config", baseUrl: model.url, model: "fixture", dir, pollMs: 20 });
    expect(result.status).toBe("completed");
    expect(result.diagnosis).toMatchObject({ status: "insufficient-evidence", nextObservation });
  }, 60_000);

  it("runs the full scenario through a stateless Responses endpoint", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("nginx-bad-config")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story, NGINX_FIX), { responses: true });
    disposals.push(() => model.close());
    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fixture", apiProtocol: "responses", dir, pollMs: 20 });
    expect(result.error).toBeUndefined();
    expect(result.score.passed).toBe(result.score.total);
    expect(result.report).toBe(scenario.story);
    expect(result.approvals.allowed).toBeGreaterThan(0);
    expect(model.requests[1].input).toContainEqual(expect.objectContaining({ encrypted_content: "opaque-0" }));
  }, 60_000);

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

  it("works with a model that takes tools only with its reasoning switched off, as gpt-6-luna does", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("nginx-bad-config")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story), { reasoningModel: true });
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "gpt-6-luna", dir, pollMs: 20 });

    // The first real run of this model ended here: "Model API (400) … set reasoning_effort to 'none'".
    expect(result.error).toBeUndefined();
    expect(result.score.passed).toBe(result.score.total);
    const last = model.requests.at(-1)!;
    expect(last.reasoning_effort).toBe("none");
    expect(last.max_completion_tokens).toBeGreaterThan(0);
    // Refused twice at the start (the limit's name, then the reasoning), and never again.
    expect(model.requests.filter((r) => "max_tokens" in r).length).toBe(1);
    expect(model.requests.filter((r) => !("max_tokens" in r) && r.reasoning_effort !== "none").length).toBe(1);
  }, 60_000);

  it("tries again when the provider's network answers 520, instead of ending the run", async () => {
    const { dir, runAgentOnScenario } = await lab();
    const scenario = scenarioById("nginx-bad-config")!;
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, scenario.story), { flaky: { status: 520, times: 1 } });
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fake-1", dir, pollMs: 20 });

    // The first real run ended here: "Model API (520): error code: 520".
    expect(result.error).toBeUndefined();
    expect(result.score.passed).toBe(result.score.total);
  }, 60_000);

  it("does not run one command a fourth time for the same answer, and ends a run that keeps asking", async () => {
    const { dir, runAgentOnScenario } = await lab();
    // A model that has stopped moving: the same look, whatever it is told. (The first real one did this fourteen times.)
    const model = await fakeOpenAi(() => ({ tool: "terminal_command", args: { command: "hostname", description: "Which server is this" } }));
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: "nginx-bad-config", baseUrl: model.url, model: "fake-1", dir, pollMs: 20, maxCommands: 30 });

    // Three runs, not thirty: then it is told why, and when it asks twice more the run is ended.
    expect(result.commands).toBe(3);
    expect(result.stoppedBy).toBeUndefined();
    expect(result.status).toBe("interrupted");
    expect(result.error).toContain("It kept asking for the same command, which printed the same thing each time.");
    const told = model.requests.flatMap((r) => (r.messages as Array<{ role: string; content?: unknown }>).filter((m) => m.role === "tool").map((m) => String(m.content)));
    expect(told.some((t) => t.includes("You ran this exact command 3 times in a row") && t.includes("It is not run again: the answer would be the same."))).toBe(true);
  }, 60_000);

  it("does not make one call a fourth time for the same result, whatever the tool, and ends a run that keeps asking", async () => {
    const { dir, runAgentOnScenario } = await lab();
    // What the first real model did for ten minutes: the same list of hypotheses, written down again and again.
    const same = { hypotheses: [{ id: "h1", text: "The disk is full", status: "open" }] };
    const model = await fakeOpenAi(() => ({ tool: "sshs3_hypotheses", args: same }));
    disposals.push(() => model.close());

    const result = await runAgentOnScenario({ scenarioId: "nginx-bad-config", baseUrl: model.url, model: "fake-1", dir, pollMs: 20, maxMinutes: 1 });

    // Three calls made, three refused with the reason, and then the run is ended: seven requests, not hundreds.
    expect(result.stoppedBy).toBeUndefined();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("the agent made the same call (sshs3_hypotheses) again and again");
    expect(model.requests.length).toBeLessThanOrEqual(8);
    const told = model.requests.flatMap((r) => (r.messages as Array<{ role: string; content?: unknown }>).filter((m) => m.role === "tool").map((m) => String(m.content)));
    expect(told.some((t) => t.includes("You made this exact call 3 times in a row and got the same result each time."))).toBe(true);
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
    const model = await fakeOpenAi(asModel(scenario.solutions.careful, "I could not change anything: the change was refused.", NGINX_FIX));
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

    const result = await runAgentOnScenario({ scenarioId: scenario.id, baseUrl: model.url, model: "fake-1", dir, maxCommands: 3, pollMs: 500 });

    expect(result.stoppedBy).toBe("commands");
    expect(result.status).toBe("interrupted");
    expect(result.commands).toBeLessThanOrEqual(3);
    expect(result.score.passed).toBeLessThan(result.score.total);
  }, 60_000);
});
