import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { COMPARISON_TEXT, ToolBroker, comparedWithBaseline, stableObservation, stableObservationHash } from "../../src/main/ai/hub/ToolBroker";
import { observationHash } from "../../src/main/ai/hub/privacy";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * A rollback counted as "not as before" whenever the check's output held a time, a process id or a
 * counter: it had to be the same output byte for byte. Now it is compared three ways, and the result
 * says which one held.
 */

const disposals: Array<() => unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

const status = (state: string, at: string, ago: string, pid: number) =>
  [
    "● nginx.service - A high performance web server",
    "     Loaded: loaded (/lib/systemd/system/nginx.service; enabled; vendor preset: enabled)",
    `     Active: ${state} since Mon 2026-11-23 ${at} UTC; ${ago} ago`,
    `    Process: ${pid - 2} ExecStartPre=/usr/sbin/nginx -t -q (code=exited, status=0/SUCCESS)`,
    `   Main PID: ${pid} (nginx)`,
    `      Tasks: ${pid % 7} (limit: 4915)`,
    `     Memory: ${pid % 9}.1M`,
    "        CPU: 45ms",
    "     CGroup: /system.slice/nginx.service",
    `             ├─${pid} nginx: master process /usr/sbin/nginx`,
    `             └─${pid + 1} nginx: worker process`,
  ].join("\n");

describe("what is left out of a check's output before two looks are compared", () => {
  it("leaves out dates and times, how long ago, process ids and systemd's counters", () => {
    expect(stableObservation(status("active (running)", "10:00:00", "3s", 1234))).toBe(stableObservation(status("active (running)", "10:07:41", "2min 5s", 98765)));
    expect(stableObservation("10:00:01 up 3 days,  1:02,  2 users,  load average: 0.00, 0.01, 0.05")).toBe(
      stableObservation("10:09:55 up 3 days,  1:11,  3 users,  load average: 0.31, 0.11, 0.07"),
    );
    expect(stableObservation("Nov 23 10:00:00 web-01 nginx[1234]: started")).toBe(stableObservation("Nov 23 10:05:09 web-01 nginx[4321]: started"));
    expect(stableObservation('{"status":"UP","at":"2026-11-23T10:00:00.123Z","since":1763892000}')).toBe(
      stableObservation('{"status":"UP","at":"2026-11-23T10:05:41.900Z","since":1763892341}'),
    );
    expect(stableObservation("web   Up 3 minutes   0.0.0.0:80->80/tcp")).toBe(stableObservation("web   Up 2 hours   0.0.0.0:80->80/tcp"));
    expect(stableObservation('users:(("nginx",pid=1234,fd=6))')).toBe(stableObservation('users:(("nginx",pid=777,fd=6))'));
  });

  it("keeps what may be a setting or a state: those are what a rollback is about", () => {
    const differ = (a: string, b: string) => expect(stableObservation(a)).not.toBe(stableObservation(b));
    differ(status("active (running)", "10:00:00", "3s", 1234), status("failed (Result: exit-code)", "10:00:00", "3s", 1234));
    differ("inactive", "failed");
    differ("proxy_read_timeout 30s;", "proxy_read_timeout 60s;");
    differ("worker_processes 4;", "worker_processes 8;");
    differ("LISTEN 0 511 0.0.0.0:80", "LISTEN 0 511 0.0.0.0:8080");
    differ("replicas: 3", "replicas: 5");
    differ("web   Up 3 minutes   0.0.0.0:80->80/tcp", "web   Exited (1) 3 minutes ago");
    // Text with nothing volatile in it is left as it is.
    expect(stableObservation("active\n")).toBe("active");
  });
});

