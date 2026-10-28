// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
});
