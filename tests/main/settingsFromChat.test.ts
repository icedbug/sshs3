import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", async () => {
  const shim = await import("../../src/main/web/electronShim");
  return shim;
});

import type { AgentMode, AgentTask, HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { APP_OPS, guardAsk } from "../../src/main/ai/hub/AppGuard";
import { SETTINGS_OPS } from "../../src/main/ai/hub/AppSettingsActions";
import { toolsForTask } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { HubService } from "../../src/main/ai/hub/HubService";
import { setHeadlessUserDataPath } from "../../src/main/web/electronShim";
import { Sshs3WebServer } from "../../src/main/web/WebServer";
import { AgentBotApi } from "../../src/main/web/chatAgent/AgentBotApi";
import type { ChatTransportFactory } from "../../src/main/web/chatAgent/ChatAgentService";
import { startFakeSlack, type FakeSlack } from "../helpers/fakeSlack";

/**
 * Every setting from the conversation: the operations that set up what the settings cards set up, that
 * they wait for a person, and that a secret goes in and comes out through the approval card, never
 * through the model.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  vi.unstubAllGlobals();
});

const known = { agents: [{ id: "a1", name: "Linux SRE", defaultMode: "assisted" as AgentMode }], schedules: [] };
const NEW_TOOLS = ["sshs3_manage_team_chat", "sshs3_manage_alerts_and_integrations"] as const;
/** What a call might bring beside its operation: switches set either way are in their own checks below. */
const CROWDED = { service: "slack", channel: "ops", channelId: "C1", idOrName: "x", name: "x", enabled: false, days: 0, kind: "slack", product: "jira", text: "hello", theme: "dark", readOnly: true, approved: true, guard: false };
const aTask = (extra: Partial<AgentTask> = {}): AgentTask =>
  ({ id: "t", title: "A run", mode: "assisted", status: "running", target: { sessionId: "s", generation: "g", label: "l" }, changes: [], messages: [], sources: [], ...extra }) as unknown as AgentTask;

describe("the settings a conversation can change", () => {
  it("offers every operation this file handles, and classes each one", () => {
    const tools = toolsForTask(aTask());
    for (const [tool, ops] of Object.entries(SETTINGS_OPS)) {
      const offered = (tools.find((t) => t.name === tool)?.parameters as { properties: { operation: { enum: string[] } } }).properties.operation.enum;
      for (const op of ops) {
        expect(offered, `${tool} offers ${op}`).toContain(op);
        expect(APP_OPS[tool].ops[op], `${tool}.${op} has a class`).toBeDefined();
      }
    }
    // The two new tools are wholly these operations.
    for (const tool of NEW_TOOLS) expect(Object.keys(APP_OPS[tool].ops).sort()).toEqual([...SETTINGS_OPS[tool]].sort());
  });

  it("asks a person for every operation classed as one that moves the rules, whatever the call carries", () => {
    for (const [tool, ops] of Object.entries(SETTINGS_OPS)) {
      for (const op of ops) {
        const kind = APP_OPS[tool].ops[op];
        for (const mode of ["autonomous", "assisted", "advice"] as const) {
          // Bare, and with every kind of value a call could bring along: neither talks the question away.
          for (const payload of [{ operation: op }, { operation: op, ...CROWDED }]) {
            const ask = guardAsk(tool, payload, { mode }, known);
            if (kind === "guard") expect(ask, `${tool}.${op} in ${mode}`).toBeDefined();
            if (kind === "read" || kind === "change") expect(ask, `${tool}.${op} in ${mode}`).toBeUndefined();
          }
        }
      }
    }
    // The two that depend on what is asked.
    const chat = "sshs3_manage_team_chat";
    expect(guardAsk(chat, { operation: "context_select_channel", service: "slack", channel: "ops" }, { mode: "autonomous" }, known)?.title).toBe("Let the context bot read one more channel");
    expect(guardAsk(chat, { operation: "context_select_channel", service: "slack", channel: "ops", selected: false }, { mode: "autonomous" }, known)).toBeUndefined();
    expect(guardAsk(chat, { operation: "unlink", service: "slack" }, { mode: "assisted" }, known)).toBeUndefined();
    expect(guardAsk(chat, { operation: "unlink", service: "slack", chatUserId: "U2" }, { mode: "assisted" }, known)).toBeDefined();
    expect(guardAsk(chat, { operation: "unlink", service: "slack" }, { mode: "assisted", tainted: true }, known)).toBeDefined();
    // A delete says what it takes away.
    expect(guardAsk("sshs3_manage_alerts_and_integrations", { operation: "delete_notify_channel", idOrName: "ops" }, { mode: "autonomous" }, known)?.title).toBe("Remove a notification channel from this workspace");
    expect(guardAsk("sshs3_manage_app_and_settings", { operation: "delete_model_profile", idOrName: "fast" }, { mode: "autonomous" }, known)?.title).toBe("Remove a model profile from this workspace");
  });

  it("never offers the model a place to put a secret, and asks for it on the card instead", () => {
    const tools = toolsForTask(aTask());
    const props = (name: string): string[] => Object.keys((tools.find((t) => t.name === name)!.parameters as { properties: Record<string, unknown> }).properties);
    expect(props("sshs3_manage_team_chat")).not.toEqual(expect.arrayContaining(["token"]));
    for (const secret of ["token", "appToken", "apiKey", "secret", "password"]) {
      for (const tool of [...NEW_TOOLS, "sshs3_manage_app_and_settings"]) expect(props(tool), `${tool} has no ${secret}`).not.toContain(secret);
    }
    // A notification channel's address is a secret too: whoever has it can post there.
    expect(props("sshs3_manage_alerts_and_integrations")).not.toContain("url");

    const fields = (tool: string, payload: Record<string, unknown>): string[] => (guardAsk(tool, payload, { mode: "assisted" }, known)?.secrets ?? []).map((f) => f.key);
    expect(fields("sshs3_manage_team_chat", { operation: "agent_connect", service: "slack" })).toEqual(["token", "appToken"]);
    expect(fields("sshs3_manage_team_chat", { operation: "agent_connect", service: "mattermost", baseUrl: "https://chat.acme.se" })).toEqual(["token"]);
    expect(fields("sshs3_manage_team_chat", { operation: "context_connect", service: "slack" })).toEqual(["token"]);
    expect(fields("sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", kind: "slack", name: "ops" })).toEqual(["url"]);
    expect(fields("sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", kind: "webhook", name: "pager" })).toEqual(["url", "secret"]);
    expect(fields("sshs3_manage_alerts_and_integrations", { operation: "atlassian_connect", product: "jira", baseUrl: "https://acme.atlassian.net" })).toEqual(["token"]);
    expect(fields("sshs3_manage_app_and_settings", { operation: "save_model_profile", name: "fast", provider: "openai-compatible", model: "m" })).toEqual(["apiKey"]);

    // The card asks for them whatever the call says, and what it shows is never a secret.
    const carried = guardAsk("sshs3_manage_team_chat", { operation: "agent_connect", service: "slack", token: "xoxb-do-not-show", appToken: "xapp-do-not-show" }, { mode: "assisted" }, known)!;
    expect(carried.secrets?.map((f) => f.key)).toEqual(["token", "appToken"]);
    expect(carried.detail).not.toContain("do-not-show");
  });

  it("gives none of it to a run nobody sits at: asked for from chat, a ticket's, or a schedule's", () => {
    const names = (task: AgentTask): string[] => toolsForTask(task).map((t) => t.name);
    for (const tool of NEW_TOOLS) expect(names(aTask())).toContain(tool);
    const fromChat = aTask({
      chat: { service: "slack", channelId: "C1", channelName: "ops", threadId: "1.1", kind: "channel", askedBy: { chatUserId: "U1", name: "Omar" }, fence: { servers: "*", clusters: [], reach: "ask" } },
    } as Partial<AgentTask>);
    for (const task of [fromChat, aTask({ ticketId: "T-1" } as Partial<AgentTask>), aTask({ scheduleId: "s1" } as Partial<AgentTask>)]) {
      const offered = names(task);
      for (const tool of [...NEW_TOOLS, "sshs3_manage_app_and_settings", "sshs3_agent_and_mcp_manage"]) expect(offered).not.toContain(tool);
    }
  });
});

