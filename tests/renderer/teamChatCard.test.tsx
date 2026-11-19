// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatConnectionView, HubRequest, HubSnapshot, WorkTicket } from "../../src/shared/types/aiHub";
import { TeamChatCard } from "../../src/renderer/src/components/AiHub/TeamChatCard";
import { WorkforceView } from "../../src/renderer/src/components/AiHub/WorkforceView";

afterEach(cleanup);

const slack: ChatConnectionView = {
  service: "slack",
  hasToken: true,
  enabled: true,
  bot: "sshs3-bot",
  workspace: "Acme",
  channels: [
    { id: "C1", name: "ops", private: false, selected: true, count: 1234, lastReadAt: Date.now() - 60_000, oldestAt: Date.parse("2026-08-15T00:00:00Z"), readingBack: false },
    { id: "C2", name: "incidents", private: true, selected: false, count: 0, readingBack: false },
  ],
};
const hub = (chatSources?: HubSnapshot["chatSources"], extra: Partial<HubSnapshot> = {}): HubSnapshot => ({ chatSources, ...extra }) as unknown as HubSnapshot;

describe("the team chat card", () => {
  it("says what the bot may read and what is kept, and never shows a stored token", () => {
    render(<TeamChatCard hub={hub({ connections: [slack], canChange: true, total: 1234 })} act={vi.fn(async () => undefined)} />);
    const card = screen.getByTestId("team-chat-card");
    expect(card).toHaveTextContent("The bot only reads, and only the channels chosen here; never direct messages.");
    expect(within(card).getByTestId("chat-slack")).toHaveTextContent("Slack · sshs3-bot, reading 1 channel");
    expect(within(card).getByTestId("chat-mattermost")).toHaveTextContent("Mattermost · not connected");
    const token = within(screen.getByTestId("chat-slack")).getByLabelText(/Bot token of the Slack app/);
    expect(token).toHaveValue("");
    expect(token).toHaveAttribute("placeholder", "Set. Leave empty to keep it.");
    expect(screen.getByTestId("team-chat-kept")).toHaveTextContent("It is kept until you remove it, also when a message is later edited or deleted in the chat");
    const channels = within(screen.getByTestId("chat-slack-channels"));
    expect(channels.getByText((text) => text.includes(new Intl.NumberFormat().format(1234).replace(/\s/g, " ") + " messages kept"))).toBeInTheDocument();
    expect(channels.getByLabelText("Read #ops")).toBeChecked();
    expect(channels.getByLabelText("Read #incidents")).not.toBeChecked();
  });

  it("connects, chooses a channel, and tries a search an agent would make", async () => {
    const sent: HubRequest[] = [];
    const act = vi.fn(async (request: HubRequest) => {
      sent.push(request);
      if (request.action === "chat-source-test") return { reply: { chatTest: { ok: true, bot: "sshs3-bot", workspace: "Acme", channels: 2 } } } as HubSnapshot;
      if (request.action === "chat-search")
        return {
          reply: {
            chatSearch: {
              query: request.query,
              hits: [{ service: "slack", channelId: "C1", channel: "ops", threadId: "t1", at: Date.parse("2026-11-10T08:00:00Z"), link: "https://acme.slack.com/archives/C1/p1", total: 4, messages: [{ id: "1", at: 1, author: "Sara", text: "restarted pgbouncer", link: "" }] }],
            },
          },
        } as HubSnapshot;
      if (request.action === "chat-thread-to-kb") return { reply: { ingest: { added: ["x"], duplicates: [], failed: [] } } } as unknown as HubSnapshot;
      return {} as HubSnapshot;
    });
    const view = render(<TeamChatCard hub={hub({ connections: [], canChange: true, total: 0 })} act={act} />);
    const fold = screen.getByTestId("chat-slack");
    fireEvent.change(within(fold).getByLabelText(/Bot token of the Slack app/), { target: { value: " xoxb-new " } });
    fireEvent.click(within(fold).getByRole("button", { name: "Connect", hidden: true }));
    await waitFor(() => expect(within(fold).getByTestId("chat-slack-said")).toHaveTextContent("Signed in as sshs3-bot in Acme. The bot is in 2 channels: choose below which to read."));
    expect(sent.slice(0, 2)).toEqual([
      { action: "chat-source-save", connection: { service: "slack", baseUrl: undefined, token: "xoxb-new", enabled: true } },
      { action: "chat-source-test", service: "slack" },
    ]);

    view.rerender(<TeamChatCard hub={hub({ connections: [slack], canChange: true, total: 1234 })} act={act} />);
    fireEvent.click(screen.getByLabelText("Read #incidents"));
    await waitFor(() => expect(sent).toContainEqual({ action: "chat-channel-select", service: "slack", channelId: "C2", selected: true }));

    fireEvent.change(screen.getByLabelText("Search the team's chat"), { target: { value: "pgbouncer" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const found = await screen.findByTestId("team-chat-found");
    expect(found).toHaveTextContent("#ops");
    expect(found).toHaveTextContent("Sara: restarted pgbouncer");
    expect(found).toHaveTextContent("4 messages in the thread");
    expect(within(found).getByRole("link", { name: "Open in Slack" })).toHaveAttribute("href", "https://acme.slack.com/archives/C1/p1");
    fireEvent.click(within(found).getByRole("button", { name: "Make a source of this thread" }));
    await waitFor(() => expect(within(found).getByRole("button", { name: "Added to the knowledge base." })).toBeDisabled());
    expect(sent).toContainEqual({ action: "chat-thread-to-kb", service: "slack", channelId: "C1", threadId: "t1" });
  });

  it("is read-only for a member of a shared server", () => {
    render(<TeamChatCard hub={hub({ connections: [slack], canChange: false, total: 1234 })} act={vi.fn(async () => undefined)} />);
    expect(screen.getByTestId("team-chat-card")).toHaveTextContent("The bot is the team's: an administrator of this server sets it up and chooses the channels.");
    expect(screen.getByLabelText("Read #ops")).toBeDisabled();
    expect(screen.queryByLabelText("Days to keep messages")).toBeNull();
    // Searching what was read is not a change: a member may.
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  });
});

describe("a ticket with what was said in chat", () => {
  it("shows the excerpts with a link to the thread, as what people wrote", () => {
    const ticket: WorkTicket = {
      id: "t1",
      title: "Alert: Replication lag on pg-01",
      description: "",
      status: "backlog",
      createdBy: "Alertmanager",
      createdAt: 1,
      updatedAt: 1,
      chatRefs: [{ service: "slack", channelId: "C1", channel: "ops", threadId: "th", at: Date.parse("2026-11-10T08:00:00Z"), link: "https://acme.slack.com/archives/C1/p9", excerpt: "Sara: pg-01 is lagging again\nErik: restarted pgbouncer, fixed" }],
    };
    const snapshot = { tasks: [], sessions: [], agents: [], workGoals: [], workTickets: [ticket], agentUsage: {}, workforceTemplates: [], workBoardSync: { shared: false }, preferences: {} } as unknown as HubSnapshot;
    render(<WorkforceView hub={snapshot} act={vi.fn(async () => undefined)} onOpenTask={() => {}} />);
    fireEvent.click(screen.getByText("Alert: Replication lag on pg-01"));
    const said = screen.getByTestId("ticket-chat");
    expect(said).toHaveTextContent("Said in chat (what people wrote about this lately; not checked)");
    expect(said).toHaveTextContent("Erik: restarted pgbouncer, fixed");
    expect(within(said).getByRole("link", { name: "Open in Slack" })).toHaveAttribute("href", "https://acme.slack.com/archives/C1/p9");
  });
});
