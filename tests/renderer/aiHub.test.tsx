// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";
let fixture: HubSnapshot;
let selected = "one";
const request = vi.fn();
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => selected,
  selectAiTerminal: (id: string) => {
    selected = id;
  },
  hubRequest: (...args: unknown[]) => request(...args),
}));
beforeEach(() => {
  request.mockReset();
  selected = "one";
  fixture = {
    config: {
      enabled: true,
      provider: "openai-compatible",
      model: "local",
      useHermes: true,
      hasApiKey: false,
    },
    preferences: {
      background: false,
      autoStart: false,
      inventory: false,
      retentionDays: 30,
    },
    runtime: { bundled: true },
    sessions: [
      {
        id: "one",
        generation: "g1",
        label: "Host one",
        kind: "ssh",
        state: "ready",
        shell: "bash",
        updatedAt: 1,
      },
      {
        id: "two",
        generation: "g2",
        label: "Host two",
        kind: "ssh",
        state: "ready",
        shell: "bash",
        updatedAt: 1,
      },
    ],
    tasks: [
      {
        id: "task",
        title: "Service failure",
        target: { sessionId: "one", generation: "g1", label: "Host one" },
        mode: "assisted",
        status: "waiting",
        createdAt: 1,
        updatedAt: 1,
        maxCommands: 20,
        maxMinutes: 15,
        verification: "not-verified",
        messages: [
          {
            id: "m",
            role: "assistant",
            text: "Inspect the service log.",
            at: 1,
          },
        ],
        sources: [],
        changes: [
          {
            id: "change",
            kind: "command",
            target: "Host one",
            description: "Read service logs",
            command: "journalctl -n 20",
            status: "pending",
            at: 1,
          },
        ],
      },
    ],
    inventory: [],
    memories: [],
    schedules: [],
  };
  request.mockResolvedValue(fixture);
});
afterEach(cleanup);
function Harness() {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">("panel");
  return <AiHubPanel mode={mode} setMode={setMode} />;
}

