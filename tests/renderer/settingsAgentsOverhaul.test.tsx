// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import {
  describeActiveDataFlow,
  isEuPinnedHostname,
  isLoopbackHostname,
  isPrivateNetworkHostname,
  validateEgressPolicy,
} from "../../src/renderer/src/components/AiHub/dataDestination";
import { LABS_ENABLED_STORAGE_KEY, Settings } from "../../src/renderer/src/components/AiHub/SettingsView";
import { SafetyPolicyCard } from "../../src/renderer/src/components/AiHub/SafetyPolicyCard";
import { AgentsAndMcpView } from "../../src/renderer/src/components/AiHub/AgentsAndMcpView";
import {
  AgentTestsView,
  computePassAtK,
  extractRubricScores,
} from "../../src/renderer/src/components/AiHub/AgentTestsView";

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(LABS_ENABLED_STORAGE_KEY);
});

const baseHub = (overrides: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    config: {
      enabled: true,
      provider: "anthropic",
      model: "claude-opus-5-5",
      useHermes: false,
      hasApiKey: false,
      egressPolicy: "standard",
      zdrConfirmed: false,
      piiScrubbing: "standard",
      profiles: [],
      activeProfileByRole: {},
    },
    preferences: {
      background: false,
      autoStart: false,
      inventory: false,
      retentionDays: 30,
    },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
    memories: [],
    schedules: [],
    inventory: [],
    agents: [],
    mcpServers: [],
    rules: [],
    evalCases: [],
    ...overrides,
  }) as unknown as HubSnapshot;

describe("dataDestination residency & data flow", () => {
  it("validates local-only, eu-pinned, and standard ZDR egress policies", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isPrivateNetworkHostname("10.24.1.5")).toBe(true);
    expect(isEuPinnedHostname("eu.api.anthropic.com")).toBe(true);
    expect(isEuPinnedHostname("myorg.westeurope.openai.azure.com")).toBe(true);
    expect(isEuPinnedHostname("api.anthropic.com")).toBe(false);

    const localOk = validateEgressPolicy({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      egressPolicy: "local-only",
    });
    expect(localOk.allowed).toBe(true);

    const localBlocked = validateEgressPolicy({
      provider: "anthropic",
      egressPolicy: "local-only",
    });
    expect(localBlocked.allowed).toBe(false);
    expect(localBlocked.errors[0]).toMatch(/local-only/);

    const euOk = validateEgressPolicy({
      provider: "anthropic",
      baseUrl: "https://eu.api.anthropic.com",
      egressPolicy: "eu-pinned",
      zdrConfirmed: true,
    });
    expect(euOk.allowed).toBe(true);

    const missingZdr = validateEgressPolicy({
      provider: "anthropic",
      egressPolicy: "standard",
      zdrConfirmed: false,
    });
    expect(missingZdr.allowed).toBe(false);
    expect(missingZdr.errors.some((e) => e.includes("zdrConfirmed"))).toBe(true);
  });

  it("describes active data flow channels and subprocessors", () => {
    const flow = describeActiveDataFlow(
      {
        provider: "anthropic",
        egressPolicy: "standard",
        zdrConfirmed: true,
        piiScrubbing: "strict",
      },
      { enabled: true, bucket: "ops-team", region: "eu-north-1" },
    );
    expect(flow.egressValidation.allowed).toBe(true);
    expect(flow.channels.find((c) => c.channel === "llm-inference")?.notes[0]).toContain("Strict");
    expect(flow.subprocessors).toHaveLength(2);
    expect(flow.subprocessors[1].locality).toBe("eu");
  });
});

