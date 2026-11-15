// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HubRequest,
  HubSnapshot,
  KbDocument,
  KbPage,
  MemoryProposal,
  RunbookTemplate,
} from "../../src/shared/types/aiHub";
import {
  highlightSearchSnippet,
  interpolateRunbookText,
  KnowledgeBaseView,
} from "../../src/renderer/src/components/AiHub/KnowledgeBaseView";
import {
  describeMemoryScope,
  isMemoryStale,
  Memory,
  type MemoryEntryView,
} from "../../src/renderer/src/components/AiHub/MemoryView";
import {
  assessProposalRisk,
  MemoryProposals,
  type MemoryProposalView,
} from "../../src/renderer/src/components/AiHub/MemoryProposals";
import {
  isFactsStale,
  resourceSeverityClass,
  ServerFactsCard,
  type ServerFactsEntry,
} from "../../src/renderer/src/components/AiHub/ServerFactsCard";

afterEach(cleanup);

function baseHub(extra: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    config: {
      enabled: true,
      provider: "anthropic",
      model: "claude",
      useHermes: false,
      hasApiKey: true,
    },
    preferences: {
      background: false,
      autoStart: false,
      inventory: false,
      retentionDays: 30,
      autoSaveMemories: false,
    },
    runtime: { bundled: true },
    sessions: [],
    tasks: [],
    memories: [],
    schedules: [],
    inventory: [],
    workspaceServers: [],
    kbDocuments: [],
    kbPages: [],
    kbFindings: [],
    runbooks: [],
    ...extra,
  } as unknown as HubSnapshot;
}

