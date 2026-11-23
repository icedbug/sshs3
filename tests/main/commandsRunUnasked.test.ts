import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubService } from "../../src/main/ai/hub/HubService";
import { HubStore } from "../../src/main/ai/hub/HubStore";
import { planGate } from "../../src/main/ai/hub/PlanMode";
import { exactHash } from "../../src/main/ai/hub/privacy";
import type { ToolRequest } from "../../src/main/ai/hub/ToolBroker";
import type { AgentChange, AgentTask, ChatOrigin, TeamSafetyRules, WorkspaceServerSummary } from "../../src/shared/types/aiHub";

/**
 * What is asked about and what is not, row by row as docs/ai-hub.md lists it under "What is checked and
 * what is not".
 *
 * A command the agent runs in a terminal is run at once: nobody is asked and nothing looks at what the
 * command does, also when it deletes. What waits for a person is a change card (a command with its check
 * and its rollback), a file write, a plan and a change to sshs3's own rules. A freeze and the two-person
 * rule are about those, not about commands.
 *
 * A real hub with its real broker; only the terminals and the file tools are stand-ins.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const WEB: WorkspaceServerSummary = { id: "srv-web-1", name: "web-1", host: "10.0.0.11", port: 22, username: "ops", cluster: "web", shared: true } as WorkspaceServerSummary;
/** A production server: its tag is what the rules for production look at. */
const API: WorkspaceServerSummary = { id: "srv-api-1", name: "api-1", host: "10.0.0.21", port: 22, username: "ops", cluster: "api", tags: ["prod"], shared: true } as WorkspaceServerSummary;
const SERVERS = [WEB, API];

/** A command that deletes. Nothing reads it, so it stands for every command. */
const DELETES = "rm -rf /tmp/x";
/** A change card. Every terminal here prints "done", so that is what its check expects. */
const card = (command: string, more: Partial<ToolRequest> = {}): ToolRequest =>
  ({ action: "change", command, description: "Restart the service", check: { command: "systemctl is-active app", expected: "done" }, rollback: "systemctl stop app", ...more }) as ToolRequest;
const fileWrite = (filePath = "/etc/app/app.conf"): ToolRequest => ({ action: "file-write", path: filePath, content: "workers 4\n", description: "Set the workers" }) as ToolRequest;

type Invoke = (request: ToolRequest) => Promise<any>;