// ---- through the broker, as a run would --------------------------------------

type Broker = { issue: (t: AgentTask) => Promise<{ key: string }>; invoke: (key: string, request: { action: string; payload?: unknown }) => Promise<unknown> };

async function startRun(hub: HubService, mode: AgentMode = "assisted", id = `run-${Math.random().toString(36).slice(2, 8)}`) {
  const task = { id, title: "A run", agentName: "Operator", mode, status: "running", messages: [], changes: [], sources: [], createdAt: Date.now(), updatedAt: Date.now(), maxCommands: 20, maxMinutes: 15, verification: "not-verified" } as unknown as AgentTask;
  hub.store.data.tasks.push(task);
  const broker = (hub as unknown as { broker: Broker }).broker;
  const { key } = await broker.issue(task);
  const call = (action: string, payload: Record<string, unknown>): Promise<unknown> => {
    const answer = broker.invoke(key, { action, payload });
    // A refusal is looked at where the test expects it: until then it is not an unhandled one.
    answer.catch(() => undefined);
    return answer;
  };
  const pending = async () => {
    await vi.waitFor(() => expect(task.changes.some((c) => c.status === "pending")).toBe(true));
    return task.changes.find((c) => c.status === "pending")!;
  };
  /** The person's answer, as the card sends it: with what they typed, if anything. */
  const approve = (changeId: string, secrets?: Record<string, string>): Promise<HubSnapshot> =>
    hub.request({ action: "approve", taskId: task.id, changeId, approved: true, ...(secrets ? { secrets } : {}) });
  return { task, call, pending, approve };
}

async function makeHub(servers: Array<{ id: string; name: string; host: string }> = []) {
  const { HubService: Hub } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-settings-chat-"));
  const hub = new Hub(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => servers.map((x) => ({ ...x, port: 22, username: "ops", shared: true })),
    } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await hub.initialize();
  return { hub, dir };
}

const KEY = "sk-typed-on-the-card-0123456789"; // pragma: allowlist secret

