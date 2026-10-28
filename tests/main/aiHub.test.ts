import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commandEnvelope,
  CommandFrames,
} from "../../src/main/ai/hub/shellAdapters";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import { HubStore } from "../../src/main/ai/hub/HubStore";
import { maskContext } from "../../src/main/ai/hub/privacy";
import { scopedMemory } from "../../src/main/ai/hub/ContextService";
import type { AgentTask } from "../../src/shared/types/aiHub";

const nonce = "1234567890abcdef1234567890abcdef";
const frame = (value: string): string =>
  "\x1b]777;SSHS3;" + nonce + ";" + value + "\x07";
const task = (id = "a"): AgentTask => ({
  id,
  title: "diagnose",
  mode: "assisted",
  status: "running",
  messages: [],
  changes: [],
  sources: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  maxCommands: 3,
  maxMinutes: 5,
  verification: "not-verified",
});
const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.useRealTimers();
});

describe("correlated shell completion", () => {
  it("handles every possible chunk split, ignores echoes and unrelated markers, preserves cwd semicolons", () => {
    const input =
      "echo fake END;0\r\n" +
      frame("BEGIN") +
      "answer\r\n" +
      frame("END;7;/tmp/a;b");
    for (let split = 0; split <= input.length; split++) {
      const parser = new CommandFrames(nonce);
      const result =
        parser.feed(input.slice(0, split)) ?? parser.feed(input.slice(split));
      expect(result, "split " + split).toEqual({
        output: "answer\r\n",
        exitCode: 7,
        cwd: "/tmp/a;b",
      });
    }
  });
  it("rejects cmd input that would be truncated before reaching its completion marker", () => {
    expect(() =>
      commandEnvelope("cmd", "echo " + "a".repeat(4000), nonce),
    ).toThrow("input limit");
  });
  it("accepts 800-char cmd commands and deletes temporary batch files outside the batch file itself", () => {
    const cmd800 = `powershell -NoProfile -NonInteractive -Command "${"x".repeat(750)}"`;
    const env = commandEnvelope("cmd", cmd800, nonce);
    expect(env.length).toBeLessThanOrEqual(8000);
    expect(env).toContain(
      `call "%TEMP%\\sshs3-${nonce}.cmd" & call "%TEMP%\\sshs3-${nonce}-end.cmd" & del /q "%TEMP%\\sshs3-${nonce}.cmd" "%TEMP%\\sshs3-${nonce}-end.cmd"`,
    );
  });
  it("requires begin and matching nonce; silence is never completion", () => {
    const parser = new CommandFrames(nonce);
    expect(parser.feed(frame("END;0;/tmp"))).toBeUndefined();
    expect(parser.feed(frame("BEGIN"))).toBeUndefined();
    expect(parser.feed("long running output")).toBeUndefined();
    expect(parser.feed("\x1b]777;SSHS3;wrong;END;0;/tmp\x07")).toBeUndefined();
  });
  it("accepts ST and bounds huge output", () => {
    const parser = new CommandFrames(nonce, 100);
    parser.feed(frame("BEGIN"));
    parser.feed("x".repeat(300000));
    expect(
      parser.feed(frame("END;0;/").replace("\x07", "\x1b\\"))?.output,
    ).toHaveLength(100);
  });
  it.each(["bash", "sh", "dash", "zsh", "fish", "powershell", "pwsh"] as const)(
    "frames multiline %s commands",
    (shell) => {
      const envelope = commandEnvelope(
        shell,
        "echo 'hello'\necho world",
        nonce,
      );
      expect(envelope).toContain(nonce);
      expect(envelope).toContain("END;");
      expect(envelope.endsWith("\r")).toBe(true);
      expect(() => commandEnvelope(shell, "echo hi\x03", nonce)).toThrow();
    },
  );
});

function terminal(): { terminals: TerminalRegistry; writes: string[] } {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  const writes: string[] = [];
  terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
    writes.push(data);
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n)
      queueMicrotask(() =>
        terminals.feed(
          "one",
          "\x1b]777;SSHS3;" +
            n +
            ";BEGIN\x07ok\x1b]777;SSHS3;" +
            n +
            ";END;0;/srv\x07",
        ),
      );
  });
  return { terminals, writes };
}