async function hubWith(options: { team?: TeamSafetyRules } = {}) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-commands-unasked-"));
  /** What was typed into each terminal, after it was made ready. */
  const typed = new Map<string, string[]>();
  /** The paths the file tools wrote. */
  const written: string[] = [];
  let count = 0;
  // eslint-disable-next-line prefer-const -- the host's terminals need the hub, made just below
  let hub: HubService;
  /** A terminal that answers every command with "done", as a shell at its prompt would. */
  const answering = async (id: string, srv: WorkspaceServerSummary): Promise<void> => {
    hub.terminals.register({ id, label: srv.name, kind: "ssh", profileId: srv.id }, (data) => {
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (!nonce) return;
      typed.get(id)?.push(data);
      queueMicrotask(() => hub.terminals.feed(id, `\x1b]777;SSHS3;${nonce};BEGIN\x07done\r\n\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`));
    });
    hub.terminals.feed(id, `ops@${srv.name}:~$ `);
    await hub.terminals.ensureReady(id, "bash");
    typed.set(id, []);
  };
  /** As the real file tools do: a write is put to the broker as a change before anything is written. */
  const file = async (task: AgentTask, request: ToolRequest, authorize?: (change: AgentChange) => Promise<void>) => {
    if (request.action !== "file-write") return { content: "", hash: "h" };
    const change: AgentChange = { id: `file-${task.changes.length + 1}`, kind: "file", target: task.target!.label, description: request.description ?? "Write a file", status: "pending", at: Date.now() };
    task.changes.push(change);
    await authorize!(change);
    written.push(String(request.path));
    change.status = "completed";
    return { ok: true };
  };
  hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => SERVERS,
      openServerTerminal: async (profileId: string) => {
        const id = `opened-${++count}`;
        await answering(id, SERVERS.find((s) => s.id === profileId)!);
        return id;
      },
      closeSession: () => {},
      manageAppSettings: async () => ({}),
      file,
      // A server several people sign in to: only there a second person can be asked.
      ...(options.team
        ? { alertHookOwner: "owner-1", soleUser: () => false, teamAdmin: () => false, peerApproval: () => true, teamRules: { read: () => options.team!, write: async () => {} } }
        : {}),
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  await hub.collectExtraContext();
  await answering("term-web", WEB);
  await answering("term-api", API);

  let runs = 0;
  /** A conversation at work in a terminal of a server, and the way its tools reach the broker. */
  const run = async (mode: AgentTask["mode"], on: "web" | "api" | "none" = "web", extra: Partial<AgentTask> = {}) => {
    const sessionId = on === "none" ? undefined : `term-${on}`;
    // One run at a time works in a terminal: the run before this one is over.
    const owner = sessionId ? hub.terminals.get(sessionId)?.owner : undefined;
    if (owner) hub.terminals.release(owner);
    const task: AgentTask = {
      id: `run-${++runs}`,
      title: "Work",
      mode,
      status: "running",
      messages: [{ id: `u-${runs}`, role: "user", text: "Look at the app", at: 1 }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 0,
      maxMinutes: 0,
      verification: "not-verified",
      ...(sessionId ? { target: { sessionId, generation: hub.terminals.get(sessionId)!.generation, label: on === "web" ? WEB.name : API.name } } : {}),
      ...extra,
    };
    hub.store.data.tasks.push(task);
    const capability = await hub.broker.issue(task);
    const invoke: Invoke = (request) => hub.broker.invoke(capability.key, request);
    /** The change that waits for a person, once the question is out. */
    const waiting = async (): Promise<AgentChange> => {
      await vi.waitFor(() => expect(task.changes.some((c) => c.status === "pending") && task.status === "waiting").toBe(true));
      return task.changes.find((c) => c.status === "pending")!;
    };
    const answer = (change: AgentChange, approved: boolean) => hub.request({ action: "approve", taskId: task.id, changeId: change.id, approved });
    return { task, invoke, waiting, answer };
  };
  const ran = (terminal: string, text: string): boolean => (typed.get(terminal) ?? []).some((d) => d.includes(text));
  const typedCount = (): number => [...typed.values()].reduce((n, lines) => n + lines.length, 0);
  /** Nothing rates a change: none carries what the old rating wrote on it. */
  const unrated = (): void => {
    for (const task of hub.store.data.tasks)
      for (const change of task.changes) for (const field of ["riskLevel", "riskReason", "parsedSubcommands"]) expect(change).not.toHaveProperty(field);
  };
  return { hub, dir, run, ran, typed, typedCount, written, unrated };
}

const chatOrigin = (reach: "read" | "ask" | "plan"): ChatOrigin => ({
  service: "slack",
  channelId: "C-OPS",
  channelName: "ops",
  threadId: "1700000000.000100",
  kind: "channel",
  askedBy: { chatUserId: "U-1", name: "Somebody in chat" },
  fence: { servers: ["web-1"], clusters: [], reach },
});

