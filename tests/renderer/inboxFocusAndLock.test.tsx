// @vitest-environment jsdom
import { act as reactAct, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { InboxView, waitingChangeText } from "../../src/renderer/src/components/AiHub/InboxView";

afterEach(cleanup);

const now = Date.now();

const change = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: "command",
  description: `Restart ${id}`,
  command: `systemctl restart ${id}`,
  target: "web-01",
  status: "pending",
  at: now - 5_000,
  ...extra,
});

const makeHub = (changes: Record<string, unknown>[]): HubSnapshot =>
  ({
    config: { enabled: true },
    sessions: [],
    workTickets: [],
    kbFindings: [],
    agents: [],
    alertIntake: { canReceive: true, enabled: false, received: 0, rules: [] },
    tasks: changes.length
      ? [{ id: "t1", title: "Restart", status: "waiting", agentName: "Operator", updatedAt: now - 10_000, messages: [], changes }]
      : [],
  }) as unknown as HubSnapshot;

const sent = (act: ReturnType<typeof vi.fn>): HubRequest[] => act.mock.calls.map((c) => c[0] as HubRequest);

/** Stands in for the file list: it takes letters for its type-ahead and calls preventDefault. */
function FileListStandIn(): JSX.Element {
  const [typed, setTyped] = useState("");
  return (
    <div
      tabIndex={0}
      data-testid="file-list"
      onKeyDown={(e) => {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          setTyped(typed + e.key);
        }
      }}
    >
      {typed}
    </div>
  );
}

describe("Inbox keys act only inside the Inbox, and only on the chosen item", () => {
  it("a letter typed elsewhere in the window approves and dismisses nothing", () => {
    const act = vi.fn(async () => undefined);
    const hub = makeHub([change("c1")]);
    // The item a notification pointed at is chosen from the start: the worst case for a stray key.
    render(
      <div>
        <FileListStandIn />
        <button type="button">Somewhere else</button>
        <InboxView hub={hub} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} focusItemId="approval:c1" />
      </div>,
    );
    const list = screen.getByTestId("file-list");
    list.focus();
    for (const key of ["a", "e", "h", "o", "j", "?"]) fireEvent.keyDown(list, { key });
    expect(list.textContent).toBe("aehoj?");
    const elsewhere = screen.getByRole("button", { name: "Somewhere else" });
    elsewhere.focus();
    for (const key of ["a", "e"]) fireEvent.keyDown(elsewhere, { key });
    for (const key of ["a", "e"]) fireEvent.keyDown(document.body, { key });
    for (const key of ["a", "e"]) fireEvent.keyDown(window, { key });
    expect(sent(act)).toEqual([]);
    expect(screen.queryByTestId("inbox-shortcuts")).toBeNull();
  });

  it("with the focus in the Inbox and nothing chosen, a key answers no item", () => {
    const act = vi.fn(async () => undefined);
    const onOpenTask = vi.fn();
    render(<InboxView hub={makeHub([change("c1")])} act={act} onOpenTask={onOpenTask} onOpenView={vi.fn()} />);
    const inbox = screen.getByTestId("inbox-view");
    inbox.focus();
    expect(inbox).toHaveFocus();
    for (const key of ["a", "e", "o", "h", "Enter"]) fireEvent.keyDown(inbox, { key });
    expect(sent(act)).toEqual([]);
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(screen.queryByTestId("inbox-snooze-menu-approval:c1")).toBeNull();

    // Choosing it first is what makes the key an answer.
    fireEvent.keyDown(inbox, { key: "j" });
    expect(screen.getByTestId("inbox-approval")).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(inbox, { key: "a" });
    expect(sent(act)).toEqual([{ action: "approve", taskId: "t1", changeId: "c1", approved: true }]);
  });

  it("ignores a key that another control inside it already took, and a held key", () => {
    const act = vi.fn(async () => undefined);
    render(<InboxView hub={makeHub([change("c1")])} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} focusItemId="approval:c1" />);
    const inbox = screen.getByTestId("inbox-view");
    const item = screen.getByTestId("inbox-approval");
    item.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    fireEvent.keyDown(item, { key: "a" });
    expect(sent(act)).toEqual([]);
    fireEvent.keyDown(inbox, { key: "a", repeat: true });
    expect(sent(act)).toEqual([]);
    fireEvent.keyDown(inbox, { key: "a" });
    expect(sent(act)).toHaveLength(1);
  });

  it("chooses nothing when the chosen item went away by itself, and moves on after the person's own answer", async () => {
    const act = vi.fn(async () => undefined);
    const two = makeHub([change("c1"), change("c2")]);
    const view = render(<InboxView hub={two} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    const inbox = screen.getByTestId("inbox-view");
    fireEvent.keyDown(inbox, { key: "j" });
    expect(screen.getAllByTestId("inbox-approval")[0]).toHaveAttribute("data-selected", "true");
    // Somebody else answered c1: the next key must not land on c2.
    view.rerender(<InboxView hub={makeHub([change("c2")])} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    expect(screen.getByTestId("inbox-approval")).not.toHaveAttribute("data-selected");
    fireEvent.keyDown(inbox, { key: "a" });
    expect(sent(act)).toEqual([]);

    // The person's own answer: the selection moves to what is left.
    view.rerender(<InboxView hub={two} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    fireEvent.keyDown(inbox, { key: "j" });
    fireEvent.keyDown(inbox, { key: "a" });
    await waitFor(() => expect(sent(act)).toHaveLength(1));
    view.rerender(<InboxView hub={makeHub([change("c2")])} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    expect(screen.getByTestId("inbox-approval")).toHaveAttribute("data-selected", "true");
  });
});

describe("Inbox Approve", () => {
  it("sends one request for a double click, and is locked while the request is out", async () => {
    let finish: (() => void) | undefined;
    const act = vi.fn(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    render(<InboxView hub={makeHub([change("c1")])} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(sent(act)).toHaveLength(1);
    expect(approve).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    // The key is held back by the same lock.
    fireEvent.click(screen.getByTestId("inbox-approval"));
    fireEvent.keyDown(screen.getByTestId("inbox-view"), { key: "a" });
    expect(sent(act)).toHaveLength(1);
    await reactAct(async () => finish?.());
    await waitFor(() => expect(approve).toBeEnabled());
  });

  it("opens a long change first: the first press shows all of it, the next one approves", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `echo step ${i + 1}`);
    const act = vi.fn(async () => undefined);
    render(<InboxView hub={makeHub([change("c1", { command: lines.join("\n") })])} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    const text = screen.getByTestId("inbox-change-text-c1");
    expect(text).toHaveTextContent("echo step 12");
    expect(text).not.toHaveTextContent("echo step 13");
    expect(screen.getByTestId("inbox-change-toggle-c1")).toHaveTextContent("Show all 30 lines");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent(act)).toEqual([]);
    expect(text).toHaveTextContent("echo step 30");
    expect(screen.getByTestId("inbox-read-first")).toHaveTextContent("Read it, then press Approve again.");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent(act)).toEqual([{ action: "approve", taskId: "t1", changeId: "c1", approved: true }]));
  });

  it("the a key opens a long change first too, and a short one is approved at once", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `echo step ${i + 1}`);
    const act = vi.fn(async () => undefined);
    render(
      <InboxView
        hub={makeHub([change("c1", { command: lines.join("\n") }), change("c2")])}
        act={act}
        onOpenTask={vi.fn()}
        onOpenView={vi.fn()}
      />,
    );
    const inbox = screen.getByTestId("inbox-view");
    fireEvent.keyDown(inbox, { key: "j" });
    fireEvent.keyDown(inbox, { key: "a" });
    expect(sent(act)).toEqual([]);
    expect(screen.getByTestId("inbox-change-text-c1")).toHaveTextContent("echo step 30");
    fireEvent.keyDown(inbox, { key: "a" });
    expect(sent(act)).toEqual([{ action: "approve", taskId: "t1", changeId: "c1", approved: true }]);
    fireEvent.keyDown(inbox, { key: "j" });
    fireEvent.keyDown(inbox, { key: "a" });
    expect(sent(act)[1]).toEqual({ action: "approve", taskId: "t1", changeId: "c2", approved: true });
  });

  it("shows a file change that came without a diff only when opened, and asks for that before approving", () => {
    const act = vi.fn(async () => undefined);
    const file = change("c1", { kind: "file", description: "Edit nginx.conf", command: undefined, before: "keepalive 60;\n", after: "keepalive 120;\n" });
    render(<InboxView hub={makeHub([file])} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    const item = screen.getByTestId("inbox-approval");
    expect(item).not.toHaveTextContent("keepalive 120");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent(act)).toEqual([]);
    expect(item).toHaveTextContent("keepalive 120");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent(act)).toHaveLength(1);
  });

  it("shows the check and the way back of a change whose command is its description", () => {
    const same = change("c1", { description: "systemctl restart nginx", command: "systemctl restart nginx", check: { command: "systemctl is-active nginx", expected: "active" }, rollback: { command: "systemctl stop nginx" } });
    render(<InboxView hub={makeHub([same])} act={vi.fn(async () => undefined)} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    expect(screen.getByText("systemctl is-active nginx")).toBeInTheDocument();
    expect(screen.getByText("systemctl stop nginx")).toBeInTheDocument();
  });
});