describe("a secret a setting needs", () => {
  it("is typed on the approval card and reaches the setting, without ever being in the conversation", async () => {
    const { hub, dir } = await makeHub();
    const { task, call, pending, approve } = await startRun(hub);
    const asked = call("sshs3_manage_app_and_settings", { operation: "save_model_profile", name: "Fast", provider: "openai-compatible", model: "small-1", baseUrl: "https://llm.internal.example/v1", activeRole: "fastTriage" });
    const change = await pending();
    expect(change).toMatchObject({ kind: "setting", guard: true, description: "Add or change a model profile", secretFields: [{ key: "apiKey", label: "the API key", optional: true }] });
    expect(change.command).toContain("baseUrl: https://llm.internal.example/v1");
    // Nothing is saved while it waits.
    expect((await hub.snapshot()).config.profiles ?? []).toEqual([]);

    await approve(change.id, { apiKey: KEY });
    const result = (await asked) as { ok: boolean; profile?: { name: string; hasApiKey?: boolean }; activeProfileByRole: Record<string, string> };
    expect(result.ok).toBe(true);
    expect(result.profile).toMatchObject({ name: "Fast", hasApiKey: true });
    const saved = (await hub.snapshot()).config.profiles!.find((x) => x.name === "Fast")!;
    expect(result.activeProfileByRole.fastTriage).toBe(saved.id);
    expect(change.status).toBe("completed");
    // The card's fields are gone with the answer, and the key is in none of what the model or the record sees.
    expect(change.secretFields).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(task)).not.toContain(KEY);
    await hub.store.save();
    // Every file the hub wrote, in every folder: the audit log is where a setting change is written down.
    // The model settings file keeps the key itself, encrypted, and is the one place it belongs.
    const files = (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile()).map((f) => path.join(f.parentPath, f.name));
    expect(files.some((f) => f.includes(`${path.sep}audit${path.sep}`))).toBe(true);
    for (const file of files) if (path.basename(file) !== "ai.json") expect(await fs.readFile(file, "utf8"), file).not.toContain(KEY);
    // Nothing typed is left behind in memory.
    expect((hub as unknown as { changeSecrets: Map<string, unknown> }).changeSecrets.size).toBe(0);
  });

  it("is not kept when the answer finds nothing waiting, or when the person says no", async () => {
    const { hub } = await makeHub();
    const secrets = (hub as unknown as { changeSecrets: Map<string, unknown> }).changeSecrets;
    const { task, call, pending } = await startRun(hub);
    const asked = call("sshs3_manage_app_and_settings", { operation: "save_model_profile", name: "Fast", provider: "openai-compatible", model: "small-1" });
    const change = await pending();
    // Declined, with something typed: nothing is kept and nothing is saved.
    await hub.request({ action: "approve", taskId: task.id, changeId: change.id, approved: false, secrets: { apiKey: KEY } });
    await expect(asked).rejects.toThrow("Action not approved");
    expect(secrets.size).toBe(0);
    expect((await hub.snapshot()).config.profiles ?? []).toEqual([]);
    // An answer to a change that no longer waits.
    await expect(hub.request({ action: "approve", taskId: task.id, changeId: change.id, approved: true, secrets: { apiKey: KEY } })).rejects.toThrow();
    expect(secrets.size).toBe(0);
  });

  it("survives a second answer in flight: a double press does not take the key away", async () => {
    const { hub } = await makeHub();
    const run = await startRun(hub);
    const asked = run.call("sshs3_manage_app_and_settings", { operation: "save_model_profile", name: "Fast", provider: "openai-compatible", model: "small-1" });
    const change = await run.pending();
    // The same answer twice at once, as a double press or two windows send it. One of them is taken,
    // the other finds nothing waiting. Whichever comes first, the key it carried reaches the setting:
    // the late one must not take away what the first one left for the tool.
    const answers = await Promise.allSettled([run.approve(change.id, { apiKey: KEY }), run.approve(change.id, { apiKey: KEY })]);
    expect(answers.map((a) => a.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(((await asked) as { profile?: { hasApiKey?: boolean } }).profile?.hasApiKey).toBe(true);
    expect((hub as unknown as { changeSecrets: Map<string, unknown> }).changeSecrets.size).toBe(0);
  });

  it("is refused when the call itself carries it, before anybody is asked", async () => {
    const { hub } = await makeHub();
    const run = await startRun(hub);
    // Where a notification channel sends is the whole question: an address in the call would be approved unseen.
    for (const [tool, payload, key] of [
      ["sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", kind: "webhook", name: "ops", includeCommand: true, url: "http://attacker.example/collect" }, "url"],
      ["sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", idOrName: "ops", secret: "s" }, "secret"],
      ["sshs3_manage_alerts_and_integrations", { operation: "atlassian_connect", product: "jira", baseUrl: "https://acme.atlassian.net", token: "t" }, "token"],
      ["sshs3_manage_team_chat", { operation: "agent_connect", service: "slack", token: "xoxb-1", appToken: "xapp-1" }, "token"],
      ["sshs3_manage_team_chat", { operation: "context_connect", service: "slack", token: "xoxb-1" }, "token"],
      ["sshs3_manage_app_and_settings", { operation: "save_model_profile", name: "Fast", provider: "openai-compatible", model: "m", apiKey: KEY }, "apiKey"],
    ] as const)
      await expect(run.call(tool, payload), JSON.stringify(payload)).rejects.toThrow(`Leave "${key}"`);
    expect(run.task.changes).toEqual([]);
    expect((await hub.snapshot()).notifications?.channels ?? []).toEqual([]);
  });

  it("keeps the saved one when the field is left empty, and says so when a new thing needs it", async () => {
    const { hub } = await makeHub();
    const run = await startRun(hub);
    // A new notification channel without its address cannot be made.
    const first = run.call("sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", kind: "slack", name: "ops", events: ["approval", "alert"] });
    const noAddress = await run.pending();
    expect(noAddress.secretFields?.map((f) => f.key)).toEqual(["url"]);
    // A plain yes, as a shortcut or another list would send it, does not answer a change that takes a secret.
    await expect(run.approve(noAddress.id)).rejects.toThrow("This one takes a token or key. Answer it on its card in the conversation.");
    expect(noAddress.status).toBe("pending");
    // Its card always says what was typed, also when that is nothing.
    await run.approve(noAddress.id, {});
    await expect(first).rejects.toThrow("A new channel needs its address");
    expect(noAddress.status).toBe("failed");

    const second = run.call("sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", kind: "slack", name: "ops", events: ["approval", "alert"] });
    const withAddress = await run.pending();
    // An address by number: there is no name to look up where the tests run.
    await run.approve(withAddress.id, { url: "http://127.0.0.1:9/services/T000/B000/do-not-show" });
    const made = (await second) as { channels: Array<Record<string, unknown>> };
    // The model is told the address is saved, in words it cannot read as "missing".
    expect(made.channels).toEqual([expect.objectContaining({ name: "ops", addressSaved: true, addressHost: expect.stringContaining("127.0.0.1"), includeCommand: false, events: ["approval", "alert"] })]);
    expect(made.channels[0]).not.toHaveProperty("hasSecret");
    expect(made.channels[0]).not.toHaveProperty("signingSecretSaved");
    expect(JSON.stringify(made)).not.toContain("do-not-show");

    // Changed by name, with the field left empty: the address stays.
    const third = run.call("sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", idOrName: "ops", alertMinSeverity: "critical" });
    const change = await run.pending();
    await run.approve(change.id, {});
    const changed = (await third) as { channels: Array<Record<string, unknown>> };
    expect(changed.channels).toEqual([expect.objectContaining({ name: "ops", addressHost: expect.stringContaining("127.0.0.1"), alertMinSeverity: "critical" })]);

    // What is set up can be read without asking anybody, and has no address in it.
    const status = (await run.call("sshs3_manage_alerts_and_integrations", { operation: "status" })) as { notifications: { channels: unknown[] } };
    expect(status.notifications.channels).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain("do-not-show");
    expect(run.task.changes.filter((c) => c.status === "pending")).toEqual([]);

    // Removing it is a person's decision too.
    const removal = run.call("sshs3_manage_alerts_and_integrations", { operation: "delete_notify_channel", idOrName: "ops" });
    const gone = await run.pending();
    expect(gone.description).toBe("Remove a notification channel from this workspace");
    await run.approve(gone.id);
    await removal;
    expect((await hub.snapshot()).notifications?.channels).toEqual([]);
  });
});

