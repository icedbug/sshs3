// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { AgentTask, HubSnapshot } from "../../src/shared/types/aiHub";
import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";

let fixture: HubSnapshot;
const request = vi.fn();
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => "",
  selectAiTerminal: () => {},
  hubRequest: (...args: unknown[]) => request(...args),
  onAiHubDelta: vi.fn(() => () => {}),
}));

function makeTask(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task",
    title: "Disk question",
    mode: "advice",
    status: "failed",
    createdAt: 1,
    updatedAt: 1,
    maxCommands: 20,
    maxMinutes: 15,
    verification: "not-verified",
    messages: [
      { id: "u1", role: "user", text: "First question", at: 1 },
      { id: "a1", role: "assistant", text: "First answer", at: 2 },
      { id: "u2", role: "user", text: "Second question", at: 3 },
    ],
    sources: [],
    changes: [],
    ...over,
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
    tasks: [makeTask()],
    inventory: [],
    memories: [],
    schedules: [],
  } as unknown as HubSnapshot;
  request.mockImplementation(async () => fixture);
});
afterEach(cleanup);

function Harness({ start = "panel" }: { start?: "panel" | "hub" | "closed" }) {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">(start);
  return (
    <>
      <output data-testid="mode">{mode}</output>
      <AiHubPanel mode={mode} setMode={setMode} />
    </>
  );
}
function openTask(): void {
  fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
  fireEvent.click(screen.getByRole("button", { name: /Disk question/ }));
}

describe("header badge", () => {
  it("says AI off when the assistant is switched off, and the model when it is on", () => {
    fixture.config.enabled = false;
    const view = render(<Harness />);
    expect(screen.getByTestId("ai-profile-badge")).toHaveTextContent("AI off");
    fixture.config.enabled = true;
    view.rerender(<Harness />);
    expect(screen.getByTestId("ai-profile-badge")).toHaveTextContent("local");
  });
});

describe("the demo lab's example conversation", () => {
  it("says where it is read that it is invented, and only there", () => {
    fixture.demoMode = true;
    fixture.tasks = [makeTask({ id: "demo-task-ontap-latency-triage", status: "completed" })];
    const view = render(<Harness />);
    openTask();
    expect(screen.getByTestId("demo-example-note")).toHaveTextContent(
      "Demo lab: this conversation is an invented example. Nothing in it was run.",
    );
    // A conversation somebody started in the demo lab themselves is not an example.
    view.unmount();
    fixture.tasks = [makeTask({ status: "completed" })];
    render(<Harness />);
    openTask();
    expect(screen.queryByTestId("demo-example-note")).toBeNull();
  });
  it("names the mode that runs nothing Advice, not Ask", () => {
    render(<Harness />);
    expect(screen.getByTestId("ai-mode-pill-advice")).toHaveTextContent("Advice");
    expect(screen.getByTestId("ai-mode-pill-assisted")).toHaveTextContent("Ask first");
  });
});

describe("fork and restore", () => {
  it("forks with the typed field name fromMessageId", async () => {
    render(<Harness />);
    openTask();
    fireEvent.click(screen.getAllByTitle("Start a new conversation from a copy of this one, up to this message")[1]);
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith({ action: "task-fork", taskId: "task", fromMessageId: "a1" });
  });
  it("restores a checkpoint by the change's id, as changeId", async () => {
    fixture.tasks = [
      makeTask({
        changes: [
          {
            id: "change-1",
            kind: "file",
            target: "Host one",
            description: "Edit nginx.conf",
            status: "completed",
            at: 4,
            checkpointId: "cp-9",
          } as unknown as AgentTask["changes"][number],
        ],
      }),
    ];
    render(<Harness />);
    openTask();
    // The first click asks, the second does it.
    fireEvent.click(screen.getByTestId("ai-restore-checkpoint-change-1"));
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ action: "restore-checkpoint" }));
    expect(screen.getByTestId("ai-restore-checkpoint-change-1")).toHaveTextContent("Put the file back as it was?");
    fireEvent.click(screen.getByTestId("ai-restore-checkpoint-change-1"));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith({ action: "restore-checkpoint", taskId: "task", changeId: "change-1" });
  });
});

describe("Retry", () => {
  it("is offered only on the last user message", () => {
    render(<Harness />);
    openTask();
    const retry = screen.getAllByTestId("ai-message-retry");
    expect(retry).toHaveLength(1);
    expect(retry[0]).toHaveAttribute("title", "Ask again. The answer below is replaced by the new one.");
    expect(retry[0].closest("article")).toHaveTextContent("Second question");
  });
  it("asks the question again without posting it a second time", async () => {
    render(<Harness />);
    openTask();
    fireEvent.click(screen.getByTestId("ai-message-retry"));
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ action: "reply", taskId: "task", text: "", retry: true, sessionId: undefined });
  });
  it("is not offered while the task is running", () => {
    fixture.tasks = [makeTask({ status: "running" })];
    render(<Harness />);
    openTask();
    expect(screen.queryByTestId("ai-message-retry")).not.toBeInTheDocument();
  });
});

