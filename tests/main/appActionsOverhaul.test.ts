import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChange,
  AgentTask,
  McpServerConfig,
  MissionAgent,
  WorkspaceServerSummary,
} from "../../src/shared/types/aiHub";
import type { AppActionHost } from "../../src/main/ai/hub/HubService";

const k8sMocks = vi.hoisted(() => ({
  listContexts: vi.fn(),
  listPods: vi.fn(),
  describePod: vi.fn(),
  listNode: vi.fn(),
  listPodForAllNamespaces: vi.fn(),
  listNamespacedEvent: vi.fn(),
  listEventForAllNamespaces: vi.fn(),
  readNamespacedPodLog: vi.fn(),
  readNamespacedPod: vi.fn(),
  getNamespacedCustomObject: vi.fn(),
  listNamespacedCustomObject: vi.fn(),
  listClusterCustomObject: vi.fn(),
}));

vi.mock("../../src/main/services/K8sDiscoveryService", () => ({
  K8sDiscoveryService: class {
    listContexts = k8sMocks.listContexts;
    listPods = k8sMocks.listPods;
    describePod = k8sMocks.describePod;
  },
}));

vi.mock("../../src/main/services/k8sClient", () => ({
  loadK8sClient: async () => ({
    CoreV1Api: class CoreV1Api {},
    CustomObjectsApi: class CustomObjectsApi {},
  }),
}));

vi.mock("../../src/main/services/k8sKubeConfig", () => ({
  loadKubeConfigForContext: async () => ({
    makeApiClient: (ApiClass: { name?: string }) => {
      if (ApiClass?.name === "CustomObjectsApi") {
        return {
          getNamespacedCustomObject: k8sMocks.getNamespacedCustomObject,
          listNamespacedCustomObject: k8sMocks.listNamespacedCustomObject,
          listClusterCustomObject: k8sMocks.listClusterCustomObject,
        };
      }
      return {
        listNode: k8sMocks.listNode,
        listPodForAllNamespaces: k8sMocks.listPodForAllNamespaces,
        listNamespacedEvent: k8sMocks.listNamespacedEvent,
        listEventForAllNamespaces: k8sMocks.listEventForAllNamespaces,
        readNamespacedPodLog: k8sMocks.readNamespacedPodLog,
        readNamespacedPod: k8sMocks.readNamespacedPod,
      };
    },
  }),
}));

import { handleAppAction } from "../../src/main/ai/hub/AppActions";
import { DEFAULT_SAFETY_POLICY } from "../../src/main/ai/hub/CommandSafetyService";

function makeTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-1",
    title: "Test task",
    mode: "assisted",
    status: "running",
    messages: [],
    changes: [],
    sources: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    maxCommands: 20,
    maxMinutes: 10,
    verification: "not-verified",
    ...overrides,
  };
}

function makeServer(overrides: Partial<WorkspaceServerSummary> = {}): WorkspaceServerSummary {
  return {
    id: "srv-1",
    name: "web-01",
    host: "10.0.0.10",
    port: 22,
    username: "ubuntu",
    shared: true,
    ...overrides,
  };
}