describe("what the person approves is what is done", () => {
  it("refuses a value of the wrong kind instead of passing it over", async () => {
    const { hub } = await makeHub();
    const run = await startRun(hub);
    for (const [tool, payload, said] of [
      // "false" where false was meant would leave answering on while the card said it goes off.
      ["sshs3_manage_team_chat", { operation: "agent_settings", enabled: "false", dmsEnabled: true }, '"enabled" must be true or false.'],
      // "90" where 90 was meant would remove the limit while the card said 90 days.
      ["sshs3_manage_team_chat", { operation: "context_retention", days: "90" }, '"days" must be a number.'],
      ["sshs3_manage_team_chat", { operation: "context_retention" }, 'context_retention requires "days"'],
      ["sshs3_manage_team_chat", { operation: "agent_set_channel", service: "slack", channelId: 12345 }, '"channelId" must be text.'],
      ["sshs3_manage_alerts_and_integrations", { operation: "facts_configure", exclude: "all" , intervalHours: "6" }, '"intervalHours" must be a number.'],
      ["sshs3_manage_alerts_and_integrations", { operation: "save_notify_channel", kind: "slack", name: "ops", includeCommand: "no" }, '"includeCommand" must be true or false.'],
    ] as const)
      await expect(run.call(tool, payload), JSON.stringify(payload)).rejects.toThrow(said);
    expect(run.task.changes).toEqual([]);
  });

  it("names servers whole, and keeps them out of collection when it says so", async () => {
    const { hub } = await makeHub([
      { id: "srv-1", name: "prod-db-01", host: "10.0.0.1" },
      { id: "srv-2", name: "db-test", host: "10.0.0.2" },
    ]);
    const run = await startRun(hub);
    // A part of a name names nothing: "db" is two servers here.
    await expect(run.call("sshs3_manage_alerts_and_integrations", { operation: "facts_configure", exclude: ["db"] })).rejects.toThrow('No server is called "db"');
    await expect(run.call("sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", name: "k", scopes: ["read", "run"], serverIdOrName: "db" })).rejects.toThrow('No server is called "db"');
    await expect(run.call("sshs3_manage_alerts_and_integrations", { operation: "facts_collect_now", serverIdOrName: "db" })).rejects.toThrow('No server is called "db"');
    expect(run.task.changes).toEqual([]);

    // Named by host: the card shows the server's name, and the list holds its id.
    const asked = run.call("sshs3_manage_alerts_and_integrations", { operation: "facts_configure", exclude: ["10.0.0.1"] });
    const change = await run.pending();
    expect(change.command).toContain('exclude: ["prod-db-01"]');
    expect(change.command).toContain("exclude is the whole list");
    await run.approve(change.id);
    expect(((await asked) as { serverFacts: { exclude: string[] } }).serverFacts.exclude).toEqual(["prod-db-01"]);
    expect((await hub.snapshot()).serverFacts?.exclude).toEqual(["srv-1"]);

    // Collecting now is a person's decision, and never reaches a server that is kept out.
    await expect(run.call("sshs3_manage_alerts_and_integrations", { operation: "facts_collect_now", serverIdOrName: "prod-db-01" })).rejects.toThrow(
      "prod-db-01 is on the list of servers nothing is collected from",
    );
    const collecting = run.call("sshs3_manage_alerts_and_integrations", { operation: "facts_collect_now", serverIdOrName: "db-test" });
    const collect = await run.pending();
    expect(collect.description).toBe("Collect facts from servers now");
    expect(collect.command).toContain("serverIdOrName: db-test");
    await hub.request({ action: "approve", taskId: run.task.id, changeId: collect.id, approved: false });
    await expect(collecting).rejects.toThrow("Action not approved");

    // A key held to a server says which one, whole, on its card.
    const key = run.call("sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", idOrName: "k", scopes: ["read"], serverIdOrName: "10.0.0.2" });
    const made = await run.pending();
    expect(made.command).toContain("name: k");
    expect(made.command).toContain("serverIdOrName: db-test");
    await hub.request({ action: "approve", taskId: run.task.id, changeId: made.id, approved: false });
    await expect(key).rejects.toThrow("Action not approved");
  });

  it("keeps what a change to a connection does not name", async () => {
    const { hub } = await makeHub();
    const run = await startRun(hub);
    // An address by number: there is no name to look up where the tests run.
    const first = run.call("sshs3_manage_alerts_and_integrations", {
      operation: "atlassian_connect", product: "jira", variant: "datacenter", baseUrl: "http://127.0.0.1:9", projects: ["OPS"], doneTransition: "Resolve", closeOnApprove: false,
    });
    await run.approve((await run.pending()).id, { token: "typed-jira-token" });
    expect(((await first) as { connection: Record<string, unknown> }).connection).toMatchObject({ projects: ["OPS"], doneTransition: "Resolve", closeOnApprove: false, enabled: true, hasToken: true });

    // Switched off, and nothing else said: the transition, the closing rule, the projects and the token stay.
    const second = run.call("sshs3_manage_alerts_and_integrations", { operation: "atlassian_connect", product: "jira", enabled: false });
    const change = await run.pending();
    expect(change.command).toContain("What is not named here stays as it is.");
    await run.approve(change.id, {});
    await second;
    expect((await hub.snapshot()).atlassian?.jira).toMatchObject({ enabled: false, projects: ["OPS"], doneTransition: "Resolve", closeOnApprove: false, hasToken: true });
  });

  it("says how long the team's chat is kept in the terms it will be kept", () => {
    const chat = "sshs3_manage_team_chat";
    expect(guardAsk(chat, { operation: "context_retention", days: 30 }, { mode: "assisted" }, known)?.detail).toBe("days: 30\nMessages older than this are removed.");
    expect(guardAsk(chat, { operation: "context_retention", days: 0 }, { mode: "assisted" }, known)?.detail).toBe("days: 0\n0 days: messages are kept until somebody removes them.");
  });

  it("has no way to forget every conversation from inside one", () => {
    // The conversation that asks is itself running, and history is not forgotten while a run is: a person does this in the settings.
    expect(Object.keys(APP_OPS.sshs3_manage_app_and_settings.ops)).not.toContain("forget_history");
    expect(SETTINGS_OPS.sshs3_manage_app_and_settings).not.toContain("forget_history");
  });
});