describe("a command the agent runs", () => {
  it("runs at once and nobody is asked, in Ask first and in Auto, also on production and also when it deletes", async () => {
    const { hub, run, ran, unrated } = await hubWith();
    for (const mode of ["assisted", "autonomous"] as const)
      for (const on of ["web", "api"] as const) {
        const { task, invoke } = await run(mode, on);
        const command = `${DELETES}-${mode}-${on}`;
        await expect(invoke({ action: "command", command, description: "Clean up" })).resolves.toMatchObject({ exitCode: 0 });
        expect(ran(`term-${on}`, command)).toBe(true);
        expect(task.status).toBe("running");
        expect(task.changes).toHaveLength(1);
        // No rule let it through and no person did: there was nothing to decide.
        expect(task.changes[0]).toMatchObject({ kind: "command", status: "completed", decidedHow: "policy" });
        expect(task.changes[0].decidedBy).toBeUndefined();
        expect(task.changes[0].requiredApprovals).toBeUndefined();
        // Written down once, when it has ended. Nothing is written before a command runs.
        await vi.waitFor(async () => {
          const rows = (await hub.audit().entries()).filter((row) => "changeId" in row && row.changeId === task.changes[0].id);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ kind: "command", outcome: "completed", approvedBy: "nobody: a command runs without asking" });
        });
      }
    unrated();
  });

  it("is not asked about because a secret in it was hidden", async () => {
    const { run, ran, unrated } = await hubWith();
    const { task, invoke } = await run("assisted");
    await expect(invoke({ action: "command", command: "mysql --password=correct-horse-battery -e 'select 1'" })).resolves.toMatchObject({ exitCode: 0 });
    expect(task.changes[0]).toMatchObject({ status: "completed", hiddenValues: true });
    expect(task.changes[0].command).not.toContain("correct-horse-battery");
    expect(ran("term-web", "correct-horse-battery")).toBe(true);
    expect(task.status).toBe("running");
    unrated();
  });

  it("runs on several servers at once without asking", async () => {
    const { run, typed, unrated } = await hubWith();
    const { task, invoke } = await run("assisted");
    await invoke({ action: "sshs3_cluster_exec", payload: { command: DELETES, serverIdsOrNames: ["web-1", "api-1"], description: "Clean up" } });
    expect(task.status).toBe("running");
    expect([...typed.values()].flat().filter((line) => line.includes(DELETES))).toHaveLength(2);
    expect(task.changes.at(-1)).toMatchObject({ kind: "command", decidedHow: "policy" });
    expect(task.changes.at(-1)?.decidedBy).toBeUndefined();
    unrated();
  });
});