describe("waitingChangeText", () => {
  it("says a short command is shown whole and a long one is not", () => {
    expect(waitingChangeText("uptime", { kind: "command" }).long).toBe(false);
    const long = waitingChangeText(Array.from({ length: 13 }, (_, i) => `l${i}`).join("\n"), { kind: "command" });
    expect(long.long).toBe(true);
    expect(long.lineCount).toBe(13);
    expect(long.peek.split("\n")).toHaveLength(13);
    expect(long.peek.endsWith("…")).toBe(true);
  });
});

describe("the alert address", () => {
  it("is replaced only after the question is answered: the old address stops working", async () => {
    const act = vi.fn(async () => ({ reply: { alertHook: { path: "/api/hooks/u1.new" } } }) as unknown as HubSnapshot);
    const hub = { ...makeHub([]), alertIntake: { canReceive: true, enabled: true, received: 2, rules: [] } } as unknown as HubSnapshot;
    render(<InboxView hub={hub} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    fireEvent.click(screen.getByText(/^Alerts in/));
    fireEvent.click(screen.getByRole("button", { name: "Replace the address" }));
    expect(sent(act)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Replace it? The old address stops working." }));
    await waitFor(() => expect(sent(act)).toEqual([{ action: "alert-hook-create" }]));
    expect(await screen.findByTestId("alert-address")).toHaveValue(`${window.location.origin}/api/hooks/u1.new`);
  });

  it("is made with one click when there is none yet", async () => {
    const act = vi.fn(async () => ({ reply: { alertHook: { path: "/api/hooks/u1.first" } } }) as unknown as HubSnapshot);
    render(<InboxView hub={makeHub([])} act={act} onOpenTask={vi.fn()} onOpenView={vi.fn()} />);
    fireEvent.click(screen.getByText(/^Alerts in/));
    fireEvent.click(screen.getByRole("button", { name: "Create an address to post to" }));
    await waitFor(() => expect(sent(act)).toEqual([{ action: "alert-hook-create" }]));
  });
});
