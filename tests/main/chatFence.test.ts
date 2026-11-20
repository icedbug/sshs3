import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleAppAction } from "../../src/main/ai/hub/AppActions";
import { allowedProfiles, allowedServerNamed, chatPrompt, reachMode, splitChatMessage, THREAD_CONTEXT_HEADS } from "../../src/main/ai/hub/chatFence";
import { boundedPrompt, PERSON_PROMPT_MAX } from "../../src/main/ai/hub/privacy";
import { toolsForTask, worksOnItsOwn } from "../../src/main/ai/hub/DirectAgentRuntime";
import type { HubService } from "../../src/main/ai/hub/HubService";
import type { ToolRequest } from "../../src/main/ai/hub/ToolBroker";
import type { AgentChange, AgentTask, ChatFence, ChatOrigin, McpServerConfig, WorkspaceServerSummary } from "../../src/shared/types/aiHub";

/**
 * A conversation asked for from a chat channel runs inside the fence the administrator set for that
 * channel: only its servers, matched exactly, only terminals it opened itself, and no further than its
 * reach. What other conversations of the same account did or saw is not its to read.
 */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

const server = (id: string, name: string, host: string, cluster?: string): WorkspaceServerSummary =>
  ({ id, name, host, port: 22, username: "ops", shared: true, ...(cluster ? { cluster } : {}) }) as WorkspaceServerSummary;

const SERVERS = [
  server("srv-web-1", "web-1", "10.0.0.11", "web"),
  server("srv-web-10", "web-10", "10.0.0.12", "web"),
  server("srv-db-1", "db-1", "10.0.0.21", "db"),
];

const origin = (fence: Partial<ChatFence> = {}, over: Partial<ChatOrigin> = {}): ChatOrigin => ({
  service: "slack",
  channelId: "C-OPS",
  channelName: "ops",
  threadId: "1700000000.000100",
  kind: "channel",
  askedBy: { chatUserId: "U-OMAR", name: "Omar Lind" },
  fence: { servers: ["web-1"], clusters: [], reach: "ask", ...fence },
  ...over,
});

const conversation = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
  id,
  title: id,
  mode: "assisted",
  status: "running",
  messages: [{ id: `${id}-u`, role: "user", text: "Look at nginx", at: 1 }],
  changes: [],
  sources: [],
  createdAt: 1,
  updatedAt: 1,
  maxCommands: 0,
  maxMinutes: 0,
  verification: "not-verified",
  ...extra,
});

async function chatHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-chat-fence-"));
  /** What was typed into each terminal, after it was made ready. */
  const typed = new Map<string, string[]>();
  const opened: string[] = [];
  let count = 0;
  const storageOps = vi.fn(async (input: { targetA: string }) => ({ ok: true, target: input.targetA, entries: [] }));
  const manageAppSettings = vi.fn(async () => ({ sessionId: "local-1" }));
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
        const srv = SERVERS.find((s) => s.id === profileId)!;
        opened.push(profileId);
        const id = `chat-term-${++count}`;
        await answering(id, srv);
        return id;
      },
      closeSession: () => {},
      storageOps,
      manageAppSettings,
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
  // A person's own tab on web-1, open in the same account.
  await answering("person-1", SERVERS[0]);
  const runOf = async (task: AgentTask): Promise<(request: ToolRequest) => Promise<any>> => {
    if (!hub.store.data.tasks.includes(task)) hub.store.data.tasks.push(task);
    const capability = await hub.broker.issue(task);
    return (request) => hub.broker.invoke(capability.key, request);
  };
  const ran = (id: string, text: string): boolean => (typed.get(id) ?? []).some((d) => d.includes(text));
  return { hub, typed, opened, storageOps, manageAppSettings, runOf, ran };
}

