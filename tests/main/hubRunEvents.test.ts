import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubRunEvent } from "../../src/main/ai/hub/areas/chatRuns";
import type { HubService } from "../../src/main/ai/hub/HubService";
import type { AgentTask, ChatOrigin, WorkspaceServerSummary } from "../../src/shared/types/aiHub";
import { fakeOpenAi, type FakeModelRequest, type FakeModelStep } from "../helpers/fakeOpenAi";

/**
 * Following a run with nobody at a browser: the chat agent posts in a thread what a run asks, how a
 * person answered, its plan and its end, and reads the answer from what the hub stored (masked), never
 * from the model's stream. A person who linked their chat account answers from the thread: their vote
 * is theirs, and their answer to a plan counts as the owner's would.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposals.splice(0)) await dispose();
});

const server = (id: string, name: string, host: string): WorkspaceServerSummary =>
  ({ id, name, host, port: 22, username: "ops", shared: true }) as WorkspaceServerSummary;
const WEB_1 = server("srv-web-1", "web-1", "10.0.0.11");
const WEB_10 = server("srv-web-10", "web-10", "10.0.0.12");

const origin = (reach: ChatOrigin["fence"]["reach"], over: Partial<ChatOrigin> = {}, servers: string[] = ["web-1"]): ChatOrigin => ({
  service: "slack",
  channelId: "C-OPS",
  channelName: "ops",
  threadId: "1700000000.000100",
  kind: "channel",
  askedBy: { chatUserId: "U-OMAR", name: "Omar Lind" },
  fence: { servers, clusters: [], reach },
  ...over,
});

const MARIA = { id: "u-maria", name: "Maria Ek", via: "slack" as const };
const LINA = { id: "u-lina", name: "Lina Berg", via: "slack" as const };

const said = (request: FakeModelRequest): string => JSON.stringify(request.messages);
/** Whether the model was given a tool's answer after the first place `marker` was said. */
const toolAfter = (request: FakeModelRequest, marker: string): boolean => {
  const text = said(request);
  const at = text.indexOf(marker);
  return at >= 0 && text.indexOf('"role":"tool"', at) > at;
};

interface HubOptions {
  servers?: WorkspaceServerSummary[];
  /** More of the host: a server several people share, a check of who may still approve. */
  host?: Record<string, unknown>;
  /** A person's own tab on web-1, open in the same account, showing this. */
  personTab?: string;
}

async function hubWithModel(script: (request: FakeModelRequest) => FakeModelStep, options: HubOptions = {}) {
  const model = await fakeOpenAi(script);
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-run-events-"));
  const servers = options.servers ?? [WEB_1];
  const typed: string[] = [];
  const opened: string[] = [];
  let count = 0;
  // The host's terminal reaches the hub by this name once it is made.
  // eslint-disable-next-line prefer-const -- the host's terminals need the hub, made just below
  let hub: HubService;
  const answering = async (id: string, srv: WorkspaceServerSummary, shows = ""): Promise<void> => {
    hub.terminals.register({ id, label: srv.name, kind: "ssh", profileId: srv.id }, (data) => {
      const nonce = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (!nonce) return;
      typed.push(data);
      queueMicrotask(() => hub.terminals.feed(id, `\x1b]777;SSHS3;${nonce};BEGIN\x07done\r\n\x1b]777;SSHS3;${nonce};END;0;/home/ops\x07`));
    });
    hub.terminals.feed(id, `${shows}ops@${srv.name}:~$ `);
    await hub.terminals.ensureReady(id, "bash");
  };
  hub = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => servers,
      // No window is connected: there is no `delta` to stream to.
      openServerTerminal: async (profileId: string) => {
        const srv = servers.find((s) => s.id === profileId)!;
        opened.push(profileId);
        const id = `chat-term-${++count}`;
        await answering(id, srv);
        return id;
      },
      closeSession: () => {},
      ...options.host,
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    await model.close();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  // A server several people share never calls its own address: the model here is on this machine.
  if (options.host?.soleUser) (hub as unknown as { outboundGuard(): object }).outboundGuard = () => ({ server: false, allowPrivate: true });
  await hub.request({
    action: "configure",
    config: { enabled: true, provider: "openai-compatible", model: "fake-1", baseUrl: model.url, apiKey: "not-a-real-key" },
    preferences: { proposeMemories: false },
  });
  if (options.personTab !== undefined) await answering("person-1", WEB_1, options.personTab);
  const events: HubRunEvent[] = [];
  const stop = hub.onRun((event) => events.push(event));
  disposals.unshift(stop);
  const ended = async (task: AgentTask): Promise<void> => {
    await vi.waitFor(() => expect(["completed", "failed", "interrupted"]).toContain(task.status), { timeout: 10_000 });
    await hub.whenSettled(task);
  };
  return { hub, model, events, typed, opened, ended };
}

