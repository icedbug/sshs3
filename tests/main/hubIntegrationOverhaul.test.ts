import { observationHash } from "../../src/main/ai/hub/privacy";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  runtimeStart: vi.fn(),
  acpCtors: [] as Array<{ runner: unknown; options: Record<string, unknown> }>,
  acpStart: vi.fn(),
  acpStop: vi.fn(),
  execOnServer: vi.fn(),
  restoreCheckpoint: vi.fn(),
  aiConfigEnabled: true,
}));

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

vi.mock("../../src/main/ai/hub/AcpRuntime", async () => {
  const actual = await vi.importActual<typeof import("../../src/main/ai/hub/AcpRuntime")>(
    "../../src/main/ai/hub/AcpRuntime",
  );
  return {
    ...actual,
    AcpRuntime: class {
      constructor(runner: unknown, options: Record<string, unknown>) {
        mocks.acpCtors.push({ runner, options });
      }
      start = mocks.acpStart;
      stop = mocks.acpStop;
    },
  };
});

import { HubService, incomingAgentForTesting } from "../../src/main/ai/hub/HubService";
import { createMultiSSHApi, HUB_DELTA_CHANNEL, type AiHubDeltaEvent } from "../../src/shared/ipc/createMultiSSHApi";
import { applyAiHubDelta } from "../../src/renderer/src/lib/aiHub";
import type { AuditEntry } from "../../src/main/ai/hub/AuditLog";
import type { AgentTask, HubSnapshot, MissionAgent, WorkspaceServerSummary } from "../../src/shared/types/aiHub";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  mocks.acpCtors.length = 0;
  mocks.aiConfigEnabled = true;
  vi.clearAllMocks();
});

