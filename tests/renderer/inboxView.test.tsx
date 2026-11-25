// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { InboxView } from "../../src/renderer/src/components/AiHub/InboxView";
import { inboxItems } from "../../src/renderer/src/components/AiHub/workforceModel";

afterEach(cleanup);

const hub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({ tasks: [], workTickets: [], kbFindings: [], agents: [], alertIntake: { canReceive: true, enabled: false, received: 0, rules: [] }, ...extra }) as unknown as HubSnapshot;

const full = hub({
  tasks: [
    { id: "t1", title: "Fix nginx", status: "waiting", agentName: "Operator", updatedAt: 5, messages: [], changes: [{ id: "c1", kind: "command", description: "Restart nginx", command: "systemctl restart nginx", target: "web-01", status: "pending", check: { command: "systemctl is-active nginx", expected: "active" }, rollback: { command: "systemctl stop nginx" }, at: 50 }] },
    { id: "t2", title: "Upgrade", status: "waiting", agentName: "Operator", updatedAt: 6, messages: [], changes: [], plan: { id: "p1", goal: "Upgrade postgres", steps: [{}, {}], status: "proposed", revision: 1, review: { verdict: "revise", findings: [] }, createdAt: 40 } },
    { id: "t3", title: "Which cluster?", status: "waiting", agentName: "Watch", updatedAt: 30, messages: [{ id: "m", role: "assistant", text: "Which cluster do you mean?", at: 1 }], changes: [] },
    { id: "t4", title: "Background", status: "running", workforceRunId: "x", messages: [], changes: [{ id: "c9", status: "pending", description: "hidden", target: "x", at: 1 }] },
    { id: "t5", title: "Done long ago", status: "completed", messages: [], changes: [{ id: "c8", status: "pending", description: "stale", target: "x", at: 1 }] },
  ] as unknown as HubSnapshot["tasks"],
  workTickets: [
    { id: "k1", title: "Morning check", status: "review", result: "All fine.", assigneeName: "Watch", updatedAt: 20 },
    { id: "k2", title: "Backup", status: "blocked", result: "The run failed: timeout", assigneeName: "Operator", updatedAt: 25 },
    { id: "k3", title: "Alert (critical): Disk full", status: "backlog", updatedAt: 60, alert: { fingerprint: "f", source: "Alertmanager", severity: "critical", firstAt: 60, lastAt: 60, count: 3 } },
    { id: "k4", title: "Alert: has an agent", status: "todo", assigneeAgentId: "a", updatedAt: 61, alert: { fingerprint: "g", source: "Alertmanager", severity: "warning", firstAt: 1, lastAt: 1, count: 1 } },
  ] as unknown as HubSnapshot["workTickets"],
  kbFindings: [
    { id: "gap:x", kind: "gap", text: "An agent looked for “ceph keys” and found nothing.", at: 3 },
    { id: "stale:p", kind: "stale", text: "Old page", at: 2 },
  ],
});

