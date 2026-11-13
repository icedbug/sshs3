import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callMcpTool } from "../../src/main/web/mcp/mcpTools";
import type { HubRequest } from "../../src/shared/types/aiHub";

/**
 * What the audit log and the recordings end up holding when an agent runs a
 * command for real through the broker: who asked, who allowed it, what ran,
 * how it ended, and what the terminal showed.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

const SERVERS = [{ id: "srv-db01", name: "db01", host: "db01.internal", port: 22, username: "ops" }];

async function hubWithTerminal() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-audit-hub-"));
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
  hub.terminals.register({ id: "sess-db01", label: "db01", kind: "ssh", profileId: "srv-db01" }, (data: string) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n)
      queueMicrotask(() =>
        hub.terminals.feed(
          "sess-db01",
          `\x1b]777;SSHS3;${n};BEGIN\x07quota 2T  token=s3cr3tvalue123\r\n\x1b]777;SSHS3;${n};END;0;/root\x07`,
        ),
      );
  });
  await hub.terminals.arm("sess-db01", "bash");
  return { hub, dir };
}

describe("after a command has run", () => {
  it("is in the audit log with who allowed it, and the chain holds", async () => {
    const { hub } = await hubWithTerminal();
    const ctx = {
      request: (r: HubRequest) => hub.request(r),
      runCommand: (input: Parameters<typeof hub.runForMcp>[0]) => hub.runForMcp({ ...input, by: "Jacob" }),
      commandStatus: (id: string) => hub.mcpCommandStatus(id),
      scopes: ["read", "run"],
      serverId: "srv-db01",
      actor: "Jacob",
    };
    const asked = (await callMcpTool("run_command", { command: "zfs get quota tank/data", why: "check the quota" }, ctx as never)) as { id: string };
    const task = hub.store.data.tasks.find((t) => t.changes.some((c) => c.id === asked.id))!;
    // A person answers through the app, as they would from the inbox.
    await hub.request({ action: "approve", taskId: task.id, changeId: asked.id, approved: true } as never);
    await vi.waitFor(() => expect(task.changes[0].status).toBe("completed"));

    await vi.waitFor(async () => {
      const audit = (await hub.request({ action: "audit-read" } as never)).reply!.audit!;
      expect(audit.entries.length).toBeGreaterThan(0);
    });
    const audit = (await hub.request({ action: "audit-read" } as never)).reply!.audit!;
    const entry = audit.entries.find((e) => e.changeId === asked.id)!;
    expect(entry).toMatchObject({
      kind: "mcp",
      target: "db01",
      what: "zfs get quota tank/data",
      outcome: "completed",
      exitCode: 0,
      taskId: task.id,
    });
    expect(entry.approvedBy).toMatch(/\(allowed\)$/);
    expect(entry.actor).toContain("from outside");
    expect(audit.verification).toMatchObject({ ok: true });
    // Logged once, not on every later change of anything.
    hub.changed();
    hub.changed();
    await new Promise((r) => setTimeout(r, 50));
    const again = (await hub.request({ action: "audit-read" } as never)).reply!.audit!;
    expect(again.entries.filter((e) => e.changeId === asked.id)).toHaveLength(1);
  });

  it("records what the terminal showed while the run owned it, masked, with the command marked", async () => {
    const { hub } = await hubWithTerminal();
    const ctx = {
      request: (r: HubRequest) => hub.request(r),
      runCommand: (input: Parameters<typeof hub.runForMcp>[0]) => hub.runForMcp({ ...input, by: "Jacob" }),
      commandStatus: (id: string) => hub.mcpCommandStatus(id),
      scopes: ["read", "run"],
      serverId: "srv-db01",
      actor: "Jacob",
    };
    const asked = (await callMcpTool("run_command", { command: "zfs get quota tank/data", why: "check" }, ctx as never)) as { id: string };
    const task = hub.store.data.tasks.find((t) => t.changes.some((c) => c.id === asked.id))!;
    await hub.request({ action: "approve", taskId: task.id, changeId: asked.id, approved: true } as never);
    await vi.waitFor(() => expect(task.status).not.toBe("running"));
    await vi.waitFor(() => expect(task.recordingId).toBeTruthy());
    // The run released the terminal, so the recording is complete.
    await vi.waitFor(async () => {
      const cast = (await hub.request({ action: "recording-read", id: task.recordingId! } as never)).reply!.recording!.cast;
      expect(cast).toContain("quota 2T");
    });
    const cast = (await hub.request({ action: "recording-read", id: task.recordingId! } as never)).reply!.recording!.cast;
    const [header, ...events] = cast.trim().split("\n").map((l) => JSON.parse(l) as unknown);
    expect(header).toMatchObject({ version: 2 });
    expect(events.some((e) => Array.isArray(e) && e[1] === "m" && e[2] === "zfs get quota tank/data")).toBe(true);
    // The secret the program printed is not in the recording.
    expect(cast).not.toContain("s3cr3tvalue123");
  });

  it("hands the whole log over as a file, with what its check found", async () => {
    const { hub } = await hubWithTerminal();
    await hub.audit().append({ kind: "setting", actor: "Jacob", target: "sshs3", what: "Changed the safety policy" });
    const file = (await hub.request({ action: "audit-export" } as never)).reply!.download!;
    expect(file.name).toMatch(/^sshs3-audit-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const lines = Buffer.from(file.dataBase64, "base64").toString("utf8").trim().split("\n");
    expect(JSON.parse(lines[0])).toMatchObject({ seq: 1, what: "Changed the safety policy" });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ verification: { ok: true, entries: 1 } });
  });
});
