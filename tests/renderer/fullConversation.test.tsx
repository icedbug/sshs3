// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AgentChange, AgentMessage, AgentTask, HubSnapshot } from "../../src/shared/types/aiHub";
import type { AiHubDeltaEvent } from "../../src/shared/ipc/createMultiSSHApi";
import { applyAiHubDelta, applyDeltaToMessages, deltaLeavesGap } from "../../src/renderer/src/lib/aiHub";
import { clearFullTaskCache, useFullTask, userMessageCount } from "../../src/renderer/src/lib/aiHubTasks";
import { setHubWebAccount } from "../../src/renderer/src/lib/aiHubSession";
import { ChangesView } from "../../src/renderer/src/components/AiHub/ChangesView";

/**
 * A long conversation is in a snapshot by its last messages only, and a change without its long parts.
 * The window that shows it fetches it whole, keeps it current from the stream, and fetches it again
 * only when the snapshot says it holds something the window's copy does not.
 */

const message = (id: string, role: AgentMessage["role"], text: string, at = 1): AgentMessage => ({ id, role, text, at });
const piece = (text: string, length: number | undefined, at = 10): AiHubDeltaEvent => ({ taskId: "t1", type: "message.delta", at, delta: text, ...(length === undefined ? {} : { length }) });

describe("a piece of streamed text", () => {
  it("is added where the copy ends exactly before it", () => {
    const put = applyDeltaToMessages([message("u1", "user", "hi"), message("a1", "assistant", "Hello")], piece(" there", 11));
    expect(put.fit).toBe("applied");
    expect(put.messages.at(-1)!.text).toBe("Hello there");
  });

  it("is not added twice when the copy already holds it", () => {
    const messages = [message("a1", "assistant", "Hello there")];
    expect(applyDeltaToMessages(messages, piece(" there", 11))).toMatchObject({ fit: "have", messages });
  });

  it("is noticed as a gap when pieces before it are missing here", () => {
    const messages = [message("a1", "assistant", "Hel")];
    expect(applyDeltaToMessages(messages, piece(" there", 11))).toMatchObject({ fit: "gap", messages });
    // A new message that starts in the middle is a gap too.
    expect(applyDeltaToMessages([message("u1", "user", "hi")], piece("lo", 5)).fit).toBe("gap");
  });

  it("starts a new message after a person's, with an id of its own", () => {
    const put = applyDeltaToMessages([message("u1", "user", "hi")], piece("He", 2));
    expect(put).toMatchObject({ fit: "applied", added: true });
    expect(put.messages.at(-1)).toMatchObject({ role: "assistant", text: "He" });
    expect(put.messages.at(-1)!.id.startsWith("delta-")).toBe(true);
  });

  it("is added as it comes when it does not say where it belongs", () => {
    expect(applyDeltaToMessages([message("a1", "assistant", "Hel")], piece("lo", undefined)).messages.at(-1)!.text).toBe("Hello");
  });

  it("retains the hub's message ID and never appends a late piece to another answer", () => {
    const first = { ...piece("Hi", 2), messageId: "a1" };
    const streamed = applyDeltaToMessages([message("u1", "user", "hi")], first);
    expect(streamed.messages.at(-1)).toMatchObject({ id: "a1", text: "Hi" });
    const later = [...streamed.messages, message("u2", "user", "again"), message("a2", "assistant", "Hi")];
    expect(applyDeltaToMessages(later, { ...piece("!", 3), messageId: "a1" })).toEqual({ messages: later, fit: "have", added: false });
    expect(applyDeltaToMessages(later, { ...piece("Hi", 2), messageId: "a3" }).fit).toBe("gap");
  });
});

const task = (over: Partial<AgentTask> = {}): AgentTask =>
  ({ id: "t1", title: "Long talk", mode: "assisted", status: "running", messages: [], changes: [], sources: [], createdAt: 1, updatedAt: 2, maxCommands: 0, maxMinutes: 0, verification: "not-verified", ...over }) as AgentTask;
const snapshot = (tasks: AgentTask[]): HubSnapshot => ({ tasks }) as unknown as HubSnapshot;