describe("a change card and a file write", () => {
  it("are asked about in Ask first, and nothing of them is typed or written until a person says yes", async () => {
    const { run, ran, typedCount, written, unrated } = await hubWith();
    const { task, invoke, waiting, answer } = await run("assisted");

    const asked = invoke(card("systemctl restart app"));
    const change = await waiting();
    expect(change).toMatchObject({ kind: "command", command: "systemctl restart app", check: { command: "systemctl is-active app", expected: "done" }, rollback: { command: "systemctl stop app" } });
    // Not its check either.
    expect(typedCount()).toBe(0);
    await answer(change, true);
    await expect(asked).resolves.toMatchObject({ exitCode: 0, checkPassed: true });
    expect(ran("term-web", "systemctl restart app")).toBe(true);
    expect(change).toMatchObject({ status: "completed", decidedHow: "person" });

    // A no: nothing more is typed.
    const before = typedCount();
    const refused = expect(invoke(card("systemctl restart other"))).rejects.toMatchObject({ code: "approval_denied" });
    await answer(await waiting(), false);
    await refused;
    expect(typedCount()).toBe(before);

    const write = invoke(fileWrite());
    const fileChange = await waiting();
    expect(fileChange.kind).toBe("file");
    expect(written).toEqual([]);
    await answer(fileChange, true);
    await write;
    expect(written).toEqual(["/etc/app/app.conf"]);
    expect(fileChange.decidedHow).toBe("person");
    // Three questions, three answers, and the run goes on.
    expect(task.changes.map((c) => c.status)).toEqual(["completed", "denied", "completed"]);
    expect(task.status).toBe("running");
    unrated();
  });

  it("run unasked in Auto, except on production while the rule for it is on", async () => {
    const { hub, run, ran, written, unrated } = await hubWith();
    // Off production: no question.
    const web = await run("autonomous", "web");
    await expect(web.invoke(card("systemctl restart app"))).resolves.toMatchObject({ checkPassed: true });
    await web.invoke(fileWrite("/etc/app/web.conf"));
    expect(web.task.status).toBe("running");
    expect(web.task.changes.map((c) => c.decidedHow)).toEqual(["policy", "policy"]);

    // On production the card and the file write wait. A command beside them does not.
    const api = await run("autonomous", "api");
    const asked = api.invoke(card("systemctl restart api"));
    const change = await api.waiting();
    expect(ran("term-api", "systemctl restart api")).toBe(false);
    await api.answer(change, true);
    await asked;
    expect(ran("term-api", "systemctl restart api")).toBe(true);
    const write = api.invoke(fileWrite("/etc/app/api.conf"));
    const fileChange = await api.waiting();
    expect(written).toEqual(["/etc/app/web.conf"]);
    await api.answer(fileChange, true);
    await write;
    await expect(api.invoke({ action: "command", command: DELETES })).resolves.toMatchObject({ exitCode: 0 });

    // With the rule off, production is as any other server.
    hub.store.data.safetyPolicy = { requireApprovalOnProdTags: false };
    const free = await run("autonomous", "api");
    await expect(free.invoke(card("systemctl reload api"))).resolves.toMatchObject({ checkPassed: true });
    await free.invoke(fileWrite("/etc/app/api2.conf"));
    expect(free.task.status).toBe("running");
    expect(written).toEqual(["/etc/app/web.conf", "/etc/app/api.conf", "/etc/app/api2.conf"]);
    unrated();
  });

  it("are refused during a change freeze, in every mode, while a command still runs", async () => {
    const { hub, run, ran, typedCount, written, unrated } = await hubWith();
    hub.store.data.safetyPolicy = { requireApprovalOnProdTags: true, clusterPolicies: { web: { frozenUntil: Date.now() + 3_600_000 } } };
    for (const mode of ["assisted", "autonomous"] as const) {
      const { task, invoke } = await run(mode);
      const before = typedCount();
      const frozen = invoke(card("systemctl restart app"));
      await expect(frozen).rejects.toMatchObject({ code: "change_freeze" });
      await expect(frozen).rejects.toThrow(/no change card and no file write is run there until then\. Commands still run/);
      await expect(invoke(fileWrite())).rejects.toMatchObject({ code: "change_freeze" });
      // Refused, not asked about: nobody was bothered and nothing was typed or written.
      expect(task.status).toBe("running");
      expect(task.changes.map((c) => c.status)).toEqual(["denied", "denied"]);
      expect(typedCount()).toBe(before);
      expect(written).toEqual([]);
      // The freeze is not about commands: nothing looks at what this one does.
      const command = `${DELETES}-${mode}`;
      await expect(invoke({ action: "command", command })).resolves.toMatchObject({ exitCode: 0 });
      expect(ran("term-web", command)).toBe(true);
    }
    // A server outside the frozen cluster is not held.
    const other = await run("autonomous", "api");
    hub.store.data.safetyPolicy = { requireApprovalOnProdTags: false, clusterPolicies: { web: { frozenUntil: Date.now() + 3_600_000 } } };
    await expect(other.invoke(card("systemctl restart api"))).resolves.toMatchObject({ checkPassed: true });
    unrated();
  });

  it("wait for a second person on production where the two-person rule is on, and a command there waits for nobody", async () => {
    const { hub, run, ran, unrated } = await hubWith({ team: { requirePeerApprovalOnProd: true } });
    const { task, invoke, waiting, answer } = await run("assisted", "api");

    await expect(invoke({ action: "command", command: DELETES })).resolves.toMatchObject({ exitCode: 0 });
    expect(task.changes[0].requiredApprovals).toBeUndefined();
    expect(task.status).toBe("running");

    const asked = invoke(card("systemctl restart api"));
    const change = await waiting();
    expect(change.requiredApprovals).toBe(2);
    // The person whose run it is says yes: that is one of two, and nothing runs.
    await answer(change, true);
    expect(change.status).toBe("pending");
    expect(task.status).toBe("waiting");
    expect(ran("term-api", "systemctl restart api")).toBe(false);
    // A second person's yes lets it run.
    await hub.approveAsPeer(task.id, change.id, true, { id: "peer-2", name: "A second person" });
    await expect(asked).resolves.toMatchObject({ checkPassed: true });
    expect(ran("term-api", "systemctl restart api")).toBe(true);
    expect(change.approvals?.filter((vote) => vote.allowed)).toHaveLength(2);

    // Off production the rule does not count: one yes is enough.
    const web = await run("assisted", "web");
    const single = web.invoke(card("systemctl restart app"));
    const one = await web.waiting();
    expect(one.requiredApprovals ?? 1).toBe(1);
    await web.answer(one, true);
    await single;
    unrated();
  });

  it("are asked about on production for a member of a shared server, whatever that member's own setting says", async () => {
    const { hub, run, ran } = await hubWith({ team: {} });
    // Stored for this member with the rule off: on a server several people share it stays on for them.
    hub.store.data.safetyPolicy = { requireApprovalOnProdTags: false };
    expect(hub.safetyPolicy().requireApprovalOnProdTags).toBe(true);
    const { task, invoke, waiting, answer } = await run("autonomous", "api");
    const asked = invoke(card("systemctl restart api"));
    const change = await waiting();
    expect(ran("term-api", "systemctl restart api")).toBe(false);
    await answer(change, true);
    await asked;
    // A command there is still nobody's to approve.
    await expect(invoke({ action: "command", command: DELETES })).resolves.toMatchObject({ exitCode: 0 });
    expect(task.changes.map((c) => c.decidedHow)).toEqual(["person", "policy"]);
  });

  it("are held to a cluster's own rules (two approvals, a plan first, a check and a rollback), and a command is not", async () => {
    const { hub, run, ran, written } = await hubWith({ team: {} });
    const rules = (web: Record<string, unknown>) => {
      hub.store.data.safetyPolicy = { requireApprovalOnProdTags: true, clusterPolicies: { web } };
    };

    // Two approvals on the cluster: the card waits for two people, the command for nobody.
    rules({ requiredApprovals: 2 });
    const two = await run("autonomous");
    await expect(two.invoke({ action: "command", command: `${DELETES}-two` })).resolves.toMatchObject({ exitCode: 0 });
    expect(two.task.changes[0].requiredApprovals).toBeUndefined();
    const held = expect(two.invoke(card("systemctl restart app"))).rejects.toMatchObject({ code: "approval_denied" });
    const change = await two.waiting();
    expect(change.requiredApprovals).toBe(2);
    await two.answer(change, true);
    expect(change.status).toBe("pending");
    await hub.approveAsPeer(two.task.id, change.id, false, { id: "peer-2", name: "A second person" });
    await held;
    expect(ran("term-web", "systemctl restart app")).toBe(false);

    // A plan first: without an approved plan no card and no file write, but a command runs.
    rules({ maxMode: "plan" });
    const planned = await run("assisted");
    await expect(planned.invoke({ action: "command", command: `${DELETES}-plan` })).resolves.toMatchObject({ exitCode: 0 });
    await expect(planned.invoke(card("systemctl restart app"))).rejects.toThrow(/requires an approved plan/);
    await expect(planned.invoke(fileWrite())).rejects.toThrow(/requires an approved plan/);

    // A check and a rollback: a file write has neither and is refused. A command is not a change.
    rules({ requireCheckAndRollback: true });
    const proven = await run("autonomous");
    await expect(proven.invoke({ action: "command", command: `${DELETES}-proof` })).resolves.toMatchObject({ exitCode: 0 });
    await expect(proven.invoke(fileWrite())).rejects.toThrow(/requires a checked change with a rollback/);
    await expect(proven.invoke(card("systemctl reload app"))).resolves.toMatchObject({ checkPassed: true });
    expect(written).toEqual([]);
    for (const tail of ["two", "plan", "proof"]) expect(ran("term-web", `${DELETES}-${tail}`)).toBe(true);
  });

  it("are refused where a cluster allows only advice, and so is a command", async () => {
    const { hub, run, typedCount, written } = await hubWith();
    hub.store.data.safetyPolicy = { requireApprovalOnProdTags: true, clusterPolicies: { web: { maxMode: "advice" } } };
    const { task, invoke } = await run("autonomous");
    await expect(invoke({ action: "command", command: "uptime" })).rejects.toThrow(/only allows advice/);
    await expect(invoke(card("systemctl restart app"))).rejects.toThrow(/only allows advice/);
    await expect(invoke(fileWrite())).rejects.toThrow(/only allows advice/);
    expect(typedCount()).toBe(0);
    expect(written).toEqual([]);
    expect(task.changes.map((c) => c.status)).toEqual(["denied", "denied", "denied"]);
  });
});

