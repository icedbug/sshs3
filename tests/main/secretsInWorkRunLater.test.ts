import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HubStore } from "../../src/main/ai/hub/HubStore";
import { KnowledgeBaseService } from "../../src/main/ai/hub/KnowledgeBaseService";
import { SelfLearningService } from "../../src/main/ai/hub/SelfLearningService";
import type { AgentSchedule, AgentTask, RunbookTemplate } from "../../src/shared/types/aiHub";

/**
 * Text that is run later (a runbook's steps, a schedule's prompt, a learned command) is not changed
 * when it is saved. The store hides secrets in what it writes to disk, so a password in such a text
 * came back as "[redacted]", and was then typed. Each of these refuses a secret instead, and says where
 * it is; what is saved comes back byte for byte.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

const SERVERS = [{ id: "srv-mq01", name: "mq-01", host: "mq01.internal", port: 22, username: "ops" }];

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-run-later-"));
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => SERVERS,
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  return { hub, dir };
}

const schedule = (prompt: string): AgentSchedule =>
  ({
    id: "nightly",
    enabled: true,
    title: "Nightly",
    mode: "assisted",
    shell: "bash",
    profileId: "srv-mq01",
    model: "test",
    provider: "anthropic",
    prompt,
    intervalMinutes: 60,
    maxCommands: 10,
    maxMinutes: 30,
    nextRunAt: 0,
  }) as AgentSchedule;

const runbook = (steps: RunbookTemplate["steps"], inputs: RunbookTemplate["inputs"] = []) => ({ name: "Reset cache auth", inputs, steps });
type Extra = { runbooks?: RunbookTemplate[] };

describe("a schedule's prompt", () => {
  it("is refused with a secret in it, saying where, and nothing is saved", async () => {
    const { hub } = await makeHub();
    const refused = await hub.request({ action: "schedule-save", schedule: schedule("Each night run `rabbitmqctl change_password app S3cretPw` on mq-01 and check the queue.") }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    const message = (refused as Error).message;
    expect(message).toContain("holds a password, key or token");
    expect(message).toContain("rabbitmqctl change_password app [redacted]");
    expect(message).not.toContain("S3cretPw");
    expect(hub.store.data.schedules).toEqual([]);
  });

  it("is refused when the agent makes the schedule too", async () => {
    const { hub } = await makeHub();
    const task = { id: "run-1", title: "t", mode: "assisted", status: "running", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 1, maxCommands: 0, maxMinutes: 0, verification: "not-verified" } as AgentTask;
    hub.store.data.tasks.push(task);
    const capability = await hub.broker.issue(task);
    await expect(
      hub.broker.invoke(capability.key, { action: "sshs3_manage_schedule", payload: { operation: "save", title: "Nightly", prompt: "Run redis-cli -a S3cretPw ping every night" } }),
    ).rejects.toThrow(/holds a password, key or token/);
    expect(hub.store.data.schedules).toEqual([]);
  });

  it("without a secret is saved and comes back from the disk as it was written", async () => {
    const { hub, dir } = await makeHub();
    const prompt = "Each night run `rabbitmqctl list_queues` on mq-01, and read the password from /etc/mq/pw only if you need it.";
    await hub.request({ action: "schedule-save", schedule: schedule(prompt) });
    await hub.store.save();
    const again = new HubStore(path.join(dir, "hub.json"));
    await again.load();
    expect(again.data.schedules[0].prompt).toBe(prompt);
    expect(again.problem).toBeUndefined();
  });
});

describe("a runbook's steps", () => {
  it("are refused with a secret in a step, naming the step and showing it hidden", async () => {
    const { hub } = await makeHub();
    for (const [step, shown] of [
      [{ id: "s1", kind: "command", title: "web basic auth", command: "htpasswd -b /etc/nginx/.htpasswd admin S3cretPw" }, "htpasswd -b /etc/nginx/.htpasswd admin [redacted]"],
      [{ id: "s1", kind: "command", title: "app user", command: "echo 'app:S3cretPw' | chpasswd" }, "echo 'app:[redacted]' | chpasswd"],
      [{ id: "s1", kind: "ai_diagnose", prompt: "Log in with redis-cli -a S3cretPw and look" }, "redis-cli -a [redacted]"],
    ] as const) {
      const refused = await hub.request({ action: "runbook-save", runbook: runbook([step as never]) } as never).catch((e: Error) => e);
      expect(refused).toBeInstanceOf(Error);
      expect((refused as Error).message).toContain("Step 1");
      expect((refused as Error).message).toContain(shown);
      expect((refused as Error).message).toContain("{{password}}");
      expect((refused as Error).message).not.toContain("S3cretPw");
    }
    const withDefault = await hub.request({
      action: "runbook-save",
      runbook: runbook([{ id: "s1", kind: "command", command: "redis-cli -a {{pw}} ping" }], [{ name: "pw", type: "string", defaultValue: "password=S3cretPw" }]),
    } as never).catch((e: Error) => e);
    expect((withDefault as Error).message).toContain('The default value of the input "pw"');
    expect((hub.store.data as unknown as Extra).runbooks ?? []).toEqual([]);
  });

  it("with a variable in place of the secret are saved, and come back from the disk byte for byte", async () => {
    const { hub, dir } = await makeHub();
    const steps = [
      { id: "s1", kind: "command" as const, title: "set the password", command: "redis-cli CONFIG SET requirepass {{password}} && redis-cli -a {{password}} ping" },
      { id: "s2", kind: "command" as const, title: "web basic auth", command: "htpasswd -b /etc/nginx/.htpasswd admin {{password}}" },
      { id: "s3", kind: "command" as const, title: "app user", command: "echo \"app:$APP_PW\" | chpasswd" },
    ];
    await hub.request({ action: "runbook-save", runbook: runbook(steps, [{ name: "password", type: "string", required: true }]) } as never);
    await hub.store.save();
    const again = new HubStore(path.join(dir, "hub.json"));
    await again.load();
    expect((again.data as unknown as Extra).runbooks![0].steps.map((s) => s.command)).toEqual(steps.map((s) => s.command));
  });
});

describe("a command learned from what worked", () => {
  it("is not learned with a secret in it, and that is said", () => {
    const learning = new SelfLearningService(new KnowledgeBaseService());
    const failure = { command: "redis-cli ping", snippet: "NOAUTH Authentication required.", exitCode: 1, label: "cache-01" };
    for (const fixCommand of ["redis-cli -a S3cretPw ping", "htpasswd -b /etc/nginx/.htpasswd admin S3cretPw"]) {
      const result = learning.learnFromCommandResolution({ memories: [], failure, fixCommand, scope: "server:cache-01", proven: true });
      expect(result.learnedSkill).toBeUndefined();
      expect(result.proposal).toBeUndefined();
      expect(result.memories).toEqual([]);
    }
    const events = learning.getStatus({ memories: [], kbDocuments: [], infraEdges: [], tasks: [], mcpServerCount: 0 }).recentEvents;
    expect(events[0]).toMatchObject({ title: "Not learned: the command holds a secret" });
    expect(events[0].summary).toContain("[redacted]");
    expect(JSON.stringify(events)).not.toContain("S3cretPw");
    // One without a secret is still learned, as it ran.
    const learned = learning.learnFromCommandResolution({ memories: [], failure, fixCommand: "sudo systemctl restart redis", scope: "server:cache-01", proven: true });
    expect(learned.learnedSkill?.sourceCommand).toBe("sudo systemctl restart redis");
  });
});