function openPreviousChat() {
  fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
  fireEvent.click(screen.getByRole("button", { name: /Service failure/ }));
}
describe("persistent AI chat", () => {
  it("shows just the conversation and composer until expanded", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Message to agent")).toBeVisible();
    expect(screen.queryByText("Infrastructure")).not.toBeInTheDocument();
    expect(screen.queryByText("Schedules")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand chat" }));
    expect(screen.getByText("Infrastructure")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse chat" }));
    expect(screen.queryByText("Infrastructure")).not.toBeInTheDocument();
  });
  it("expands the same conversation and preserves its draft", () => {
    render(<Harness />);
    openPreviousChat();
    fireEvent.change(screen.getByLabelText("Message to agent"), {
      target: { value: "Check the config next" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Expand chat" }));
    expect(screen.getByText("Inspect the service log.")).toBeVisible();
    expect(screen.getByLabelText("Message to agent")).toHaveValue(
      "Check the config next",
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse chat" }));
    expect(screen.getByText("Inspect the service log.")).toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });
  it("keeps a running task bound to its terminal after switching tabs", () => {
    const view = render(<AiHubPanel mode="panel" setMode={() => {}} />);
    openPreviousChat();
    selected = "two";
    view.rerender(<AiHubPanel mode="hub" setMode={() => {}} />);
    expect(screen.getByLabelText("Chat target")).toHaveAttribute(
      "title",
      "Host one · fixed for this task",
    );
    expect(request).not.toHaveBeenCalled();
  });
  it("approves exactly the displayed action", async () => {
    render(<Harness />);
    openPreviousChat();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "approve",
        taskId: "task",
        changeId: "change",
        approved: true,
      }),
    );
  });
  it("keeps the draft across settings and closing the panel", () => {
    const view = render(<AiHubPanel mode="panel" setMode={() => {}} />);
    fireEvent.change(screen.getByLabelText("Message to agent"), {
      target: { value: "Diagnose safely" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AI settings" }));
    expect(screen.getByRole("dialog", { name: "AI settings" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close AI settings" }));
    view.rerender(<AiHubPanel mode="closed" setMode={() => {}} />);
    view.rerender(<AiHubPanel mode="panel" setMode={() => {}} />);
    expect(screen.getByLabelText("Message to agent")).toHaveValue(
      "Diagnose safely",
    );
  });
  it("uses Shift+Enter for a newline and Enter to send", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("Message to agent");
    fireEvent.change(input, { target: { value: "Inspect nginx" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(request).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "start",
        task: {
          prompt: "Inspect nginx",
          sessionId: "one",
          mode: "assisted",
          attachments: [],
        },
      }),
    );
  });
  it("opens model setup without losing or sending the draft", () => {
    fixture.config.enabled = false;
    render(<Harness />);
    const input = screen.getByLabelText("Message to agent");
    fireEvent.change(input, { target: { value: "Inspect nginx" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: "AI settings" })).toBeVisible();
    expect(input).toHaveValue("Inspect nginx");
    expect(request).not.toHaveBeenCalled();
  });
  it("immediately sends messages on unarmed SSH and local terminals without blocking on pre-chat prompt confirmation", async () => {
    fixture.sessions[0].state = "unknown";
    render(<Harness />);
    const input = screen.getByLabelText("Message to agent");
    fireEvent.change(input, { target: { value: "Inspect nginx" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "start",
        task: {
          prompt: "Inspect nginx",
          sessionId: "one",
          mode: "assisted",
          attachments: [],
        },
      }),
    );

    request.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fixture.sessions[0].kind = "local";
    fixture.sessions[0].state = "unknown";
    fireEvent.change(input, { target: { value: "Check local files" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "start",
        task: {
          prompt: "Check local files",
          sessionId: "one",
          mode: "assisted",
          attachments: [],
        },
      }),
    );
  });
  it("falls back to Context only (sessionId: undefined) when selected terminal is disconnected or user detaches terminal", async () => {
    fixture.sessions[0].state = "disconnected";
    render(<Harness />);
    expect(screen.getByLabelText("Chat target")).toHaveTextContent(
      "Context only",
    );
    const input = screen.getByLabelText("Message to agent");
    fireEvent.change(input, {
      target: { value: "Kan du förklara hur BGP fungerar?" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "start",
        task: {
          prompt: "Kan du förklara hur BGP fungerar?",
          sessionId: undefined,
          mode: "assisted",
          attachments: [],
        },
      }),
    );
  });
  it("switches to ChatGPT/Codex in settings, populates default model, supports custom model IDs, and clears stale endpoint", async () => {
    fixture.config = {
      enabled: true,
      provider: "openai-compatible",
      model: "gpt-sol-latest",
      baseUrl: "https://openrouter.ai/api/v1",
      useHermes: true,
      hasApiKey: false,
      codexConnected: true,
      codexAccountEmail: "jacob@example.com",
      codexDefaultModel: "gpt-6.1-sol",
      codexModels: ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol"],
    };
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "AI settings" }));
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "openai-codex" },
    });
    expect(screen.getByLabelText("Model ID")).toHaveValue("gpt-6.1-sol");
    fireEvent.change(screen.getByLabelText("Model preset"), {
      target: { value: "gpt-6-astra" },
    });
    expect(screen.getByLabelText("Model ID")).toHaveValue("gpt-6-astra");
    fireEvent.change(screen.getByLabelText("Model preset"), {
      target: { value: "__custom__" },
    });
    expect(screen.getByLabelText("Model preset")).toHaveValue("__custom__");
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "gpt-6.1-sol-900k" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "configure",
          config: expect.objectContaining({
            enabled: true,
            provider: "openai-codex",
            model: "gpt-6.1-sol-900k",
            baseUrl: "",
            useHermes: false,
          }),
        }),
      ),
    );
  });

  it("renders Self-Learning Engine metrics, triggers self-learn-reflect, and sends memory-feedback votes", async () => {
    fixture.memories = [
      {
        id: "mem-learned-1",
        kind: "skill",
        scope: "workspace",
        tier: "core",
        title: "Auto-Learned Fix: multipathd reload",
        text: "systemctl restart multipathd && multipath -r",
        autoLearned: true,
        confidence: 0.88,
        feedbackScore: 2,
        updatedAt: 100,
      },
    ];
    fixture.selfLearning = {
      totalLearnedSkills: 4,
      autoLearned: 2,
      failureToFixPatterns: 2,
      averageConfidence: 0.88,
      recentEvents: [
        {
          id: "ev-1",
          createdAt: 100,
          kind: "failure_to_fix",
          title: "Learned multipathd recovery",
          summary: "Captured exit 1 -> exit 0 resolution",
          confidence: 0.88,
        },
      ],
    };

    render(<AiHubPanel mode="hub" setMode={() => {}} />);
    // The nav label is "Memory & skills" followed by the memory count badge.
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Hub views" })).getByRole(
        "button",
        { name: /Memory & skills/ },
      ),
    );

    expect(screen.getByTestId("self-learning-engine-card")).toBeVisible();
    // The card shows what the app measured, not a list of named "engines" with version numbers.
    expect(screen.queryByTestId("os-engine-badge-orama-hybrid-rag")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("run-self-reflection-btn"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({ action: "self-learn-reflect" }),
    );

    fireEvent.click(screen.getByTestId("memory-upvote-mem-learned-1"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "memory-feedback",
        id: "mem-learned-1",
        delta: 1,
      }),
    );

    fireEvent.click(screen.getByTestId("memory-downvote-mem-learned-1"));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        action: "memory-feedback",
        id: "mem-learned-1",
        delta: -1,
      }),
    );
  });
});

