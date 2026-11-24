import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubService } from "../../src/main/ai/hub/HubService";
import { maskContext, maskMarkIn, maskProviderText, scrubPii } from "../../src/main/ai/hub/privacy";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import type { ToolRequest } from "../../src/main/ai/hub/ToolBroker";
import type { AgentTask, WorkspaceServerSummary } from "../../src/shared/types/aiHub";

/**
 * The agent only ever sees secrets masked. A command it writes from what it saw (its own earlier call in
 * the tool log, a runbook step, a learned command, a schedule's prompt) holds sshs3's mark, not the value.
 * Run, `htpasswd -b f admin [redacted]` sets the password to the word "[redacted]". Every path that types
 * a command refuses one that holds such a mark, before anything is typed or shown on a card.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const WEB: WorkspaceServerSummary = { id: "srv-web-1", name: "web-1", host: "10.0.0.11", port: 22, username: "ops", cluster: "web", shared: true } as WorkspaceServerSummary;
const API: WorkspaceServerSummary = { id: "srv-api-1", name: "api-1", host: "10.0.0.21", port: 22, username: "ops", cluster: "web", shared: true } as WorkspaceServerSummary;

async function hubWith() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-masked-value-"));
  const typed: string[] = [];
  // eslint-disable-next-line prefer-const -- the host's terminals need the hub, made just below
  let hub: HubService;
  const answering = async (id: string, srv: WorkspaceServerSummary): Promise<void> => {
    hub.terminals.register({ id, label: srv.name, kind: "ssh", profileId: srv.id }, (data) => {
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (!nonce) return;
      typed.push(data);
      queueMicrotask(() => hub.terminals.feed(id, `\x1b]777;SSHS3;${nonce};BEGIN\x07done\r\n\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`));
    });
    hub.terminals.feed(id, `ops@${srv.name}:~$ `);
    await hub.terminals.ensureReady(id, "bash");
  };
  hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => [WEB, API],
      closeSession: () => {},
      manageAppSettings: async () => ({}),
      file: async () => ({ ok: true }),
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  await hub.collectExtraContext();
  await answering("term-web", WEB);
  await answering("term-api", API);
  typed.length = 0;
  let runs = 0;
  const run = async (mode: AgentTask["mode"] = "assisted") => {
    const owner = hub.terminals.get("term-web")?.owner;
    if (owner) hub.terminals.release(owner);
    const task: AgentTask = {
      id: `run-${++runs}`,
      title: "Work",
      mode,
      status: "running",
      messages: [{ id: `u-${runs}`, role: "user", text: "Set the password", at: 1 }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 0,
      maxMinutes: 0,
      verification: "not-verified",
      target: { sessionId: "term-web", generation: hub.terminals.get("term-web")!.generation, label: WEB.name },
    };
    hub.store.data.tasks.push(task);
    const capability = await hub.broker.issue(task);
    return { task, invoke: (request: ToolRequest) => hub.broker.invoke(capability.key, request) };
  };
  return { hub, typed, run };
}

/** What the agent saw of its own earlier call, after a save and a load: the password is the mark. */
const MASKED = maskContext("htpasswd -b /etc/nginx/.htpasswd admin S3cretPw");

describe("the marks sshs3 writes in place of a secret", () => {
  it("are all known: what each masker writes is found", () => {
    expect(MASKED).toBe("htpasswd -b /etc/nginx/.htpasswd admin [redacted]");
    expect(maskMarkIn(MASKED)).toBe("[redacted]");
    expect(maskMarkIn(maskContext("-----BEGIN RSA PRIVATE KEY-----\nAAAAAAAAAAAA\n-----END RSA PRIVATE KEY-----"))).toBe("[private key redacted]");
    expect(maskMarkIn(scrubPii("mail ops@example.com", "standard"))).toBe("[email redacted]");
    expect(maskMarkIn(scrubPii("ping 8.8.8.8", "standard"))).toBe("[ip redacted]");
    expect(maskMarkIn(scrubPii("call +46 70 123 45 67", "standard"))).toBe("[phone redacted]");
    expect(maskMarkIn(maskProviderText("ssh web-1", "strict", new Set(["web-1"])))).toBe("[host redacted]");
    // The panel masks what a person pastes with capitals.
    expect(maskMarkIn("echo [REDACTED] | chpasswd")).toBe("[REDACTED]");
    expect(maskMarkIn("grep -c redacted /var/log/app.log")).toBeUndefined();
  });
});

