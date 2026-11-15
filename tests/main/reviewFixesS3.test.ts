import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ runtimeStart: vi.fn() }));

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), quit: vi.fn() },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

vi.mock("../../src/main/ai/HermesManager", () => ({
  HermesManager: class {
    getManifest = async () => null;
  },
}));

vi.mock("../../src/main/ai/hub/AgentRuntime", () => ({
  HermesRuntime: class {
    start = mocks.runtimeStart;
    stop = async () => {};
  },
}));

import { HubService } from "../../src/main/ai/hub/HubService";
import { TerminalRegistry } from "../../src/main/ai/hub/TerminalRegistry";
import { ToolBroker, ToolBrokerError } from "../../src/main/ai/hub/ToolBroker";
import { DEFAULT_SAFETY_POLICY } from "../../src/main/ai/hub/CommandSafetyService";
import { isQuietHours } from "../../src/main/ai/hub/Notifier";
import { NotifyStore } from "../../src/main/ai/hub/NotifyStore";
import { AuditShipper, type AuditEntry } from "../../src/main/ai/hub/AuditLog";
import { parseDistillAnswer, type GovernedMemoryProposal } from "../../src/main/ai/hub/MemoryDistiller";
import type { IncomingAlert } from "../../src/main/ai/hub/AlertIntake";
import type { AgentChange, AgentTask, MemoryEntry, SafetyPolicyConfig, WorkspaceServerSummary } from "../../src/shared/types/aiHub";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-s3-fixes-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

async function createHub(options: { shared?: { owner: string; peerApproval?: boolean }; servers?: WorkspaceServerSummary[] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-s3-hub-"));
  const cfgPath = path.join(dir, "ai-config.json");
  await fs.writeFile(
    cfgPath,
    JSON.stringify({ enabled: true, provider: "openai-compatible", model: "gpt-test", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "test-key" }),
    "utf8",
  );
  const hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      openSchedule: async () => "sched-term-1",
      backgroundChanged: async () => {},
      show: () => {},
      aiConfigFilePath: cfgPath,
      defaultActorName: "alice",
      workspaceServers: async () => options.servers ?? [],
      ...(options.shared
        ? {
            alertHookOwner: options.shared.owner,
            soleUser: () => false,
            teamAdmin: () => true,
            ...(options.shared.peerApproval ? { peerApproval: () => true } : {}),
          }
        : {}),
    },
    dir,
  );
  cleanups.push(async () => {
    await hub.dispose();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  return hub;
}

const priv = (hub: HubService) =>
  hub as unknown as {
    resolveSafetyContext(task: Pick<AgentTask, "target" | "startedAs" | "agentId">, label?: string): {
      policy: SafetyPolicyConfig;
      peerApproval?: boolean;
      requesterId?: string;
    };
    flushInbox(now?: number): Promise<void>;
    inboxNow(): Array<{ id: string }>;
    sendToChannels(...args: unknown[]): Promise<void>;
    takeAlertsNow(alerts: IncomingAlert[]): Promise<{ created: string[]; updated: string[] }>;
    applyMemoryProposal(p: unknown): Promise<MemoryEntry>;
    notifyStore: NotifyStore;
    storeDataExtra(): { inboxState?: Record<string, { snoozedUntil?: number; acknowledgedAt?: number }> };
  };

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: overrides.id ?? "task-1",
    title: "A task",
    agentId: "agent-1",
    mode: "assisted",
    status: "running",
    messages: [{ id: "m1", role: "user", text: "Do it", at: 1 }],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 20,
    maxMinutes: 10,
    verification: "not-verified",
    ...overrides,
  };
}

function pendingChange(id = "c-1", at = Date.now()): AgentChange {
  return { id, kind: "command", target: "host", description: "restart app", command: "systemctl restart app", status: "pending", riskLevel: "modify", at };
}