describe("a streamed piece and the snapshot's own copy", () => {
  it("keeps the tail of a long conversation a tail, and what the whole of it is true", () => {
    const tail = task({
      messages: [message("u9", "user", "And then?"), message("a9", "assistant", "x".repeat(800))],
      messagesTail: { count: 20, users: 10, lastId: "a9", lastChars: 5000 },
    });
    // The whole message is 5000 long: this piece follows it, though only its last 800 are here.
    const next = applyAiHubDelta(snapshot([tail]), piece(" more", 5005))!.tasks[0];
    expect(next.messages).toHaveLength(2);
    expect(next.messages[1].text.endsWith(" more")).toBe(true);
    expect(next.messages[1].text).toHaveLength(800);
    expect(next.messagesTail).toEqual({ count: 20, users: 10, lastId: "a9", lastChars: 5005 });
    // A piece it already has changes nothing, and one that leaves a gap asks for a refetch.
    expect(applyAiHubDelta(snapshot([next]), piece(" more", 5005))!.tasks[0]).toBe(next);
    expect(deltaLeavesGap(snapshot([next]), piece("!", 5099))).toBe(true);
    expect(deltaLeavesGap(snapshot([next]), piece("!", 5006))).toBe(false);
  });
});

/** The window's way to the hub, as the test controls it. */
function hubApi(read: (taskId: string) => { messages: AgentMessage[]; changes: AgentChange[] }) {
  let listener: ((delta: AiHubDeltaEvent) => void) | undefined;
  const aiHubRequest = vi.fn(async (request: { action: string; taskId?: string }) => {
    if (request.action !== "task-read") throw new Error(`unexpected ${request.action}`);
    return { tasks: [], reply: { task: { id: request.taskId!, ...read(request.taskId!) } } } as unknown as HubSnapshot;
  });
  (window as unknown as { multissh: unknown }).multissh = {
    aiHubRequest,
    onAiHubDelta: (l: (delta: AiHubDeltaEvent) => void) => {
      listener = l;
      return () => (listener = undefined);
    },
  };
  return { aiHubRequest, send: (delta: AiHubDeltaEvent) => act(() => listener?.(delta)) };
}

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