describe("a plan", () => {
  it("holds a change card and a file write while it waits; a command still runs", async () => {
    const { run, ran, typedCount, unrated } = await hubWith();
    const { task, invoke, waiting, answer } = await run("plan");
    const listed = card("systemctl restart app");
    task.plan = {
      id: "p1",
      goal: "Restart the app",
      steps: [{ action: "Restart", command: "systemctl restart app", commandHash: exactHash("systemctl restart app"), risk: "medium", check: "systemctl is-active app", checkExpected: "done", rollback: "systemctl stop app" }],
      status: "proposed",
      revision: 1,
      review: { verdict: "approve", findings: [] },
      createdAt: 1,
    };
    // The run loop does not hand a change on while the plan waits. It does hand on a command.
    expect(planGate(task, "sshs3_change", listed as never)).toMatch(/No change card and no file write runs until they approve it/);
    expect(planGate(task, "file_write", { path: "/etc/app/app.conf" })).toMatch(/No change card and no file write runs/);
    expect(planGate(task, "terminal_command", { command: DELETES })).toBeUndefined();
    expect(planGate(task, "sshs3_cluster_exec", { command: DELETES })).toBeUndefined();

    // The broker, asked all the same: the command runs, the card is not covered by a plan nobody approved.
    await expect(invoke({ action: "command", command: DELETES })).resolves.toMatchObject({ exitCode: 0 });
    expect(task.status).toBe("running");
    const early = expect(invoke(listed)).rejects.toMatchObject({ code: "approval_denied" });
    const change = await waiting();
    expect(ran("term-web", "systemctl restart app")).toBe(false);
    await answer(change, false);
    await early;

    // Approved: the card the plan lists runs without a second question, once. Another card still asks.
    task.plan.status = "approved";
    task.plan.steps[0].approvedTarget = JSON.stringify([task.target!.sessionId, task.target!.generation]);
    expect(planGate(task, "sshs3_change", listed as never)).toBeUndefined();
    await expect(invoke(listed)).resolves.toMatchObject({ checkPassed: true });
    expect(task.changes.at(-1)).toMatchObject({ status: "completed", decidedHow: "plan" });
    expect(task.plan.steps[0].ranAt).toBeTypeOf("number");
    const before = typedCount();
    const other = expect(invoke(card("systemctl restart other"))).rejects.toMatchObject({ code: "approval_denied" });
    const second = await waiting();
    expect(typedCount()).toBe(before);
    await answer(second, false);
    await other;
    unrated();
  });
});