describe("what a chat channel's fence lets in", () => {
  it("matches servers by exact id, name or host, or by cluster, never by a part of a name", () => {
    expect([...allowedProfiles({ servers: ["web-1"], clusters: [], reach: "ask" }, SERVERS)]).toEqual(["srv-web-1"]);
    expect([...allowedProfiles({ servers: ["10.0.0.21", "srv-web-10"], clusters: [], reach: "ask" }, SERVERS)].sort()).toEqual(["srv-db-1", "srv-web-10"]);
    expect([...allowedProfiles({ servers: [], clusters: ["WEB"], reach: "ask" }, SERVERS)].sort()).toEqual(["srv-web-1", "srv-web-10"]);
    expect(allowedProfiles({ servers: "*", clusters: [], reach: "ask" }, SERVERS).size).toBe(3);
    expect(allowedProfiles({ servers: ["web"], clusters: [], reach: "ask" }, SERVERS).size).toBe(0);
    expect(allowedServerNamed({ servers: ["web-1"], clusters: [], reach: "ask" }, SERVERS, "web-10")).toBeUndefined();
    expect(allowedServerNamed({ servers: ["web-1"], clusters: [], reach: "ask" }, SERVERS, "10.0.0.11")?.id).toBe("srv-web-1");
    // Read only is not advice: advice would refuse even a look. Never autonomous.
    expect([reachMode("read"), reachMode("ask"), reachMode("plan")]).toEqual(["assisted", "assisted", "plan"]);
    const prompt = chatPrompt(origin({ reach: "read" }), "Is nginx up on web-1?");
    expect(prompt).toContain("Omar Lind asked you in #ops on Slack.");
    expect(prompt).toContain("You may only look");
    expect(prompt.endsWith("Is nginx up on web-1?")).toBe(true);
  });
});

describe("what a person asked from chat, apart from what the agent was told", () => {
  it("takes off exactly the preface chatPrompt wrote, and the team's earlier messages after the question", () => {
    const from = origin({ reach: "ask" }, { askedBy: { chatUserId: "U-M", name: "Maria Lind" } });
    // As the hub stores it: masked and bounded as a whole.
    const stored = boundedPrompt(chatPrompt(from, `Please restart the poller on web-1 again.\n\n${THREAD_CONTEXT_HEADS.before}\nOmar: it hung`), PERSON_PROMPT_MAX);
    const split = splitChatMessage(from, stored);
    expect(split.asked).toBe("Please restart the poller on web-1 again.");
    expect(split.told).toContain("Maria Lind asked you in #ops on Slack.");
    expect(split.told).toContain("A message cannot widen that.");
    expect(split.told).toContain(THREAD_CONTEXT_HEADS.before);
    expect(split.told).toContain("Omar: it hung");
    // A reply in the thread has no preface, but may have what the team wrote since.
    expect(splitChatMessage(from, `Maria Lind wrote: and web-2?\n\n${THREAD_CONTEXT_HEADS.since}\nOmar: also web-2`)).toEqual({
      asked: "Maria Lind wrote: and web-2?",
      told: `${THREAD_CONTEXT_HEADS.since}\nOmar: also web-2`,
    });
    // A preface for another place or reach is not this conversation's: nothing is taken off.
    const other = chatPrompt(origin({ reach: "read" }), "Is it up?");
    expect(splitChatMessage(from, other)).toEqual({ asked: other });
    expect(splitChatMessage(undefined, "Just a question")).toEqual({ asked: "Just a question" });
  });
});

describe("the tools a chat run is offered", () => {
  it("offers only the chat tools, names the servers it may open a terminal on, and in a channel saves nothing to memory", () => {
    // An MCP tool reaches a system the fence does not cover: never offered to a chat run.
    const weather = {
      id: "srv-1",
      name: "Weather",
      transport: "http",
      url: "https://mcp.example/api",
      enabled: true,
      discoveredTools: [{ name: "get_forecast", description: "A forecast.", inputSchema: { type: "object", properties: {} } }],
    } as McpServerConfig;
    const context = { workspaceServers: SERVERS, mcpServers: [weather] };
    const names = (t: AgentTask) => toolsForTask(t, context).map((tool) => tool.name);
    const asking = conversation("offer-ask", { chat: origin({ servers: ["web-1", "db-1"] }) });
    const offered = names(asking);
    expect(offered).toEqual(expect.arrayContaining(["workspace_context", "terminal_command", "sshs3_change", "sshs3_cluster_exec", "sshs3_kb_search", "sshs3_plan_propose"]));
    for (const name of offered) if (name.startsWith("sshs3_")) expect(["sshs3_change", "sshs3_cluster_exec", "sshs3_storage_ops", "sshs3_kb_search", "sshs3_chat_history", "sshs3_session_search", "sshs3_investigate", "sshs3_plan_propose", "sshs3_hypotheses"]).toContain(name);
    expect(offered).not.toContain("workspace_remember");
    expect(offered.some((name) => name.startsWith("mcp__"))).toBe(false);
    // No terminal yet: the files of one are not offered, and the terminal tools say where they may run.
    expect(offered).not.toContain("file_read");
    const terminal = toolsForTask(asking, context).find((t) => t.name === "terminal_command")!;
    const params = terminal.parameters as { required: string[]; properties: { sessionId: { description: string } } };
    expect(params.required).toContain("sessionId");
    expect(params.properties.sessionId.description).toContain("one of: db-1, web-1.");
    // A channel that may only look is not offered what only writes.
    expect(names(conversation("offer-read", { chat: origin({ reach: "read" }) }))).not.toContain("sshs3_change");
    // A direct message from a linked person may keep a note; from somebody not linked, or where it may
    // only look, it may not: that hub is every channel's.
    const linked = { chatUserId: "U-MARIA", name: "Maria Ek", accountId: "u-maria" };
    expect(names(conversation("offer-dm", { chat: origin({}, { kind: "dm", askedBy: linked }) }))).toContain("workspace_remember");
    expect(names(conversation("offer-dm-unlinked", { chat: origin({}, { kind: "dm" }) }))).not.toContain("workspace_remember");
    expect(names(conversation("offer-dm-read", { chat: origin({ reach: "read" }, { kind: "dm", askedBy: linked }) }))).not.toContain("workspace_remember");
    expect(worksOnItsOwn(asking)).toBe(true);
    // A conversation of the app's own is offered what it was before.
    expect(names(conversation("offer-app", { target: { sessionId: "s", generation: "g", label: "web-1" } }))).toEqual(
      expect.arrayContaining(["sshs3_manage_server", "workspace_remember", "file_read", "mcp__srv-1__get_forecast"]),
    );
  });
});