describe("SettingsView privacy, profiles, role routing, and labs", () => {
  it("updates live 'What leaves this machine' card and saves ZDR/egress/PII settings", async () => {
    const hub = baseHub();
    const act = vi.fn().mockResolvedValue(hub);
    render(<Settings hub={hub} act={act} />);

    expect(screen.getByTestId("data-flow-status-badge")).toHaveTextContent("Blocked by policy");

    fireEvent.click(screen.getByTestId("ai-zdr-confirmed"));
    expect(screen.getByTestId("data-flow-status-badge")).toHaveTextContent("Policy allowed");

    fireEvent.change(screen.getByTestId("ai-egress-policy"), { target: { value: "local-only" } });
    expect(screen.getByTestId("data-flow-status-badge")).toHaveTextContent("Blocked by policy");
    expect(screen.getByTestId("data-flow-errors")).toHaveTextContent(/local-only/);

    fireEvent.change(screen.getByTestId("ai-egress-policy"), { target: { value: "standard" } });
    fireEvent.change(screen.getByTestId("ai-pii-scrubbing"), { target: { value: "strict" } });

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(act).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "configure",
          config: expect.objectContaining({
            egressPolicy: "standard",
            zdrConfirmed: true,
            piiScrubbing: "strict",
          }),
        }),
      ),
    );
  });

  it("supports multi-profile creation, deletion, and per-role routing", async () => {
    const hub = baseHub({
      config: {
        enabled: true,
        provider: "anthropic",
        model: "claude-opus-5-5",
        useHermes: false,
        hasApiKey: false,
        profiles: [
          {
            id: "prof-local",
            name: "Local Ollama",
            provider: "openai-compatible",
            model: "qwen3:32b",
            baseUrl: "http://127.0.0.1:11434/v1",
            egressPolicy: "local-only",
          },
        ],
        activeProfileByRole: { fastTriage: "prof-local" },
      },
    });
    const act = vi.fn().mockResolvedValue(hub);
    render(<Settings hub={hub} act={act} />);

    expect(screen.getByTestId("profile-card-prof-local")).toHaveTextContent("Local Ollama");

    fireEvent.click(screen.getByTestId("add-profile-btn"));
    const form = screen.getByTestId("profile-form");
    fireEvent.change(within(form).getByLabelText("Profile name"), { target: { value: "EU Claude" } });
    fireEvent.change(within(form).getByLabelText("Profile provider"), { target: { value: "anthropic" } });
    fireEvent.change(within(form).getByLabelText("Profile model"), { target: { value: "claude-sonnet-5-5" } });
    fireEvent.change(within(form).getByLabelText("Profile base URL"), {
      target: { value: "https://eu.api.anthropic.com" },
    });
    fireEvent.change(within(form).getByLabelText("Profile egress policy"), { target: { value: "eu-pinned" } });
    fireEvent.change(within(form).getByLabelText("Profile role"), { target: { value: "primary" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(act).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "profile-save",
          activeRole: "primary",
          profile: expect.objectContaining({
            name: "EU Claude",
            provider: "anthropic",
            model: "claude-sonnet-5-5",
            baseUrl: "https://eu.api.anthropic.com",
            egressPolicy: "eu-pinned",
          }),
        }),
      ),
    );

    fireEvent.change(screen.getByTestId("role-select-backgroundDistill"), {
      target: { value: "prof-local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(act).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "configure",
          config: expect.objectContaining({
            activeProfileByRole: expect.objectContaining({
              fastTriage: "prof-local",
              backgroundDistill: "prof-local",
            }),
          }),
        }),
      ),
    );
  });

  it("toggles Labs Features progressive disclosure and persists preference", () => {
    const onToggleLabs = vi.fn();
    const hub = baseHub();
    render(<Settings hub={hub} act={vi.fn().mockResolvedValue(hub)} onToggleLabs={onToggleLabs} />);

    expect(screen.queryByTestId("labs-features-controls")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("labs-features-toggle"));
    expect(screen.getByTestId("labs-features-controls")).toBeVisible();
    expect(window.localStorage.getItem(LABS_ENABLED_STORAGE_KEY)).toBe("true");
    expect(onToggleLabs).toHaveBeenCalledWith(true);
  });
});

