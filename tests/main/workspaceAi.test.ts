import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAuthProvider } from "../../src/main/ai/CodexAuthProvider";
import { DirectAgentRuntime } from "../../src/main/ai/hub/DirectAgentRuntime";
import {
  TerminalRegistry,
  classifyNotableCommand,
} from "../../src/main/ai/hub/TerminalRegistry";
import { HubStore } from "../../src/main/ai/hub/HubStore";
import type { AgentTask } from "../../src/shared/types/aiHub";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  vi.restoreAllMocks();
});

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("CodexAuthProvider", () => {
  it("loads ChatGPT/Codex OAuth tokens from hermes-native/auth.json and extracts JWT claims", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-codex-test-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const hermesDir = path.join(tmpDir, "hermes-native");
    await fs.mkdir(hermesDir, { recursive: true });

    const token = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "jacob@example.com" },
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-123",
        chatgpt_data_residency: "eu",
      },
    });

    await fs.writeFile(
      path.join(hermesDir, "auth.json"),
      JSON.stringify({
        version: 1,
        active_provider: "openai-codex",
        providers: {
          "openai-codex": {
            tokens: {
              access_token: token,
              refresh_token: "rt_test_123",
            },
          },
        },
      }),
      "utf-8",
    );

    const provider = new CodexAuthProvider(tmpDir);
    const status = await provider.getStatus();
    expect(status).toEqual({
      connected: true,
      email: "jacob@example.com",
      defaultModel: undefined,
    });

    const creds = await provider.resolveCredentials();
    expect(creds?.accessToken).toBe(token);
    expect(creds?.accountId).toBe("acct-123");
    expect(creds?.email).toBe("jacob@example.com");
    expect(creds?.residency).toBe("eu");
  });

  it("automatically refreshes an expiring access token", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-codex-refresh-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const hermesDir = path.join(tmpDir, "hermes-native");
    await fs.mkdir(hermesDir, { recursive: true });

    const expiredToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const freshToken = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 7200,
      "https://api.openai.com/profile": { email: "jacob@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-456" },
    });

    await fs.writeFile(
      path.join(hermesDir, "auth.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "openai-codex": {
            tokens: {
              access_token: expiredToken,
              refresh_token: "rt_old",
            },
          },
        },
      }),
      "utf-8",
    );

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: freshToken,
        refresh_token: "rt_new",
      }),
    });

    const provider = new CodexAuthProvider(tmpDir);

    const creds = await provider.resolveCredentials(mockFetch as unknown as typeof fetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(creds?.accessToken).toBe(freshToken);
    expect(creds?.accountId).toBe("acct-456");
  });
});

describe("Collaborative terminal input & activity detection", () => {
  it("classifies config edits, service restarts, k8s deployments and package installs", () => {
    expect(classifyNotableCommand("sudo vim /etc/nginx/nginx.conf")).toEqual({
      kind: "config-edit",
      summary: "Edited file/config: /etc/nginx/nginx.conf",
    });
    expect(classifyNotableCommand("sudo systemctl restart postgresql")).toEqual({
      kind: "service",
      summary: "Service operation: systemctl restart postgresql",
    });
    expect(classifyNotableCommand("kubectl apply -f k8s/deployment.yaml")).toEqual({
      kind: "deploy",
      summary: "Cluster/Infra deployment: kubectl apply -f k8s/deployment.yaml",
    });
    expect(classifyNotableCommand("ls -la")).toBeNull();
  });

  it("keeps terminal in ready state when user types and emits commandLine on notable commands", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());

    terminals.register({ id: "t1", label: "web-prod-01", kind: "ssh", profileId: "p1" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (n) {
        queueMicrotask(() =>
          terminals.feed(
            "t1",
            `\x1b]777;SSHS3;${n};BEGIN\x07\x1b]777;SSHS3;${n};END;0;/etc/nginx\x07`,
          ),
        );
      }
    });

    await terminals.arm("t1", "bash");
    expect(terminals.get("t1")?.state).toBe("ready");

    const detected: Array<{ label: string; cmd: string; summary: string }> = [];
    terminals.on("commandLine", (session, cmd, classified) => {
      detected.push({ label: session.label, cmd, summary: classified.summary });
    });

    // Simulate user typing a config edit command in the terminal
    terminals.observeHumanInput("t1", "sudo nano /etc/nginx/sites-enabled/default\r");

    // Readiness is preserved!
    expect(terminals.get("t1")?.state).toBe("ready");
    expect(detected).toEqual([
      {
        label: "web-prod-01",
        cmd: "sudo nano /etc/nginx/sites-enabled/default",
        summary: "Edited file/config: /etc/nginx/sites-enabled/default",
      },
    ]);
  });

  it("auto-prepares an unarmed terminal via ensureReady", async () => {
    const terminals = new TerminalRegistry();
    disposals.push(() => terminals.dispose());

    terminals.register({ id: "t2", label: "db-01", kind: "ssh" }, (data) => {
      const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
      if (n) {
        queueMicrotask(() =>
          terminals.feed(
            "t2",
            `\x1b]777;SSHS3;${n};BEGIN\x07\x1b]777;SSHS3;${n};END;0;/var/lib/postgresql\x07`,
          ),
        );
      }
    });

    expect(terminals.get("t2")?.state).toBe("unknown");
    const ready = await terminals.ensureReady("t2");
    expect(ready.state).toBe("ready");
    expect(ready.shell).toBe("bash");
  });
});