describe("KnowledgeBaseView & KbPagesView overhaul", () => {
  it("renders 1-click onboarding starter templates when Sources and Pages are empty", async () => {
    const act = vi.fn(async () => baseHub());
    const request = vi.fn(async () => baseHub());
    render(
      <KnowledgeBaseView
        hub={baseHub()}
        act={act}
        onAttachDoc={vi.fn()}
        request={request}
      />,
    );

    const starterSection = screen.getByTestId("kb-starter-templates");
    expect(starterSection).toBeVisible();
    expect(within(starterSection).getByText("Linux Incident Runbook")).toBeVisible();
    expect(within(starterSection).getByText("PostgreSQL Failover SOP")).toBeVisible();
    expect(within(starterSection).getByText("Cluster Architecture Map")).toBeVisible();
    expect(within(starterSection).getByTestId("kb-starter-import-markdown")).toBeVisible();

    fireEvent.click(screen.getByTestId("kb-starter-postgres-failover-sop"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "kb-save",
        doc: expect.objectContaining({
          title: "PostgreSQL Failover SOP",
          collection: "Databases",
          kind: "runbook",
        }),
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "Pages · 0" }));
    const pageStarters = screen.getByTestId("kb-pages-starters");
    expect(pageStarters).toBeVisible();
    fireEvent.click(screen.getByTestId("kb-page-starter-cluster-architecture-map"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "kb-page-save",
        page: expect.objectContaining({
          kind: "system",
          title: "Cluster Architecture Map",
        }),
      }),
    );
  });

  it("renders executable RunbookTemplate steps with variable interpolation and terminal/AI callbacks", async () => {
    const runbook: RunbookTemplate = {
      id: "rb-1",
      name: "Nginx Triage",
      description: "Check nginx unit and logs",
      dispatchStrategy: "canary_then_rolling",
      inputs: [
        { name: "unit", label: "Unit name", type: "string", required: true, defaultValue: "nginx" },
        { name: "window", label: "Window", type: "enum", options: ["15m", "1h"], defaultValue: "15m" },
      ],
      steps: [
        { id: "s1", title: "Status", kind: "check", command: "systemctl status {{unit}}", expected: "active" },
        { id: "s2", title: "AI Diagnose", kind: "ai_diagnose", prompt: "Analyze {{unit}} for {{window}}" },
      ],
    };

    expect(interpolateRunbookText("systemctl status {{unit}}", { unit: "postgresql" })).toBe(
      "systemctl status postgresql",
    );

    const act = vi.fn(async () => baseHub({ runbooks: [runbook] }));
    const onRunStepInTerminal = vi.fn();
    const onAskAiStep = vi.fn();

    render(
      <KnowledgeBaseView
        hub={baseHub({ runbooks: [runbook] })}
        act={act}
        onAttachDoc={vi.fn()}
        onRunStepInTerminal={onRunStepInTerminal}
        onAskAiStep={onAskAiStep}
        request={vi.fn(async () => baseHub())}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Runbooks · 1" }));
    const executor = screen.getByTestId("runbook-executor-rb-1");
    expect(within(executor).getByText("canary_then_rolling")).toBeVisible();

    fireEvent.change(within(executor).getByLabelText(/Unit name/i), { target: { value: "haproxy" } });
    fireEvent.change(within(executor).getByLabelText(/Window/i), { target: { value: "1h" } });

    expect(within(executor).getByText("systemctl status haproxy")).toBeVisible();
    expect(within(executor).getByText("Analyze haproxy for 1h")).toBeVisible();

    fireEvent.click(screen.getByTestId("runbook-step-terminal-s1"));
    expect(onRunStepInTerminal).toHaveBeenCalledWith("systemctl status haproxy", runbook.steps[0], runbook);
    expect(screen.getByTestId("runbook-step-s1")).toHaveAttribute("data-step-state", "active");

    fireEvent.click(screen.getByTestId("runbook-step-ai-s2"));
    expect(onAskAiStep).toHaveBeenCalledWith("Analyze haproxy for 1h", runbook.steps[1], runbook);

    fireEvent.click(screen.getByTestId("runbook-run-all-rb-1"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "runbook-run",
        id: "rb-1",
        inputs: { unit: "haproxy", window: "1h" },
        dryRun: false,
      }),
    );
  });

  it("renders clickable host:/path:line refs, highlighted chunked search snippets, and compile/lint health badges", async () => {
    const docItem: KbDocument = {
      id: "d1",
      title: "Nginx Config Notes",
      sourceType: "manual",
      content: "Check prod-web-01:/etc/nginx/nginx.conf:42 for upstream timeouts.",
      chunks: [],
      chunkCount: 2,
      updatedAt: 1000,
      reading: { state: "done", at: 1000 },
      compiled: { at: 1000, pages: 2 },
    };
    const healthyPage: KbPage = {
      id: "p-ok",
      kind: "procedure",
      title: "Reload Nginx",
      when: "When config changed",
      body: "Inspect prod-web-01:/etc/nginx/nginx.conf:42 and `/var/log/nginx/error.log:10`.",
      targets: ["prod"],
      sources: [{ docId: "d1", title: "Nginx Config Notes" }],
      revision: 1,
      createdAt: 1000,
      updatedAt: 1000,
      updatedBy: "assistant",
      history: [],
    };
    const lintedPage: KbPage = {
      ...healthyPage,
      id: "p-bad",
      title: "Old DB Guide",
    };

    const segs = highlightSearchSnippet("Increase proxy_read_timeout to 120s for SSE.", "proxy_read_timeout");
    expect(segs.some((s) => s.match && s.text === "proxy_read_timeout")).toBe(true);

    const onOpenFileRef = vi.fn();
    const request = vi.fn(async (req: HubRequest) => {
      if (req.action === "kb-read") {
        return baseHub({ reply: { kbDocument: docItem } }) as HubSnapshot;
      }
      if (req.action === "kb-page-read") {
        return baseHub({ reply: { kbPage: healthyPage } }) as HubSnapshot;
      }
      if (req.action === "kb-search") {
        return baseHub({
          reply: {
            kbSearch: {
              query: "proxy_read_timeout",
              byMeaning: true,
              hits: [
                {
                  pageId: "p-ok",
                  docId: "d1",
                  title: "Reload Nginx",
                  collection: "Web",
                  heading: "Reload Nginx › Timeouts",
                  snippet: "Increase proxy_read_timeout to 120s for SSE.",
                  score: 0.92,
                },
              ],
            },
          },
        }) as HubSnapshot;
      }
      return baseHub();
    });

    render(
      <KnowledgeBaseView
        hub={baseHub({
          kbDocuments: [docItem],
          kbPages: [healthyPage, lintedPage],
          kbFindings: [
            { id: "f1", kind: "contradiction", pageId: "p-bad", text: "Disagrees on port", at: 1 },
          ],
        })}
        act={vi.fn(async () => baseHub())}
        onAttachDoc={vi.fn()}
        onOpenFileRef={onOpenFileRef}
        request={request}
      />,
    );

    // Compile/lint health badges on Pages
    expect(screen.getByTestId("kb-pages-health")).toHaveTextContent("1 healthy");
    expect(screen.getByTestId("kb-pages-health")).toHaveTextContent("1 lint notice");
    expect(screen.getByTestId("kb-page-health-p-ok")).toHaveTextContent("healthy");
    expect(within(screen.getByTestId("kb-page-p-bad")).getByText("contradiction")).toBeVisible();

    // Open page and click extracted host:/path:line ref
    fireEvent.click(within(screen.getByTestId("kb-page-p-ok")).getByRole("button", { name: "Read" }));
    const refsBar = await screen.findByTestId("kb-page-refs-p-ok");
    fireEvent.click(within(refsBar).getByRole("button", { name: "prod-web-01:/etc/nginx/nginx.conf:42" }));
    expect(onOpenFileRef).toHaveBeenCalledWith({
      raw: "prod-web-01:/etc/nginx/nginx.conf:42",
      host: "prod-web-01",
      path: "/etc/nginx/nginx.conf",
      line: 42,
      column: undefined,
    });

    // Search snippet highlighting
    fireEvent.change(screen.getByTestId("kb-hybrid-search-input"), { target: { value: "proxy_read_timeout" } });
    const hits = await screen.findByTestId("kb-hits");
    const mark = hits.querySelector("mark.ai-search-mark");
    expect(mark).toHaveTextContent("proxy_read_timeout");
    expect(hits).toHaveTextContent("semantic · score 0.92");

    // Compile badge and ref on Source document
    fireEvent.click(screen.getByRole("tab", { name: "Sources · 1" }));
    expect(screen.getByTestId("kb-doc-compile-d1")).toHaveTextContent("compiled · 2p");
    fireEvent.click(within(screen.getByTestId("kb-doc-d1")).getByRole("button", { name: "Read" }));
    const docRefs = await screen.findByTestId("kb-doc-refs-d1");
    fireEvent.click(within(docRefs).getByRole("button", { name: "prod-web-01:/etc/nginx/nginx.conf:42" }));
    expect(onOpenFileRef).toHaveBeenCalledTimes(2);
  });
});