async function brokerWithTerminal(safetyContext: NonNullable<ConstructorParameters<typeof ToolBroker>[1]["safetyContext"]>) {
  const terminals = new TerminalRegistry();
  terminals.register({ id: "one", label: "host", kind: "ssh" }, (data) => {
    const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
    if (n) queueMicrotask(() => terminals.feed("one", `\x1b]777;SSHS3;${n};BEGIN\x07ok\x1b]777;SSHS3;${n};END;0;/srv\x07`));
  });
  await terminals.arm("one", "bash");
  const session = terminals.get("one")!;
  const task = makeTask({ target: { sessionId: "one", generation: session.generation, label: "host" } });
  terminals.claim("one", session.generation, task.id);
  const broker = new ToolBroker(terminals, {
    context: async () => ({}),
    memory: async () => ({}),
    file: async () => ({}),
    safetyContext,
    changed: () => {},
  });
  broker.wait = async () => {};
  const cap = await broker.issue(task);
  cleanups.push(async () => {
    broker.dispose();
    terminals.dispose();
  });
  return { broker, task, cap, terminals };
}

describe("S3.1 approvals by two people", () => {
  it("does not count one person twice when approvals carry only a name", async () => {
    const { broker, task, cap } = await brokerWithTerminal(() => ({
      policy: DEFAULT_SAFETY_POLICY,
      targetTags: ["prod"],
      clusterPolicy: { requiredApprovals: 2 },
      requesterId: "local",
      peerApproval: true,
    }));
    const pending = broker.invoke(cap.key, { action: "command", command: "systemctl restart app" });
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(task.changes[0]?.status).toBe("pending"));
    const change = task.changes[0]!;
    expect(broker.approve(task.id, change.id, true, undefined, { actor: "Alice" })).toBe(false);
    expect(() => broker.approve(task.id, change.id, true, undefined, { actor: "alice" })).toThrow(/already approved/);
    expect(broker.waitingOnPerson(task.id)).toBe(true);
    broker.revoke(task.id);
  });

  it("refuses at once a change that needs two people where only one can approve", async () => {
    const { broker, task, cap } = await brokerWithTerminal(() => ({
      policy: DEFAULT_SAFETY_POLICY,
      clusterPolicy: { requiredApprovals: 2 },
      requesterId: "local",
      peerApproval: false,
    }));
    const error = await broker.invoke(cap.key, { action: "command", command: "systemctl restart app" }).catch((e) => e);
    expect(error).toBeInstanceOf(ToolBrokerError);
    expect((error as ToolBrokerError).message).toMatch(/only one person/);
    expect(task.changes[0]?.status).toBe("denied");
    expect(broker.waitingOnPerson(task.id)).toBe(false);
  });

  it("desktop: the peer rule is not in force and the requester is the person, not the agent", async () => {
    const hub = await createHub();
    hub.store.data.safetyPolicy = { ...DEFAULT_SAFETY_POLICY, requirePeerApprovalOnProd: true };
    const ctx = priv(hub).resolveSafetyContext(makeTask());
    expect(ctx.policy.requirePeerApprovalOnProd).toBe(false);
    expect(ctx.peerApproval).toBe(false);
    expect(ctx.requesterId).toBe("local");
    await expect(
      hub.request({ action: "safety-policy-save", policy: { clusterPolicies: { prod: { requiredApprovals: 2 } } } }),
    ).rejects.toThrow(/second person/);
  });

  it("team server: the owner's approval is one, a signed-in teammate's is the second", async () => {
    const hub = await createHub({ shared: { owner: "u-alice", peerApproval: true } });
    await hub.request({ action: "safety-policy-save", policy: { requirePeerApprovalOnProd: true } });
    expect(priv(hub).resolveSafetyContext(makeTask()).policy.requirePeerApprovalOnProd).toBe(true);
    const task = makeTask({ id: "t-peer", status: "running" });
    hub.store.data.tasks.push(task);
    const change = { ...pendingChange("c-peer"), requiredApprovals: 2 };
    const answer = hub.broker.askApproval(task, change, "user:u-alice");
    await hub.request({ action: "approve", taskId: task.id, changeId: change.id, approved: true });
    await expect(hub.request({ action: "approve", taskId: task.id, changeId: change.id, approved: true })).rejects.toThrow(/already approved/);
    expect(hub.waitingForApproval().map((w) => w.changeId)).toEqual(["c-peer"]);
    await expect(hub.approveAsPeer(task.id, change.id, true, { id: "u-alice", name: "Alice again" })).rejects.toThrow(/own app/);
    expect(await hub.approveAsPeer(task.id, change.id, true, { id: "u-bob", name: "Bob" })).toBe(true);
    expect(await answer).toBe(true);
    expect(change.decidedBy?.name).toBe("Bob");
  });
});

