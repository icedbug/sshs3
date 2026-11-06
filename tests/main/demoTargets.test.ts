import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setDemoModeForTesting } from "../../src/main/demo/demoMode";
import { DemoStorageProvider } from "../../src/main/demo/DemoStorageProvider";
import { executeDemoServerCommand } from "../../src/main/demo/DemoVirtualPty";
import { StorageRegistry } from "../../src/main/storage/StorageRegistry";
import { SFTPStorageProvider } from "../../src/main/storage/SFTPStorageProvider";
import { S3StorageProvider } from "../../src/main/storage/S3StorageProvider";
import { SSHPtyManager } from "../../src/main/ssh/SSHPtyManager";
import { McpClientManager } from "../../src/main/ai/hub/McpClientManager";
import type { HubHost } from "../../src/main/ai/hub/HubService";
import type { AgentTask, WorkspaceServerSummary } from "../../src/shared/types/aiHub";
import type { SSHConnectionConfig } from "../../src/shared/types/ssh";
import type { S3Config, SFTPConfig } from "../../src/shared/types/storage";

// Every real ssh process would be spawned through node-pty: recorded here, never started.
const pty = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ default: { spawn: pty.spawn }, spawn: pty.spawn }));

function fakeSshProcess() {
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  return {
    pid: 4242,
    cols: 80,
    rows: 24,
    process: "ssh",
    handleFlowControl: false,
    onData: () => ({ dispose: () => {} }),
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    write: () => {},
    resize: () => {},
    clear: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {
      for (const listener of [...exitListeners]) listener({ exitCode: 0 });
    },
  };
}

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  setDemoModeForTesting(undefined);
});

// Terminals give every session a fresh config.id and send the saved profile's id alongside it.
const SESSION_ID = "6f1c2a9e-1b7d-4a53-9f0e-2d8c4b7a1e35";
const REAL_PROFILE_ID = "8a3f5c71-2e4d-4b9a-a1c6-7d0e9f2b3c48";
const DEMO_PROFILE_ID = "demo-netapp-aff-a800-01a";

describe("SSH sessions of demo targets", () => {
  let manager: SSHPtyManager;
  // A demo fixture's connection details; the address is in the demo range, which decides nothing.
  const node: SSHConnectionConfig = {
    id: SESSION_ID,
    name: "netapp-aff-a800-01a",
    host: "10.30.10.11",
    port: 22,
    username: "admin",
    authType: "agent",
  };

  beforeEach(() => {
    pty.spawn.mockReset();
    pty.spawn.mockImplementation(() => fakeSshProcess());
    manager = new SSHPtyManager();
  });

  afterEach(async () => {
    await manager.killAll();
  });

  it("runs a demo profile on the virtual demo terminal, also after a reconnect, and never spawns ssh", async () => {
    setDemoModeForTesting(true);
    const session = await manager.createSession(node, { cols: 100, rows: 30, profileId: DEMO_PROFILE_ID });
    const output: string[] = [];
    session.onData((data) => output.push(data));
    session.write("storage aggregate show\r");
    expect(output.join("")).toContain("aggr1_nvme_prod");

    const reconnected = await session.reconnect?.();
    expect(reconnected).toBe(true);
    expect(pty.spawn).not.toHaveBeenCalled();
  });

  it("connects every other profile with ssh, whatever its address, and demo ids too outside demo mode", async () => {
    setDemoModeForTesting(true);
    await manager.createSession(node, { cols: 100, rows: 30, profileId: REAL_PROFILE_ID });
    expect(pty.spawn).toHaveBeenCalledTimes(1);
    expect(String(pty.spawn.mock.calls[0][0])).toMatch(/^ssh(\.exe)?$/);

    setDemoModeForTesting(false);
    await manager.createSession(
      { ...node, id: "0b9d4e2f-5a6c-4f81-9e3d-c2b7a8f1d064" },
      { cols: 100, rows: 30, profileId: DEMO_PROFILE_ID },
    );
    expect(pty.spawn).toHaveBeenCalledTimes(2);
  });
});