describe("how long a key the assistant makes lasts", () => {
  it("is 30 days when nothing is said, and for ever only when the request says so; the card says which", async () => {
    const { hub } = await makeHub();
    const { call, pending, approve } = await startRun(hub);
    const day = 24 * 3600_000;
    const plain = call("sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", name: "Thirty days", scopes: ["read"] });
    const plainCard = await pending();
    expect(plainCard.command).toContain("The key works for 30 days.");
    await approve(plainCard.id);
    const made = (await plain) as { key: { expiresAt?: number } };
    expect(made.key.expiresAt! - Date.now()).toBeGreaterThan(29 * day);
    expect(made.key.expiresAt! - Date.now()).toBeLessThanOrEqual(30 * day);

    const endless = call("sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", name: "For ever", scopes: ["read"], neverExpires: true });
    const endlessCard = await pending();
    expect(endlessCard.command).toContain("This key never stops working.");
    await approve(endlessCard.id);
    expect(((await endless) as { key: { expiresAt?: number } }).key.expiresAt).toBeUndefined();
  });
});

describe("a secret a setting makes", () => {
  it("is shown to the person once on the card, and is not in what the model is told", async () => {
    const { hub } = await makeHub();
    const { task, call, pending, approve } = await startRun(hub);
    const asked = call("sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", name: "My laptop agent", scopes: ["read"] });
    const change = await pending();
    expect(change.description).toBe("Make a key that lets another agent reach this app");
    expect(change.command).toContain("shown to you once, on this card");
    await approve(change.id);
    const result = (await asked) as { ok: boolean; note: string; key: unknown };
    expect(result.ok).toBe(true);
    expect(result.note).toContain("You are not given it");
    expect(change.reveal).toEqual({ label: "The new key" });

    // The person asks for it on the card: it comes once.
    const shown = (await hub.request({ action: "change-reveal", taskId: task.id, changeId: change.id })).reply?.changeReveal;
    expect(shown?.label).toBe("The new key");
    expect(shown?.value.length).toBeGreaterThan(20);
    // The model's answer and the stored conversation never held it.
    expect(JSON.stringify(result)).not.toContain(shown!.value);
    expect(JSON.stringify(task)).not.toContain(shown!.value);
    expect(change.reveal).toEqual({ label: "The new key", shown: true });
    const again = (await hub.request({ action: "change-reveal", taskId: task.id, changeId: change.id })).reply?.changeReveal;
    expect(again).toEqual({ label: "The new key", value: "" });

    // The key works: it is the one in the list, and it can be taken back by name.
    const listed = (await call("sshs3_agent_and_mcp_manage", { operation: "list_mcp_keys" })) as { localMcp: { keys: Array<{ name: string }> } };
    expect(listed.localMcp.keys.map((k) => k.name)).toEqual(["My laptop agent"]);
    const revoke = call("sshs3_agent_and_mcp_manage", { operation: "revoke_mcp_key", idOrName: "My laptop agent" });
    await approve((await pending()).id);
    await revoke;
    // A change with nothing to show says so.
    await expect(hub.request({ action: "change-reveal", taskId: task.id, changeId: task.changes.at(-1)!.id })).rejects.toThrow("There is nothing to show");
  });
});