function createHarness(options: {
  servers?: WorkspaceServerSummary[];
  mcpServers?: McpServerConfig[];
  agents?: MissionAgent[];
  terminals?: Array<{
    id: string;
    generation: string;
    label: string;
    profileId?: string;
    state: string;
  }>;
  execResult?: (sessionId: string, cmd: string) => Promise<{ exitCode: number; output: string }>;
  fileHandler?: NonNullable<AppActionHost["host"]["file"]>;
} = {}) {
  const servers = options.servers ?? [makeServer()];
  const mcpServers = options.mcpServers ?? [];
  const agents = options.agents ?? [];
  const terminalsList = options.terminals ?? [];

  const requests: unknown[] = [];
  const mcpCalls: Array<{ server: McpServerConfig; toolName: string; args: Record<string, unknown> }> = [];
  const activities: AgentChange[] = [];

  const hub: AppActionHost = {
    recheckChange: vi.fn(),
    // No run here was asked for from chat.
    chatFence: () => undefined,
    // No chat bot in these tests: nothing is kept, so nothing can be searched.
    chat: { index: { list: () => [] }, search: () => [], thread: () => [] } as unknown as AppActionHost["chat"],
    store: {
      data: {
        tasks: [],
        memories: [],
        schedules: [],
        workTickets: [],
        workGoals: [],
        infraEdges: [],
        safetyPolicy: { ...DEFAULT_SAFETY_POLICY },
        preferences: {
          background: false,
          autoStart: false,
          inventory: true,
          retentionDays: 30,
        },
      },
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as AppActionHost["store"],
    host: {
      changed: vi.fn(),
      inventoryTargets: async () => [],
      openSchedule: vi.fn(),
      backgroundChanged: vi.fn(),
      show: vi.fn(),
      manageFolders: vi.fn().mockResolvedValue({ ok: true }),
      manageS3Profile: vi.fn().mockResolvedValue({ ok: true }),
      manageAppSettings: vi.fn().mockResolvedValue({ ok: true }),
      storageOps: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
      file: options.fileHandler,
    },
    terminals: {
      list: () => terminalsList as never,
      ensureReady: vi.fn(async (id: string) => {
        const found = terminalsList.find((t) => t.id === id);
        return {
          id,
          generation: found?.generation ?? "gen-1",
          label: found?.label ?? id,
          state: "ready",
        } as never;
      }),
      claim: vi.fn(),
      execute: vi.fn(async (id: string, _gen: string, _taskId: string, cmd: string) => {
        if (options.execResult) return options.execResult(id, cmd);
        return { exitCode: 0, output: `ok:${id}` };
      }),
    } as unknown as AppActionHost["terminals"],
    config: {
      getConfig: vi.fn().mockResolvedValue({ provider: "openai-codex", model: "gpt-5" }),
      getView: vi.fn().mockResolvedValue({ actorName: "Alice", provider: "openai-codex", model: "gpt-5" }),
    } as unknown as AppActionHost["config"],
    mcp: {
      resolveQualifiedCall: (
        list: McpServerConfig[],
        qualifiedName: string,
        opts?: { allowedServerIds?: string[] },
      ) => {
        for (const server of list) {
          if (!server.enabled) continue;
          if (opts?.allowedServerIds && !opts.allowedServerIds.includes(server.id)) continue;
          const prefix = `mcp__${server.id}__`;
          if (!qualifiedName.startsWith(prefix)) continue;
          const toolName = qualifiedName.slice(prefix.length);
          const tool = (server.discoveredTools ?? []).find((t) => t.name === toolName);
          if (tool) return { server, toolName, tool };
        }
        return undefined;
      },
      callTool: vi.fn(async (server: McpServerConfig, toolName: string, args: Record<string, unknown>) => {
        mcpCalls.push({ server, toolName, args });
        return { ok: true, output: { toolName, args } };
      }),
    } as unknown as AppActionHost["mcp"],
    kb: { searchHybrid: vi.fn().mockResolvedValue({ retrieval: "lexical", matches: [] }) } as never,
    embeddings: {} as never,
    s3Workspace: { getStatus: () => ({ enabled: false }) } as never,
    pendingLayoutEvent: undefined,
    request: vi.fn(async (req: unknown) => {
      requests.push(req);
      return { workspaceServers: servers };
    }) as never,
    changed: vi.fn(),
    closeWhenRunEnds: vi.fn(),
    getMcpServersList: () => mcpServers,
    getKbDocumentsList: () => [],
    getAgentsList: () => agents,
    getWorkforceRunsList: () => [],
    getInfraEdgesList: () => [],
    collectExtraContext: vi.fn(async () => ({ workspaceServers: servers })),
    resolveServerTarget: vi.fn(async (q?: string) => {
      if (!q) return undefined;
      const lower = q.toLowerCase();
      return servers.find(
        (s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower || s.host.toLowerCase() === lower,
      );
    }),
    isDemoTargetRef: vi.fn().mockResolvedValue(false),
    rememberFromRun: vi.fn().mockResolvedValue({ proposal: false, entry: { id: "mem-1" } }),
    saveMemoryInternal: vi.fn().mockResolvedValue(undefined),
    resolveActorName: vi.fn().mockResolvedValue("Alice"),
    recordAgentChangeActivity: vi.fn(async (_task: AgentTask, change: AgentChange) => {
      activities.push(change);
    }),
    kbEmbedder: vi.fn().mockResolvedValue(undefined),
    beginWorkforceRun: vi.fn(),
    investigate: vi.fn().mockResolvedValue([]),
    reviewPlan: vi.fn(),
    planProposed: vi.fn(),
    saveTicketFrom: vi.fn(),
    notePageOpened: vi.fn(),
    noteKbGap: vi.fn(),
    pagesWithUse: () => [],
    commentTicket: vi.fn(),
  };

  return { hub, requests, mcpCalls, activities };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AppActions overhaul", () => {
  describe("1. strict only() & field validation across all 11 sshs3_* handlers", () => {
    it("rejects unknown operations across all 11 handlers with no fall-through into create/write", async () => {
      const { hub, requests } = createHarness();
      const task = makeTask();

      const allElevenTools = [
        "sshs3_manage_server",
        "sshs3_manage_cluster_and_folders",
        "sshs3_manage_memory_and_activity",
        "sshs3_manage_schedule",
        "sshs3_manage_s3_and_sync",
        "sshs3_manage_app_and_settings",
        "sshs3_kb_manage",
        "sshs3_tickets",
        "sshs3_workspace_layout",
        "sshs3_storage_ops",
        "sshs3_agent_and_mcp_manage",
      ];

      for (const action of allElevenTools) {
        await expect(
          handleAppAction(hub, task, {
            action,
            payload: { operation: "bogus_write_op", title: "ShouldNeverCreate", name: "nope", host: "1.2.3.4" },
          }),
        ).rejects.toThrow(/There is no operation "bogus_write_op"/);
      }

      // Also reject non-string operation values instead of silently falling back
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_manage_schedule",
          payload: { operation: 123 },
        }),
      ).rejects.toThrow(/Invalid "operation"/);

      expect(requests).toHaveLength(0);
      expect(hub.host.manageFolders).not.toHaveBeenCalled();
      expect(hub.host.manageS3Profile).not.toHaveBeenCalled();
      expect(hub.host.manageAppSettings).not.toHaveBeenCalled();
      expect(hub.host.storageOps).not.toHaveBeenCalled();
      expect(hub.pendingLayoutEvent).toBeUndefined();
    });

    it("rejects silent 8080/local coercions in save_tunnel and validates ports/enums strictly", async () => {
      const { hub, requests } = createHarness();
      const task = makeTask();

      // Invalid tunnelType must throw instead of silently becoming "local"
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_manage_server",
          payload: {
            operation: "save_tunnel",
            serverIdOrName: "web-01",
            tunnelType: "udp",
            localPort: 3000,
            remotePort: 3000,
          },
        }),
      ).rejects.toThrow(/Invalid "tunnelType"/);

      // Missing localPort must throw instead of defaulting to 8080
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_manage_server",
          payload: {
            operation: "save_tunnel",
            serverIdOrName: "web-01",
            tunnelType: "local",
            remotePort: 3000,
          },
        }),
      ).rejects.toThrow(/localPort/);

      // Non-integer / string / out-of-range ports must throw
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_manage_server",
          payload: {
            operation: "save_tunnel",
            serverIdOrName: "web-01",
            tunnelType: "local",
            localPort: "8080",
            remotePort: 80,
          },
        }),
      ).rejects.toThrow(/Invalid "localPort"/);

      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_manage_server",
          payload: {
            operation: "upsert",
            serverIdOrName: "web-01",
            port: 70000,
          },
        }),
      ).rejects.toThrow(/Invalid "port"/);

      // delete_tunnel with empty query must not wipe all tunnels via .includes("")
      const authorize = vi.fn().mockResolvedValue(undefined);
      await expect(
        handleAppAction(
          hub,
          task,
          {
            action: "sshs3_manage_server",
            payload: {
              operation: "delete_tunnel",
              serverIdOrName: "web-01",
            },
          },
          authorize,
        ),
      ).rejects.toThrow(/delete_tunnel requires/);

      // Valid save_tunnel succeeds cleanly
      const saved = (await handleAppAction(hub, task, {
        action: "sshs3_manage_server",
        payload: {
          operation: "save_tunnel",
          serverIdOrName: "web-01",
          tunnelName: "metrics",
          tunnelType: "local",
          localPort: 9090,
          remotePort: 9090,
        },
      })) as { ok: boolean; tunnel: { localPort: number; type: string } };
      expect(saved.ok).toBe(true);
      expect(saved.tunnel.localPort).toBe(9090);
      expect(saved.tunnel.type).toBe("local");
      expect(requests).toHaveLength(1);
    });

    it("enforces required fields & strict types on schedule, app settings, layout, storage, and mcp manage", async () => {
      const { hub } = createHarness({
        mcpServers: [
          {
            id: "mcp-a",
            name: "Alpha",
            transport: "stdio",
            command: "npx",
            enabled: true,
          },
        ],
      });
      const task = makeTask();

      // schedule save requires title + prompt on create
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_manage_schedule",
          payload: { operation: "save", intervalMinutes: 15 },
        }),
      ).rejects.toThrow(/requires "title" and "prompt"/);

      // invalid reasoningEffort / temperature throws loudly
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_manage_app_and_settings",
          payload: { operation: "configure_ai", reasoningEffort: "maximum" },
        }),
      ).rejects.toThrow(/Invalid "reasoningEffort"/);

      // invalid layout throws loudly instead of coercing to "grid"
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_workspace_layout",
          payload: { operation: "open_cluster_split", layout: "diagonal" },
        }),
      ).rejects.toThrow(/Invalid "layout"/);

      // storage_ops requires targetA
      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_storage_ops",
          payload: { operation: "read_remote_file" },
        }),
      ).rejects.toThrow(/requires "targetA"/);

      // save_mcp_server requires transport & command/url, and delete_mcp_server rejects empty query
      const authorize = vi.fn().mockResolvedValue(undefined);
      await expect(
        handleAppAction(
          hub,
          task,
          {
            action: "sshs3_agent_and_mcp_manage",
            payload: { operation: "save_mcp_server", name: "Broken", transport: "websocket" },
          },
          authorize,
        ),
      ).rejects.toThrow(/Invalid "transport"/);

      await expect(
        handleAppAction(
          hub,
          task,
          {
            action: "sshs3_agent_and_mcp_manage",
            payload: { operation: "delete_mcp_server" },
          },
          authorize,
        ),
      ).rejects.toThrow(/requires "idOrName"/);
    });
  });

  describe("2. sshs3_k8s_inspect read-only diagnostics with secret scrubbing", () => {
    it("supports cluster_triage, describe_pod, pod_logs (previous + tailLines), and pod_metrics with maskContext", async () => {
      const { hub } = createHarness();
      const task = makeTask({ mode: "advice" });

      k8sMocks.listContexts.mockResolvedValue([
        { contextName: "prod-eu", clusterName: "prod", isCurrent: true, isOpenShift: false, namespaces: [] },
      ]);
      k8sMocks.listNode.mockResolvedValue({
        items: [
          {
            metadata: { name: "node-1" },
            spec: { unschedulable: false },
            status: { conditions: [{ type: "Ready", status: "True" }] },
          },
          {
            metadata: { name: "node-2" },
            spec: { unschedulable: true },
            status: { conditions: [{ type: "Ready", status: "False", reason: "KubeletNotReady" }] },
          },
        ],
      });
      k8sMocks.listPodForAllNamespaces.mockResolvedValue({
        items: [
          {
            metadata: { name: "api-0", namespace: "payments" },
            spec: { nodeName: "node-1" },
            status: {
              phase: "Running",
              containerStatuses: [{ ready: false, restartCount: 4, state: { waiting: { reason: "CrashLoopBackOff" } } }],
            },
          },
        ],
      });
      k8sMocks.listEventForAllNamespaces.mockResolvedValue({
        items: [
          {
            type: "Warning",
            reason: "BackOff",
            message: "Error pulling with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload.sig",
            involvedObject: { namespace: "payments", kind: "Pod", name: "api-0" },
            count: 3,
          },
        ],
      });

      const triage = (await handleAppAction(hub, task, {
        action: "sshs3_k8s_inspect",
        payload: { operation: "cluster_triage" },
      })) as {
        ok: boolean;
        summary: { nodeCount: number; unreadyNodes: number; unhealthyPodCount: number };
        warningEvents: Array<{ message: string }>;
      };

      expect(triage.ok).toBe(true);
      expect(triage.summary.nodeCount).toBe(2);
      expect(triage.summary.unreadyNodes).toBe(1);
      expect(triage.summary.unhealthyPodCount).toBe(1);
      expect(triage.warningEvents[0].message).not.toContain("secretpayload");
      expect(triage.warningEvents[0].message).toContain("[redacted]");

      k8sMocks.describePod.mockResolvedValue({
        name: "api-0",
        namespace: "payments",
        phase: "Running",
        yaml: "kind: Pod\ntoken: ghp_1234567890abcdefghijklmnop",
        events: [],
        annotations: { note: "Authorization: Bearer supersecret12345678" },
      });

      const described = (await handleAppAction(hub, task, {
        action: "sshs3_k8s_inspect",
        payload: { operation: "describe_pod", context: "prod-eu", namespace: "payments", pod: "api-0" },
      })) as { ok: boolean; description: { yaml: string; annotations: { note: string } } };
      expect(described.ok).toBe(true);
      expect(described.description.yaml).not.toContain("ghp_1234567890abcdefghijklmnop");
      expect(described.description.annotations.note).not.toContain("supersecret12345678");

      k8sMocks.readNamespacedPodLog.mockResolvedValue(
        "line 1\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK\n-----END RSA PRIVATE KEY-----\nfatal crash",
      );
      const logs = (await handleAppAction(hub, task, {
        action: "sshs3_k8s_inspect",
        payload: {
          operation: "pod_logs",
          context: "prod-eu",
          namespace: "payments",
          pod: "api-0",
          container: "app",
          previous: true,
          tailLines: 50,
        },
      })) as { ok: boolean; previous: boolean; tailLines: number; logs: string };

      expect(k8sMocks.readNamespacedPodLog).toHaveBeenCalledWith({
        name: "api-0",
        namespace: "payments",
        container: "app",
        previous: true,
        tailLines: 50,
      });
      expect(logs.ok).toBe(true);
      expect(logs.previous).toBe(true);
      expect(logs.tailLines).toBe(50);
      expect(logs.logs).not.toContain("MIIEowIBAAK");
      expect(logs.logs).toContain("[private key redacted]");

      k8sMocks.getNamespacedCustomObject.mockResolvedValue({
        containers: [{ name: "app", usage: { cpu: "250m", memory: "128Mi" } }],
      });
      k8sMocks.readNamespacedPod.mockResolvedValue({
        spec: { containers: [{ name: "app", resources: { limits: { cpu: "500m" } } }] },
      });
      const metrics = (await handleAppAction(hub, task, {
        action: "sshs3_k8s_inspect",
        payload: { operation: "pod_metrics", context: "prod-eu", namespace: "payments", pod: "api-0" },
      })) as { ok: boolean; metrics: { containers: Array<{ usage: { cpu: string } }> } };
      expect(metrics.ok).toBe(true);
      expect(metrics.metrics.containers[0].usage.cpu).toBe("250m");

      await expect(
        handleAppAction(hub, task, {
          action: "sshs3_k8s_inspect",
          payload: { operation: "delete_pod" },
        }),
      ).rejects.toThrow(/There is no operation "delete_pod"/);
    });
  });

  describe("3. sshs3_cluster_exec staged execution & prod role/count reporting", () => {
    it("reports target node roles & count before execution and stops after canary failure", async () => {
      const servers: WorkspaceServerSummary[] = [
        makeServer({ id: "n1", name: "db-primary", host: "10.0.1.1", cluster: "Prod-DB", nodeRole: "primary", tags: ["prod"] }),
        makeServer({ id: "n2", name: "db-replica-1", host: "10.0.1.2", cluster: "Prod-DB", nodeRole: "replica", tags: ["prod"] }),
        makeServer({ id: "n3", name: "db-replica-2", host: "10.0.1.3", cluster: "Prod-DB", nodeRole: "replica", tags: ["prod"] }),
      ];
      const terminals = servers.map((s) => ({
        id: `term-${s.id}`,
        generation: "g1",
        label: s.name,
        profileId: s.id,
        state: "ready",
      }));
      const execOrder: string[] = [];
      const { hub } = createHarness({
        servers,
        terminals,
        execResult: async (sessionId) => {
          execOrder.push(sessionId);
          if (sessionId === "term-n1") return { exitCode: 2, output: "canary failed" };
          return { exitCode: 0, output: "ok" };
        },
      });
      const task = makeTask();
      let seenBeforeExec: AgentChange | undefined;
      const authorize = vi.fn(async (change: AgentChange) => {
        seenBeforeExec = { ...change };
        expect(execOrder).toHaveLength(0);
      });

      const res = (await handleAppAction(
        hub,
        task,
        {
          action: "sshs3_cluster_exec",
          payload: {
            cluster: "Prod-DB",
            command: "systemctl status postgresql",
            description: "Check DB units",
          },
        },
        authorize,
      )) as {
        ok: boolean;
        aborted: boolean;
        executedCount: number;
        nodeCount: number;
        prodTarget: boolean;
        roleCounts: Record<string, number>;
        skippedNodes?: string[];
      };

      expect(authorize).toHaveBeenCalledTimes(1);
      expect(seenBeforeExec?.description).toContain("PROD");
      expect(seenBeforeExec?.description).toContain("3 nodes");
      expect(seenBeforeExec?.description).toContain("primary:1, replica:2");
      expect(seenBeforeExec?.blastRadius).toBe("3 nodes (primary:1, replica:2) [PROD]");

      expect(execOrder).toEqual(["term-n1"]);
      expect(res.ok).toBe(false);
      expect(res.aborted).toBe(true);
      expect(res.executedCount).toBe(1);
      expect(res.nodeCount).toBe(3);
      expect(res.prodTarget).toBe(true);
      expect(res.roleCounts).toEqual({ primary: 1, replica: 2 });
      expect(res.skippedNodes).toEqual(["db-replica-1", "db-replica-2"]);
    });

    it("starts no further stage once the run is stopped", async () => {
      const servers: WorkspaceServerSummary[] = [
        makeServer({ id: "s1", name: "app-1", host: "10.0.3.1", cluster: "Stage", nodeRole: "worker" }),
        makeServer({ id: "s2", name: "app-2", host: "10.0.3.2", cluster: "Stage", nodeRole: "worker" }),
        makeServer({ id: "s3", name: "app-3", host: "10.0.3.3", cluster: "Stage", nodeRole: "worker" }),
      ];
      const terminals = servers.map((s) => ({ id: `term-${s.id}`, generation: "g1", label: s.name, profileId: s.id, state: "ready" }));
      const execOrder: string[] = [];
      const task = makeTask();
      const { hub } = createHarness({
        servers,
        terminals,
        execResult: async (sessionId) => {
          execOrder.push(sessionId);
          // The person stops the run while the canary runs.
          task.status = "cancelled";
          return { exitCode: 0, output: "ok" };
        },
      });
      const res = (await handleAppAction(hub, task, {
        action: "sshs3_cluster_exec",
        payload: { cluster: "Stage", command: "systemctl reload app", batchSize: 1, stopOnFirstFailure: false },
      })) as { aborted: boolean; executedCount: number; skippedNodes?: string[] };
      expect(execOrder).toEqual(["term-s1"]);
      expect(res.aborted).toBe(true);
      expect(res.executedCount).toBe(1);
      expect(res.skippedNodes).toEqual(["app-2", "app-3"]);
    });

    it("supports batchSize + stopOnFirstFailure: false across all batches", async () => {
      const servers: WorkspaceServerSummary[] = [
        makeServer({ id: "a1", name: "app-1", host: "10.0.2.1", cluster: "App", nodeRole: "worker" }),
        makeServer({ id: "a2", name: "app-2", host: "10.0.2.2", cluster: "App", nodeRole: "worker" }),
        makeServer({ id: "a3", name: "app-3", host: "10.0.2.3", cluster: "App", nodeRole: "worker" }),
        makeServer({ id: "a4", name: "app-4", host: "10.0.2.4", cluster: "App", nodeRole: "worker" }),
      ];
      const terminals = servers.map((s) => ({
        id: `term-${s.id}`,
        generation: "g1",
        label: s.name,
        profileId: s.id,
        state: "ready",
      }));
      const execOrder: string[] = [];
      const { hub } = createHarness({
        servers,
        terminals,
        execResult: async (sessionId) => {
          execOrder.push(sessionId);
          return sessionId === "term-a2"
            ? { exitCode: 1, output: "fail a2" }
            : { exitCode: 0, output: `ok ${sessionId}` };
        },
      });
      const task = makeTask();

      const res = (await handleAppAction(hub, task, {
        action: "sshs3_cluster_exec",
        payload: {
          cluster: "App",
          command: "uptime",
          canaryFirst: false,
          batchSize: 2,
          stopOnFirstFailure: false,
        },
      })) as {
        ok: boolean;
        aborted: boolean;
        stagesCompleted: number;
        executedCount: number;
      };

      expect(execOrder).toEqual(["term-a1", "term-a2", "term-a3", "term-a4"]);
      expect(res.stagesCompleted).toBe(2);
      expect(res.executedCount).toBe(4);
      expect(res.aborted).toBe(false);
      expect(res.ok).toBe(false);
    });
  });

  describe("4. mcp__* toolPolicies, trustReadOnlyHint, and inputSchema validation", () => {
    it("enforces deny/ask/allow policies, trustReadOnlyHint: false, and inputSchema checks", async () => {
      const mcpServers: McpServerConfig[] = [
        {
          id: "k8s",
          name: "Kubernetes",
          transport: "stdio",
          command: "mcp-k8s",
          enabled: true,
          trustReadOnlyHint: false,
          toolPolicies: {
            get_pods: "ask",
            delete_pod: "deny",
            restart_pod: "allow",
          },
          discoveredTools: [
            {
              name: "get_pods",
              description: "List pods",
              readOnly: true,
              inputSchema: {
                type: "object",
                properties: {
                  namespace: { type: "string" },
                  limit: { type: "integer", minimum: 1 },
                },
                required: ["namespace"],
                additionalProperties: false,
              },
            },
            {
              name: "describe_node",
              description: "Describe a node",
              readOnly: true,
              inputSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            },
            { name: "delete_pod", description: "Delete pod", readOnly: false },
            { name: "restart_pod", description: "Restart pod", readOnly: false },
          ],
        },
      ];

      const { hub, mcpCalls } = createHarness({ mcpServers });
      const task = makeTask({ mode: "autonomous" });
      const authorize = vi.fn().mockResolvedValue(undefined);

      // deny blocks immediately
      await expect(
        handleAppAction(hub, task, { action: "mcp__k8s__delete_pod", payload: {} }, authorize),
      ).rejects.toThrow(/denied by tool policy/);
      expect(authorize).not.toHaveBeenCalled();

      // inputSchema rejects missing required field, wrong type, or unknown field
      await expect(
        handleAppAction(hub, task, { action: "mcp__k8s__get_pods", payload: {} }, authorize),
      ).rejects.toThrow(/requires parameter "namespace"/);

      await expect(
        handleAppAction(
          hub,
          task,
          { action: "mcp__k8s__get_pods", payload: { namespace: "default", limit: "five" } },
          authorize,
        ),
      ).rejects.toThrow(/expected integer/);

      await expect(
        handleAppAction(
          hub,
          task,
          { action: "mcp__k8s__get_pods", payload: { namespace: "default", extra: true } },
          authorize,
        ),
      ).rejects.toThrow(/does not accept unknown parameter "extra"/);

      // An MCP question still goes through the broker as an ordinary tool call.
      await handleAppAction(
        hub,
        task,
        { action: "mcp__k8s__get_pods", payload: { namespace: "default", limit: 10 } },
        authorize,
      );
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize.mock.calls[0][0]).toMatchObject({ forceApproval: true });

      // trustReadOnlyHint: false requires authorize even without an explicit "ask" policy
      await handleAppAction(
        hub,
        task,
        { action: "mcp__k8s__describe_node", payload: { name: "node-1" } },
        authorize,
      );
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(authorize.mock.calls[1][0].riskReason).toContain("does not trust readOnlyHint");

      // An allowed writing tool still goes through the workspace rules.
      await handleAppAction(hub, task, { action: "mcp__k8s__restart_pod", payload: {} }, authorize);
      expect(authorize).toHaveBeenCalledTimes(3);
      expect(mcpCalls).toHaveLength(3);
    });
  });

  describe("5. file_patch action forwarding", () => {
    it("forwards file_patch / sshs3_file_patch cleanly to hub.host.file and records completed activity", async () => {
      const fileSpy = vi.fn(async (t: AgentTask, req: { action: string; path?: string; expectedHash?: string; edits?: unknown[] }) => {
        t.changes.push({
          id: "chg-patch",
          kind: "file",
          target: "web-01",
          description: `${req.path} — patch`,
          status: "completed",
          at: Date.now(),
        });
        return { ok: true, patched: req.path, editsApplied: req.edits?.length };
      });
      const { hub, activities } = createHarness({ fileHandler: fileSpy as never });
      const task = makeTask();
      const authorize = vi.fn().mockResolvedValue(undefined);

      await expect(
        handleAppAction(hub, task, { action: "file_patch", payload: { path: "/etc/hosts" } }, authorize),
      ).rejects.toThrow(/requires "expectedHash"/);

      await expect(
        handleAppAction(
          hub,
          task,
          { action: "file_patch", payload: { path: "/etc/hosts", expectedHash: "abc", edits: [] } },
          authorize,
        ),
      ).rejects.toThrow(/non-empty "edits" array/);

      const result = await handleAppAction(
        hub,
        task,
        {
          action: "sshs3_file_patch",
          payload: {
            path: "/etc/nginx/nginx.conf",
            expectedHash: "sha256-hash",
            edits: [{ oldText: "worker_processes 1;", newText: "worker_processes 4;" }],
            description: "Tune workers",
          },
        },
        authorize,
      );

      expect(fileSpy).toHaveBeenCalledTimes(1);
      expect(fileSpy.mock.calls[0][1]).toMatchObject({
        action: "file-patch",
        path: "/etc/nginx/nginx.conf",
        expectedHash: "sha256-hash",
        expected: "sha256-hash",
        description: "Tune workers",
      });
      expect(result).toEqual({ ok: true, patched: "/etc/nginx/nginx.conf", editsApplied: 1 });
      expect(activities).toHaveLength(1);
      expect(activities[0].id).toBe("chg-patch");
    });
  });
});