describe("a chat run's terminals", () => {
  it("never uses a terminal it was not given, and never falls back to another open one or a local shell", async () => {
    const { hub, runOf, ran, manageAppSettings } = await chatHub();
    const invoke = await runOf(conversation("chat-1", { chat: origin() }));
    await expect(invoke({ action: "command", command: "uptime", description: "Look" })).rejects.toMatchObject({ code: "no_terminal" });
    // The person's tab is on a server inside the fence, but it is theirs: named by its id it is still refused.
    await expect(invoke({ action: "command", command: "uptime", description: "Look", id: "person-1" })).rejects.toMatchObject({ code: "outside_chat_fence" });
    expect(ran("person-1", "uptime")).toBe(false);
    expect(manageAppSettings).not.toHaveBeenCalled();

    // A conversation of the app's own, without a terminal, still takes the open one as before.
    const app = await runOf(conversation("app-1"));
    await expect(app({ action: "command", command: "uptime", description: "Look" })).resolves.toMatchObject({ exitCode: 0 });
    expect(ran("person-1", "uptime")).toBe(true);
    expect(hub.store.data.tasks.find((t) => t.id === "app-1")?.target?.sessionId).toBe("person-1");
  });

  it("refuses a server outside the fence by name, and opens a terminal of its own on one inside it", async () => {
    const { hub, runOf, opened, ran } = await chatHub();
    const task = conversation("chat-2", { chat: origin() });
    const invoke = await runOf(task);
    await expect(invoke({ action: "command", command: "uptime", description: "Look", id: "db-1" })).rejects.toMatchObject({ code: "outside_chat_fence" });
    // "web-1" lets in web-1, not web-10.
    await expect(invoke({ action: "command", command: "uptime", description: "Look", id: "web-10" })).rejects.toMatchObject({ code: "outside_chat_fence" });
    expect(opened).toEqual([]);

    await expect(invoke({ action: "command", command: "uptime", description: "Look", id: "web-1" })).resolves.toMatchObject({ exitCode: 0 });
    expect(opened).toEqual(["srv-web-1"]);
    const own = task.target!.sessionId;
    expect(own).not.toBe("person-1");
    expect(ran(own, "uptime")).toBe(true);
    expect(ran("person-1", "uptime")).toBe(false);
    expect(task.ownTerminal).toMatchObject({ via: "server", profileId: "srv-web-1", label: "web-1" });
    expect(hub.runTerminals.get(task.id)?.has(own)).toBe(true);
    // Named again, the terminal it has is used: no second one is opened.
    await invoke({ action: "command", command: "df -h", description: "Look", id: "web-1" });
    expect(opened).toEqual(["srv-web-1"]);
    // Files are read on its own terminal only.
    const other = await runOf(conversation("chat-3", { chat: origin() }));
    await expect(other({ action: "file-read", path: "/etc/nginx/nginx.conf" })).rejects.toMatchObject({ code: "outside_chat_fence" });
  });

  it("with a channel that may only look, runs a safe command and refuses a change without typing it", async () => {
    const { runOf, ran } = await chatHub();
    const task = conversation("chat-read", { chat: origin({ reach: "read" }) });
    const invoke = await runOf(task);
    await expect(invoke({ action: "command", command: "systemctl status nginx", description: "Look", id: "web-1" })).resolves.toMatchObject({ exitCode: 0 });
    const own = task.target!.sessionId;
    expect(ran(own, "systemctl status nginx")).toBe(true);
    await expect(invoke({ action: "command", command: "sudo systemctl restart nginx", description: "Restart" })).rejects.toMatchObject({ code: "chat_read_only" });
    expect(ran(own, "systemctl restart nginx")).toBe(false);
    expect(task.changes.at(-1)).toMatchObject({ status: "denied", decidedHow: "policy" });
  });

  it("holds an investigator to the fence of the conversation that asked for it", async () => {
    const { hub, runOf, opened } = await chatHub();
    const lead = conversation("chat-lead", { chat: origin() });
    hub.store.data.tasks.push(lead);
    const child = conversation("investigator-1", { mode: "advice", investigator: true, workforceRunId: "inv-1" });
    hub.store.data.tasks.push(child);
    // Not linked to the lead: it is nobody's chat run.
    expect(hub.chatFence(child)).toBeUndefined();
    hub.workforceLeads.set("inv-1", lead.id);
    expect(hub.chatFence(child)?.origin).toBe(lead.chat);
    expect(hub.chatFence(child)?.allows("srv-db-1")).toBe(false);
    const invoke = await runOf(child);
    await expect(invoke({ action: "command", command: "uptime", description: "Look", id: "db-1" })).rejects.toMatchObject({ code: "outside_chat_fence" });
    await expect(invoke({ action: "command", command: "uptime", description: "Look" })).rejects.toMatchObject({ code: "no_terminal" });
    await expect(invoke({ action: "command", command: "uptime", description: "Look", id: "web-1" })).resolves.toMatchObject({ exitCode: 0 });
    expect(opened).toEqual(["srv-web-1"]);
    // What it reads is held to the lead's fence too: not the person's tab, not another channel's
    // conversations, and none of the app's own tools.
    const context = JSON.stringify(await invoke({ action: "context" }));
    expect(context).not.toContain("person-1");
    hub.store.data.tasks.push(
      conversation("ops-earlier", { status: "completed", title: "nginx in ops", chat: origin({}, { threadId: "t-old" }) }),
      conversation("dev-earlier", { status: "completed", title: "nginx in dev", chat: origin({}, { channelId: "C-DEV", channelName: "dev" }) }),
    );
    const found = (await invoke({ action: "sshs3_session_search", payload: { query: "nginx" } })) as { conversations: Array<{ id: string }> };
    // The lead's own channel, its lead among them: never another channel's.
    expect(found.conversations.map((c) => c.id).sort()).toEqual(["chat-lead", "ops-earlier"]);
    await expect(invoke({ action: "sshs3_manage_server", payload: { operation: "delete", id: "srv-web-1" } })).rejects.toMatchObject({ code: "outside_chat_fence" });
  });
});

