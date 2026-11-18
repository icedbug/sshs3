import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ACP_PROTOCOL_VERSION, probeRunner } from "../../src/main/ai/hub/AcpRuntime";

/**
 * "Test" on an external agent: its program is started, greeted and stopped again, and the answer
 * says in plain words what was found. The "agents" here are small node scripts.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function script(body: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-runner-"));
  disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(dir, "agent.cjs");
  await fs.writeFile(file, body);
  return { dir, file };
}

/** A program that answers the greeting the way an agent does. */
const answering = (result: string): string => `
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ${result} }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`;

const node = process.execPath;

describe("testing an external agent", () => {
  it("says it works when the program answers the greeting, and who it is", async () => {
    const { dir, file } = await script(answering(`result: { protocolVersion: ${ACP_PROTOCOL_VERSION}, agentInfo: { name: "test-agent", version: "1.2" } }`));
    const found = await probeRunner({ name: "Test agent", command: node, args: [file], cwd: dir });
    expect(found).toEqual({ ok: true, detail: "It started and answered as an agent (test-agent 1.2)." });
  });

  it("says that it still needs a working folder when none is set", async () => {
    const { file } = await script(answering(`result: { protocolVersion: ${ACP_PROTOCOL_VERSION} }`));
    const found = await probeRunner({ name: "Test agent", command: node, args: [file] });
    expect(found.ok).toBe(true);
    expect(found.detail).toBe("It started and answered as an agent. No working folder is set for it on this computer: it needs one before it can be given work.");
  });

  it("says so when the program is not on this computer, or its folder is not", async () => {
    expect(await probeRunner({ name: "Missing", command: "no-such-agent-program-xyz", args: [] })).toEqual({
      ok: false,
      detail: 'The program "no-such-agent-program-xyz" was not found on this computer. Install it there, or give its full path.',
    });
    // In the web app the program is the server's.
    expect((await probeRunner({ name: "Missing", command: "no-such-agent-program-xyz", args: [] }, { where: "on the server sshS3 runs on" })).detail).toBe(
      'The program "no-such-agent-program-xyz" was not found on the server sshS3 runs on. Install it there, or give its full path.',
    );
    expect(await probeRunner({ name: "Node", command: node, args: [], cwd: "/no/such/folder/anywhere" })).toEqual({
      ok: false,
      detail: 'The working folder "/no/such/folder/anywhere" does not exist on this computer.',
    });
  });

  it("says so when the program ends at once, with what it printed", async () => {
    const { file } = await script(`console.error("not signed in"); process.exit(3);`);
    const found = await probeRunner({ name: "Quitter", command: node, args: [file] });
    expect(found.ok).toBe(false);
    expect(found.detail).toContain("started and ended at once (exit 3), without answering.");
    expect(found.detail).toContain("It said: not signed in");
  });

  it("gives up on a program that never answers", async () => {
    const { file } = await script(`setInterval(() => {}, 1000);`);
    const started = Date.now();
    const found = await probeRunner({ name: "Silent", command: node, args: [file] }, { timeoutMs: 400 });
    expect(found.ok).toBe(false);
    expect(found.detail).toContain("started but did not answer within 1 second.");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("says so when the program speaks another version, or answers with an error", async () => {
    const other = await script(answering(`result: { protocolVersion: ${ACP_PROTOCOL_VERSION + 41} }`));
    expect((await probeRunner({ name: "Old agent", command: node, args: [other.file] })).detail).toBe(
      `"Old agent" speaks protocol version ${ACP_PROTOCOL_VERSION + 41}; sshS3 speaks ${ACP_PROTOCOL_VERSION}.`,
    );
    const failing = await script(answering(`error: { code: -32000, message: "Authentication required" }`));
    expect(await probeRunner({ name: "Locked", command: node, args: [failing.file] })).toEqual({
      ok: false,
      detail: `"${node}" answered with an error: Authentication required`,
    });
  });

  it("is asked for through the hub, by the runner's id", async () => {
    const { dir, file } = await script(answering(`result: { protocolVersion: ${ACP_PROTOCOL_VERSION} }`));
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-runner-hub-"));
    const hub = new HubService(
      { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(data, "ai.json") } as never,
      data,
    );
    disposals.unshift(async () => {
      await hub.dispose();
      await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    await hub.initialize();
    await hub.request({ action: "runner-save", runner: { id: "test-agent", name: "Test agent", command: node, args: [file], cwd: dir } });

    const snap = await hub.request({ action: "runner-test", id: "test-agent" });
    expect(snap.reply?.runnerProbe).toEqual({ id: "test-agent", ok: true, detail: "It started and answered as an agent." });
    await expect(hub.request({ action: "runner-test", id: "gone" })).rejects.toThrow("not set up here any more");
  });
});
