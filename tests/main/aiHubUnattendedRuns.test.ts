import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSchedule, AgentTask } from "../../src/shared/types/aiHub";

/**
 * Runs nobody sits at, as the third evaluation round found them: the
 * heartbeat started one ticket twice while the first run's terminal was still
 * opening, the terminals those runs opened stayed listed as "disconnected",
 * and a command that waited for an approval nobody gave was reported as "not
 * approved", without the command.
 */

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), quit: () => {} },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
}));

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
  vi.unstubAllGlobals();
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
    { type: "message_delta", usage: { output_tokens: 300 } }, { type: "message_stop" },
  ]);
const callTool = (name: string, input: Record<string, unknown>): Response =>
  sse([
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  ]);

const SERVERS = [{ id: "srv-db01", name: "db-01", host: "db01.internal", port: 22, username: "ops" }];

async function makeHub(host: Record<string, unknown> = {}, savedSchedules?: AgentSchedule[]) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-unattended-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => SERVERS,
      ...host,
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  if (savedSchedules) {
    hub.store.data.schedules = savedSchedules;
    await hub.store.save();
  }
  await hub.initialize();
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" }, // pragma: allowlist secret
    preferences: { proposeMemories: false },
  });
  return hub;
}
type Hub = Awaited<ReturnType<typeof makeHub>>;
const inner = (hub: Hub) =>
  hub as unknown as {
    whenSettled(task: AgentTask): Promise<void>;
    workTick(now?: number): Promise<void>;
    sweepDeadTerminals(): void;
    approvalWaitMinutes(): number;
    notify(title: string, body: string): void;
  };

/** A terminal that answers the handshake and every command, as a shell at its prompt would. */
function shell(hub: Hub, id: string, label: string, profileId?: string): string[] {
  const ran: string[] = [];
  hub.terminals.register({ id, label, kind: "ssh", profileId }, (data: string) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (!n) return;
    ran.push(/\(eval '([^']*)'\)/.exec(data)?.[1] ?? "");
    queueMicrotask(() => hub.terminals.feed(id, `\x1b]777;SSHS3;${n};BEGIN\x07ok\n\x1b]777;SSHS3;${n};END;0;/root\x07ops@${label}:~$ `));
  });
  hub.terminals.feed(id, `ops@${label}:~$ `);
  return ran;
}

/** A host that opens a terminal on a server for a run; `gate`, when set, holds the opening until it is let go. */
function serverTerminals() {
  const opened: string[] = [];
  const closed: string[] = [];
  const ref: { hub?: Hub; gate?: Promise<void> } = {};
  const host = {
    openServerTerminal: async (profileId: string) => {
      const id = `own-${opened.length + 1}`;
      opened.push(profileId);
      if (ref.gate) await ref.gate;
      shell(ref.hub!, id, "db-01", profileId);
      await ref.hub!.terminals.armAtPrompt(id, "bash", 2000);
      return id;
    },
    closeSession: (id: string) => {
      closed.push(id);
      ref.hub!.terminals.invalidate(id, "closed", true);
    },
  };
  return { opened, closed, ref, host };
}

async function ticketFor(hub: Hub, target = "db-01") {
  let snap = await hub.request({ action: "workforce-template-apply", templateId: "operate-system" });
  const watch = snap.agents!.find((a) => a.name === "Watch")!;
  snap = await hub.request({ action: "ticket-save", ticket: { title: "db-01 /var 99% full", assigneeAgentId: watch.id, target, status: "todo" } });
  return snap.workTickets!.find((t) => t.title === "db-01 /var 99% full")!;
}