describe("what is waiting for a person", () => {
  it("gathers approvals, plans, questions, tickets, unowned alerts and gaps, what blocks an agent first", () => {
    const items = inboxItems(full);
    // An alert assigned to an agent that has not started on it still waits for a person (feature 6 review).
    expect(items.map((i) => i.kind)).toEqual(["approval", "plan", "question", "alert", "blocked", "alert", "review", "knowledge"]);
    expect(items.find((i) => i.id === "alert:k4")?.detail).toBe("With an agent; it waits for a person to start it");
    expect(items[0]).toMatchObject({ title: "Restart nginx", detail: "systemctl restart nginx", from: "Operator on web-01" });
    // Nothing rates a change: an approval carries no risk. (An alert's `risk` is its severity.)
    expect(items[0]).not.toHaveProperty("risk");
    expect(items[1].detail).toBe("2 steps · the reviewer has objections");
    expect(items[3].detail).toBe("Nobody has it · fired 3 times");
    expect(inboxItems(hub())).toEqual([]);
  });

  it("lets each thing be dealt with where it is listed", async () => {
    const act = vi.fn(async () => hub());
    const openTask = vi.fn();
    render(<InboxView hub={full} act={act} onOpenTask={openTask} onOpenView={() => {}} />);
    const approval = screen.getByTestId("inbox-approval");
    expect(within(approval).getByText("systemctl restart nginx")).toBeVisible();
    expect(approval).not.toHaveTextContent(/changes state|read-only|destructive/);
    fireEvent.click(within(approval).getByRole("button", { name: "Approve" }));
    expect(act).toHaveBeenCalledWith({ action: "approve", taskId: "t1", changeId: "c1", approved: true });
    fireEvent.click(within(screen.getByTestId("inbox-plan")).getByRole("button", { name: "Approve the plan" }));
    expect(act).toHaveBeenCalledWith({ action: "plan-decide", taskId: "t2", approved: true });
    // Found by the security lead tester: the inbox offered no way to say no to a plan.
    const reject = () => within(screen.getByTestId("inbox-plan")).getByRole("button", { name: "Reject Plan" });
    await waitFor(() => expect(reject()).toBeEnabled());
    fireEvent.click(reject());
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "plan-decide", taskId: "t2", approved: false }));
    fireEvent.click(within(screen.getByTestId("inbox-question")).getByRole("button", { name: "Answer" }));
    expect(openTask).toHaveBeenCalledWith("t3");
    // Sending a ticket back needs a note saying what is missing.
    const review = screen.getByTestId("inbox-review");
    expect(within(review).getByRole("button", { name: "Send back" })).toBeDisabled();
    fireEvent.change(within(review).getByLabelText("Note for the agent"), { target: { value: "Also check the replica" } });
    fireEvent.click(within(review).getByRole("button", { name: "Send back" }));
    expect(act).toHaveBeenCalledWith({ action: "ticket-review", id: "k1", approve: false, note: "Also check the replica" });
    fireEvent.click(within(screen.getByTestId("inbox-knowledge")).getByRole("button", { name: "Dismiss" }));
    expect(act).toHaveBeenCalledWith({ action: "kb-finding-dismiss", id: "gap:x" });
  });

  it("shows the address to post alerts to once, and says so when there is none", async () => {
    const act = vi.fn(async () => hub({ reply: { alertHook: { path: "/api/hooks/u1.secret" } } }));
    const { unmount } = render(<InboxView hub={hub()} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    expect(screen.getByTestId("inbox-empty")).toBeVisible();
    fireEvent.click(screen.getByText(/^Alerts in/));
    fireEvent.click(screen.getByRole("button", { name: "Create an address to post to" }));
    await waitFor(() => expect(screen.getByTestId("alert-address")).toHaveValue(`${window.location.origin}/api/hooks/u1.secret`));
    fireEvent.change(screen.getByTestId("alert-paste"), { target: { value: "Disk full on pg-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a ticket of it" }));
    expect(act).toHaveBeenCalledWith({ action: "alert-paste", text: "Disk full on pg-01" });
    unmount();
    render(<InboxView hub={hub({ alertIntake: { canReceive: false, enabled: false, received: 0, rules: [] } })} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    fireEvent.click(screen.getByText(/^Alerts in/));
    expect(screen.getByText(/The desktop app has no address/)).toBeVisible();
  });

  it("renders markdown formatting in blocked and review excerpts instead of raw asterisks", () => {
    const mdHub = hub({
      workTickets: [
        { id: "k1", title: "Morning check", status: "review", result: "**All fine** on `web-01`.", assigneeName: "Watch", updatedAt: 20 },
        { id: "k2", title: "Backup", status: "blocked", result: "**Timeout** running `pg_dump`.", assigneeName: "Operator", updatedAt: 25 },
      ] as unknown as HubSnapshot["workTickets"],
    });
    render(<InboxView hub={mdHub} act={vi.fn(async () => hub())} onOpenTask={() => {}} onOpenView={() => {}} />);

    const review = screen.getByTestId("inbox-review");
    expect(within(review).getByText("All fine").tagName).toBe("STRONG");
    expect(within(review).getByText("web-01").tagName).toBe("CODE");
    expect(review.textContent).not.toContain("**");

    const blocked = screen.getByTestId("inbox-blocked");
    expect(within(blocked).getByText("Timeout").tagName).toBe("STRONG");
    expect(within(blocked).getByText("pg_dump").tagName).toBe("CODE");
    expect(blocked.textContent).not.toContain("**");
  });

  it("copies a newly created alert webhook address, explains when an enabled hook hides its one-time URL, and opens KB findings on the review tab", async () => {
    const clipboard = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
    const openView = vi.fn();
    const act = vi.fn(async () => hub({ reply: { alertHook: { path: "/api/hooks/u1.secret" } } }));

    const { rerender } = render(
      <InboxView
        hub={hub({
          kbFindings: [{ id: "gap:1", kind: "gap", text: "Missing runbook", at: 1 }],
        })}
        act={act}
        onOpenTask={() => {}}
        onOpenView={openView}
      />,
    );

    fireEvent.click(within(screen.getByTestId("inbox-knowledge")).getByRole("button", { name: "Look at it" }));
    expect(openView).toHaveBeenCalledWith("Knowledge Base", { kbTab: "review" });

    fireEvent.click(screen.getByText(/^Alerts in/));
    fireEvent.click(screen.getByRole("button", { name: "Create an address to post to" }));
    await waitFor(() => expect(screen.getByTestId("alert-address")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("alert-address-copy"));
    expect(clipboard).toHaveBeenCalledWith(`${window.location.origin}/api/hooks/u1.secret`);
    await waitFor(() => expect(screen.getByTestId("alert-address-copy")).toHaveTextContent("Copied"));

    clipboard.mockRejectedValueOnce(new Error("Clipboard denied"));
    fireEvent.click(screen.getByTestId("alert-address-copy"));
    expect(await screen.findByTestId("alert-address-copy-error")).toHaveTextContent(/Could not copy automatically/);

    rerender(
      <InboxView
        hub={hub({ alertIntake: { canReceive: true, enabled: true, received: 2, rules: [] } })}
        act={act}
        onOpenTask={() => {}}
        onOpenView={openView}
      />,
    );
    // It asks first: the address stops working for whatever posts to it.
    fireEvent.click(screen.getByRole("button", { name: "Revoke and turn off" }));
    expect(act).not.toHaveBeenCalledWith({ action: "alert-hook-disable" });
    fireEvent.click(screen.getByRole("button", { name: "Turn it off? The address stops working." }));
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "alert-hook-disable" }));
    await waitFor(() =>
      expect(screen.getByText(/The webhook address is shown once when created/)).toBeVisible(),
    );
  });

  it("keeps unsaved alert routing rule drafts when validation fails and shows the error inline", async () => {
    const act = vi.fn(async () =>
      hub({
        reply: { notes: ['Not saved: choose an agent for rule "disk".'] },
      }),
    );
    render(
      <InboxView
        hub={hub({
          agents: [{ id: "op", name: "Operator", role: "ops", mission: "", systemPrompt: "", defaultMode: "ask", kbDocIds: [], mcpServerIds: [] }] as unknown as HubSnapshot["agents"],
        })}
        act={act}
        onOpenTask={() => {}}
        onOpenView={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(/^Alerts in/));
    fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));
    fireEvent.change(screen.getByLabelText("Alert contains"), { target: { value: "disk" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));

    expect(await screen.findByTestId("alert-rules-status")).toHaveTextContent(
      'Not saved: choose an agent for rule "disk".',
    );
    // Draft input remains visible so the user can pick an agent instead of losing their rule.
    expect(screen.getByLabelText("Alert contains")).toHaveValue("disk");
    expect(screen.getByRole("button", { name: "Save rules" })).toBeVisible();
  });
});

