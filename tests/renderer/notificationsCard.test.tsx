// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { NotificationsCard } from "../../src/renderer/src/components/AiHub/NotificationsCard";
import { InboxView } from "../../src/renderer/src/components/AiHub/InboxView";

afterEach(cleanup);

const hub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    tasks: [],
    agents: [],
    preferences: {},
    notifications: {
      channels: [
        { id: "c1", kind: "slack", name: "#ops", host: "hooks.slack.com", hasSecret: false, enabled: true, events: ["approval", "alert"], includeCommand: false, last: { at: Date.now() - 120_000, ok: false, status: 404, error: "The channel answered 404" } },
      ],
      publicUrl: "",
      publicUrlFixed: false,
      reminderMinutes: 5,
    },
    ...extra,
  }) as unknown as HubSnapshot;

describe("notification channels", () => {
  it("shows a channel by its host only, with how the last delivery went, and tests it", async () => {
    const act = vi.fn(async (request: HubRequest) => ({ ...hub(), reply: request.action === "notify-channel-test" ? { notifyTest: { ok: false, status: 404, error: "The channel answered 404" } } : undefined }) as HubSnapshot);
    render(<NotificationsCard hub={hub()} act={act} />);
    const row = screen.getByTestId("notify-channel-c1");
    expect(row).toHaveTextContent("#ops");
    expect(row).toHaveTextContent("hooks.slack.com");
    expect(row).toHaveTextContent("2 kinds of event · without command text");
    expect(row).toHaveTextContent("last attempt failed 2 min ago: The channel answered 404");

    fireEvent.click(within(row).getByRole("button", { name: "Send a test" }));
    expect(act).toHaveBeenCalledWith({ action: "notify-channel-test", id: "c1" });
    await waitFor(() => expect(within(row).getByRole("status")).toHaveTextContent("Not delivered: The channel answered 404"));
  });

  it("adds a channel with its address, and keeps the address when an existing one is edited", async () => {
    const act = vi.fn(async () => hub());
    render(<NotificationsCard hub={hub()} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a channel" }));
    const editor = screen.getByTestId("notify-editor");
    expect(within(editor).getByRole("button", { name: "Add channel" })).toBeDisabled();
    fireEvent.change(within(editor).getByLabelText("Kind of channel"), { target: { value: "ntfy" } });
    fireEvent.change(within(editor).getByLabelText("Channel name"), { target: { value: "My phone" } });
    fireEvent.change(within(editor).getByLabelText("Channel address"), { target: { value: " https://ntfy.sh/a-topic " } });
    expect(within(editor).getByLabelText("Channel address")).toHaveAttribute("type", "password");
    fireEvent.click(within(editor).getByLabelText("The daily report"));
    fireEvent.click(within(editor).getByRole("button", { name: "Add channel" }));
    expect(act).toHaveBeenCalledWith({
      action: "notify-channel-save",
      channel: { id: undefined, kind: "ntfy", name: "My phone", url: "https://ntfy.sh/a-topic", secret: "", enabled: true, events: ["approval", "plan", "question", "blocked", "alert", "report"], includeCommand: true, alertMinSeverity: undefined },
    });
    await waitFor(() => expect(screen.queryByTestId("notify-editor")).not.toBeInTheDocument());

    fireEvent.click(within(screen.getByTestId("notify-channel-c1")).getByRole("button", { name: "Edit" }));
    const again = screen.getByTestId("notify-editor");
    expect(within(again).getByLabelText("Channel address")).toHaveAttribute("placeholder", "Kept (hooks.slack.com). Type a new one to change it.");
    fireEvent.change(within(again).getByLabelText("Lowest alert severity"), { target: { value: "critical" } });
    fireEvent.click(within(again).getByRole("button", { name: "Save channel" }));
    expect(act).toHaveBeenLastCalledWith({
      action: "notify-channel-save",
      channel: { id: "c1", kind: "slack", name: "#ops", url: undefined, secret: undefined, enabled: true, events: ["approval", "alert"], includeCommand: false, alertMinSeverity: "critical" },
    });
  });

  it("saves the address links point at, unless the administrator fixed it", async () => {
    const act = vi.fn(async () => hub());
    const { unmount } = render(<NotificationsCard hub={hub()} act={act} />);
    fireEvent.change(screen.getByLabelText("Public address"), { target: { value: "https://sshs3.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save address" }));
    expect(act).toHaveBeenCalledWith({ action: "notify-settings-save", publicUrl: "https://sshs3.example.com" });
    fireEvent.change(screen.getByLabelText("Reminder"), { target: { value: "10" } });
    expect(act).toHaveBeenLastCalledWith({ action: "notify-settings-save", reminderMinutes: 10 });
    unmount();

    render(<NotificationsCard hub={hub({ notifications: { channels: [], publicUrl: "https://team.example.com", publicUrlFixed: true, reminderMinutes: 0 } })} act={act} />);
    expect(screen.getByLabelText("Public address")).toBeDisabled();
    expect(screen.getByText("Set by the administrator (SSHS3_PUBLIC_URL).")).toBeInTheDocument();
    expect(screen.getByText(/No channel yet/)).toBeInTheDocument();
  });
});

describe("the item a notification pointed at", () => {
  const task = { id: "t1", title: "Fix", agentName: "DBA", status: "waiting", mode: "assisted", messages: [], sources: [], changes: [{ id: "c1", kind: "command", target: "pg-01", description: "Restart pgbouncer", command: "systemctl restart pgbouncer", status: "pending", riskLevel: "modify", at: Date.now() }] };

  it("is marked when it still waits, and said to be handled when it does not", () => {
    const { rerender } = render(<InboxView hub={hub({ tasks: [task] as never })} act={vi.fn()} onOpenTask={vi.fn()} onOpenView={vi.fn()} focusItemId="approval:c1" />);
    expect(screen.getByTestId("inbox-approval")).toHaveClass("ai-inbox-focus");
    expect(screen.getByTestId("inbox-approval")).toHaveTextContent("DBA on pg-01");
    expect(screen.queryByTestId("inbox-handled")).not.toBeInTheDocument();
    rerender(<InboxView hub={hub()} act={vi.fn()} onOpenTask={vi.fn()} onOpenView={vi.fn()} focusItemId="approval:c1" />);
    expect(screen.getByTestId("inbox-handled")).toHaveTextContent("no longer waits");
  });
});