describe("one ticket, one run", () => {
  it("is taken before its terminal opens: a second start and the next heartbeat pass find it taken", async () => {
    const { opened, ref, host } = serverTerminals();
    const hub = (ref.hub = await makeHub(host));
    const ticket = await ticketFor(hub);
    // The only ticket on the board: the template's own first ticket would be the heartbeat's choice.
    hub.store.data.workTickets = hub.store.data.workTickets!.filter((t) => t.id === ticket.id);
    hub.store.data.preferences.workforceAutopilot = true;
    vi.stubGlobal("fetch", vi.fn(async () => say("Looked at /var.")));
    let open!: () => void;
    ref.gate = new Promise<void>((resolve) => (open = resolve));

    // The heartbeat takes the ticket; its terminal is slow to show a prompt (up to 30 s on the lab).
    const first = inner(hub).workTick(Date.now());
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const state = () => hub.store.data.workTickets!.find((t) => t.id === ticket.id)!;
    expect(state()).toMatchObject({ status: "in_progress" });
    expect(state().claim).toBeDefined();

    // Meanwhile: the next heartbeat pass, and a person pressing Start.
    await inner(hub).workTick(Date.now() + 60_000);
    await expect(hub.request({ action: "ticket-start", id: ticket.id })).rejects.toThrow(/already being started/);
    expect(opened).toHaveLength(1);

    open();
    await first;
    const runs = hub.store.data.tasks.filter((t) => t.ticketId === ticket.id);
    expect(runs).toHaveLength(1);
    expect(state()).toMatchObject({ status: "in_progress", taskId: runs[0].id });
    // While it runs, it is not started again either.
    await expect(hub.request({ action: "ticket-start", id: ticket.id })).rejects.toThrow(/already running/);
    await vi.waitFor(() => expect(runs[0].status).toBe("completed"));
    await inner(hub).whenSettled(runs[0]);
    expect(hub.store.data.tasks.filter((t) => t.ticketId === ticket.id)).toHaveLength(1);
  });

  it("gives the ticket back as it was when its run could not be started", async () => {
    const { ref, host } = serverTerminals();
    const hub = (ref.hub = await makeHub(host));
    const ticket = await ticketFor(hub);
    // No model can be reached: the run fails to start.
    await hub.request({ action: "configure", config: { enabled: true, provider: "anthropic", model: "claude-opus-5-5", apiKey: "" } });
    await expect(hub.request({ action: "ticket-start", id: ticket.id })).rejects.toThrow();
    const after = hub.store.data.workTickets!.find((t) => t.id === ticket.id)!;
    expect(after.status).toBe("todo");
    expect(after.claim).toBeUndefined();
    expect(hub.store.data.tasks.filter((t) => t.ticketId === ticket.id)).toHaveLength(0);
  });
});

describe("the terminals of runs nobody sits at", () => {
  it("are taken out of the list when the run ends; a person's terminal stays", async () => {
    const { closed, ref, host } = serverTerminals();
    const hub = (ref.hub = await makeHub(host));
    shell(hub, "person", "web-01");
    await hub.terminals.arm("person", "bash");
    const ticket = await ticketFor(hub);
    vi.stubGlobal("fetch", vi.fn(async () => say("Looked at /var.")));
    await hub.request({ action: "ticket-start", id: ticket.id });
    const task = hub.store.data.tasks.find((t) => t.ticketId === ticket.id)!;
    expect(task.target?.sessionId).toBe("own-1");
    await vi.waitFor(() => expect(task.status).toBe("completed"));
    await inner(hub).whenSettled(task);
    expect(closed).toEqual(["own-1"]);
    // Gone, not "disconnected": six of those after one ticket and one schedule is what the list looked like.
    expect(hub.terminals.get("own-1")).toBeUndefined();
    expect(hub.terminals.list().map((t) => t.id)).toEqual(["person"]);
    expect(hub.terminals.get("person")!.state).toBe("ready");
  });

  it("is no longer \"ready\" once its process is gone without the terminal having been told", async () => {
    const gone = new Set<string>();
    const hub = await makeHub({ sessionAlive: (id: string) => (gone.has(id) ? false : id === "unknown" ? undefined : true) });
    for (const id of ["killed", "alive", "unknown"]) {
      shell(hub, id, "web-01");
      await hub.terminals.arm(id, "bash");
    }
    gone.add("killed");
    gone.add("unknown-but-not-asked");
    inner(hub).sweepDeadTerminals();
    expect(hub.terminals.get("killed")!.state).toBe("disconnected");
    expect(hub.terminals.get("alive")!.state).toBe("ready");
    // A host that cannot say leaves the terminal as it is.
    expect(hub.terminals.get("unknown")!.state).toBe("ready");
  });
});