describe("MemoryView overhaul", () => {
  it("shows Needs Check + Re-verify, scope filtering (global/host/cluster/tag/env), pin, inline edit, and provenance", async () => {
    const now = Date.now();
    const oldVerified = now - 45 * 24 * 60 * 60 * 1000;
    expect(isMemoryStale({ id: "x", kind: "memory", scope: "workspace", title: "t", text: "x", updatedAt: now, staleReason: "OS upgraded" }, now).stale).toBe(true);
    expect(isMemoryStale({ id: "x", kind: "memory", scope: "workspace", title: "t", text: "x", updatedAt: now, lastVerifiedAt: oldVerified }, now).stale).toBe(true);
    expect(describeMemoryScope("env:prod").badgeText).toBe("env:prod");
    expect(describeMemoryScope("tag:postgres").badgeText).toBe("tag:postgres");
    expect(describeMemoryScope("host:db-01").badgeText).toBe("host:db-01");

    const memories: MemoryEntryView[] = [
      {
        id: "m-global",
        kind: "memory",
        tier: "archival",
        scope: "workspace",
        title: "Use systemd journalctl",
        text: "Prefer journalctl -u over raw syslog.",
        author: "triage-agent",
        sourceTaskId: "task-42",
        staleReason: "OS upgraded to Debian 13",
        sourceTrust: "trusted",
        updatedAt: now,
      },
      {
        id: "m-env",
        kind: "skill",
        tier: "core",
        scope: "env:prod",
        title: "Drain prod nodes before reboot",
        text: "Cordon node first.",
        author: "ops-lead",
        lastVerifiedAt: oldVerified,
        updatedAt: now,
      },
      {
        id: "m-tag",
        kind: "memory",
        tier: "archival",
        scope: "tag:postgres",
        title: "Check pg_stat_activity",
        text: "Look for idle in transaction.",
        updatedAt: now,
      },
      {
        id: "m-cluster",
        kind: "memory",
        tier: "archival",
        scope: "cluster:eu-west",
        title: "EU cluster VIP",
        text: "VIP is 10.20.0.10.",
        updatedAt: now,
      },
      {
        id: "m-host",
        kind: "memory",
        tier: "archival",
        scope: "server:web-01",
        title: "Web-01 cert path",
        text: "Cert lives in /etc/ssl/web.pem.",
        updatedAt: now,
      },
    ];

    const act = vi.fn(async () => baseHub({ memories }));
    const onOpenTask = vi.fn();
    render(
      <Memory
        hub={baseHub({ memories })}
        act={act}
        suggestion=""
        onOpenTask={onOpenTask}
      />,
    );

    // Needs Check badge + provenance
    expect(screen.getByTestId("memory-stale-m-global")).toHaveTextContent("Needs Check");
    expect(screen.getByTestId("memory-stale-reason-m-global")).toHaveTextContent("OS upgraded to Debian 13");
    expect(screen.getByTestId("memory-stale-m-env")).toHaveTextContent("Needs Check");
    expect(screen.getByTestId("memory-provenance-m-global")).toHaveTextContent("task:task-42");
    expect(screen.getByTestId("memory-provenance-m-global")).toHaveTextContent("by triage-agent");
    expect(screen.getByTestId("memory-provenance-m-global")).toHaveTextContent("trusted");

    // Scope badges
    expect(screen.getByTestId("memory-scope-m-global")).toHaveTextContent("global");
    expect(screen.getByTestId("memory-scope-m-env")).toHaveTextContent("env:prod");
    expect(screen.getByTestId("memory-scope-m-tag")).toHaveTextContent("tag:postgres");
    expect(screen.getByTestId("memory-scope-m-cluster")).toHaveTextContent("cluster:eu-west");
    expect(screen.getByTestId("memory-scope-m-host")).toHaveTextContent("host:web-01");

    // Re-verify action
    fireEvent.click(screen.getByTestId("memory-reverify-m-global"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "memory-save",
        entry: expect.objectContaining({
          id: "m-global",
          staleReason: undefined,
          lastVerifiedAt: expect.any(Number),
        }),
      }),
    );

    // Pin action
    fireEvent.click(screen.getByTestId("memory-pin-m-global"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "memory-save",
        entry: expect.objectContaining({
          id: "m-global",
          tier: "core",
        }),
      }),
    );

    // Inline edit action
    fireEvent.click(screen.getByTestId("memory-inline-edit-m-global"));
    const inlineForm = screen.getByTestId("memory-inline-form-m-global");
    fireEvent.change(within(inlineForm).getByLabelText("Inline text"), {
      target: { value: "Use journalctl -u nginx -n 100." },
    });
    fireEvent.click(within(inlineForm).getByRole("button", { name: "Save inline" }));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "memory-save",
        entry: expect.objectContaining({
          id: "m-global",
          text: "Use journalctl -u nginx -n 100.",
        }),
      }),
    );

    // Scope filter for env:
    fireEvent.click(screen.getByTestId("memory-scope-filter-env"));
    expect(screen.getByTestId("memory-m-env")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-m-global")).not.toBeInTheDocument();

    // Scope filter for tag:
    fireEvent.click(screen.getByTestId("memory-scope-filter-tag"));
    expect(screen.getByTestId("memory-m-tag")).toBeInTheDocument();
    expect(screen.queryByTestId("memory-m-env")).not.toBeInTheDocument();
  });
});

