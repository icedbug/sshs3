import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker } from "../../src/main/ai/hub/ToolBroker";
import { maskContext, maskStrings } from "../../src/main/ai/hub/privacy";
import type { AgentChange, AgentTask } from "../../src/shared/types/aiHub";

/** How each change came to be allowed or refused, and what is kept and shown of it. From the review of feature 3. */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
  vi.useRealTimers();
});

const task = (mode: AgentTask["mode"]): AgentTask => ({
  id: "a",
  title: "t",
  mode,
  status: "running",
  messages: [],
  changes: [],
  sources: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  maxCommands: 20,
  maxMinutes: 5,
  verification: "not-verified",
});

async function setup(mode: AgentTask["mode"], approvalWaitMs = 60_000) {
  const terminals = new TerminalRegistry();
  disposals.push(() => terminals.dispose());
  terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n) queueMicrotask(() => terminals.feed("one", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
  });
  await terminals.arm("one", "bash");
  const t = task(mode);
  t.target = { sessionId: "one", generation: terminals.get("one")!.generation, label: "host" };
  terminals.claim("one", t.target.generation, t.id);
  const broker = new ToolBroker(terminals, { context: async () => ({}), memory: async () => [], file: async () => ({}), changed: vi.fn(), approvalWaitMs: () => approvalWaitMs });
  disposals.unshift(() => broker.dispose());
  const capability = await broker.issue(t);
  return { broker, t, capability };
}

describe("how a change was decided", () => {
  it("records the safety rules, a person, a timeout and a stop, each as itself", async () => {
    const auto = await setup("autonomous");
    await auto.broker.invoke(auto.capability.key, { action: "command", command: "uptime" });
    expect(auto.t.changes[0]).toMatchObject({ status: "completed", decidedHow: "policy" });

    const asked = await setup("assisted");
    const p = asked.broker.invoke(asked.capability.key, { action: "command", command: "systemctl restart nginx" });
    await vi.waitFor(() => expect(asked.t.status).toBe("waiting"));
    asked.broker.approve(asked.t.id, asked.t.changes[0].id, true);
    await p;
    expect(asked.t.changes[0].decidedHow).toBe("person");

    const late = await setup("assisted", 20);
    await expect(late.broker.invoke(late.capability.key, { action: "command", command: "systemctl restart nginx" })).rejects.toThrow();
    expect(late.t.changes[0]).toMatchObject({ status: "denied", decidedHow: "timeout" });

    const stopped = await setup("assisted");
    const q = stopped.broker.invoke(stopped.capability.key, { action: "command", command: "systemctl restart nginx" });
    await vi.waitFor(() => expect(stopped.t.status).toBe("waiting"));
    stopped.t.status = "interrupted";
    stopped.broker.revoke(stopped.t.id);
    await expect(q).rejects.toThrow();
    expect(stopped.t.changes[0]).toMatchObject({ status: "denied", decidedHow: "stopped" });
  });

  it("gives the agent what the person said with the answer, and keeps the run going after a no", async () => {
    const no = await setup("assisted");
    const p = no.broker.invoke(no.capability.key, { action: "command", command: "systemctl restart nginx" });
    await vi.waitFor(() => expect(no.t.status).toBe("waiting"));
    no.broker.approve(no.t.id, no.t.changes[0].id, false, "reload instead of restart");
    await expect(p).rejects.toThrow("Not approved. The person said: reload instead of restart");
    expect(no.t.status).toBe("running");
    expect(no.t.changes[0]).toMatchObject({ status: "denied", decisionNote: "reload instead of restart" });

    const yes = await setup("assisted");
    const q = yes.broker.invoke(yes.capability.key, { action: "command", command: "systemctl restart nginx" });
    await vi.waitFor(() => expect(yes.t.status).toBe("waiting"));
    yes.broker.approve(yes.t.id, yes.t.changes[0].id, true, "watch the error log after");
    expect(await q).toMatchObject({ personNote: "Approved with a note from the person: watch the error log after" });
  });

  it("keeps a run waiting while an external agent still has a question open, and answers each one as given", async () => {
    const { broker, t } = await setup("assisted");
    const change = (id: string): AgentChange => ({ id, kind: "command", target: "x", description: id, status: "pending", at: Date.now() });
    const first = broker.askApproval(t, change("one"));
    const second = broker.askApproval(t, change("two"));
    broker.approve(t.id, "one", true);
    expect(await first).toBe(true);
    // The other question is still open: the run is still waiting, and a yes to it is a yes.
    expect(t.status).toBe("waiting");
    broker.approve(t.id, "two", true);
    expect(await second).toBe(true);
    expect(t.status).toBe("running");
    expect(t.changes.map((c) => c.status)).toEqual(["approved", "approved"]);
  });
});

describe("what is masked before it leaves this computer", () => {
  it("masks every string in structured data and keeps its shape", () => {
    const doc = { id: "d", title: "db", content: "password: hunter2\nhost db01", tags: ["token=abc123def"], n: 3, nested: { k: "Bearer abc.def" } };
    const masked = maskStrings(doc);
    expect(masked).toEqual({ id: "d", title: "db", content: "password: [redacted]\nhost db01", tags: ["token=[redacted]"], n: 3, nested: { k: "Bearer [redacted]" } });
    expect(doc.content).toContain("hunter2");
  });

  it("knows the common secret shapes", () => {
    for (const secret of [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstu",
      "glpat-abcdefghij0123456789",
      "xoxb-1234567890-abcdefghij",
      "sk_live_abcdefghijklmnop1234",
      "AIzaSyA1234567890abcdefghijklmnopqrstu",
    ])
      expect(maskContext(`x ${secret} y`)).toBe("x [redacted] y");
    expect(maskContext("client-key-data: LS0tLS1CRUdJTi0tLS0tCg==")).toBe("client-key-data: [redacted]");
    expect(maskContext("MYSQL_PWD=hunter2")).toBe("MYSQL_PWD=[redacted]");
    expect(maskContext("mysql -u root -phunter2 -e 'select 1'")).toBe("mysql -u root -p[redacted] -e 'select 1'");
    expect(maskContext("mongodb+srv://user:p@ss@host.example/db")).toBe("mongodb+srv://user:[redacted]@host.example/db");
    // And leaves what is not a secret alone.
    for (const plain of ["ssh user@host", "git clone https://github.com/a/b", "mysql -h db -P 3306 -u app", "date +%s"]) expect(maskContext(plain)).toBe(plain);
  });
});

describe("a person changing the safety rules", () => {
  it("is written into the audit log, from what to what, and shown on the card", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-policy-"));
    const hub = new HubService(
      { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), workspaceServers: async () => [] } as never,
      dir,
    );
    disposals.push(async () => {
      await hub.dispose();
      setDemoModeForTesting(undefined);
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    await hub.initialize();
    const snap = await hub.request({ action: "safety-policy-save", policy: { autoApproveSafeReadOnly: true, requireApprovalOnProdTags: false, blockDestructiveWithoutConfirm: true } });
    expect(snap.safetyPolicyChanged?.by).toBeTruthy();
    await vi.waitFor(async () => {
      const log = (await hub.request({ action: "audit-read" })).reply?.audit;
      expect(log?.entries[0]).toMatchObject({ kind: "setting", what: "Safety policy: always ask before a change on production: on → off" });
    });
  });
});