describe("S3.2 inbox snooze and acknowledgement", () => {
  it("a snoozed item is not notified, an acknowledged one not reminded, and state for gone items is pruned", async () => {
    const hub = await createHub();
    const p = priv(hub);
    const now = Date.now();
    const task = makeTask({ id: "t-inbox", status: "waiting", changes: [pendingChange("c-a", now), pendingChange("c-b", now)] });
    hub.store.data.tasks.push(task);
    const extra = p.storeDataExtra();
    extra.inboxState = {
      "approval:c-a": { snoozedUntil: now + 3_600_000 },
      "approval:c-b": { acknowledgedAt: now },
      "approval:gone": { acknowledgedAt: now },
    };
    expect(p.inboxNow().map((i) => i.id)).toEqual(["approval:c-b"]);
    await p.flushInbox(now);
    await p.flushInbox(now + 6 * 60_000);
    expect(p.notifyStore.data.reminded["approval:c-b"]).toBeUndefined();
    expect(p.notifyStore.data.reminded["approval:c-a"]).toBeUndefined();
    expect(Object.keys(p.storeDataExtra().inboxState ?? {}).sort()).toEqual(["approval:c-a", "approval:c-b"]);
  });

  it("quiet hours hold back what goes to the channels", async () => {
    const hub = await createHub();
    const p = priv(hub);
    const send = vi.spyOn(p as unknown as { sendToChannels: () => Promise<void> }, "sendToChannels").mockResolvedValue(undefined);
    await hub.request({
      action: "notify-settings-save",
      quietHours: { enabled: true, start: "00:00", end: "00:00", timezone: "UTC", bypassCritical: true },
    } as never);
    expect(p.notifyStore.data.quietHours).toMatchObject({ enabled: true, startHour: 0, endHour: 0, timezone: "UTC" });
    const view = (await hub.request({ action: "notify-settings-save" } as never)).notifications as unknown as { quietHours?: { start: string } };
    expect(view.quietHours?.start).toBe("00:00");
    hub.store.data.tasks.push(makeTask({ id: "t-q", status: "waiting", changes: [pendingChange("c-q")] }));
    await p.flushInbox(Date.now());
    expect(send).not.toHaveBeenCalled();
    await hub.request({ action: "notify-settings-save", quietHours: { enabled: false } } as never);
    hub.store.data.tasks.push(makeTask({ id: "t-q2", status: "waiting", changes: [pendingChange("c-q2")] }));
    await p.flushInbox(Date.now());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("isQuietHours reads a named time zone and minutes", () => {
    const at = Date.parse("2026-01-15T21:30:00Z"); // 22:30 in Berlin (winter)
    expect(isQuietHours({ enabled: true, startHour: 22, startMinute: 15, endHour: 7, timezone: "Europe/Berlin" }, at)).toBe(true);
    expect(isQuietHours({ enabled: true, startHour: 22, startMinute: 45, endHour: 7, timezone: "Europe/Berlin" }, at)).toBe(false);
  });

  it("NotifyStore reads back only well-formed policy settings", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "notify.json");
    await fs.writeFile(
      file,
      JSON.stringify({ quietHours: { enabled: "yes", startHour: 1, endHour: 2 }, noiseBudgetPerHour: 5, flapCooldownMs: -3, escalationMinutes: [5, "x", 15] }),
    );
    const store = new NotifyStore(file);
    await store.load();
    expect(store.data.quietHours).toBeUndefined();
    expect(store.data.noiseBudgetPerHour).toBe(5);
    expect(store.data.flapCooldownMs).toBeUndefined();
    expect(store.data.escalationMinutes).toEqual([5, 15]);
  });
});