describe("MemoryProposals overhaul", () => {
  it("renders DiffViewer inline diff, provenance, risk badges, and batch Approve safe / Reject all", async () => {
    const safeProposal: MemoryProposalView = {
      id: "prop-safe",
      op: "add",
      kind: "memory",
      scope: "env:staging",
      title: "Staging TLS note",
      text: "Staging uses internal ACME CA.",
      evidence: "openssl s_client output; curl verbose log",
      sourceId: "task:t-101",
      sourceTitle: "TLS Check",
      createdAt: 1700000000000,
    };
    const riskyProposal: MemoryProposalView = {
      id: "prop-risky",
      op: "update",
      targetId: "m-1",
      kind: "skill",
      scope: "cluster:prod",
      title: "Force clean disk",
      previousValue: "df -h /var",
      proposedValue: "rm -rf /var/tmp/* --force",
      text: "rm -rf /var/tmp/* --force",
      evidence: "disk cleanup run",
      sourceId: "task:t-102",
      sourceTitle: "Disk Cleanup",
      createdAt: 1700000000000,
    };

    expect(assessProposalRisk(safeProposal)).toBe("safe");
    expect(assessProposalRisk(riskyProposal)).toBe("high");

    const act = vi.fn(async () => baseHub());
    render(
      <MemoryProposals
        hub={baseHub({ memoryProposals: [safeProposal, riskyProposal] as MemoryProposal[] })}
        act={act}
      />,
    );

    // DiffViewer rendered for both, comparing previousValue vs proposedValue
    const riskyDiff = screen.getByTestId("memory-proposal-diff-prop-risky");
    expect(riskyDiff.querySelector(".ai-diff-viewer")).toBeInTheDocument();
    expect(riskyDiff).toHaveTextContent("df -h /var");
    expect(riskyDiff).toHaveTextContent("rm -rf /var/tmp/* --force");

    // Provenance & risk badges
    expect(screen.getByTestId("memory-proposal-risk-prop-safe")).toHaveTextContent("risk: safe");
    expect(screen.getByTestId("memory-proposal-risk-prop-risky")).toHaveTextContent("risk: high");
    expect(screen.getByTestId("memory-proposal-provenance-prop-safe")).toHaveTextContent("task:t-101");
    expect(screen.getByTestId("memory-proposal-provenance-prop-safe")).toHaveTextContent("2 evidence");

    // Batch Approve safe approves only prop-safe
    const approveSafeBtn = screen.getByTestId("memory-approve-safe-btn");
    expect(approveSafeBtn).toHaveTextContent("Approve safe (1)");
    fireEvent.click(approveSafeBtn);
    await waitFor(() =>
      expect(act).toHaveBeenCalledTimes(1),
    );
    expect(act).toHaveBeenCalledWith({
      action: "memory-proposal-accept",
      id: "prop-safe",
      title: "Staging TLS note",
      text: "Staging uses internal ACME CA.",
    });

    // Batch Reject all rejects both pending proposals
    act.mockClear();
    fireEvent.click(screen.getByTestId("memory-reject-all-btn"));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(2));
    expect(act).toHaveBeenNthCalledWith(1, { action: "memory-proposal-reject", id: "prop-safe" });
    expect(act).toHaveBeenNthCalledWith(2, { action: "memory-proposal-reject", id: "prop-risky" });
  });
});