/**
 * A change card for the restart: what a person is asked about. A plain command would run at once,
 * with nobody asked. The terminals of these tests print "done" for everything, so that is what the
 * check expects.
 */
const RESTART_CARD = {
  command: "sudo systemctl restart nginx",
  description: "Restart the web server",
  check: { command: "systemctl is-active nginx", expected: "done" },
  rollback: "sudo systemctl stop nginx",
};
/** The plan's one step is that card: with its check, what the check should show, and its rollback. */
const PLAN_STEPS = [
  { action: "Restart nginx", target: "web-1", command: RESTART_CARD.command, risk: "low", check: RESTART_CARD.check.command, checkExpected: RESTART_CARD.check.expected, rollback: RESTART_CARD.rollback },
];
const APPROVED = "[sshs3] The user approved your plan.";

/**
 * A model that proposes a plan to restart nginx, and once it is approved makes exactly the step's
 * change card and then says it is done. Its reviewer looks at the workspace first.
 */
const planModel = (request: FakeModelRequest): FakeModelStep => {
  const text = said(request);
  if (text.includes("You review an operations plan"))
    return text.includes('"role":"tool"') ? { text: '{"verdict":"approve","findings":[]}' } : { tool: "workspace_context", args: {} };
  if (text.includes(APPROVED))
    return toolAfter(request, APPROVED)
      ? { text: "Done as planned." }
      : { tool: "sshs3_change", args: { ...RESTART_CARD, description: "Restart nginx" } };
  if (text.includes("Use reload, not restart")) return { text: "I will propose a reload instead." };
  return text.includes('"role":"tool"')
    ? { text: "Here is the plan. Approve it in the thread." }
    : { tool: "sshs3_plan_propose", args: { goal: "nginx serves again on web-1", steps: PLAN_STEPS } };
};