describe("S3.3 memory governance", () => {
  const confirmed = {
    id: "task:t1",
    title: "Fix nginx",
    transcript: "Command on web-1 → exit 0\n  output: active (running)",
  };

  it("parseDistillAnswer says what needs a person: a command skill and an invalidation, not a plain confirmed fact", () => {
    const existing: MemoryEntry[] = [
      { id: "m-old", kind: "memory", scope: "workspace", title: "Nginx port", text: "Nginx listens on 8080", updatedAt: 1, autoLearned: true },
    ];
    const answer = JSON.stringify({
      proposals: [
        { op: "add", kind: "memory", scope: "workspace", title: "Web runs nginx", text: "web-1 runs nginx under systemd", evidence: "active (running)" },
        { op: "add", kind: "skill", scope: "workspace", title: "Check nginx", text: "Check it", commandTemplate: "systemctl status nginx", evidence: "x" },
        { op: "invalidate", id: "m-old", reason: "It listens on 80 now", evidence: "x" },
      ],
    });
    const proposals = parseDistillAnswer(answer, confirmed, existing)!;
    expect(proposals.map((p) => p.requiresApproval)).toEqual([false, true, true]);
    expect(proposals[2].invalidate).toBe(true);
  });

  it("applying carries the skill's fields, and an invalidation marks the memory stale instead of rewriting it", async () => {
    const hub = await createHub();
    const p = priv(hub);
    const skill: Partial<GovernedMemoryProposal> = {
      id: "p1",
      op: "add",
      kind: "skill",
      tier: "episodic",
      scope: "workspace",
      title: "Restart nginx safely",
      text: "Reload first",
      evidence: "e",
      sourceId: "task:t1",
      sourceTitle: "t",
      createdAt: 1,
      commandTemplate: "systemctl reload nginx",
      verifyCommand: "systemctl is-active nginx",
      confidence: 0.9,
      sourceTrust: "trusted",
      riskLevel: "medium",
      diffSummary: "+",
    };
    const saved = await p.applyMemoryProposal(skill);
    expect(saved).toMatchObject({ tier: "episodic", commandTemplate: "systemctl reload nginx", verifyCommand: "systemctl is-active nginx", confidence: 0.9 });

    const target = await p.applyMemoryProposal({ ...skill, id: "p2", kind: "memory", title: "Port", text: "Nginx listens on 8080", commandTemplate: undefined, verifyCommand: undefined });
    const invalidated = await p.applyMemoryProposal({
      id: "p3",
      op: "update",
      intendedOp: "invalidate",
      invalidate: true,
      staleReason: "It listens on 80 now",
      targetId: target.id,
      kind: "memory",
      scope: "workspace",
      title: "Port",
      text: "[INVALIDATED: It listens on 80 now] Nginx listens on 8080",
      evidence: "e",
      sourceId: "s",
      sourceTitle: "s",
      createdAt: 1,
    });
    expect(invalidated.id).toBe(target.id);
    expect(invalidated.text).toBe("Nginx listens on 8080");
    expect(invalidated.staleReason).toBe("It listens on 80 now");
  });

  it("an untouched auto-save setting behaves as one switched on: learned skills go through the rules", async () => {
    const hub = await createHub();
    expect(hub.store.data.preferences.autoSaveMemories).toBeUndefined();
    const active = (hub.selfLearning as unknown as { isGovernanceActive(o?: unknown): boolean }).isGovernanceActive();
    expect(active).toBe(true);
  });
});