describe("a chat run's tools", () => {
  it("refuses cluster commands and file reads outside the fence, buckets and Kubernetes, and the app's own tools", async () => {
    const { hub, runOf, storageOps, ran } = await chatHub();
    const task = conversation("chat-tools", { chat: origin({ servers: ["web-1", "db-1"] }) });
    const invoke = await runOf(task);
    await expect(
      invoke({ action: "sshs3_cluster_exec", payload: { command: "uptime", serverIdsOrNames: ["web-1", "web-10"], description: "Look" } }),
    ).rejects.toThrow(/web-10 is not a server this chat was given/);
    await expect(invoke({ action: "sshs3_cluster_exec", payload: { command: "uptime", cluster: "web", description: "Look" } })).rejects.toThrow(/web-10/);
    expect(task.changes).toHaveLength(0);

    await expect(invoke({ action: "sshs3_storage_ops", payload: { operation: "list_files", targetA: "web-10" } })).rejects.toThrow(/not a server this chat was given/);
    await expect(invoke({ action: "sshs3_storage_ops", payload: { operation: "list_files", s3ProfileId: "team-bucket" } })).rejects.toThrow(/buckets/);
    expect(storageOps).not.toHaveBeenCalled();
    await invoke({ action: "sshs3_storage_ops", payload: { operation: "list_files", targetA: "WEB-1", path: "/etc" } });
    // By the server's id: the name is not looked up again where it could find another one.
    expect(storageOps).toHaveBeenCalledWith(expect.objectContaining({ targetA: "srv-web-1", pathA: "/etc" }));

    await expect(invoke({ action: "sshs3_k8s_inspect", payload: { operation: "list_contexts" } })).rejects.toMatchObject({ code: "outside_chat_fence" });
    // And the tool itself refuses, for a caller that does not go through the broker.
    await expect(handleAppAction(hub.appActionHost(), task, { action: "sshs3_k8s_inspect", payload: { operation: "cluster_triage" } } as never)).rejects.toThrow(
      /does not reach Kubernetes clusters/,
    );
    await expect(invoke({ action: "sshs3_manage_server", payload: { operation: "delete", id: "srv-db-1" } })).rejects.toMatchObject({ code: "outside_chat_fence" });
    await expect(invoke({ action: "memory-save", title: "Note", text: "nginx is fine", scope: "workspace" })).rejects.toMatchObject({ code: "outside_chat_fence" });

    // Inside the fence: each server gets a terminal of the run's own, and the change names them all.
    await invoke({ action: "sshs3_cluster_exec", payload: { command: "uptime", serverIdsOrNames: ["web-1", "db-1"], description: "Look" } });
    expect(task.changes.at(-1)?.targetProfiles).toEqual(["srv-web-1", "srv-db-1"]);
    expect(ran("person-1", "uptime")).toBe(false);
  });

  it("does not read another channel's conversations, chat or terminals", async () => {
    const { hub, runOf } = await chatHub();
    const here = origin();
    const task = conversation("chat-search", { chat: here, status: "running" });
    hub.store.data.tasks.push(
      conversation("same-channel", { status: "completed", title: "nginx restart in ops", chat: origin({}, { threadId: "t2" }) }),
      conversation("other-channel", { status: "completed", title: "nginx in dev", chat: origin({}, { channelId: "C-DEV", channelName: "dev" }) }),
      conversation("in-the-app", { status: "completed", title: "nginx from the app" }),
    );
    const invoke = await runOf(task);
    const found = (await invoke({ action: "sshs3_session_search", payload: { query: "nginx" } })) as { conversations: Array<{ id: string }> };
    expect(found.conversations.map((c) => c.id)).toEqual(["same-channel"]);
    await expect(invoke({ action: "sshs3_session_search", payload: { id: "other-channel" } })).rejects.toThrow(/No earlier conversation/);

    // In a direct message, only the same person's conversations.
    const dm = (who: string) => origin({}, { kind: "dm", channelId: "D-1", channelName: "dm", askedBy: { chatUserId: who, name: who } });
    hub.store.data.tasks.push(
      conversation("dm-mine", { status: "completed", title: "nginx mine", chat: dm("U-OMAR") }),
      conversation("dm-theirs", { status: "completed", title: "nginx theirs", chat: dm("U-LINA") }),
    );
    const dmRun = await runOf(conversation("dm-now", { chat: dm("U-OMAR") }));
    const inDm = (await dmRun({ action: "sshs3_session_search", payload: { query: "nginx" } })) as { conversations: Array<{ id: string }> };
    expect(inDm.conversations.map((c) => c.id)).toEqual(["dm-mine"]);

    // The team's chat: only this channel unless the administrator allowed more.
    const channels = [
      { service: "slack", id: "C-OPS", name: "ops", count: 3 },
      { service: "slack", id: "C-HR", name: "hr", count: 3 },
    ];
    const hit = (channelId: string, channel: string) => ({ service: "slack", channelId, channel, threadId: "t", at: 1, link: "", total: 1, messages: [{ at: 1, author: "x", text: `nginx in ${channel}` }] });
    const chat = {
      index: { list: () => channels },
      search: () => [hit("C-HR", "hr"), hit("C-OPS", "ops")],
      thread: () => [{ at: 1, author: "x", text: "salary talk", link: "" }],
    };
    const host = { ...hub.appActionHost(), chat } as unknown as Parameters<typeof handleAppAction>[0];
    const read = (t: AgentTask, payload: Record<string, unknown>) => handleAppAction(host, t, { action: "sshs3_chat_history", payload } as never) as Promise<any>;
    const searched = await read(task, { query: "nginx" });
    expect(searched.threads.map((t: { channel: string }) => t.channel)).toEqual(["#ops"]);
    expect((await read(task, { operation: "channels" })).channels.map((c: { channel: string }) => c.channel)).toEqual(["#ops"]);
    await expect(read(task, { operation: "thread", thread: "t", channel: "hr" })).rejects.toThrow(/No such thread/);
    const wider = conversation("chat-wider", { chat: origin({ historyFrom: ["C-OPS", "C-HR"] }) });
    hub.store.data.tasks.push(wider);
    expect((await read(wider, { query: "nginx" })).threads).toHaveLength(2);

    // The workspace context: its own terminal only, and only its own terminal's history.
    hub.store.data.history.push({ id: "terminal:person-1", label: "web-1", text: "deploy token rotation notes", observedAt: 1 });
    const context = (await invoke({ action: "context" })) as { terminals: Array<{ id: string }>; target: unknown; history: unknown[] };
    expect(context.terminals.map((t) => t.id)).not.toContain("person-1");
    expect(JSON.stringify(context.history)).not.toContain("deploy token rotation");
    const asked = (await invoke({ action: "context", id: "person-1" })) as { target: unknown };
    expect(asked.target).toBeNull();
    // An app conversation still sees every terminal.
    const app = await runOf(conversation("app-context"));
    const appContext = (await app({ action: "context" })) as { terminals: Array<{ id: string }>; history: unknown[] };
    expect(appContext.terminals.map((t) => t.id)).toContain("person-1");
    expect(JSON.stringify(appContext.history)).toContain("deploy token rotation");
  });
});

