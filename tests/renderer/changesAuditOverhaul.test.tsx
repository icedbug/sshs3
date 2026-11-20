// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChange,
  AgentSchedule,
  AuditEntryView,
  AuditVerificationView,
  HubRequest,
  HubSnapshot,
} from "../../src/shared/types/aiHub";
import {
  ChangesView,
  groupChangeEntries,
} from "../../src/renderer/src/components/AiHub/ChangesView";
import {
  ChangeProof,
  formatStructuredCheckSummary,
  isUncertainOrPartialRollback,
} from "../../src/renderer/src/components/AiHub/ChangeProof";
import {
  AuditLogView,
  formatAuditCsv,
  formatAuditMarkdown,
} from "../../src/renderer/src/components/AiHub/AuditLogView";
import {
  PLAYBACK_SPEEDS,
  RecordingPlayer,
} from "../../src/renderer/src/components/AiHub/RecordingPlayer";
import {
  isValidCronExpression,
  SCHEDULE_MODES,
  Schedules,
} from "../../src/renderer/src/components/AiHub/SchedulesView";
import {
  isInQuietHours,
  NotificationsCard,
} from "../../src/renderer/src/components/AiHub/NotificationsCard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
});

function makeHub(extra: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    config: {
      enabled: true,
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      useHermes: false,
      hasApiKey: true,
    },
    preferences: {
      background: false,
      autoStart: false,
      inventory: false,
      retentionDays: 30,
      approvalWaitMinutes: 10,
    },
    runtime: { bundled: true },
    sessions: [],
    tasks: [],
    inventory: [
      {
        id: "srv-prod-1",
        kind: "ssh",
        label: "prod-api-01",
        address: "10.0.1.10",
        status: "reachable",
        detail: "ok",
        observedAt: 1000,
      },
      {
        id: "k8s-prod",
        kind: "k8s",
        label: "prod-eks",
        address: "https://k8s.internal",
        status: "reachable",
        detail: "ok",
        observedAt: 1000,
      },
    ],
    memories: [],
    schedules: [],
    notifications: {
      channels: [
        {
          id: "ch-siem",
          kind: "webhook",
          name: "Splunk SIEM",
          host: "splunk.internal",
          hasSecret: true,
          enabled: true,
          events: ["approval", "alert"],
          includeCommand: false,
          last: { at: Date.now() - 30_000, ok: true, status: 200 },
        },
      ],
      publicUrl: "https://sshs3.example.com",
      publicUrlFixed: false,
      reminderMinutes: 5,
    },
    ...extra,
  };
}