describe("storage of demo targets", () => {
  let registry: StorageRegistry;
  const sftpConfig: SFTPConfig = {
    id: DEMO_PROFILE_ID,
    name: "netapp-aff-a800-01a",
    host: "10.30.10.11",
    port: 22,
    username: "admin",
    authType: "password",
    password: "demo",
  };
  const s3Config: S3Config = {
    id: "demo-s3-storagegrid-prod",
    name: "StorageGRID Prod",
    endpoint: "https://s3-dc1.storage.acme.se:10443",
    region: "us-east-1",
    accessKeyId: "demo",
    secretAccessKey: "demo",
  };

  beforeEach(() => {
    registry = new StorageRegistry();
  });

  afterEach(async () => {
    await registry.disconnectAll();
  });

  it("serves demo fixtures from the in-memory demo storage, found by provider or profile id", async () => {
    setDemoModeForTesting(true);
    const sftp = await registry.getOrCreate({
      id: `sftp-${DEMO_PROFILE_ID}`,
      name: "netapp-aff-a800-01a",
      type: "sftp",
      sftpConfig,
    });
    expect(sftp).toBeInstanceOf(DemoStorageProvider);
    expect((await sftp.list("/etc")).map((entry) => entry.name)).toContain("multipath.conf");

    const s3 = await registry.getOrCreate({
      id: `s3-${s3Config.id}`,
      name: s3Config.name,
      type: "s3",
      s3Config,
    });
    expect(s3).toBeInstanceOf(DemoStorageProvider);
    expect((await s3.list("/")).map((entry) => entry.name)).toContain("ontap-fabricpool-tier");

    // The AI's file tools wrap a terminal's connection in a synthetic provider id; the terminal's
    // profile id is what identifies the demo target then.
    const aiFiles = await registry.getOrCreate(
      {
        id: `ai-file:${SESSION_ID}:1`,
        name: "netapp-aff-a800-01a",
        type: "sftp",
        sftpConfig: { ...sftpConfig, id: `ai-file:${SESSION_ID}:1` },
      },
      { profileId: DEMO_PROFILE_ID },
    );
    expect(aiFiles).toBeInstanceOf(DemoStorageProvider);
  });

  it("connects real profiles for real, even with a demo-looking address or endpoint", async () => {
    setDemoModeForTesting(true);
    const sftp = await registry.getOrCreate({
      id: `sftp-${REAL_PROFILE_ID}`,
      name: "lab-ontap",
      type: "sftp",
      sftpConfig: { ...sftpConfig, id: REAL_PROFILE_ID },
    });
    expect(sftp).toBeInstanceOf(SFTPStorageProvider);

    const s3 = await registry.getOrCreate({
      id: `s3-${REAL_PROFILE_ID}`,
      name: "Acme bucket",
      type: "s3",
      s3Config: { ...s3Config, id: REAL_PROFILE_ID },
    });
    expect(s3).toBeInstanceOf(S3StorageProvider);
  });

  it("treats demo ids as ordinary profiles outside demo mode", async () => {
    setDemoModeForTesting(false);
    const sftp = await registry.getOrCreate({
      id: `sftp-${DEMO_PROFILE_ID}`,
      name: "netapp-aff-a800-01a",
      type: "sftp",
      sftpConfig,
    });
    expect(sftp).toBeInstanceOf(SFTPStorageProvider);

    const s3 = await registry.getOrCreate({
      id: `s3-${s3Config.id}`,
      name: s3Config.name,
      type: "s3",
      s3Config,
    });
    expect(s3).toBeInstanceOf(S3StorageProvider);
  });
});

describe("virtual demo terminal", () => {
  it("picks the appliance personality from the host name", () => {
    expect(executeDemoServerCommand("netapp-aff-a800-01a", "uptime").output).toContain("NetApp Release");
    expect(executeDemoServerCommand("k8s-gpu-io-worker-01", "uptime").output).toContain("load average");
  });
});