describe("a run nobody sits at that needs an approval", () => {
  it("tells at once, with the command, and its ticket names the command that nobody answered", async () => {
    const { ref, host } = serverTerminals();
    const hub = (ref.hub = await makeHub(host));
    const ticket = await ticketFor(hub);
    // A wait of a few milliseconds instead of the minutes a person gets.
    (hub as unknown as { approvalWaitMinutes: () => number }).approvalWaitMinutes = () => 0.002;
    const told: Array<{ title: string; body: string; at: number }> = [];
    (hub as unknown as { notify: (title: string, body: string) => void }).notify = (title, body) => told.push({ title, body, at: Date.now() });
    const bodies: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return call++ === 0
          ? callTool("terminal_command", { command: "sudo systemctl restart postgresql", description: "Restart the database" })
          : say("Report: /var is full. The restart is still to do.");
      }),
    );
    const startedAt = Date.now();
    await hub.request({ action: "ticket-start", id: ticket.id });
    const task = hub.store.data.tasks.find((t) => t.ticketId === ticket.id)!;
    await vi.waitFor(() => expect(task.status).toBe("completed"), { timeout: 5000 });
    await inner(hub).whenSettled(task);

    // Told at once (not on the next look at the inbox, seconds later), and told which command.
    const asked = told.find((t) => t.title.includes("waits for your approval"));
    expect(asked).toBeDefined();
    expect(asked!.body).toContain("sudo systemctl restart postgresql");
    expect(asked!.at - startedAt).toBeLessThan(2500);

    // The agent read that nobody answered, and which command did not run.
    const second = bodies[1];
    expect(second).toContain("Nobody answered within 1 minute, so this did not run: sudo systemctl restart postgresql");
    expect(second).toContain("It was not refused");
    expect(task.changes[0]).toMatchObject({ status: "denied", decidedHow: "timeout" });

    // And the ticket says it, whatever the report says.
    const after = hub.store.data.workTickets!.find((t) => t.id === ticket.id)!;
    expect(after.status).toBe("review");
    expect(after.result).toContain("Report: /var is full.");
    expect(after.result).toContain("Waited for approval and nobody answered, so this did not run:");
    expect(after.result).toContain("on db-01: sudo systemctl restart postgresql");
  });
});

