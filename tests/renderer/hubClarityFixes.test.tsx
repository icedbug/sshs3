// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot, WorkTicket } from "../../src/shared/types/aiHub";
import { countWaitingInboxItems, inboxItems } from "../../src/shared/aiHubInbox";
import { ChangesView } from "../../src/renderer/src/components/AiHub/ChangesView";
import { WorkforceView } from "../../src/renderer/src/components/AiHub/WorkforceView";

afterEach(cleanup);

const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: `Ticket ${id}`,
  description: "",
  status: "todo",
  createdBy: "jacob",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const hub = (extra: Partial<HubSnapshot>): HubSnapshot =>
  ({
    tasks: [],
    sessions: [],
    agents: [],
    workGoals: [],
    workTickets: [],
    workforceTemplates: [],
    preferences: {},
    ...extra,
  }) as unknown as HubSnapshot;

const REPORTED = "Reported by the team. Not run or approved through sshS3.";

describe("team activity in the Changes timeline", () => {
  const event = (id: string, kind: string, extra: object = {}) => ({
    id,
    targetLabel: "web-01",
    actor: "maria",
    kind,
    summary: `${kind} on web-01`,
    at: 1_700_000_000_000,
    ...extra,
  });

  it("says that a reported change was not run or approved here", () => {
    render(
      <ChangesView
        hub={hub({
          activityLog: [
            event("a", "deploy"),
            event("b", "command", { commandOrPath: "systemctl restart nginx" }),
            event("c", "note"),
          ] as HubSnapshot["activityLog"],
        })}
        onOpenTask={() => {}}
        request={vi.fn()}
      />,
    );
    // In the row, without opening anything.
    expect(screen.getByTestId("reported-only-team-a")).toHaveTextContent("Reported by the team");
    expect(screen.getByTestId("reported-only-team-b")).toBeInTheDocument();
    // A note changed nothing: it carries no such tag.
    expect(screen.queryByTestId("reported-only-team-c")).not.toBeInTheDocument();
    // The full sentence is in what opens, also for an entry with nothing else to show.
    const lines = screen.getAllByTestId("reported-only-line");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveTextContent(REPORTED);
  });
});