describe("a teammate's change that needs a second person", () => {
  const teammates = hub({
    peerApprovals: [
      {
        ownerId: "u-omar",
        ownerName: "Omar Lind",
        agentName: "Linux SRE",
        taskId: "run-1",
        changeId: "c7",
        description: "Restart the web server",
        command: "sudo systemctl restart nginx",
        target: "web-prod-01",
        requiredApprovals: 2,
        approvedBy: ["Omar Lind"],
        at: 40,
      },
    ],
  });

  it("is in the inbox as what blocks a teammate's run, with what would run and for whom", () => {
    const [item] = inboxItems(teammates);
    expect(item).toMatchObject({
      id: "peer:u-omar:c7",
      kind: "peer",
      bucket: "blocking",
      title: "Restart the web server",
      detail: "sudo systemctl restart nginx",
      from: "Omar Lind (Linux SRE) on web-prod-01",
      ownerId: "u-omar",
      taskId: "run-1",
      changeId: "c7",
    });
    expect(item).not.toHaveProperty("risk");
  });

  it("is answered there, and the answer goes to the teammate's run", async () => {
    const act = vi.fn(async () => hub());
    render(<InboxView hub={teammates} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    const card = screen.getByTestId("inbox-peer");
    // The heading says what it is, whose run it is and where: in one line.
    expect(card).toHaveTextContent(/Needs a second person/i);
    expect(card).toHaveTextContent(/Omar Lind \(Linux SRE\) on web-prod-01/i);
    expect(within(card).getByText("sudo systemctl restart nginx")).toBeVisible();
    expect(within(card).getByTestId("peer-count-c7")).toHaveTextContent("Approved so far by Omar Lind. 2 different people have to approve.");
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    expect(act).toHaveBeenCalledWith({ action: "peer-approve", ownerId: "u-omar", taskId: "run-1", changeId: "c7", approved: true });
    // One answer at a time: the buttons are locked until the first one has landed.
    expect(within(card).getByRole("button", { name: "Deny" })).toBeDisabled();
    await waitFor(() => expect(within(card).getByRole("button", { name: "Deny" })).toBeEnabled());
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    expect(act).toHaveBeenCalledWith({ action: "peer-approve", ownerId: "u-omar", taskId: "run-1", changeId: "c7", approved: false });
  });
});

describe("a change of one's own that needs two people", () => {
  const own = (approvals: Array<{ actor: string; allowed: boolean; at: number }>) =>
    hub({
      tasks: [
        {
          id: "t1",
          title: "Restart nginx",
          status: "waiting",
          agentName: "Linux SRE",
          updatedAt: 5,
          messages: [],
          changes: [{ id: "c1", kind: "command", description: "Restart nginx", command: "systemctl restart nginx", target: "web-prod-01", status: "pending", check: { command: "systemctl is-active nginx", expected: "active" }, rollback: { command: "systemctl stop nginx" }, requiredApprovals: 2, approvals, at: 4 }],
        },
      ] as unknown as HubSnapshot["tasks"],
    });

  it("says that two people have to approve, and that the others are being asked", () => {
    render(<InboxView hub={own([])} act={vi.fn(async () => hub())} onOpenTask={() => {}} onOpenView={() => {}} />);
    expect(screen.getByTestId("approval-count-c1")).toHaveTextContent("2 different people have to approve. Your approval counts as one; the others who may are asked in their inbox.");
  });

  it("says who has approved once somebody has", () => {
    render(<InboxView hub={own([{ actor: "Omar Lind", allowed: true, at: 5 }])} act={vi.fn(async () => hub())} onOpenTask={() => {}} onOpenView={() => {}} />);
    expect(screen.getByTestId("approval-count-c1")).toHaveTextContent("Approved so far by Omar Lind. 2 different people have to approve");
  });

  it("says nothing of the kind about a change one person may approve", () => {
    render(<InboxView hub={full} act={vi.fn(async () => hub())} onOpenTask={() => {}} onOpenView={() => {}} />);
    expect(screen.queryByTestId("approval-count-c1")).not.toBeInTheDocument();
  });
});

describe("a plan that waits for its answer", () => {
  const NOW = 10 * 86_400_000;
  const withPlan = (plan: Record<string, unknown>, status = "completed") =>
    hub({
      tasks: [
        {
          id: "t1",
          title: "Restart nginx",
          status,
          agentName: "Linux SRE",
          updatedAt: NOW,
          messages: [],
          changes: [],
          target: { sessionId: "s", generation: "g", label: "web-prod-01" },
          plan: { id: "p1", goal: "Restart the web server", steps: [{ action: "Restart nginx", risk: "medium", check: "is-active" }], status: "proposed", revision: 1, review: { verdict: "approve", findings: [] }, createdAt: NOW - 60_000, ...plan },
        },
      ] as unknown as HubSnapshot["tasks"],
    });

  it("is in the inbox once the agent has stopped: that is when it can be answered", () => {
    const [item] = inboxItems(withPlan({}), { now: NOW });
    expect(item).toMatchObject({ id: "plan:p1", kind: "plan", bucket: "blocking", title: "Restart the web server", detail: "1 step", from: "Linux SRE", target: "web-prod-01", taskId: "t1" });
    // One nobody answered for more than a week is not: it can still be answered in its conversation.
    expect(inboxItems(withPlan({ createdAt: NOW - 8 * 86_400_000 }), { now: NOW })).toEqual([]);
    // A decided plan is not waiting.
    expect(inboxItems(withPlan({ status: "approved" }), { now: NOW })).toEqual([]);
  });

  it("says that it takes two people, and who has approved", () => {
    const line = (plan: Record<string, unknown>): string => inboxItems(withPlan(plan), { now: NOW })[0].detail!;
    expect(line({ requiredApprovals: 2 })).toBe("1 step · Two people have to approve this plan: you and one more. The others who may approve are asked in their inbox.");
    expect(line({ requiredApprovals: 2, approvals: [{ actor: "Omar Lind", allowed: true, at: 1 }] })).toBe(
      "1 step · You approved. It waits for one more person: the others who may approve are asked in their inbox.",
    );
    expect(line({ requiredApprovals: 2, approvals: [{ actor: "Maria Ek", allowed: true, peer: true, at: 1 }] })).toBe("1 step · Approved by Maria Ek. It waits for your own answer.");
    expect(line({ requiredApprovals: 3 })).toBe("1 step · 3 people have to approve this plan: you and 2 more. The others who may approve are asked in their inbox.");
    // One person approves it: nothing is said about people.
    expect(line({ requiredApprovals: 1 })).toBe("1 step");
  });

  it("offers this person's approval once: after it, the plan waits for somebody else", () => {
    const act = vi.fn(async () => hub());
    // On screen the clock is the real one: the plan was proposed a minute ago.
    const createdAt = Date.now() - 60_000;
    const before = render(<InboxView hub={withPlan({ requiredApprovals: 2, createdAt })} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    fireEvent.click(within(screen.getByTestId("inbox-plan")).getByRole("button", { name: "Approve the plan" }));
    expect(act).toHaveBeenCalledWith({ action: "plan-decide", taskId: "t1", approved: true });
    before.unmount();
    render(<InboxView hub={withPlan({ requiredApprovals: 2, createdAt, approvals: [{ actor: "Omar Lind", allowed: true, at: 1 }] })} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    const card = screen.getByTestId("inbox-plan");
    expect(within(card).queryByRole("button", { name: "Approve the plan" })).toBeNull();
    expect(within(card).getByRole("button", { name: "Read it" })).toBeVisible();
    expect(card).toHaveTextContent("You approved. It waits for one more person");
  });
});

describe("a teammate's plan that needs a second person", () => {
  const teammates = hub({
    peerApprovals: [
      {
        ownerId: "u-omar",
        ownerName: "Omar Lind",
        agentName: "Linux SRE",
        taskId: "run-1",
        changeId: "p1",
        description: "Restart the web server",
        target: "web-prod-01",
        requiredApprovals: 2,
        approvedBy: ["Omar Lind"],
        at: 40,
        plan: {
          steps: [
            { action: "Restart nginx", command: "sudo systemctl restart nginx", target: "web-prod-01", risk: "medium" },
            { action: "Look at the error log", risk: "low" },
          ],
        },
      },
    ],
  });

  it("is in the inbox with every step, its command and where it runs", () => {
    const [item] = inboxItems(teammates);
    expect(item).toMatchObject({ id: "peer:u-omar:p1", kind: "peer", bucket: "blocking", title: "Plan: Restart the web server", from: "Omar Lind (Linux SRE) on web-prod-01" });
    expect(item.detail).toBe("1. [medium risk] Restart nginx (on web-prod-01)\n   $ sudo systemctl restart nginx\n2. [low risk] Look at the error log");
  });

  it("is approved or not as a plan, and the answer goes to the teammate's conversation", async () => {
    const act = vi.fn(async () => hub());
    render(<InboxView hub={teammates} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    const card = screen.getByTestId("inbox-peer");
    expect(card).toHaveTextContent("Plan: Restart the web server");
    expect(card).toHaveTextContent("$ sudo systemctl restart nginx");
    expect(within(card).getByTestId("peer-count-p1")).toHaveTextContent("Approved so far by Omar Lind. 2 different people have to approve.");
    fireEvent.click(within(card).getByRole("button", { name: "Approve the plan" }));
    expect(act).toHaveBeenCalledWith({ action: "peer-approve", ownerId: "u-omar", taskId: "run-1", changeId: "p1", approved: true });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Do not approve" })).toBeEnabled());
    fireEvent.click(within(card).getByRole("button", { name: "Do not approve" }));
    expect(act).toHaveBeenCalledWith({ action: "peer-approve", ownerId: "u-omar", taskId: "run-1", changeId: "p1", approved: false });
  });
});