describe("the agent's task list", () => {
  it("shows each item with its state and the note that says what showed it done", async () => {
    const { TaskTodos } = await import("../../src/renderer/src/components/AiHub/TaskTodos");
    const { container } = render(
      <TaskTodos
        todos={[
          { id: "t1", content: "Raise proxy_read_timeout", status: "completed", note: "nginx -t: syntax is ok" },
          { id: "t2", content: "Verify an SSE stream", status: "in_progress" },
          { id: "t3", content: "Restart haproxy", status: "blocked", note: "needs your go-ahead" },
        ]}
      />,
    );
    const list = screen.getByTestId("task-todos");
    expect(list).toHaveTextContent("Task list · 1/3 done");
    expect(list).toHaveTextContent("nginx -t: syntax is ok");
    expect(within(list).getByText("(waiting for you)")).toBeInTheDocument();
    expect(container.querySelector('[data-status="in_progress"]')).toHaveTextContent("Verify an SSE stream");
  });

  it("is absent when the agent has no list", async () => {
    const { TaskTodos } = await import("../../src/renderer/src/components/AiHub/TaskTodos");
    const { container } = render(<TaskTodos todos={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the agent's plan", () => {
  const plan = {
    id: "p",
    goal: "SSE streams survive 90s",
    steps: [
      { action: "Raise the timeout", target: "prod-api-01", command: "sed -i s/60s/120s/ acme.conf", risk: "medium" as const, check: "nginx -t ok", rollback: "sed it back" },
      { action: "Watch a stream", risk: "low" as const, check: "curl holds 90s" },
    ],
    assumptions: ["haproxy has no shorter timeout"],
    status: "proposed" as const,
    revision: 2,
    review: { verdict: "revise" as const, findings: ["Step 2 does not go through haproxy"] },
    createdAt: 1,
  };

  it("shows the steps with risk, check and undo, the review's findings, and what approving allows", async () => {
    const { PlanCard } = await import("../../src/renderer/src/components/AiHub/PlanCard");
    render(<PlanCard taskId="t1" plan={plan} busy={false} act={vi.fn()} />);
    const card = screen.getByTestId("plan-card");
    expect(card).toHaveTextContent("Plan (version 2): SSE streams survive 90s");
    expect(screen.getByTestId("plan-step-1")).toHaveTextContent("medium risk");
    expect(screen.getByTestId("plan-step-1")).toHaveTextContent("$ sed -i s/60s/120s/ acme.conf");
    expect(screen.getByTestId("plan-step-1")).toHaveTextContent("Undo: sed it back");
    expect(screen.getByTestId("plan-review")).toHaveTextContent("Review: problems found");
    expect(screen.getByTestId("plan-review")).toHaveTextContent("Step 2 does not go through haproxy");
    expect(card).toHaveTextContent("Not checked: haproxy has no shorter timeout");
    // One of the two steps lists a command: that is what runs without asking again.
    expect(card).toHaveTextContent("The 1 command(s) listed above run without asking you again");
  });

  it("sends the decision with the note, and names the second button by what it will do", async () => {
    const { PlanCard } = await import("../../src/renderer/src/components/AiHub/PlanCard");
    const act = vi.fn().mockResolvedValue(undefined);
    render(<PlanCard taskId="t1" plan={plan} busy={false} act={act} />);
    expect(screen.getByTestId("plan-reject-btn")).toHaveTextContent("Don't run it");
    fireEvent.change(screen.getByLabelText("Note to the agent"), { target: { value: " test through haproxy " } });
    expect(screen.getByTestId("plan-reject-btn")).toHaveTextContent("Send back with this note");
    fireEvent.click(screen.getByTestId("plan-reject-btn"));
    expect(act).toHaveBeenLastCalledWith({ action: "plan-decide", taskId: "t1", approved: false, note: "test through haproxy" });
    await waitFor(() => expect(screen.getByTestId("plan-approve-btn")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Note to the agent"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("plan-approve-btn"));
    expect(act).toHaveBeenLastCalledWith({ action: "plan-decide", taskId: "t1", approved: true });
  });

  it("cannot be decided while the agent is working, and offers no decision once it is made", async () => {
    const { PlanCard } = await import("../../src/renderer/src/components/AiHub/PlanCard");
    const { rerender } = render(<PlanCard taskId="t1" plan={plan} busy act={vi.fn()} />);
    expect(screen.getByTestId("plan-approve-btn")).toBeDisabled();
    rerender(<PlanCard taskId="t1" plan={{ ...plan, status: "approved", review: { verdict: "unreviewed", findings: [] } }} busy={false} act={vi.fn()} />);
    expect(screen.queryByTestId("plan-approve-btn")).not.toBeInTheDocument();
    expect(screen.getByTestId("plan-status")).toHaveTextContent("approved");
    expect(screen.getByTestId("plan-review")).toHaveTextContent("Not reviewed");
    const none = render(<PlanCard taskId="t2" busy={false} act={vi.fn()} />);
    expect(none.container).toBeEmptyDOMElement();
  });
});
