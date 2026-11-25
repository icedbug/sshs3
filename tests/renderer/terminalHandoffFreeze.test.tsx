// @vitest-environment jsdom
/*
 * Run in Terminal under an answer or a runbook step, during a change freeze: found by the security lead
 * tester (it typed past a freeze unseen), and by the review of that fix (the confirmation carried over to
 * another terminal, and the audit log said "sent" before anything was typed).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, TerminalSession } from "../../src/shared/types/aiHub";

const request = vi.fn<(req: HubRequest) => Promise<unknown>>();
vi.mock("../../src/renderer/src/lib/aiHub", () => ({ hubRequest: (req: HubRequest) => request(req) }));
import { useTerminalHandoff } from "../../src/renderer/src/components/AiHub/panel/useTerminalHandoff";

const term = (id: string, label: string): TerminalSession =>
  ({ id, generation: "g1", label, kind: "ssh", state: "ready", updatedAt: 1 }) as unknown as TerminalSession;
const web = term("t1", "web-01");
const db = term("t2", "db-01");
const until = Date.now() + 3_600_000;
/** The hub as it answers during a freeze on every server: asked first, cleared once the person presses again. */
const frozenEverywhere = async (req: HubRequest) => {
  if (req.action === "answer-command" && !req.confirmFreeze)
    return { reply: { answerCommand: { cleared: false, frozenUntil: until, label: req.sessionId === "t1" ? "web-01" : "db-01" } } };
  if (req.action === "answer-command") return { reply: { answerCommand: { cleared: true, intentId: `intent-${req.sessionId}` } } };
  return {};
};
const asked = () => request.mock.calls.map(([req]) => req);

let write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  request.mockReset();
  write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window, "multissh", { configurable: true, writable: true, value: { terminalWrite: write } });
});
afterEach(() => vi.restoreAllMocks());

function handoff(session: TerminalSession) {
  const setError = vi.fn();
  const setNotice = vi.fn();
  const hook = renderHook(({ s }) => useTerminalHandoff("task-1", s, setError, setNotice), { initialProps: { s: session } });
  return { ...hook, setError };
}

describe("Run in Terminal during a change freeze", () => {
  it("asks again on another terminal: the freeze said on one is not taken as said on the other", async () => {
    request.mockImplementation(frozenEverywhere);
    const { result, rerender, setError } = handoff(web);
    act(() => result.current.forMessage("m1")!.run("uptime", 1));
    await vi.waitFor(() => expect(setError).toHaveBeenLastCalledWith(expect.stringMatching(/^A change freeze holds on web-01 until /)));
    // The person picks another terminal, frozen as well, and presses Run on the same block.
    rerender({ s: db });
    act(() => result.current.forMessage("m1")!.run("uptime", 1));
    await vi.waitFor(() => expect(setError).toHaveBeenLastCalledWith(expect.stringMatching(/^A change freeze holds on db-01 until /)));
    expect(asked().at(-1)).toEqual({ action: "answer-command", sessionId: "t2", command: "uptime", taskId: "task-1" });
    expect(write).not.toHaveBeenCalled();
    // Pressed again there, it runs there, and the hub is told it was typed.
    act(() => result.current.forMessage("m1")!.run("uptime", 1));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("t2", "uptime\n"));
    await vi.waitFor(() => expect(asked().at(-1)).toEqual({ action: "answer-command-typed", intentId: "intent-t2", typed: true }));
    expect(asked().filter((r) => r.action === "answer-command" && r.confirmFreeze)).toEqual([
      { action: "answer-command", sessionId: "t2", command: "uptime", taskId: "task-1", confirmFreeze: true },
    ]);
  });

  it("tells the hub when the terminal did not take the command", async () => {
    request.mockImplementation(async () => ({ reply: { answerCommand: { cleared: true, intentId: "intent-1" } } }));
    write.mockRejectedValueOnce(new Error("Pod transport closed"));
    const { result } = handoff(web);
    act(() => result.current.forMessage("m1")!.run("uptime", 1));
    await vi.waitFor(() => expect(asked().at(-1)).toEqual({ action: "answer-command-typed", intentId: "intent-1", typed: false }));
  });

  it("does not count a warning the person never saw as said", async () => {
    let answerFirst!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    request.mockImplementation(frozenEverywhere);
    const { result, setError } = handoff(web);
    act(() => result.current.forMessage("m1")!.run("uptime", 1));
    // The person leaves (another conversation) before the hub answers: the warning is not shown.
    act(() => result.current.reset());
    await act(async () => answerFirst({ reply: { answerCommand: { cleared: false, frozenUntil: until, label: "web-01" } } }));
    expect(setError).not.toHaveBeenCalledWith(expect.stringMatching(/change freeze/));
    // So the next press asks, and says so, instead of running.
    act(() => result.current.forMessage("m1")!.run("uptime", 1));
    await vi.waitFor(() => expect(setError).toHaveBeenLastCalledWith(expect.stringMatching(/^A change freeze holds on web-01 until /)));
    expect(asked().at(-1)).toEqual({ action: "answer-command", sessionId: "t1", command: "uptime", taskId: "task-1" });
    expect(write).not.toHaveBeenCalled();
  });

  // Also found by the review: Run in terminal on a runbook step in the knowledge base typed into a frozen
  // server with no question and no line in the audit log.
  it("asks about a runbook step in the same way, as one from a runbook", async () => {
    request.mockImplementation(frozenEverywhere);
    const { result, setError } = handoff(web);
    act(() => void result.current.runStep("systemctl reload nginx"));
    await vi.waitFor(() => expect(setError).toHaveBeenLastCalledWith(expect.stringMatching(/^A change freeze holds on web-01 until /)));
    expect(asked().at(-1)).toEqual({ action: "answer-command", sessionId: "t1", command: "systemctl reload nginx", from: "runbook" });
    act(() => void result.current.runStep("systemctl reload nginx"));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("t1", "systemctl reload nginx\n"));
    await vi.waitFor(() => expect(asked().at(-1)).toEqual({ action: "answer-command-typed", intentId: "intent-t1", typed: true }));
  });
});
