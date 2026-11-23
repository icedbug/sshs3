import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => os.tmpdir(),
  },
}));

import {
  AcpRuntime,
  EXTERNAL_RUNNER_PRESETS,
  buildAcpMcpServers,
  childEnv,
  wrapWithOsSandbox,
} from "../../src/main/ai/hub/AcpRuntime";
import type { RunEvent } from "../../src/main/ai/hub/AgentRuntime";
import { LocalMcpServer } from "../../src/main/ai/hub/LocalMcpServer";
import {
  HermesManager,
  hermesBaseEnvironment,
  hermesPolicyBlocks,
  resolveHermesAllowedDomains,
  wrapHermesSidecarSpawn,
} from "../../src/main/ai/HermesManager";
import type { AgentTask, ExternalRunner } from "../../src/shared/types/aiHub";

const disposals: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  AcpRuntime.clearSessionCache();
  for (const dispose of disposals.splice(0).reverse()) {
    await dispose();
  }
  vi.restoreAllMocks();
});

function makeTask(id: string, text: string, extra: Record<string, unknown> = {}): AgentTask {
  return {
    id,
    title: "Test task",
    mode: "assisted",
    status: "running",
    messages: [{ id: `m-${id}`, role: "user", text, at: Date.now() }],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 5,
    maxMinutes: 5,
    verification: "not-verified",
    ...extra,
  } as unknown as AgentTask;
}

async function writeFakeAgentScript(dir: string, source: string): Promise<string> {
  const file = path.join(dir, "agent.cjs");
  await fs.writeFile(file, source, "utf8");
  return file;
}

function makeRunner(scriptFile: string, cwd: string, extra: Partial<ExternalRunner> = {}): ExternalRunner {
  return {
    id: "test-runner",
    name: "Test ACP Agent",
    command: process.execPath,
    args: [scriptFile],
    cwd,
    updatedAt: Date.now(),
    ...extra,
  };
}

describe("EXTERNAL_RUNNER_PRESETS", () => {
  it("includes opencode preset alongside existing external runner presets", () => {
    const opencode = EXTERNAL_RUNNER_PRESETS.find((p) => p.id === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode).toMatchObject({
      id: "opencode",
      command: "opencode",
      args: ["acp"],
    });
    expect(EXTERNAL_RUNNER_PRESETS.map((p) => p.id)).toEqual(
      expect.arrayContaining(["claude-code", "codex", "gemini", "opencode"]),
    );
  });
});

describe("AcpRuntime model & reasoningEffort propagation", () => {
  it("passes selected model and reasoningEffort in init/session _meta and via session/set_model & session/set_config_option", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-acp-model-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    const logFile = path.join(dir, "rpc.json");
    const script = await writeFakeAgentScript(
      dir,
      `
const fs = require("node:fs");
const readline = require("node:readline");
const log = [];
const writeLog = () => fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(log));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  log.push({ method: m.method, params: m.params });
  writeLog();
  if (m.method === "initialize") {
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (m.method === "session/new") {
    return send({
      jsonrpc: "2.0",
      id: m.id,
      result: {
        sessionId: "sess-model-1",
        models: { currentModelId: "default-model", availableModels: [{ modelId: "claude-opus-5-5" }] },
        configOptions: [{ id: "thought_level", category: "thought_level", currentValue: "medium" }],
      },
    });
  }
  if (m.method === "session/set_model" || m.method === "session/set_config_option") {
    return send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-model-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
`,
    );

    const runtime = new AcpRuntime(makeRunner(script, dir), {
      preface: "Check status",
      ask: async () => true,
    });
    disposals.push(() => runtime.stop());

    const events: RunEvent[] = [];
    await runtime.start(
      makeTask("task-model", "Hello"),
      { kind: "anthropic", model: "claude-opus-5-5", apiKey: "secret-should-not-leak", reasoningEffort: "high" },
      (e) => events.push(e),
    );

    expect(events.at(-1)).toMatchObject({ type: "run.completed", output: "ok" });
    const recorded = JSON.parse(await fs.readFile(logFile, "utf8")) as Array<{ method: string; params: Record<string, unknown> }>;
    expect(recorded.find((r) => r.method === "initialize")?.params._meta).toEqual({
      model: "claude-opus-5-5",
      reasoningEffort: "high",
    });
    expect(recorded.find((r) => r.method === "session/new")?.params._meta).toEqual({
      model: "claude-opus-5-5",
      reasoningEffort: "high",
    });
    expect(recorded.find((r) => r.method === "session/set_model")?.params).toEqual({
      sessionId: "sess-model-1",
      modelId: "claude-opus-5-5",
    });
    expect(recorded.find((r) => r.method === "session/set_config_option")?.params).toEqual({
      sessionId: "sess-model-1",
      configId: "thought_level",
      value: "high",
    });
    expect(JSON.stringify(recorded)).not.toContain("secret-should-not-leak");
  });
});