describe("following a chat run without a browser", () => {
  it("tells what the run asks once it can be answered, and how it was answered once the change says so", async () => {
    const { hub, events, typed, ended } = await hubWithModel((request) =>
      said(request).includes('"role":"tool"')
        ? { text: "Restarted nginx on web-1. The key in the log was AKIAIOSFODNN7EXAMPLE, rotate it." }
        : { tool: "sshs3_change", args: RESTART_CARD },
    );
    // What a listener finds at the moment it is told: the question is out, the answer is written.
    const seen: { waiting?: boolean; pendingAtAnswer?: string[] } = {};
    hub.onRun((event) => {
      if (event.type === "asking") seen.waiting = hub.chatApprovalSubject(event.taskId, event.changeId).waiting;
      if (event.type === "answered" && event.final) seen.pendingAtAnswer = hub.runView(event.taskId).pending.map((p) => p.id);
    });
    const task = await hub.startFromChat({ prompt: "Restart nginx on web-1 please", mode: "autonomous" }, origin("ask"));
    // Never on its own from chat, and the channel's words are from outside.
    expect(task.mode).toBe("assisted");
    expect(task.tainted).toBe(true);
    expect(task.target?.label).toBe("web-1");
    expect(task.messages[0].text).toContain("Omar Lind asked you in #ops on Slack.");
    // Lists show what was asked, not the preface before it.
    expect(task.title).toBe("Restart nginx on web-1 please");

    await vi.waitFor(() => expect(events.some((e) => e.type === "asking")).toBe(true), { timeout: 10_000 });
    const asking = events.find((e) => e.type === "asking") as Extract<HubRunEvent, { type: "asking" }>;
    expect(seen.waiting).toBe(true);
    expect(hub.chatApprovalSubject(task.id, asking.changeId)).toMatchObject({ kind: "change", setting: false, waiting: true, requiredApprovals: 1, targetTags: [] });
    const view = hub.runView(task.id);
    expect(view.status).toBe("waiting");
    expect(view.pending).toEqual([
      expect.objectContaining({ id: asking.changeId, command: "sudo systemctl restart nginx", target: "web-1", requiredApprovals: 1, check: RESTART_CARD.check, rollback: RESTART_CARD.rollback }),
    ]);
    // Nothing rates the change: what is given to the card carries no risk.
    expect(view.pending[0]).not.toHaveProperty("riskLevel");
    expect(view.pending[0]).not.toHaveProperty("riskReason");
    expect(typed.some((d) => d.includes("systemctl restart"))).toBe(false);
    expect(events.some((e) => e.type === "progress")).toBe(true);

    // A change to sshs3's own rules is not answered from a thread.
    task.changes.push({ id: "rules-1", kind: "setting", target: "sshs3", description: "Loosen the rules", status: "pending", at: Date.now() });
    await expect(hub.approveFromChat(task.id, "rules-1", true, MARIA)).rejects.toThrow(/answered in the app/);
    expect(hub.chatApprovalSubject(task.id, "rules-1")).toMatchObject({ kind: "change", setting: true, waiting: false });
    task.changes = task.changes.filter((c) => c.id !== "rules-1");

    const resolved = await hub.approveFromChat(task.id, asking.changeId, true, MARIA);
    expect(resolved).toBe(true);
    const change = task.changes.find((c) => c.id === asking.changeId)!;
    expect(change.approvals).toEqual([expect.objectContaining({ actor: "Maria Ek", actorId: "user:u-maria", allowed: true, peer: true, via: "slack" })]);
    expect(change.decidedBy).toMatchObject({ name: "Maria Ek", allowed: true });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "answered", taskId: task.id, changeId: asking.changeId, allowed: true, how: "person", final: true }),
    );
    expect(seen.pendingAtAnswer).toEqual([]);

    await ended(task);
    expect(task.status).toBe("completed");
    expect(typed.some((d) => d.includes("systemctl restart nginx"))).toBe(true);
    expect(events).toContainEqual({ type: "settled", taskId: task.id, status: "completed" });
    // A piece of the stream is never news: the model streamed its answer, and no event said so.
    expect(events.some((e) => e.type === "progress" && e.event === "message.delta")).toBe(false);
    const done = hub.runView(task.id);
    expect(done.text).toContain("Restarted nginx on web-1.");
    expect(done.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(done.pending).toEqual([]);
    expect(done.lastStep?.name).toBe("sshs3_change");
  }, 30_000);

  it("masks every text it gives, and gives no hash of a plan's raw command", async () => {
    const { hub } = await hubWithModel(() => ({ text: "ok" }));
    const secret = "AKIAIOSFODNN7EXAMPLE";
    hub.store.data.tasks.push({
      id: "masked",
      title: `Rotate ${secret}`,
      mode: "plan",
      status: "waiting",
      chat: origin("plan"),
      messages: [],
      changes: [
        {
          id: "c-masked",
          kind: "command",
          target: "web-1",
          description: `Write ${secret} into the config`,
          command: "echo [redacted] > /etc/app.key",
          blastRadius: `Everything that reads ${secret}`,
          status: "pending",
          at: 1,
        },
      ],
      plan: {
        id: "plan-masked",
        goal: `Rotate ${secret}`,
        steps: [{ action: `Write ${secret}`, target: "web-1", command: "echo [redacted] > /etc/app.key", risk: "low", check: "true", commandHash: "f".repeat(64), approvedTarget: '["s","g"]' }],
        status: "proposed",
        revision: 1,
        review: { verdict: "revise", findings: [`It leaks ${secret}`] },
        createdAt: 1,
      },
      sources: [],
      createdAt: 1,
      updatedAt: 1,
      maxCommands: 0,
      maxMinutes: 0,
      verification: "not-verified",
    });
    const view = hub.runView("masked");
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.pending[0].id).toBe("c-masked");
    expect(view.plan?.id).toBe("plan-masked");
    expect(view.plan?.steps[0]).not.toHaveProperty("commandHash");
    expect(view.plan?.steps[0]).not.toHaveProperty("approvedTarget");
    expect(view.plan?.steps[0]).toMatchObject({ target: "web-1", command: "echo [redacted] > /etc/app.key" });
  });

  it("tells a proposed plan, and a linked person's approval runs its steps as the owner's would", async () => {
    const { hub, model, events, typed, ended } = await hubWithModel(planModel, { personTab: "PERSON-TAB-MARKER\r\n" });
    const task = await hub.startFromChat({ prompt: "Fix nginx on web-1", mode: "assisted" }, origin("plan"));
    expect(task.mode).toBe("plan");
    await ended(task);
    expect(task.plan?.status).toBe("proposed");
    const planId = task.plan!.id;
    expect(events).toContainEqual({ type: "plan", taskId: task.id, planId, status: "proposed" });
    expect(hub.runView(task.id).plan).toMatchObject({ id: planId, goal: "nginx serves again on web-1", status: "proposed", requiredApprovals: 1 });
    expect(hub.chatApprovalSubject(task.id, planId)).toMatchObject({ kind: "plan", requiredApprovals: 1, waiting: true, setting: false });
    // The reviewer read the workspace for the conversation, inside its fence: not the person's tab.
    const reviewed = model.requests.map((r) => said(r as FakeModelRequest)).filter((t) => t.includes("You review an operations plan") && t.includes('"role":"tool"'));
    expect(reviewed.length).toBeGreaterThan(0);
    for (const text of reviewed) {
      expect(text).not.toContain("person-1");
      expect(text).not.toContain("PERSON-TAB-MARKER");
    }
    // What the reviewer used is the conversation's to pay from the chat's budget, kept apart from its own usage.
    const reviewer = hub.store.data.tasks.find((t) => t.id !== task.id && t.title.includes("Plan reviewer"))!;
    const reviewerTokens = (reviewer.usage?.inputTokens ?? 0) + (reviewer.usage?.outputTokens ?? 0);
    expect(reviewerTokens).toBeGreaterThan(0);
    expect(task.chatBackgroundTokens).toBe(reviewerTokens);

    // A card stays in the thread: pressed for a plan that is no longer the one waiting, it answers nothing.
    await expect(hub.decidePlanFromChat(task.id, "plan-old", true, MARIA)).rejects.toThrow(/replaced/);
    expect(task.plan?.status).toBe("proposed");

    const before = model.requests.length;
    const eventsBefore = events.length;
    await hub.decidePlanFromChat(task.id, planId, true, MARIA, { note: "Go ahead." });
    expect(events).toContainEqual({ type: "plan", taskId: task.id, planId, status: "approved" });
    expect(task.plan?.approvals).toEqual([expect.objectContaining({ actor: "Maria Ek", actorId: "user:u-maria", via: "slack", peer: true })]);
    // As the owner's would: the note goes to the agent, and the run starts again.
    expect(task.plan?.decisionNote).toBe("Go ahead.");
    expect(task.messages.some((m) => m.role === "system" && m.text === "Maria Ek approved in Slack.")).toBe(true);
    await ended(task);
    expect(model.requests.length).toBeGreaterThan(before);
    expect(said(model.requests.at(-1) as FakeModelRequest)).toContain("The user added: Go ahead.");
    // The step ran on the terminal opened again for the conversation, without asking again.
    expect(typed.some((d) => d.includes("systemctl restart nginx"))).toBe(true);
    expect(events.slice(eventsBefore).some((e) => e.type === "asking" && e.taskId === task.id)).toBe(false);
    expect(task.plan?.steps[0].ranAt).toBeTypeOf("number");
    expect(hub.runView(task.id).text).toBe("Done as planned.");
    expect(events.filter((e) => e.type === "settled" && e.taskId === task.id)).toHaveLength(2);
    // The reviewer is the hub's own background run: nothing of it is told.
    expect(events.every((e) => e.taskId === task.id)).toBe(true);
  }, 30_000);

  it("does not run a plan's step when the person who approved it may no longer approve there", async () => {
    let eligible = true;
    const { hub, typed, ended } = await hubWithModel(planModel, { host: { peerStillEligible: () => eligible } });
    const task = await hub.startFromChat({ prompt: "Fix nginx on web-1", mode: "assisted" }, origin("plan"));
    await ended(task);
    const planId = task.plan!.id;
    // Approved, and then the person was unlinked or taken out of the approvers before the step ran.
    eligible = false;
    await hub.decidePlanFromChat(task.id, planId, true, MARIA);
    await ended(task);
    expect(typed.some((d) => d.includes("systemctl restart nginx"))).toBe(false);
    const step = task.changes.find((c) => c.command === "sudo systemctl restart nginx");
    expect(step).toMatchObject({ status: "denied" });
    expect(step?.approvals).toEqual([expect.objectContaining({ actorId: "user:u-maria", peer: true })]);
    expect(task.plan?.steps[0].ranAt).toBeUndefined();
  }, 30_000);

  it("sends the agent back to revise when a linked person says no with a note, as the owner's no would", async () => {
    const { hub, model, events, ended } = await hubWithModel(planModel);
    const task = await hub.startFromChat({ prompt: "Fix nginx on web-1", mode: "assisted" }, origin("plan"));
    await ended(task);
    const planId = task.plan!.id;
    const before = model.requests.length;
    await hub.decidePlanFromChat(task.id, planId, false, MARIA, { note: "Use reload, not restart" });
    expect(task.plan?.status).toBe("rejected");
    expect(events).toContainEqual({ type: "plan", taskId: task.id, planId, status: "rejected" });
    expect(task.messages.some((m) => m.role === "system" && m.text === "Maria Ek did not approve this plan in Slack.")).toBe(true);
    await ended(task);
    expect(model.requests.length).toBeGreaterThan(before);
    expect(said(model.requests.at(-1) as FakeModelRequest)).toContain("Use reload, not restart");
    expect(events.filter((e) => e.type === "settled" && e.taskId === task.id)).toHaveLength(2);
  }, 30_000);
});