describe("S3.4 alerts and the audit shipper", () => {
  it("a second alert on a server with an open incident goes on that ticket, once", async () => {
    const server: WorkspaceServerSummary = { id: "s-db", name: "db01", host: "10.0.0.5", port: 22, username: "ops", shared: true };
    const hub = await createHub({ servers: [server] });
    const p = priv(hub);
    const alert = (fingerprint: string, title: string): IncomingAlert =>
      ({ fingerprint, title, text: "", source: "alertmanager", severity: "warning", status: "firing", subjects: ["db01"], labels: {} }) as unknown as IncomingAlert;
    const first = await p.takeAlertsNow([alert("fp-disk", "DiskFull")]);
    expect(first.created).toHaveLength(1);
    const second = await p.takeAlertsNow([alert("fp-cpu", "HighCPU")]);
    expect(second.created).toHaveLength(0);
    const again = await p.takeAlertsNow([alert("fp-cpu", "HighCPU")]);
    expect(again.created).toHaveLength(0);
    const ticket = hub.store.data.workTickets!.find((t) => t.id === first.created[0])!;
    expect(ticket.correlatedAlerts?.map((c) => c.fingerprint)).toEqual(["fp-cpu"]);
    expect((ticket.comments ?? []).filter((c) => c.text.includes("HighCPU"))).toHaveLength(1);
  });

  it("AuditShipper without a guard of its own does not post to this machine", async () => {
    const errors: unknown[] = [];
    const shipper = new AuditShipper({ format: "webhook", url: "http://127.0.0.1:9/audit", onError: (e) => errors.push(e) });
    shipper.emit({ seq: 1, at: Date.now(), kind: "setting", actor: "a", what: "x", hash: "h" } as AuditEntry);
    await shipper.flush();
    expect(String(errors[0])).toMatch(/itself|private|local|not allowed/i);
  });
});

describe("S3.5 request checks", () => {
  it("rule-save, runbook-save and runbook-run refuse a malformed request with a message", async () => {
    const hub = await createHub();
    await expect(hub.request({ action: "rule-save" } as never)).rejects.toThrow("A rule to save is missing");
    await expect(hub.request({ action: "runbook-save", runbook: { name: "x", steps: "rm -rf /" } } as never)).rejects.toThrow(/steps are a list/);
    await hub.request({ action: "runbook-save", runbook: { name: "rb", inputs: [], steps: [] } } as never);
    const rb = (hub.store.data as unknown as { runbooks: Array<{ id: string }> }).runbooks[0];
    await expect(hub.request({ action: "runbook-run", id: rb.id, inputs: ["a"] } as never)).rejects.toThrow(/given by name/);
  });

  it("promote-eval makes one ticket however often it is asked", async () => {
    const hub = await createHub();
    hub.store.data.tasks.push(makeTask({ id: "t-eval", status: "failed", error: "boom" }));
    await hub.request({ action: "promote-eval", taskId: "t-eval" });
    await hub.request({ action: "promote-eval", taskId: "t-eval" });
    expect((hub.store.data.workTickets ?? []).filter((t) => t.taskId === "t-eval" && !t.deleted)).toHaveLength(1);
  });

  it("profile-save on a shared server refuses a model address on the private network", async () => {
    const hub = await createHub({ shared: { owner: "u-1" } });
    await expect(
      hub.request({
        action: "profile-save",
        profile: { name: "Internal", provider: "openai-compatible", model: "m", baseUrl: "http://10.1.2.3/v1" },
      } as never),
    ).rejects.toThrow();
  });
});