describe("ServerFactsCard overhaul", () => {
  it("renders CPU/RAM/Disk resource bars with severity classes, PSI/OOM badges, staleness, and quick diagnostics", () => {
    const now = Date.now();
    expect(resourceSeverityClass(40)).toBe("ai-bar-ok");
    expect(resourceSeverityClass(75)).toBe("ai-bar-warning");
    expect(resourceSeverityClass(90)).toBe("ai-bar-critical");
    expect(isFactsStale(now - 15 * 3_600_000, 6, now)).toBe(true);
    expect(isFactsStale(now - 2 * 3_600_000, 6, now)).toBe(false);

    const server: ServerFactsEntry = {
      serverId: "api-1",
      name: "prod-api-01",
      status: "ok",
      collectedAt: now - 16 * 3_600_000,
      via: "open-tab",
      os: "Ubuntu 24.04",
      kernel: "6.8.0",
      packages: 320,
      services: 18,
      listening: 4,
      cpuPct: 82,
      memPct: 93,
      psi: { cpu: 4.5, mem: 18.2 },
      oomKills: 2,
      disks: [
        { mount: "/", usedPct: 91 },
        { mount: "/data", usedPct: 60 },
      ],
      problems: [],
      changes: [],
    };

    const onRunDiagnostic = vi.fn();
    render(
      <ServerFactsCard
        hub={baseHub({
          serverFacts: {
            enabled: true,
            intervalHours: 6,
            exclude: [],
            watchPaths: [],
            collecting: [],
            servers: [server],
          },
        })}
        act={vi.fn(async () => baseHub())}
        onRunDiagnostic={onRunDiagnostic}
      />,
    );

    const cpuBar = screen.getByTestId("facts-bar-cpu-api-1");
    const ramBar = screen.getByTestId("facts-bar-ram-api-1");
    const rootDiskBar = screen.getByTestId("facts-bar-disk-api-1-/");
    const dataDiskBar = screen.getByTestId("facts-bar-disk-api-1-/data");

    expect(cpuBar).toHaveClass("ai-bar-warning");
    expect(cpuBar).toHaveTextContent("CPU 82%");
    expect(ramBar).toHaveClass("ai-bar-critical");
    expect(ramBar).toHaveTextContent("RAM 93%");
    expect(rootDiskBar).toHaveClass("ai-bar-critical");
    expect(dataDiskBar).toHaveClass("ai-bar-ok");

    expect(screen.getByTestId("facts-psi-api-1")).toHaveTextContent("PSI pressure: cpu 4.5% · mem 18.2%");
    expect(screen.getByTestId("facts-oom-api-1")).toHaveTextContent("OOM alert ×2");
    expect(screen.getByTestId("facts-stale-api-1")).toHaveTextContent("Stale");

    fireEvent.click(screen.getByTestId("facts-diag-btn-api-1-journalctl-err"));
    expect(onRunDiagnostic).toHaveBeenCalledWith(
      "journalctl -p err -n 100 --no-pager",
      server,
      "journalctl-err",
    );
    expect(screen.getByTestId("facts-staged-api-1")).toHaveTextContent("journalctl -p err -n 100 --no-pager");
  });
});