describe("AcpRuntime session persistence, resume via session/load, and LocalMcpServer bridge", () => {
  it("persists sessionId by task.id, resumes via session/load, falls back to session/new on failure, and bridges LocalMcpServer without leaking SSH/SSHS3 env", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-acp-session-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    const localMcp = new LocalMcpServer({
      tokens: {} as never,
      hubFor: async () => ({
        request: async () => ({}) as never,
        actor: "tester",
      }),
    });
    const mcpUrl = await localMcp.set(true, 0);
    disposals.push(() => localMcp.stop());

    const logFile = path.join(dir, "session-log.json");
    const envFile = path.join(dir, "env.json");
    const script = await writeFakeAgentScript(
      dir,
      `
const fs = require("node:fs");
const readline = require("node:readline");
const logFile = ${JSON.stringify(logFile)};
const existing = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : [];
fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
  SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK || null,
  SSH_AGENT_PID: process.env.SSH_AGENT_PID || null,
  SSHS3_SECRET: process.env.SSHS3_SECRET || null,
}));
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let counter = existing.filter((x) => x.method === "session/new").length;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  existing.push({ method: m.method, params: m.params });
  fs.writeFileSync(logFile, JSON.stringify(existing));
  if (m.method === "initialize") {
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  }
  if (m.method === "session/load") {
    if (m.params.sessionId === "expired-session") {
      return send({ jsonrpc: "2.0", id: m.id, error: { code: -32004, message: "Session not found" } });
    }
    return send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
  if (m.method === "session/new") {
    counter += 1;
    return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-" + counter } });
  }
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sid=" + m.params.sessionId } } } });
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
`,
    );

    const prevSock = process.env.SSH_AUTH_SOCK;
    const prevSshs3 = process.env.SSHS3_SECRET;
    process.env.SSH_AUTH_SOCK = "/tmp/fake-ssh-agent.sock";
    process.env.SSHS3_SECRET = "super-secret"; // pragma: allowlist secret
    disposals.push(() => {
      if (prevSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prevSock;
      if (prevSshs3 === undefined) delete process.env.SSHS3_SECRET;
      else process.env.SSHS3_SECRET = prevSshs3;
    });

    const seenSessions: string[] = [];
    const bridge = {
      server: localMcp,
      token: "s3k_u1.t1.scopedsecretvalue123456", // pragma: allowlist secret
      name: "sshs3-readonly",
      scopes: ["read"],
    };

    // Run 1: creates session "sess-1" via session/new and bridges LocalMcpServer
    const r1 = new AcpRuntime(makeRunner(script, dir), {
      preface: "p",
      ask: async () => true,
      localMcp: bridge,
      onSessionId: (sid) => {
        seenSessions.push(sid);
      },
    });
    disposals.push(() => r1.stop());
    const events1: RunEvent[] = [];
    await r1.start(makeTask("persistent-task", "turn 1"), undefined, (e) => events1.push(e));
    expect(events1.at(-1)?.output).toBe("sid=sess-1");
    expect(seenSessions).toEqual(["sess-1"]);

    // Verify childEnv stripped SSH_AUTH_SOCK & SSHS3_* from actual spawned child
    const spawnedEnv = JSON.parse(await fs.readFile(envFile, "utf8")) as Record<string, string | null>;
    expect(spawnedEnv).toEqual({ SSH_AUTH_SOCK: null, SSH_AGENT_PID: null, SSHS3_SECRET: null });
    expect(childEnv({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/x", SSHS3_TOKEN: "t", KEEP: "1" })).toEqual({ PATH: "/usr/bin" });
    expect(childEnv({ PATH: "/usr/bin", SSH_AUTH_SOCK: "/x", SSHS3_TOKEN: "t", KEEP: "1" }, ["KEEP"])).toEqual({
      PATH: "/usr/bin",
      KEEP: "1",
    });

    // Run 2: same task.id automatically resumes "sess-1" via session/load
    const r2 = new AcpRuntime(makeRunner(script, dir), {
      preface: "p",
      ask: async () => true,
      localMcp: bridge,
    });
    disposals.push(() => r2.stop());
    const events2: RunEvent[] = [];
    await r2.start(makeTask("persistent-task", "turn 2"), undefined, (e) => events2.push(e));
    expect(events2.at(-1)?.output).toBe("sid=sess-1");

    // Run 3: explicit expired sessionId tries session/load, fails, and falls back to session/new ("sess-2")
    const r3 = new AcpRuntime(makeRunner(script, dir), {
      preface: "p",
      ask: async () => true,
      sessionId: "expired-session",
      localMcp: bridge,
      onSessionId: (sid) => {
        seenSessions.push(sid);
      },
    });
    disposals.push(() => r3.stop());
    const events3: RunEvent[] = [];
    await r3.start(makeTask("persistent-task", "turn 3"), undefined, (e) => events3.push(e));
    expect(events3.at(-1)?.output).toBe("sid=sess-2");
    expect(seenSessions).toEqual(["sess-1", "sess-2"]);

    const rpcLog = JSON.parse(await fs.readFile(logFile, "utf8")) as Array<{ method: string; params: Record<string, unknown> }>;
    const methods = rpcLog.map((x) => x.method);
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "initialize",
      "session/load",
      "session/prompt",
      "initialize",
      "session/load",
      "session/new",
      "session/prompt",
    ]);
    const newParams = rpcLog.find((x) => x.method === "session/new")!.params;
    expect(newParams.mcpServers).toEqual([
      {
        type: "http",
        name: "sshs3-readonly",
        url: mcpUrl,
        headers: [{ name: "Authorization", value: "Bearer s3k_u1.t1.scopedsecretvalue123456" }],
      },
    ]);
    const loadParams = rpcLog.find((x) => x.method === "session/load")!.params;
    expect(loadParams.mcpServers).toEqual(newParams.mcpServers);
  });

  it("rejects non-loopback LocalMcpServer bridge URLs", () => {
    expect(() =>
      buildAcpMcpServers({
        localMcp: { url: "https://evil.example.com/mcp", token: "tok" },
      }),
    ).toThrow(/loopback/i);
  });
});

describe("wrapWithOsSandbox", () => {
  it("passes through unchanged when not opted in", () => {
    expect(wrapWithOsSandbox("opencode", ["acp"], { enabled: false })).toEqual({
      command: "opencode",
      args: ["acp"],
      sandboxed: false,
      backend: "none",
    });
  });

  it("wraps with sandbox-exec on macOS when available", () => {
    const res = wrapWithOsSandbox("opencode", ["acp"], {
      enabled: true,
      platform: "darwin",
      cwd: "/Users/dev/repo",
      writePaths: ["/tmp/work"],
      allowedDomains: ["127.0.0.1", "localhost"],
      hasBinary: (b) => b === "sandbox-exec",
    });
    expect(res.sandboxed).toBe(true);
    expect(res.backend).toBe("sandbox-exec");
    expect(res.command).toBe("sandbox-exec");
    expect(res.args[0]).toBe("-p");
    expect(res.args[1]).toContain('(allow file-write* (subpath "/Users/dev/repo"))');
    expect(res.args[1]).toContain('(allow file-write* (subpath "/tmp/work"))');
    expect(res.args[1]).toContain('(allow network-outbound (remote ip "127.0.0.1:*"))');
    expect(res.args.slice(2)).toEqual(["opencode", "acp"]);
  });

  it("wraps with bwrap on Linux when available", () => {
    const res = wrapWithOsSandbox("opencode", ["acp"], {
      enabled: true,
      platform: "linux",
      cwd: "/home/dev/repo",
      readPaths: ["/opt/runtime"],
      writePaths: ["/home/dev/cache"],
      allowNetwork: false,
      hasBinary: (b) => b === "bwrap",
    });
    expect(res.sandboxed).toBe(true);
    expect(res.backend).toBe("bwrap");
    expect(res.command).toBe("bwrap");
    expect(res.args).toContain("--die-with-parent");
    expect(res.args).toContain("--unshare-net");
    expect(res.args).toEqual(expect.arrayContaining(["--ro-bind", "/opt/runtime", "/opt/runtime"]));
    expect(res.args).toEqual(expect.arrayContaining(["--bind", "/home/dev/repo", "/home/dev/repo"]));
    expect(res.args.slice(-3)).toEqual(["--", "opencode", "acp"]);
  });

  it("falls back cleanly on Windows or missing binaries unless failIfUnavailable is true", () => {
    expect(
      wrapWithOsSandbox("opencode", ["acp"], {
        enabled: true,
        platform: "win32",
      }),
    ).toMatchObject({
      command: "opencode",
      args: ["acp"],
      sandboxed: false,
      backend: "none",
    });

    expect(() =>
      wrapWithOsSandbox("opencode", ["acp"], {
        enabled: true,
        platform: "win32",
        failIfUnavailable: true,
      }),
    ).toThrow(/OS sandbox unavailable/);

    expect(
      wrapWithOsSandbox("opencode", ["acp"], {
        enabled: true,
        platform: "linux",
        hasBinary: () => false,
      }),
    ).toMatchObject({
      command: "opencode",
      args: ["acp"],
      sandboxed: false,
      backend: "none",
      reason: "bwrap unavailable",
    });

    expect(() =>
      wrapWithOsSandbox("opencode", ["acp"], {
        enabled: true,
        platform: "darwin",
        hasBinary: () => false,
        failIfUnavailable: true,
      }),
    ).toThrow(/sandbox-exec/);
  });

  it("runs AcpRuntime normally when sandbox falls back, and rejects if failIfUnavailable on unsupported platform", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-acp-sb-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const script = await writeFakeAgentScript(
      dir,
      `
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1 } });
  if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-sb" } });
  if (m.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-sb", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ran" } } } });
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
`,
    );

    const graceful = new AcpRuntime(makeRunner(script, dir), {
      preface: "p",
      ask: async () => true,
      sandbox: { enabled: true, platform: "win32", failIfUnavailable: false },
    });
    disposals.push(() => graceful.stop());
    const events: RunEvent[] = [];
    await graceful.start(makeTask("sb-ok", "hi"), undefined, (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", output: "ran" });

    const strict = new AcpRuntime(makeRunner(script, dir), {
      preface: "p",
      ask: async () => true,
      sandbox: { enabled: true, platform: "win32", failIfUnavailable: true },
    });
    await expect(strict.start(makeTask("sb-fail", "hi"), undefined, () => {})).rejects.toThrow(
      /OS sandbox unavailable/,
    );
  });
});

describe("HermesManager OS sandbox & domain-allowlist wrapper", () => {
  it("resolves model + loopback domain allowlists cleanly", () => {
    expect(
      resolveHermesAllowedDomains(
        { kind: "anthropic", model: "claude-opus-5-5", apiKey: "k" },
        ["https://proxy.corp.internal:8443/v1"],
        "http://127.0.0.1:41234/tool",
      ),
    ).toEqual(["127.0.0.1", "localhost", "api.anthropic.com", "proxy.corp.internal"]);

    expect(
      resolveHermesAllowedDomains({
        kind: "custom",
        model: "qwen",
        baseUrl: "https://eu.llm.example.com/v1",
      }),
    ).toEqual(["127.0.0.1", "localhost", "eu.llm.example.com"]);
  });

  it("wraps sidecar spawns with OS sandbox when available and falls back gracefully unless hardened", async () => {
    const linuxWrapped = await wrapHermesSidecarSpawn(
      { command: "/opt/hermes/python", args: ["-I", "bootstrap.py"], cwd: "/tmp/h", env: { PATH: "/usr/bin" } },
      {
        enabled: true,
        platform: "linux",
        hasBinary: (b) => b === "bwrap",
        allowedDomains: ["127.0.0.1", "localhost", "api.anthropic.com"],
      },
    );
    expect(linuxWrapped.sandboxed).toBe(true);
    expect(linuxWrapped.backend).toBe("bwrap");
    expect(linuxWrapped.command).toBe("bwrap");
    expect(linuxWrapped.env.SSHS3_ALLOWED_DOMAINS).toBe("127.0.0.1,localhost,api.anthropic.com");

    const desktopFallback = await wrapHermesSidecarSpawn(
      { command: "C:\\hermes\\python.exe", args: ["-I", "bootstrap.py"], cwd: "C:\\temp\\h", env: {} },
      {
        enabled: true,
        hardened: false,
        platform: "win32",
        allowedDomains: ["127.0.0.1", "localhost"],
      },
    );
    expect(desktopFallback.sandboxed).toBe(false);
    expect(desktopFallback.backend).toBe("none");
    expect(desktopFallback.command).toBe("C:\\hermes\\python.exe");
    expect(desktopFallback.env.SSHS3_ALLOWED_DOMAINS).toBe("127.0.0.1,localhost");

    await expect(
      wrapHermesSidecarSpawn(
        { command: "C:\\hermes\\python.exe", args: ["-I", "bootstrap.py"], cwd: "C:\\temp\\h", env: {} },
        {
          hardened: true,
          platform: "win32",
        },
      ),
    ).rejects.toThrow(/OS sandbox unavailable/);
  });

  it("preserves HermesManager manifest/env/policy invariants and enforces hardened sandbox on ensureRunning", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-hermes-sb-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const runtimeDir = path.join(dir, "runtime");
    const homeDir = path.join(dir, "home");
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(path.join(runtimeDir, "python-bin"), "stub", "utf8");
    await fs.writeFile(
      path.join(runtimeDir, "manifest.json"),
      JSON.stringify({
        tag: "v1.0.0",
        commit: "f97608f178d1ffeca59860195ab7da295f7c8e5f",
        python: "python-bin",
      }),
      "utf8",
    );

    const spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
    const fakeSpawn = ((file: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      spawned.push({ file, args, env: opts.env });
      const proc = new EventEmitter() as EventEmitter & {
        exitCode: number | null;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => boolean;
      };
      proc.exitCode = null;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {
        proc.exitCode = 0;
        proc.emit("exit", 0);
        return true;
      };
      return proc as never;
    }) as unknown as typeof import("node:child_process").spawn;

    const manager = new HermesManager({
      runtimeDir,
      homeDir,
      spawn: fakeSpawn,
      fetch: (async () => ({ ok: true })) as unknown as typeof fetch,
      sandbox: {
        enabled: true,
        hardened: false,
        platform: "win32",
      },
      allowedDomains: ["llm.internal.example"],
    });
    expect(await manager.getManifest()).toMatchObject({ tag: "v1.0.0", python: "python-bin" });
    const endpoint = await manager.ensureRunning({
      kind: "anthropic",
      model: "claude-opus-5-5",
      apiKey: "ant-test", // pragma: allowlist secret
    });
    expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(manager.isRunning()).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].env?.SSHS3_ALLOWED_DOMAINS).toBe(
      "127.0.0.1,localhost,api.anthropic.com,llm.internal.example",
    );
    await manager.stop();
    expect(manager.isRunning()).toBe(false);

    // Hardened mode rejects on unavailable OS sandbox without spawning
    const hardenedManager = new HermesManager({
      runtimeDir,
      homeDir,
      spawn: fakeSpawn,
      fetch: (async () => ({ ok: true })) as unknown as typeof fetch,
      sandbox: {
        hardened: true,
        platform: "win32",
      },
    });
    await expect(
      hardenedManager.ensureRunning({
        kind: "anthropic",
        model: "claude-opus-5-5",
        apiKey: "ant-test", // pragma: allowlist secret
      }),
    ).rejects.toThrow(/OS sandbox unavailable/);
    expect(spawned).toHaveLength(1);

    // Existing policy/env helpers remain intact
    expect(hermesPolicyBlocks()).toContain('mode: "manual"');
    expect(
      hermesBaseEnvironment(
        { PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/sock", AWS_SECRET_ACCESS_KEY: "x" },
        homeDir,
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: homeDir,
      USERPROFILE: homeDir,
    });
  });
});