describe("what belongs to a team server", () => {
  it("says so in this app, after the person was asked", async () => {
    const { hub } = await makeHub();
    const run = await startRun(hub);
    // Reading how the bots stand needs nobody's leave, and says the agent bot is not part of this app.
    const status = (await run.call("sshs3_manage_team_chat", { operation: "status" })) as { agentBot: unknown; note?: string };
    expect(status.agentBot).toBeNull();
    expect(status.note).toContain("not part of this app");

    const asked = run.call("sshs3_manage_team_chat", { operation: "agent_settings", enabled: true });
    const change = await run.pending();
    expect(change.description).toBe("Change how the agent bot answers in chat");
    await run.approve(change.id);
    await expect(asked).rejects.toThrow("It is not part of this app");
    expect(change.status).toBe("failed");

    const rules = run.call("sshs3_manage_app_and_settings", { operation: "update_team_rules", requirePeerApprovalOnProd: true });
    const second = await run.pending();
    expect(second.description).toBe("Change the rules for everyone on this server");
    await run.approve(second.id);
    await expect(rules).rejects.toThrow("Rules for everyone belong to a server several people sign in to");
    expect((await run.call("sshs3_manage_app_and_settings", { operation: "get_team_rules" })) as { teamRules: unknown }).toMatchObject({ teamRules: null });
  });

  it("says what a call leaves out before anybody is asked to approve it", async () => {
    const { hub } = await makeHub();
    const run = await startRun(hub);
    for (const [tool, payload, said] of [
      ["sshs3_manage_team_chat", { operation: "agent_connect" }, 'agent_connect requires "service".'],
      ["sshs3_manage_team_chat", { operation: "agent_set_channel", service: "slack" }, 'agent_set_channel requires "channelId".'],
      ["sshs3_manage_team_chat", { operation: "link_code" }, "The agent bot is not connected to Slack or Mattermost here"],
      ["sshs3_manage_alerts_and_integrations", { operation: "atlassian_connect", baseUrl: "https://acme.atlassian.net" }, 'atlassian_connect requires "product".'],
      ["sshs3_manage_alerts_and_integrations", { operation: "delete_notify_channel" }, 'delete_notify_channel requires "idOrName".'],
      ["sshs3_agent_and_mcp_manage", { operation: "set_mcp_tool_policy", serverIdOrName: "grafana" }, 'set_mcp_tool_policy requires "toolName" and "policy".'],
      ["sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", scopes: ["read"] }, 'create_mcp_key requires "name".'],
      // A key held to tools the MCP server does not have could call nothing: a real model once named its own.
      ["sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", name: "x", scopes: ["read"], tools: ["workspace_context", "kb_search"] }, '"workspace_context" is not a tool a key with these scopes can call. They are: list_servers'],
      ["sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", name: "x", scopes: ["read"], tools: ["run_command"] }, '"run_command" is not a tool a key with these scopes can call'],
    ] as const)
      await expect(run.call(tool, payload), JSON.stringify(payload)).rejects.toThrow(said);
    // Nobody was asked about any of them.
    expect(run.task.changes).toEqual([]);

    // A name given where a thing is usually named is taken as the new key's name.
    const asked = run.call("sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", idOrName: "laptop-agent", scopes: ["read"], tools: ["kb_search", "list_servers"] });
    await run.approve((await run.pending()).id);
    expect((await asked) as { ok: boolean; key: { tools?: string[] } }).toMatchObject({ ok: true, key: { tools: ["kb_search", "list_servers"] } });
    const listed = (await run.call("sshs3_agent_and_mcp_manage", { operation: "list_mcp_keys" })) as { localMcp: { keys: Array<{ name: string }> } };
    expect(listed.localMcp.keys.map((k) => k.name)).toEqual(["laptop-agent"]);
  });

  it("refuses a run nobody sits at even when the call arrives all the same", async () => {
    const { hub } = await makeHub();
    for (const extra of [{ ticketId: "T-1" }, { scheduleId: "s1" }]) {
      const run = await startRun(hub);
      Object.assign(run.task, extra);
      for (const [tool, payload] of [
        ["sshs3_manage_alerts_and_integrations", { operation: "status" }],
        ["sshs3_manage_alerts_and_integrations", {}],
        ["sshs3_manage_team_chat", { operation: "agent_settings", enabled: true }],
        ["sshs3_manage_app_and_settings", { operation: "update_team_rules", requirePeerApprovalOnProd: false }],
        ["sshs3_agent_and_mcp_manage", { operation: "create_mcp_key", name: "k" }],
      ] as const)
        await expect(run.call(tool, payload), `${JSON.stringify(extra)} ${JSON.stringify(payload)}`).rejects.toThrow("This run works on its own.");
      expect(run.task.changes).toEqual([]);
    }
  });

  it("does not try an address the call names when the model is tested", async () => {
    const { hub } = await makeHub();
    const probe = vi.spyOn(hub as unknown as { probeModel: (baseUrl?: string) => Promise<unknown> }, "probeModel").mockResolvedValue({ ok: true, detail: "It answers." });
    const run = await startRun(hub);
    expect(await run.call("sshs3_manage_app_and_settings", { operation: "test_model", baseUrl: "http://169.254.169.254/latest" })).toEqual({ ok: true, detail: "It answers." });
    expect(probe).toHaveBeenCalledWith(undefined);
  });
});