describe("a conversation that only looks", () => {
  it("as an investigator runs a command, whatever it does, and is refused a change card and a file write", async () => {
    const { run, ran, typedCount, written, unrated } = await hubWith();
    const { task, invoke } = await run("advice", "web", { investigator: true });
    await expect(invoke({ action: "command", command: DELETES })).resolves.toMatchObject({ exitCode: 0 });
    expect(ran("term-web", DELETES)).toBe(true);
    const before = typedCount();
    const refused = invoke(card("systemctl restart app"));
    await expect(refused).rejects.toMatchObject({ code: "investigator_read_only" });
    await expect(refused).rejects.toThrow(/An investigator only looks\. It makes no change card, writes no file/);
    await expect(invoke(fileWrite())).rejects.toMatchObject({ code: "investigator_read_only" });
    expect(typedCount()).toBe(before);
    expect(written).toEqual([]);
    expect(task.status).toBe("running");
    unrated();
  });

  it("from a chat channel set to commands only runs a command and is refused a change card and a file write", async () => {
    const { run, typed, typedCount, written, unrated } = await hubWith();
    const { task, invoke } = await run("assisted", "none", { chat: chatOrigin("read") });
    // It opens a terminal of its own on a server of its channel.
    await expect(invoke({ action: "command", command: DELETES, id: "web-1" })).resolves.toMatchObject({ exitCode: 0 });
    expect((typed.get(task.target!.sessionId) ?? []).some((line) => line.includes(DELETES))).toBe(true);
    expect(task.changes[0]).toMatchObject({ status: "completed", decidedHow: "policy" });
    const before = typedCount();
    const refused = invoke(card("systemctl restart app"));
    await expect(refused).rejects.toMatchObject({ code: "chat_read_only" });
    await expect(refused).rejects.toThrow(/This chat may run commands and proposes no change/);
    await expect(invoke(fileWrite())).rejects.toMatchObject({ code: "chat_read_only" });
    expect(typedCount()).toBe(before);
    expect(written).toEqual([]);
    expect(task.status).toBe("running");
    unrated();
  });

  it("in Advice runs nothing: no command, no change card, no file write", async () => {
    const { run, typedCount, written } = await hubWith();
    const { task, invoke } = await run("advice");
    for (const request of [{ action: "command", command: "uptime" } as ToolRequest, card("systemctl restart app"), fileWrite()])
      await expect(invoke(request)).rejects.toMatchObject({ code: "advice_mode_read_only" });
    expect(typedCount()).toBe(0);
    expect(written).toEqual([]);
    expect(task.status).toBe("running");
  });
});