describe("ChangesView overhaul", () => {
  it("groups changes into Change Sets, renders DiffViewer with inline/split toggle, blast radius, approvals, and triggers restore-checkpoint", async () => {
    const fileChange: AgentChange & { changeSetId?: string } = {
      id: "chg-file-1",
      kind: "file",
      target: "/etc/nginx/nginx.conf",
      description: "Increase proxy_read_timeout",
      before: "proxy_read_timeout 30s;\nworker_connections 1024;",
      after: "proxy_read_timeout 90s;\nworker_connections 1024;",
      beforeHash: "abc123",
      status: "completed",
      riskLevel: "modify",
      blastRadius: "2 edge proxies",
      turnIndex: 2,
      requiredApprovals: 2,
      approvals: [
        { actor: "Alice", at: 1000, allowed: true },
        { actor: "Bob", at: 2000, allowed: true },
      ],
      changeSetId: "cs-nginx",
      at: 2000,
    };
    const cmdChange: AgentChange & { changeSetId?: string } = {
      id: "chg-cmd-1",
      kind: "command",
      target: "prod-api-01",
      description: "Reload nginx",
      command: "systemctl reload nginx",
      output: "\x1b[32mReloaded nginx\x1b[0m",
      status: "completed",
      riskLevel: "modify",
      turnIndex: 2,
      changeSetId: "cs-nginx",
      at: 3000,
    };

    const hub = makeHub({
      tasks: [
        {
          id: "task-1",
          title: "Tune nginx timeouts",
          agentName: "NetOps",
          mode: "assisted",
          status: "completed",
          messages: [],
          sources: [],
          changes: [fileChange, cmdChange],
          createdAt: 1000,
          updatedAt: 3000,
          maxCommands: 10,
          maxMinutes: 10,
          verification: "verified",
        },
      ],
    });

    const request = vi.fn(async (_r: HubRequest) => hub);
    render(
      <ChangesView hub={hub} onOpenTask={vi.fn()} request={request} />,
    );

    const setCard = screen.getByTestId("change-set-changeset:cs-nginx");
    expect(setCard).toHaveTextContent(
      "Tune nginx timeouts (1 file edit, 1 command)",
    );
    expect(setCard).toHaveTextContent("2 edge proxies");
    expect(setCard).toHaveTextContent("Approvals: 2/2");

    // Expand file change details and verify DiffViewer + Unified/Split toggle
    const diffContainer = screen.getByTestId("change-diff-chg-file-1");
    expect(diffContainer).toHaveTextContent("/etc/nginx/nginx.conf");
    expect(
      diffContainer.querySelector(".ai-diff-word-add"),
    ).toBeInTheDocument();
    expect(
      diffContainer.querySelector(".ai-diff-word-del"),
    ).toBeInTheDocument();

    fireEvent.click(within(diffContainer).getByRole("button", { name: "Split" }));
    expect(
      diffContainer.querySelector(".ai-diff-split"),
    ).toBeInTheDocument();

    // Per-change Restore Checkpoint
    fireEvent.click(screen.getByTestId("restore-checkpoint-chg-file-1"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "restore-checkpoint",
        taskId: "task-1",
        changeId: "chg-file-1",
      }),
    );

    // Task-level Rewind Task
    fireEvent.click(screen.getByTestId("rewind-task-task-1"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "restore-checkpoint",
        taskId: "task-1",
        changeId: "chg-file-1",
      }),
    );
  });

  it("groupChangeEntries groups by changeSetId first, falling back to taskId", () => {
    const groups = groupChangeEntries([
      {
        id: "1",
        at: 10,
        source: "assistant",
        who: "A",
        target: "h1",
        summary: "edit a",
        kind: "file",
        taskId: "t1",
        change: {
          id: "c1",
          kind: "file",
          target: "h1",
          description: "edit a",
          status: "completed",
          at: 10,
          changeSetId: "cs-1",
        },
      },
      {
        id: "2",
        at: 20,
        source: "assistant",
        who: "A",
        target: "h1",
        summary: "edit b",
        kind: "file",
        taskId: "t1",
        change: {
          id: "c2",
          kind: "file",
          target: "h1",
          description: "edit b",
          status: "completed",
          at: 20,
          changeSetId: "cs-1",
        },
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries).toHaveLength(2);
  });
});

describe("ChangeProof overhaul", () => {
  it("renders structured post-checks and explicit two-step Verify & Execute Rollback on uncertain status", async () => {
    const change: AgentChange = {
      id: "chg-uncertain",
      kind: "command",
      target: "db-01",
      description: "Restart pgbouncer",
      command: "systemctl restart pgbouncer",
      status: "uncertain",
      hiddenValues: false,
      check: {
        command: "systemctl is-active pgbouncer",
        expected: "active",
        before: false,
        output: "activating",
      },
      structuredCheck: {
        equals: "active",
        regex: "^active$",
        maxNumber: 5,
      },
      rollback: {
        command: "systemctl restart pgbouncer@backup",
        ran: false,
      },
      preflightSnapshot: "pgbouncer pid=412",
      dryRunOutput: "Would restart pgbouncer.service",
      at: 1000,
    };

    expect(isUncertainOrPartialRollback(change)).toBe(true);
    expect(formatStructuredCheckSummary(change.structuredCheck)).toEqual([
      'equals "active"',
      "matches /^active$/",
      "numeric ≤ 5",
    ]);

    const request = vi.fn(async () => makeHub());
    render(
      <ChangeProof change={change} taskId="task-9" request={request} />,
    );

    expect(screen.getByTestId("structured-check")).toHaveTextContent(
      'equals "active"',
    );
    expect(screen.getByTestId("structured-check")).toHaveTextContent(
      "matches /^active$/",
    );
    expect(screen.getByTestId("structured-check")).toHaveTextContent(
      "numeric ≤ 5",
    );
    expect(screen.getByTestId("preflight-snapshot")).toHaveTextContent(
      "pgbouncer pid=412",
    );
    expect(screen.getByTestId("dry-run-output")).toHaveTextContent(
      "Would restart pgbouncer.service",
    );

    // Step 1: does not send request yet
    fireEvent.click(screen.getByTestId("verify-execute-rollback-btn"));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByTestId("verify-execute-rollback-step2")).toHaveTextContent(
      "Step 1: probe current target state",
    );

    // Step 2: confirms and runs rollback-change with verify: true
    fireEvent.click(screen.getByTestId("confirm-execute-rollback-btn"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "rollback-change",
        taskId: "task-9",
        changeId: "chg-uncertain",
        verify: true,
      }),
    );
  });
});

