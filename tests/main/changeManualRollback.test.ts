import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubService } from "../../src/main/ai/hub/HubService";
import { readPosixEnvelope } from "../../src/main/ai/hub/shellAdapters";
import { observationHash } from "../../src/main/ai/hub/privacy";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * A rollback a person starts from the Changes view. When the terminal refused the command before
 * anything was typed, the rollback was still recorded as run, and a rollback runs only once: the
 * person could not try again after clearing the prompt.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function hubWithChange() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-manual-rollback-"));
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
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  /** The commands typed into the terminal, as the shell would run them. */
  const typed: string[] = [];
  hub.terminals.register({ id: "term-1", label: "web-1", kind: "ssh" }, (data) => {
    const frame = readPosixEnvelope(data.replace(/\r$/, ""));
    if (!frame) return;
    typed.push(frame.command);
    queueMicrotask(() => hub.terminals.feed("term-1", `\x1b]777;${frame.prefix};BEGIN\x07active\x1b]777;${frame.prefix};END;0;/home/ops\x07`));
  });
  hub.terminals.feed("term-1", "ops@web-1:~$ ");
  await hub.terminals.ensureReady("term-1", "bash");
  typed.length = 0;
  const session = hub.terminals.get("term-1")!;
  const task: AgentTask = {
    id: "task-1",
    title: "Reload nginx",
    mode: "assisted",
    status: "completed",
    messages: [],
    changes: [
      {
        id: "chg-1",
        targetKey: JSON.stringify([session.id, session.generation]),
        kind: "command",
        target: "web-1",
        description: "Reload nginx",
        command: "systemctl reload nginx",
        status: "completed",
        // Its own entry is in the log already: what is read here is what the rollback adds.
        audited: true,
        at: Date.now(),
        check: { command: "systemctl is-active nginx", expected: "active", before: true, baselineHash: observationHash("chg-1", { exitCode: 0, output: "active" }) },
        rollback: { command: "cp /etc/nginx/nginx.conf.bak /etc/nginx/nginx.conf" },
      },
    ],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 10,
    maxMinutes: 15,
    verification: "not-verified",
  };
  hub.store.data.tasks.push(task);
  const outcomes = async (): Promise<Array<{ outcome?: string; detail?: string }>> =>
    (await hub.audit().recent(20)).filter((e) => e.changeId === "chg-1").map((e) => ({ outcome: e.outcome, detail: e.detail })).reverse();
  return { hub, task, typed, outcomes };
}

describe("a rollback started by a person", () => {
  it("is not recorded as run when nothing was typed, says so in the log, and can be tried again", async () => {
    const { hub, task, typed, outcomes } = await hubWithChange();
    // The person has half a line at the prompt of that terminal.
    hub.terminals.observeHumanInput("term-1", "sudo vim /etc/ng");
    await expect(hub.request({ action: "rollback-change", taskId: "task-1", changeId: "chg-1", verify: true })).rejects.toThrow(/Something is typed at the prompt/);
    expect(typed).toEqual([]);
    expect(task.changes[0].rollback).toEqual({ command: "cp /etc/nginx/nginx.conf.bak /etc/nginx/nginx.conf" });
    expect(await outcomes()).toEqual([
      { outcome: "manual-rollback-intent", detail: undefined },
      { outcome: "rollback-not-run", detail: expect.stringMatching(/Something is typed at the prompt/) },
    ]);

    // They clear the line (Ctrl-U) and press the button again.
    hub.terminals.observeHumanInput("term-1", "\x15");
    await hub.request({ action: "rollback-change", taskId: "task-1", changeId: "chg-1", verify: true });
    expect(typed).toEqual(["cp /etc/nginx/nginx.conf.bak /etc/nginx/nginx.conf", "systemctl is-active nginx"]);
    expect(task.changes[0].rollback).toMatchObject({ ran: true, exitCode: 0, restored: true, comparedWithBaseline: true, comparison: "exact" });
    expect((await outcomes()).map((o) => o.outcome)).toEqual(["manual-rollback-intent", "rollback-not-run", "manual-rollback-intent", "rolled-back"]);

    // Once it ran, it runs no second time.
    await expect(hub.request({ action: "rollback-change", taskId: "task-1", changeId: "chg-1", verify: true })).rejects.toThrow(/Only a change that ran can be taken back, once/);
    expect(typed).toHaveLength(2);
  });

  it("is recorded as run when it was typed and its end is not known", async () => {
    const { hub, task, typed } = await hubWithChange();
    const execute = hub.terminals.execute.bind(hub.terminals);
    hub.terminals.execute = ((...args: Parameters<typeof execute>) => {
      const running = execute(...args);
      // The person takes the terminal back while the rollback runs.
      hub.terminals.takeover("term-1", { interrupt: false });
      return running;
    }) as typeof execute;
    await expect(hub.request({ action: "rollback-change", taskId: "task-1", changeId: "chg-1", verify: true })).rejects.toThrow(/Control returned to the user/);
    expect(typed).toHaveLength(1);
    expect(task.changes[0].rollback).toMatchObject({ ran: true });
  });
});