describe("whether a look after a rollback reads as the look before the change", () => {
  const passes = (look: { exitCode: number; output: string }) => look.exitCode === 0 && look.output.includes("active (running)");
  const before = { exitCode: 0, output: status("active (running)", "10:00:00", "3s", 1234) };

  it("says which comparison held: the same output, the same without what is volatile, or the card's own expected text", () => {
    expect(comparedWithBaseline({ id: "c", now: { ...before }, baseline: before, before: true, passes })).toBe("exact");
    const restarted = { exitCode: 0, output: status("active (running)", "10:07:41", "2s", 4321) };
    expect(comparedWithBaseline({ id: "c", now: restarted, baseline: before, before: true, passes })).toBe("stable");
    // A different shape of output that still shows what the card expects.
    const other = { exitCode: 0, output: "nginx is active (running), 4 workers" };
    expect(comparedWithBaseline({ id: "c", now: other, baseline: before, before: true, passes })).toBe("expected");
  });

  it("does not take two failed checks for the same state: a check that failed before and fails again proves nothing by itself", () => {
    const inactive = { exitCode: 3, output: "inactive" };
    const failed = { exitCode: 3, output: "failed" };
    expect(comparedWithBaseline({ id: "c", now: failed, baseline: inactive, before: false, passes })).toBeUndefined();
    expect(comparedWithBaseline({ id: "c", now: { ...inactive }, baseline: inactive, before: false, passes })).toBe("exact");
    // Another exit code is another state, whatever the text.
    expect(comparedWithBaseline({ id: "c", now: { exitCode: 4, output: "inactive" }, baseline: inactive, before: false, passes })).toBeUndefined();
  });

  it("compares the same way from the hashes kept with a change, for a rollback made later", () => {
    const kept = { exactHash: observationHash("c", before), stableHash: stableObservationHash("c", before) };
    const restarted = { exitCode: 0, output: status("active (running)", "11:30:00", "1s", 555) };
    expect(comparedWithBaseline({ id: "c", now: { ...before }, ...kept, before: true, passes })).toBe("exact");
    expect(comparedWithBaseline({ id: "c", now: restarted, ...kept, before: true, passes })).toBe("stable");
    // A change kept by an older version has only the exact hash: the card's expected text still decides.
    expect(comparedWithBaseline({ id: "c", now: restarted, exactHash: kept.exactHash, before: true, passes })).toBe("expected");
    expect(comparedWithBaseline({ id: "c", now: { exitCode: 3, output: "inactive" }, exactHash: kept.exactHash, before: false, passes })).toBeUndefined();
  });
});

describe("a change that is taken back, with a check whose output holds a time and a process id", () => {
  const task = (): AgentTask => ({
    id: "a",
    title: "change",
    mode: "autonomous",
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

  async function setup() {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());
    terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (n) queueMicrotask(() => terminals.feed("one", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
    });
    await terminals.arm("one", "bash");
    const t = task();
    t.target = { sessionId: "one", generation: terminals.get("one")!.generation, label: "host" };
    terminals.claim("one", t.target.generation, t.id);
    const broker = new ToolBroker(terminals, { context: async () => ({}), memory: async () => [], file: async () => ({}), changed: vi.fn() });
    broker.wait = async () => undefined;
    disposals.unshift(() => broker.dispose());
    const capability = await broker.issue(t);
    const run = vi.spyOn(terminals, "execute");
    const answer = (output: string, exitCode = 0) => run.mockResolvedValueOnce({ exitCode, output } as never);
    return { broker, t, capability, answer };
  }

  const reload = {
    action: "change" as const,
    command: "cp nginx.new /etc/nginx/nginx.conf && systemctl restart nginx",
    check: { command: "systemctl status nginx --no-pager", expected: "active (running)" },
    rollback: "cp nginx.bak /etc/nginx/nginx.conf && systemctl restart nginx",
  };

  it("counts as taken back when the service runs again under another process id, at another time, and says how that was seen", async () => {
    const { broker, t, capability, answer } = await setup();
    answer(status("active (running)", "10:00:00", "3 days", 1234)); // before the change
    answer(""); // the change
    answer(status("failed (Result: exit-code)", "10:05:00", "1s", 2000), 3); // the check afterwards
    answer(status("failed (Result: exit-code)", "10:05:00", "4s", 2000), 3); // and once more after it had time to settle
    answer(""); // the rollback
    answer(status("active (running)", "10:05:09", "1s", 2100)); // the check after the rollback
    const res = (await broker.invoke(capability.key, reload)) as Record<string, unknown>;
    expect(res).toMatchObject({ checkPassed: false, rolledBack: true, backAsBefore: true, comparedBy: COMPARISON_TEXT.stable });
    expect(t.changes[0].status).toBe("failed");
    expect(t.changes[0].rollback).toMatchObject({ ran: true, restored: true, comparedWithBaseline: true, comparison: "stable" });
    expect(t.changes[0].check?.baselineStableHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still says so when the service is not back: the same words do not make a failed unit a running one", async () => {
    const { broker, t, capability, answer } = await setup();
    answer(status("active (running)", "10:00:00", "3 days", 1234));
    answer("");
    answer(status("failed (Result: exit-code)", "10:05:00", "1s", 2000), 3);
    answer(status("failed (Result: exit-code)", "10:05:00", "4s", 2000), 3);
    answer("");
    answer(status("failed (Result: exit-code)", "10:05:09", "1s", 2100), 3);
    const res = (await broker.invoke(capability.key, reload)) as Record<string, unknown>;
    expect(res).toMatchObject({ rolledBack: false, backAsBefore: false });
    expect(String(res.comparedBy)).toMatch(/does not read as it did before the change/);
    expect(t.changes[0].status).toBe("uncertain");
    expect(t.changes[0].rollback).toMatchObject({ ran: true, restored: false });
    expect(t.changes[0].rollback?.comparison).toBeUndefined();
  });
});