describe("AI tools on demo targets", () => {
  const servers: WorkspaceServerSummary[] = [
    {
      id: DEMO_PROFILE_ID,
      name: "netapp-aff-a800-01a",
      host: "10.30.10.11",
      port: 22,
      username: "admin",
      cluster: "NetApp-ONTAP-Prod-SE",
      shared: true,
    },
    {
      id: "srv-lab-ontap",
      name: "lab-ontap",
      host: "10.30.10.12",
      port: 22,
      username: "admin",
      cluster: "NetApp-ONTAP-Prod-SE",
      shared: true,
    },
  ];

  async function createHub(host: Partial<HubHost> = {}) {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-demo-targets-"));
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        aiConfigFilePath: path.join(tmpDir, "ai-config.json"),
        workspaceServers: async () => servers,
        ...host,
      },
      tmpDir,
    );
    disposals.push(async () => {
      await hub.dispose();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
    await hub.initialize();
    return hub;
  }

  function autonomousTask(id: string): AgentTask {
    return {
      id,
      title: "Demo targets",
      mode: "autonomous",
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
  }

  it("scripts cluster commands only for demo servers, recognised by id rather than address", async () => {
    setDemoModeForTesting(true);
    const hub = await createHub();
    const cap = await hub.broker.issue(autonomousTask("task-demo-cluster"));
    const run = async () =>
      (await hub.broker.invoke(cap.key, {
        action: "sshs3_cluster_exec",
        payload: { cluster: "NetApp-ONTAP-Prod-SE", command: "storage aggregate show" },
      })) as { results: Array<{ node: string; source: string }> };

    const demoRun = await run();
    expect(demoRun.results.find((r) => r.node === "netapp-aff-a800-01a")?.source).toBe(
      `demo-cluster:${DEMO_PROFILE_ID}`,
    );
    // A real server in the same address range is not fake: without an open terminal it stays unconnected.
    expect(demoRun.results.find((r) => r.node === "lab-ontap")?.source).toBe("unconnected:srv-lab-ontap");

    setDemoModeForTesting(false);
    const normalRun = await run();
    expect(normalRun.results.find((r) => r.node === "netapp-aff-a800-01a")?.source).toBe(
      `unconnected:${DEMO_PROFILE_ID}`,
    );
  });

  it("scripts storage results only when a demo target is involved; real targets take the real path", async () => {
    setDemoModeForTesting(true);
    const storageOps = vi.fn(async (_input: { targetA: string }) => ({ ok: true, real: true }));
    const hub = await createHub({ storageOps });
    const cap = await hub.broker.issue(autonomousTask("task-demo-storage"));

    // Given by name: the server it names is the demo fixture.
    const demoRes = await hub.broker.invoke(cap.key, {
      action: "sshs3_storage_ops",
      payload: { operation: "list_files", targetA: "netapp-aff-a800-01a", path: "/etc" },
    });
    expect(demoRes).toMatchObject({ ok: true, operation: "list_files", target: "netapp-aff-a800-01a" });
    expect(storageOps).not.toHaveBeenCalled();

    const realRes = await hub.broker.invoke(cap.key, {
      action: "sshs3_storage_ops",
      payload: { operation: "list_files", targetA: "srv-lab-ontap", path: "/etc" },
    });
    expect(realRes).toEqual({ ok: true, real: true });
    expect(storageOps).toHaveBeenCalledTimes(1);
    expect(storageOps).toHaveBeenCalledWith(expect.objectContaining({ targetA: "srv-lab-ontap" }));
  });

  it("answers demo MCP fixtures from their script without starting or contacting them", async () => {
    setDemoModeForTesting(true);
    const callTool = vi.spyOn(McpClientManager.prototype, "callTool").mockImplementation(async () => {
      throw new Error("contacted a demo MCP server");
    });
    const testAndDiscover = vi
      .spyOn(McpClientManager.prototype, "testAndDiscover")
      .mockImplementation(async () => {
        throw new Error("started a demo MCP server");
      });
    disposals.push(() => {
      callTool.mockRestore();
      testAndDiscover.mockRestore();
    });
    const hub = await createHub();
    const cap = await hub.broker.issue(autonomousTask("task-demo-mcp"));

    const res = (await hub.broker.invoke(cap.key, {
      action: "mcp__demo-mcp-netapp-harvest__ontap_get_volume_metrics",
      payload: {},
    })) as { ok: boolean; output: string };
    expect(res.ok).toBe(true);
    expect(res.output).toContain("NetApp-ONTAP-Prod-SE");

    const snap = await hub.request({ action: "mcp-test", id: "demo-mcp-s3-inspector" });
    expect(snap.mcpServers?.find((m) => m.id === "demo-mcp-s3-inspector")?.status).toBe("connected");
    expect(callTool).not.toHaveBeenCalled();
    expect(testAndDiscover).not.toHaveBeenCalled();
  });
});