// ---- on a server several people sign in to -----------------------------------

describe("the chat bots, set up from a conversation on a team server", () => {
  let tmpDir: string;
  let server: Sshs3WebServer;
  let baseUrl: string;
  let slack: FakeSlack;
  const LOCAL = { server: false, allowPrivate: true };

  async function start(): Promise<void> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-settings-chat-web-"));
    setHeadlessUserDataPath(tmpDir);
    slack = await startFakeSlack();
    const staticDir = path.join(tmpDir, "static");
    await fs.mkdir(staticDir, { recursive: true });
    await fs.writeFile(path.join(staticDir, "index.html"), "<!doctype html><html><body>sshs3 web</body></html>", "utf-8");
    const api = new AgentBotApi({ guard: () => LOCAL });
    api.slackBase = slack.base;
    // Lines are not opened here: only what is saved matters.
    const transport: ChatTransportFactory = () => ({ start: () => undefined, stop: async () => undefined });
    server = new Sshs3WebServer({ port: 0, host: "127.0.0.1", dataDir: tmpDir, staticDir, chatAgent: { api, transport, tryWaitMs: 3000 } });
    baseUrl = `http://127.0.0.1:${(await server.start()).port}`;
    disposals.push(async () => {
      await server.stop();
      await slack.close();
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });
  }

  async function post(urlPath: string, body: unknown, cookie?: string): Promise<{ body: any; cookie: string }> {
    const res = await fetch(`${baseUrl}${urlPath}`, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) throw new Error(json?.error || `HTTP ${res.status}`);
    return { body: json, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" };
  }
  async function hubOf(id: string): Promise<HubService> {
    const user = (await server.auth.listUsers()).find((u) => u.id === id)!;
    return (await server.tenants.getOrCreateTenant(user)).hub;
  }
  async function team(): Promise<{ maria: HubService; omar: HubService; omarId: string; mariaId: string }> {
    const admin = await post("/api/auth/setup", { username: "maria", displayName: "Maria Ek", password: "maria-password-123" }); // pragma: allowlist secret
    const invite = await post("/api/admin/invites", { role: "member", maxUses: 1 }, admin.cookie);
    const made = await post("/api/auth/register-invite", { inviteToken: invite.body.invite.token, username: "omar", displayName: "Omar Lind", password: "omar-password-123" }); // pragma: allowlist secret
    return { maria: await hubOf(admin.body.user.id), omar: await hubOf(made.body.user.id), omarId: made.body.user.id, mariaId: admin.body.user.id };
  }

  it("lets an administrator connect the agent bot and choose its channels, with the tokens typed on the card", async () => {
    await start();
    const { maria } = await team();
    const run = await startRun(maria);

    const connecting = run.call("sshs3_manage_team_chat", { operation: "agent_connect", service: "slack" });
    const connect = await run.pending();
    expect(connect.secretFields?.map((f) => f.key)).toEqual(["token", "appToken"]);
    await run.approve(connect.id, { token: slack.apps.agent.botToken, appToken: slack.apps.agent.appToken });
    const connected = (await connecting) as { ok: boolean; bots: Array<{ service: string }> };
    expect(connected.ok).toBe(true);
    expect(server.chatAnswering.bots.view().map((b) => b.service)).toEqual(["slack"]);
    // The tokens are saved, and in nothing the model was told or the conversation keeps.
    expect(JSON.stringify(connected)).not.toContain(slack.apps.agent.botToken);
    expect(JSON.stringify(run.task)).not.toContain(slack.apps.agent.botToken);
    expect(JSON.stringify(run.task)).not.toContain(slack.apps.agent.appToken);

    // A new channel may only look unless more is said.
    const adding = run.call("sshs3_manage_team_chat", { operation: "agent_set_channel", service: "slack", channelId: "COPSDB", channelName: "#ops-db", servers: ["db-1"] });
    const add = await run.pending();
    expect(add.description).toBe("Let people in a chat channel ask the agent bot");
    expect(server.chatAnswering.answering.settings().channels.slack).toEqual([]);
    await run.approve(add.id);
    await adding;
    expect(server.chatAnswering.answering.settings().channels.slack).toEqual([
      expect.objectContaining({ channelId: "COPSDB", channelName: "ops-db", servers: ["db-1"], reach: "read", approvers: "linked" }),
    ]);

    // A second channel leaves the first as it is; changing the first keeps what was not named.
    const second = run.call("sshs3_manage_team_chat", { operation: "agent_set_channel", service: "slack", channelId: "COPSWEB", channelName: "ops-web", servers: ["*"], reach: "ask", approvers: "admins" });
    await run.approve((await run.pending()).id);
    await second;
    const widen = run.call("sshs3_manage_team_chat", { operation: "agent_set_channel", service: "slack", channelId: "COPSDB", reach: "plan" });
    await run.approve((await run.pending()).id);
    await widen;
    expect(server.chatAnswering.answering.settings().channels.slack).toEqual([
      expect.objectContaining({ channelId: "COPSDB", channelName: "ops-db", servers: ["db-1"], reach: "plan" }),
      expect.objectContaining({ channelId: "COPSWEB", servers: "*", reach: "ask", approvers: "admins" }),
    ]);

    // Answering on, with a limit, in one question.
    const settings = run.call("sshs3_manage_team_chat", { operation: "agent_settings", enabled: true, concurrentRuns: 2, dmsEnabled: true, dmsUnlinked: "off" });
    const set = await run.pending();
    expect(set.command).toContain("enabled: true");
    await run.approve(set.id);
    await settings;
    expect(server.chatAnswering.answering.settings()).toMatchObject({ enabled: true, limits: { concurrentRuns: 2 }, dms: { enabled: true, unlinked: "off" } });

    // Taking a channel away narrows who can ask: it needs no question.
    await run.call("sshs3_manage_team_chat", { operation: "agent_remove_channel", service: "slack", channelId: "COPSWEB" });
    expect(server.chatAnswering.answering.settings().channels.slack.map((r) => r.channelId)).toEqual(["COPSDB"]);

    // The whole picture, without a token in it.
    const status = (await run.call("sshs3_manage_team_chat", { operation: "status" })) as { agentBot: { admin?: unknown } };
    expect(status.agentBot.admin).toBeDefined();
    expect(JSON.stringify(status)).not.toContain(slack.apps.agent.botToken);

    // The rules for everyone, the same way.
    const rules = run.call("sshs3_manage_app_and_settings", { operation: "update_team_rules", requirePeerApprovalOnProd: true, freezeHours: 2, freezeCluster: "db", freezeWhy: "Migration" });
    await run.approve((await run.pending()).id);
    const saved = (await rules) as { teamRules: { requirePeerApprovalOnProd?: boolean; freezes?: Record<string, { why?: string }> } };
    expect(saved.teamRules.requirePeerApprovalOnProd).toBe(true);
    expect(saved.teamRules.freezes?.db).toMatchObject({ why: "Migration" });
  });

  it("holds a member to what a member may do, also when a person approves it", async () => {
    await start();
    const { omar, omarId, mariaId } = await team();
    const run = await startRun(omar);
    for (const [tool, payload, refusal] of [
      ["sshs3_manage_team_chat", { operation: "agent_settings", enabled: true }, "Only an administrator of this server can set up the agent bot."],
      ["sshs3_manage_team_chat", { operation: "agent_copy_model" }, "Only an administrator of this server can set up the agent bot."],
      ["sshs3_manage_app_and_settings", { operation: "update_team_rules", requirePeerApprovalOnProd: false }, "Only an administrator of this server sets the rules that hold for everyone."],
    ] as const) {
      const asked = run.call(tool, payload);
      const change = await run.pending();
      await run.approve(change.id);
      await expect(asked, JSON.stringify(payload)).rejects.toThrow(refusal);
      expect(change.status).toBe("failed");
    }
    // A channel's rule needs the settings a member is not shown.
    await run.approve((await (async () => { void run.call("sshs3_manage_team_chat", { operation: "agent_set_channel", service: "slack", channelId: "C1", servers: ["*"], reach: "ask" }).catch(() => undefined); return run.pending(); })()).id);
    await vi.waitFor(() => expect(run.task.changes.at(-1)!.status).toBe("failed"));
    expect(run.task.changes.at(-1)!.output).toContain("an administrator's");
    expect(server.chatAnswering.answering.settings()).toMatchObject({ enabled: false, channels: { slack: [], mattermost: [] } });

    // A member's own link code is theirs to ask for. It is shown on the card, not told to the model.
    // No service is connected yet: there is nothing to link, and nobody is asked.
    await expect(run.call("sshs3_manage_team_chat", { operation: "link_code" })).rejects.toThrow("The agent bot is not connected to Slack or Mattermost here");
    await server.chatAnswering.request(mariaId, { action: "chat-answering-connect", input: { service: "slack", token: slack.apps.agent.botToken, appToken: slack.apps.agent.appToken } });
    // With one bot connected, the service need not be said.
    const asked = run.call("sshs3_manage_team_chat", { operation: "link_code" });
    const change = await run.pending();
    expect(change.description).toBe("Make a code that links a chat account to your sshs3 account");
    await run.approve(change.id);
    const result = (await asked) as { ok: boolean; note: string; expiresAt: number };
    expect(result.note).toContain("You are not given it");
    const shown = (await omar.request({ action: "change-reveal", taskId: run.task.id, changeId: change.id } as HubRequest)).reply?.changeReveal;
    expect(shown?.value).toMatch(/^link [A-Z2-7]{4}-?[A-Z2-7]{4}$/);
    const code = shown!.value.slice("link ".length);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(JSON.stringify(run.task)).not.toContain(code);
    // The code is real: sent to the bot, it links Omar's chat account to his own account.
    expect((await server.chatAgent.redeem("slack", "U2OMAR", "Omar", code)).ok).toBe(true);
    expect(server.chatAgent.allLinks()).toEqual([expect.objectContaining({ chatUserId: "U2OMAR", accountId: omarId })]);
    // Ending his own link needs no question.
    await run.call("sshs3_manage_team_chat", { operation: "unlink" });
    expect(server.chatAgent.allLinks()).toEqual([]);
  });
});
