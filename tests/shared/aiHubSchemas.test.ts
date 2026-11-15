import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  formatMemoryScope,
  parseMemoryScope,
  type AgentChange,
  type AgentMode,
  type AgentSchedule,
  type AgentTask,
  type HubRequest,
  type McpServerConfig,
  type MemoryEntry,
  type MemoryScope,
  type RunbookTemplate,
  type SafetyPolicyConfig,
  type WorkTicket,
  type WorkspaceRule,
} from "../../src/shared/types/aiHub";
import {
  DEFAULT_AI_CONFIG,
  type AiConfig,
  type AiConfigView,
  type ProviderProfile,
} from "../../src/shared/types/ai";
import {
  countUrgentInboxItems,
  filterInboxItems,
  inboxItems,
  inboxPriorityBucket,
  isInboxItemSnoozed,
  type InboxInput,
  type InboxPriorityBucket,
} from "../../src/shared/aiHubInbox";
import {
  AI_POLICY_DEFINITIONS,
  EMPTY_POLICY,
  POLICY_DEFINITIONS,
  type AiPolicyConfig,
  type PolicyDocument,
  type PolicyInfo,
} from "../../src/shared/types/policy";

describe("aiHub shared schemas (Wave 0 additive compatibility)", () => {
  it("supports plan mode alongside advice, assisted, and autonomous", () => {
    const modes: AgentMode[] = ["advice", "plan", "assisted", "autonomous"];
    expect(AGENT_MODES).toEqual(modes);
  });

  it("preserves legacy AgentTask and supports additive task, usage, toolLog, and source fields", () => {
    const legacyTask: AgentTask = {
      id: "task-legacy",
      title: "Check nginx",
      mode: "assisted",
      status: "completed",
      messages: [],
      changes: [],
      sources: [],
      createdAt: 1,
      updatedAt: 2,
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };
    expect(legacyTask.parentTaskId).toBeUndefined();

    const extendedTask: AgentTask = {
      ...legacyTask,
      id: "task-extended",
      mode: "plan",
      parentTaskId: "task-legacy",
      forkedFromMessageId: "msg-2",
      recordingIds: ["rec-1", "rec-2"],
      tainted: true,
      sessionAllowPrefixes: ["kubectl get", "systemctl status"],
      handoffChain: ["triage", "k8s-ops"],
      sources: [
        {
          id: "src-1",
          label: "web-01 terminal",
          text: "nginx error",
          observedAt: 10,
          kind: "terminal",
          tokenEstimate: 120,
        },
      ],
      toolLog: [
        {
          name: "terminal_run",
          input: "systemctl status nginx",
          output: "active (running)",
          at: 11,
          durationMs: 240,
          exitCode: 0,
          target: "web-01",
          ok: true,
        },
      ],
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadTokens: 800,
        cacheCreationTokens: 150,
        costUsd: 0.0125,
      },
      runUsage: {
        inputTokens: 200,
        outputTokens: 50,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        costUsd: 0.002,
      },
    };
    expect(extendedTask.usage?.cacheReadTokens).toBe(800);
    expect(extendedTask.recordingIds).toEqual(["rec-1", "rec-2"]);
    expect(extendedTask.handoffChain).toEqual(["triage", "k8s-ops"]);
  });

  it("supports additive AgentChange preflight, multi-approval, idempotency, and structuredCheck fields", () => {
    const change: AgentChange = {
      id: "chg-1",
      kind: "file",
      target: "prod-db-01",
      description: "Update postgresql.conf",
      status: "pending",
      beforeHash: "sha256:aaa",
      dryRunOutput: "ALTER SYSTEM SET max_connections = 300;",
      blastRadius: "1 primary node; reload required",
      turnIndex: 3,
      approvals: [
        { actor: "alice", actorId: "usr-1", at: 100, allowed: true, note: "LGTM" },
        { actor: "bob", actorId: "usr-2", at: 105, allowed: true },
      ],
      requiredApprovals: 2,
      preflightSnapshot: "connections=142/200",
      idempotencyKey: "idem-chg-1",
      structuredCheck: { regex: "max_connections\\s*=\\s*300", maxNumber: 500, equals: "300" },
      at: 99,
    };
    expect(change.approvals).toHaveLength(2);
    expect(change.requiredApprovals).toBe(2);
    expect(change.structuredCheck?.maxNumber).toBe(500);
  });

  it("extends MemoryEntry with verification/staleness/skill fields and provides tag/env scope helpers", () => {
    const scopeTag: MemoryScope = formatMemoryScope("tag", "prod");
    const scopeEnv: MemoryScope = formatMemoryScope("env", "staging");
    expect(scopeTag).toBe("tag:prod");
    expect(scopeEnv).toBe("env:staging");

    expect(parseMemoryScope("workspace")).toEqual({ kind: "workspace" });
    expect(parseMemoryScope("server:web-01")).toEqual({ kind: "server", value: "web-01" });
    expect(parseMemoryScope("tag:prod")).toEqual({ kind: "tag", value: "prod" });
    expect(parseMemoryScope("env:staging")).toEqual({ kind: "env", value: "staging" });
    expect(parseMemoryScope("custom")).toEqual({ kind: "unknown", value: "custom" });

    const entry: MemoryEntry = {
      id: "mem-1",
      kind: "skill",
      scope: scopeTag,
      title: "Drain k8s node safely",
      text: "Cordon then drain with ignore-daemonsets",
      updatedAt: 1000,
      lastVerifiedAt: 950,
      staleReason: "kubectl version upgraded",
      validUntil: 5000,
      commandTemplate: "kubectl drain {{node}} --ignore-daemonsets",
      preconditions: ["PDB satisfied"],
      verifyCommand: "kubectl get node {{node}} -o jsonpath='{.spec.unschedulable}'",
      proven: true,
      sourceTrust: "human",
    };
    expect(entry.proven).toBe(true);
    expect(entry.sourceTrust).toBe("human");
  });

  it("supports additive McpServerConfig, SafetyPolicyConfig, WorkTicket, and AgentSchedule fields", () => {
    const mcp: McpServerConfig = {
      id: "mcp-1",
      name: "prometheus",
      transport: "http",
      url: "https://mcp.internal/prom",
      enabled: true,
      toolPolicies: { query_range: "allow", delete_silence: "deny", create_silence: "ask" },
      trustReadOnlyHint: false,
      oauth: { enabled: true, clientId: "sshs3", scopes: ["read:metrics"], connectedAt: 123 },
    };
    expect(mcp.toolPolicies?.delete_silence).toBe("deny");

    const safety: SafetyPolicyConfig = {
      autoApproveSafeReadOnly: true,
      requireApprovalOnProdTags: true,
      blockDestructiveWithoutConfirm: true,
      requirePeerApprovalOnProd: true,
      commandAllowPrefixes: ["systemctl status", "kubectl get"],
      clusterPolicies: {
        "prod-eu": {
          maxMode: "plan",
          requiredApprovals: 2,
          requireCheckAndRollback: true,
          frozenUntil: 999999,
        },
      },
    };
    expect(safety.clusterPolicies?.["prod-eu"].maxMode).toBe("plan");

    const ticket: WorkTicket = {
      id: "tk-1",
      title: "High 5xx rate",
      description: "Ingress 502 spike",
      status: "todo",
      createdBy: "alertmanager",
      createdAt: 1,
      updatedAt: 2,
      hypotheses: [{ id: "h1", text: "Upstream timeout", status: "open", evidence: [] }],
      correlatedAlerts: [{ fingerprint: "fp1", summary: "PodCrashLoop", at: 2, severity: "critical" }],
      runbookId: "rb-1",
      targetSelector: { tags: ["prod"], cluster: "eu-west", glob: "web-*", serverIds: ["s1"] },
    };
    expect(ticket.correlatedAlerts).toHaveLength(1);

    const schedule: AgentSchedule = {
      id: "sched-1",
      title: "Morning health",
      prompt: "Check disks and services",
      profileId: "p1",
      shell: "bash",
      intervalMinutes: 60,
      nextRunAt: 200,
      enabled: true,
      mode: "advice",
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      maxCommands: 5,
      maxMinutes: 3,
      cron: "30 7 * * 1-5",
      timezone: "Europe/Stockholm",
      quietSentinel: true,
      missedPolicy: "skip",
      eventTrigger: { kind: "facts_drift", cooldownMinutes: 30 },
      runbookId: "rb-1",
      lastRunSummary: "HEARTBEAT_OK",
    };
    expect(schedule.quietSentinel).toBe(true);
    expect(schedule.eventTrigger?.kind).toBe("facts_drift");
  });

  it("defines RunbookTemplate, WorkspaceRule, and additive HubRequest variants", () => {
    const runbook: RunbookTemplate = {
      id: "rb-1",
      name: "Nginx reload",
      description: "Validate config then reload",
      inputs: [{ name: "env", type: "enum", options: ["staging", "prod"], required: true }],
      steps: [
        { id: "s1", kind: "check", command: "nginx -t", expected: "syntax is ok" },
        { id: "s2", kind: "command", command: "systemctl reload nginx" },
        { id: "s3", kind: "ai_diagnose", prompt: "Inspect /var/log/nginx/error.log" },
      ],
      targetSelector: { tags: ["web"], cluster: "prod-eu" },
      dispatchStrategy: "canary_then_rolling",
      maxConcurrency: 2,
    };
    expect(runbook.steps).toHaveLength(3);

    const rule: WorkspaceRule = {
      id: "rule-1",
      name: "Prod change guard",
      scope: "env",
      scopeValue: "prod",
      activation: "always",
      description: "Require verification before and after prod mutations",
      body: "Always verify service status before and after reloading.",
      applyToReadOnly: false,
    };
    expect(rule.scope).toBe("env");

    const requests: HubRequest[] = [
      { action: "restore-checkpoint", taskId: "t1", changeId: "c1" },
      { action: "rollback-change", taskId: "t1", changeId: "c1", verify: true },
      { action: "task-fork", taskId: "t1", fromMessageId: "m2", mode: "plan" },
      { action: "compact-task", taskId: "t1", focus: "keep nginx errors" },
      { action: "snooze-inbox", itemId: "alert:k1", durationMinutes: 60 },
      { action: "ack-inbox", itemId: "alert:k1", acknowledged: true },
      { action: "promote-eval", taskId: "t1", title: "Nginx reload regression" },
      { action: "rule-save", rule },
      { action: "rule-delete", id: "rule-1" },
      { action: "runbook-save", runbook },
      { action: "runbook-delete", id: "rb-1" },
      { action: "runbook-run", id: "rb-1", inputs: { env: "staging" }, dryRun: true },
      {
        action: "profile-save",
        profile: { name: "Local Ollama", provider: "openai-compatible", model: "qwen3:32b", baseUrl: "http://127.0.0.1:11434/v1" },
        activeRole: "fastTriage",
      },
      { action: "profile-delete", id: "prof-1" },
      { action: "mcp-tool-policy", serverId: "mcp-1", toolName: "query_range", policy: "allow" },
      { action: "workforce-pause", paused: true, reason: "maintenance window" },
    ];
    expect(requests).toHaveLength(16);
  });

  it("keeps AiConfig flat fields intact and adds ProviderProfile & privacy/residency fields", () => {
    const legacy: AiConfig = { ...DEFAULT_AI_CONFIG };
    expect(legacy.provider).toBe("anthropic");

    const profile: ProviderProfile = {
      id: "prof-eu",
      name: "Azure EU",
      provider: "openai-compatible",
      model: "gpt-6.1-sol",
      baseUrl: "https://swedencentral.api.cognitive.microsoft.com/openai/v1",
      egressPolicy: "eu-pinned",
      zdrConfirmed: true,
      hasApiKey: true,
      keyStorage: "encrypted",
    };

    const view: AiConfigView = {
      ...DEFAULT_AI_CONFIG,
      hasApiKey: true,
      profiles: [profile],
      activeProfileByRole: { primary: "prof-eu", fastTriage: "prof-eu" },
      egressPolicy: "eu-pinned",
      zdrConfirmed: true,
      piiScrubbing: "strict",
    };
    expect(view.profiles?.[0].id).toBe("prof-eu");
    expect(view.piiScrubbing).toBe("strict");
  });

  it("supports inbox priority buckets, snooze/ack state filtering, and urgent counting backward-compatibly", () => {
    const buckets: Record<string, InboxPriorityBucket> = {
      approval: inboxPriorityBucket("approval"),
      plan: inboxPriorityBucket("plan"),
      question: inboxPriorityBucket("question"),
      alert: inboxPriorityBucket("alert"),
      blocked: inboxPriorityBucket("blocked"),
      health: inboxPriorityBucket("health"),
      review: inboxPriorityBucket("review"),
      report: inboxPriorityBucket("report"),
      knowledge: inboxPriorityBucket("knowledge"),
    };
    expect(buckets).toEqual({
      approval: "blocking",
      plan: "blocking",
      question: "blocking",
      alert: "incident",
      blocked: "incident",
      health: "incident",
      review: "review",
      report: "review",
      knowledge: "review",
    });

    const now = 10_000;
    const hub: InboxInput = {
      tasks: [
        {
          id: "t1",
          title: "Restart nginx",
          mode: "assisted",
          status: "waiting",
          messages: [],
          changes: [
            {
              id: "c1",
              kind: "command",
              target: "web-01",
              description: "Restart nginx",
              command: "systemctl restart nginx",
              status: "pending",
              riskLevel: "modify",
              at: 500,
            },
          ],
          sources: [],
          createdAt: 1,
          updatedAt: 500,
          maxCommands: 5,
          maxMinutes: 5,
          verification: "not-verified",
        },
      ],
      workTickets: [
        {
          id: "k1",
          title: "High CPU",
          description: "",
          status: "backlog",
          createdBy: "alert",
          createdAt: 1,
          updatedAt: 400,
          alert: { fingerprint: "cpu", source: "prom", severity: "warning", firstAt: 400, lastAt: 400, count: 1 },
        },
        {
          id: "k2",
          title: "Weekly digest",
          description: "",
          status: "review",
          createdBy: "agent",
          createdAt: 1,
          updatedAt: 300,
        },
      ],
      inboxState: {
        "alert:k1": { snoozedUntil: now + 60_000 },
        "review:k2": { acknowledgedAt: now - 100 },
      },
    };

    // Default call hides currently snoozed items (alert:k1)
    const active = inboxItems(hub, { now });
    expect(active.map((i) => i.id)).toEqual(["approval:c1", "review:k2"]);
    expect(active[0].bucket).toBe("blocking");

    // Snoozed filter shows only snoozed items
    const snoozed = inboxItems(hub, { snoozeFilter: "snoozed", now });
    expect(snoozed.map((i) => i.id)).toEqual(["alert:k1"]);
    expect(isInboxItemSnoozed(snoozed[0], now)).toBe(true);

    // All filter shows everything
    const all = inboxItems(hub, { includeSnoozed: true, now });
    expect(all).toHaveLength(3);

    // Expired snooze becomes active again
    const later = inboxItems(hub, { now: now + 120_000 });
    expect(later.map((i) => i.id)).toEqual(["approval:c1", "alert:k1", "review:k2"]);

    // Bucket filter
    expect(filterInboxItems(all, { snoozeFilter: "all", bucket: "review", now }).map((i) => i.id)).toEqual(["review:k2"]);

    // Urgent counter counts only non-snoozed, unacknowledged blocking + incident items
    expect(countUrgentInboxItems(hub, { now })).toBe(1);
    expect(countUrgentInboxItems(hub, { now: now + 120_000 })).toBe(2);
  });

  it("exposes managed AI policy definitions without breaking existing POLICY_DEFINITIONS", () => {
    expect(POLICY_DEFINITIONS.length).toBeGreaterThan(0);
    expect(AI_POLICY_DEFINITIONS.map((d) => d.id)).toEqual([
      "aiSafetyLocked",
      "aiAllowedEndpoints",
      "aiRequireZdr",
      "aiMaxAutonomy",
    ]);

    const ai: AiPolicyConfig = {
      aiSafetyLocked: true,
      aiAllowedEndpoints: ["https://api.anthropic.com", "http://127.0.0.1:11434/v1"],
      aiRequireZdr: true,
      aiMaxAutonomy: "assisted",
    };
    const doc: PolicyDocument = { ...EMPTY_POLICY, ai };
    const info: PolicyInfo = { managed: [], features: {}, warnings: [], ai };
    expect(doc.ai?.aiMaxAutonomy).toBe("assisted");
    expect(info.ai?.aiSafetyLocked).toBe(true);
  });
});
