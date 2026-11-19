// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPlan, HubSnapshot } from "../../src/shared/types/aiHub";
import { InboxView } from "../../src/renderer/src/components/AiHub/InboxView";
import { PlanCard } from "../../src/renderer/src/components/AiHub/PlanCard";
import { TaskTodos } from "../../src/renderer/src/components/AiHub/TaskTodos";
import { TerminalControl } from "../../src/renderer/src/components/AiHub/TerminalControl";

afterEach(() => {
  cleanup();
  delete (window as unknown as { multissh?: unknown }).multissh;
});

const makeHub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    config: { enabled: true },
    sessions: [],
    tasks: [],
    workTickets: [],
    kbFindings: [],
    agents: [],
    alertIntake: { canReceive: true, enabled: false, received: 0, rules: [] },
    ...extra,
  }) as unknown as HubSnapshot;

describe("InboxView priority sections, keyboard triage, snooze & batch actions", () => {
  const now = Date.now();
  const sampleHub = makeHub({
    tasks: [
      {
        id: "t-safe",
        title: "Inspect logs",
        status: "waiting",
        agentName: "Watch",
        updatedAt: now - 10_000,
        messages: [],
        changes: [
          {
            id: "c-safe",
            kind: "command",
            description: "Check nginx status",
            command: "systemctl status nginx",
            target: "web-01",
            status: "pending",
            riskLevel: "safe",
            at: now - 5_000,
          },
        ],
      },
      {
        id: "t-dest",
        title: "Clean temp",
        status: "waiting",
        agentName: "Operator",
        updatedAt: now - 20_000,
        messages: [],
        changes: [
          {
            id: "c-dest",
            kind: "command",
            description: "Purge cache dir",
            command: "rm -rf /var/cache/tmp/*",
            target: "web-02",
            status: "pending",
            riskLevel: "destructive",
            at: now - 15_000,
          },
        ],
      },
    ] as unknown as HubSnapshot["tasks"],
    workTickets: [
      {
        id: "k-alert",
        title: "High CPU on db-01",
        status: "backlog",
        updatedAt: now - 30_000,
        alert: { fingerprint: "cpu", source: "Prometheus", severity: "critical", firstAt: now - 30_000, lastAt: now - 30_000, count: 2 },
      },
    ] as unknown as HubSnapshot["workTickets"],
    kbFindings: [
      { id: "gap:1", kind: "gap", text: "Missing runbook for redis failover", at: now - 40_000 },
    ] as unknown as HubSnapshot["kbFindings"],
    inboxState: {
      "knowledge:gap:1": { snoozedUntil: now + 90 * 60_000 },
    },
  });

  it("groups items into Needs Decision, Urgent Alerts, Findings & Suggestions, and Snoozed sections", () => {
    const hubWithActiveAndSnoozed = makeHub({
      ...sampleHub,
      kbFindings: [
        { id: "gap:1", kind: "gap", text: "Snoozed gap", at: now - 40_000 },
        { id: "gap:2", kind: "gap", text: "Active gap", at: now - 35_000 },
      ] as unknown as HubSnapshot["kbFindings"],
    });

    render(
      <InboxView
        hub={hubWithActiveAndSnoozed}
        act={vi.fn(async () => hubWithActiveAndSnoozed)}
        onOpenTask={vi.fn()}
        onOpenView={vi.fn()}
      />,
    );

    const blocking = screen.getByTestId("inbox-section-blocking");
    expect(blocking).toHaveTextContent("Needs Decision");
    expect(within(blocking).getByText("Check nginx status")).toBeInTheDocument();

    const incident = screen.getByTestId("inbox-section-incident");
    expect(incident).toHaveTextContent("Urgent Alerts");
    expect(within(incident).getByText("High CPU on db-01")).toBeInTheDocument();

    const review = screen.getByTestId("inbox-section-review");
    expect(review).toHaveTextContent("Findings & Suggestions");
    expect(within(review).getByText("Active gap")).toBeInTheDocument();

    const snoozed = screen.getByTestId("inbox-section-snoozed");
    expect(snoozed).toHaveTextContent("Put off until later");
    expect(within(snoozed).getByText("Snoozed gap")).toBeInTheDocument();
    expect(within(snoozed).getByTestId("inbox-snooze-countdown")).toHaveTextContent(/Back in \d+ h|Back in \d+ min/);
  });

  it("supports keyboard triage (j/k/o/a/e/h/?) and ignores shortcuts while typing in inputs", async () => {
    const act = vi.fn(async () => sampleHub);
    const onOpenTask = vi.fn();

    render(
      <InboxView
        hub={sampleHub}
        act={act}
        onOpenTask={onOpenTask}
        onOpenView={vi.fn()}
      />,
    );

    // Toggle shortcut cheatsheet with ?
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByTestId("inbox-shortcuts")).toBeVisible();
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.queryByTestId("inbox-shortcuts")).not.toBeInTheDocument();

    // Typing inside search input must NOT trigger keyboard triage or cheatsheet
    const search = screen.getByTestId("inbox-search");
    fireEvent.keyDown(search, { key: "?" });
    fireEvent.keyDown(search, { key: "j" });
    fireEvent.keyDown(search, { key: "a" });
    expect(screen.queryByTestId("inbox-shortcuts")).not.toBeInTheDocument();
    expect(act).not.toHaveBeenCalled();

    // Navigate with j -> selects first item (c-safe)
    fireEvent.keyDown(window, { key: "j" });
    const approvals = screen.getAllByTestId("inbox-approval");
    expect(approvals[0]).toHaveAttribute("data-selected", "true");

    // Open with o -> opens t-safe
    fireEvent.keyDown(window, { key: "o" });
    expect(onOpenTask).toHaveBeenCalledWith("t-safe");

    // Approve safe approval with a -> immediate approve
    fireEvent.keyDown(window, { key: "a" });
    expect(act).toHaveBeenCalledWith({
      action: "approve",
      taskId: "t-safe",
      changeId: "c-safe",
      approved: true,
    });

    // Navigate down to destructive approval -> first 'a' arms, second 'a' approves
    fireEvent.keyDown(window, { key: "j" });
    expect(approvals[1]).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(window, { key: "a" });
    expect(screen.getByTestId("inbox-destructive-arm")).toBeVisible();
    expect(act).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "a" });
    expect(act).toHaveBeenLastCalledWith({
      action: "approve",
      taskId: "t-dest",
      changeId: "c-dest",
      approved: true,
    });

    // Press h to open snooze menu on selected item, then click 4h
    fireEvent.keyDown(window, { key: "h" });
    const snoozeMenu = screen.getByTestId("inbox-snooze-menu-approval:c-dest");
    fireEvent.click(within(snoozeMenu).getByRole("button", { name: "4h" }));
    expect(act).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "snooze-inbox",
        itemId: "approval:c-dest",
        durationMinutes: 240,
      }),
    );

    // Move back up with k and press e to archive/acknowledge
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "e" });
    expect(act).toHaveBeenLastCalledWith({
      action: "ack-inbox",
      itemId: "approval:c-safe",
      acknowledged: true,
    });
  });

  it("approves only low-risk non-guard approvals via batch triage bar and renders snooze countdowns", async () => {
    const act = vi.fn(async () => makeHub());
    const batchHub = makeHub({
      tasks: [
        {
          id: "t1",
          title: "Read status",
          status: "waiting",
          messages: [],
          changes: [
            { id: "c1", kind: "command", description: "Safe check 1", command: "uptime", target: "web-01", status: "pending", riskLevel: "safe", at: now - 10 },
            { id: "c2", kind: "command", description: "Safe guard", command: "cat /etc/sshs3", target: "web-01", status: "pending", riskLevel: "safe", guard: true, at: now - 20 },
            { id: "c3", kind: "command", description: "Modify action", command: "systemctl reload nginx", target: "web-01", status: "pending", riskLevel: "modify", at: now - 30 },
          ],
        },
      ] as unknown as HubSnapshot["tasks"],
      kbFindings: [
        { id: "gap:short", kind: "gap", text: "Short snooze item", at: now - 1000 },
      ] as unknown as HubSnapshot["kbFindings"],
      inboxState: {
        "knowledge:gap:short": { snoozedUntil: now + 45 * 60_000 },
      },
    });

    render(<InboxView hub={batchHub} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    expect(screen.getByTestId("inbox-batch-bar")).toHaveTextContent("1 low-risk read-only approval ready");
    fireEvent.click(screen.getByTestId("inbox-approve-low-risk"));
    await waitFor(() =>
      expect(act).toHaveBeenCalledWith({
        action: "approve",
        taskId: "t1",
        changeId: "c1",
        approved: true,
      }),
    );
    expect(act).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("inbox-snooze-countdown")).toHaveTextContent(/Back in 4[45] min/);
  });
});

