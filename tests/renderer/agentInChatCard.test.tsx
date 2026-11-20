// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAnsweringSnapshot, ChatTaskView, HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { AGENT_BOT_SLACK_MANIFEST, AgentInChatCard, approvalsText, chatTextAsMarkdown } from "../../src/renderer/src/components/AiHub/AgentInChatCard";

afterEach(cleanup);

const NOW = Date.parse("2026-11-20T10:00:00Z");

function adminChat(over: Partial<NonNullable<ChatAnsweringSnapshot["admin"]>> = {}, top: Partial<ChatAnsweringSnapshot> = {}): ChatAnsweringSnapshot {
  return {
    enabled: false,
    services: ["slack"],
    links: [],
    waiting: [],
    admin: {
      settings: {
        enabled: false,
        channels: {
          slack: [{ channelId: "C1", channelName: "ops", servers: ["web-1"], clusters: [], reach: "ask", approvers: "linked", historyFrom: [] }],
          mattermost: [],
        },
        dms: { enabled: false, unlinked: "off", servers: [], clusters: [] },
        limits: { personNewPerHour: 10, personMessagesPerHour: 30, channelPerHour: 30, concurrentRuns: 4 },
        monthlyTokenBudget: 2_000_000,
        approvalWaitMinutes: 60,
        usage: { month: "2026-11", tokens: 12_345 },
        changedBy: "Maria",
        changedAt: NOW,
      },
      bots: [{ service: "slack", enabled: true, hasToken: true, hasAppToken: true, identity: { userId: "U9", name: "sshs3-agent", team: "Acme" }, savedAt: NOW }],
      status: { slack: { state: "waiting", error: "Slack did not answer", retryAt: NOW + 60_000 } },
      linked: [{ service: "slack", chatUserId: "U1", chatName: "lina", accountId: "u-lina", accountName: "Lina", linkedAt: NOW }],
      publicKey: "ssh-ed25519 AAAAC3Nza chat-agent",
      mattermostAnswers: "reactions",
      dataPolicy: [{ service: "slack", allowed: true, errors: [], warnings: [] }],
      canTry: true,
      agents: [{ id: "sre", name: "SRE agent" }],
      model: { set: true, name: "Team model (gpt-x)" },
      ...over,
    },
    ...top,
  };
}

const hub = (chatAnswering?: ChatAnsweringSnapshot, extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    chatAnswering,
    // The administrator's own agents: a channel row offers the chat agent's (admin.agents), never these.
    agents: [
      { id: "sre", name: "SRE agent" },
      { id: "mine", name: "My own agent" },
      { id: "claude-code", name: "External", runnerId: "claude" },
    ],
    chatSources: {
      canChange: true,
      total: 10,
      connections: [
        {
          service: "slack",
          hasToken: true,
          enabled: true,
          channels: [
            { id: "C1", name: "ops", private: false, selected: true, count: 5, readingBack: false },
            { id: "C2", name: "incidents", private: false, selected: true, count: 5, readingBack: false },
            { id: "C3", name: "random", private: false, selected: false, count: 0, readingBack: false },
          ],
        },
      ],
    },
    ...extra,
  }) as unknown as HubSnapshot;

function recorder(answer: (request: HubRequest) => Partial<HubSnapshot> | undefined = () => ({})) {
  const sent: HubRequest[] = [];
  const act = vi.fn(async (request: HubRequest) => {
    sent.push(request);
    const out = answer(request);
    return out === undefined ? undefined : (out as HubSnapshot);
  });
  return { sent, act };
}