describe("what still asks whatever the mode", () => {
  it("asks about a command that was asked for from outside sshs3", async () => {
    const { run, ran, unrated } = await hubWith();
    const { task, invoke, waiting, answer } = await run("autonomous", "web", { fromOutside: true });
    const asked = invoke({ action: "command", command: "uptime" });
    const change = await waiting();
    expect(ran("term-web", "uptime")).toBe(false);
    await answer(change, true);
    await expect(asked).resolves.toMatchObject({ exitCode: 0 });
    expect(change).toMatchObject({ status: "completed", decidedHow: "person" });
    const card1 = invoke(card("systemctl restart app"));
    await answer(await waiting(), true);
    await card1;
    expect(task.changes.map((c) => c.decidedHow)).toEqual(["person", "person"]);
    unrated();
  });

  it("asks about a change to sshs3's own rules, and says at once that the settings about commands are gone", async () => {
    const { hub, run, unrated } = await hubWith();
    const { task, invoke, waiting, answer } = await run("autonomous");
    const settings = "sshs3_manage_app_and_settings";
    const asked = invoke({ action: settings, payload: { operation: "update_safety_policy", requireApprovalOnProdTags: false } });
    const change = await waiting();
    expect(change).toMatchObject({ kind: "setting", guard: true });
    expect(hub.safetyPolicy().requireApprovalOnProdTags).toBe(true);
    await answer(change, true);
    await asked;
    expect(hub.safetyPolicy().requireApprovalOnProdTags).toBe(false);

    // A setting that no longer exists is not put to a person: the agent is told there is none.
    const before = task.changes.length;
    for (const gone of ["autoApproveSafeReadOnly", "blockDestructiveWithoutConfirm", "commandAllowPrefixes"])
      await expect(invoke({ action: settings, payload: { operation: "update_safety_policy", [gone]: gone === "commandAllowPrefixes" ? ["rm"] : false } })).rejects.toThrow(
        new RegExp(`sshs3 has no setting ${gone}\\. Nothing was changed\\. Commands are not checked and nobody is asked about them`),
      );
    expect(task.changes).toHaveLength(before);
    expect(task.status).toBe("running");
    unrated();
  });

  it("refuses a terminal command that asks for a dry run, since there is no such option now, and runs nothing", async () => {
    const { run, typedCount } = await hubWith();
    const { invoke } = await run("autonomous");
    const refused = invoke({ action: "command", command: "apt-get upgrade", dryRun: true } as never);
    await expect(refused).rejects.toMatchObject({ code: "dry_run_removed" });
    await expect(refused).rejects.toThrow(/There is no dry run option\. Nothing ran\./);
    expect(typedCount()).toBe(0);
  });
});