describe("SafetyPolicyCard SoD & per-cluster/tag overrides", () => {
  it("toggles Two-Person Rule (SoD), allowed command prefixes, and cluster/tag overrides", async () => {
    const hub = baseHub({
      // A second person can approve here, so a new override starts with two-person approval ticked.
      peerApprovalPossible: true,
      safetyPolicy: {
        autoApproveSafeReadOnly: true,
        requireApprovalOnProdTags: true,
        blockDestructiveWithoutConfirm: true,
        requirePeerApprovalOnProd: false,
        commandAllowPrefixes: ["kubectl get"],
        clusterPolicies: {
          "tag:prod": { maxMode: "plan", requiredApprovals: 2, requireCheckAndRollback: true },
        },
      },
    });
    const act = vi.fn().mockResolvedValue(hub);
    render(<SafetyPolicyCard hub={hub} act={act} />);

    expect(screen.getByTestId("cluster-policy-tag:prod")).toHaveTextContent("2 people approve");
    expect(screen.getByTestId("cluster-policy-tag:prod")).toHaveTextContent("Plan");

    fireEvent.click(screen.getByTestId("safety-peer-approval-toggle"));
    expect(act).toHaveBeenCalledWith({
      action: "safety-policy-save",
      policy: expect.objectContaining({ requirePeerApprovalOnProd: true }),
    });

    fireEvent.change(screen.getByLabelText("New allowed command prefix"), { target: { value: "df -h" } });
    fireEvent.click(screen.getByRole("button", { name: "Add prefix" }));
    expect(act).toHaveBeenCalledWith({
      action: "safety-policy-save",
      policy: expect.objectContaining({ commandAllowPrefixes: ["kubectl get", "df -h"] }),
    });

    fireEvent.click(screen.getByTestId("add-cluster-policy-btn"));
    const form = screen.getByTestId("cluster-policy-form");
    fireEvent.change(within(form).getByLabelText("Cluster or tag selector"), {
      target: { value: "prod-db" },
    });
    fireEvent.change(within(form).getByLabelText("Override max mode"), { target: { value: "plan" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save override" }));

    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "safety-policy-save",
        policy: expect.objectContaining({
          clusterPolicies: expect.objectContaining({
            "prod-db": expect.objectContaining({
              maxMode: "plan",
              requiredApprovals: 2,
              requireCheckAndRollback: true,
            }),
          }),
        }),
      }),
    );
  });
});

describe("AgentsAndMcpView MCP matrix, OAuth 2.1, counts & Workspace Rules", () => {
  it("renders per-tool MCP policy matrix, OAuth 2.1 status, capability counts, and Workspace Rules CRUD", async () => {
    const hub = baseHub({
      kbPages: [{ id: "p1", kind: "procedure", title: "K8s Runbook", when: "pods fail", body: "", targets: [], sources: [], revision: 1, createdAt: 1, updatedAt: 1, updatedBy: "jacob", history: [] }],
      memories: [{ id: "m1", kind: "skill", scope: "workspace", title: "Check ZFS", text: "zpool status", updatedAt: 1 }],
      mcpServers: [
        {
          id: "srv-k8s",
          name: "Kubernetes HTTP",
          transport: "http",
          url: "https://mcp.internal/k8s",
          enabled: true,
          status: "connected",
          oauth: { enabled: true, clientId: "sshs3-client", scopes: ["mcp:read"], connectedAt: 1000 },
          toolPolicies: { get_pods: "allow", delete_pod: "deny" },
          discoveredTools: [
            { name: "get_pods", description: "List pods", readOnly: true },
            { name: "delete_pod", description: "Delete pod", readOnly: false },
          ],
          discoveredPrompts: [{ name: "triage_pod" }],
          discoveredResources: [{ uri: "k8s://cluster" }, { uri: "k8s://nodes" }],
        } as never,
      ],
      rules: [
        {
          id: "r1",
          name: "Prod safety",
          scope: "tag",
          scopeValue: "prod*",
          activation: "always",
          body: "Always verify backups before mutating prod*.",
          priority: 10,
          enabled: true,
        },
      ],
    });
    const act = vi.fn().mockResolvedValue(hub);

    render(
      <AgentsAndMcpView
        hub={hub}
        act={act}
        selectedAgentId=""
        onSelectAgentForChat={vi.fn()}
        onStartedMission={vi.fn()}
      />,
    );

    expect(screen.getByTestId("local-mcp-capabilities")).toHaveTextContent("1 resources · 1 prompts");
    expect(screen.getByTestId("mcp-counts-srv-k8s")).toHaveTextContent("2 tools · 1 prompt · 2 resources");
    expect(screen.getByTestId("mcp-oauth-badge-srv-k8s")).toHaveTextContent("OAuth 2.1 connected");

    fireEvent.change(screen.getByTestId("mcp-tool-policy-srv-k8s-delete_pod"), {
      target: { value: "ask" },
    });
    expect(act).toHaveBeenCalledWith({
      action: "mcp-tool-policy",
      serverId: "srv-k8s",
      toolName: "delete_pod",
      policy: "ask",
    });

    expect(screen.getByTestId("workspace-rule-r1")).toHaveTextContent("tag:prod*");

    fireEvent.click(screen.getByTestId("new-rule-btn"));
    const ruleForm = screen.getByTestId("workspace-rule-form");
    fireEvent.change(within(ruleForm).getByLabelText("Rule name"), {
      target: { value: "Cluster read-only" },
    });
    fireEvent.change(within(ruleForm).getByLabelText("Rule scope"), { target: { value: "cluster" } });
    fireEvent.change(within(ruleForm).getByLabelText("Scope value or glob"), {
      target: { value: "k8s-prod-*" },
    });
    fireEvent.change(within(ruleForm).getByLabelText("Rule body"), {
      target: { value: "Capture pod logs prior to restart." },
    });
    fireEvent.click(within(ruleForm).getByRole("button", { name: "Save rule" }));

    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "rule-save",
        rule: expect.objectContaining({
          name: "Cluster read-only",
          scope: "cluster",
          scopeValue: "k8s-prod-*",
          body: "Capture pod logs prior to restart.",
        }),
      }),
    );
  });
});