describe("a failure about the model", () => {
  it("offers a way to the AI settings", () => {
    fixture.tasks = [
      makeTask({ error: "No model answered at http://127.0.0.1:11434/v1. Start Ollama, or choose another model in AI settings." }),
    ];
    render(<Harness />);
    openTask();
    fireEvent.click(screen.getByTestId("ai-task-error-settings"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("offers nothing for any other failure", () => {
    fixture.tasks = [makeTask({ error: "The command timed out." })];
    render(<Harness />);
    openTask();
    expect(screen.queryByTestId("ai-task-error-settings")).not.toBeInTheDocument();
  });
});

describe("history and opening", () => {
  it("lists conversations only, not background runs", () => {
    fixture.tasks = [makeTask(), makeTask({ id: "bg", title: "Nightly fact run", workforceRunId: "run-1" } as Partial<AgentTask>)];
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Chat history" }));
    expect(screen.getByRole("button", { name: /Disk question/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nightly fact run/ })).not.toBeInTheDocument();
  });
  it("keeps Full view when sshs3:ai-open gives no mode", () => {
    render(<Harness start="hub" />);
    fireEvent(window, new CustomEvent("sshs3:ai-open"));
    fireEvent(window, new CustomEvent("sshs3:ai-attach", { detail: { text: "x", label: "y" } }));
    expect(screen.getByTestId("mode")).toHaveTextContent("hub");
  });
  it("clears sticky kbTabRequest on normal Knowledge Base navigation and opens requested pageId", async () => {
    const page = {
      id: "p-wal",
      kind: "troubleshooting",
      title: "WAL disk full",
      when: "When pg_wal fills",
      targets: ["pg-01"],
      keys: ["pg_wal"],
      body: "Check archive_command.",
      sources: [],
      history: [],
      revision: 1,
      updatedAt: 1,
    };
    fixture.kbPages = [page] as unknown as HubSnapshot["kbPages"];
    fixture.kbDocuments = [];
    fixture.runbooks = [];
    fixture.kbFindings = [];
    request.mockImplementation(async (req: { action: string; id?: string }) =>
      req.action === "kb-page-read" && req.id === "p-wal"
        ? { ...fixture, reply: { kbPage: page } }
        : fixture,
    );

    render(<Harness start="hub" />);
    // Open Knowledge Base on review tab via sshs3:ai-open.
    fireEvent(
      window,
      new CustomEvent("sshs3:ai-open", { detail: { mode: "hub", view: "Knowledge Base", kbTab: "review" } }),
    );
    expect(await screen.findByRole("tab", { name: /To review/ })).toHaveAttribute("aria-selected", "true");

    // Navigate away and back via nav buttons: must clear sticky review tab and default to Pages.
    fireEvent.click(screen.getByRole("button", { name: /^Chat$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Knowledge Base/ }));
    expect(screen.getByRole("tab", { name: /Pages/ })).toHaveAttribute("aria-selected", "true");

    // Open a specific page via sshs3:ai-open with pageId.
    fireEvent(
      window,
      new CustomEvent("sshs3:ai-open", {
        detail: { mode: "hub", view: "Knowledge Base", kbTab: "pages", pageId: "p-wal" },
      }),
    );
    await waitFor(() => expect(request).toHaveBeenCalledWith({ action: "kb-page-read", id: "p-wal" }));
    expect(await screen.findByText("Check archive_command.")).toBeVisible();
  });
});

describe("Local Ollama", () => {
  it("does not save when nothing answers, and keeps the card", async () => {
    fixture.config.enabled = false;
    request.mockImplementation(async (req: { action: string }) =>
      req.action === "ai-probe"
        ? { ...fixture, reply: { probe: { ok: false, detail: "No model answered at http://127.0.0.1:11434/v1. Start Ollama." } } }
        : fixture,
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Local Ollama/ }));
    expect(await screen.findByText(/No model answered at/)).toBeInTheDocument();
    expect(request.mock.calls.map((c) => c[0].action)).toEqual(["ai-probe"]);
    expect(screen.getByTestId("ai-hub-quick-connect-card")).toBeInTheDocument();
  });
  it("saves the first offered model when the usual one is not there", async () => {
    fixture.config.enabled = false;
    request.mockImplementation(async (req: { action: string }) =>
      req.action === "ai-probe"
        ? { ...fixture, reply: { probe: { ok: true, detail: "Answers.", models: ["llama3.2", "phi4"] } } }
        : fixture,
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Local Ollama/ }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[0][0]).toEqual({ action: "ai-probe", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(request.mock.calls[1][0].config.model).toBe("llama3.2");
    expect(await screen.findByText(/Model: llama3\.2/)).toBeInTheDocument();
  });
});