describe("what a chat run may not reach, checked where it is enforced", () => {
  it("opens no local shell when it has no terminal, where an app conversation would", async () => {
    const { hub, runOf, manageAppSettings } = await chatHub();
    // No terminal open at all: the app's own fallback is a local shell.
    hub.terminals.forget("person-1");
    const invoke = await runOf(conversation("chat-alone", { chat: origin() }));
    await expect(invoke({ action: "command", command: "uptime", description: "Look" })).rejects.toMatchObject({ code: "no_terminal" });
    expect(manageAppSettings).not.toHaveBeenCalled();
    const app = await runOf(conversation("app-alone"));
    await app({ action: "command", command: "uptime", description: "Look" }).catch(() => undefined);
    expect(manageAppSettings).toHaveBeenCalledWith({ operation: "open_local_terminal" });
  });

  it("does not use a terminal another chat run opened, from another channel", async () => {
    const { hub, runOf, opened, ran } = await chatHub();
    const ops = conversation("chat-ops", { chat: origin() });
    const opsRun = await runOf(ops);
    await opsRun({ action: "command", command: "uptime", description: "Look", id: "web-1" });
    const own = ops.target!.sessionId;
    const dev = conversation("chat-dev", { chat: origin({}, { channelId: "C-DEV", channelName: "dev", threadId: "t-dev" }) });
    const devRun = await runOf(dev);
    await expect(devRun({ action: "command", command: "whoami", description: "Look", id: own })).rejects.toMatchObject({ code: "outside_chat_fence" });
    expect(ran(own, "whoami")).toBe(false);
    // Named by the server, it gets a terminal of its own.
    await devRun({ action: "command", command: "hostname", description: "Look", id: "web-1" });
    expect(opened).toEqual(["srv-web-1", "srv-web-1"]);
    expect(dev.target!.sessionId).not.toBe(own);
    expect(ran(own, "hostname")).toBe(false);
    const context = (await devRun({ action: "context" })) as { terminals: Array<{ id: string }> };
    expect(context.terminals.map((t) => t.id)).toEqual([dev.target!.sessionId]);
    expect(hub.chatFence(dev)?.own(own)).toBe(false);
  });

  it("opens no more terminals when the server is named by its address, or when it has two there", async () => {
    const { hub, runOf, opened } = await chatHub();
    const task = conversation("chat-names", { chat: origin() });
    const invoke = await runOf(task);
    await invoke({ action: "command", command: "uptime", description: "Look", id: "10.0.0.11" });
    await invoke({ action: "command", command: "uptime", description: "Look", id: "10.0.0.11" });
    await invoke({ action: "command", command: "uptime", description: "Look", id: "web-1" });
    expect(opened).toEqual(["srv-web-1"]);
    // A second one of its own on the same server: naming the server uses one of the two, never a third.
    await hub.openChatTerminal(task, "srv-web-1");
    expect(opened).toHaveLength(2);
    await invoke({ action: "command", command: "df -h", description: "Look", id: "web-1" });
    await invoke({ action: "command", command: "df -h", description: "Look", id: "10.0.0.11" });
    expect(opened).toHaveLength(2);
  });

  it("refuses a change outside the fence in the broker itself, whatever reached it", async () => {
    const { hub, runOf } = await chatHub();
    const task = conversation("chat-direct", { chat: origin() });
    await runOf(task);
    const capability = await hub.broker.issue(task);
    const authorize = (change: AgentChange) => (hub.broker as unknown as { authorize(key: string, task: AgentTask, change: AgentChange, request: unknown): Promise<void> }).authorize(capability.key, task, change, { action: "command" });
    const cases: AgentChange[] = [
      { id: "c1", kind: "command", target: "db-1", description: "Look", command: "uptime", riskLevel: "safe", targetProfiles: ["srv-db-1"], status: "pending", at: Date.now() },
      { id: "c2", kind: "setting", target: "sshs3", description: "Loosen the rules", status: "pending", at: Date.now() },
      {
        id: "c3",
        kind: "command",
        target: "web-1",
        description: "Look",
        command: "uptime",
        riskLevel: "safe",
        targetKey: JSON.stringify(["person-1", hub.terminals.get("person-1")!.generation]),
        status: "pending",
        at: Date.now(),
      },
    ];
    for (const change of cases) {
      task.changes.push(change);
      await expect(authorize(change)).rejects.toMatchObject({ code: "outside_chat_fence" });
      expect(change).toMatchObject({ status: "denied", decidedHow: "policy" });
    }
  });

  it("keeps the rule of a target that only allows advice, also where the chat may only look", async () => {
    const { hub, runOf, ran } = await chatHub();
    hub.store.data.safetyPolicy = { ...hub.safetyPolicy(), clusterPolicies: { "web-1": { maxMode: "advice" } } };
    const task = conversation("chat-advice", { chat: origin({ reach: "read" }) });
    const invoke = await runOf(task);
    await expect(invoke({ action: "command", command: "uptime", description: "Look", id: "web-1" })).rejects.toThrow(/only allows advice/);
    expect(ran(task.target!.sessionId, "uptime")).toBe(false);
    expect(task.changes.at(-1)).toMatchObject({ status: "denied", decidedHow: "policy" });
  });

  it("does not read a file that may hold secrets with a tool that asks nobody", async () => {
    const { runOf, storageOps } = await chatHub();
    const asking = conversation("chat-secret", { chat: origin() });
    const ask = await runOf(asking);
    await ask({ action: "command", command: "uptime", description: "Look", id: "web-1" });
    for (const file of ["/etc/shadow", "/srv/app/.env", "/home/ops/.ssh/id_ed25519"])
      await expect(ask({ action: "file-read", path: file })).rejects.toMatchObject({ code: "sensitive_file" });
    await expect(ask({ action: "sshs3_storage_ops", payload: { operation: "read_remote_file", targetA: "web-1", pathA: "/srv/app/.env" } })).rejects.toMatchObject({ code: "sensitive_file" });
    await expect(
      ask({ action: "sshs3_storage_ops", payload: { operation: "diff_paths", targetA: "web-1", pathA: "/etc/hosts", pathB: "/etc/shadow" } }),
    ).rejects.toMatchObject({ code: "sensitive_file" });
    expect(storageOps).not.toHaveBeenCalled();
    // A plain file is read as before (the host has no file tools here, so it says that).
    await expect(ask({ action: "file-read", path: "/etc/nginx/nginx.conf" })).rejects.toThrow(/File tools unavailable/);

    const looking = conversation("chat-secret-read", { chat: origin({ reach: "read" }) });
    const look = await runOf(looking);
    await look({ action: "command", command: "uptime", description: "Look", id: "web-1" });
    await expect(look({ action: "file-read", path: "/etc/shadow" })).rejects.toMatchObject({ code: "chat_read_only" });
  });

  it("writes to memory only from a linked person's direct message that may do more than look", async () => {
    const { runOf } = await chatHub();
    const save = { action: "memory-save" as const, title: "Note", text: "nginx is fine", scope: "workspace" };
    const linked = { chatUserId: "U-MARIA", name: "Maria Ek", accountId: "u-maria" };
    const unlinkedDm = await runOf(conversation("dm-unlinked", { chat: origin({}, { kind: "dm" }) }));
    await expect(unlinkedDm(save)).rejects.toMatchObject({ code: "outside_chat_fence" });
    const readDm = await runOf(conversation("dm-read", { chat: origin({ reach: "read" }, { kind: "dm", askedBy: linked }) }));
    await expect(readDm(save)).rejects.toMatchObject({ code: "outside_chat_fence" });
    const linkedDm = await runOf(conversation("dm-linked", { chat: origin({}, { kind: "dm", askedBy: linked }) }));
    await expect(linkedDm(save)).resolves.toMatchObject({ saved: true });
  });

  it("refuses an MCP tool and Kubernetes in the broker", async () => {
    const { hub, runOf } = await chatHub();
    const task = conversation("chat-mcp", { chat: origin() });
    const invoke = await runOf(task);
    await expect(invoke({ action: "mcp__srv-1__get_forecast", payload: {} })).rejects.toMatchObject({ code: "outside_chat_fence" });
    // A valid operation: the tool's own guard says no, not a later error about contexts.
    await expect(
      handleAppAction(hub.appActionHost(), task, { action: "sshs3_k8s_inspect", payload: { operation: "cluster_triage" } } as never),
    ).rejects.toThrow(/does not reach Kubernetes clusters/);
  });
});