async function createTestHub(options: {
  actorName?: string;
  teamAdmin?: () => boolean;
  alertHookOwner?: string;
  servers?: WorkspaceServerSummary[];
  onDelta?: (d: AiHubDeltaEvent) => void;
  auditShipperSend?: (payload: { format: string; body: string; entry: AuditEntry }) => Promise<void>;
} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-overhaul-"));
  const cfgPath = path.join(dir, "ai-config.json");
  await fs.writeFile(
    cfgPath,
    JSON.stringify({
      enabled: mocks.aiConfigEnabled,
      provider: "openai-compatible",
      model: "gpt-test",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "test-key",
    }),
    "utf8",
  );
  const deltaEvents: AiHubDeltaEvent[] = [];
  const servers = options.servers ?? [];
  let actor = options.actorName ?? "alice";
  const hub = new HubService(
    {
      changed: () => {},
      delta: (d) => {
        deltaEvents.push(d);
        options.onDelta?.(d);
      },
      inventoryTargets: async () => [],
      openSchedule: async () => "sched-term-1",
      backgroundChanged: async () => {},
      show: () => {},
      aiConfigFilePath: cfgPath,
      defaultActorName: actor,
      ...(options.teamAdmin ? { teamAdmin: options.teamAdmin } : {}),
      ...(options.alertHookOwner ? { alertHookOwner: options.alertHookOwner } : {}),
      workspaceServers: async () => servers,
      execOnServer: mocks.execOnServer,
      restoreCheckpoint: mocks.restoreCheckpoint,
      ...(options.auditShipperSend
        ? {
            auditShipper: {
              format: "webhook",
              send: options.auditShipperSend,
            },
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
  return {
    hub,
    dir,
    deltaEvents,
    setActor: (next: string) => {
      actor = next;
      (hub as unknown as { host: { defaultActorName: string } }).host.defaultActorName = next;
    },
  };
}

function registerReadyTerminal(
  hub: HubService,
  id: string,
  label: string,
  profileId?: string,
  writes: string[] = [],
) {
  hub.terminals.register(
    {
      id,
      kind: "ssh",
      label,
      profileId,
    },
    (data: string) => {
      writes.push(data);
    },
  );
  // Put terminal at prompt synchronously by setting state ready via handshake feed or arming
  const session = hub.terminals.get(id)!;
  const internal = (hub.terminals as unknown as { sessions: Map<string, { view: { shell?: string; state: string; cwd?: string } }> }).sessions.get(id)!;
  internal.view.shell = "bash";
  internal.view.state = "ready";
  internal.view.cwd = "/srv/app";
  return session;
}

describe("Wave 2 Hub integration overhaul", () => {
  it("supports AgentMode 'plan' across start, schedule-save, agent-save, and incomingAgent", async () => {
    const { hub } = await createTestHub();
    mocks.runtimeStart.mockImplementation(async (_task, _model, onEvent) => {
      onEvent({ type: "run.completed", output: "Plan proposed." });
    });

    const startSnap = await hub.request({
      action: "start",
      task: { prompt: "Plan a safe nginx reload", mode: "plan", maxCommands: 3, maxMinutes: 5 },
    });
    expect(startSnap.tasks.at(-1)?.mode).toBe("plan");

    const schedSnap = await hub.request({
      action: "schedule-save",
      schedule: {
        title: "Nightly plan check",
        prompt: "Check certificates",
        profileId: "srv-1",
        model: "gpt-test",
        provider: "openai-compatible",
        shell: "bash",
        mode: "plan",
        intervalMinutes: 60,
        maxCommands: 5,
        maxMinutes: 10,
        enabled: true,
        nextRunAt: Date.now() + 60_000,
      },
    });
    expect(schedSnap.schedules[0]?.mode).toBe("plan");

    const agentSnap = await hub.request({
      action: "agent-save",
      agent: {
        id: "planner-1",
        name: "Planner Agent",
        role: "Planner",
        icon: "",
        mission: "Design safe rollout plans",
        systemPrompt: "Propose before changing",
        defaultMode: "plan",
        allowedTools: ["all"],
      },
    });
    expect(agentSnap.agents?.find((a) => a.id === "planner-1")?.defaultMode).toBe("plan");

    const incoming = incomingAgentForTesting(
      {
        id: "r1",
        name: "Remote",
        role: "Ops",
        icon: "",
        mission: "Ops",
        systemPrompt: "Plan safely",
        defaultMode: "plan",
        updatedAt: Date.now(),
      },
      undefined,
    );
    expect(incoming.defaultMode).toBe("plan");
  });

  it("handles all 16 new HubRequest actions end-to-end and exposes snapshot fields", async () => {
    const prodServer: WorkspaceServerSummary = {
      id: "srv-prod-1",
      name: "prod-web-01",
      host: "10.0.1.10",
      port: 22,
      username: "ops",
      cluster: "prod-eu",
      tags: ["prod", "web"],
      shared: false,
    };
    const { hub } = await createTestHub({ servers: [prodServer] });
    registerReadyTerminal(hub, "term-1", "prod-web-01", "srv-prod-1");

    const targetKey = JSON.stringify(["term-1", hub.terminals.get("term-1")!.generation]);
    const baseTask: AgentTask = {
      id: "task-1",
      title: "Investigate high CPU",
      mode: "assisted",
      status: "failed",
      error: "Unit failed healthcheck",
      target: { sessionId: "term-1", generation: "g1", label: "prod-web-01" },
      messages: [
        { id: "m1", role: "user", text: "Check CPU load", at: 100 },
        { id: "m2", role: "assistant", text: "Checking top", at: 200 },
        { id: "m3", role: "user", text: "Check nginx workers", at: 300 },
        { id: "m4", role: "assistant", text: "Found worker loop", at: 400 },
        { id: "m5", role: "user", text: "Inspect config", at: 500 },
        { id: "m6", role: "assistant", text: "Config line 12 bad", at: 600 },
      ],
      changes: [
        {
          id: "chg-file-1",
          targetKey,
          kind: "file",
          target: "prod-web-01",
          description: "/etc/nginx/nginx.conf — update worker_connections",
          status: "completed",
          at: 450,
          rollback: { command: "restoreCheckpoint(/etc/nginx/nginx.conf)" },
        },
        {
          id: "chg-cmd-1",
          targetKey,
          kind: "command",
          target: "prod-web-01",
          description: "Reload nginx",
          command: "systemctl reload nginx",
          status: "completed",
          at: 480,
          check: { command: "systemctl is-active nginx", expected: "active", baselineHash: observationHash("chg-cmd-1", {exitCode:0, output:"active"}) },
          rollback: { command: "cp /etc/nginx/nginx.conf.bak /etc/nginx/nginx.conf" },
        },
      ],
      sources: [],
      createdAt: 100,
      updatedAt: 600,
      maxCommands: 10,
      maxMinutes: 15,
      verification: "not-verified",
    };
    hub.store.data.tasks.push(baseTask);

    // 1. restore-checkpoint
    mocks.restoreCheckpoint.mockResolvedValueOnce({
      restored: true,
      path: "/etc/nginx/nginx.conf",
      hash: "abc",
      beforeHash: "def",
    });
    await hub.request({ action: "restore-checkpoint", taskId: "task-1", changeId: "chg-file-1", force: true });
    expect(mocks.restoreCheckpoint).toHaveBeenCalledTimes(1);

    // 2. rollback-change (command + verification)
    const executeSpy = vi
      .spyOn(hub.terminals, "execute")
      .mockResolvedValueOnce({ output: "restored conf", exitCode: 0, cwd: "/srv/app" })
      .mockResolvedValueOnce({ output: "active", exitCode: 0, cwd: "/srv/app" });
    await hub.request({ action: "rollback-change", taskId: "task-1", changeId: "chg-cmd-1", verify: true });
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(baseTask.changes[1].rollback?.ran).toBe(true);
    expect(baseTask.changes[1].rollback?.restored).toBe(true);
    executeSpy.mockRestore();

    // 3. task-fork
    const forkSnap = await hub.request({
      action: "task-fork",
      taskId: "task-1",
      fromMessageId: "m4",
      title: "Alt branch",
      mode: "plan",
    });
    const forkedId = forkSnap.reply?.started?.taskId;
    expect(forkedId).toBeTruthy();
    const forked = forkSnap.tasks.find((t) => t.id === forkedId)!;
    expect(forked.parentTaskId).toBe("task-1");
    expect(forked.forkedFromMessageId).toBe("m4");
    expect(forked.mode).toBe("plan");
    expect(forked.messages).toHaveLength(4);

    // 4. compact-task
    const compactSnap = await hub.request({
      action: "compact-task",
      taskId: "task-1",
      focus: "nginx worker loop",
    });
    const compacted = compactSnap.tasks.find((t) => t.id === "task-1")!;
    expect(compacted.messages.length).toBe(5); // 1 summary + last 4
    expect(compacted.messages[0].role).toBe("system");
    expect(compacted.messages[0].text).toContain("nginx worker loop");

    // 5 & 6. snooze-inbox + ack-inbox
    await hub.request({ action: "snooze-inbox", itemId: "item-42", durationMinutes: 30 });
    const inboxSnap = await hub.request({ action: "ack-inbox", itemId: "item-42", acknowledged: true });
    expect(inboxSnap.inboxState?.["item-42"]?.snoozedUntil).toBeGreaterThan(Date.now());
    expect(inboxSnap.inboxState?.["item-42"]?.acknowledgedAt).toBeGreaterThan(0);

    // 7. promote-eval
    const promoteSnap = await hub.request({
      action: "promote-eval",
      taskId: "task-1",
      title: "Nginx regression incident",
    });
    expect(promoteSnap.workTickets?.some((t) => t.title === "Nginx regression incident")).toBe(true);

    // 8 & 9. rule-save + rule-delete
    const ruleSnap = await hub.request({
      action: "rule-save",
      rule: {
        id: "rule-prod-1",
        name: "Prod verification required",
        scope: "cluster",
        scopeValue: "prod-eu",
        activation: "always",
        body: "Always verify nginx -t before reload.",
        enabled: true,
      },
    });
    expect(ruleSnap.rules?.some((r) => r.id === "rule-prod-1")).toBe(true);
    const ruleDelSnap = await hub.request({ action: "rule-delete", id: "rule-prod-1" });
    expect(ruleDelSnap.rules?.some((r) => r.id === "rule-prod-1")).toBe(false);

    // 10, 11, 12. runbook-save, runbook-run (dryRun), runbook-delete
    const rbSnap = await hub.request({
      action: "runbook-save",
      runbook: {
        id: "rb-1",
        name: "Restart Service",
        inputs: [{ name: "svc", type: "string", required: true }],
        steps: [{ id: "s1", kind: "command", command: "systemctl restart {{svc}}", expected: "exit 0" }],
        targetSelector: { cluster: "prod-eu", tags: ["prod"] },
      },
    });
    expect(rbSnap.runbooks?.some((r) => r.id === "rb-1")).toBe(true);
    const rbRunSnap = await hub.request({
      action: "runbook-run",
      id: "rb-1",
      inputs: { svc: "nginx" },
      dryRun: true,
    });
    const dryTask = rbRunSnap.tasks.find((t) => t.id === rbRunSnap.reply?.started?.taskId)!;
    expect(dryTask.messages[0].text).toContain("systemctl restart nginx");
    expect(dryTask.messages[0].text).toContain("prod-web-01");
    const rbDelSnap = await hub.request({ action: "runbook-delete", id: "rb-1" });
    expect(rbDelSnap.runbooks?.some((r) => r.id === "rb-1")).toBe(false);

    // 13 & 14. profile-save + profile-delete
    const profSnap = await hub.request({
      action: "profile-save",
      profile: {
        id: "prof-eu",
        name: "EU OpenAI",
        provider: "openai-compatible",
        model: "gpt-4o-mini",
        baseUrl: "https://eu.example.com/v1",
      },
      apiKey: "secret-eu-key",
      activeRole: "primary",
    });
    expect(profSnap.config.profiles?.some((p) => p.id === "prof-eu")).toBe(true);
    expect(profSnap.config.activeProfileByRole?.primary).toBe("prof-eu");
    const profDelSnap = await hub.request({ action: "profile-delete", id: "prof-eu" });
    expect(profDelSnap.config.profiles?.some((p) => p.id === "prof-eu")).toBe(false);

    // 15. mcp-tool-policy
    await hub.request({
      action: "mcp-save",
      server: {
        id: "mcp-1",
        name: "Local Ops MCP",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        enabled: true,
      },
    });
    const mcpSnap = await hub.request({
      action: "mcp-tool-policy",
      serverId: "mcp-1",
      toolName: "restart_pod",
      policy: "deny",
    });
    expect(mcpSnap.mcpServers?.find((m) => m.id === "mcp-1")?.toolPolicies?.restart_pod).toBe("deny");

    // 16. workforce-pause
    const pauseSnap = await hub.request({
      action: "workforce-pause",
      paused: true,
      reason: "Maintenance window",
    });
    expect(pauseSnap.workforcePaused).toBe(true);
  });

  it("wires targetTags into launchExternal AcpRuntime and flags stale memories on telemetry drift", async () => {
    const prodServer: WorkspaceServerSummary = {
      id: "srv-prod",
      name: "db-prod-01",
      host: "10.0.9.9",
      port: 22,
      username: "root",
      cluster: "db-prod",
      tags: ["prod"],
      shared: false,
    };
    const { hub } = await createTestHub({ servers: [prodServer] });
    // Not offered on the desktop (only one person approves there)...
    await expect(
      hub.request({ action: "safety-policy-save", policy: { clusterPolicies: { "db-prod": { requiredApprovals: 2 } } } }),
    ).rejects.toThrow(/second person/);
    // ...but one that arrives anyway (stored before, synced) is held to: such a change is refused, not waved through.
    hub.store.data.safetyPolicy = {
      requireApprovalOnProdTags: true,
      clusterPolicies: { "db-prod": { requiredApprovals: 2 } },
    };

    // Save external runner + agent
    hub.store.data.externalRunners = [
      { id: "acp-runner", name: "db-prod-01", command: "echo", args: [], cwd: "/tmp", updatedAt: Date.now() },
    ];
    await hub.request({
      action: "agent-save",
      agent: {
        id: "ext-agent",
        name: "External Ops",
        role: "SRE",
        icon: "",
        mission: "Inspect db-prod-01",
        systemPrompt: "Inspect db-prod-01 carefully",
        defaultMode: "autonomous",
        allowedTools: ["all"],
        runnerId: "acp-runner",
      },
    });

    // Enable localMcp to also verify LocalMcpServer bridge passes localMcp into AcpRuntime
    await hub.request({ action: "mcp-local-set", enabled: true, port: 0 });

    mocks.acpStart.mockImplementationOnce(async (task: AgentTask) => {
      const ctor = mocks.acpCtors[0];
      expect(ctor).toBeDefined();
      const opts = ctor.options as {
        localMcp?: { token?: string; scopes?: string[] };
        ask: (q: { title: string; command?: string; kind?: string; toolCallId?: string }) => Promise<boolean>;
      };
      expect(opts.localMcp?.token).toBeTruthy();
      expect(opts.localMcp?.scopes).toContain("read");
      // Even in autonomous mode, prod tag + clusterPolicy.requiredApprovals=2 must require approval (via broker.askApproval)
      const askPromise = opts.ask({
        title: "Restart postgresql",
        command: "systemctl restart postgresql",
        kind: "execute",
        toolCallId: "tc-1",
      });
      // Two people are needed and only one can approve here: refused at once, with the reason.
      expect(await askPromise).toBe(false);
      const refused = task.changes.find((c) => c.command === "systemctl restart postgresql");
      expect(refused?.requiredApprovals).toBe(2);
      expect(refused?.status).toBe("denied");
      expect(refused?.output).toMatch(/only one person/);
    });
    mocks.acpStop.mockResolvedValue(undefined);

    await hub.request({
      action: "start",
      task: { prompt: "Check db-prod-01", agentId: "ext-agent", mode: "autonomous", maxCommands: 5, maxMinutes: 5 },
    });
    await new Promise((r) => setTimeout(r, 50));

    // Telemetry drift -> flagStaleMemories
    await hub.request({
      action: "memory-save",
      entry: {
        id: "mem-db-1",
        kind: "memory",
        scope: "server:db-prod-01",
        title: "Postgres runs on Ubuntu 22.04",
        text: "OS is Ubuntu 22.04",
      },
    });
    mocks.execOnServer
      .mockResolvedValueOnce({
        ok: true,
        via: "own-connection",
        stdout: JSON.stringify({
          os: { name: "Ubuntu", version: "22.04", pretty: "Ubuntu 22.04" },
          kernel: "5.15.0",
          hostname: "db-prod-01",
          failedServices: [],
          runningServices: ["postgresql"],
          listening: [{ port: 5432, proto: "tcp", address: "127.0.0.1", proc: "postgres" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        via: "own-connection",
        stdout: JSON.stringify({
          os: { name: "Ubuntu", version: "24.04", pretty: "Ubuntu 24.04" },
          kernel: "6.8.0",
          hostname: "db-prod-01",
          failedServices: ["postgresql"],
          runningServices: [],
          listening: [{ port: 5432, proto: "tcp", address: "127.0.0.1", proc: "postgres" }],
        }),
      });

    await hub.request({ action: "facts-collect-now", serverId: "srv-prod" });
    const afterDrift = await hub.request({ action: "facts-collect-now", serverId: "srv-prod" });
    const mem = afterDrift.memories.find((m) => m.id === "mem-db-1");
    expect(mem).toBeDefined();
    expect(mem?.staleReason).toBeTruthy();
  });

  it("enforces two-person peer approval & freeze in plan-decide, and hands a conversation on without a hop limit", async () => {
    const prodServer: WorkspaceServerSummary = {
      id: "srv-p",
      name: "prod-api-1",
      host: "10.0.2.1",
      port: 22,
      username: "ops",
      cluster: "prod-api",
      tags: ["prod"],
      shared: false,
    };
    const { hub, setActor } = await createTestHub({ actorName: "alice", servers: [prodServer] });
    // On the desktop only one person approves: a rule that needs a second one is not offered.
    await expect(
      hub.request({
        action: "safety-policy-save",
        policy: {
          requireApprovalOnProdTags: true,
          requirePeerApprovalOnProd: true,
        },
      }),
    ).rejects.toThrow(/second person/);
    // One stored before (or synced in) is not in force here: the plan is not left waiting for ever.
    hub.store.data.safetyPolicy = { ...hub.store.data.safetyPolicy!, requirePeerApprovalOnProd: true };

    const planTask: AgentTask = {
      id: "task-plan",
      title: "Upgrade API",
      mode: "plan",
      agentId: "planner-agent",
      agentName: "Planner",
      status: "completed",
      target: { sessionId: "term-1", generation: "g1", label: "prod-api-1" },
      messages: [{ id: "u1", role: "user", text: "Upgrade", at: 100 }],
      changes: [],
      sources: [],
      plan: {
        id: "plan-1",
        goal: "Restart prod API",
        steps: [
          {
            action: "Restart service",
            target: "prod-api-1",
            command: "systemctl restart api",
            risk: "medium",
            check: "systemctl is-active api",
            rollback: "systemctl start api",
          },
        ],
        status: "proposed",
        revision: 1,
        review: { verdict: "approve", findings: [] },
        createdAt: 100,
      },
      createdAt: 100,
      updatedAt: 100,
      maxCommands: 5,
      maxMinutes: 10,
      verification: "not-verified",
    };
    hub.store.data.tasks.push(planTask);

    // Renaming the person does not make a second approver: approvals are by account, and the
    // rule that wants two is not in force where only one can approve.
    mocks.runtimeStart.mockResolvedValue(undefined);
    setActor("bob");
    // Recent, or saving the store prunes it as an old conversation.
    planTask.updatedAt = Date.now();
    await hub.request({ action: "plan-decide", taskId: "task-plan", approved: true, note: "LGTM" });
    const plan = hub.store.data.tasks.find((t) => t.id === "task-plan")?.plan as
      | (NonNullable<AgentTask["plan"]> & { approvals?: Array<{ actorId?: string }> })
      | undefined;
    expect(plan?.status).toBe("approved");
    expect(plan?.approvals?.[0]?.actorId).toBe("local");

    // Freeze blocks plan approval
    await hub.request({
      action: "safety-policy-save",
      policy: {
        clusterPolicies: { "prod-api": { frozenUntil: Date.now() + 3_600_000 } },
      },
    });
    hub.store.data.tasks.push({
      ...planTask,
      id: "task-frozen",
      status: "completed",
      plan: { ...planTask.plan!, id: "plan-frozen", status: "proposed", approvals: undefined } as AgentTask["plan"],
    });
    await expect(
      hub.request({ action: "plan-decide", taskId: "task-frozen", approved: true }),
    ).rejects.toThrow("change freeze");

    // Handoffs: no limit on how many
    const mkAgent = (id: string, name: string): MissionAgent => ({
      id,
      name,
      role: "Ops",
      icon: "",
      mission: `Mission ${name}`,
      systemPrompt: `Mission ${name}`,
      defaultMode: "assisted",
      allowedTools: ["all"],
      updatedAt: Date.now(),
    });
    hub.store.data.agents = [
      mkAgent("a1", "Agent One"),
      mkAgent("a2", "Agent Two"),
      mkAgent("a3", "Agent Three"),
      mkAgent("a4", "Agent Four"),
      mkAgent("a5", "Agent Five"),
    ];
    hub.store.data.tasks.push({
      id: "task-handoff",
      title: "Handoff chain",
      mode: "assisted",
      agentId: "a1",
      agentName: "Agent One",
      status: "completed",
      messages: [{ id: "h1", role: "user", text: "Go", at: 100 }],
      changes: [],
      sources: [],
      createdAt: 100,
      updatedAt: 100,
      maxCommands: 5,
      maxMinutes: 10,
      verification: "not-verified",
    });
    await hub.request({ action: "agent-handoff", taskId: "task-handoff", toAgentId: "a2" });
    await hub.request({ action: "agent-handoff", taskId: "task-handoff", toAgentId: "a3" });
    await hub.request({ action: "agent-handoff", taskId: "task-handoff", toAgentId: "a4" });
    // A fourth hop goes through like the others.
    await hub.request({ action: "agent-handoff", taskId: "task-handoff", toAgentId: "a5" });
    expect(hub.store.data.tasks.find((t) => t.id === "task-handoff")).toMatchObject({ agentId: "a5" });
  });

  it("streams live deltas via HubService -> createMultiSSHApi -> applyAiHubDelta", async () => {
    const { hub, deltaEvents } = await createTestHub();
    mocks.runtimeStart.mockImplementation(async (_task: AgentTask, _model, onEvent) => {
      onEvent({ type: "message.delta", delta: "Hello " });
      onEvent({ type: "message.delta", delta: "world" });
      onEvent({
        type: "tool.result",
        tool: { name: "terminal_command", input: "uptime", output: "up 10 days" },
      });
      onEvent({
        type: "usage.updated",
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
          cost_usd: 0.012,
          context_tokens: 512,
        },
      });
      onEvent({ type: "run.retrying", text: "Retrying in 500ms" });
      onEvent({ type: "run.degraded", text: "Degraded to backup", toModel: "gpt-backup", error: "429" });
      onEvent({
        type: "run.completed",
        output: "Hello world",
        usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 40, cost_usd: 0.012 },
      });
    });

    const startSnap = await hub.request({
      action: "start",
      task: { prompt: "Say hello", mode: "advice", maxCommands: 3, maxMinutes: 5 },
    });
    await new Promise((r) => setTimeout(r, 40));

    expect(deltaEvents.map((d) => d.type)).toEqual([
      "message.delta",
      "message.delta",
      "tool.result",
      "usage.updated",
      "run.retrying",
      "run.degraded",
    ]);

    // Verify IPC transport onAiHubDelta + backward compatible onAiHubChanged
    const listeners = new Map<string, Set<(_ev: unknown, ...args: unknown[]) => void>>();
    const api = createMultiSSHApi({
      invoke: vi.fn(),
      on: (ch, fn) => {
        if (!listeners.has(ch)) listeners.set(ch, new Set());
        listeners.get(ch)!.add(fn);
      },
      removeListener: (ch, fn) => {
        listeners.get(ch)?.delete(fn);
      },
    });

    const received: AiHubDeltaEvent[] = [];
    const unsubDelta = api.onAiHubDelta((d) => received.push(d));
    const changedFn = vi.fn();
    const unsubChanged = api.onAiHubChanged(changedFn);

    for (const d of deltaEvents) {
      for (const fn of listeners.get(HUB_DELTA_CHANNEL) ?? []) fn({}, d);
    }
    for (const fn of listeners.get("ai-hub:changed") ?? []) fn({});
    expect(received).toHaveLength(6);
    expect(changedFn).toHaveBeenCalledTimes(1);
    unsubDelta();
    unsubChanged();

    // Verify applyAiHubDelta patches renderer HubSnapshot immutably
    const baseSnap: HubSnapshot = {
      ...startSnap,
      tasks: [
        {
          id: deltaEvents[0].taskId,
          title: "Say hello",
          mode: "advice",
          status: "running",
          messages: [{ id: "u1", role: "user", text: "Say hello", at: 1 }],
          changes: [],
          sources: [],
          createdAt: 1,
          updatedAt: 1,
          maxCommands: 3,
          maxMinutes: 5,
          verification: "not-verified",
        },
      ],
    };
    let patched: HubSnapshot | undefined = baseSnap;
    for (const d of received) {
      patched = applyAiHubDelta(patched, d);
    }
    const patchedTask = patched!.tasks[0];
    expect(patchedTask.messages.find((m) => m.role === "assistant")?.text).toBe("Hello world");
    expect(patchedTask.toolLog?.[0]?.name).toBe("terminal_command");
    expect(patchedTask.runUsage?.cacheReadTokens).toBe(40);
    expect(patchedTask.runUsage?.costUsd).toBe(0.012);
    expect(patchedTask.contextTokens).toBe(512);
    expect(patchedTask.model).toBe("gpt-backup");
  });

  it("handles SSH reconnect grace interruption, recordingIds[], per-target Heartbeat concurrency, and AuditShipper", async () => {
    const shipped: AuditEntry[] = [];
    const { hub } = await createTestHub({
      auditShipperSend: async ({ entry }) => {
        shipped.push(entry);
      },
    });
    registerReadyTerminal(hub, "ssh-1", "app-01", "srv-1");

    // 1. Multi-recording accumulation + graceful reconnect drop
    hub.store.data.tasks.push({
      id: "task-rec",
      title: "Run check",
      mode: "assisted",
      status: "running",
      target: { sessionId: "ssh-1", generation: "g1", label: "app-01" },
      messages: [{ id: "u1", role: "user", text: "check", at: 1 }],
      changes: [],
      sources: [],
      createdAt: 1,
      updatedAt: 1,
      maxCommands: 5,
      maxMinutes: 10,
      verification: "not-verified",
    });
    hub.terminals.claim("ssh-1", hub.terminals.get("ssh-1")!.generation, "task-rec");
    await new Promise((r) => setTimeout(r, 40));
    expect(hub.store.data.tasks.find((t) => t.id === "task-rec")?.recordingIds?.length).toBe(1);

    // Entering reconnecting interrupts active task cleanly instead of crashing
    hub.terminals.markReconnecting("ssh-1", { attempt: 1, maxAttempts: 3, reason: "TCP reset" });
    await new Promise((r) => setTimeout(r, 30));
    const interrupted = hub.store.data.tasks.find((t) => t.id === "task-rec")!;
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.error).toContain("TCP reset");
    const restoredView = hub.terminals.markReconnected("ssh-1");
    expect(restoredView.shell).toBe("bash");
    expect(restoredView.cwd).toBe("/srv/app");

    // 2. Per-target Heartbeat concurrency + workforcePaused gating
    await hub.request({ action: "configure", config: {}, preferences: { workforceAutopilot: true } });
    await hub.request({
      action: "agent-save",
      agent: {
        id: "hb-agent",
        name: "Heartbeat Agent",
        role: "Ops",
        icon: "",
        mission: "Handle tickets",
        systemPrompt: "Handle assigned tickets",
        defaultMode: "advice",
        allowedTools: ["all"],
      },
    });
    const now = Date.now();
    hub.store.data.tasks.push({
      id: "task-busy",
      title: "Running ticket on app-01",
      mode: "advice",
      agentId: "hb-agent",
      agentName: "Heartbeat Agent",
      status: "running",
      messages: [{ id: "m-busy", role: "user", text: "Run", at: now - 100 }],
      changes: [],
      sources: [],
      createdAt: now - 100,
      updatedAt: now - 100,
      maxCommands: 5,
      maxMinutes: 10,
      verification: "not-verified",
    });
    hub.store.data.workTickets = [
      {
        id: "t-busy",
        title: "Ticket on app-01 already running",
        description: "Busy",
        status: "in_progress",
        target: "app-01",
        taskId: "task-busy",
        assigneeAgentId: "hb-agent",
        claim: { by: "alice", client: (hub as unknown as { clientId: () => string }).clientId(), at: now, seenAt: now },
        createdBy: "alice",
        createdAt: now - 200,
        updatedAt: now - 200,
      },
      {
        id: "t-same-target",
        title: "Second ticket on app-01 (must wait)",
        description: "Same target",
        status: "todo",
        target: "app-01",
        assigneeAgentId: "hb-agent",
        createdBy: "alice",
        createdAt: now - 150,
        updatedAt: now - 150,
      },
      {
        id: "t-other-target",
        title: "Ticket on db-02 (can run concurrently)",
        description: "Other target",
        status: "todo",
        target: "db-02",
        assigneeAgentId: "hb-agent",
        createdBy: "alice",
        createdAt: now - 100,
        updatedAt: now - 100,
      },
    ];
    const startTicketSpy = vi
      .spyOn(hub as unknown as { startTicket: (id: string) => Promise<void> }, "startTicket")
      .mockResolvedValue(undefined);

    await (hub as unknown as { workTick: (n: number, ai?: boolean) => Promise<void> }).workTick(now, true);
    expect(startTicketSpy).toHaveBeenCalledTimes(1);
    expect(startTicketSpy).toHaveBeenCalledWith("t-other-target");

    // When paused globally, workTick does not start new tickets
    startTicketSpy.mockClear();
    await hub.request({ action: "workforce-pause", paused: true });
    await (hub as unknown as { workTick: (n: number, ai?: boolean) => Promise<void> }).workTick(now + 1000, true);
    expect(startTicketSpy).not.toHaveBeenCalled();
    startTicketSpy.mockRestore();

    // 3. AuditShipper received audit entries
    await hub.audit().append({
      kind: "setting",
      actor: "alice",
      target: "cluster-a",
      what: "Verified shipper hook",
      outcome: "completed",
    });
    await hub.dispose();
    expect(shipped.some((e) => e.what === "Verified shipper hook")).toBe(true);
  });
});