describe("showing a conversation whole", () => {
  const all = [message("u1", "user", "Why?"), message("a1", "assistant", "Because."), message("u2", "user", "And then?"), message("a2", "assistant", "It was restarted.")];

  it("starts a fresh full-task cache and ignores an unfinished read from the previous session", async () => {
    setHubWebAccount("first");
    const cut = task({ messages: all.slice(-1), messagesTail: { count: 4, users: 2, lastId: "a2", lastChars: 17 } });
    let finish!: (snapshot: HubSnapshot) => void;
    const delayed = new Promise<HubSnapshot>((resolve) => { finish = resolve; });
    const firstFull = { reply: { task: { id: cut.id, messages: all, changes: [] } } } as unknown as HubSnapshot;
    const currentMessages = [...all.slice(0, -1), message("a2", "assistant", "Current session.")];
    const currentFull = { reply: { task: { id: cut.id, messages: currentMessages, changes: [] } } } as unknown as HubSnapshot;
    const read = vi.fn().mockReturnValueOnce(delayed).mockResolvedValueOnce(currentFull);
    Object.assign(window, { multissh: { aiHubRequest: read } });
    const old = render(<Shown task={cut} />);
    expect(read).toHaveBeenCalledTimes(1);
    old.unmount();
    setHubWebAccount(null);
    setHubWebAccount("second");
    render(<Shown task={{ ...cut, messagesTail: { ...cut.messagesTail!, lastChars: 16 } }} />);
    await waitFor(() => expect(screen.getByTestId("last")).toHaveTextContent("Current session."));
    await act(async () => { finish(firstFull); });
    expect(screen.getByTestId("last")).toHaveTextContent("Current session.");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("leaves a conversation the snapshot carries whole as it is, and asks for nothing", () => {
    const api = hubApi(() => ({ messages: [], changes: [] }));
    render(<Shown task={task({ messages: all.slice(0, 2) })} />);
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    expect(api.aiHubRequest).not.toHaveBeenCalled();
  });

  it("fetches a long one once, shows its tail meanwhile, and does not fetch again while nothing is new", async () => {
    const api = hubApi(() => ({ messages: all, changes: [] }));
    const cut = task({ status: "completed", messages: all.slice(-2), messagesTail: { count: 4, users: 2, lastId: "a2", lastChars: 17 } });
    const view = render(<Shown task={cut} />);
    expect(screen.getByTestId("count")).toHaveTextContent("2");
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("4"));
    expect(api.aiHubRequest).toHaveBeenCalledTimes(1);
    // A new snapshot that says the same about the conversation: nothing is asked.
    view.rerender(<Shown task={{ ...cut, updatedAt: 99 }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.aiHubRequest).toHaveBeenCalledTimes(1);
  });

  it("recovers after a failed read without switching away from the chat", async () => {
    const api = hubApi(() => ({ messages: all, changes: [] }));
    api.aiHubRequest.mockRejectedValueOnce(new Error("Offline"));
    const cut = task({ status: "completed", messages: all.slice(-2), messagesTail: { count: 4, users: 2, lastId: "a2", lastChars: 17 } });
    render(<Shown task={cut} />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("4"), { timeout: 4000 });
    expect(api.aiHubRequest).toHaveBeenCalledTimes(2);
  });

  it("fetches again when the snapshot says there is a message this copy does not have", async () => {
    let stored = all;
    const api = hubApi(() => ({ messages: stored, changes: [] }));
    const cut = task({ status: "completed", messages: all.slice(-2), messagesTail: { count: 4, users: 2, lastId: "a2", lastChars: 17 } });
    const view = render(<Shown task={cut} />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("4"));
    stored = [...all, message("u3", "user", "Thanks")];
    view.rerender(<Shown task={{ ...cut, messages: stored.slice(-2), messagesTail: { count: 5, users: 3, lastId: "u3", lastChars: 6 } }} />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("5"));
    expect(api.aiHubRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps the whole copy current from the stream, without a fetch for each piece", async () => {
    const api = hubApi(() => ({ messages: all, changes: [] }));
    const cut = task({ status: "running", messages: all.slice(-2), messagesTail: { count: 4, users: 2, lastId: "a2", lastChars: 17 } });
    render(<Shown task={cut} />);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("4"));
    api.send(piece(" Twice.", 24));
    expect(screen.getByTestId("last")).toHaveTextContent("It was restarted. Twice.");
    // The same piece again (the stream and a fetch crossed): not added twice.
    api.send(piece(" Twice.", 24));
    expect(screen.getByTestId("last")).toHaveTextContent("It was restarted. Twice.");
    expect(api.aiHubRequest).toHaveBeenCalledTimes(1);
  });

  it("gives a change its long parts once fetched, and keeps what the snapshot says about how it stands", async () => {
    const long = "line\n".repeat(400);
    const fetched = { id: "c1", kind: "command", target: "web-01", description: "Logs", command: "journalctl", status: "completed", exitCode: 0, output: long, at: 1 } as AgentChange;
    hubApi(() => ({ messages: all.slice(0, 2), changes: [fetched] }));
    const listed = { ...fetched, output: long.slice(0, 120), partial: true } as AgentChange;
    render(<Shown task={task({ status: "completed", messages: all.slice(0, 2), changes: [listed] })} />);
    expect(screen.getByTestId("partial")).toHaveTextContent("true");
    await waitFor(() => expect(screen.getByTestId("partial")).toHaveTextContent("false"));
    expect(screen.getByTestId("output").textContent).toHaveLength(long.length);
  });

  it("counts a person's messages from the tail's own count", () => {
    expect(userMessageCount(task({ messages: all.slice(-2), messagesTail: { count: 4, users: 2, lastId: "a2", lastChars: 17 } }))).toBe(2);
    expect(userMessageCount(task({ messages: all }))).toBe(2);
  });
});

describe("the Changes view and a change's long parts", () => {
  it("fetches them when the row is opened, not for every row of the list", async () => {
    const long = "restarted nginx\n".repeat(200);
    const whole = { id: "c1", kind: "command", target: "web-01", description: "Restart nginx", command: "systemctl restart nginx", status: "completed", exitCode: 0, output: long, at: Date.now() } as AgentChange;
    const api = hubApi(() => ({ messages: [], changes: [whole] }));
    const listed = { ...whole, output: long.slice(0, 120), partial: true } as AgentChange;
    const hub = {
      tasks: [task({ status: "completed", title: "Fix nginx", messages: [message("u1", "user", "Fix it")], changes: [listed], target: { sessionId: "s", generation: "g", label: "web-01" } })],
      activityLog: [],
      memories: [],
      schedules: [],
      inventory: [],
      sessions: [],
      preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
      config: { enabled: true, provider: "anthropic", model: "m", useHermes: false, hasApiKey: true },
      runtime: { bundled: true },
    } as unknown as HubSnapshot;
    render(<ChangesView hub={hub} onOpenTask={() => {}} request={vi.fn(async () => hub)} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.aiHubRequest).not.toHaveBeenCalled();

    const row = screen.getByText(/systemctl restart nginx/).closest("details")!;
    row.open = true;
    fireEvent(row, new Event("toggle"));
    await waitFor(() => expect(api.aiHubRequest).toHaveBeenCalledWith({ action: "task-read", taskId: "t1" }));
    await waitFor(() => expect(screen.queryByTestId("change-partial-c1")).not.toBeInTheDocument());
    expect(row.textContent!.split("restarted nginx").length - 1).toBeGreaterThan(20);
  });
});