describe("what a button in a thread answers", () => {
  it("reads the tags of the server a change runs on, and says production for a plan there", async () => {
    const prodWeb = { ...WEB_1, tags: ["production"] } as WorkspaceServerSummary;
    const db = server("srv-db-1", "db-1", "10.0.0.21");
    const { hub, events, ended } = await hubWithModel(
      (request) => {
        const text = said(request);
        if (text.includes("You review an operations plan")) return { text: '{"verdict":"approve","findings":[]}' };
        if (text.includes("Plan the restart")) return text.includes('"role":"tool"') ? { text: "Plan ready." } : { tool: "sshs3_plan_propose", args: { goal: "nginx on web-1", steps: PLAN_STEPS } };
        return text.includes('"role":"tool"')
          ? { text: "Not restarted." }
          : { tool: "sshs3_change", args: { command: "sudo systemctl restart postgresql", description: "Restart the database", check: { command: "pg_isready", expected: "done" }, rollback: "sudo systemctl stop postgresql", sessionId: "db-1" } };
      },
      { servers: [prodWeb, db] },
    );
    const fence = ["web-1", "db-1"];
    // The run's first terminal is on web-1, which is production; the change runs on db-1, which is not.
    const task = await hub.startFromChat({ prompt: "Restart postgres, starting from web-1", mode: "assisted" }, origin("ask", {}, fence));
    expect(task.target?.label).toBe("web-1");
    await vi.waitFor(() => expect(events.some((e) => e.type === "asking")).toBe(true), { timeout: 10_000 });
    const { changeId } = events.find((e) => e.type === "asking") as Extract<HubRunEvent, { type: "asking" }>;
    const subject = hub.chatApprovalSubject(task.id, changeId);
    expect(subject.kind).toBe("change");
    expect(subject.targetTags).not.toContain("production");
    await hub.approveFromChat(task.id, changeId, false, MARIA);
    await ended(task);

    const planning = await hub.startFromChat({ prompt: "Plan the restart of nginx on web-1", mode: "assisted" }, origin("plan", {}, fence));
    await ended(planning);
    const plan = hub.chatApprovalSubject(planning.id, planning.plan!.id);
    expect(plan.kind).toBe("plan");
    expect(plan.targetTags).toContain("production");
    expect(plan.requiredApprovals).toBe(1);
  }, 30_000);
});