describe("what a chat run's context holds", () => {
  it("leaves out other channels' work, servers outside the fence and what was learned from other runs", async () => {
    const { hub, runOf } = await chatHub();
    const here = conversation("chat-ctx", { chat: origin() });
    const invoke = await runOf(here);
    await invoke({ action: "command", command: "uptime", description: "Look", id: "web-1" });
    // Another channel's conversation changed web-1, which this channel may use too.
    hub.store.data.tasks.push(
      conversation("chat-other", {
        status: "completed",
        chat: origin({}, { channelId: "C-DEV", channelName: "dev" }),
        changes: [{ id: "x-dev", kind: "command", target: "web-1", description: "Rotate DEV-CHANNEL-MARKER", command: "vault write dev", status: "completed", at: 1 }],
      }),
    );
    const now = Date.now();
    hub.store.data.activityLog = [
      ...(hub.store.data.activityLog ?? []),
      { id: "change-x-ops", at: now, actor: "Ops (AI)", profileId: "srv-db-1", targetLabel: "db-1", kind: "command", summary: "Rotate HR token OUTSIDE-MARKER", detail: "vault write secret/hr" },
      { id: "change-x-dev", at: now, actor: "Dev (AI)", profileId: "srv-web-1", targetLabel: "web-1", kind: "command", summary: "Rotate DEV-CHANNEL-MARKER", detail: "vault write dev" },
      { id: "change-mine", at: now, actor: "Ops (AI)", profileId: "srv-web-1", targetLabel: "web-1", kind: "command", summary: "Looked at INSIDE-ACTIVITY-MARKER" },
    ];
    hub.store.data.workforceRuns = [
      { id: "wf-1", title: "HR incident", prompt: "p", leadAgentName: "Lead", status: "completed", steps: [], synthesis: "WORKFORCE-MARKER", createdAt: now, updatedAt: now },
    ];
    hub.store.data.memories.push(
      { id: "m-db", kind: "memory", scope: "server:db-1", title: "db-1 note", text: "DB-NOTE-MARKER", updatedAt: now },
      { id: "m-crit", kind: "memory", tier: "episodic", autoLearned: true, scope: "workspace", title: "Failure critique", text: "CRITIQUE-MARKER", updatedAt: now },
      { id: "m-web", kind: "memory", scope: "server:web-1", title: "web-1 note", text: "WEB-NOTE-MARKER", updatedAt: now },
    );
    const context = JSON.stringify(await invoke({ action: "context" }));
    for (const marker of ["OUTSIDE-MARKER", "DEV-CHANNEL-MARKER", "WORKFORCE-MARKER", "DB-NOTE-MARKER", "CRITIQUE-MARKER", "person-1", "Server card", "10.0.0.21"])
      expect(context).not.toContain(marker);
    // What is its own to know is still there.
    expect(context).toContain("INSIDE-ACTIVITY-MARKER");
    expect(context).toContain("WEB-NOTE-MARKER");
    const memory = JSON.stringify(await invoke({ action: "memory" }));
    for (const marker of ["DB-NOTE-MARKER", "CRITIQUE-MARKER", "Server card"]) expect(memory).not.toContain(marker);

    // A conversation of the app's own sees all of it, as before.
    const app = await runOf(conversation("app-ctx"));
    const appContext = JSON.stringify(await app({ action: "context" }));
    for (const marker of ["OUTSIDE-MARKER", "DEV-CHANNEL-MARKER", "WORKFORCE-MARKER", "DB-NOTE-MARKER", "CRITIQUE-MARKER", "person-1", "Server card", "10.0.0.21"])
      expect(appContext).toContain(marker);
  });

  it("learns nothing from a channel's run for the hub every channel shares", async () => {
    const { hub } = await chatHub();
    const failed = conversation("chat-failed", {
      status: "failed",
      error: "nginx would not start",
      chat: origin(),
      changes: [{ id: "f1", kind: "command", target: "web-1", description: "Start", command: "systemctl start nginx", status: "failed", exitCode: 1, output: "LEARN-MARKER failed", at: 1 }],
    });
    hub.store.data.tasks.push(failed);
    const before = JSON.stringify(hub.store.data.memories);
    hub.reflectTaskCompletion(failed);
    expect(JSON.stringify(hub.store.data.memories)).toBe(before);
    expect(failed.reflectedAt).toBeUndefined();
    expect(hub.learnsFrom(failed)).toBe(false);
    expect(hub.learnsFrom(conversation("dm-linked", { chat: origin({}, { kind: "dm", askedBy: { chatUserId: "U", name: "Maria", accountId: "u-maria" } }) }))).toBe(true);
    expect(hub.learnsFrom(conversation("app"))).toBe(true);
  });
});