describe("AgentTestsView multi-turn, 3-axis rubric, pass@k, tag filter & promote failed task", () => {
  it("computes rubric scores & pass@k, filters by tag, shows multi-turn transcript, and promotes failed tasks", async () => {
    const failedTask = {
      id: "task-fail-1",
      title: "Redis OOM incident",
      mode: "assisted",
      status: "failed",
      createdAt: 1,
      updatedAt: 2,
      maxCommands: 10,
      maxMinutes: 10,
      verification: "not-verified",
      sources: [],
      changes: [],
      messages: [
        { id: "u1", role: "user", text: "Why is Redis restarting?", at: 1 },
        { id: "a1", role: "assistant", text: "Checking logs…", at: 2 },
        { id: "u2", role: "user", text: "Check dmesg too.", at: 3 },
      ],
    };

    const eval1 = {
      id: "e-multi",
      title: "Multi-turn Redis triage",
      prompt: "Why is Redis restarting?",
      mode: "plan",
      fromTaskId: "task-done-1",
      recordedCalls: 2,
      expect: { mention: ["OOM"], notMention: [], mustCall: ["dmesg"], mustNotRun: ["systemctl restart"] },
      runs: [
        {
          at: 20,
          model: "claude-opus-5-5",
          passed: true,
          checks: [
            { name: "ran to an answer", passed: true },
            { name: "mentions “OOM”", passed: true },
            { name: "uses “dmesg”", passed: true },
            { name: "never runs “systemctl restart”", passed: true },
          ],
          answer: "OOM killer terminated redis-server.",
          calls: [{ name: "dmesg", input: "-T" }],
          unrecorded: 0,
          tokens: 500,
        },
        {
          at: 10,
          model: "claude-opus-5-5",
          passed: false,
          checks: [{ name: "ran to an answer", passed: false }],
          answer: "",
          calls: [],
          unrecorded: 0,
          tokens: 100,
        },
      ],
      createdBy: "jacob",
      createdAt: 1,
      updatedAt: 20,
    };

    const multiTask = {
      ...failedTask,
      id: "task-done-1",
      title: "Done Redis task",
      status: "completed",
    };

    const hub = baseHub({
      tasks: [failedTask as never, multiTask as never],
      evalCases: [eval1 as never],
    });
    const act = vi.fn().mockResolvedValue(hub);

    render(<AgentTestsView hub={hub} act={act} />);

    expect(screen.getByTestId("eval-turns-e-multi")).toHaveTextContent("Multi-turn (2 turns)");
    expect(screen.getByTestId("eval-passk-e-multi")).toHaveTextContent("pass@2: 50%");

    const rubricEl = screen.getByTestId("eval-rubric-e-multi");
    expect(within(rubricEl).getByText("Correctness")).toBeVisible();
    expect(within(rubricEl).getByText("Safety")).toBeVisible();
    expect(within(rubricEl).getByText("Efficiency")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show the answer" }));
    expect(screen.getByTestId("eval-transcript-e-multi")).toHaveTextContent("Check dmesg too.");

    // Tag filter
    const filterBar = screen.getByTestId("eval-tag-filters");
    fireEvent.click(within(filterBar).getByRole("button", { name: "multi-turn" }));
    expect(screen.getByTestId("eval-e-multi")).toBeVisible();

    fireEvent.change(screen.getByTestId("eval-search-input"), { target: { value: "nonexistent-xyz" } });
    expect(screen.queryByTestId("eval-e-multi")).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId("eval-search-input"), { target: { value: "" } });

    // Promote failed task
    fireEvent.click(screen.getByTestId("promote-failed-task-btn"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "promote-eval",
        taskId: "task-fail-1",
        title: "Redis OOM incident",
      }),
    );

    // Helper unit assertions
    expect(computePassAtK(eval1.runs as never)).toEqual({ k: 2, passed: 1, ratePct: 50 });
    expect(extractRubricScores(eval1.runs[0] as never, eval1 as never)).toEqual({
      correctness: 100,
      safety: 100,
      efficiency: 100,
    });
  });
});

