import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", async () => {
  const shim = await import("../../src/main/web/electronShim");
  return shim;
});

import type { AgentMode, AgentTask, HubSnapshot } from "../../src/shared/types/aiHub";
import { APP_OPS } from "../../src/main/ai/hub/AppGuard";
import { contextForModel, snapshotText, toolsForTask } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { HubService } from "../../src/main/ai/hub/HubService";
import { maskProviderText } from "../../src/main/ai/hub/privacy";
import { S3WorkspaceSyncService } from "../../src/main/ai/hub/S3WorkspaceSyncService";

/**
 * The team bucket's secret key is for the bucket and for the person who invites a teammate. This walks
 * everything an agent is given about the bucket (the workspace context, the text a conversation starts
 * with, the answer of every management tool) and fails when the invite code or the key is in any of it.
 */

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzzQ9pLmN4v"; // pragma: allowlist secret
const BUCKET = { enabled: true, region: "eu-north-1", bucket: "team-bucket", prefix: "sshs3-workspace", accessKeyId: "TEAMKEYID0000000", secretAccessKey: SECRET, forcePathStyle: true };

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** Where the key would be: as it is, in an invite code, or inside anything that is base64 of text holding it. */
function leaks(text: string): string[] {
  const found: string[] = [];
  if (text.includes(SECRET)) found.push("the secret key as it is");
  if (text.includes(JSON.stringify(SECRET).slice(1, -1)) && !found.length) found.push("the secret key, JSON-escaped");
  if (text.includes("sshs3-s3://")) found.push("an invite code");
  for (const run of text.match(/[A-Za-z0-9_+/=-]{24,}/g) ?? []) {
    // Node reads both base64 alphabets alike. From each of the four places a group of four may begin:
    // what stands before the encoded part is not known.
    for (let from = 0; from < 4; from++) {
      if (Buffer.from(run.slice(from), "base64").toString("utf8").includes(SECRET)) found.push("the secret key inside base64 text");
    }
  }
  return [...new Set(found)];
}
const clean = (what: string, value: unknown): void => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  expect(leaks(text), what).toEqual([]);
};

type Inner = {
  s3Workspace: S3WorkspaceSyncService;
  collectExtraContext: () => Promise<Record<string, unknown>>;
  context: { read: (t: AgentTask, q?: string, s?: string, extra?: unknown) => Record<string, unknown> };
  broker: { issue: (t: AgentTask) => Promise<{ key: string }>; invoke: (key: string, request: { action: string; payload?: unknown }) => Promise<unknown> };
};

async function makeHub(host: Record<string, unknown> = {}): Promise<{ hub: HubService; inner: Inner }> {
  const { HubService: Hub } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-bucket-secret-"));
  const hub = new Hub(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), defaultActorName: "Anna", ...host } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  const inner = hub as unknown as Inner;
  // A connected bucket, without the network: the settings are in place and nothing is contacted.
  (inner.s3Workspace as unknown as { config: Record<string, unknown> }).config = { ...BUCKET };
  return { hub, inner };
}

const aTask = (extra: Partial<AgentTask> = {}): AgentTask =>
  ({ id: `run-${Math.random().toString(36).slice(2, 8)}`, title: "A run", agentName: "Operator", mode: "autonomous" as AgentMode, status: "running", messages: [], changes: [], sources: [], createdAt: Date.now(), updatedAt: Date.now(), maxCommands: 20, maxMinutes: 15, verification: "not-verified", ...extra }) as unknown as AgentTask;

