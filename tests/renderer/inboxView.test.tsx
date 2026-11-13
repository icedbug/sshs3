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
    { id: "t1", title: "Fix nginx", status: "waiting", agentName: "Operator", updatedAt: 5, messages: [], changes: [{ id: "c1", kind: "command", description: "Restart nginx", command: "systemctl restart nginx", target: "web-01", status: "pending", riskLevel: "modify", at: 50 }] },
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
    expect(items.find((i) => i.id === "alert:k4")?.detail).toBe("With an agent, not started yet");
    expect(items[0]).toMatchObject({ title: "Restart nginx", detail: "systemctl restart nginx", from: "Operator on web-01", risk: "modify" });
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
    expect(within(approval).getByText("changes state")).toBeVisible();
    fireEvent.click(within(approval).getByRole("button", { name: "Approve" }));
    expect(act).toHaveBeenCalledWith({ action: "approve", taskId: "t1", changeId: "c1", approved: true });
    fireEvent.click(within(screen.getByTestId("inbox-plan")).getByRole("button", { name: "Approve the plan" }));
    expect(act).toHaveBeenCalledWith({ action: "plan-decide", taskId: "t2", approved: true });
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
});