describe("AgentsAndMcpView shows what was saved for an agent", () => {
  it("says the commands level in the form's words and how far the agent is held, and that an outside agent is not checked", () => {
    const hub = baseHub({
      agents: [
        { id: "a1", name: "Disk watcher", role: "Disks", mission: "Watch the disks.", defaultMode: "advice", allowedTools: ["terminal_command", "file_read"], enabled: true },
        { id: "a2", name: "Fixer", role: "Fixes", mission: "Fix things.", defaultMode: "assisted", allowedTools: ["all"], enabled: true },
      ] as never,
      externalRunners: [{ id: "r1", name: "Claude Code", command: "npx", args: ["-y", "x"], cwd: "/code" }] as never,
    });
    render(<AgentsAndMcpView hub={hub} act={vi.fn().mockResolvedValue(hub)} selectedAgentId="" onSelectAgentForChat={vi.fn()} onStartedMission={vi.fn()} />);
    expect(screen.getByTestId("agent-may-a1")).toHaveTextContent("Commands: Never runs commands, advises only. Held to 2 of the things an agent may do.");
    expect(screen.getByTestId("agent-may-a2")).toHaveTextContent("Commands: Asks before each command. May do everything that level allows.");
    expect(screen.getByTestId("runner-test-r1")).toHaveTextContent("Not checked yet. Test starts the program, greets it and stops it again. It is given no work.");
  });

  it("tests an outside agent on request and says what was found", async () => {
    const hub = baseHub({ externalRunners: [{ id: "r1", name: "Claude Code", command: "npx", args: ["-y", "x"], cwd: "/code" }] as never });
    const act = vi
      .fn()
      .mockResolvedValueOnce({ ...hub, reply: { runnerProbe: { id: "r1", ok: false, detail: 'The program "npx" was not found on this computer. Install it there, or give its full path.' } } })
      .mockResolvedValueOnce({ ...hub, reply: { runnerProbe: { id: "r1", ok: true, detail: "It started and answered as an agent (claude-code 2.1)." } } });
    render(<AgentsAndMcpView hub={hub} act={act} selectedAgentId="" onSelectAgentForChat={vi.fn()} onStartedMission={vi.fn()} />);

    fireEvent.click(screen.getByTestId("runner-test-btn-r1"));
    expect(act).toHaveBeenCalledWith({ action: "runner-test", id: "r1" });
    await waitFor(() => expect(screen.getByTestId("runner-test-r1")).toHaveTextContent('Does not work: The program "npx" was not found on this computer.'));

    fireEvent.click(screen.getByTestId("runner-test-btn-r1"));
    await waitFor(() => expect(screen.getByTestId("runner-test-r1")).toHaveTextContent("Works: It started and answered as an agent (claude-code 2.1)."));
  });
});
