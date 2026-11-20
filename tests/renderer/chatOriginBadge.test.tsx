// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { AgentTask, ChatAnsweringSnapshot, ChatOrigin, HubSnapshot } from "../../src/shared/types/aiHub";
import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";
import { ChatOriginBadge } from "../../src/renderer/src/components/AiHub/ChatOriginBadge";

let fixture: HubSnapshot;
const request = vi.fn();
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => "",
  selectAiTerminal: () => {},
  hubRequest: (...args: unknown[]) => request(...args),
  onAiHubDelta: vi.fn(() => () => {}),
}));

const origin = (service: ChatOrigin["service"], kind: ChatOrigin["kind"]): ChatOrigin => ({
  service,
  channelId: kind === "dm" ? "D1" : "C1",
  channelName: kind === "dm" ? "" : "ops",
  threadId: "1.2",
  kind,
  askedBy: { chatUserId: "U1", name: "Lina", accountId: "u-lina" },
  fence: { servers: "*", clusters: [], reach: "ask" },
});

function task(id: string, title: string, chat?: ChatOrigin): AgentTask {
  return {
    id,
    title,
    mode: "assisted",
    status: "completed",
    createdAt: 1,
    updatedAt: 1,
    maxCommands: 20,
    maxMinutes: 15,
    verification: "not-verified",
    messages: [{ id: `${id}-u`, role: "user", text: title, at: 1 }],
    sources: [],
    changes: [],
    ...(chat ? { chat } : {}),
  } as AgentTask;
}

beforeEach(() => {
  request.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  fixture = {
    config: { enabled: true, provider: "openai-compatible", model: "local", useHermes: false, hasApiKey: false },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: true },
    sessions: [],
    tasks: [task("t-app", "Asked in the app"), task("t-dm", "Disk from Slack", origin("slack", "dm")), task("t-mm", "Load from Mattermost", origin("mattermost", "dm"))],
    inventory: [],
    memories: [],
    schedules: [],
  } as unknown as HubSnapshot;
  request.mockImplementation(async () => fixture);
});
afterEach(cleanup);

function Harness({ start = "panel" }: { start?: "panel" | "hub" }) {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">(start);
  return <AiHubPanel mode={mode} setMode={setMode} />;
}

describe("the from-chat badge", () => {
  it("marks only a direct message from chat, with its service", () => {
    const view = render(<ChatOriginBadge task={task("a", "x", origin("slack", "dm"))} />);
    expect(screen.getByTestId("chat-origin-badge")).toHaveTextContent("from Slack");
    view.rerender(<ChatOriginBadge task={task("b", "x", origin("mattermost", "dm"))} />);
    expect(screen.getByTestId("chat-origin-badge")).toHaveTextContent("from Mattermost");
    view.rerender(<ChatOriginBadge task={task("c", "x", origin("slack", "channel"))} />);
    expect(screen.queryByTestId("chat-origin-badge")).toBeNull();
    view.rerender(<ChatOriginBadge task={task("d", "x")} />);
    expect(screen.queryByTestId("chat-origin-badge")).toBeNull();
  });

  it("is shown in the conversation list and over the open conversation", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    const list = screen.getByLabelText("Conversation history");
    expect(within(within(list).getByRole("button", { name: /Disk from Slack/ })).getByTestId("chat-origin-badge")).toHaveTextContent("from Slack");
    expect(within(within(list).getByRole("button", { name: /Load from Mattermost/ })).getByTestId("chat-origin-badge")).toHaveTextContent("from Mattermost");
    expect(within(within(list).getByRole("button", { name: /Asked in the app/ })).queryByTestId("chat-origin-badge")).toBeNull();
    fireEvent.click(within(list).getByRole("button", { name: /Disk from Slack/ }));
    expect(within(screen.getByTestId("ai-task-context-bar")).getByTestId("chat-origin-badge")).toHaveTextContent("from Slack");
  });

  it("is shown in the full view's sidebar", () => {
    render(<Harness start="hub" />);
    const sidebar = screen.getByLabelText("Full view sidebar");
    expect(within(within(sidebar).getByRole("button", { name: /Disk from Slack/ })).getByTestId("chat-origin-badge")).toHaveTextContent("from Slack");
    expect(within(within(sidebar).getByRole("button", { name: /Asked in the app/ })).queryByTestId("chat-origin-badge")).toBeNull();
  });
});