describe("Agent in chat, for an administrator", () => {
  it("shows the status, the bot, what is only tested against stand-ins, and switches answering on", async () => {
    const { sent, act } = recorder();
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const card = screen.getByTestId("agent-in-chat-card");
    expect(card).toHaveTextContent("Agent in chat");
    expect(screen.getByTestId("agent-chat-stand-ins")).toHaveTextContent("tested only against stand-ins for Slack and Mattermost");
    const slack = screen.getByTestId("agent-bot-slack-status");
    expect(slack).toHaveTextContent("The agent bot is sshs3-agent in Acme.");
    expect(slack).toHaveTextContent("Waiting to try again");
    expect(slack).toHaveTextContent("Slack did not answer");
    expect(screen.getByTestId("agent-bot-mattermost")).toHaveTextContent("Mattermost · not connected");
    // After the "·" in a fold's title the state starts small, as "not connected" does.
    expect(screen.getByTestId("agent-bot-slack").querySelector("summary")).toHaveTextContent(/^Slack · waiting to try again/);
    fireEvent.click(screen.getByLabelText("Answer in chat"));
    await waitFor(() => expect(sent).toEqual([{ action: "chat-answering-save", input: { enabled: true } }]));
  });

  it("says when the data policy refuses answering", () => {
    render(
      <AgentInChatCard
        hub={hub(adminChat({ dataPolicy: [{ service: "slack", allowed: false, errors: ["The data policy keeps data in the EU, and Slack is not."], warnings: [] }] }))}
        act={recorder().act}
      />,
    );
    expect(screen.getByTestId("agent-chat-policy")).toHaveTextContent("does not let answers go to Slack (The data policy keeps data in the EU, and Slack is not.)");
  });

  it("connects the Slack app with both tokens, gives the manifest, and never shows a token", async () => {
    const { sent, act } = recorder((r) =>
      r.action === "chat-answering-connect" ? { reply: { chatAgentConnect: { service: "slack", bot: "sshs3-agent", team: "Acme", notes: [] } } } : {},
    );
    render(<AgentInChatCard hub={hub(adminChat({ bots: [], status: {} }))} act={act} />);
    const fold = screen.getByTestId("agent-bot-slack");
    expect(fold).toHaveTextContent("separate Slack app from the context bot");
    for (const scope of ["app_mentions:read", "chat:write", "im:history", "im:read", "im:write", "channels:read", "groups:read", "users:read"])
      expect(fold).toHaveTextContent(scope);
    // The manifest: Socket Mode, mentions and direct messages, buttons, and no scope that reads a channel's history.
    const manifest = JSON.parse(AGENT_BOT_SLACK_MANIFEST) as {
      settings: { socket_mode_enabled: boolean; interactivity: { is_enabled: boolean }; event_subscriptions: { bot_events: string[] } };
      oauth_config: { scopes: { bot: string[] } };
    };
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.interactivity.is_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(["app_mention", "message.im"]);
    expect(manifest.oauth_config.scopes.bot).not.toContain("channels:history");
    expect(manifest.oauth_config.scopes.bot).not.toContain("groups:history");
    expect(within(screen.getByTestId("agent-bot-manifest")).getByText(/socket_mode_enabled/)).toBeInTheDocument();

    const bot = within(fold).getByLabelText("Bot token of the agent bot's app");
    const app = within(fold).getByLabelText("App-level token");
    // Typed tokens are never shown on screen.
    expect(bot).toHaveAttribute("type", "password");
    expect(app).toHaveAttribute("type", "password");
    fireEvent.change(bot, { target: { value: " xoxb-secret-1 " } });
    fireEvent.change(app, { target: { value: "xapp-secret-2" } });
    fireEvent.click(within(fold).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByTestId("agent-bot-slack-said")).toHaveTextContent("Connected as sshs3-agent in Acme."));
    expect(sent).toEqual([{ action: "chat-answering-connect", input: { service: "slack", token: "xoxb-secret-1", appToken: "xapp-secret-2", enabled: true } }]);
    expect(bot).toHaveValue("");
    expect(app).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("secret-1");
    expect(document.body.innerHTML).not.toContain("secret-2");
  });

  it("keeps saved tokens hidden and connects Mattermost with the address", async () => {
    const { sent, act } = recorder(() => ({ reply: { chatAgentConnect: { service: "mattermost", bot: "agent", notes: ["Mattermost cards are answered with reactions."] } } }));
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const slackToken = within(screen.getByTestId("agent-bot-slack")).getByLabelText("Bot token of the agent bot's app");
    expect(slackToken).toHaveValue("");
    expect(slackToken).toHaveAttribute("placeholder", "Set. Leave empty to keep it.");
    const fold = screen.getByTestId("agent-bot-mattermost");
    fireEvent.change(within(fold).getByLabelText("Address of the Mattermost server"), { target: { value: "https://chat.example.com" } });
    expect(within(fold).getByLabelText("Access token of the agent bot's account")).toHaveAttribute("type", "password");
    fireEvent.change(within(fold).getByLabelText("Access token of the agent bot's account"), { target: { value: "abc123token" } });
    fireEvent.click(within(fold).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByTestId("agent-bot-mattermost-said")).toHaveTextContent("Mattermost cards are answered with reactions."));
    expect(sent).toEqual([{ action: "chat-answering-connect", input: { service: "mattermost", token: "abc123token", baseUrl: "https://chat.example.com", enabled: true } }]);
    expect(document.body.innerHTML).not.toContain("abc123token");
  });

  it("shows the server's refusal of the context bot's token next to the form", async () => {
    const refusal = "That is the context bot's token. The agent bot needs a Slack app of its own, so the context bot stays one that only reads.";
    function Harness(): JSX.Element {
      const [error, setError] = useState("");
      const act = async (request: HubRequest): Promise<HubSnapshot | undefined> => {
        setError("");
        if (request.action === "chat-answering-connect") {
          setError(refusal);
          return undefined;
        }
        return {} as HubSnapshot;
      };
      return <AgentInChatCard hub={hub(adminChat({ bots: [], status: {} }))} act={act} error={error} />;
    }
    render(<Harness />);
    const fold = screen.getByTestId("agent-bot-slack");
    fireEvent.change(within(fold).getByLabelText("Bot token of the agent bot's app"), { target: { value: "xoxb-context" } });
    fireEvent.change(within(fold).getByLabelText("App-level token"), { target: { value: "xapp-1" } });
    fireEvent.click(within(fold).getByRole("button", { name: "Connect" }));
    expect(await within(fold).findByRole("alert")).toHaveTextContent(refusal);
    expect(within(fold).getByLabelText("Bot token of the agent bot's app")).toHaveValue("");
  });

  it("disconnects after a confirm", async () => {
    const { sent, act } = recorder();
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const fold = screen.getByTestId("agent-bot-slack");
    fireEvent.click(within(fold).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(fold).getByRole("button", { name: "Disconnect the agent bot from Slack?" }));
    await waitFor(() => expect(sent).toEqual([{ action: "chat-answering-disconnect", service: "slack" }]));
  });

  it("edits, adds and removes channel rows and saves them whole", async () => {
    const { sent, act } = recorder();
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const rows = screen.getByTestId("agent-chat-channels");
    const ops = within(rows).getByTestId("agent-chat-row-C1");
    fireEvent.change(within(ops).getByLabelText("Reach for #ops"), { target: { value: "plan" } });
    fireEvent.change(within(ops).getByLabelText("Who may approve in #ops"), { target: { value: "admins" } });
    fireEvent.change(within(ops).getByLabelText("Agent for #ops"), { target: { value: "sre" } });
    fireEvent.change(within(ops).getByLabelText("Clusters for #ops"), { target: { value: "staging, prod-eu" } });
    // Only the chat agent's own agents are offered: not an external one, nor one the administrator made.
    expect(within(within(ops).getByLabelText("Agent for #ops")).queryByText("External")).toBeNull();
    expect(within(within(ops).getByLabelText("Agent for #ops")).queryByText("My own agent")).toBeNull();
    expect(within(within(ops).getByLabelText("Agent for #ops")).getByText("SRE agent")).toBeInTheDocument();
    // Who may approve says what is true: an answer in the app needs no link.
    expect(within(within(ops).getByLabelText("Who may approve in #ops")).getByText("Anyone who may approve it")).toBeInTheDocument();
    expect(ops).toHaveTextContent("In chat, only people who linked their chat account can answer. Each person can approve only what their own account may approve.");
    // Only the context bot's channels are offered to search, and not this one itself.
    expect(within(ops).queryByLabelText("#ops may search #random")).toBeNull();
    expect(within(ops).queryByLabelText("#ops may search #ops")).toBeNull();
    fireEvent.click(within(ops).getByLabelText("#ops may search #incidents"));

    fireEvent.change(within(rows).getByLabelText("Channel id"), { target: { value: "C7" } });
    fireEvent.change(within(rows).getByLabelText("Channel name"), { target: { value: "#db" } });
    fireEvent.click(within(rows).getByRole("button", { name: "Add the channel" }));
    const db = within(rows).getByTestId("agent-chat-row-C7");
    fireEvent.click(within(db).getByLabelText("All servers for #db"));

    fireEvent.click(within(rows).getByRole("button", { name: "Save the channels" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      action: "chat-answering-save",
      input: {
        channels: {
          slack: [
            { channelId: "C1", channelName: "ops", servers: ["web-1"], clusters: ["staging", "prod-eu"], reach: "plan", agentId: "sre", approvers: "admins", historyFrom: ["C1", "C2"] },
            { channelId: "C7", channelName: "db", servers: "*", clusters: [], reach: "read", approvers: "linked", historyFrom: [] },
          ],
          mattermost: [],
        },
      },
    });

    fireEvent.click(within(ops).getByRole("button", { name: "Remove #ops" }));
    fireEvent.click(within(rows).getByRole("button", { name: "Save the channels" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({
      action: "chat-answering-save",
      input: { channels: { slack: [{ channelId: "C7", channelName: "db", servers: "*", clusters: [], reach: "read", approvers: "linked", historyFrom: [] }], mattermost: [] } },
    });
  });

  it("saves direct messages", async () => {
    const { sent, act } = recorder();
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const dms = screen.getByTestId("agent-chat-dms");
    fireEvent.click(within(dms).getByLabelText("Answer direct messages"));
    fireEvent.change(within(dms).getByLabelText("Direct messages from people who did not link"), { target: { value: "read" } });
    fireEvent.change(within(dms).getByLabelText("Servers for direct messages"), { target: { value: "web-1, web-2" } });
    fireEvent.change(within(dms).getByLabelText("Clusters for direct messages"), { target: { value: "staging" } });
    fireEvent.click(within(dms).getByRole("button", { name: "Save direct messages" }));
    await waitFor(() =>
      expect(sent).toEqual([{ action: "chat-answering-save", input: { dms: { enabled: true, unlinked: "read", servers: ["web-1", "web-2"], clusters: ["staging"] } } }]),
    );
  });

  it("copies the model, and saves the wait, the budget and the limits", async () => {
    const { sent, act } = recorder((r) => (r.action === "chat-answering-copy-model" ? { reply: { notes: ["The chat agent now uses the same model settings as you."] } } : {}));
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const model = screen.getByTestId("agent-chat-model");
    // The month as people say it, not as it is stored ("2026-11").
    expect(screen.getByTestId("agent-chat-usage")).toHaveTextContent(`Used in November 2026: ${(12_345).toLocaleString()} of ${(2_000_000).toLocaleString()} tokens`);
    fireEvent.click(within(model).getByRole("button", { name: "Copy my model" }));
    await waitFor(() => expect(screen.getByTestId("agent-chat-model-said")).toHaveTextContent("same model settings as you"));
    fireEvent.change(within(model).getByLabelText("Approval wait in minutes"), { target: { value: "30" } });
    fireEvent.change(within(model).getByLabelText("Monthly token budget"), { target: { value: "500000" } });
    fireEvent.change(within(model).getByLabelText("Answers worked on at the same time"), { target: { value: "2" } });
    fireEvent.click(within(model).getByRole("button", { name: "Save the wait, budget and limits" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { action: "chat-answering-copy-model" },
      {
        action: "chat-answering-save",
        input: { approvalWaitMinutes: 30, monthlyTokenBudget: 500000, limits: { personNewPerHour: 10, personMessagesPerHour: 30, channelPerHour: 30, concurrentRuns: 2 } },
      },
    ]);
  });

  it("shows the bot's SSH key with where to put it, and makes a new one after a confirm", async () => {
    const { sent, act } = recorder(() => ({ reply: { chatAgentKey: { publicKey: "ssh-ed25519 BBBB new-key" } } }));
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const key = screen.getByTestId("agent-chat-key");
    expect(key).toHaveTextContent("Add it only on the servers the agent bot may reach");
    expect(screen.getByTestId("agent-chat-public-key")).toHaveTextContent("ssh-ed25519 AAAAC3Nza chat-agent");
    fireEvent.click(within(key).getByRole("button", { name: "Make a new key" }));
    fireEvent.click(within(key).getByRole("button", { name: /Make a new key\? The old one/ }));
    await waitFor(() => expect(screen.getByTestId("agent-chat-public-key")).toHaveTextContent("ssh-ed25519 BBBB new-key"));
    expect(sent).toEqual([{ action: "chat-answering-rotate-key" }]);
  });

  it("says how Mattermost cards are answered", () => {
    const view = render(<AgentInChatCard hub={hub(adminChat())} act={recorder().act} />);
    const text = screen.getByTestId("agent-chat-mattermost-answers");
    expect(text).toHaveTextContent("answered with reactions: ✅ to approve, ❌ to deny");
    expect(text).toHaveTextContent("SSHS3_PUBLIC_URL and SSHS3_MATTERMOST_ACTION_FROM");
    expect(text).toHaveTextContent("Behind a reverse proxy");
    view.rerender(<AgentInChatCard hub={hub(adminChat({ mattermostAnswers: "buttons" }))} act={recorder().act} />);
    expect(screen.getByTestId("agent-chat-mattermost-answers")).toHaveTextContent("Mattermost cards have Approve and Deny buttons");
  });

  it("lists linked people and unlinks one", async () => {
    const { sent, act } = recorder();
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const linked = screen.getByTestId("agent-chat-linked");
    expect(linked).toHaveTextContent("lina in Slack is Lina, linked");
    fireEvent.click(within(linked).getByRole("button", { name: "Unlink lina" }));
    fireEvent.click(within(linked).getByRole("button", { name: "Unlink lina?" }));
    await waitFor(() => expect(sent).toEqual([{ action: "chat-unlink", service: "slack", chatUserId: "U1" }]));
  });

  it("reads conversations from chat and approves a waiting change and plan there", async () => {
    const task: ChatTaskView = {
      taskId: "t1",
      title: "Disk on web-1",
      status: "waiting",
      chat: {
        service: "slack",
        channelId: "C1",
        channelName: "ops",
        threadId: "1.2",
        kind: "channel",
        askedBy: { chatUserId: "U2", name: "Omar" },
        fence: { servers: ["web-1"], clusters: [], reach: "ask" },
      },
      messages: [
        {
          id: "m1",
          role: "user",
          text: "clean the tmp folder on web-1",
          told: "Omar asked you in #ops on Slack. Your answer is posted in that thread, so keep it short and plain.",
          at: NOW,
        },
        { id: "m2", role: "assistant", text: "I will remove old files.", at: NOW },
      ],
      changes: [
        { id: "c1", kind: "command", target: "web-1", description: "Remove old files in /tmp", command: "find /tmp -mtime +7 -delete", status: "pending", riskLevel: "destructive", requiredApprovals: 1 } as ChatTaskView["changes"][number],
      ],
      plan: { id: "p1", goal: "Free disk space", steps: [{ action: "Remove old files", risk: "low", check: "df -h" }], status: "proposed", revision: 1, review: { verdict: "approve", findings: [] }, createdAt: NOW },
    };
    const { sent, act } = recorder((r) => {
      if (r.action === "chat-answering-runs")
        return {
          reply: {
            chatRuns: [{ taskId: "t1", title: "Disk on web-1", status: "waiting", service: "slack", channelId: "C1", channelName: "ops", kind: "channel", threadId: "1.2", askedBy: "Omar", reach: "ask", waiting: 2, createdAt: NOW, updatedAt: NOW }],
          },
        };
      if (r.action === "chat-answering-task") return { reply: { chatTask: task } };
      if (r.action === "chat-answering-answer") return { reply: { chatAnswer: { outcome: "approved", message: "Approved. It runs now." } } };
      return {};
    });
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const runs = screen.getByTestId("agent-chat-runs");
    fireEvent.click(within(runs).getByRole("button", { name: "Show the conversations" }));
    fireEvent.click(await within(runs).findByRole("button", { name: "Open Disk on web-1" }));
    expect(within(runs).getByText(/asked by Omar/)).toBeInTheDocument();
    // What waits is said once, plainly.
    const line = within(runs).getByTestId("agent-chat-run-line");
    expect(line).toHaveTextContent("Waiting for 2 answers");
    expect(line).not.toHaveTextContent("waiting ·");
    const open = await screen.findByTestId("agent-chat-task");
    expect(within(open).getByTestId("agent-chat-task-status")).toHaveTextContent("Status: Waiting.");
    // The person's question is what was asked; what the agent was told is folded away under it.
    const asked = within(open).getByTestId("agent-chat-message-user");
    expect(asked.querySelector("blockquote")).toHaveTextContent(/^clean the tmp folder on web-1$/);
    const told = within(asked).getByTestId("agent-chat-told");
    expect(told.tagName).toBe("DETAILS");
    expect(told).not.toHaveAttribute("open");
    expect(within(told).getByText("What the agent was told")).toBeInTheDocument();
    expect(told).toHaveTextContent("keep it short and plain");
    const change = within(open).getByTestId("agent-chat-change-c1");
    expect(change).toHaveTextContent("find /tmp -mtime +7 -delete");
    // The same plain words as the waiting list, the Inbox and the chat card: never "risk: destructive".
    expect(change).toHaveTextContent("High. It can remove or overwrite data. No approvals yet. 1 needed.");
    expect(change).not.toHaveTextContent("risk:");
    expect(change).not.toHaveTextContent("0 of 1");
    fireEvent.click(within(change).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByTestId("agent-chat-answered")).toHaveTextContent("Approved. It runs now."));
    fireEvent.click(within(screen.getByTestId("agent-chat-plan")).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(sent.filter((r) => r.action === "chat-answering-answer")).toHaveLength(2));
    expect(sent.filter((r) => r.action === "chat-answering-answer")).toEqual([
      { action: "chat-answering-answer", taskId: "t1", id: "c1", kind: "change", approved: true },
      { action: "chat-answering-answer", taskId: "t1", id: "p1", kind: "plan", approved: false },
    ]);
  });

  it("tries a message in a simulated chat and shows what the bot posted", async () => {
    const { sent, act } = recorder((r) =>
      r.action === "chat-answering-try"
        ? {
            reply: {
              chatTry: {
                channelId: "C1",
                thread: "1700.1",
                settled: false,
                posts: [
                  { id: "p1", threadId: "1700.1", text: "Working on it.", edits: 2, buttons: false },
                  { id: "p2", threadId: "1700.1", text: "May I run df -h on web-1?", edits: 0, buttons: true },
                ],
                privateNotes: ["Link your chat account to approve."],
              },
            },
          }
        : {},
    );
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const tryIt = screen.getByTestId("agent-chat-try");
    expect(screen.getByTestId("agent-chat-try-simulated")).toHaveTextContent("This is a simulated chat in this server. Nothing goes to Slack or Mattermost.");
    fireEvent.change(within(tryIt).getByLabelText("Who writes"), { target: { value: "guest" } });
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "How full is web-1?" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    const result = await screen.findByTestId("agent-chat-try-result");
    // What was sent comes first, marked as the person's own.
    const sentPost = within(result).getByTestId("agent-chat-try-sent");
    expect(sentPost).toHaveTextContent("You wrote, as someone not linked");
    expect(sentPost).toHaveTextContent("How full is web-1?");
    expect(result.firstElementChild).toBe(sentPost);
    const posts = within(result).getAllByTestId("agent-chat-try-post");
    expect(posts[0]).toHaveTextContent("Working on it.");
    expect(posts[0]).toHaveTextContent("edited 2 times");
    expect(posts[1]).toHaveTextContent("with Approve and Deny buttons");
    expect(within(result).getByTestId("agent-chat-try-private")).toHaveTextContent("Link your chat account to approve.");
    expect(result).toHaveTextContent("still working, or waits for an answer");
    expect(sent).toEqual([{ action: "chat-answering-try", channel: "C1", as: "guest", text: "How full is web-1?" }]);
    // On in the same thread.
    fireEvent.click(within(tryIt).getByLabelText("Write in the same thread"));
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "and web-2?" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ action: "chat-answering-try", channel: "C1", as: "guest", text: "and web-2?", thread: "1700.1" });
  });

  it("still says Saved. and Connected after a save changes the settings and the forms start over", async () => {
    // As the server does: each save gives a new snapshot with a later change time, and a connect adds the bot.
    function Harness(): JSX.Element {
      const [chat, setChat] = useState(adminChat({ bots: [], status: {} }));
      const act = async (request: HubRequest): Promise<HubSnapshot> => {
        const next = adminChat(
          request.action === "chat-answering-connect"
            ? { bots: [{ service: "slack", enabled: true, hasToken: true, hasAppToken: true, savedAt: NOW + 5 }], status: { slack: { state: "open" } } }
            : { bots: chat.admin!.bots, status: chat.admin!.status },
        );
        next.admin!.settings.changedAt = (chat.admin!.settings.changedAt ?? NOW) + 1;
        setChat(next);
        return {
          ...hub(next),
          ...(request.action === "chat-answering-connect" ? { reply: { chatAgentConnect: { service: "slack", bot: "sshs3-agent", notes: [] } } } : {}),
        } as HubSnapshot;
      };
      return <AgentInChatCard hub={hub(chat)} act={act} />;
    }
    render(<Harness />);
    const fold = screen.getByTestId("agent-bot-slack");
    fireEvent.change(within(fold).getByLabelText("Bot token of the agent bot's app"), { target: { value: "xoxb-1" } });
    fireEvent.change(within(fold).getByLabelText("App-level token"), { target: { value: "xapp-2" } });
    fireEvent.click(within(fold).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.getByTestId("agent-bot-slack-said")).toHaveTextContent("Connected as sshs3-agent."));

    fireEvent.click(within(screen.getByTestId("agent-chat-channels")).getByRole("button", { name: "Save the channels" }));
    await waitFor(() => expect(within(screen.getByTestId("agent-chat-channels")).getByText("Saved.")).toBeInTheDocument());
    // A change to the form takes the note away again.
    fireEvent.change(screen.getByLabelText("Clusters for #ops"), { target: { value: "staging" } });
    expect(within(screen.getByTestId("agent-chat-channels")).queryByText("Saved.")).toBeNull();

    fireEvent.click(within(screen.getByTestId("agent-chat-model")).getByRole("button", { name: "Save the wait, budget and limits" }));
    await waitFor(() => expect(screen.getByTestId("agent-chat-model-saved")).toHaveTextContent("Saved."));
  });

  it("shows what the bot posted as it reads in the chat", async () => {
    expect(chatTextAsMarkdown("slack", "*What*\nRestart <https://example.com/x|the job> now")).toBe("**What**\nRestart [the job](https://example.com/x) now");
    expect(chatTextAsMarkdown("mattermost", "**What**")).toBe("**What**");
    const { act } = recorder(() => ({
      reply: { chatTry: { channelId: "C1", thread: "1", settled: true, posts: [{ id: "p1", text: "#### A change is waiting\n\n**What**\nRestart nginx", edits: 0, buttons: false }], privateNotes: [] } },
    }));
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const tryIt = screen.getByTestId("agent-chat-try");
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "Restart nginx" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    const post = await screen.findByTestId("agent-chat-try-post");
    expect(within(post).getByRole("heading", { name: "A change is waiting" })).toBeInTheDocument();
    expect(post).not.toHaveTextContent("**");
  });

  it("says who may approve as it is, and whether the chat agent has a model", () => {
    const view = render(<AgentInChatCard hub={hub(adminChat())} act={recorder().act} />);
    expect(screen.getByTestId("agent-in-chat-card")).toHaveTextContent(
      "A change waits until a person who may approve it says yes: in the thread once they linked their chat account, or here under Waiting for your answer.",
    );
    expect(screen.getByTestId("agent-chat-model-now")).toHaveTextContent("The chat agent uses Team model (gpt-x).");
    expect(screen.getByTestId("agent-chat-model")).toHaveTextContent("This copies your data policy too.");
    expect(screen.queryByTestId("agent-chat-no-model")).toBeNull();
    view.rerender(<AgentInChatCard hub={hub(adminChat({ model: { set: false } }))} act={recorder().act} />);
    expect(screen.getByTestId("agent-chat-no-model")).toHaveTextContent("The chat agent has no model yet. Press Copy my model first");
    expect(screen.getByTestId("agent-chat-model-now")).toHaveTextContent("The chat agent has no model yet.");
    expect(screen.getByTestId("agent-chat-try-no-model")).toHaveTextContent("nothing answers here");
    // With answering on and no model, every question gets "No model is set up": said as an error.
    const on = adminChat({ model: { set: false } });
    on.admin!.settings.enabled = true;
    view.rerender(<AgentInChatCard hub={hub(on)} act={recorder().act} />);
    expect(screen.getByTestId("agent-chat-no-model")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("agent-chat-no-model")).toHaveTextContent(
      'Until then the agent bot answers every question with an error that says "No model is set up".',
    );
    expect(screen.getByTestId("agent-chat-no-model")).not.toHaveTextContent("with that.");
  });

  it("says what the data policy means while answering is on, and how to change it", () => {
    const refused = { dataPolicy: [{ service: "slack" as const, allowed: false, errors: ["Slack is not in the EU."], warnings: [] }] };
    const view = render(<AgentInChatCard hub={hub(adminChat(refused))} act={recorder().act} />);
    const policy = screen.getByTestId("agent-chat-policy");
    expect(policy).toHaveTextContent("Answering cannot be switched on until the policy allows it.");
    expect(policy).toHaveTextContent("The chat agent's data policy comes with its model settings. Change yours under What leaves this machine, then press Copy my model.");
    const on = adminChat(refused);
    on.admin!.settings.enabled = true;
    view.rerender(<AgentInChatCard hub={hub(on)} act={recorder().act} />);
    expect(screen.getByTestId("agent-chat-policy")).toHaveTextContent("Answers are not posted there while the policy stops it.");
    expect(screen.getByTestId("agent-chat-policy")).not.toHaveTextContent("cannot be switched on");
  });

  it("keeps channel rows not saved yet when another part is saved, by this administrator or another", async () => {
    function Harness(): JSX.Element {
      const [chat, setChat] = useState(adminChat());
      const act = async (request: HubRequest): Promise<HubSnapshot> => {
        const next = adminChat();
        next.admin!.settings = { ...chat.admin!.settings, changedAt: (chat.admin!.settings.changedAt ?? NOW) + 1 };
        if (request.action === "chat-answering-save" && request.input.enabled !== undefined) next.admin!.settings.enabled = request.input.enabled;
        if (request.action === "chat-answering-save" && request.input.dms) next.admin!.settings.dms = { ...next.admin!.settings.dms, ...request.input.dms };
        setChat(next);
        return hub(next);
      };
      return <AgentInChatCard hub={hub(chat)} act={act} />;
    }
    render(<Harness />);
    const rows = screen.getByTestId("agent-chat-channels");
    fireEvent.change(within(rows).getByLabelText("Channel id"), { target: { value: "C7" } });
    fireEvent.change(within(rows).getByLabelText("Channel name"), { target: { value: "db" } });
    fireEvent.click(within(rows).getByRole("button", { name: "Add the channel" }));
    fireEvent.change(within(rows).getByLabelText("Clusters for #ops"), { target: { value: "staging" } });
    // Answering switched on, then direct messages saved: the new row and the edit stay.
    fireEvent.click(screen.getByLabelText("Answer in chat"));
    await waitFor(() => expect(screen.getByText("Answering")).toBeInTheDocument());
    const dms = screen.getByTestId("agent-chat-dms");
    fireEvent.click(within(dms).getByLabelText("Answer direct messages"));
    fireEvent.click(within(dms).getByRole("button", { name: "Save direct messages" }));
    await waitFor(() => expect(within(screen.getByTestId("agent-chat-dms")).getByText("Saved.")).toBeInTheDocument());
    expect(within(screen.getByTestId("agent-chat-channels")).getByTestId("agent-chat-row-C7")).toBeInTheDocument();
    expect(screen.getByLabelText("Clusters for #ops")).toHaveValue("staging");
  });

  it("shows a failure only in the part whose request failed last, with that request's reason", async () => {
    function Harness(): JSX.Element {
      const [error, setError] = useState("");
      const act = async (request: HubRequest): Promise<HubSnapshot | undefined> => {
        setError("");
        if (request.action === "chat-answering-save") {
          const what = request.input.channels ? "channels" : request.input.dms ? "direct messages" : request.input.limits ? "limits" : "the switch";
          setError(`Refused: ${what}.`);
          return undefined;
        }
        return {} as HubSnapshot;
      };
      return <AgentInChatCard hub={hub(adminChat())} act={act} error={error} />;
    }
    render(<Harness />);
    const channels = screen.getByTestId("agent-chat-channels");
    const dms = screen.getByTestId("agent-chat-dms");
    const model = screen.getByTestId("agent-chat-model");
    fireEvent.click(within(channels).getByRole("button", { name: "Save the channels" }));
    expect(await within(channels).findByRole("alert")).toHaveTextContent("Refused: channels.");
    fireEvent.click(within(dms).getByRole("button", { name: "Save direct messages" }));
    expect(await within(dms).findByRole("alert")).toHaveTextContent("Refused: direct messages.");
    expect(within(channels).queryByTestId("agent-chat-failed")).toBeNull();
    fireEvent.click(within(model).getByRole("button", { name: "Save the wait, budget and limits" }));
    expect(await within(model).findByRole("alert")).toHaveTextContent("Refused: limits.");
    expect(within(dms).queryByTestId("agent-chat-failed")).toBeNull();
    fireEvent.click(screen.getByLabelText("Answer in chat"));
    await waitFor(() => expect(screen.getAllByTestId("agent-chat-failed")).toHaveLength(1));
    expect(screen.getByTestId("agent-chat-failed")).toHaveTextContent("Refused: the switch.");
    expect(within(model).queryByTestId("agent-chat-failed")).toBeNull();
    // A later request that worked takes the box away.
    fireEvent.click(within(model).getByRole("button", { name: "Copy my model" }));
    await waitFor(() => expect(screen.queryByTestId("agent-chat-failed")).toBeNull());
  });

  it("goes on in a thread only of the channel chosen now, and says where a direct message from you runs", async () => {
    const two = adminChat();
    two.admin!.settings.channels.slack.push({ channelId: "C7", channelName: "db", servers: "*", clusters: [], reach: "read", approvers: "linked", historyFrom: [] });
    const { sent, act } = recorder((r) =>
      r.action === "chat-answering-try"
        ? { reply: { chatTry: { channelId: r.channel === "dm" ? "D1" : r.channel, thread: "1700.1", settled: false, posts: [], privateNotes: [] } } }
        : {},
    );
    render(<AgentInChatCard hub={hub(two)} act={act} />);
    const tryIt = screen.getByTestId("agent-chat-try");
    expect(screen.getByTestId("agent-chat-try-simulated")).toHaveTextContent("The agent itself really runs, with the chat agent's model and servers.");
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "one" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    await within(tryIt).findByLabelText("Write in the same thread");
    fireEvent.click(within(tryIt).getByLabelText("Write in the same thread"));
    // Another channel: the thread of #ops is not offered, nor sent.
    fireEvent.change(within(tryIt).getByLabelText("Channel to try"), { target: { value: "C7" } });
    expect(within(tryIt).queryByLabelText("Write in the same thread")).toBeNull();
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "two" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({ action: "chat-answering-try", channel: "C7", as: "me", text: "two" });
    // Back in #ops after a result in #db: still not #db's thread.
    fireEvent.change(within(tryIt).getByLabelText("Channel to try"), { target: { value: "C1" } });
    expect(within(tryIt).queryByLabelText("Write in the same thread")).toBeNull();

    // A direct message written as yourself runs in your own account.
    fireEvent.change(within(tryIt).getByLabelText("Channel to try"), { target: { value: "dm" } });
    expect(screen.getByTestId("agent-chat-try-simulated")).toHaveTextContent(
      "A direct message from you runs in your own account, with your own model and servers. A change it asks for waits in that conversation, in your list.",
    );
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "three" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toEqual({ action: "chat-answering-try", channel: "dm", as: "me", text: "three" });
    expect(await within(tryIt).findByText(/A change that waits is in that conversation, in your list/)).toBeInTheDocument();
    expect(tryIt).not.toHaveTextContent("Conversations from chat");
    fireEvent.change(within(tryIt).getByLabelText("Who writes"), { target: { value: "guest" } });
    expect(screen.getByTestId("agent-chat-try-simulated")).toHaveTextContent("The agent itself really runs, with the chat agent's model and servers.");
  });

  it("saves a Mattermost channel row in the Mattermost list, and offers only Mattermost channels to search", async () => {
    const { sent, act } = recorder();
    const withMm = hub(adminChat(), {
      chatSources: {
        canChange: true,
        total: 10,
        connections: [
          { service: "slack", hasToken: true, enabled: true, channels: [{ id: "C2", name: "incidents", private: false, selected: true, count: 5, readingBack: false }] },
          {
            service: "mattermost",
            hasToken: true,
            enabled: true,
            channels: [{ id: "mmtown", name: "town-square", private: false, selected: true, count: 3, readingBack: false }],
          },
        ],
      },
    } as unknown as Partial<HubSnapshot>);
    render(<AgentInChatCard hub={withMm} act={act} />);
    const rows = screen.getByTestId("agent-chat-channels");
    fireEvent.change(within(rows).getByLabelText("Service of the new channel"), { target: { value: "mattermost" } });
    fireEvent.change(within(rows).getByLabelText("Channel id"), { target: { value: "mmops" } });
    fireEvent.change(within(rows).getByLabelText("Channel name"), { target: { value: "ops-mm" } });
    fireEvent.click(within(rows).getByRole("button", { name: "Add the channel" }));
    const row = within(rows).getByTestId("agent-chat-row-mmops");
    expect(row).toHaveTextContent("#ops-mm in Mattermost");
    expect(within(row).getByLabelText("#ops-mm may search #town-square")).toBeInTheDocument();
    expect(within(row).queryByLabelText("#ops-mm may search #incidents")).toBeNull();
    fireEvent.click(within(row).getByLabelText("#ops-mm may search #town-square"));
    fireEvent.change(within(row).getByLabelText("Servers for #ops-mm"), { target: { value: "web-2" } });
    fireEvent.click(within(rows).getByRole("button", { name: "Save the channels" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      action: "chat-answering-save",
      input: {
        channels: {
          slack: [{ channelId: "C1", channelName: "ops", servers: ["web-1"], clusters: [], reach: "ask", approvers: "linked", historyFrom: [] }],
          mattermost: [{ channelId: "mmops", channelName: "ops-mm", servers: ["web-2"], clusters: [], reach: "read", approvers: "linked", historyFrom: ["mmops", "mmtown"] }],
        },
      },
    });
  });

  it("reads the conversation again after an answer until its agent is done, so the status matches", async () => {
    const base: ChatTaskView = {
      taskId: "t2",
      title: "Restart the poller",
      status: "waiting",
      chat: {
        service: "mattermost",
        channelId: "mmops",
        channelName: "ops",
        threadId: "p1",
        kind: "channel",
        askedBy: { chatUserId: "U2", name: "Maria" },
        fence: { servers: "*", clusters: [], reach: "ask" },
      },
      messages: [{ id: "m1", role: "user", text: "Restart the poller on um-01", at: NOW }],
      changes: [
        {
          id: "c1",
          kind: "command",
          target: "um-01",
          description: "Restart the Harvest poller",
          command: "sudo systemctl restart harvest",
          status: "pending",
          riskLevel: "modify",
          // A change from chat need not carry how many must approve: one person does.
          at: NOW + 1,
        } as ChatTaskView["changes"][number],
      ],
    };
    const done = (status: ChatTaskView["status"], change: string): ChatTaskView => ({
      ...base,
      status,
      changes: [{ ...base.changes[0], status: change, approvals: [{ actor: "Maria", allowed: true, at: NOW }] } as ChatTaskView["changes"][number]],
      messages: status === "completed" ? [...base.messages, { id: "m2", role: "assistant", text: "Restarted it.", at: NOW + 2 }] : base.messages,
    });
    // Read once before the answer; after it, the agent still works on the first read and is done on the next.
    const reads = [base, done("running", "completed"), done("completed", "completed")];
    const { sent, act } = recorder((r) => {
      if (r.action === "chat-answering-runs")
        return { reply: { chatRuns: [{ taskId: "t2", title: "Restart the poller", status: "waiting", service: "mattermost", channelId: "mmops", channelName: "ops", kind: "channel", threadId: "p1", askedBy: "Maria", reach: "ask", waiting: 1, createdAt: NOW, updatedAt: NOW }] } };
      if (r.action === "chat-answering-task") return { reply: { chatTask: reads.shift() ?? done("completed", "completed") } };
      if (r.action === "chat-answering-answer") return { reply: { chatAnswer: { outcome: "approved", message: "Maria approved." } } };
      return {};
    });
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const runs = screen.getByTestId("agent-chat-runs");
    expect(within(runs).queryByTestId("agent-chat-run-line")).toBeNull();
    fireEvent.click(within(runs).getByRole("button", { name: "Show the conversations" }));
    expect(await within(runs).findByTestId("agent-chat-run-line")).toHaveTextContent("Waiting for 1 answer ·");
    fireEvent.click(within(runs).getByRole("button", { name: "Open Restart the poller" }));
    const status = await screen.findByTestId("agent-chat-task-status");
    expect(status).toHaveTextContent("Status: Waiting.");
    expect(within(screen.getByTestId("agent-chat-change-c1")).getByText("It changes something. No approvals yet. 1 needed.")).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId("agent-chat-change-c1")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByTestId("agent-chat-task-status")).toHaveTextContent("Status: Working on it."));
    await waitFor(() => expect(screen.getByTestId("agent-chat-task-status")).toHaveTextContent("Status: Done."), { timeout: 3000 });
    expect(screen.getByTestId("agent-chat-change-c1")).toHaveTextContent("Change on um-01. Done.");
    expect(screen.getByTestId("agent-chat-change-c1")).toHaveTextContent("1 of 1 approval.");
    // The change shows before the reply the agent gave after it ran, as it happened.
    const changeBlock = screen.getByTestId("agent-chat-change-c1");
    const reply = screen.getByTestId("agent-chat-message-assistant");
    expect(changeBlock.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("agent-chat-answered")).toHaveTextContent("Maria approved.");
    // Once done, it is not read again.
    const count = sent.filter((r) => r.action === "chat-answering-task").length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(sent.filter((r) => r.action === "chat-answering-task")).toHaveLength(count);
  });

  it("says under a waiting card in Try it how it is answered in Slack, in Mattermost and here", async () => {
    const card = { id: "p2", threadId: "1", text: "*A change is waiting for approval*\nRestart nginx. Answer it in sshs3.", edits: 0, buttons: false, waitingCard: true };
    const { act } = recorder(() => ({ reply: { chatTry: { channelId: "C1", thread: "1", settled: false, posts: [card], privateNotes: [] } } }));
    const view = render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const tryIt = screen.getByTestId("agent-chat-try");
    // Short option labels: what the channel may do is said under the list.
    expect(within(tryIt).getByRole("option", { name: "#ops, Slack" })).toBeInTheDocument();
    expect(within(tryIt).getByTestId("agent-chat-try-reach")).toHaveTextContent("There: Ask before changes.");
    // It does not claim the person is linked: Try it only acts as if they were.
    expect(within(tryIt).getByRole("option", { name: "You, as if linked" })).toBeInTheDocument();
    expect(within(tryIt).getByText(/This does not link it/)).toBeInTheDocument();
    fireEvent.change(within(tryIt).getByLabelText("Who writes"), { target: { value: "guest" } });
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "Restart nginx on web-1" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    const note = await screen.findByTestId("agent-chat-try-card-note");
    expect(note).toHaveTextContent(
      "In Slack this card has Approve and Deny buttons. In Mattermost people answer it with reactions, as set under How Mattermost cards are answered. Here nobody can press or react, so answer it under Conversations from chat.",
    );
    expect(screen.getByTestId("agent-chat-try-sent")).toHaveTextContent("Restart nginx on web-1");
    // With Mattermost buttons set up, it says buttons.
    view.rerender(<AgentInChatCard hub={hub(adminChat({ mattermostAnswers: "buttons" }))} act={act} />);
    fireEvent.change(within(screen.getByTestId("agent-chat-try")).getByLabelText("Message to the agent bot"), { target: { value: "again" } });
    fireEvent.click(within(screen.getByTestId("agent-chat-try")).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("agent-chat-try-card-note")).toHaveTextContent("In Mattermost people answer it with Approve and Deny buttons"));
  });

  it("says nothing of buttons under Try it when no card waits", async () => {
    const { act } = recorder(() => ({ reply: { chatTry: { channelId: "C1", thread: "1", settled: true, posts: [{ id: "p1", text: "The disk is 40% full.", edits: 0, buttons: false }], privateNotes: [] } } }));
    render(<AgentInChatCard hub={hub(adminChat())} act={act} />);
    const tryIt = screen.getByTestId("agent-chat-try");
    fireEvent.change(within(tryIt).getByLabelText("Message to the agent bot"), { target: { value: "How full is web-1?" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Send" }));
    expect(await screen.findByTestId("agent-chat-try-sent")).toHaveTextContent("You wrote");
    expect(screen.queryByTestId("agent-chat-try-card-note")).toBeNull();
  });

  it("says approvals in one way, and keeps a number on the line of its word", () => {
    expect(approvalsText(0, 1)).toBe("No approvals yet. 1\u00a0needed.");
    expect(approvalsText(1, 2)).toBe("1 of 2\u00a0approvals.");
    expect(approvalsText(1, 1)).toBe("1 of 1\u00a0approval.");
    // Never fewer needed than approved.
    expect(approvalsText(2, 1)).toBe("2 of 2\u00a0approvals.");
  });

  it("says when try it cannot be used", () => {
    render(<AgentInChatCard hub={hub(adminChat({ canTry: false }))} act={recorder().act} />);
    expect(screen.queryByTestId("agent-chat-try")).toBeNull();
    expect(screen.getByText(/Try it is for the demo, or for before the agent bot is connected/)).toBeInTheDocument();
  });
});

describe("Your chat account", () => {
  it("is all a member sees: a code to send in a direct message, and unlink", async () => {
    const { sent, act } = recorder((r) => (r.action === "chat-link-code" ? { reply: { chatLinkCode: { service: "slack", code: "ABCD2345", expiresAt: NOW + 600_000 } } } : {}));
    const member: ChatAnsweringSnapshot = {
      enabled: true,
      services: ["slack", "mattermost"],
      links: [{ service: "mattermost", chatName: "omar", linkedAt: NOW }],
      waiting: [],
    };
    render(<AgentInChatCard hub={hub(member)} act={act} />);
    const card = screen.getByTestId("agent-in-chat-card");
    expect(card).not.toHaveTextContent("Answer in chat");
    expect(card).not.toHaveTextContent("Channels");
    expect(screen.queryByTestId("agent-bot-slack")).toBeNull();
    const mine = screen.getByTestId("your-chat-account");
    expect(mine).toHaveTextContent("Your chat account");
    expect(screen.getByTestId("your-chat-link-mattermost")).toHaveTextContent("In Mattermost you are linked as omar");

    fireEvent.click(within(mine).getByRole("button", { name: "Get a link code for Slack" }));
    const code = await within(screen.getByTestId("your-chat-code-slack")).findByRole("status");
    expect(code).toHaveTextContent("Send link ABCD2345 to the agent bot in a direct message. Do not paste it in a channel.");
    expect(code).toHaveTextContent("The code works until");

    fireEvent.click(within(screen.getByTestId("your-chat-link-mattermost")).getByRole("button", { name: "Unlink" }));
    fireEvent.click(within(screen.getByTestId("your-chat-link-mattermost")).getByRole("button", { name: "Unlink your Mattermost account?" }));
    await waitFor(() => expect(sent).toEqual([{ action: "chat-link-code", service: "slack" }, { action: "chat-unlink", service: "mattermost" }]));
  });

  it("is hidden when answering is off and the person has no link, and absent off a web server", () => {
    const view = render(<AgentInChatCard hub={hub({ enabled: false, services: ["slack"], links: [], waiting: [] })} act={recorder().act} />);
    expect(screen.queryByTestId("agent-in-chat-card")).toBeNull();
    view.rerender(<AgentInChatCard hub={hub(undefined)} act={recorder().act} />);
    expect(screen.queryByTestId("agent-in-chat-card")).toBeNull();
    view.rerender(<AgentInChatCard hub={hub({ enabled: false, services: [], links: [{ service: "slack", chatName: "lina", linkedAt: NOW }], waiting: [] })} act={recorder().act} />);
    expect(screen.getByTestId("your-chat-link-slack")).toHaveTextContent("In Slack you are linked as lina");
  });

  it("lets a person who may approve answer a change from chat in the app", async () => {
    const { sent, act } = recorder(() => ({ reply: { chatAnswer: { outcome: "waiting", message: "Approved. One more person is needed.", remaining: 1 } } }));
    const member: ChatAnsweringSnapshot = {
      enabled: true,
      services: ["slack"],
      links: [],
      waiting: [{ taskId: "t1", id: "c1", kind: "change", service: "slack", channelName: "ops", askedBy: "Omar", description: "Restart nginx", command: "systemctl restart nginx", target: "web-1", risk: "modify", requiredApprovals: 2, approvedBy: ["Maria"], at: NOW }],
    };
    render(<AgentInChatCard hub={hub(member)} act={act} />);
    const waiting = screen.getByTestId("agent-chat-waiting");
    expect(waiting).toHaveTextContent("A change asked by Omar in #ops (Slack): Restart nginx.");
    // The command on its own line, in a code block; the target, risk and approvals after it.
    expect(within(waiting).getByTestId("agent-chat-waiting-command").tagName).toBe("PRE");
    expect(within(waiting).getByTestId("agent-chat-waiting-command")).toHaveTextContent("systemctl restart nginx");
    expect(waiting).not.toHaveTextContent("Restart nginx systemctl");
    expect(waiting).toHaveTextContent("On web-1. It changes something. 1 of 2 approvals.");
    // A column, so a long command wraps on a phone.
    expect(within(waiting).getByRole("listitem")).toHaveStyle({ flexDirection: "column" });
    fireEvent.click(within(waiting).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(within(waiting).getByRole("status")).toHaveTextContent("One more person is needed."));
    expect(sent).toEqual([{ action: "chat-answering-answer", taskId: "t1", id: "c1", kind: "change", approved: true }]);
  });
});
