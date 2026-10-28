import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NativeToolBridge, type NativeOwner } from "../../src/main/ai/desktop/NativeToolBridge";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import { HubStore } from "../../src/main/ai/hub/HubStore";
import type { AgentTask } from "../../src/shared/types/aiHub";
import type { ToolRequest } from "../../src/main/ai/hub/ToolBroker";

const disposals: Array<() => unknown> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-native-"));
  const terminals = new TerminalRegistry();
  terminals.observe(true);
  const writes: Array<{ id: string; data: string }> = [];
  for (const id of ["one", "two"]) {
    terminals.register({ id, label: `host-${id}`, kind: "ssh" }, (data) => {
      writes.push({ id, data });
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (nonce) queueMicrotask(() => terminals.feed(id,
        `\x1b]777;SSHS3;${nonce};BEGIN\x07healthy\x1b]777;SSHS3;${nonce};END;0;/srv\x07`));
    });
    await terminals.arm(id, "bash");
  }
  const store = new HubStore(path.join(directory, "hub.json"));
  const changed = vi.fn();
  const file = vi.fn(async (_task: AgentTask, _request: ToolRequest) => ({ content: "file content", hash: "expected-hash" }));
  const broker = new ToolBroker(terminals, {
    context: async (task) => ({ text: terminals.context(task.target!.sessionId), source: task.target!.sessionId }),
    memory: async () => [], file, changed,
  });
  const hub = { terminals, store, broker, changed, initialize: async () => {} };
  let available = false;
  const bridge = new NativeToolBridge(() => {
    if (!available) throw new Error("Hub has not initialized yet");
    return hub;
  }, changed);
  // Native main receives its environment before the sshs3 hub is initialized.
  const env = await bridge.start();
  available = true;
  const owner: NativeOwner = { profileHome: path.join(directory, "profile-a"), sessionId: "native-conversation" };
  const post = async (action: string, fields: Record<string, unknown> = {}, actor = owner) => {
    const response = await fetch(env.SSHS3_NATIVE_TOOL_URL, {
      method: "POST", headers: { Authorization: `Bearer ${env.SSHS3_NATIVE_TOOL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, owner: actor, ...fields }),
    });
    return { status: response.status, body: await response.json() as { result?: any; error?: string } };
  };
  disposals.unshift(async () => {
    await bridge.dispose();
    await broker.dispose();
    terminals.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { bridge, env, owner, post, terminals, store, writes, file, directory };
}

describe("native Hermes terminal authority", () => {
  it("keeps a conversation on its original terminal across tab changes and later turns", async () => {
    const { bridge, post, writes, terminals } = await setup();
    bridge.selectTerminal("one");
    const { body: { result: bound } } = await post("begin", { platform: "desktop" });
    expect(bound).toMatchObject({ bound: true, active: true, target: "host-one" });
    bridge.selectTerminal("two");
    const command = post("tool", { request: { action: "command", command: "echo healthy", sessionId: "two", description: "Check health" } });
    await vi.waitFor(() => expect(bridge.snapshot().bindings[0].task.status).toBe("waiting"));
    const task = bridge.snapshot().bindings[0].task;
    expect(writes).toHaveLength(2);
    bridge.approve(task.id, task.changes[0].id, true);
    expect((await command).body.result).toMatchObject({ exitCode: 0, source: "terminal:one" });
    expect(writes[2].id).toBe("one");
    await post("end");
    expect(terminals.get("one")!.owner).toBeUndefined();
    expect((await post("begin", { platform: "desktop" })).body.result.target).toBe("host-one");
    expect(bridge.snapshot().bindings[0].task.target?.sessionId).toBe("one");
  });

  it("isolates profiles and prevents an unbound conversation from borrowing a capability", async () => {
    const { bridge, post, owner } = await setup();
    bridge.selectTerminal("one");
    await post("begin", { platform: "desktop" });
    const other = { ...owner, profileHome: path.join(owner.profileHome, "other-profile") };
    expect((await post("status", {}, other)).body.result).toEqual({ bound: false });
    const denied = await post("tool", { request: { action: "command", command: "echo forbidden" } }, other);
    expect(denied.status).toBe(400);
    expect(denied.body.error).toContain("No terminal is bound");
  });

  it("revokes a pending approval before takeover allows user input, without queuing more commands", async () => {
    const { bridge, post, writes, terminals } = await setup();
    bridge.selectTerminal("one");
    await post("begin", { platform: "desktop" });
    const command = post("tool", { request: { action: "command", command: "echo pending", description: "Inspect" } });
    await vi.waitFor(() => expect(bridge.snapshot().bindings[0].task.status).toBe("waiting"));
    const task = bridge.snapshot().bindings[0].task;
    bridge.takeover(task.id);
    expect((await command).status).toBe(400);
    expect(writes).toHaveLength(2);
    await post("end");
    expect(task.status).toBe("interrupted");
    expect(() => terminals.humanWrite("one")).not.toThrow();
    expect((await post("begin", { platform: "desktop" })).body.result).toMatchObject({ bound: true, active: false });
    expect((await post("tool", { request: { action: "command", command: "echo retry" } })).status).toBe(400);
  });

  it("fails closed on a replaced terminal and requires explicit rearming and resume", async () => {
    const { bridge, post, terminals, writes } = await setup();
    bridge.selectTerminal("one");
    await post("begin", { platform: "desktop" });
    const task = bridge.snapshot().bindings[0].task;
    const originalGeneration = task.target!.generation;
    terminals.invalidate("one", "Network lost", true);
    bridge.selectTerminal("two");
    expect((await post("begin", { platform: "desktop" })).body.result.active).toBe(false);
    expect(task.target!.generation).toBe(originalGeneration);
    await expect(bridge.resume(task.id)).rejects.toThrow("Arm the assigned terminal");
    expect(writes).toHaveLength(2);
  });

  it("marks a stale selected instance as bound and blocked, instead of silently using native host tools", async () => {
    const { bridge, post, terminals } = await setup();
    bridge.selectTerminal("one");
    terminals.invalidate("one", "Session replaced");
    const result = (await post("begin", { platform: "desktop" })).body.result;
    expect(result).toMatchObject({ bound: true, active: false });
    expect((await post("status")).body.result.bound).toBe(true);
    expect(bridge.snapshot().bindings[0].task.status).toBe("interrupted");
  });

  it("enforces a bounded command budget and distinguishes verification from a successful command", async () => {
    const { bridge, post } = await setup();
    bridge.selectTerminal("one");
    await post("begin", { platform: "desktop" });
    const task = bridge.snapshot().bindings[0].task;
    task.maxCommands = 1;
    const verify = post("tool", { request: { action: "verify", command: "echo healthy", expected: "healthy", description: "Verify service" } });
    await vi.waitFor(() => expect(task.status).toBe("waiting"));
    bridge.approve(task.id, task.changes[0].id, true);
    expect((await verify).status).toBe(200);
    expect(task.verification).toBe("verified");
    expect((await post("tool", { request: { action: "command", command: "echo extra" } })).body.error).toContain("budget exhausted");
  });

  it("sends only approved tool fields to target-scoped file access", async () => {
    const { bridge, post, file } = await setup();
    bridge.selectTerminal("one");
    await post("begin", { platform: "desktop" });
    expect((await post("tool", { request: { action: "file-read", path: "/etc/service.conf", target: "another-host", profileId: "evil" } })).status).toBe(200);
    expect(file.mock.calls[0][0].target!.sessionId).toBe("one");
    expect(file.mock.calls[0][1]).toEqual({ action: "file-read", command: undefined, query: undefined, path: "/etc/service.conf", content: undefined, expected: undefined, description: undefined });
  });

  it("requires the private capability and refuses browser origins", async () => {
    const { env } = await setup();
    const noKey = await fetch(env.SSHS3_NATIVE_TOOL_URL, { method: "POST", body: "{}" });
    expect(noKey.status).toBe(403);
    const origin = await fetch(env.SSHS3_NATIVE_TOOL_URL, {
      method: "POST", headers: { Authorization: `Bearer ${env.SSHS3_NATIVE_TOOL_KEY}`, Origin: "https://untrusted.example" }, body: "{}",
    });
    expect(origin.status).toBe(403);
  });

  it.runIf(process.env.HERMES_NATIVE_CONTRACT === "1")("honors the real native plugin discovery, lifecycle, dispatcher identity and child secret scrub", async () => {
    const { bridge, env, owner, writes, terminals } = await setup();
    bridge.selectTerminal("one");
    await fs.mkdir(path.join(owner.profileHome, "plugins"), { recursive: true });
    await fs.cp(path.resolve("integrations/hermes-desktop/sshs3_terminal"), path.join(owner.profileHome, "plugins/sshs3_terminal"), { recursive: true });
    await fs.writeFile(path.join(owner.profileHome, "config.yaml"), JSON.stringify({
      plugins: { enabled: ["sshs3_terminal"] }, tool_search: { enabled: "off" },
    }));
    const runtime = path.resolve(process.env.SSHS3_HERMES_NATIVE_RUNTIME_DIR ?? "build-resources/hermes-native-runtime");
    const manifest = JSON.parse(await fs.readFile(path.join(runtime, "manifest.json"), "utf8")) as { python: string; repo: string };
    const python = path.resolve(runtime, manifest.python);
    const safeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP, TMP: process.env.TMP,
      SSHS3_CONTRACT_ENGINE_ROOT: path.resolve(runtime, manifest.repo),
      HERMES_HOME: owner.profileHome, HOME: owner.profileHome, USERPROFILE: owner.profileHome,
      APPDATA: owner.profileHome, LOCALAPPDATA: owner.profileHome,
      HERMES_DESKTOP: "1", ...env,
    };
    const processResult = promisify(execFile)(python, ["-I", "-B", path.resolve("tests/main/fixtures/nativeHermesToolsContract.py")], {
      env: safeEnv, timeout: 60_000, windowsHide: true,
    });
    await vi.waitFor(() => expect(bridge.snapshot().bindings[0]?.task.status).toBe("waiting"), { timeout: 30_000 });
    const task = bridge.snapshot().bindings[0].task;
    expect(writes).toHaveLength(2);
    bridge.selectTerminal("two");
    bridge.approve(task.id, task.changes[0].id, true);
    const output = await processResult;
    expect(output.stdout).toContain('"nativePlugin": "passed"');
    expect(output.stdout).toContain('"secretScrub": "passed"');
    expect(writes[2].id).toBe("one");
    expect(terminals.get("one")!.owner).toBeUndefined();
    expect(task.status).toBe("interrupted");
    expect(task.changes[1].status).toBe("denied");
    expect(writes).toHaveLength(3);
  }, 60_000);
});
