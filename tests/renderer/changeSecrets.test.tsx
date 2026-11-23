// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { AgentChange, AgentTask, HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";
import { ChangeReveal, SECRETS_ELSEWHERE } from "../../src/renderer/src/components/AiHub/ChangeSecrets";
import { InboxView } from "../../src/renderer/src/components/AiHub/InboxView";

/**
 * A setting's secrets on its approval card: typed there and sent with the approval, and what a setting
 * made for the person alone shown there once. Other places that list the change send people to the card.
 */

let fixture: HubSnapshot;
const request = vi.fn();
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => "",
  selectAiTerminal: () => {},
  hubRequest: (...args: unknown[]) => request(...args),
  onAiHubDelta: vi.fn(() => () => {}),
}));

const TOKEN = "xoxb-typed-on-the-card"; // pragma: allowlist secret

const connect: AgentChange = {
  id: "c1",
  kind: "setting",
  guard: true,
  target: "sshs3",
  description: "Connect the agent bot, which answers people in chat",
  command: "service: slack",
  status: "pending",
  riskLevel: "modify",
  riskReason: "Changes the rules agents run under. Only a person can approve it.",
  secretFields: [
    { key: "token", label: "the agent bot's token", optional: true },
    { key: "appToken", label: "the Slack app-level token (xapp-)", optional: true },
  ],
  at: 2,
} as AgentChange;

function task(changes: AgentChange[], status: AgentTask["status"] = "waiting"): AgentTask {
  return {
    id: "t1",
    title: "Connect the agent bot to Slack",
    mode: "assisted",
    status,
    createdAt: 1,
    updatedAt: 2,
    maxCommands: 20,
    maxMinutes: 15,
    verification: "not-verified",
    messages: [{ id: "m1", role: "user", text: "Connect the agent bot to Slack", at: 1 }],
    sources: [],
    changes,
  } as AgentTask;
}

function snapshot(changes: AgentChange[], status?: AgentTask["status"]): HubSnapshot {
  return {
    config: { enabled: true, provider: "openai-compatible", model: "local", useHermes: false, hasApiKey: false },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: true },
    sessions: [],
    tasks: [task(changes, status)],
    inventory: [],
    memories: [],
    schedules: [],
  } as unknown as HubSnapshot;
}

beforeEach(() => {
  request.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  fixture = snapshot([connect]);
  request.mockImplementation(async () => fixture);
});
afterEach(cleanup);

function Panel() {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">("hub");
  return <AiHubPanel mode={mode} setMode={setMode} />;
}

const sent = (action: string): HubRequest[] => request.mock.calls.map((c) => c[0] as HubRequest).filter((r) => r.action === action);

