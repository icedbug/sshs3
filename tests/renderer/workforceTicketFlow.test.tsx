// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot, WorkTicket } from "../../src/shared/types/aiHub";
import { ConfirmButton } from "../../src/renderer/src/components/AiHub/ConfirmButton";
import { InboxView } from "../../src/renderer/src/components/AiHub/InboxView";
import { WorkforceView } from "../../src/renderer/src/components/AiHub/WorkforceView";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ticket = (id: string, extra: Partial<WorkTicket> = {}): WorkTicket => ({
  id,
  title: `Ticket ${id}`,
  description: "",
  status: "todo",
  assigneeAgentId: "lead",
  assigneeName: "Lead",
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
    alertIntake: { canReceive: true, enabled: false, received: 0, rules: [] },
    ...extra,
  }) as unknown as HubSnapshot;

describe("a ticket's detail", () => {
  it("shows the request recorded for the open ticket and saves its edited reviewer", async () => {
    const accessRequest = { url: "https://access.example.net/requests/42", reviewer: "Day shift", resource: "pg-primary", expiresAt: Date.UTC(2027, 1, 3, 18, 25, 33, 123) };
    const state = hub({ workTickets: [ticket("access", { accessRequest })] });
    const send = vi.fn().mockResolvedValue(state);
    render(<WorkforceView hub={state} act={send} onOpenTask={() => {}} />);
    fireEvent.click(within(screen.getByTestId("ticket-access")).getByRole("button", { name: "Ticket access" }));
    const card = within(screen.getByRole("region", { name: "Resource access request" }));
    const link = card.getByRole("link", { name: "Open access request" });
    expect(link).toHaveAttribute("href", accessRequest.url);
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("multissh", { openExternal });
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith(accessRequest.url);
    expect(card.getByText(/Reviewer · Day shift/)).toBeVisible();
    fireEvent.click(card.getByRole("button", { name: "Edit access request" }));
    fireEvent.change(card.getByLabelText("Reviewer"), { target: { value: "Night shift" } });
    fireEvent.click(card.getByRole("button", { name: "Save access request" }));
    await waitFor(() => expect(send).toHaveBeenCalledWith({ action: "ticket-access-request", id: "access", accessRequest: { ...accessRequest, reviewer: "Night shift" } }));
  });

  it("scrolls into view when a ticket is opened, and holds the edit form", () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<WorkforceView hub={hub({ workTickets: [ticket("a"), ticket("b")] })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
      const title = within(screen.getByTestId("ticket-a")).getByRole("button", { name: "Ticket a" });
      expect(title).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(title);
      expect(title).toHaveAttribute("aria-expanded", "true");
      const detail = screen.getByTestId("ticket-detail");
      expect(scrolled).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
      expect(scrolled.mock.instances[0]).toBe(detail);

      fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
      expect(within(detail).getByTestId("ticket-form")).toHaveTextContent("Edit ticket");

      // A new ticket's form is not part of any ticket: it stays at the top.
      fireEvent.click(screen.getByRole("button", { name: "New ticket" }));
      expect(screen.getByTestId("ticket-form")).toHaveTextContent("New ticket");
      expect(within(detail).queryByTestId("ticket-form")).not.toBeInTheDocument();

      // The title is a toggle: clicking it again closes the ticket.
      fireEvent.click(title);
      expect(screen.queryByTestId("ticket-detail")).not.toBeInTheDocument();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("opens the ticket another view asked for", () => {
    render(<WorkforceView hub={hub({ workTickets: [ticket("a"), ticket("b")] })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} openTicketId="b" />);
    expect(screen.getByTestId("ticket-detail")).toHaveTextContent("Ticket b");
  });

  it("saves a person's report as the ticket's result", async () => {
    const act = vi.fn(async () => hub({}));
    render(
      <WorkforceView hub={hub({ workTickets: [ticket("a", { result: "Old text.", taskId: "t1" })] })} act={act} onOpenTask={() => {}} openTicketId="a" />,
    );
    const detail = screen.getByTestId("ticket-detail");
    // Who wrote the result is not on the ticket, so it is not called the agent's.
    expect(within(detail).getByTestId("ticket-report")).toHaveTextContent("Report");
    expect(detail).not.toHaveTextContent("The agent's report");
    expect(detail).toHaveTextContent("What was wrong and what you did.");
    // Found by an exploring tester: a scenario is the demo lab's, and only there does its check read this.
    expect(detail).not.toHaveTextContent("A scenario's last check reads this.");
    expect(within(detail).getByRole("button", { name: "Save report" })).toBeDisabled();
    fireEvent.change(within(detail).getByLabelText("Your report"), { target: { value: " The archive target was gone. I pointed it at the new one. " } });
    fireEvent.click(within(detail).getByRole("button", { name: "Save report" }));
    expect(act).toHaveBeenCalledWith({ action: "ticket-result", id: "a", result: "The archive target was gone. I pointed it at the new one." });
    await waitFor(() => expect(within(detail).getByLabelText("Your report")).toHaveValue(""));
  });

  it("says in the demo lab that a scenario's last check reads the report", () => {
    render(<WorkforceView hub={hub({ demoMode: true, workTickets: [ticket("a")] })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} openTicketId="a" />);
    expect(screen.getByTestId("ticket-detail")).toHaveTextContent("What was wrong and what you did. A scenario's last check reads this.");
  });

  it("offers Undo after a removal, which restores the ticket", async () => {
    const act = vi.fn(async () => hub({ workTickets: [] }));
    render(<WorkforceView hub={hub({ workTickets: [ticket("a")] })} act={act} onOpenTask={() => {}} openTicketId="a" />);
    const del = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(del);
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete this ticket?" }));
    expect(act).toHaveBeenCalledWith({ action: "ticket-delete", id: "a" });
    const notice = await screen.findByTestId("workforce-notice");
    expect(notice).toHaveTextContent('Removed "Ticket a".');
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    expect(act).toHaveBeenLastCalledWith({ action: "ticket-restore", id: "a" });
    expect(screen.queryByTestId("workforce-notice")).not.toBeInTheDocument();
  });

  it("says nothing was removed when the request failed", async () => {
    const act = vi.fn(async () => undefined);
    render(<WorkforceView hub={hub({ workTickets: [ticket("a")] })} act={act} onOpenTask={() => {}} openTicketId="a" />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete this ticket?" }));
    await waitFor(() => expect(act).toHaveBeenCalled());
    expect(screen.queryByTestId("workforce-notice")).not.toBeInTheDocument();
  });

  it("moves a ticket only when Move is clicked, and approves a reviewed one instead of moving it", async () => {
    const act = vi.fn(async () => hub({ workTickets: [ticket("a", { status: "done" })] }));
    render(<WorkforceView hub={hub({ workTickets: [ticket("a", { status: "review" })] })} act={act} onOpenTask={() => {}} openTicketId="a" />);
    const detail = screen.getByTestId("ticket-detail");
    const move = within(detail).getByRole("button", { name: "Move" });
    expect(move).toBeDisabled();
    fireEvent.change(within(detail).getByLabelText("Move to"), { target: { value: "done" } });
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(move);
    // Done from review goes through the review, so its checks are not skipped.
    expect(act).toHaveBeenCalledWith({ action: "ticket-review", id: "a", approve: true, note: "" });
    const notice = await screen.findByTestId("workforce-notice");
    expect(notice).toHaveTextContent('Moved "Ticket a" to Done.');
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    expect(act).toHaveBeenLastCalledWith({ action: "ticket-move", id: "a", status: "review" });
  });

  it("uses a plain move for other columns, and asks twice before a stopped ticket is called done", async () => {
    const act = vi.fn(async () => hub({ workTickets: [ticket("a", { status: "backlog" })] }));
    const { unmount } = render(<WorkforceView hub={hub({ workTickets: [ticket("a")] })} act={act} onOpenTask={() => {}} openTicketId="a" />);
    fireEvent.change(screen.getByLabelText("Move to"), { target: { value: "backlog" } });
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(act).toHaveBeenCalledWith({ action: "ticket-move", id: "a", status: "backlog" });
    unmount();

    act.mockClear();
    render(<WorkforceView hub={hub({ workTickets: [ticket("b", { status: "blocked" })] })} act={act} onOpenTask={() => {}} openTicketId="b" />);
    fireEvent.click(screen.getByRole("button", { name: "Mark done anyway" }));
    expect(act).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Mark it done?" }));
    expect(act).toHaveBeenCalledWith({ action: "ticket-review", id: "b", approve: true, note: "" });
  });

  it("says when a column is cut short and shows the rest when asked", () => {
    const done = Array.from({ length: 15 }, (_, i) => ticket(`d${i}`, { status: "done", updatedAt: i }));
    render(<WorkforceView hub={hub({ workTickets: done })} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
    const column = screen.getByTestId("column-done");
    expect(within(column).getAllByRole("article")).toHaveLength(12);
    fireEvent.click(within(column).getByRole("button", { name: "Show all (15)" }));
    expect(within(column).getAllByRole("article")).toHaveLength(15);
  });

  it("lists only runs of tickets and of the team in the run inspector, the open ticket's first", () => {
    const tasks = [
      { id: "chat", title: "A plain conversation", status: "completed", updatedAt: 9, messages: [], changes: [] },
      { id: "run-a", title: "Run of a", status: "completed", ticketId: "a", updatedAt: 1, messages: [], changes: [] },
      { id: "run-b", title: "Run of b", status: "completed", ticketId: "b", updatedAt: 5, messages: [], changes: [] },
    ] as unknown as HubSnapshot["tasks"];
    render(
      <WorkforceView
        hub={hub({ tasks, workTickets: [ticket("a", { taskId: "run-a" }), ticket("b", { taskId: "run-b" })] })}
        act={vi.fn(async () => undefined)}
        onOpenTask={() => {}}
        openTicketId="a"
      />,
    );
    fireEvent.click(screen.getByTestId("run-drawer-toggle"));
    const list = screen.getByTestId("run-drawer-list");
    expect(within(list).queryByTestId("run-drawer-task-chat")).not.toBeInTheDocument();
    expect(within(list).getByTestId("run-drawer-task-run-a")).toHaveAttribute("aria-pressed", "true");
    expect(within(list).getByTestId("run-drawer-task-run-b")).toHaveAttribute("aria-pressed", "false");
  });

  it("leads to the Agents & MCP view from where it is mentioned", () => {
    const opened = vi.fn();
    window.addEventListener("sshs3:ai-open", opened);
    render(<WorkforceView hub={hub({})} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
    fireEvent.click(screen.getByTestId("open-agents-view"));
    window.removeEventListener("sshs3:ai-open", opened);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: "Agents & MCP", mode: "hub" });
  });
});

describe("the confirm button", () => {
  it("counts down 10 seconds, pauses on hover, and cancels when Cancel is clicked", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(<ConfirmButton label="Delete" confirmLabel="Delete this ticket?" onConfirm={onConfirm} />);
    const btn = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(btn);
    expect(screen.getByTestId("confirm-countdown")).toHaveTextContent("(10)");
    reactAct(() => void vi.advanceTimersByTime(5100));
    expect(screen.getByTestId("confirm-countdown")).toHaveTextContent("(5)");

    // Hovering pauses the countdown so the operator can finish reading. A number that stands
    // still would promise a deadline that is not running, so none is shown meanwhile.
    fireEvent.mouseEnter(btn.parentElement!);
    reactAct(() => void vi.advanceTimersByTime(4000));
    expect(screen.queryByTestId("confirm-countdown")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete this ticket?" })).toBeVisible();
    fireEvent.mouseLeave(btn.parentElement!);
    expect(screen.getByTestId("confirm-countdown")).toHaveTextContent("(5)");

    // Clicking Cancel exits confirmation immediately without firing onConfirm.
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(screen.queryByTestId("confirm-countdown")).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();

    // Unhovered, it auto-reverts after 10 seconds.
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.mouseLeave(screen.getByRole("button", { name: "Delete this ticket?" }).parentElement!);
    reactAct(() => void vi.advanceTimersByTime(10_200));
    expect(screen.queryByTestId("confirm-countdown")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeVisible();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("tickets in the inbox", () => {
  const alerts = hub({
    workTickets: [
      ticket("k3", { title: "Alert: disk full", status: "backlog", assigneeAgentId: undefined, assigneeName: undefined, alert: { fingerprint: "f", source: "Alertmanager", severity: "critical", firstAt: 60, lastAt: 60, count: 1 } }),
      ticket("k4", { title: "Alert: has an agent", alert: { fingerprint: "g", source: "Alertmanager", severity: "warning", firstAt: 1, lastAt: 1, count: 1 } }),
    ],
  });

  it("opens an alert's ticket and acknowledges an alert with a button", () => {
    const act = vi.fn(async () => hub({}));
    const openTicket = vi.fn();
    render(<InboxView hub={alerts} act={act} onOpenTask={() => {}} onOpenView={() => {}} onOpenTicket={openTicket} />);
    const [unowned, owned] = screen.getAllByTestId("inbox-alert");
    fireEvent.click(within(owned).getByRole("button", { name: "Open ticket" }));
    expect(openTicket).toHaveBeenLastCalledWith("k4");
    expect(within(owned).queryByRole("button", { name: "Assign it" })).not.toBeInTheDocument();
    // Nobody has it yet: assigning is done on its ticket.
    fireEvent.click(within(unowned).getByRole("button", { name: "Assign it" }));
    expect(openTicket).toHaveBeenLastCalledWith("k3");
    fireEvent.click(within(owned).getByRole("button", { name: "Acknowledge" }));
    expect(act).toHaveBeenCalledWith({ action: "ack-inbox", itemId: "alert:k4", acknowledged: true });
  });

  it("needs the e key twice to mark a ticket done, and once to acknowledge an alert", () => {
    const act = vi.fn(async () => hub({}));
    const review = hub({ workTickets: [ticket("r", { status: "review", result: "Done." })] });
    const { unmount } = render(<InboxView hub={review} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    // Nothing is chosen yet: the key answers nothing.
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "e" });
    expect(screen.queryByTestId("inbox-done-arm")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "j" });
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "e" });
    expect(act).not.toHaveBeenCalled();
    expect(screen.getByTestId("inbox-done-arm")).toHaveTextContent("Press e again to mark it done");
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "e" });
    expect(act).toHaveBeenCalledWith({ action: "ticket-review", id: "r", approve: true, note: "" });
    expect(screen.queryByTestId("inbox-done-arm")).not.toBeInTheDocument();
    unmount();

    act.mockClear();
    render(<InboxView hub={alerts} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "j" });
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "e" });
    expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "ack-inbox", acknowledged: true }));
  });

  it("stops waiting for the second e after ten seconds", () => {
    vi.useFakeTimers();
    const act = vi.fn(async () => hub({}));
    render(<InboxView hub={hub({ workTickets: [ticket("r", { status: "review" })] })} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "j" });
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "e" });
    reactAct(() => void vi.advanceTimersByTime(5000));
    expect(screen.getByTestId("inbox-done-arm")).toBeInTheDocument();
    reactAct(() => void vi.advanceTimersByTime(5100));
    expect(screen.queryByTestId("inbox-done-arm")).not.toBeInTheDocument();
    expect(act).not.toHaveBeenCalled();
  });
});