describe("answers that need two people in a thread", () => {
  const shared = {
    alertHookOwner: "owner-1",
    soleUser: () => false,
    teamAdmin: () => true,
    peerApproval: () => true,
  };

  it("keeps the first approver's note and choice when the second completes a plan", async () => {
    const { hub, events, ended } = await hubWithModel(planModel, { host: shared });
    hub.store.data.safetyPolicy = { ...hub.safetyPolicy(), clusterPolicies: { "web-1": { requiredApprovals: 2 } } };
    const task = await hub.startFromChat({ prompt: "Fix nginx on web-1", mode: "assisted" }, origin("plan"));
    await ended(task);
    const planId = task.plan!.id;
    expect(hub.chatApprovalSubject(task.id, planId)).toMatchObject({ kind: "plan", requiredApprovals: 2 });

    await hub.decidePlanFromChat(task.id, planId, true, MARIA, { note: "Only web-1, do not touch the config.", askEach: true });
    expect(task.plan?.status).toBe("proposed");
    expect(task.plan?.askEach).toBe("person");
    expect(events.filter((e) => e.type === "plan" && e.planId === planId && e.status === "proposed").length).toBeGreaterThanOrEqual(2);
    await expect(hub.decidePlanFromChat(task.id, planId, true, MARIA)).rejects.toThrow(/already approved/);

    await hub.decidePlanFromChat(task.id, planId, true, LINA);
    expect(task.plan?.status).toBe("approved");
    // The one who answered last neither drops what the first wrote nor undoes their choice.
    expect(task.plan?.askEach).toBe("person");
    expect(task.plan?.decisionNote).toContain("Only web-1, do not touch the config.");
    // And so the step the plan lists is asked about before it runs.
    await vi.waitFor(() => expect(events.some((e) => e.type === "asking" && e.taskId === task.id)).toBe(true), { timeout: 10_000 });
  }, 30_000);

  it("tells a vote that still waits for another person, and the one that completes it", async () => {
    const { hub, events, typed, ended } = await hubWithModel(
      (request) =>
        said(request).includes('"role":"tool"')
          ? { text: "Restarted." }
          : { tool: "sshs3_change", args: RESTART_CARD },
      { host: shared },
    );
    hub.store.data.safetyPolicy = { ...hub.safetyPolicy(), clusterPolicies: { "web-1": { requiredApprovals: 2 } } };
    const task = await hub.startFromChat({ prompt: "Restart nginx on web-1", mode: "assisted" }, origin("ask"));
    await vi.waitFor(() => expect(events.some((e) => e.type === "asking")).toBe(true), { timeout: 10_000 });
    const { changeId } = events.find((e) => e.type === "asking") as Extract<HubRunEvent, { type: "asking" }>;
    expect(hub.chatApprovalSubject(task.id, changeId)).toMatchObject({ requiredApprovals: 2, waiting: true });

    expect(await hub.approveFromChat(task.id, changeId, true, MARIA)).toBe(false);
    expect(events).toContainEqual({ type: "answered", taskId: task.id, changeId, allowed: true, how: "person", final: false });
    expect(typed.some((d) => d.includes("systemctl restart"))).toBe(false);
    expect(await hub.approveFromChat(task.id, changeId, true, LINA)).toBe(true);
    await vi.waitFor(() => expect(events).toContainEqual({ type: "answered", taskId: task.id, changeId, allowed: true, how: "person", final: true }));
    await ended(task);
    expect(typed.some((d) => d.includes("systemctl restart nginx"))).toBe(true);
  }, 30_000);

  it("tells when nobody answered in time", async () => {
    const { hub, events, typed, ended } = await hubWithModel((request) =>
      said(request).includes('"role":"tool"')
        ? { text: "Nobody approved the restart." }
        : { tool: "sshs3_change", args: RESTART_CARD },
    );
    // A wait of a little more than a tenth of a second.
    (hub as unknown as { approvalWaitMinutes(): number }).approvalWaitMinutes = () => 0.002;
    const task = await hub.startFromChat({ prompt: "Restart nginx on web-1", mode: "assisted" }, origin("ask"));
    await ended(task);
    const change = task.changes.find((c) => c.command === "sudo systemctl restart nginx")!;
    expect(change).toMatchObject({ status: "denied", decidedHow: "timeout" });
    expect(events).toContainEqual({ type: "answered", taskId: task.id, changeId: change.id, allowed: false, how: "timeout", final: true });
    expect(typed.some((d) => d.includes("systemctl restart"))).toBe(false);
  }, 30_000);
});

