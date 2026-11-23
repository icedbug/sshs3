// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { AgentChange, AgentMessage, AgentTask, HubSnapshot } from "../../src/shared/types/aiHub";
import { clearFullTaskCache, useFullTask } from "../../src/renderer/src/lib/aiHubTasks";

const message = (id: string, role: AgentMessage["role"], text: string, at = 1): AgentMessage => ({ id, role, text, at });
const task = (over: Partial<AgentTask> = {}): AgentTask =>
  ({ id: "t1", title: "Long talk", mode: "assisted", status: "completed", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 2, maxCommands: 0, maxMinutes: 0, verification: "not-verified", ...over }) as AgentTask;

function Shown({ task: shown }: { task: AgentTask | undefined }): JSX.Element {
  const whole = useFullTask(shown);
  return (
    <div>
      <output data-testid="count">{whole?.messages.length ?? 0}</output>
      <output data-testid="last">{whole?.messages.at(-1)?.text ?? ""}</output>
      <output data-testid="output">{whole?.changes[0]?.output ?? ""}</output>
      <output data-testid="partial">{String(Boolean(whole?.changes[0]?.partial))}</output>
    </div>
  );
}

beforeEach(() => clearFullTaskCache());
afterEach(() => {
  cleanup();
  delete (window as unknown as { multissh?: unknown }).multissh;
});

describe("the snapshot moves on while the whole conversation is being fetched", () => {
  const all = [message("u1", "user", "Why?"), message("a1", "assistant", "Because."), message("u2", "user", "And then?"), message("a2", "assistant", "It was restarted.")];

  it("a message that arrived during the fetch is shown without the person doing anything", async () => {
    let finish!: (s: HubSnapshot) => void;
    const first = new Promise<HubSnapshot>((resolve) => { finish = resolve; });
    const newer = [...all, message("u3", "user", "Thanks")];
    const read = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ reply: { task: { id: "t1", messages: newer, changes: [] } } } as unknown as HubSnapshot);
    Object.assign(window, { multissh: { aiHubRequest: read } });

    const cut = task({ messages: all.slice(-2), messagesTail: { count: 4, users: 2, lastId: "a2", lastChars: 17 } });
    const view = render(<Shown task={cut} />);
    expect(read).toHaveBeenCalledTimes(1);
    // The snapshot now says there are five messages; the first fetch is still on its way.
    view.rerender(<Shown task={{ ...cut, messages: newer.slice(-2), messagesTail: { count: 5, users: 3, lastId: "u3", lastChars: 6 } }} />);
    // The first fetch answers with what the hub had when it was asked: four messages.
    await act(async () => { finish({ reply: { task: { id: "t1", messages: all, changes: [] } } } as unknown as HubSnapshot); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect({ fetches: read.mock.calls.length, shown: screen.getByTestId("count").textContent, last: screen.getByTestId("last").textContent })
      .toEqual({ fetches: 2, shown: "5", last: "Thanks" });
  });

  it("a copy that came back older than the snapshot is asked for again after a pause, without anything else changing", async () => {
    const newer = [...all, message("u3", "user", "Thanks")];
    // The hub answers once with the state it had before the fifth message, then with all of it.
    const read = vi.fn()
      .mockResolvedValueOnce({ reply: { task: { id: "t1", messages: all, changes: [] } } } as unknown as HubSnapshot)
      .mockResolvedValue({ reply: { task: { id: "t1", messages: newer, changes: [] } } } as unknown as HubSnapshot);
    Object.assign(window, { multissh: { aiHubRequest: read } });
    render(<Shown task={task({ messages: newer.slice(-2), messagesTail: { count: 5, users: 3, lastId: "u3", lastChars: 6 } })} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(read).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("count").textContent).toBe("4");
    await act(async () => { await new Promise((r) => setTimeout(r, 1200)); });
    expect({ fetches: read.mock.calls.length, shown: screen.getByTestId("count").textContent, last: screen.getByTestId("last").textContent })
      .toEqual({ fetches: 2, shown: "5", last: "Thanks" });
  });

  it("a command that finished during the fetch gets its output", async () => {
    let finish!: (s: HubSnapshot) => void;
    const first = new Promise<HubSnapshot>((resolve) => { finish = resolve; });
    const pendingChange = { id: "c1", kind: "command", target: "web-01", description: "Logs", command: "journalctl", status: "pending", at: 1 } as AgentChange;
    const doneChange = { ...pendingChange, status: "completed", exitCode: 0, output: "the long output" } as AgentChange;
    const read = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ reply: { task: { id: "t1", messages: all.slice(0, 2), changes: [doneChange] } } } as unknown as HubSnapshot);
    Object.assign(window, { multissh: { aiHubRequest: read } });
    const cut = task({ status: "running", messages: all.slice(0, 2), changes: [{ ...pendingChange, partial: true }] });
    const view = render(<Shown task={cut} />);
    expect(read).toHaveBeenCalledTimes(1);
    view.rerender(<Shown task={{ ...cut, changes: [{ ...pendingChange, status: "completed", exitCode: 0, partial: true } as AgentChange] }} />);
    await act(async () => { finish({ reply: { task: { id: "t1", messages: all.slice(0, 2), changes: [pendingChange] } } } as unknown as HubSnapshot); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect({ fetches: read.mock.calls.length, output: screen.getByTestId("output").textContent, partial: screen.getByTestId("partial").textContent })
      .toEqual({ fetches: 2, output: "the long output", partial: "false" });
  });
});
