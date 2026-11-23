import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubService } from "../../src/main/ai/hub/HubService";
import type { AuditEntry } from "../../src/main/ai/hub/AuditLog";
import type { ToolRequest } from "../../src/main/ai/hub/ToolBroker";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * A command is written to the audit log once, when it has ended (tests/main/commandsRunUnasked.test.ts
 * holds that). One whose end never comes must be in the log all the same: a command that hangs until
 * it runs out of time, and a command that is running when the app closes.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function hubWithTerminal() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-command-started-"));
  const hub: HubService = new HubService(
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
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await hub.dispose();
  };
  disposals.push(async () => {
    await dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  // The log is told after 30 ms that a command is still running, not after five seconds.
  hub.broker.startedNoteMs = 30;
  /** How long the terminal takes to answer a command. Undefined: it never does. */
  const shell: { answerAfter?: number } = { answerAfter: 0 };
  hub.terminals.register({ id: "term-1", label: "web-1", kind: "ssh" }, (data) => {
    const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (!nonce) return;
    const begin = `\x1b]777;SSHS3;${nonce};BEGIN\x07`;
    if (shell.answerAfter === undefined) setTimeout(() => hub.terminals.feed("term-1", `${begin}Password: `), 1);
    else setTimeout(() => hub.terminals.feed("term-1", `${begin}done\r\n\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`), shell.answerAfter);
  });
  hub.terminals.feed("term-1", "ops@web-1:~$ ");
  await hub.terminals.ensureReady("term-1", "bash");
  const task: AgentTask = {
    id: "run-1",
    title: "Work",
    mode: "assisted",
    status: "running",
    messages: [{ id: "u-1", role: "user", text: "Look at the app", at: 1 }],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 0,
    maxMinutes: 0,
    verification: "not-verified",
    target: { sessionId: "term-1", generation: hub.terminals.get("term-1")!.generation, label: "web-1" },
  };
  hub.store.data.tasks.push(task);
  const capability = await hub.broker.issue(task);
  const invoke = (request: ToolRequest) => hub.broker.invoke(capability.key, request);
  /** The log's entries for the run's first change, oldest first, as they are on disk. */
  const rows = async (): Promise<AuditEntry[]> => {
    const text = await fs.readFile(hub.audit().file, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEntry)
      .filter((entry) => entry.changeId === task.changes[0]?.id);
  };
  return { hub, task, invoke, rows, shell, dispose };
}

describe("a command in the audit log", () => {
  it("that ends at once is written once, when it has ended", async () => {
    const { invoke, rows } = await hubWithTerminal();
    await invoke({ action: "command", command: "df -h" });
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1));
    await sleep(80);
    expect((await rows()).map((e) => e.outcome)).toEqual(["completed"]);
  });

  it("that is still running after a moment is written down as started, and again when it ends", async () => {
    const { invoke, rows, shell, task } = await hubWithTerminal();
    shell.answerAfter = 250;
    const running = invoke({ action: "command", command: "pg_dump app > /backup/app.sql" });
    // While it runs: it is in the log already.
    await vi.waitFor(async () => expect((await rows()).map((e) => e.outcome)).toEqual(["started"]));
    expect(task.changes[0].status).toBe("running");
    const [started] = await rows();
    expect(started).toMatchObject({ kind: "command", target: "web-1", what: "pg_dump app > /backup/app.sql", taskId: "run-1", detail: "Still running. How it ended is written when it ends." });
    await running;
    await vi.waitFor(async () => expect((await rows()).map((e) => e.outcome)).toEqual(["started", "completed"]));
  });

  it("that never ends is in the log as started, and then as uncertain with what was done about it", async () => {
    const { hub, invoke, rows, shell } = await hubWithTerminal();
    shell.answerAfter = undefined;
    // The same call, with a short time for the command: two minutes are not waited out here.
    const execute = hub.terminals.execute.bind(hub.terminals);
    vi.spyOn(hub.terminals, "execute").mockImplementation((id, generation, owner, command, _timeout, handshake) => execute(id, generation, owner, command, handshake ? 10_000 : 150, handshake));
    await expect(invoke({ action: "command", command: "sudo systemctl restart nginx" })).rejects.toThrow(/did not finish within 1 seconds/);
    await vi.waitFor(async () => expect((await rows()).map((e) => e.outcome)).toEqual(["started", "uncertain"]));
    const [, ended] = await rows();
    expect(ended.detail).toMatch(/did not finish within 1 seconds\. It was left running in this terminal/);
  });

  it("that is running when the app closes is in the log before the app is gone", async () => {
    const { hub, invoke, rows, shell, dispose, task } = await hubWithTerminal();
    shell.answerAfter = undefined;
    // Closed long before the moment after which a running command is written down as started.
    hub.broker.startedNoteMs = 60_000;
    const running = invoke({ action: "command", command: "tail -f /var/log/syslog" }).catch((e: Error) => e.message);
    await vi.waitFor(() => expect(task.changes[0]?.status).toBe("running"));
    await dispose();
    // The run was stopped and its terminal handed back: that is what the command's end is known by.
    expect(await running).toMatch(/Control returned to the user/);
    expect((await rows()).map((e) => e.outcome)).toEqual(["uncertain"]);
    expect((await rows())[0]).toMatchObject({ what: "tail -f /var/log/syslog", detail: expect.stringContaining("Control returned to the user") });
  });

  it("that the rules stop when the run has ended is in the log as not run, not as uncertain", async () => {
    const { hub, invoke, rows, task } = await hubWithTerminal();
    // A change card: its check is typed, and while it runs the run is stopped.
    const execute = hub.terminals.execute.bind(hub.terminals);
    let calls = 0;
    vi.spyOn(hub.terminals, "execute").mockImplementation((...args) => {
      const running = execute(...args);
      if (++calls === 1) task.status = "cancelled";
      return running;
    });
    task.mode = "autonomous";
    await expect(
      invoke({ action: "change", command: "systemctl restart nginx", check: { command: "systemctl is-active nginx", expected: "done" }, rollback: "systemctl stop nginx" }),
    ).rejects.toThrow(/This run has stopped/);
    hub.changed();
    await vi.waitFor(async () => expect((await rows()).map((e) => e.outcome)).toEqual(["intent", "denied"]));
    expect((await rows())[1].detail).toContain("Not run: This run has stopped.");
  });
});