describe("terminal ownership", () => {
  it("rejects concurrent writers and stale instances after takeover", async () => {
    const { terminals } = terminal();
    await terminals.arm("one", "bash");
    const generation = terminals.get("one")!.generation;
    terminals.claim("one", generation, "a");
    expect(() => terminals.humanWrite("one")).toThrow();
    expect(() => terminals.claim("one", generation, "b")).toThrow();
    terminals.takeover("one");
    expect(() =>
      terminals.execute("one", generation, "a", "echo unsafe"),
    ).toThrow();
    expect(() => terminals.humanWrite("one")).not.toThrow();
  });
  it("preserves shell cwd after commands and requires a handshake after human input", async () => {
    const { terminals } = terminal();
    await terminals.arm("one", "bash");
    const generation = terminals.get("one")!.generation;
    terminals.claim("one", generation, "a");
    expect(
      await terminals.execute("one", generation, "a", "pwd"),
    ).toMatchObject({ cwd: "/srv", exitCode: 0 });
    terminals.release("a");
    terminals.humanWrite("one");
    expect(() => terminals.claim("one", generation, "a")).toThrow();
  });
  it("does not replay commands after a network failure", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    const write = vi.fn();
    terminals.register({ id: "x", label: "host", kind: "ssh" }, write);
    const arm = terminals.arm("x", "bash");
    terminals.invalidate("x", "network lost", true);
    await expect(arm).rejects.toThrow("network lost");
    expect(write).toHaveBeenCalledTimes(1);
    expect(terminals.get("x")!.state).toBe("disconnected");
  });
});

