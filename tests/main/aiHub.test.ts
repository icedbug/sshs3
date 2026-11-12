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

const nonce = "1234567890abcdef1234567890abcdef"; // pragma: allowlist secret
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
  it("runs a change with its check, and rolls it back by itself when the check fails", async () => {
    const { broker, t, capability, terminals } = await setup("autonomous");
    t.maxCommands = 20;
    broker.wait = async () => undefined;
    // What the terminal answers, in the order the broker asks.
    const run = vi.spyOn(terminals, "execute");
    const answer = (output: string, exitCode = 0) => run.mockResolvedValueOnce({ exitCode, output } as never);

    // 1. A change that works: check before (failing), the change, check after (passing).
    answer("inactive", 3);
    answer("");
    answer("active");
    const good = (await broker.invoke(capability.key, {
      action: "change",
      command: "systemctl start nginx",
      description: "Start nginx",
      check: { command: "systemctl is-active nginx", expected: "active" },
      rollback: "systemctl stop nginx",
    })) as Record<string, unknown>;
    expect(good).toMatchObject({ checkPassed: true, checkPassedBefore: false });
    expect(t.changes[0]).toMatchObject({ status: "completed", check: { before: false, after: true }, rollback: { command: "systemctl stop nginx" } });
    expect(t.changes[0].rollback!.ran).toBeUndefined();
    expect(t.verification).toBe("verified");
    expect(run.mock.calls.map((c) => c[3])).toEqual(["systemctl is-active nginx", "systemctl start nginx", "systemctl is-active nginx"]);

    // 2. A change whose check fails afterwards: the rollback runs, once, and the agent is told.
    run.mockClear();
    answer("worker_processes 4;");
    answer("");
    answer("502 Bad Gateway", 22);
    answer("restored");
    answer("200 OK");
    const bad = (await broker.invoke(capability.key, {
      action: "change",
      command: "cp nginx.new /etc/nginx/nginx.conf && systemctl reload nginx",
      description: "New nginx config",
      check: { command: "curl -fsS -o /dev/null -w '%{http_code}' http://localhost/", expected: "200" },
      rollback: "cp /etc/nginx/nginx.conf.bak /etc/nginx/nginx.conf && systemctl reload nginx",
    })) as Record<string, unknown>;
    expect(bad).toMatchObject({ checkPassed: false, rolledBack: true, checkPassesAfterRollback: true });
    expect(String(bad.next)).toContain("Do not make the same change again");
    expect(t.changes[1]).toMatchObject({ status: "failed", check: { after: false }, rollback: { ran: true, exitCode: 0, checkAfter: true } });
    expect(run.mock.calls.map((c) => c[3]).slice(-2)).toEqual([
      "cp /etc/nginx/nginx.conf.bak /etc/nginx/nginx.conf && systemctl reload nginx",
      "curl -fsS -o /dev/null -w '%{http_code}' http://localhost/",
    ]);

    // 3. A rollback that fails too: the agent is told to stop, not to try again.
    run.mockClear();
    answer("ok");
    answer("");
    answer("down", 1);
    answer("cannot restore", 1);
    answer("down", 1);
    const worse = (await broker.invoke(capability.key, { action: "change", command: "systemctl restart db", description: "Restart", check: { command: "systemctl is-active db", expected: "active" }, rollback: "systemctl start db" })) as Record<string, unknown>;
    expect(worse).toMatchObject({ checkPassed: false, rolledBack: false, checkPassesAfterRollback: false });
    expect(String(worse.next)).toContain("Stop making changes");

    // A change without a check or a way back is not a change this tool makes, and the check may only look.
    await expect(broker.invoke(capability.key, { action: "change", command: "systemctl restart x", rollback: "true" })).rejects.toThrow(/needs a check/);
    await expect(broker.invoke(capability.key, { action: "change", command: "systemctl restart x", check: { command: "systemctl is-active x", expected: "active" } })).rejects.toThrow(/needs a rollback/);
    await expect(broker.invoke(capability.key, { action: "change", command: "true", check: { command: "systemctl restart x", expected: "x" }, rollback: "true" })).rejects.toThrow(/must only look/);
    run.mockRestore();
  });

  it("keeps the check passing for the observation time, and rolls back when it stops", async () => {
    const { broker, t, capability, terminals } = await setup("autonomous");
    t.maxCommands = 20;
    const waits: number[] = [];
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    broker.wait = async (ms) => {
      waits.push(ms);
      now += ms;
    };
    const run = vi.spyOn(terminals, "execute");
    for (const [output, exitCode] of [["inactive", 3], ["", 0], ["active", 0], ["active", 0], ["failed", 3], ["stopped", 0], ["inactive", 3]] as const)
      run.mockResolvedValueOnce({ exitCode, output } as never);
    const result = (await broker.invoke(capability.key, { action: "change", command: "systemctl start app", description: "Start", check: { command: "systemctl is-active app", expected: "active" }, rollback: "systemctl stop app", observeSeconds: 30 })) as Record<string, unknown>;
    // It started, then crashed twenty seconds in: caught, and taken back.
    expect(waits).toEqual([10_000, 10_000]);
    expect(result).toMatchObject({ checkPassed: false, rolledBack: true });
    clock.mockRestore();
    run.mockRestore();
  });

  it("lets an investigator run read-only commands without asking, and refuses everything else without asking", async () => {
    const { broker, t, capability, writes } = await setup("advice");
    t.investigator = true;
    t.maxCommands = 10;
    const before = writes.length;
    // Looking is allowed, and nobody is asked.
    const looked = await broker.invoke(capability.key, { action: "command", command: "df -h" });
    expect(looked).toMatchObject({ exitCode: 0 });
    expect(t.status).toBe("running");
    expect(writes.length).toBe(before + 1);
    // Changing is refused, the command never reaches the terminal, and the person is not bothered.
    for (const command of ["systemctl restart nginx", "rm -rf /var/tmp/x", "df -h && echo x > /etc/motd"]) {
      await expect(broker.invoke(capability.key, { action: "command", command })).rejects.toThrow(/only runs read-only commands/);
      expect(t.status).toBe("running");
    }
    expect(writes.length).toBe(before + 1);
    expect(t.changes.map((c) => c.status)).toEqual(["completed", "denied", "denied", "denied"]);
    // Writing a file is not a command at all.
    await expect(broker.invoke(capability.key, { action: "file-write", path: "/etc/x", content: "y" } as never)).rejects.toThrow(/does not change files/);
  });
  it("runs a command an approved plan lists without asking again, once; anything else is still asked about", async () => {
    const { broker, t, capability } = await setup();
    t.maxCommands = 10;
    t.plan = {
      id: "p",
      goal: "say hi",
      steps: [{ action: "Say hi", command: "echo hi", risk: "low", check: "prints hi" }],
      status: "proposed",
      revision: 1,
      review: { verdict: "approve", findings: [] },
      createdAt: 1,
    };
    // A plan that is only proposed covers nothing.
    const early = broker.invoke(capability.key, { action: "command", command: "echo hi" });
    expect(t.status).toBe("waiting");
    broker.approve(t.id, t.changes[0].id, true);
    await early;

    t.plan.status = "approved";
    expect(await broker.invoke(capability.key, { action: "command", command: "echo hi" })).toMatchObject({ exitCode: 0 });
    expect(t.plan.steps[0].ranAt).toBeTypeOf("number");
    // The step has run: the same command a second time is not covered, nor is a different one.
    const again = broker.invoke(capability.key, { action: "command", command: "echo hi" });
    expect(t.status).toBe("waiting");
    broker.approve(t.id, t.changes.at(-1)!.id, true);
    await again;
    const other = broker.invoke(capability.key, { action: "command", command: "echo bye" });
    expect(t.status).toBe("waiting");
    broker.approve(t.id, t.changes.at(-1)!.id, true);
    await other;
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
      "-----BEGIN OPENSSH PRIVATE KEY-----\nsecretstuff\n-----END OPENSSH PRIVATE KEY-----"; // pragma: allowlist secret
    expect(maskContext(secret)).not.toContain("secretstuff");
    expect(maskContext("Authorization: Bearer abcd.efgh")).not.toContain(
      "abcd.efgh",
    );
    expect(maskContext("https://user:secret@example.com")).not.toContain( // pragma: allowlist secret
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