describe("AuditLogView overhaul", () => {
  const entries: AuditEntryView[] = [
    {
      seq: 1,
      at: Date.UTC(2026, 10, 14, 12, 0, 0),
      kind: "command",
      actor: "Alice",
      target: "web-01",
      what: 'systemctl reload "nginx"',
      outcome: "completed",
      exitCode: 0,
      approvedBy: "Bob",
      hash: "aaaa1111bbbb2222cccc3333",
    },
    {
      seq: 2,
      at: Date.UTC(2026, 10, 14, 12, 5, 0),
      kind: "file-write",
      actor: "NetBot",
      target: "db-01",
      what: "/etc/pgbouncer/pgbouncer.ini",
      outcome: "failed",
      exitCode: 1,
      hash: "dddd4444eeee5555ffff6666",
    },
  ];
  const verification: AuditVerificationView = {
    ok: true,
    entries: 2,
    anchors: { checked: 2, held: 2, coveredSeq: 2, lastAt: Date.now() },
  };

  it("formats CSV and Markdown compliance reports, filters by actor/tool/host/status, shows SIEM badge, and verifies chain", async () => {
    const csv = formatAuditCsv(entries);
    expect(csv).toContain("seq,timestamp,kind,actor,target,what,outcome");
    expect(csv).toContain('"systemctl reload ""nginx"""');

    const md = formatAuditMarkdown(entries, verification);
    expect(md).toContain("# sshs3 Audit Compliance Report");
    expect(md).toContain("**Hash Chain Status:** VERIFIED");
    expect(md).toContain("Team Bucket Anchors:** 2/2 held");

    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      value: createObjectURL,
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: revokeObjectURL,
      configurable: true,
    });
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    const request = vi.fn(async (req: HubRequest) => {
      if (req.action === "audit-read") {
        return makeHub({
          reply: { audit: { entries, verification } },
        });
      }
      return makeHub();
    });

    render(
      <AuditLogView
        request={request}
        hub={makeHub()}
        onOpenTask={vi.fn()}
        onWatch={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("audit-chain-badge")).toHaveTextContent(
        "Chain verified · 2 entries",
      ),
    );
    expect(screen.getByTestId("siem-sink-badge")).toHaveTextContent(
      "SIEM sink: Splunk SIEM",
    );

    // Filter by actor
    fireEvent.change(screen.getByLabelText("Filter by actor"), {
      target: { value: "NetBot" },
    });
    expect(
      screen.getByText("/etc/pgbouncer/pgbouncer.ini", {
        selector: "summary code",
      }),
    ).toBeVisible();
    expect(
      screen.queryByText('systemctl reload "nginx"'),
    ).not.toBeInTheDocument();

    // Reset filters, then filter by tool/host/status
    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
    fireEvent.change(screen.getByLabelText("Filter by host"), {
      target: { value: "web-01" },
    });
    expect(
      screen.getByText('systemctl reload "nginx"', {
        selector: "summary code",
      }),
    ).toBeVisible();
    expect(
      screen.queryByText("/etc/pgbouncer/pgbouncer.ini"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));

    // Client-side CSV & Markdown exports
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(clickSpy).toHaveBeenCalledTimes(2);

    // Verify chain button triggers audit-read
    request.mockClear();
    fireEvent.click(screen.getByTestId("verify-audit-chain"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "audit-read",
        limit: 200,
      }),
    );
  });
});

