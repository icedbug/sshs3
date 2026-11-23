// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { AgentTask, HubSnapshot } from "../../src/shared/types/aiHub";

let fixture: HubSnapshot;
// How often the markdown of a message is worked out: once per time a message row is drawn.
const counter = vi.hoisted(() => ({ markdown: 0, texts: [] as string[] }));
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => "",
  selectAiTerminal: () => {},
  hubRequest: async () => fixture,
  onAiHubDelta: vi.fn(() => () => {}),
}));
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    counter.markdown++;
    counter.texts.push(children);
    return <p>{children}</p>;
  },
}));

import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";

const N = 200;
const messages = (): AgentTask["messages"] =>
  Array.from({ length: N }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", text: `Message ${i} with \`code\` and **bold**`, at: i + 1 })) as AgentTask["messages"];
const hubWith = (list: AgentTask["messages"]): HubSnapshot =>
  ({
    config: { enabled: true, provider: "openai-compatible", model: "local", useHermes: false, hasApiKey: false, baseUrl: "http://localhost:11434/v1" },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: true },
    sessions: [],
    tasks: [{ id: "task", title: "Long", mode: "advice", status: "completed", createdAt: 1, updatedAt: 1, maxCommands: 20, maxMinutes: 15, verification: "not-verified", messages: list, sources: [], changes: [] } as unknown as AgentTask],
    inventory: [], memories: [], schedules: [],
  }) as unknown as HubSnapshot;

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  counter.markdown = 0;
  counter.texts = [];
  fixture = hubWith(messages());
});
afterEach(cleanup);

function Harness(): JSX.Element {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">("panel");
  const [, redraw] = useState(0);
  return (
    <>
      <button type="button" onClick={() => redraw((n) => n + 1)}>
        new state arrived
      </button>
      <AiHubPanel mode={mode} setMode={setMode} initialTaskId="task" />
    </>
  );
}

describe("a long conversation while typing", () => {
  it("draws every message once, and none of them again for a key pressed in the composer", () => {
    render(<Harness />);
    expect(counter.markdown).toBe(N);
    const composer = screen.getByTestId("ai-composer");
    fireEvent.change(composer, { target: { value: "a" } });
    fireEvent.change(composer, { target: { value: "ab" } });
    fireEvent.change(composer, { target: { value: "abc" } });
    expect(counter.markdown).toBe(N);
    expect((composer as HTMLTextAreaElement).value).toBe("abc");
  });

  it("draws only the message that changed when new state arrives", () => {
    render(<Harness />);
    const first = fixture.tasks[0].messages;
    // The last answer got longer (a piece of a streamed answer): the other messages are the same objects.
    const longer = [...first.slice(0, -1), { ...first[N - 1], text: "The answer, now longer" }];
    fixture = hubWith(longer);
    counter.markdown = 0;
    counter.texts = [];
    fireEvent.click(screen.getByRole("button", { name: "new state arrived" }));
    expect(counter.texts).toEqual(["The answer, now longer"]);
    expect(screen.getByText("The answer, now longer")).toBeInTheDocument();
  });

  it("the buttons of a message still reach the panel", () => {
    render(<Harness />);
    const before = counter.markdown;
    // Edit puts a message's text into the composer: the row asks the panel as it is now.
    fireEvent.click(screen.getAllByTitle("Edit prompt in composer")[0]);
    expect((screen.getByTestId("ai-composer") as HTMLTextAreaElement).value).toBe("Message 0 with `code` and **bold**");
    expect(counter.markdown).toBe(before);
  });
});