describe("a command that holds a mark of a hidden value", () => {
  it("is refused as a plain command, before anything is typed, and the agent is told why", async () => {
    const { typed, run } = await hubWith();
    const { task, invoke } = await run("autonomous");
    const refused = await invoke({ action: "command", command: MASKED, description: "Set it again" }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "masked_value" });
    const message = (refused as Error).message;
    expect(message).toContain("Nothing ran.");
    expect(message).toContain('"[redacted]"');
    expect(message).toContain("not the real value");
    expect(message).toMatch(/Ask the person/);
    expect(typed).toEqual([]);
    expect(task.changes).toEqual([]);
  });

  it("is refused as a verification and with another mark", async () => {
    const { typed, run } = await hubWith();
    const { invoke } = await run();
    await expect(invoke({ action: "verify", command: "redis-cli -a [redacted] ping", expected: "PONG" })).rejects.toMatchObject({ code: "masked_value" });
    await expect(invoke({ action: "command", command: "ssh admin@[ip redacted] uptime" })).rejects.toMatchObject({ code: "masked_value" });
    await expect(invoke({ action: "command", command: "echo 'app:[REDACTED]' | chpasswd" })).rejects.toMatchObject({ code: "masked_value" });
    expect(typed).toEqual([]);
  });

  it("is refused as a change card, its check or its rollback, before a card is shown or its check looked at", async () => {
    const { typed, run } = await hubWith();
    const { task, invoke } = await run("assisted");
    const card = (more: Partial<ToolRequest>): ToolRequest =>
      ({ action: "change", command: "systemctl restart app", description: "Restart", check: { command: "systemctl is-active app", expected: "done" }, rollback: "systemctl stop app", ...more }) as ToolRequest;
    for (const [request, what] of [
      [card({ command: MASKED }), "change"],
      [card({ check: { command: "redis-cli -a [redacted] ping", expected: "PONG" } }), "check"],
      [card({ rollback: "rabbitmqctl change_password app [redacted]" }), "rollback"],
      [card({ preflightCommand: "mysql -p[redacted] -e 'select 1'" }), "command"],
    ] as const) {
      const refused = await invoke(request).catch((e: unknown) => e);
      expect(refused).toMatchObject({ code: "masked_value" });
      expect((refused as Error).message).toContain(`The ${what} holds`);
    }
    expect(task.changes).toEqual([]);
    expect(task.status).toBe("running");
    expect(typed).toEqual([]);
  });

  it("is refused on several servers at once, on none of them", async () => {
    const { typed, run } = await hubWith();
    const { task, invoke } = await run("autonomous");
    await expect(
      invoke({ action: "sshs3_cluster_exec", payload: { command: MASKED, serverIdsOrNames: ["web-1", "api-1"], description: "Set it" } }),
    ).rejects.toMatchObject({ code: "masked_value" });
    expect(typed).toEqual([]);
    expect(task.changes).toEqual([]);
  });

  it("is refused when it comes from outside through MCP", async () => {
    const { hub, typed } = await hubWith();
    await expect(hub.runForMcp({ serverId: "web-1", command: MASKED, description: "Set it", by: "a test" })).rejects.toThrow(/not the real value/);
    const task = hub.store.data.tasks.find((t) => t.id.startsWith("mcp-"))!;
    expect(task.status).toBe("failed");
    expect(task.changes).toEqual([]);
    expect(typed).toEqual([]);
  });

  it("is refused by the terminal itself, whoever asks: the last guard before anything is typed", async () => {
    const registry = new TerminalRegistry();
    const written: string[] = [];
    registry.register({ id: "t", label: "t", kind: "local" }, (data) => {
      written.push(data);
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (nonce) queueMicrotask(() => registry.feed("t", `\x1b]777;SSHS3;${nonce};BEGIN\x07\x1b]777;SSHS3;${nonce};END;0;/\x07`));
    });
    registry.feed("t", "$ ");
    await registry.arm("t", "bash");
    const generation = registry.get("t")!.generation;
    registry.claim("t", generation, "task");
    written.length = 0;
    expect(() => registry.execute("t", generation, "task", "htpasswd -b f admin [redacted]")).toThrow(/not the real value/);
    expect(written).toEqual([]);
    expect(registry.get("t")!.state).toBe("ready");
    // A command without a mark still runs.
    await expect(registry.execute("t", generation, "task", "true")).resolves.toMatchObject({ exitCode: 0 });
  });
});