describe("RecordingPlayer overhaul", () => {
  const sampleCast = [
    JSON.stringify({ version: 2, width: 80, height: 24, title: "Demo" }),
    JSON.stringify([0.1, "m", "uptime"]),
    JSON.stringify([0.2, "o", "\x1b[32m12:00 up 5 days\x1b[0m\r\n"]),
    JSON.stringify([0.3, "x", "0"]),
    JSON.stringify([1.0, "m", "df -h"]),
    JSON.stringify([1.2, "o", "/dev/sda1 90%\r\n"]),
    JSON.stringify([1.3, "x", "0"]),
  ].join("\n");

  it("renders AnsiLogView, command scrubber markers, 0.5x-4x speeds, and handles Escape via useModalDismiss + useDialogFocus", () => {
    expect(PLAYBACK_SPEEDS).toEqual([0.5, 1, 1.5, 2, 4]);
    const onClose = vi.fn();
    render(
      <RecordingPlayer
        cast={sampleCast}
        title="Nginx triage"
        sealed={true}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Recording: Nginx triage",
    });
    expect(dialog).toBeInTheDocument();

    // Speed options 0.5x to 4x
    const speedSelect = screen.getByLabelText("Playback speed");
    expect(
      Array.from(speedSelect.querySelectorAll("option")).map((o) => o.value),
    ).toEqual(["0.5", "1", "1.5", "2", "4"]);

    // Command scrubber markers jump to step and update ANSI transcript
    expect(screen.getByTestId("recording-scrubber-markers")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("scrubber-marker-1"));
    expect(screen.getByTestId("scrubber-marker-1")).toHaveClass("ai-chip-on");
    expect(screen.getByTestId("recording-ansi-screen")).toHaveTextContent(
      "12:00 up 5 days",
    );

    // Timeline scrubber
    const slider = screen.getByLabelText("Where in the recording");
    fireEvent.change(slider, { target: { value: "1.3" } });
    expect(screen.getByTestId("recording-ansi-screen")).toHaveTextContent(
      "/dev/sda1 90%",
    );
    fireEvent.change(slider, { target: { value: "0.2" } });
    expect(screen.getByTestId("recording-ansi-screen")).not.toHaveTextContent(
      "/dev/sda1 90%",
    );

    // Escape closes via useModalDismiss
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SchedulesView overhaul", () => {
  it("supports 'plan' mode, quiet sentinel preset, cron expression + timezone, event triggers, and target selector", async () => {
    expect(SCHEDULE_MODES.plan).toMatch(/Plan/i);
    expect(isValidCronExpression("30 7 * * 1-5")).toBe(true);
    expect(isValidCronExpression("bad cron")).toBe(false);

    const savedSchedules: AgentSchedule[] = [];
    const act = vi.fn(async (req: HubRequest) => {
      if (req.action === "schedule-save") {
        savedSchedules.push({
          ...req.schedule,
          id: "sched-1",
        });
      }
      return makeHub({ schedules: savedSchedules });
    });

    render(<Schedules hub={makeHub()} act={act} />);

    fireEvent.click(screen.getByTestId("quiet-sentinel-preset-btn"));
    const form = screen.getByTestId("schedule-form");
    expect(within(form).getByLabelText("Name")).toHaveValue(
      "Health check that tells you only when something is wrong",
    );
    expect(
      within(form).getByLabelText(/Only tell me when something is wrong/),
    ).toBeChecked();

    // Switch mode to plan
    fireEvent.change(within(form).getByLabelText("Commands"), {
      target: { value: "plan" },
    });

    // Switch timing to cron
    fireEvent.change(within(form).getByLabelText("Schedule type"), {
      target: { value: "cron" },
    });
    fireEvent.change(within(form).getByLabelText("Cron expression"), {
      target: { value: "15 6 * * *" },
    });
    fireEvent.change(within(form).getByLabelText("Timezone"), {
      target: { value: "Europe/Stockholm" },
    });

    // Select event trigger & target
    fireEvent.change(within(form).getByLabelText("Event trigger"), {
      target: { value: "alert" },
    });
    fireEvent.change(within(form).getByLabelText("Event cooldown minutes"), {
      target: { value: "45" },
    });
    fireEvent.change(within(form).getByLabelText("Where it runs"), {
      target: { value: "srv-prod-1" },
    });

    fireEvent.click(within(form).getByRole("button", { name: "Create job" }));

    await waitFor(() =>
      expect(act).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "schedule-save",
          schedule: expect.objectContaining({
            mode: "plan",
            profileId: "srv-prod-1",
            cron: "15 6 * * *",
            timezone: "Europe/Stockholm",
            quietSentinel: true,
            eventTrigger: { kind: "alert", cooldownMinutes: 45 },
          }),
        }),
      ),
    );
  });
});