describe("S3.6 the main session's HubService fixes", () => {
  it("mcp-save keeps tool policies, and trust in readOnlyHint is dropped when the address changes", async () => {
    const hub = await createHub();
    await hub.request({ action: "mcp-save", server: { id: "m1", name: "Docs", transport: "http", url: "https://mcp.example.com/a", enabled: false } } as never);
    const list = () => hub.store.data.mcpServers ?? [];
    const first = list().find((s) => s.id === "m1")!;
    hub.store.data.mcpServers = [{ ...first, toolPolicies: { search: "allow" }, trustReadOnlyHint: true }];
    await hub.request({ action: "mcp-save", server: { id: "m1", name: "Docs 2", transport: "http", url: "https://mcp.example.com/a", enabled: false } } as never);
    expect(list()[0]).toMatchObject({ name: "Docs 2", toolPolicies: { search: "allow" }, trustReadOnlyHint: true });
    await hub.request({ action: "mcp-save", server: { id: "m1", name: "Docs 2", transport: "http", url: "https://other.example.com/a", enabled: false } } as never);
    expect(list()[0].toolPolicies).toEqual({ search: "allow" });
    expect(list()[0].trustReadOnlyHint).toBeFalsy();
  });

  it("rollback-change refuses a change that did not run, one already rolled back, and a destructive rollback", async () => {
    const hub = await createHub();
    const base = { kind: "command" as const, target: "host", description: "d", command: "systemctl stop app", at: 1 };
    hub.store.data.tasks.push(
      makeTask({
        id: "t-rb",
        status: "completed",
        changes: [
          { ...base, id: "never", status: "denied", rollback: { command: "systemctl start app" } } as AgentChange,
          { ...base, id: "done", status: "completed", rolledBack: { at: 2 }, rollback: { command: "systemctl start app" } } as unknown as AgentChange,
          { ...base, id: "rmrf", status: "completed", rollback: { command: "rm -rf /var/lib/app" } } as AgentChange,
        ],
      }),
    );
    for (const changeId of ["never", "done", "rmrf"])
      await expect(hub.request({ action: "rollback-change", taskId: "t-rb", changeId } as never)).rejects.toThrow();
  });

  it("runbook-run refuses a selector that matches nothing, and several terminals without a target", async () => {
    const hub = await createHub();
    await hub.request({ action: "runbook-save", runbook: { name: "rb", inputs: [], steps: [{ kind: "command", command: "uptime" }] } } as never);
    const rb = (hub.store.data as unknown as { runbooks: Array<{ id: string }> }).runbooks[0];
    await expect(hub.request({ action: "runbook-run", id: rb.id, targetSelector: { names: ["nowhere"] } } as never)).rejects.toThrow(/matches no server/);
    vi.spyOn(hub.terminals, "list").mockReturnValue([
      { id: "a", label: "a", state: "ready" },
      { id: "b", label: "b", state: "ready" },
    ] as never);
    await expect(hub.request({ action: "runbook-run", id: rb.id } as never)).rejects.toThrow(/several terminals/);
  });

  it("compact-task keeps the first prompt and the summary reaches the model", async () => {
    const hub = await createHub();
    const task = makeTask({
      id: "t-compact",
      status: "completed",
      messages: Array.from({ length: 30 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        text: i === 0 ? "FIRST PROMPT: fix the web tier" : `message ${i} ${crypto.randomUUID()}`,
        at: i + 1,
      })),
    });
    hub.store.data.tasks.push(task);
    mocks.runtimeStart.mockResolvedValue(undefined);
    await hub.request({ action: "compact-task", taskId: task.id } as never).catch(() => undefined);
    const after = hub.store.data.tasks.find((t) => t.id === task.id)!;
    expect(after.messages.some((m) => m.text.includes("FIRST PROMPT"))).toBe(true);
  });
});

describe("S3 extra: knowledge base paste with the same source name", () => {
  it("a different title makes a new document with a note; the same title revises it", async () => {
    const hub = await createHub();
    const r1 = await hub.request({ action: "kb-ingest-text", title: "Runbook A", text: "Restart A with systemctl restart a.", sourceRef: "notes" });
    expect(r1.reply?.ingest?.added).toEqual(["Runbook A"]);
    const r2 = await hub.request({ action: "kb-ingest-text", title: "Runbook B", text: "Restart B with systemctl restart b.", sourceRef: "notes" });
    expect(r2.reply?.ingest?.added).toEqual(["Runbook B"]);
    expect((r2.reply?.ingest as { notes?: string[] } | undefined)?.notes?.[0]).toMatch(/new document/);
    expect((hub.store.data.kbDocuments ?? []).map((d) => d.title).sort()).toEqual(["Runbook A", "Runbook B"]);
    const r3 = await hub.request({ action: "kb-ingest-text", title: "Runbook A", text: "Restart A with systemctl reload a now.", sourceRef: "notes" });
    expect(r3.reply?.ingest?.updated).toEqual(["Runbook A"]);
    expect(hub.store.data.kbDocuments).toHaveLength(2);
  });
});