describe("schedule timing and events", () => {
  it("resolves a daily clock time in Stockholm on both changes of the clocks", async () => {
    const { nextCronTime } = await import("../../src/shared/scheduleTiming");
    const next = (at: string) => new Date(nextCronTime("30 2 * * *", "Europe/Stockholm", Date.parse(at))).toISOString();
    expect(next("2026-03-28T23:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
    expect(next("2026-10-24T23:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
    expect(next("2026-10-25T00:30:00Z")).toBe("2026-10-26T01:30:00.000Z");
    expect(() => nextCronTime("75 23 * * *", "UTC", Date.now())).toThrow();
    expect(() => nextCronTime("0 23 * * *", "unknown", Date.now())).toThrow();
  });

  it("uses server time for cron and limits event runs to the selected target and cooldown", async () => {
    const hub = await makeHub();
    const { nextCronTime } = await import("../../src/shared/scheduleTiming");
    const now = Date.now();
    const response = await hub.request({ action: "schedule-save", schedule: {
      id: "s1", enabled: true, title: "Health", mode: "advice", shell: "bash", profileId: "srv-db01",
      model: "test", provider: "openai-compatible", prompt: "Report changes", intervalMinutes: 60,
      maxCommands: 10, maxMinutes: 30, nextRunAt: 0, cron: "30 6 * * *", timezone: "Europe/Stockholm",
      eventTrigger: { kind: "facts_drift", cooldownMinutes: 20 },
    } });
    const job = response.schedules.find((s) => s.id === "s1")!;
    expect(job.nextRunAt).toBe(nextCronTime(job.cron!, job.timezone!, now));
    const launch = vi.spyOn(hub, "launchSchedule").mockResolvedValue(undefined);
    await hub.scheduleEvent("facts_drift", ["other-server"]);
    expect(launch).not.toHaveBeenCalled();
    await hub.scheduleEvent("facts_drift", ["srv-db01"]);
    await hub.scheduleEvent("facts_drift", ["srv-db01"]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(hub.store.data.schedules[0].nextRunAt).toBe(job.nextRunAt);
    const { eventTrigger: _removed, ...withoutEvent } = job;
    await hub.request({ action: "schedule-save", schedule: withoutEvent });
    expect(hub.store.data.schedules[0].eventTrigger).toBeUndefined();
  });

  it("migrates saved cron jobs to the next future match and pauses invalid legacy settings", async () => {
    const legacy: AgentSchedule = { enabled: true, title: "Health", id: "old", mode: "advice", shell: "bash",
      profileId: "srv-db01", model: "test", provider: "anthropic", prompt: "Report health", intervalMinutes: 10,
      maxCommands: 5, maxMinutes: 8, nextRunAt: 1, cron: "30 6 * * *", timezone: "Europe/Stockholm", missedPolicy: "run_once" };
    const hub = await makeHub({}, [legacy, { ...legacy, id: "invalid", timezone: "invalid" }]);
    const stored = JSON.parse(await fs.readFile(path.join(hub.directory, "hub.json"), "utf8")).schedules as AgentSchedule[];
    expect(stored[0]).toMatchObject({ id: "old", enabled: true, cronTimingVersion: 1 });
    expect(stored[0].nextRunAt).toBeGreaterThan(Date.now());
    expect(stored[1]).toMatchObject({ id: "invalid", enabled: false, cronTimingVersion: 1 });
    expect(stored[1].lastStatus).toContain("time zone");
    expect(hub.store.data.tasks).toHaveLength(0);
  });

  it("keeps abnormal reports visible and applies the missed run policy once", async () => {
    const hub = await makeHub();
    const { isConversation } = await import("../../src/shared/aiHubInbox");
    const now = Date.now();
    const template = { enabled: true, title: "Health", mode: "advice" as const, shell: "bash" as const,
      profileId: "srv-db01", model: "test", provider: "anthropic" as const, prompt: "Report health",
      intervalMinutes: 10, maxCommands: 5, maxMinutes: 8, nextRunAt: now - 86400000 };
    await hub.request({ action: "schedule-save", schedule: { ...template, id: "skip", quietSentinel: true } });
    await hub.request({ action: "schedule-save", schedule: { ...template, id: "once", missedPolicy: "run_once" } });
    (hub as unknown as { resume(): void }).resume();
    expect(hub.store.data.schedules.find((s) => s.id === "skip")!.nextRunAt).toBeGreaterThan(now);
    expect(hub.store.data.schedules.find((s) => s.id === "once")!.nextRunAt).toBeLessThanOrEqual(Date.now());

    const task = { id: "run", scheduleId: "skip", changes: [], status: "completed",
      messages: [{ role: "assistant", text: "HEARTBEAT_OK" }] } as unknown as AgentTask;
    hub.store.data.tasks.push(task);
    hub.scheduledRunEnded(task.id);
    expect(isConversation(task)).toBe(false);
    expect(hub.store.data.tasks).toContain(task);
    task.messages[0].text = "Disk full. HEARTBEAT_OK";
    hub.scheduledRunEnded(task.id);
    expect(isConversation(task)).toBe(true);
    task.messages[0].text = "HEARTBEAT_OK";
    task.toolLog = [{ ok: false }] as AgentTask["toolLog"];
    hub.scheduledRunEnded(task.id);
    expect(isConversation(task)).toBe(true);
  });
});
