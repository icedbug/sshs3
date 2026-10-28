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
    expect(toolNames).toEqual(["workspace_context", "workspace_remember"]);
    expect(events.find((e) => e.type === "run.completed")?.output).toContain(
      "Hej! Jag kan hjälpa dig",
    );

    // Also excludes execution tools in assisted mode when target is detached ("Context only")
    await runtime.start(
      { ...chatTask, id: "task-context-only", mode: "assisted", target: undefined },
      { kind: "openai-codex", model: "gpt-5.3-codex" },
      () => {},
    );
    expect(capturedBody.model).toBe("gpt-6.1-sol");
    const contextOnlyTools = ((capturedBody.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(contextOnlyTools).toEqual(["workspace_context", "workspace_remember"]);

    // Includes execution tools in assisted mode when target is attached
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
    ]);
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
});