describe("DirectAgentRuntime", () => {
  it("streams Codex Responses SSE, invokes tools, and completes the run", async () => {
    const sseTurn1 = [
      'data: {"type":"response.output_text.delta","delta":"Checking workspace..."}',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"workspace_context","arguments":"{\\"query\\":\\"nginx\\"}"}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":25}}}',
      "",
    ].join("\n\n");

    const sseTurn2 = [
      'data: {"type":"response.output_text.delta","delta":" Teammate Jacob updated nginx.conf."}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":30}}}',
      "",
    ].join("\n\n");

    let fetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      const payload = ++fetchCount === 1 ? sseTurn1 : sseTurn2;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    const toolCalls: unknown[] = [];
    const invokeTool = vi.fn().mockImplementation(async (req) => {
      toolCalls.push(req);
      return { recentTeamActivity: [{ actor: "jacob", summary: "Edited nginx.conf" }] };
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-direct-agent-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(tmpDir, "hermes-native"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "hermes-native", "auth.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "openai-codex": {
            tokens: {
              access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
              refresh_token: "ref_123",
            },
          },
        },
      }),
      "utf-8",
    );

    const runtime = new DirectAgentRuntime(
      invokeTool,
      tmpDir,
      mockFetch as unknown as typeof fetch,
    );

    const sampleTask: AgentTask = {
      id: "task-1",
      title: "What changed?",
      mode: "assisted",
      status: "running",
      messages: [{ id: "m1", role: "user", text: "What changed on nginx?", at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };

    const events: Array<{ type: string; delta?: string; output?: string }> = [];
    await runtime.start(
      sampleTask,
      { kind: "openai-codex", model: "gpt-6.1-sol" },
      (ev) => events.push(ev),
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === "run.completed")).toBe(true);
    const completed = events.find((e) => e.type === "run.completed");
    expect(completed?.output).toContain("Teammate Jacob updated nginx.conf.");
  });
});