describe("what an older version stored about commands", () => {
  const oldStore = () => ({
    version: 1,
    tasks: [
      {
        id: "old-1",
        title: "Clean up",
        mode: "assisted",
        status: "completed",
        messages: [{ id: "m1", role: "user", text: "Clean /tmp", at: 1 }],
        // "Always allow commands that start with": a list the conversation kept.
        sessionAllowPrefixes: ["rm -rf /tmp", "systemctl status"],
        changes: [
          {
            id: "c1",
            kind: "command",
            target: "web-1",
            description: "Clean up",
            command: DELETES,
            status: "completed",
            exitCode: 0,
            riskLevel: "destructive",
            riskReason: "Deletes files recursively",
            parsedSubcommands: [{ command: "rm", args: ["-rf", "/tmp/x"], riskLevel: "destructive" }],
            decidedHow: "person",
            at: 2,
          },
          { id: "c2", kind: "file", target: "web-1", description: "Edit a file", status: "completed", riskLevel: "modify", riskReason: "Writes a file", at: 3 },
        ],
        sources: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        maxCommands: 0,
        maxMinutes: 0,
        verification: "not-verified",
      },
    ],
    memories: [],
    schedules: [],
    history: [],
    inventory: [],
    safetyPolicy: {
      autoApproveSafeReadOnly: false,
      requireApprovalOnProdTags: false,
      blockDestructiveWithoutConfirm: true,
      requirePeerApprovalOnProd: true,
      commandAllowPrefixes: ["systemctl status", "kubectl get"],
      clusterPolicies: { web: { maxMode: "plan" } },
    },
  });

  it("is read without an error, and what it said about a rating of commands is dropped: not kept, not shown, not written back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-old-store-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "hub.json");
    await fs.writeFile(file, JSON.stringify(oldStore()));

    const store = new HubStore(file);
    await store.load();
    // The rules that still exist are kept as they were set.
    expect(store.data.safetyPolicy).toEqual({ requireApprovalOnProdTags: false, requirePeerApprovalOnProd: true, clusterPolicies: { web: { maxMode: "plan" } } });
    const task = store.data.tasks[0];
    expect(task).not.toHaveProperty("sessionAllowPrefixes");
    expect(task.changes).toHaveLength(2);
    for (const change of task.changes) for (const field of ["riskLevel", "riskReason", "parsedSubcommands"]) expect(change).not.toHaveProperty(field);
    // What happened is still on record.
    expect(task.changes[0]).toMatchObject({ id: "c1", command: DELETES, status: "completed", exitCode: 0, decidedHow: "person" });

    await store.save();
    const saved = await fs.readFile(file, "utf8");
    for (const gone of ["riskLevel", "riskReason", "parsedSubcommands", "sessionAllowPrefixes", "autoApproveSafeReadOnly", "blockDestructiveWithoutConfirm", "commandAllowPrefixes"])
      expect(saved).not.toContain(gone);
    expect(saved).toContain(DELETES);
  });

  it("is what a hub starts from: its snapshot shows none of it, and a window of an older version cannot save it back", async () => {
    const { hub, dir } = await hubWith();
    await fs.writeFile(path.join(dir, "hub.json"), JSON.stringify(oldStore()));
    await hub.store.load();
    const shown = JSON.stringify(await hub.snapshot());
    for (const gone of ["riskLevel", "riskReason", "parsedSubcommands", "sessionAllowPrefixes", "autoApproveSafeReadOnly", "blockDestructiveWithoutConfirm", "commandAllowPrefixes"])
      expect(shown).not.toContain(gone);

    await hub.request({ action: "safety-policy-save", policy: { requireApprovalOnProdTags: true, autoApproveSafeReadOnly: true, commandAllowPrefixes: ["rm"], blockDestructiveWithoutConfirm: false } } as never);
    expect(hub.store.data.safetyPolicy).toMatchObject({ requireApprovalOnProdTags: true });
    for (const gone of ["autoApproveSafeReadOnly", "blockDestructiveWithoutConfirm", "commandAllowPrefixes"]) expect(hub.store.data.safetyPolicy).not.toHaveProperty(gone);
  });
});