describe("PlanCard 2-button decision flow", () => {
  const plan: AgentPlan = {
    id: "p1",
    goal: "Roll out nginx timeout bump",
    steps: [
      {
        action: "Update proxy timeout",
        target: "web-01",
        command: "sed -i s/60s/120s/ /etc/nginx/nginx.conf",
        risk: "medium",
        check: "nginx -t succeeds",
        rollback: "git checkout /etc/nginx/nginx.conf",
      },
      {
        action: "Verify SSE endpoint",
        risk: "low",
        check: "curl holds 90s",
      },
    ],
    status: "proposed",
    revision: 1,
    review: { verdict: "approve", findings: [] },
    createdAt: 100,
  };

  it("renders Approve & Execute and Edit Plan, supports Save Draft and Send Revision without silent askEach flip", async () => {
    const act = vi.fn(async () => undefined);
    const onSaveDraft = vi.fn();

    render(<PlanCard taskId="task-1" plan={plan} busy={false} act={act} onSaveDraft={onSaveDraft} />);

    expect(screen.getByTestId("plan-step-1")).toHaveTextContent("medium risk");
    expect(screen.getByTestId("plan-step-2")).toHaveTextContent("low risk");
    expect(screen.getByTestId("plan-approve-btn")).toHaveTextContent("Approve & Execute");
    expect(screen.getByTestId("plan-edit-btn")).toHaveTextContent("Edit Plan");

    // Feedback panel starts collapsed; clicking Edit Plan expands it
    expect(screen.queryByTestId("plan-feedback-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("plan-edit-btn"));
    expect(screen.getByTestId("plan-feedback-panel")).toBeVisible();

    // Typing feedback does NOT silently check plan-ask-each
    const noteInput = screen.getByLabelText("Note to the agent");
    fireEvent.change(noteInput, { target: { value: "Test on staging first" } });
    expect(screen.getByTestId("plan-ask-each")).not.toBeChecked();

    // Save Draft preserves draft locally without calling act
    fireEvent.click(screen.getByTestId("plan-save-draft-btn"));
    expect(onSaveDraft).toHaveBeenCalledWith("Test on staging first");
    expect(screen.getByTestId("plan-draft-badge")).toHaveTextContent("Draft saved");
    expect(act).not.toHaveBeenCalled();

    // Send Revision dispatches plan-decide approved: false with note
    fireEvent.click(screen.getByTestId("plan-reject-btn"));
    expect(act).toHaveBeenCalledWith({
      action: "plan-decide",
      taskId: "task-1",
      approved: false,
      note: "Test on staging first",
    });

    await waitFor(() => expect(screen.getByTestId("plan-approve-btn")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("plan-approve-btn"));
    expect(act).toHaveBeenLastCalledWith({
      action: "plan-decide",
      taskId: "task-1",
      approved: true,
      note: "Test on staging first",
    });
  });
});

describe("a plan that takes two people", () => {
  const plan = (extra: Partial<AgentPlan> = {}): AgentPlan => ({
    id: "p1",
    goal: "Restart the web server",
    steps: [{ action: "Restart nginx", target: "web-prod-01", command: "sudo systemctl restart nginx", risk: "medium", check: "is-active prints active", rollback: "sudo systemctl start nginx" }],
    status: "proposed",
    revision: 1,
    review: { verdict: "approve", findings: [] },
    createdAt: 100,
    requiredApprovals: 2,
    ...extra,
  });

  it("says so before anybody has answered, and approving is this person's own approval, not the start", () => {
    const act = vi.fn(async () => undefined);
    render(<PlanCard taskId="task-1" plan={plan()} busy={false} act={act} />);
    expect(screen.getByTestId("plan-people")).toHaveTextContent("Two people have to approve this plan: you and one more. The others who may approve are asked in their inbox.");
    expect(screen.getByTestId("plan-status")).toHaveTextContent("waiting for your decision");
    // Your yes alone does not start the agent here, so the line under the plan does not say it does.
    expect(screen.getByTestId("plan-covers")).toHaveTextContent("The agent carries the plan out when you and a second person have both approved.");
    expect(screen.getByTestId("plan-covers")).not.toHaveTextContent("Approving lets the agent carry the plan out");
    expect(screen.getByTestId("plan-approve-btn")).toHaveTextContent(/^Approve$/);
    fireEvent.click(screen.getByTestId("plan-approve-btn"));
    expect(act).toHaveBeenCalledWith({ action: "plan-decide", taskId: "task-1", approved: true });
  });

  it("waits for a second person once this person has approved, and offers no second approval", () => {
    render(<PlanCard taskId="task-1" plan={plan({ approvals: [{ actor: "Omar Lind", actorId: "user:u1", allowed: true, at: 1 }], askEach: "person" })} busy={false} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("plan-status")).toHaveTextContent("waiting for a second person");
    expect(screen.getByTestId("plan-people")).toHaveTextContent("You approved. It waits for one more person: the others who may approve are asked in their inbox.");
    expect(screen.queryByTestId("plan-approve-btn")).toBeNull();
    // What this person chose about each command stands, and cannot be changed after the approval.
    expect(screen.getByTestId("plan-ask-each")).toBeChecked();
    expect(screen.getByTestId("plan-ask-each")).toBeDisabled();
    // The plan can still be taken back.
    expect(screen.getByTestId("plan-edit-btn")).toBeEnabled();
  });

  it("says when the second person answered first", () => {
    render(<PlanCard taskId="task-1" plan={plan({ approvals: [{ actor: "Maria Ek", actorId: "user:u2", allowed: true, peer: true, at: 1 }] })} busy={false} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("plan-people")).toHaveTextContent("Approved by Maria Ek. It waits for your own answer.");
    expect(screen.getByTestId("plan-status")).toHaveTextContent("waiting for your decision");
    expect(screen.getByTestId("plan-approve-btn")).toBeEnabled();
  });

  it("names the two once it is approved", () => {
    render(
      <PlanCard
        taskId="task-1"
        plan={plan({
          status: "approved",
          approvals: [
            { actor: "Omar Lind", actorId: "user:u1", allowed: true, at: 1 },
            { actor: "Maria Ek", actorId: "user:u2", allowed: true, peer: true, at: 2 },
          ],
        })}
        busy={false}
        act={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByTestId("plan-people")).toHaveTextContent("Approved by you and Maria Ek.");
    expect(screen.getByTestId("plan-covers")).toHaveTextContent("Approved: the listed commands run without asking again; destructive ones still ask.");
  });

  it("says nothing about people for a plan one person approves", () => {
    render(<PlanCard taskId="task-1" plan={plan({ requiredApprovals: 1 })} busy={false} act={vi.fn(async () => undefined)} />);
    expect(screen.queryByTestId("plan-people")).toBeNull();
    expect(screen.getByTestId("plan-approve-btn")).toHaveTextContent("Approve & Execute");
  });
});

describe("TerminalControl inline pending approval bar & controls", () => {
  it("shows blast radius, host, reason, command preview, Approve Once, Always Allow Prefix (safe), Deny, Return Control & Step-by-step", async () => {
    const onRequest = vi.fn(async () => makeHub());
    const onStepByStep = vi.fn();

    const hub = makeHub({
      safetyPolicy: {
        autoApproveSafeReadOnly: true,
        requireApprovalOnProdTags: true,
        blockDestructiveWithoutConfirm: true,
        commandAllowPrefixes: ["uptime"],
      },
      sessions: [
        { id: "s1", generation: "g1", label: "prod-web-01", kind: "ssh", shell: "bash", state: "ready", owner: "t1", updatedAt: 1 },
      ],
      tasks: [
        {
          id: "t1",
          title: "Diagnose nginx",
          status: "waiting",
          mode: "autonomous",
          target: { sessionId: "s1", generation: "g1", label: "prod-web-01" },
          messages: [],
          sources: [],
          changes: [
            {
              id: "c1",
              kind: "command",
              target: "prod-web-01",
              description: "Reload nginx config",
              command: "systemctl reload nginx",
              status: "pending",
              riskLevel: "modify",
              riskReason: "Reloads active HTTP worker processes",
              blastRadius: "1 production web node",
              at: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
          maxCommands: 10,
          maxMinutes: 5,
          verification: "not-verified",
        },
      ] as unknown as HubSnapshot["tasks"],
    });

    render(<TerminalControl sessionId="s1" hub={hub} onRequest={onRequest} onStepByStep={onStepByStep} />);

    const bar = screen.getByTestId("terminal-approval-bar");
    expect(within(bar).getByTestId("terminal-approval-target")).toHaveTextContent("Host: prod-web-01");
    expect(within(bar).getByTestId("terminal-approval-blast")).toHaveTextContent("1 production web node");
    expect(within(bar).getByTestId("terminal-approval-reason")).toHaveTextContent("Reloads active HTTP worker processes");
    expect(within(bar).getByTestId("terminal-approval-command")).toHaveTextContent("systemctl reload nginx");

    fireEvent.click(screen.getByTestId("terminal-approve-once-btn"));
    expect(onRequest).toHaveBeenCalledWith({
      action: "approve",
      taskId: "t1",
      changeId: "c1",
      approved: true,
    });

    await waitFor(() => expect(screen.getByTestId("terminal-allow-prefix-btn")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("terminal-allow-prefix-btn"));
    await waitFor(() =>
      expect(onRequest).toHaveBeenCalledWith({
        action: "safety-policy-save",
        policy: { commandAllowPrefixes: ["uptime", "systemctl reload"] },
      }),
    );

    await waitFor(() => expect(screen.getByTestId("terminal-deny-btn")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("terminal-deny-btn"));
    expect(onRequest).toHaveBeenCalledWith({
      action: "approve",
      taskId: "t1",
      changeId: "c1",
      approved: false,
    });

    await waitFor(() => expect(screen.getByTestId("terminal-step-by-step-btn")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("terminal-step-by-step-btn"));
    expect(onStepByStep).toHaveBeenCalledWith("t1");

    fireEvent.click(screen.getByTestId("terminal-return-control-btn"));
    expect(onRequest).toHaveBeenCalledWith({ action: "takeover", sessionId: "s1" });
  });

  it("hides Always Allow Prefix on destructive, compound, or secret-bearing commands and handles sudo prefixes", () => {
    const makeCmdHub = (command: string, riskLevel: "safe" | "modify" | "destructive" = "modify") =>
      makeHub({
        sessions: [
          { id: "s1", generation: "g1", label: "prod-db-01", kind: "ssh", state: "ready", owner: "t1", updatedAt: 1 },
        ],
        tasks: [
          {
            id: "t1",
            title: "Run op",
            status: "waiting",
            mode: "assisted",
            messages: [],
            sources: [],
            changes: [
              {
                id: "c-1",
                kind: "command",
                target: "prod-db-01",
                description: "Op",
                command,
                status: "pending",
                riskLevel,
                at: 1,
              },
            ],
          },
        ] as unknown as HubSnapshot["tasks"],
      });

    const { rerender } = render(<TerminalControl sessionId="s1" hub={makeCmdHub("rm -rf /tmp/old-data", "destructive")} onRequest={vi.fn()} />);
    expect(screen.getByTestId("terminal-approve-once-btn")).toBeVisible();
    expect(screen.getByTestId("terminal-deny-btn")).toBeVisible();
    expect(screen.queryByTestId("terminal-allow-prefix-btn")).not.toBeInTheDocument();

    rerender(<TerminalControl sessionId="s1" hub={makeCmdHub("cat file && rm -rf /", "modify")} onRequest={vi.fn()} />);
    expect(screen.queryByTestId("terminal-allow-prefix-btn")).not.toBeInTheDocument();

    rerender(<TerminalControl sessionId="s1" hub={makeCmdHub("curl https://token=abc", "modify")} onRequest={vi.fn()} />);
    expect(screen.queryByTestId("terminal-allow-prefix-btn")).not.toBeInTheDocument();

    rerender(<TerminalControl sessionId="s1" hub={makeCmdHub("sudo systemctl status nginx", "safe")} onRequest={vi.fn()} />);
    expect(screen.getByTestId("terminal-allow-prefix-btn")).toHaveTextContent("Always Allow Prefix (systemctl status)");
  });
});

describe("TaskTodos progress bar, status icons, spinner & elapsed timing", () => {
  it("renders progress bar, active spinner on in_progress, status icons, and elapsed times", () => {
    render(
      <TaskTodos
        elapsedMs={125_000}
        todos={[
          { id: "1", content: "Inspect logs", status: "completed", durationMs: 2_300 },
          { id: "2", content: "Patch config", status: "in_progress", elapsedMs: 8_100 },
          { id: "3", content: "Restart service", status: "blocked", note: "Awaiting approval" },
          { id: "4", content: "Clean up", status: "pending" },
        ]}
      />,
    );

    const list = screen.getByTestId("task-todos");
    expect(list).toHaveTextContent("Task list · 1/4 done");
    expect(screen.getByTestId("task-todos-elapsed")).toHaveTextContent("2m 5s");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByTestId("todo-spinner")).toBeInTheDocument();
    expect(screen.getByTestId("todo-icon-completed")).toBeInTheDocument();
    expect(screen.getByTestId("todo-icon-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("todo-icon-pending")).toBeInTheDocument();
    expect(screen.getByTestId("todo-elapsed-1")).toHaveTextContent("2.3s");
    expect(screen.getByTestId("todo-elapsed-2")).toHaveTextContent("8.1s");
  });
});