describe("a setting that takes a token", () => {
  it("has a hidden field for each on its card in the conversation, and sends them with the approval", async () => {
    render(<Panel />);
    fireEvent.click(await screen.findByText("Connect the agent bot to Slack", { selector: "button *, button" }));
    const card = await screen.findByTestId("ai-change-secrets-c1");
    const token = within(card).getByLabelText("Type the agent bot's token");
    const appToken = within(card).getByLabelText("Type the Slack app-level token (xapp-)");
    // What is typed is hidden, and the browser is not asked to remember it.
    for (const field of [token, appToken]) {
      expect(field).toHaveAttribute("type", "password");
      expect(field).toHaveAttribute("autocomplete", "off");
    }
    expect(card).toHaveTextContent("It is not part of the conversation and is not sent to the model.");
    fireEvent.change(token, { target: { value: TOKEN } });
    fireEvent.change(appToken, { target: { value: "xapp-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent("approve")).toHaveLength(1));
    expect(sent("approve")[0]).toMatchObject({ action: "approve", taskId: "t1", changeId: "c1", approved: true, secrets: { token: TOKEN, appToken: "xapp-typed" } });
    // Once sent, the window keeps none of it.
    await waitFor(() => expect((screen.getByLabelText("Type the agent bot's token") as HTMLInputElement).value).toBe(""));
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("sends no secrets with a change that asks for none", async () => {
    fixture = snapshot([{ ...connect, secretFields: undefined, description: "Change how the agent bot answers in chat" }]);
    render(<Panel />);
    fireEvent.click(await screen.findByText("Connect the agent bot to Slack", { selector: "button *, button" }));
    expect(screen.queryByTestId("ai-change-secrets-c1")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(sent("approve")).toHaveLength(1));
    expect(sent("approve")[0]).not.toHaveProperty("secrets");
  });

  it("is answered in the conversation, not from the inbox", () => {
    const hub = {
      ...snapshot([connect]),
      inboxState: {},
    } as HubSnapshot;
    const act = vi.fn(async () => hub);
    render(<InboxView hub={hub} act={act} onOpenTask={() => {}} onOpenView={() => {}} />);
    expect(screen.getByTestId("ai-inbox-takes-secrets")).toHaveTextContent(SECRETS_ELSEWHERE);
    // The inbox can still say no, and open the conversation: it cannot say yes without the token.
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
  });
});

describe("a card that holds something to show", () => {
  const made = (shown?: boolean): AgentChange =>
    ({ ...connect, id: "c2", status: "completed", secretFields: undefined, description: "Make a key that lets another agent reach this app", reveal: { label: "The new key", ...(shown ? { shown } : {}) } }) as AgentChange;

  it("stays open in the conversation until the person has seen it", async () => {
    fixture = snapshot([made()], "completed");
    render(<Panel />);
    fireEvent.click(await screen.findByText("Connect the agent bot to Slack", { selector: "button *, button" }));
    // A finished change is folded away, but not one whose key nobody has copied yet.
    const button = await screen.findByRole("button", { name: "Show it once" });
    expect(button.closest("details")).toHaveAttribute("open");
  });

  it("stays open with the value in it after the person asked, though the change is then marked as shown", async () => {
    fixture = snapshot([made()], "completed");
    request.mockImplementation(async (r: HubRequest) => {
      if (r.action !== "change-reveal") return fixture;
      // As the server does: the change is marked shown in the same answer that carries the value.
      fixture = snapshot([made(true)], "completed");
      return { ...fixture, reply: { changeReveal: { label: "The new key", value: "sshs3_mcp_abc123" } } };
    });
    render(<Panel />);
    fireEvent.click(await screen.findByText("Connect the agent bot to Slack", { selector: "button *, button" }));
    fireEvent.click(await screen.findByRole("button", { name: "Show it once" }));
    const value = await screen.findByTestId("ai-change-reveal-value-c2");
    expect(value).toHaveTextContent("sshs3_mcp_abc123");
    // A card that folded away here would hide the key the moment it arrived.
    await waitFor(() => expect(screen.getByTestId("ai-change-reveal-value-c2").closest("details")).toHaveAttribute("open"));
    expect(screen.getByTestId("ai-change-reveal-value-c2")).toBeVisible();
  });

  it("folds away like any finished change once it was shown", async () => {
    fixture = snapshot([made(true)], "completed");
    render(<Panel />);
    fireEvent.click(await screen.findByText("Connect the agent bot to Slack", { selector: "button *, button" }));
    const note = await screen.findByText("The new key was shown once and is not kept.");
    expect(note.closest("details")).not.toHaveAttribute("open");
  });
});

describe("what a setting made for the person alone", () => {
  const made: AgentChange = { ...connect, id: "c2", status: "completed", secretFields: undefined, description: "Make a key that lets another agent reach this app", reveal: { label: "The new key" } } as AgentChange;

  it("is shown once when asked for, and can be copied", async () => {
    const act = vi.fn(async (r: HubRequest) => ({ reply: r.action === "change-reveal" ? { changeReveal: { label: "The new key", value: "sshs3_mcp_abc123" } } : undefined }) as HubSnapshot);
    render(<ChangeReveal taskId="t1" change={made} act={act} />);
    expect(screen.getByTestId("ai-change-reveal-c2")).toHaveTextContent("The agent in this conversation is not given it.");
    expect(document.body.innerHTML).not.toContain("sshs3_mcp_abc123");
    fireEvent.click(screen.getByRole("button", { name: "Show it once" }));
    expect(await screen.findByTestId("ai-change-reveal-value-c2")).toHaveTextContent("sshs3_mcp_abc123");
    expect(act).toHaveBeenCalledWith({ action: "change-reveal", taskId: "t1", changeId: "c2" });
    expect(screen.getByTestId("ai-change-reveal-c2")).toHaveTextContent("It is shown this once: copy it now.");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("says so when it is no longer kept, and does not offer it a second time", async () => {
    const act = vi.fn(async () => ({ reply: { changeReveal: { label: "The new key", value: "" } } }) as HubSnapshot);
    const view = render(<ChangeReveal taskId="t1" change={made} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Show it once" }));
    expect(await screen.findByText("It is no longer kept: it was shown already, or sshs3 restarted since. Make a new one.")).toBeInTheDocument();
    // A card opened again after it was shown has no button.
    view.unmount();
    render(<ChangeReveal taskId="t1" change={{ ...made, reveal: { label: "The new key", shown: true } }} act={act} />);
    expect(screen.queryByRole("button", { name: "Show it once" })).toBeNull();
    expect(screen.getByText("The new key was shown once and is not kept.")).toBeInTheDocument();
  });

  it("shows nothing on a change that made nothing", () => {
    const { container } = render(<ChangeReveal taskId="t1" change={{ ...made, reveal: undefined }} act={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