describe("the workforce view", () => {
  it("puts the paused banner first and scrolls to it when the workforce becomes paused", () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      const base = hub({ workTickets: [ticket("a")] });
      const { container, rerender } = render(<WorkforceView hub={base} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
      expect(screen.queryByTestId("workforce-paused-banner")).not.toBeInTheDocument();

      rerender(<WorkforceView hub={{ ...base, workforcePaused: true }} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
      const banner = screen.getByTestId("workforce-paused-banner");
      expect(container.querySelector(".ai-workforce")!.firstElementChild).toBe(banner);
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.instances[0]).toBe(banner);

      // Another render while paused does not pull the page up again.
      rerender(<WorkforceView hub={{ ...base, workforcePaused: true, workTickets: [ticket("a"), ticket("b")] }} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
      expect(scrolled).toHaveBeenCalledTimes(1);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("does not scroll when it opens already paused", () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<WorkforceView hub={hub({ workforcePaused: true })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
      expect(screen.getByTestId("workforce-paused-banner")).toBeInTheDocument();
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("says what its numbers count", () => {
    render(
      <WorkforceView
        hub={hub({
          workGoals: [{ id: "g", title: "Keep prod healthy", createdAt: 1, updatedAt: 1 }] as HubSnapshot["workGoals"],
          workTickets: [
            ticket("a", { alert: { name: "DiskFull", source: "prom", severity: "critical", count: 1, firstAt: 1, lastAt: 1 } as WorkTicket["alert"] }),
            ticket("b"),
          ],
        })}
        act={vi.fn(async () => undefined)}
        onOpenTask={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Keep prod healthy · 0 of 0 tickets done" })).toBeVisible();

    const filter = within(screen.getByTestId("workforce-filter"));
    fireEvent.click(filter.getByRole("button", { name: "Alerts" }));
    expect(filter.getByRole("button", { name: "Clear filters (1 of 2 shown)" })).toBeVisible();
    // Exactly the chosen chip shows as chosen.
    expect(filter.getByRole("button", { name: "Alerts" })).toHaveAttribute("aria-pressed", "true");
    expect(filter.getByRole("button", { name: "Alerts" })).toHaveClass("ai-chip-on");
    for (const other of ["All", "Critical"]) {
      expect(filter.getByRole("button", { name: other })).toHaveAttribute("aria-pressed", "false");
      expect(filter.getByRole("button", { name: other })).not.toHaveClass("ai-chip-on");
    }
  });

  it("shows one ticket detail at a time", () => {
    render(<WorkforceView hub={hub({ workTickets: [ticket("a"), ticket("b")] })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
    fireEvent.click(within(screen.getByTestId("ticket-a")).getByRole("button", { name: "Ticket a" }));
    fireEvent.click(within(screen.getByTestId("ticket-b")).getByRole("button", { name: "Ticket b" }));
    expect(screen.getAllByTestId("ticket-detail")).toHaveLength(1);
    expect(screen.getByTestId("ticket-detail")).toHaveTextContent("Ticket b");
  });

  it("marks a scripted demo review as an example in the run inspector", () => {
    const run = (id: string, extra: object = {}) => ({
      id,
      title: `Run ${id}`,
      prompt: "",
      leadAgentName: "Lead",
      status: "completed",
      steps: [],
      synthesis: "Ceph/ZFS is at HEALTH_OK.",
      createdAt: 1,
      updatedAt: 1,
      ...extra,
    });
    render(
      <WorkforceView
        hub={hub({ workforceRuns: [run("demo-wf-cross-cluster-audit"), run("wf-12345678")] as HubSnapshot["workforceRuns"] })}
        act={vi.fn(async () => undefined)}
        onOpenTask={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("run-drawer-toggle"));
    fireEvent.click(screen.getByTestId("run-drawer-workforce-demo-wf-cross-cluster-audit"));
    expect(screen.getByTestId("run-drawer-demo-label")).toHaveTextContent("Example from the demo data. Not the current state.");
    fireEvent.click(screen.getByTestId("run-drawer-workforce-wf-12345678"));
    expect(screen.queryByTestId("run-drawer-demo-label")).not.toBeInTheDocument();
  });
});

describe("the Inbox tab's count", () => {
  const alertTicket = (id: string): WorkTicket =>
    ticket(id, { alert: { name: "DiskFull", source: "prom", severity: "critical", count: 1, firstAt: 1, lastAt: 1 } as WorkTicket["alert"] });

  it("leaves out an acknowledged alert, which stays listed", () => {
    const input = {
      tasks: [],
      workTickets: [alertTicket("a"), alertTicket("b")],
      inboxState: { "alert:a": { acknowledgedAt: 5 } },
    } as unknown as Parameters<typeof inboxItems>[0];
    const items = inboxItems(input, { now: 10 });
    expect(items.map((i) => i.id).sort()).toEqual(["alert:a", "alert:b"]);
    expect(items.find((i) => i.id === "alert:a")?.acknowledgedAt).toBe(5);
    expect(countWaitingInboxItems(input, { now: 10 })).toBe(1);
    expect(countWaitingInboxItems(items, { now: 10 })).toBe(1);
  });

  it("still counts an acknowledged approval, and not a snoozed item", () => {
    const items = [
      { id: "approval:x", kind: "approval", title: "x", at: 1, acknowledgedAt: 5 },
      { id: "alert:y", kind: "alert", title: "y", at: 1, snoozedUntil: 100 },
      { id: "review:z", kind: "review", title: "z", at: 1 },
    ] as Parameters<typeof countWaitingInboxItems>[0];
    expect(countWaitingInboxItems(items, { now: 10 })).toBe(2);
  });
});