describe("AcpRuntime: a reply in a conversation the agent loads again", () => {
  it("does not show or count the earlier conversation the agent replays while it loads the session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-replay-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const script = path.join(dir, "agent.cjs");
    const store = path.join(dir, "history.json");
    // An agent that keeps its sessions and, as the protocol says it must, replays the whole
    // conversation as session/update notifications before it answers session/load.
    await fs.writeFile(
      script,
      `
const fs = require("node:fs");
const readline = require("node:readline");
const store = ${JSON.stringify(store)};
const history = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : [];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const chunk = (sessionId, kind, text) => update(sessionId, { sessionUpdate: kind, content: { type: "text", text } });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === "session/new") return send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "sess-1" } });
  if (m.method === "session/load") {
    for (const h of history) {
      chunk(m.params.sessionId, h.role === "user" ? "user_message_chunk" : "agent_message_chunk", h.text);
      if (h.role === "agent") {
        update(m.params.sessionId, { sessionUpdate: "tool_call", toolCallId: "old-1", title: "Earlier command", kind: "execute", status: "pending", rawInput: { command: "uptime" } });
        update(m.params.sessionId, { sessionUpdate: "tool_call_update", toolCallId: "old-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "earlier output" } }] });
      }
    }
    return send({ jsonrpc: "2.0", id: m.id, result: null });
  }
  if (m.method === "session/prompt") {
    const n = history.filter((h) => h.role === "agent").length + 1;
    const answer = "ANSWER-" + n + ".";
    history.push({ role: "user", text: "(prompt " + n + ")" }, { role: "agent", text: answer });
    fs.writeFileSync(store, JSON.stringify(history));
    chunk(m.params.sessionId, "agent_message_chunk", answer);
    return send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
  }
});
`,
      "utf8",
    );
    const runner: ExternalRunner = { id: "replaying", name: "Replaying agent", command: process.execPath, args: [script], cwd: dir, updatedAt: 1 };
    const conversation = (texts: Array<["user" | "assistant", string]>): AgentTask =>
      makeTask("conv", "", { messages: texts.map(([role, text], i) => ({ id: `m${i}`, role, text, at: i + 1 })) });

    const first = new AcpRuntime(runner, { preface: "p", ask: async () => true });
    disposals.push(() => first.stop());
    const firstEvents: RunEvent[] = [];
    await first.start(conversation([["user", "first question"]]), undefined, (e) => firstEvents.push(e));
    await first.stop();
    expect(firstEvents.at(-1)).toMatchObject({ type: "run.completed", output: "ANSWER-1." });

    const second = new AcpRuntime(runner, { preface: "p", ask: async () => true });
    disposals.push(() => second.stop());
    const events: RunEvent[] = [];
    await second.start(
      conversation([["user", "first question"], ["assistant", "ANSWER-1."], ["user", "second question"]]),
      undefined,
      (e) => events.push(e),
    );
    // Only this run's answer is streamed and returned: the first answer is in the conversation already.
    expect(events.filter((e) => e.type === "message.delta").map((e) => e.delta)).toEqual(["ANSWER-2."]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", output: "ANSWER-2." });
    // Nor is an earlier tool call reported as a step of this run.
    expect(events.filter((e) => e.type === "tool.result")).toEqual([]);
  }, 30_000);
});