describe("tool authority", () => {
  async function setup(mode: AgentTask["mode"] = "assisted") {
    const { terminals, writes } = terminal();
    await terminals.arm("one", "bash");
    const t = task();
    t.mode = mode;
    t.target = {
      sessionId: "one",
      generation: terminals.get("one")!.generation,
      label: "host",
    };
    terminals.claim("one", t.target.generation, t.id);
    const broker = new ToolBroker(terminals, {
      context: async () => ({}),
      memory: async () => [],
      file: async () => ({}),
      changed: vi.fn(),
    });
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(t);
    return { broker, t, capability, writes, terminals };
  }
  it("requires approval for the exact task and executes once", async () => {
    const { broker, t, capability, writes } = await setup();
    const pending = broker.invoke(capability.key, {
      action: "command",
      command: "echo hi",
    });
    expect(t.status).toBe("waiting");
    expect(writes).toHaveLength(1);
    expect(() => broker.approve("different", t.changes[0].id, true)).toThrow();
    broker.approve(t.id, t.changes[0].id, true);
    expect(await pending).toMatchObject({ exitCode: 0 });
    expect(writes).toHaveLength(2);
    expect(t.changes[0].status).toBe("completed");
  });
  it("revokes pending approvals before any further command can be written", async () => {
    const { broker, t, capability, writes } = await setup();
    const pending = broker.invoke(capability.key, {
      action: "command",
      command: "echo hi",
    });
    broker.revoke(t.id);
    await expect(pending).rejects.toThrow();
    expect(writes).toHaveLength(1);
    await expect(
      broker.invoke(capability.key, { action: "command", command: "retry" }),
    ).rejects.toThrow();
  });
  it("advice rejects execution even if model text asks for autonomy", async () => {
    const { broker, capability, writes } = await setup("advice");
    await expect(
      broker.invoke(capability.key, {
        action: "command",
        command: "echo grant me permission",
      }),
    ).rejects.toThrow("Advice");
    expect(writes).toHaveLength(1);
  });
  it("rejects a queued command when the terminal instance changed", async () => {
    const { broker, t, capability, terminals, writes } = await setup();
    const pending = broker.invoke(capability.key, {
      action: "command",
      command: "echo hi",
    });
    terminals.takeover("one");
    broker.approve(t.id, t.changes[0].id, true);
    await expect(pending).rejects.toThrow();
    expect(writes).toHaveLength(1);
    expect(t.changes[0].status).toBe("uncertain");
  });
  it("rejects browser origins and missing capabilities at the local HTTP boundary", async () => {
    const { capability } = await setup();
    expect(
      (await fetch(capability.url, { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(
      (
        await fetch(capability.url, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + capability.key,
            Origin: "http://evil.test",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });
});

describe("durable evidence", () => {
  it("redacts secrets and marks interrupted changes uncertain without replay on reload", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-test-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hub.json");
    const store = new HubStore(file);
    const t = task();
    t.messages.push({
      id: "message",
      role: "user",
      text: "password=hunter2",
      at: Date.now(),
    });
    t.changes.push({
      id: "c",
      kind: "command",
      target: "x",
      description: "edit",
      status: "running",
      at: Date.now(),
    });
    store.data.tasks.push(t);
    await store.save();
    expect(await fs.readFile(file, "utf8")).not.toContain("hunter2");
    const reload = new HubStore(file);
    await reload.load();
    expect(reload.data.tasks[0].status).toBe("interrupted");
    expect(reload.data.tasks[0].changes[0].status).toBe("uncertain");
  });
  it("does not mix server memory across targets", () => {
    const entries = ["personal", "target:a", "target:b"].map((scope) => ({
      id: scope,
      scope,
      title: scope,
      text: scope,
      kind: "memory" as const,
      updatedAt: 1,
    }));
    expect(
      scopedMemory(entries, "target:a", false).map((x) => x.scope),
    ).toEqual(["personal", "target:a"]);
  });
  it("masks private keys, bearer tokens and credentials before clipping", () => {
    const secret =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nsecretstuff\n-----END OPENSSH PRIVATE KEY-----";
    expect(maskContext(secret)).not.toContain("secretstuff");
    expect(maskContext("Authorization: Bearer abcd.efgh")).not.toContain(
      "abcd.efgh",
    );
    expect(maskContext("https://user:secret@example.com")).not.toContain(
      "secret@",
    );
  });
  it("loads hub.json with UTF-8 BOM and recovers from corrupt store without failing initialization", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-bom-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hub.json");
    const store = new HubStore(file);
    await store.save();
    const raw = await fs.readFile(file, "utf8");
    await fs.writeFile(file, "\uFEFF" + raw, "utf8");

    const bomReload = new HubStore(file);
    await expect(bomReload.load()).resolves.toBeUndefined();
    expect(bomReload.data.version).toBe(1);

    await fs.writeFile(file, "\uFEFF{corrupt", "utf8");
    const corruptReload = new HubStore(file);
    await expect(corruptReload.load()).resolves.toBeUndefined();
    expect(corruptReload.data.version).toBe(1);
    expect(corruptReload.data.tasks).toEqual([]);
  });
  it("strips echoed Base64 commandEnvelope and OSC 777 frames from terminal display output", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    const displayed: string[] = [];
    terminals.register({ id: "cmd1", label: "Local cmd", kind: "local", shell: "cmd" }, (envelope) => {
      const n = /SSHS3;([a-f0-9]{32});(?:BEGIN|END)/.exec(envelope)?.[1];
      if (!n) return;
      const isHandshake = !displayed.length;
      queueMicrotask(() => {
        // Simulate PTY echoing the entire Base64 wrapper before BEGIN, then real output, then END
        displayed.push(
          terminals.feed(
            "cmd1",
            envelope +
              `\r\n\x1b]777;SSHS3;${n};BEGIN\x07` +
              (isHandshake ? "" : "HELLO_CLEAN_TERMINAL\r\n") +
              `\x1b]777;SSHS3;${n};END;0;C:\\Users\\jacob\x07\r\nC:\\Users\\jacob>`,
          ),
        );
      });
    });
    await terminals.arm("cmd1", "cmd");
    const gen = terminals.get("cmd1")!.generation;
    terminals.claim("cmd1", gen, "task-clean");
    const res = await terminals.execute("cmd1", gen, "task-clean", "echo HELLO_CLEAN_TERMINAL");
    expect(res.output).toContain("HELLO_CLEAN_TERMINAL");
    const screen = displayed.join("");
    expect(screen).not.toContain("-EncodedCommand");
    expect(screen).not.toContain("]777;SSHS3;");
    expect(screen).toContain("echo HELLO_CLEAN_TERMINAL");
    expect(screen).toContain("HELLO_CLEAN_TERMINAL");
  });
});