const adminAnswering = (over: Partial<ChatAnsweringSnapshot> = {}): ChatAnsweringSnapshot => ({
  enabled: false,
  services: [],
  links: [],
  waiting: [],
  admin: {
    settings: {
      enabled: false,
      channels: { slack: [], mattermost: [] },
      dms: { enabled: false, unlinked: "off", servers: [], clusters: [] },
      limits: { personNewPerHour: 10, personMessagesPerHour: 30, channelPerHour: 30, concurrentRuns: 4 },
      monthlyTokenBudget: 2_000_000,
      approvalWaitMinutes: 60,
      usage: { month: "2026-11", tokens: 0 },
    },
    bots: [],
    status: {},
    linked: [],
    mattermostAnswers: "reactions",
    dataPolicy: [],
    canTry: true,
    agents: [],
    model: { set: true, name: "local" },
  },
  ...over,
});

describe("the agent bot in the panel", () => {
  it("counts a change from chat that waits for this person in the Inbox, and lists it there", async () => {
    fixture = {
      ...fixture,
      chatAnswering: adminAnswering({
        waiting: [
          { taskId: "t9", id: "c9", kind: "change", service: "slack", channelName: "ops", askedBy: "Omar", description: "Restart nginx", command: "sudo systemctl restart nginx", target: "web-1", risk: "modify", requiredApprovals: 1, approvedBy: [], at: 1 },
        ],
      }),
    } as HubSnapshot;
    render(<Harness start="hub" />);
    const inbox = within(screen.getByRole("navigation", { name: "Hub views" })).getByRole("button", { name: /Inbox/ });
    expect(inbox).toHaveTextContent("1");
    fireEvent.click(inbox);
    const waiting = await screen.findByTestId("inbox-chat-waiting");
    expect(waiting).toHaveTextContent("1 change from chat waits for your answer.");
    expect(waiting).toHaveTextContent("Restart nginx.");
    // The command on its own line, then the target, the risk and the approvals in plain words.
    expect(within(waiting).getByTestId("agent-chat-waiting-command")).toHaveTextContent("sudo systemctl restart nginx");
    expect(waiting).toHaveTextContent("On web-1. It changes something. No approvals yet. 1 needed.");
    expect(waiting).not.toHaveTextContent("0 of 1");
    expect(screen.queryByTestId("inbox-empty")).toBeNull();
    request.mockImplementation(async (r: { action: string }) => (r.action === "chat-answering-answer" ? { ...fixture, reply: { chatAnswer: { outcome: "approved", message: "Maria Ek approved." } } } : fixture));
    fireEvent.click(within(waiting).getByRole("button", { name: "Approve" }));
    expect(await within(waiting).findByRole("status")).toHaveTextContent("Maria Ek approved.");
    expect(request).toHaveBeenCalledWith({ action: "chat-answering-answer", taskId: "t9", id: "c9", kind: "change", approved: true });
  });

  it("shows the server's refusal next to the agent bot's form, through the settings", async () => {
    const refusal = "That is the context bot's token. The agent bot needs a Slack app of its own, so the context bot stays one that only reads.";
    fixture = { ...fixture, chatAnswering: adminAnswering() } as HubSnapshot;
    request.mockImplementation(async (r: { action: string }) => {
      if (r.action === "chat-answering-connect") throw new Error(refusal);
      return fixture;
    });
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "AI settings" }));
    const fold = await screen.findByTestId("agent-bot-slack", undefined, { timeout: 5000 });
    fireEvent.change(within(fold).getByLabelText("Bot token of the agent bot's app"), { target: { value: "xoxb-context" } });
    fireEvent.change(within(fold).getByLabelText("App-level token"), { target: { value: "xapp-1" } });
    fireEvent.click(within(fold).getByRole("button", { name: "Connect" }));
    expect(await within(fold).findByRole("alert")).toHaveTextContent(refusal);
  });
});
