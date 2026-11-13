import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callMcpTool, toolsForScopes } from "../../src/main/web/mcp/mcpTools";
import { inboxItems } from "../../src/shared/aiHubInbox";
import type { HubRequest } from "../../src/shared/types/aiHub";

/**
 * A command asked for from outside sshs3. What matters here is what does NOT
 * happen: nothing runs until a person says so, and nothing runs anywhere but
 * on the one server the key is for.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
  vi.unstubAllGlobals();
});

const SERVERS = [
  { id: "srv-db01", name: "db01", host: "db01.internal", port: 22, username: "ops" },
  { id: "srv-web01", name: "web01", host: "web01.internal", port: 22, username: "ops" },
];

async function hubWithServer(): Promise<{
  hub: Awaited<ReturnType<typeof makeHub>>;
  ran: string[];
}> {
  const hub = await makeHub();
  const server = SERVERS[0];
  const ran: string[] = [];
  hub.terminals.register({ id: "sess-db01", label: "db01", kind: "ssh", profileId: server.id }, (data: string) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n) {
      // What was actually typed into the terminal, without the markers around it.
      // eslint-disable-next-line no-control-regex -- the markers a terminal wraps a command in are control characters
      ran.push(data.replace(/\x1b\]777;[^\x07]*\x07/g, "").trim());
      queueMicrotask(() =>
        hub.terminals.feed("sess-db01", `\x1b]777;SSHS3;${n};BEGIN\x07quota 2T\n\x1b]777;SSHS3;${n};END;0;/root\x07`),
      );
    }
  });
  await hub.terminals.arm("sess-db01", "bash");
  return { hub, ran };
}

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-mcprun-"));
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
  return hub;
}

const ctxFor = (hub: Awaited<ReturnType<typeof makeHub>>, serverId: string) => ({
  request: (r: HubRequest) => hub.request(r),
  runCommand: (input: Parameters<typeof hub.runForMcp>[0]) => hub.runForMcp({ ...input, by: "Jacob" }),
  commandStatus: (id: string) => hub.mcpCommandStatus(id),
  scopes: ["read", "run"] as ("read" | "tickets" | "run")[],
  serverId,
  actor: "Jacob",
});

describe("a command asked for over MCP", () => {
  it("is offered only to a key that may run, with its own tools", () => {
    expect(toolsForScopes(["read"]).map((t) => t.name)).not.toContain("run_command");
    const names = toolsForScopes(["read", "run"]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["run_command", "change_with_check", "command_status"]));
  });

  it("waits for a person, shows what was asked for in the inbox, and only then runs", async () => {
    const { hub, ran } = await hubWithServer();
    const ctx = ctxFor(hub, SERVERS[0].id);

    const asked = (await callMcpTool("run_command", { command: "zfs get quota tank/data", why: "Check the quota" }, ctx as never)) as {
      id: string;
      status: string;
      note: string;
    };
    expect(asked.status).toBe("waiting for a person");
    expect(asked.note).toContain("Nothing has run");
    // Nothing of what was asked for reached the terminal while it waited.
    expect(ran.join("\n")).not.toContain("zfs get quota");

    // It is in the inbox, as any waiting command is, and says where it came from.
    const snap = await hub.snapshot();
    const item = inboxItems(snap).find((i) => i.changeId === asked.id)!;
    expect(item.kind).toBe("approval");
    expect(item.from).toContain("Jacob's agent, through MCP");
    expect(item.target).toBe("db01");

    // Asking again says it is still waiting rather than running it twice.
    expect(await callMcpTool("command_status", { id: asked.id }, ctx as never)).toMatchObject({
      status: "waiting for a person",
      on: "db01",
    });

    const task = hub.store.data.tasks.find((t) => t.changes.some((c) => c.id === asked.id))!;
    hub.broker.approve(task.id, asked.id, true);
    await vi.waitFor(async () =>
      expect(((await callMcpTool("command_status", { id: asked.id }, ctx as never)) as { status: string }).status).toBe("completed"),
    );
    expect(ran.join("\n")).toContain("zfs get quota tank/data");
    expect(((await callMcpTool("command_status", { id: asked.id }, ctx as never)) as { output: string }).output).toContain("quota 2T");
  });

  it("does nothing at all when the person refuses", async () => {
    const { hub, ran } = await hubWithServer();
    const ctx = ctxFor(hub, SERVERS[0].id);
    const asked = (await callMcpTool("run_command", { command: "rm -rf /data", why: "tidy up" }, ctx as never)) as { id: string };
    const task = hub.store.data.tasks.find((t) => t.changes.some((c) => c.id === asked.id))!;
    hub.broker.approve(task.id, asked.id, false);
    await vi.waitFor(async () =>
      expect(((await callMcpTool("command_status", { id: asked.id }, ctx as never)) as { status: string }).status).toBe("denied"),
    );
    expect(ran.join("\n")).not.toContain("rm -rf");
  });

  it("will not run on a server the key is not for, or where nothing is connected", async () => {
    const { hub } = await hubWithServer();
    // The key's own server is the only one it can name: the tool takes no server at all.
    const elsewhere = ctxFor(hub, "srv-ghost");
    await expect(callMcpTool("run_command", { command: "uptime", why: "x" }, elsewhere as never)).rejects.toThrow(
      /No server called "srv-ghost"/,
    );
    // And a server with no terminal open is refused, rather than borrowing another one.
    const web = SERVERS[1];
    await expect(callMcpTool("run_command", { command: "uptime", why: "x" }, ctxFor(hub, web.id) as never)).rejects.toThrow(
      /Nothing is connected to web01/,
    );

  });

  it("carries the check and the rollback when it is a change", async () => {
    const { hub } = await hubWithServer();
    const ctx = ctxFor(hub, SERVERS[0].id);
    const asked = (await callMcpTool(
      "change_with_check",
      { command: "zfs set quota=2T tank/data", why: "Grow the quota", check: "zfs get quota tank/data", expected: "2T", rollback: "zfs set quota=1T tank/data" },
      ctx as never,
    )) as { id: string };
    const change = hub.store.data.tasks.flatMap((t) => t.changes).find((c) => c.id === asked.id)!;
    expect(change.check).toMatchObject({ command: "zfs get quota tank/data", expected: "2T" });
    expect(change.rollback?.command).toBe("zfs set quota=1T tank/data");
    await expect(
      callMcpTool("change_with_check", { command: "x", why: "y", check: "", expected: "", rollback: "" }, ctx as never),
    ).rejects.toThrow(/needs the check/);
  });

  it("says so where no command can be asked for at all", async () => {
    const hub = await makeHub();
    const bare = { request: (r: HubRequest) => hub.request(r), scopes: ["read", "run"], actor: "Jacob", serverId: "db01" };
    await expect(callMcpTool("run_command", { command: "uptime", why: "x" }, bare as never)).rejects.toThrow(/cannot run commands/);
    await expect(callMcpTool("command_status", { id: "x" }, bare as never)).rejects.toThrow(/nothing to report/);
  });
});

describe("what a run from outside is held to", () => {
  it("asks a person even for a command the policy would let through on its own", async () => {
    const { hub, ran } = await hubWithServer();
    // The safety policy would let a read-only command run unasked in assisted mode.
    const ctx = ctxFor(hub, SERVERS[0].id);
    const asked = (await callMcpTool("run_command", { command: "cat /etc/hostname", why: "which host is this" }, ctx as never)) as {
      status: string;
      id: string;
    };
    expect(asked.status).toBe("waiting for a person");
    expect(ran.join("\n")).not.toContain("/etc/hostname");
    const task = hub.store.data.tasks.find((t) => t.changes.some((c) => c.id === asked.id))!;
    expect(task.fromOutside).toBe(true);
    expect(task.mode).toBe("assisted");
    // One command per run: a key cannot keep a conversation going.
    expect(task.maxCommands).toBe(1);
  });
});