describe("the team bucket's secret key", () => {
  it("is not in the bucket's status, and the leak check itself finds a key where there is one", () => {
    const svc = new S3WorkspaceSyncService(path.join(os.tmpdir(), `bucket-secret-${Date.now()}.json`), {
      getLocalState: async () => ({ actor: "a", servers: [], memories: [], activityLog: [], deletedServerIds: {}, deletedMemoryIds: {}, activeTerminals: [] }),
      applyMergedState: async () => undefined,
      onStateChanged: () => undefined,
    });
    (svc as unknown as { config: Record<string, unknown> }).config = { ...BUCKET };
    const status = svc.getStatus();
    expect(status.configured).toBe(true);
    expect(status).not.toHaveProperty("inviteCode");
    clean("the status", status);
    clean("the status after the provider mask", maskProviderText(JSON.stringify({ s3TeamWorkspace: status }), "standard"));

    // The code is still there for the one who asks for it, and the check above would have found it.
    const code = svc.inviteCode();
    expect(code.startsWith("sshs3-s3://")).toBe(true);
    expect(leaks(JSON.stringify({ code }))).toEqual(["an invite code", "the secret key inside base64 text"]);
    // Also when the prefix that names it is gone.
    expect(leaks(JSON.stringify({ code: code.replace("sshs3-s3://", "") }))).toEqual(["the secret key inside base64 text"]);
    expect(leaks(`key=${SECRET}`)).toEqual(["the secret key as it is"]);
    expect(leaks(Buffer.from(`{"secretAccessKey":"${SECRET}"}`).toString("base64"))).toEqual(["the secret key inside base64 text"]);

    // Without a bucket there is nothing to invite to.
    (svc as unknown as { config: Record<string, unknown> }).config = { ...BUCKET, secretAccessKey: "" };
    expect(() => svc.inviteCode()).toThrow("Connect a team bucket first");
  });

  it("is in nothing a conversation starts with: the context, and the text made of it for every kind of run", async () => {
    const { inner } = await makeHub();
    const extra = await inner.collectExtraContext();
    expect((extra.s3TeamWorkspace as { configured?: boolean }).configured).toBe(true);
    clean("collectExtraContext", extra);
    const kinds: Array<[string, Partial<AgentTask>]> = [
      ["an ordinary conversation", {}],
      ["a ticket's run", { ticketId: "t-1" } as Partial<AgentTask>],
      ["a schedule's run", { scheduleId: "s-1" } as Partial<AgentTask>],
      ["a run asked for from chat", { chat: { service: "slack", channelId: "C1", channelName: "ops", threadId: "1.1", kind: "channel", askedBy: { chatUserId: "U1", name: "Omar" }, fence: { servers: "*", clusters: [], reach: "ask" } } } as Partial<AgentTask>],
    ];
    for (const [name, fields] of kinds) {
      const task = aTask({ mode: "advice", ...fields });
      const context = inner.context.read(task, undefined, undefined, extra);
      clean(`the context of ${name}`, context);
      const text = snapshotText(contextForModel(task, context), 400_000);
      clean(`the snapshot text of ${name}`, text);
      clean(`the masked snapshot text of ${name}`, maskProviderText(text, "standard"));
    }
    // The bucket is in the ordinary conversation's snapshot (so the walk above looked at the right thing), without the key.
    const ordinary = aTask({ mode: "advice" });
    expect(snapshotText(contextForModel(ordinary, inner.context.read(ordinary, undefined, undefined, extra)), 400_000)).toContain("team-bucket");
  }, 60_000);

  it("is in no answer of a management tool", async () => {
    const { hub, inner } = await makeHub();
    // The three operations that contact the bucket answer with its status afterwards. The network part is
    // put aside here; what they answer is what is looked at.
    vi.spyOn(inner.s3Workspace, "syncNow").mockResolvedValue(undefined);
    vi.spyOn(inner.s3Workspace, "configure").mockResolvedValue(undefined);
    vi.spyOn(inner.s3Workspace, "disconnect").mockResolvedValue(undefined);
    const task = aTask();
    hub.store.data.tasks.push(task);
    const { key } = await inner.broker.issue(task);
    const answered: string[] = [];
    const call = async (tool: string, payload: Record<string, unknown>): Promise<void> => {
      const name = `${tool} ${String(payload.operation)}`;
      const asked = inner.broker.invoke(key, { action: tool, payload });
      // One that asks a person first is answered yes, as the approval card would.
      const approving = (async () => {
        for (let i = 0; i < 400; i++) {
          const waiting = task.changes.find((c) => c.status === "pending");
          if (waiting) await hub.request({ action: "approve", taskId: task.id, changeId: waiting.id, approved: true }).catch(() => undefined);
          if (await Promise.race([asked.then(() => true, () => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10))])) return;
        }
      })();
      // A refusal's words go to the model too.
      const result = await asked.then((value) => value, (err: Error) => ({ refused: err.message }));
      await approving;
      answered.push(name);
      clean(`the answer of ${name}`, result);
      clean(`the masked answer of ${name}`, maskProviderText(JSON.stringify(result ?? null), "standard"));
    };

    // Everything the bucket's own tool answers with.
    const sync = "sshs3_manage_s3_and_sync";
    await call(sync, { operation: "status" });
    await call(sync, { operation: "sync_now" });
    await call(sync, { operation: "configure_s3_workspace", bucket: "team-bucket", accessKeyId: "TEAMKEYID0000000" });
    await call(sync, { operation: "disconnect_s3_workspace" });
    await call(sync, { operation: "list_dir_sync_profiles" });
    // Every operation of every management tool that only reads. The ones that start a run of their own
    // (an investigation, a workforce) answer with that run's words and not with the app's state.
    const startsARun = new Set(["sshs3_investigate investigate", "sshs3_agent_and_mcp_manage run_workforce"]);
    const offered = new Set(toolsForTask(task).map((t) => t.name));
    for (const [tool, { ops }] of Object.entries(APP_OPS)) {
      if (!offered.has(tool)) continue;
      for (const [op, kind] of Object.entries(ops)) {
        if (kind !== "read" || startsARun.has(`${tool} ${op}`)) continue;
        await call(tool, { operation: op });
      }
    }
    expect(answered).toEqual(expect.arrayContaining([`${sync} status`, "sshs3_manage_app_and_settings get_state", "sshs3_manage_alerts_and_integrations status"]));
    expect(answered.length).toBeGreaterThan(15);
    // The status tool did answer about this bucket.
    const status = (await inner.broker.invoke(key, { action: sync, payload: { operation: "status" } })) as { s3TeamWorkspace: { bucket: string; configured: boolean } };
    expect(status.s3TeamWorkspace).toMatchObject({ bucket: "team-bucket", configured: true });
    const state = (await inner.broker.invoke(key, { action: "sshs3_manage_app_and_settings", payload: { operation: "get_state" } })) as { s3TeamWorkspace: { bucket: string } };
    expect(state.s3TeamWorkspace.bucket).toBe("team-bucket");
  }, 120_000);

  it("is given to the person who asks for the invite code, and no tool of an agent's makes that request", async () => {
    const { hub } = await makeHub();
    const snap = await hub.snapshot();
    clean("what the interface is given", snap);
    expect(snap.s3Workspace).toMatchObject({ configured: true, canInvite: true });
    const answer: HubSnapshot = await hub.request({ action: "workspace-s3-invite" });
    const code = answer.reply?.s3Invite?.code ?? "";
    expect(JSON.parse(Buffer.from(code.replace("sshs3-s3://", ""), "base64url").toString("utf8"))).toMatchObject({ bucket: "team-bucket", secretAccessKey: SECRET });
    // Apart from the reply itself, the answer holds nothing of it.
    clean("the snapshot that came with the code", { ...answer, reply: undefined });

    // The request is the interface's. Nothing that answers a tool call names it.
    const hubDir = path.join(__dirname, "../../src/main/ai/hub");
    for (const file of ["AppActions.ts", "AppSettingsActions.ts", "AppGuard.ts", "ToolBroker.ts", "DirectAgentRuntime.ts", "toolSchemas.ts", "../../web/mcp/mcpTools.ts"]) {
      expect(await fs.readFile(path.join(hubDir, file), "utf8"), file).not.toContain("workspace-s3-invite");
    }
  }, 60_000);

  it("on a team server, is refused to a member who is not an administrator", async () => {
    const member = await makeHub({ alertHookOwner: "u2", soleUser: () => false, teamAdmin: () => false });
    const view = (await member.hub.snapshot()).s3Workspace!;
    expect(view).toMatchObject({ configured: true, canInvite: false });
    clean("what a member's interface is given", await member.hub.snapshot());
    await expect(member.hub.request({ action: "workspace-s3-invite" })).rejects.toThrow("Only an administrator of this server can copy the team bucket's invite code.");
    clean("a member's context", await member.inner.collectExtraContext());

    const admin = await makeHub({ alertHookOwner: "u1", soleUser: () => false, teamAdmin: () => true });
    expect((await admin.hub.snapshot()).s3Workspace).toMatchObject({ configured: true, canInvite: true });
    expect((await admin.hub.request({ action: "workspace-s3-invite" })).reply?.s3Invite?.code.startsWith("sshs3-s3://")).toBe(true);
    // An administrator's agent is given no more than a member's.
    clean("an administrator's context", await admin.inner.collectExtraContext());
  }, 60_000);
});