describe("Production multi-user workspace sync & auto-memory", () => {
  it("merges concurrent team servers, clusters, memories, and terminal activity via syncSharedFile while redacting secrets", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-prod-sync-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const sharedFile = path.join(tmpDir, "team-workspace.json");
    const storeAnna = new HubStore(path.join(tmpDir, "anna-hub.json"));
    const storeJacob = new HubStore(path.join(tmpDir, "jacob-hub.json"));

    storeAnna.data.memories.push({
      id: "auto-node:srv-1",
      kind: "memory",
      scope: "workspace",
      title: "Auto-Minne: k8s-master-01",
      text: "Edited kubelet config with token=sk-secret1234567890abcdef",
      author: "anna",
      updatedAt: 1000,
    });
    storeAnna.data.activityLog.push({
      id: "evt-anna-1",
      at: 1000,
      actor: "anna",
      profileId: "srv-1",
      targetLabel: "k8s-master-01",
      kind: "config-edit",
      summary: "Edited /var/lib/kubelet/config.yaml",
    });

    await storeAnna.syncSharedFile(sharedFile, [
      {
        id: "srv-1",
        name: "k8s-master-01",
        host: "10.20.0.10",
        port: 22,
        username: "ubuntu",
        cluster: "k8s-eu-north-1",
        nodeRole: "control-plane",
        tags: ["k8s", "prod"],
        shared: true,
        updatedAt: "2026-10-27T10:00:00.000Z",
      },
    ]);

    // Jacob concurrently adds a GPU worker node and runs a command
    storeJacob.data.memories.push({
      id: "auto-node:srv-2",
      kind: "memory",
      scope: "workspace",
      title: "Auto-Minne: k8s-gpu-01",
      text: "NVIDIA driver verified",
      author: "jacob",
      updatedAt: 2000,
    });
    storeJacob.data.activityLog.push({
      id: "evt-jacob-1",
      at: 2000,
      actor: "jacob",
      profileId: "srv-2",
      targetLabel: "k8s-gpu-01",
      kind: "deploy",
      summary: "Container action: docker compose up -d",
    });

    const syncedJacob = await storeJacob.syncSharedFile(sharedFile, [
      {
        id: "srv-2",
        name: "k8s-gpu-01",
        host: "10.20.0.25",
        port: 22,
        username: "ubuntu",
        cluster: "k8s-eu-north-1",
        nodeRole: "gpu-node",
        tags: ["k8s", "gpu-node", "nvidia"],
        shared: true,
        updatedAt: "2026-10-27T10:05:00.000Z",
      },
    ]);

    // Both servers, both memories, and both activity events are merged!
    expect(syncedJacob.servers.map((s) => s.name).sort()).toEqual([
      "k8s-gpu-01",
      "k8s-master-01",
    ]);
    expect(storeJacob.data.memories.map((m) => m.id).sort()).toEqual([
      "auto-node:srv-1",
      "auto-node:srv-2",
    ]);
    expect(storeJacob.data.activityLog.map((a) => a.id)).toEqual([
      "evt-anna-1",
      "evt-jacob-1",
    ]);

    // Verify secrets were redacted in the shared file on disk
    const rawOnDisk = await fs.readFile(sharedFile, "utf8");
    expect(rawOnDisk).not.toContain("sk-secret1234567890abcdef");
    expect(rawOnDisk).toContain("[redacted]");
  });

  it("deduplicates terminal history entries by id in HubStore.prune()", () => {
    const store = new HubStore(path.join(os.tmpdir(), "sshs3-prune-test.json"));
    const now = Date.now();
    store.data.history.push(
      { id: "terminal:s1", label: "Local shell", text: "old output", observedAt: now - 5000 },
      { id: "terminal:s1", label: "Local shell", text: "new output", observedAt: now - 1000 },
      { id: "terminal:s2", label: "prod-01", text: "ssh output", observedAt: now - 2000 },
    );
    store.prune(now);
    expect(store.data.history).toHaveLength(2);
    expect(store.data.history.find((h) => h.id === "terminal:s1")?.text).toBe("new output");
  });

  it("filters out execution tools in advice mode and sanitizes stale gpt-sol-latest/openrouter settings in DirectAgentRuntime", async () => {
    const sseReply = [
      'data: {"type":"response.output_text.delta","delta":"Hej! Jag kan hjälpa dig med både chatt och dina servrar."}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":40,"output_tokens":15}}}',
      "",
    ].join("\n\n");

    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseReply));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-advice-chat-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));
    await fs.mkdir(path.join(tmpDir, "hermes-native"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "hermes-native", "auth.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "openai-codex": {
            tokens: {
              access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
              refresh_token: "ref_123",
            },
          },
        },
      }),
      "utf-8",
    );

    const runtime = new DirectAgentRuntime(
      async () => ({ workspaceServers: [] }),
      tmpDir,
      mockFetch as unknown as typeof fetch,
    );

    const chatTask: AgentTask = {
      id: "task-chat",
      title: "vad kan du hjälpa mig med",
      mode: "advice",
      status: "running",
      messages: [{ id: "m1", role: "user", text: "vad kan du hjälpa mig med", at: Date.now() }],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };

    const events: Array<{ type: string; output?: string }> = [];
    await runtime.start(
      chatTask,
      {
        kind: "openai-codex",
        model: "gpt-sol-latest",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      (ev) => events.push(ev),
    );

    expect(capturedUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(capturedBody.model).toBe("gpt-6.1-sol");
    const toolNames = ((capturedBody.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(toolNames).toEqual([
      "workspace_context",
      "workspace_remember",
      "sshs3_manage_server",
      "sshs3_manage_cluster_and_folders",
      "sshs3_manage_memory_and_activity",
      "sshs3_manage_schedule",
      "sshs3_manage_s3_and_sync",
      "sshs3_manage_app_and_settings",
      "sshs3_cluster_exec",
      "sshs3_workspace_layout",
      "sshs3_storage_ops",
      "sshs3_kb_search",
      "sshs3_kb_manage",
      "sshs3_agent_and_mcp_manage",
    ]);
    expect(events.find((e) => e.type === "run.completed")?.output).toContain(
      "Hej! Jag kan hjälpa dig",
    );

    // Also excludes terminal execution tools in assisted mode when target is detached ("Context only"), while keeping all sshs3_* tools
    await runtime.start(
      { ...chatTask, id: "task-context-only", mode: "assisted", target: undefined },
      { kind: "openai-codex", model: "gpt-5.3-codex" },
      () => {},
    );
    expect(capturedBody.model).toBe("gpt-6.1-sol");
    const contextOnlyTools = ((capturedBody.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(contextOnlyTools).toEqual([
      "workspace_context",
      "workspace_remember",
      "sshs3_manage_server",
      "sshs3_manage_cluster_and_folders",
      "sshs3_manage_memory_and_activity",
      "sshs3_manage_schedule",
      "sshs3_manage_s3_and_sync",
      "sshs3_manage_app_and_settings",
      "sshs3_cluster_exec",
      "sshs3_workspace_layout",
      "sshs3_storage_ops",
      "sshs3_kb_search",
      "sshs3_kb_manage",
      "sshs3_agent_and_mcp_manage",
    ]);

    // Includes terminal execution tools + sshs3_* tools in assisted mode when target is attached
    await runtime.start(
      {
        ...chatTask,
        id: "task-attached",
        mode: "assisted",
        target: { sessionId: "s1", label: "prod-01", generation: "g1" },
      },
      { kind: "openai-codex", model: "gpt-6.1-sol" },
      () => {},
    );
    const attachedTools = ((capturedBody.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(attachedTools).toEqual([
      "workspace_context",
      "terminal_command",
      "terminal_verify",
      "file_read",
      "file_write",
      "workspace_remember",
      "sshs3_manage_server",
      "sshs3_manage_cluster_and_folders",
      "sshs3_manage_memory_and_activity",
      "sshs3_manage_schedule",
      "sshs3_manage_s3_and_sync",
      "sshs3_manage_app_and_settings",
      "sshs3_cluster_exec",
      "sshs3_workspace_layout",
      "sshs3_storage_ops",
      "sshs3_kb_search",
      "sshs3_kb_manage",
      "sshs3_agent_and_mcp_manage",
    ]);
  });

  it("allows AI to directly create/update/delete servers, clusters, folders, memories, schedules, and settings in sshs3", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-actions-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const savedServers = new Map<string, Record<string, unknown>>();
    const folders: string[] = [];
    let appSettings: Record<string, unknown> = { theme: "dark", terminalFontSize: 14 };

    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        workspaceServers: async () => Array.from(savedServers.values()) as never[],
        upsertServer: async (input) => {
          const id = input.id || `srv-${savedServers.size + 1}`;
          const rec = { ...input, id, port: input.port || 22, shared: input.shared ?? true };
          savedServers.set(id, rec);
          return rec as never;
        },
        describeServer: async (input) => {
          const existing = savedServers.get(input.profileId);
          if (existing) {
            savedServers.set(input.profileId, { ...existing, ...input });
          }
        },
        deleteServer: async (id) => {
          savedServers.delete(id);
        },
        extraAppContext: async () => ({
          folders,
          s3Profiles: [],
          snippets: [],
          appSettings,
        }),
        manageFolders: async (input) => {
          if (input.operation === "create_folder") folders.push(input.folderName);
          return { folders };
        },
        manageAppSettings: async (input) => {
          if (input.operation === "update_settings" && input.settings) {
            appSettings = { ...appSettings, ...input.settings };
          }
          return appSettings;
        },
      },
      tmpDir,
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();

    const dummyTask: AgentTask = {
      id: "task-ai-manage",
      title: "Manage sshs3",
      mode: "advice",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };
    const cap = await hub.broker.issue(dummyTask);

    // 1. AI creates a server in sshs3
    const createRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_server",
      payload: {
        operation: "upsert",
        name: "prod-redis-01",
        host: "10.20.1.50",
        username: "ubuntu",
        cluster: "Acme-Prod-Core",
        nodeRole: "cache",
        role: "cache",
        tags: ["redis", "prod"],
        description: "Primary Redis cluster node",
      },
    })) as { ok: boolean; operation: string; server: { name: string; cluster: string } };
    expect(createRes.ok).toBe(true);
    expect(createRes.server.name).toBe("prod-redis-01");
    expect(createRes.server.cluster).toBe("Acme-Prod-Core");

    // 2. AI assigns server to a new cluster & creates a folder
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_cluster_and_folders",
      payload: {
        operation: "assign_cluster",
        cluster: "EU-North-Cache",
        serverIdsOrNames: ["prod-redis-01"],
      },
    });
    const snapAfterCluster = await hub.snapshot();
    expect(
      (snapAfterCluster.workspaceServers ?? []).find((s) => s.name === "prod-redis-01")?.cluster,
    ).toBe("EU-North-Cache");

    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_cluster_and_folders",
      payload: {
        operation: "create_folder",
        folderName: "Acme Cloud / Cache",
      },
    });
    expect(folders).toContain("Acme Cloud / Cache");

    // 3. AI saves a schedule
    const schedRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_schedule",
      payload: {
        operation: "save",
        title: "Hourly Redis memory check",
        prompt: "Check redis-cli info memory",
        serverIdOrName: "prod-redis-01",
        intervalMinutes: 60,
      },
    })) as { ok: boolean; schedule: { title: string } };
    expect(schedRes.ok).toBe(true);
    expect(schedRes.schedule.title).toBe("Hourly Redis memory check");

    // 4. AI updates sshs3 settings (terminalFontSize + actorName)
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_app_and_settings",
      payload: {
        operation: "update_settings",
        actorName: "Jacob (Architect)",
        terminalFontSize: 16,
      },
    });
    expect(appSettings.terminalFontSize).toBe(16);
    expect((await hub.config.getView()).actorName).toBe("Jacob (Architect)");
  });

  it("returns cmd-compatible inline suggestions for cmd shell and never rejects snapshot if config.getView throws", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-inline-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
      },
      tmpDir,
    );
    disposals.push(() => hub.dispose());

    let shouldThrow = true;
    vi.spyOn(hub.config, "getView").mockImplementation(async () => {
      if (shouldThrow) throw new Error("Simulated disk read error");
      return {
        enabled: false,
        provider: "openai-codex" as const,
        model: "gpt-6.1-sol",
        useHermes: false,
        hasApiKey: false,
        keyStorage: "encrypted" as const,
      };
    });
    vi.spyOn(hub.config, "getConfig").mockResolvedValue({
      enabled: false,
      provider: "openai-codex" as const,
      model: "gpt-6.1-sol",
      useHermes: false,
      apiKey: "",
    });

    // Even when config.getView throws during both initialize() and snapshot(), snapshot() resolves cleanly
    const snap = await hub.snapshot();
    expect(snap.config.provider).toBe("openai-codex");

    shouldThrow = false;
    const cmdPortSnap = await hub.request({
      action: "inline-suggest",
      prompt: "check port 8080",
      shell: "cmd",
    });
    expect(cmdPortSnap.inlineSuggestion?.command).toBe("netstat -ano | findstr :8080");

    const cmdDefaultSnap = await hub.request({
      action: "inline-suggest",
      prompt: "visa status",
      shell: "cmd",
    });
    expect(cmdDefaultSnap.inlineSuggestion?.command).toContain("tasklist");
    expect(cmdDefaultSnap.inlineSuggestion?.command).not.toMatch(/^Get-Process/);
  });

  it("supports Mission Agents, MCP servers, Knowledge Base BM25 search, Cluster Exec, Layout Orchestration, Storage Ops, and Context Window settings", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-nextgen-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const savedServers = [
      {
        id: "srv-ontap-01",
        name: "aff-a800-dc1-01",
        host: "10.30.10.11",
        port: 22,
        username: "admin",
        cluster: "NetApp-ONTAP-Prod-SE",
        nodeRole: "storage-controller",
        shared: true,
      },
      {
        id: "srv-ontap-02",
        name: "aff-a800-dc1-02",
        host: "10.30.10.12",
        port: 22,
        username: "admin",
        cluster: "NetApp-ONTAP-Prod-SE",
        nodeRole: "storage-controller",
        shared: true,
      },
    ];

    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        workspaceServers: async () => savedServers,
      },
      tmpDir,
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();

    // 1. Configure context window & model parameters
    const configuredSnap = await hub.request({
      action: "configure",
      config: {
        contextWindowTokens: 256000,
        terminalContextChars: 16000,
        maxOutputTokens: 16384,
        maxToolTurns: 30,
        reasoningEffort: "high",
        temperature: 0.15,
      },
    });
    expect(configuredSnap.config.contextWindowTokens).toBe(256000);
    expect(configuredSnap.config.terminalContextChars).toBe(16000);
    expect(configuredSnap.config.reasoningEffort).toBe("high");
    expect(configuredSnap.contextBudget?.contextWindowTokens).toBe(256000);
    expect(configuredSnap.contextBudget?.terminalContextChars).toBe(16000);

    // 2. Save & search Knowledge Base documents
    await hub.request({
      action: "kb-save",
      doc: {
        id: "kb-ontap-qos",
        title: "NetApp ONTAP QoS & WAFL Latency Runbook",
        collection: "netapp-ontap",
        cluster: "NetApp-ONTAP-Prod-SE",
        tags: ["ontap", "qos", "wafl"],
        sourceType: "manual",
        content:
          "# QoS Ceiling Policy\nApply `volume modify -vserver svm_prod -volume vol_scratch -qos-policy-group pg-batch-ceiling` when latency exceeds 1.5ms on aggr2_nvme_db.",
      },
    });

    const dummyTask: AgentTask = {
      id: "task-nextgen",
      title: "Next-gen AI Ops",
      mode: "autonomous",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 20,
      maxMinutes: 15,
      verification: "not-verified",
    };
    const cap = await hub.broker.issue(dummyTask);

    const kbSearchRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_kb_search",
      payload: {
        query: "pg-batch-ceiling aggr2_nvme_db latency",
        cluster: "NetApp-ONTAP-Prod-SE",
      },
    })) as { matches: Array<{ title: string; snippet: string; score: number }> };
    expect(kbSearchRes.matches.length).toBeGreaterThan(0);
    expect(kbSearchRes.matches[0].title).toContain("NetApp ONTAP QoS");
    expect(kbSearchRes.matches[0].snippet).toContain("pg-batch-ceiling");

    // 3. Save Mission Agent & MCP Server
    await hub.request({
      action: "agent-save",
      agent: {
        id: "agent-ontap-sre",
        name: "ONTAP Latency Guardian",
        role: "NetApp ONTAP Performance Engineer",
        mission: "Keep WAFL and NVMe latency under 1.0ms across NetApp-ONTAP-Prod-SE.",
        systemPrompt: "Always check QoS statistics before modifying policy groups.",
        targetCluster: "NetApp-ONTAP-Prod-SE",
        defaultMode: "assisted",
        kbDocIds: ["kb-ontap-qos"],
      },
    });
    await hub.request({
      action: "mcp-save",
      server: {
        id: "mcp-harvest",
        name: "NetApp Harvest MCP",
        transport: "http",
        url: "http://127.0.0.1:18890/mcp",
        enabled: true,
        discoveredTools: [
          {
            name: "get_aggr_iops",
            description: "Fetch aggregate IOPS from Harvest",
          },
        ],
      },
    });

    const snapWithAgentsAndMcp = await hub.snapshot();
    expect(
      snapWithAgentsAndMcp.agents?.some((a) => a.name === "ONTAP Latency Guardian"),
    ).toBe(true);
    expect(
      snapWithAgentsAndMcp.mcpServers?.some((m) => m.name === "NetApp Harvest MCP"),
    ).toBe(true);

    // 4. Workspace Layout Orchestration (split view & ack)
    const layoutRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_workspace_layout",
      payload: {
        operation: "open_cluster_split",
        cluster: "NetApp-ONTAP-Prod-SE",
        layout: "grid",
      },
    })) as {
      ok: boolean;
      layoutEvent: { id: string; operation: string; serverIds: string[] };
    };
    expect(layoutRes.ok).toBe(true);
    expect(layoutRes.layoutEvent.operation).toBe("open_cluster_split");
    expect(layoutRes.layoutEvent.serverIds).toEqual([
      "srv-ontap-01",
      "srv-ontap-02",
    ]);
    expect((await hub.snapshot()).pendingLayoutEvent?.id).toBe(
      layoutRes.layoutEvent.id,
    );

    const ackedSnap = await hub.request({
      action: "layout-event-ack",
      id: layoutRes.layoutEvent.id,
    });
    expect(ackedSnap.pendingLayoutEvent).toBeUndefined();

    // 5. Parallel Cluster Execution across NetApp-ONTAP-Prod-SE
    for (const srv of savedServers) {
      const sid = `sess-${srv.id}`;
      hub.terminals.register(
        { id: sid, label: srv.name, kind: "ssh", profileId: srv.id },
        (data) => {
          const n = /SSHS3;([a-f0-9]{32});BEGIN/.exec(data)?.[1];
          if (n) {
            queueMicrotask(() =>
              hub.terminals.feed(
                sid,
                `\x1b]777;SSHS3;${n};BEGIN\x07aggr1_nvme_prod online\n\x1b]777;SSHS3;${n};END;0;/root\x07`,
              ),
            );
          }
        },
      );
      await hub.terminals.arm(sid, "bash");
    }

    const clusterExecRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_cluster_exec",
      payload: {
        cluster: "NetApp-ONTAP-Prod-SE",
        command: "storage aggregate show",
        description: "Check aggregate capacity across ONTAP cluster",
      },
    })) as {
      ok: boolean;
      nodeCount: number;
      results: Array<{ node: string; exitCode: number; output: string }>;
    };
    expect(clusterExecRes.ok).toBe(true);
    expect(clusterExecRes.nodeCount).toBe(2);
    expect(clusterExecRes.results.map((r) => r.node)).toEqual([
      "aff-a800-dc1-01",
      "aff-a800-dc1-02",
    ]);
    expect(clusterExecRes.results[0].output).toContain("aggr1_nvme_prod online");

    // 6. Deep Storage Ops (cross-server config diff)
    const diffRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_storage_ops",
      payload: {
        operation: "diff_paths",
        targetA: "aff-a800-dc1-01",
        pathA: "/etc/multipath.conf",
        targetB: "aff-a800-dc1-02",
        pathB: "/etc/multipath.conf",
      },
    })) as { ok: boolean; operation: string; unifiedDiff: string };
    expect(diffRes.ok).toBe(true);
    expect(diffRes.operation).toBe("diff_paths");
    expect(diffRes.unifiedDiff).toContain("---");
  });

  it("allows the AI to configure everything in sshs3: advanced SSH profiles, SSH port-forward tunnels (-L/-R/-D), S3 & Directory Sync profiles, Dotfile Pools, keyboard shortcuts, AI model/context settings, and full AppSettings", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-full-config-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const servers: Array<Record<string, unknown>> = [];
    const s3Profiles: Array<Record<string, unknown>> = [];
    const dirSyncProfiles: Array<Record<string, unknown>> = [];
    const dotfilePools: Array<{
      id: string;
      name: string;
      files: Array<{ id: string; remotePath: string; content: string; mode?: string }>;
    }> = [];
    let appSettings: Record<string, unknown> = {
      theme: "dark",
      terminalFontSize: 14,
      shortcuts: { newTerminal: "Ctrl+Shift+T" },
    };

    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        workspaceServers: async () => servers as never[],
        upsertServer: async (input) => {
          const id = input.id || `srv-${servers.length + 1}`;
          const idx = servers.findIndex((s) => s.id === id);
          const merged = {
            ...(idx >= 0 ? servers[idx] : {}),
            ...input,
            id,
          };
          if (idx >= 0) servers[idx] = merged;
          else servers.push(merged);
          return merged as never;
        },
        deleteServer: async (profileId) => {
          const idx = servers.findIndex((s) => s.id === profileId);
          if (idx >= 0) servers.splice(idx, 1);
        },
        extraAppContext: async () => ({
          folders: ["NetApp-ONTAP-Prod-SE"],
          s3Profiles: s3Profiles as never[],
          snippets: [],
          appSettings,
          dotfilesPools: dotfilePools,
          dirSyncProfiles: dirSyncProfiles as never[],
          activeTunnels: [],
        }),
        manageS3Profile: async (input) => {
          if (input.operation === "save_dir_sync_profile") {
            const entry = {
              id: `ds-${dirSyncProfiles.length + 1}`,
              name: input.name,
              sourceRef: input.sourceProviderId,
              sourcePath: input.sourcePath,
              targetRef: input.targetProviderId,
              targetPath: input.targetPath,
              deleteExtraneous: Boolean(input.deleteExtraneous),
            };
            dirSyncProfiles.push(entry);
            return { savedDirSyncProfile: entry };
          }
          if (input.operation === "list_dir_sync_profiles") {
            return { dirSyncProfiles };
          }
          if (input.operation === "delete_dir_sync_profile") {
            const idx = dirSyncProfiles.findIndex(
              (d) => d.id === input.idOrName || d.name === input.idOrName,
            );
            if (idx >= 0) dirSyncProfiles.splice(idx, 1);
            return { deleted: input.idOrName };
          }
          if (input.operation === "upsert_s3_profile") {
            const entry = {
              id: `s3-${s3Profiles.length + 1}`,
              name: input.name,
              endpoint: input.endpoint,
              region: input.region,
              bucket: input.bucket,
              authMethod: input.authMethod,
              awsProfile: input.awsProfile,
            };
            s3Profiles.push(entry);
            return entry;
          }
          return {};
        },
        manageAppSettings: async (input) => {
          if (input.operation === "update_settings" && input.settings) {
            appSettings = { ...appSettings, ...input.settings };
            return appSettings;
          }
          if (input.operation === "update_shortcuts") {
            appSettings.shortcuts = {
              ...(input.resetShortcuts ? {} : (appSettings.shortcuts as Record<string, string>)),
              ...(input.shortcuts ?? {}),
            };
            return { shortcuts: appSettings.shortcuts };
          }
          if (input.operation === "save_dotfile" && input.dotfile) {
            const poolId = input.dotfile.poolId || "default";
            let pool = dotfilePools.find((p) => p.id === poolId);
            if (!pool) {
              pool = {
                id: poolId,
                name: input.dotfile.poolName || "Default Pool",
                files: [],
              };
              dotfilePools.push(pool);
            }
            if (input.dotfile.remotePath) {
              pool.files.push({
                id: `df-${pool.files.length + 1}`,
                remotePath: input.dotfile.remotePath,
                content: input.dotfile.content || "",
                mode: input.dotfile.mode || "644",
              });
            }
            appSettings.dotfilesPoolEnabled = true;
            return { pool, dotfilesPoolEnabled: true };
          }
          if (input.operation === "list_dotfiles") {
            return {
              dotfilesPoolEnabled: Boolean(appSettings.dotfilesPoolEnabled),
              pools: dotfilePools,
            };
          }
          if (input.operation === "delete_dotfile" && input.dotfile) {
            const pool = dotfilePools.find((p) => p.id === (input.dotfile?.poolId || "default"));
            if (pool && input.dotfile.remotePath) {
              pool.files = pool.files.filter((f) => f.remotePath !== input.dotfile?.remotePath);
            }
            return { deletedRemotePath: input.dotfile.remotePath };
          }
          return {};
        },
      },
      tmpDir,
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();

    const task: AgentTask = {
      id: "task-full-cfg",
      title: "Configure all of sshs3",
      mode: "autonomous",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 30,
      maxMinutes: 15,
      verification: "not-verified",
    };
    const cap = await hub.broker.issue(task);

    // 1. Upsert SSH server with full advanced SSH options + ProxyJump + X11 + FIDO2 + Dotfile Pool
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_server",
      payload: {
        operation: "upsert",
        id: "srv-bastion-01",
        name: "ontap-bastion-01",
        host: "10.30.0.10",
        port: 2222,
        username: "secadmin",
        authType: "fido2",
        fido2Resident: true,
        forwardAgent: true,
        x11Forwarding: true,
        compression: true,
        serverAliveInterval: 30,
        poolId: "sre-dotfiles",
        dotfilesSyncPolicy: "push-only",
        autoReconnect: true,
        maxReconnectAttempts: 5,
        extraOptions: { StrictHostKeyChecking: "accept-new" },
        cluster: "NetApp-ONTAP-Prod-SE",
        nodeRole: "bastion",
      },
    });
    expect(servers).toHaveLength(1);
    expect(servers[0].authType).toBe("fido2");
    expect(servers[0].fido2Resident).toBe(true);
    expect(servers[0].forwardAgent).toBe(true);
    expect(servers[0].x11Forwarding).toBe(true);
    expect(servers[0].poolId).toBe("sre-dotfiles");
    expect(servers[0].dotfilesSyncPolicy).toBe("always");
    expect(servers[0].extraOptions).toEqual({ StrictHostKeyChecking: "accept-new" });

    // 2. Configure SSH port-forwarding tunnels (-L and -D) on the server
    const saveTunnelRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_server",
      payload: {
        operation: "save_tunnel",
        serverIdOrName: "ontap-bastion-01",
        tunnelName: "Grafana Dashboard Forward",
        tunnelType: "local",
        localPort: 3000,
        remoteHost: "10.30.10.50",
        remotePort: 3000,
      },
    })) as { ok: boolean; tunnels: Array<{ name: string; localPort: number; type: string }> };
    expect(saveTunnelRes.ok).toBe(true);
    expect(saveTunnelRes.tunnels).toHaveLength(1);
    expect(saveTunnelRes.tunnels[0].localPort).toBe(3000);

    const listTunnelsRes = (await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_server",
      payload: {
        operation: "list_tunnels",
        serverIdOrName: "ontap-bastion-01",
      },
    })) as { ok: boolean; tunnelsByServer: Array<{ tunnels: unknown[] }> };
    expect(listTunnelsRes.ok).toBe(true);
    expect(listTunnelsRes.tunnelsByServer[0].tunnels).toHaveLength(1);

    // 3. Configure Directory Sync profile & S3 profile
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_s3_and_sync",
      payload: {
        operation: "save_dir_sync_profile",
        name: "ONTAP Runbooks to S3",
        sourceProviderId: "local",
        sourcePath: "/ops/runbooks",
        targetProviderId: "s3-grid-se",
        targetPath: "s3://netapp-runbooks/prod",
        deleteExtraneous: true,
      },
    });
    expect(dirSyncProfiles).toHaveLength(1);
    expect(dirSyncProfiles[0].name).toBe("ONTAP Runbooks to S3");
    expect(dirSyncProfiles[0].deleteExtraneous).toBe(true);

    // 4. Configure AppSettings (Perf Bar, Smartcard Auth, Transfer Integrity, Terminal Cursor, etc.)
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_app_and_settings",
      payload: {
        operation: "update_settings",
        theme: "breeze",
        terminalFontSize: 15,
        terminalCursorStyle: "bar",
        perfBarVisible: true,
        perfBarLayout: "detailed",
        smartcardAuthMode: "agent-global",
        verifyTransferIntegrity: true,
        maxConcurrentTransfers: 8,
        maxBandwidthBps: 50_000_000,
      },
    });
    expect(appSettings.theme).toBe("breeze");
    expect(appSettings.terminalCursorStyle).toBe("bar");
    expect(appSettings.perfBarVisible).toBe(true);
    expect(appSettings.smartcardAuthMode).toBe("agent-global");
    expect(appSettings.maxConcurrentTransfers).toBe(8);

    // 5. Configure Keyboard Shortcuts via AI
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_app_and_settings",
      payload: {
        operation: "update_shortcuts",
        shortcutId: "splitVertical",
        shortcutKeys: "Ctrl+Alt+V",
      },
    });
    expect((appSettings.shortcuts as Record<string, string>).splitVertical).toBe("Ctrl+Alt+V");

    // 6. Configure AI Model & Context Window via AI tool (`configure_ai`)
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_app_and_settings",
      payload: {
        operation: "configure_ai",
        aiModel: "gpt-5.4",
        contextWindowTokens: 200000,
        terminalContextChars: 24000,
        maxToolTurns: 25,
        reasoningEffort: "high",
      },
    });
    const snapAfterAiCfg = await hub.snapshot();
    expect(snapAfterAiCfg.config.model).toBe("gpt-5.4");
    expect(snapAfterAiCfg.config.contextWindowTokens).toBe(200000);
    expect(snapAfterAiCfg.config.terminalContextChars).toBe(24000);
    expect(snapAfterAiCfg.config.maxToolTurns).toBe(25);

    // 7. Configure Dotfile Pool & synced dotfiles via AI (`save_dotfile` & `list_dotfiles`)
    await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_app_and_settings",
      payload: {
        operation: "save_dotfile",
        poolId: "sre-dotfiles",
        poolName: "SRE Production Dotfiles",
        remotePath: "~/.bashrc",
        content: "alias ll='ls -lah --color=auto'\nexport EDITOR=vim\n",
        mode: "644",
      },
    });
    expect(dotfilePools).toHaveLength(1);
    expect(dotfilePools[0].id).toBe("sre-dotfiles");
    expect(dotfilePools[0].files[0].remotePath).toBe("~/.bashrc");
    expect(appSettings.dotfilesPoolEnabled).toBe(true);
  });

  it("supports all 5 Open-Source AI Pillars: Multi-Agent Workforce & Swarm Handoffs, Mem0/Letta/Zep Smart Memory & Infra Graph, Orama Hybrid Concept RAG, AST Command Safety Classifier, and 1-Click MCP Marketplace", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { analyzeCommandSafety, splitShellAstSegments } = await import(
      "../../src/main/ai/hub/CommandSafetyService"
    );
    const { KnowledgeBaseService } = await import(
      "../../src/main/ai/hub/KnowledgeBaseService"
    );

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-pillars-"));
    disposals.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
      },
      tmpDir,
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();

    // --- PILLAR 4: AST-style Shell Command Safety Classifier ---
    const astSegments = splitShellAstSegments(
      "df -h | grep -E 'vol|aggr' && kubectl get pvc -A",
    );
    expect(astSegments).toEqual([
      "df -h",
      "grep -E 'vol|aggr'",
      "kubectl get pvc -A",
    ]);

    const safeAnalysis = analyzeCommandSafety(
      "df -h | grep -E 'vol|aggr' && kubectl get pvc -A",
    );
    expect(safeAnalysis.riskLevel).toBe("safe");

    const modifyAnalysis = analyzeCommandSafety(
      "kubectl get pods && systemctl restart trident-csi",
    );
    expect(modifyAnalysis.riskLevel).toBe("modify");

    const destructiveAnalysis = analyzeCommandSafety(
      "ls -la /tmp && rm -rf /var/lib/ceph/osd",
    );
    expect(destructiveAnalysis.riskLevel).toBe("destructive");

    // Save Safety Policy via HubRequest
    const snapPolicy = await hub.request({
      action: "safety-policy-save",
      policy: {
        autoApproveSafeReadOnly: true,
        requireApprovalOnProdTags: true,
        blockDestructiveWithoutConfirm: true,
      },
    });
    expect(snapPolicy.safetyPolicy?.autoApproveSafeReadOnly).toBe(true);

    // --- PILLAR 3: Orama-style Hybrid RAG (BM25 + Bilingual Semantic Concept Vectors + Trigram Similarity) ---
    const kb = new KnowledgeBaseService();
    const doc = kb.createDocument({
      title: "NetApp ONTAP NVMe & WAFL IOPS Troubleshooting",
      collection: "netapp-ontap",
      cluster: "NetApp-ONTAP-Prod-SE",
      tags: ["ontap", "nvme"],
      content:
        "When read/write latency spikes above 2.5ms, inspect qos statistics volume latency show and verify queue depth.",
    });
    // Query in Swedish using synonyms ("hög svarstid disk kötid") that share 0 exact words with the English doc,
    // proving that SEMANTIC_CONCEPT_CLUSTERS ("storage_latency_qos") bridges the language/terminology gap!
    const ragResults = kb.search([doc], "hög svarstid disk kötid", {
      cluster: "NetApp-ONTAP-Prod-SE",
      limit: 3,
    });
    expect(ragResults.length).toBeGreaterThan(0);
    expect(ragResults[0].matchedConcepts).toContain("storage_latency_qos");
    expect(ragResults[0].semanticScore).toBeGreaterThan(0);

    // --- PILLAR 2: Mem0 Deduplication + Letta Memory Tiers + Zep/Graphiti Infra Dependency Graph ---
    await hub.request({
      action: "memory-save",
      entry: {
        title: "NetApp ONTAP SnapMirror Policy",
        text: "SnapMirror XDP lag must stay below 5 minutes on SVM prod_svm_se.",
        kind: "memory",
        scope: "workspace",
        tier: "core",
      },
    });
    // Save overlapping memory with slightly updated text -> should deduplicate & increment updatedCount!
    const snapMem = await hub.request({
      action: "memory-save",
      entry: {
        title: "NetApp ONTAP SnapMirror Policy",
        text: "SnapMirror XDP lag must stay below 5 minutes on SVM prod_svm_se. Alert threshold is 15 minutes.",
        kind: "memory",
        scope: "workspace",
        tier: "core",
      },
    });
    const matchingMemories = snapMem.memories.filter(
      (m) => m.title === "NetApp ONTAP SnapMirror Policy",
    );
    expect(matchingMemories).toHaveLength(1);
    expect(matchingMemories[0].updatedCount).toBe(2);
    expect(matchingMemories[0].tier).toBe("core");
    expect(matchingMemories[0].text).toContain("Alert threshold is 15 minutes");

    // Save Infrastructure Dependency Graph Edge (Zep / Graphiti pattern)
    const snapEdge = await hub.request({
      action: "infra-edge-save",
      edge: {
        from: "K8s-Trident-CSI-Prod",
        to: "NetApp-ONTAP-Prod-SE",
        relation: "mounts_storage",
        label: "Astra Trident mounts ONTAP FlexVols over NFSv4.1",
      },
    });
    expect(
      (snapEdge.infraEdges ?? []).some(
        (e) =>
          e.from === "K8s-Trident-CSI-Prod" &&
          e.to === "NetApp-ONTAP-Prod-SE" &&
          e.relation === "mounts_storage",
      ),
    ).toBe(true);

    // --- PILLAR 5: 1-Click Open-Source MCP Marketplace ---
    const snapMcp = await hub.request({
      action: "mcp-install-preset",
      presetId: "preset-mcp-prometheus",
    });
    expect((snapMcp.mcpCatalog ?? []).length).toBeGreaterThanOrEqual(6);
    expect(
      (snapMcp.mcpServers ?? []).some((s) =>
        s.name.includes("Prometheus & Alertmanager"),
      ),
    ).toBe(true);

    // --- PILLAR 1: Multi-Agent Workforce Orchestrator & Swarm Handoff ---
    await hub.request({
      action: "agent-save",
      agent: {
        id: "ag-ontap-test",
        name: "NetApp ONTAP SRE Specialist",
        role: "ONTAP Architect",
        mission: "Audit ONTAP aggregates and SnapMirror lag",
        systemPrompt: "You are an ONTAP specialist.",
        targetCluster: "NetApp-ONTAP-Prod-SE",
        defaultMode: "assisted",
        enabled: true,
      },
    });
    await hub.request({
      action: "agent-save",
      agent: {
        id: "ag-k8s-test",
        name: "K8s Astra Trident Specialist",
        role: "Kubernetes Storage Engineer",
        mission: "Audit PVCs and multipathd health",
        systemPrompt: "You are a Kubernetes CSI specialist.",
        targetCluster: "K8s-Trident-CSI-Prod",
        defaultMode: "assisted",
        enabled: true,
      },
    });

    const snapWorkforce = await hub.request({
      action: "workforce-run",
      prompt: "Verify ONTAP aggregates and K8s Trident PVCs simultaneously",
      agentIds: ["ag-ontap-test", "ag-k8s-test"],
    });
    expect((snapWorkforce.workforceRuns ?? []).length).toBeGreaterThanOrEqual(1);
    const latestRun = snapWorkforce.workforceRuns![0];
    expect(latestRun.status).toBe("completed");
    expect(latestRun.steps).toHaveLength(2);
    expect(latestRun.synthesis).toContain("AI Workforce Sammanställning");

    // Verify Swarm Handoff on the newly created task
    const createdTask = snapWorkforce.tasks[0];
    expect(createdTask).toBeDefined();
    const snapHandoff = await hub.request({
      action: "agent-handoff",
      taskId: createdTask.id,
      toAgentId: "ag-k8s-test",
      reason: "Focusing on PVC multipath remediation",
    });
    const updatedTask = snapHandoff.tasks.find((t) => t.id === createdTask.id);
    expect(updatedTask?.agentId).toBe("ag-k8s-test");
    expect(
      updatedTask?.messages.some((m) => m.text.includes("Agent Handoff")),
    ).toBe(true);
  });

  it("ships 100% batteries-included out-of-the-box with 6 Mission Agents, 8 @kb Runbooks, 6 Skills + Core Memory, 12 Snippets, and supports 1-click Demo-Lab toggle & Restore Builtins", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { getBuiltinSnippets, setDemoMode } = await import(
      "../../src/main/ai/hub/demoWorkspace"
    );

    setDemoMode(false);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hub-outofthebox-"));
    disposals.push(() => {
      setDemoMode(false);
      return fs.rm(tmpDir, { recursive: true, force: true });
    });

    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
      },
      tmpDir,
    );
    disposals.push(() => hub.dispose());
    await hub.initialize();

    const snap = await hub.snapshot();
    // Even with Demo Mode OFF, all 6 built-in specialist agents and 8 KB runbooks are pre-loaded!
    expect(snap.demoMode).toBe(false);
    expect((snap.agents ?? []).length).toBe(6);
    expect(
      snap.agents?.some((a) => a.id === "builtin-agent-linux-sre"),
    ).toBe(true);
    expect(
      snap.agents?.some((a) => a.id === "builtin-agent-ssh-security"),
    ).toBe(true);
    expect((snap.kbDocuments ?? []).length).toBe(8);
    expect(
      snap.kbDocuments?.some((d) => d.id === "builtin-kb-linux-use-sre"),
    ).toBe(true);
    expect(
      snap.memories.some((m) => m.id === "builtin-skill-linux-use-triage"),
    ).toBe(true);
    expect(
      snap.memories.some((m) => m.id === "builtin-mem-sre-golden-rules"),
    ).toBe(true);
    expect(getBuiltinSnippets().length).toBe(12);

    // Dismissing a built-in agent hides it until restore-builtins is called
    const afterDelete = await hub.request({
      action: "agent-delete",
      id: "builtin-agent-linux-sre",
    });
    expect(
      afterDelete.agents?.some((a) => a.id === "builtin-agent-linux-sre"),
    ).toBe(false);

    const afterRestore = await hub.request({ action: "restore-builtins" });
    expect(
      afterRestore.agents?.some((a) => a.id === "builtin-agent-linux-sre"),
    ).toBe(true);

    // Toggle Demo-Lab ON at runtime via HubRequest
    const afterDemoOn = await hub.request({
      action: "demo-mode-toggle",
      enabled: true,
    });
    expect(afterDemoOn.demoMode).toBe(true);
    expect(afterDemoOn.preferences.demoLabEnabled).toBe(true);
    expect((afterDemoOn.tasks ?? []).length).toBeGreaterThanOrEqual(1);

    // Toggle Demo-Lab OFF again
    const afterDemoOff = await hub.request({
      action: "demo-mode-toggle",
      enabled: false,
    });
    expect(afterDemoOff.demoMode).toBe(false);
  });
});