describe("NotificationsCard overhaul", () => {
  it("evaluates quiet hours accurately and lets users configure escalation chain and quiet hours, with no answers from a notification", async () => {
    expect(
      isInQuietHours(
        {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timezone: "UTC",
          bypassCritical: true,
        },
        new Date(Date.UTC(2026, 10, 14, 23, 30)),
      ),
    ).toBe(true);
    expect(
      isInQuietHours(
        {
          enabled: true,
          start: "22:00",
          end: "07:00",
          timezone: "UTC",
          bypassCritical: true,
        },
        new Date(Date.UTC(2026, 10, 14, 14, 0)),
      ),
    ).toBe(false);

    const act = vi.fn(async () => makeHub());
    render(<NotificationsCard hub={makeHub()} act={act} />);

    // Add escalation step
    fireEvent.click(screen.getByTestId("add-escalation-step-btn"));
    expect(screen.getByTestId("escalation-step-1")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Step 1 minutes to wait"), {
      target: { value: "10" },
    });

    // Enable quiet hours
    fireEvent.click(screen.getByLabelText("Enable quiet hours"));
    fireEvent.change(screen.getByLabelText("Quiet hours start"), {
      target: { value: "21:00" },
    });

    // A notification cannot be answered: answering from chat is the agent bot's, in Agent in chat.
    expect(screen.queryByLabelText("Let Approve and Deny be answered from chat")).toBeNull();
    expect(screen.queryByTestId("chatops-signed-badge")).toBeNull();
    // On the desktop app there is no Agent in chat card to point to.
    expect(screen.getByTestId("notify-answer-in-chat")).toHaveTextContent("A notification only tells people. It cannot be answered.");
    expect(screen.getByTestId("notify-answer-in-chat")).not.toHaveTextContent("Agent in chat");

    fireEvent.click(screen.getByTestId("save-notify-policy-btn"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "notify-settings-save",
          quietHours: expect.objectContaining({
            enabled: true,
            start: "21:00",
          }),
        }),
      ),
    );
    expect(JSON.stringify(act.mock.calls)).not.toContain("chatOps");
  });

  it("loads a policy kept from before, with answers from chat in it, and saves it without them", async () => {
    window.localStorage.setItem(
      "sshs3.notifyPolicy.v1",
      JSON.stringify({ chatOps: { enabled: true, callbackUrl: "https://old.example.com/cb", ttlSeconds: 600, requireSignedWebhook: true } }),
    );
    try {
      const hub = makeHub();
      const withOld = { ...hub, notifications: { ...hub.notifications, chatOps: { enabled: true } } } as unknown as HubSnapshot;
      const act = vi.fn(async () => withOld);
      render(<NotificationsCard hub={withOld} act={act} />);
      expect(screen.getByTestId("notify-policy-section")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("save-notify-policy-btn"));
      await waitFor(() => expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "notify-settings-save" })));
      // The old answers from chat are dropped: not sent to the server, not written back to this browser.
      expect(JSON.stringify(act.mock.calls)).not.toContain("chatOps");
      expect(window.localStorage.getItem("sshs3.notifyPolicy.v1")).not.toContain("chatOps");
    } finally {
      window.localStorage.removeItem("sshs3.notifyPolicy.v1");
    }
  });

  it("points to Agent in chat only where there is one, on a web server", () => {
    const hub = makeHub();
    const onWeb = { ...hub, chatAnswering: { enabled: false, services: [], links: [], waiting: [] } } as unknown as HubSnapshot;
    render(<NotificationsCard hub={onWeb} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("notify-answer-in-chat")).toHaveTextContent(
      "A change in a conversation started in Slack or Mattermost is posted in its thread there, and people who linked their chat account can answer it. See Agent in chat.",
    );
  });
});