describe("starting a run from chat", () => {
  it("never lets a run asked for from chat go further than its reach, also when it goes on", async () => {
    const { hub, ended } = await hubWithModel(() => ({ text: "ok" }));
    // Not through startFromChat: the hub's own start is held to the reach too.
    const asking = await hub.start({ prompt: "Look at nginx", mode: "autonomous" }, undefined, undefined, undefined, undefined, origin("ask"));
    await ended(asking);
    expect(asking.mode).toBe("assisted");
    const planning = await hub.start({ prompt: "Look at nginx", mode: "autonomous" }, undefined, undefined, undefined, undefined, origin("plan"));
    await ended(planning);
    expect(planning.mode).toBe("plan");
    // Made autonomous later, in the app: the next message from the thread puts it back.
    asking.mode = "autonomous";
    await hub.replyFromChat(asking.id, "go on");
    await ended(asking);
    expect(asking.mode).toBe("assisted");
  }, 30_000);

  it("chooses the server the message names exactly, and none when it names none", async () => {
    const { hub, opened, ended } = await hubWithModel(() => ({ text: "ok" }), { servers: [WEB_1, WEB_10] });
    const both = (over: Partial<ChatOrigin> = {}) => origin("ask", over, ["web-1", "web-10"]);
    const named = await hub.startFromChat({ prompt: "restart nginx on web-10.", mode: "assisted" }, both());
    await ended(named);
    expect(opened).toEqual(["srv-web-10"]);
    expect(named.ownTerminal?.profileId).toBe("srv-web-10");
    const vague = await hub.startFromChat({ prompt: "look at web", mode: "assisted" }, both());
    await ended(vague);
    expect(vague.target).toBeUndefined();
    expect(opened).toEqual(["srv-web-10"]);
    // A linked person's direct message is their own words; an unlinked person's is from outside.
    const linked = await hub.startFromChat({ prompt: "look at web", mode: "assisted" }, both({ kind: "dm", askedBy: { chatUserId: "U-MARIA", name: "Maria Ek", accountId: "u-maria" } }));
    expect(linked.tainted).toBeUndefined();
    const unlinked = await hub.startFromChat({ prompt: "look at web", mode: "assisted" }, both({ kind: "dm" }));
    expect(unlinked.tainted).toBe(true);
    await ended(linked);
    await ended(unlinked);
  }, 30_000);

  it("does not give a conversation asked for from chat to an external agent", async () => {
    const { hub } = await hubWithModel(() => ({ text: "ok" }));
    (hub.store.data.agents ??= []).push({ id: "coder", name: "Coder", role: "r", mission: "m", systemPrompt: "s", defaultMode: "assisted", runnerId: "runner-1", updatedAt: 1 } as never);
    await expect(hub.startFromChat({ prompt: "Fix nginx on web-1", mode: "assisted", agentId: "coder" }, origin("ask"))).rejects.toThrow(/configured model/);
    // Through the hub's own start, it ends before anything runs.
    await expect(hub.start({ prompt: "Fix nginx", mode: "assisted", agentId: "coder" }, undefined, undefined, undefined, undefined, origin("ask"))).rejects.toThrow(
      /configured model/,
    );
    const task = hub.store.data.tasks.find((t) => t.agentId === "coder");
    expect(task?.status).not.toBe("running");
    // An agent this hub does not have is refused, not run on the default prompt without a word.
    await expect(hub.startFromChat({ prompt: "Fix nginx on web-1", mode: "assisted", agentId: "not-here" }, origin("ask"))).rejects.toThrow(/not there any more/);
    expect(hub.store.data.tasks.some((t) => t.agentId === "not-here")).toBe(false);
  }, 30_000);

  it("keeps telling the others when one listener fails, and stops telling one that left", async () => {
    const { hub } = await hubWithModel(() => ({ text: "ok" }));
    const seen: string[] = [];
    hub.onRun(() => {
      throw new Error("broken listener");
    });
    const leave = hub.onRun((e) => seen.push(e.type));
    hub.emitRun({ type: "progress", taskId: "t", event: "tool.result" });
    leave();
    hub.emitRun({ type: "progress", taskId: "t", event: "tool.result" });
    expect(seen).toEqual(["progress"]);
    // Only a conversation asked for from chat is answered from chat.
    hub.store.data.tasks.push({ id: "app", title: "app", mode: "assisted", status: "completed", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 1, maxCommands: 0, maxMinutes: 0, verification: "not-verified" });
    await expect(hub.approveFromChat("app", "c1", true, MARIA)).rejects.toThrow(/not asked for from chat/);
    await expect(hub.decidePlanFromChat("app", "p1", true, MARIA)).rejects.toThrow(/not asked for from chat/);
    await expect(hub.replyFromChat("app", "go on")).rejects.toThrow(/not asked for from chat/);
    expect(() => hub.chatApprovalSubject("app", "c1")).toThrow(/not asked for from chat/);
  }, 30_000);
});
