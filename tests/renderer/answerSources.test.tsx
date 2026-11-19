// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Timeline } from "../../src/renderer/src/components/AiHub/panel/Timeline";
import { AnswerSourceDetails } from "../../src/renderer/src/components/AiHub/AnswerSources";
import type { PanelState } from "../../src/renderer/src/components/AiHub/panel/usePanelState";
import type { AgentMessage, HubReply } from "../../src/shared/types/aiHub";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("sources on individual chat answers", () => {
  it("retains the reference when a terminal excerpt expires", () => {
    render(<AnswerSourceDetails source={{ ref: "S1", kind: "terminal", id: "t", label: "Worker terminal", digest: "term-sha", expired: true }} />);
    expect(screen.getByText("Worker terminal")).toBeVisible();
    expect(screen.getByText(/retention period.*expired/)).toBeVisible();
    expect(screen.queryByText(/Show sent terminal text/)).not.toBeInTheDocument();
    render(<AnswerSourceDetails source={{ ref: "S2", kind: "server-reading", id: "r", label: "CPU", observedAt: 9e99, digest: "reading-sha", expired: true }} />);
    expect(screen.getByText(/server reading has expired/)).toBeVisible();
    expect(screen.getByText("Unknown time")).toBeVisible();
  });

  it("reads only an opened answer and shows the versions, requested excerpts and explicit citations", async () => {
    const messages: AgentMessage[] = [
      { id: "old", role: "assistant", at: 1, text: "Earlier answer" },
      { id: "a2", role: "assistant", at: 2, text: "The runbook recommends checking the worker [S1].", sourceCallCount: 2 },
    ];
    const reply: HubReply = { answerSources: { messageId: "a2", citations: [{ callId: "second", ref: "S1" }], calls: [
      { id: "first", at: 1, sources: [
        { ref: "S1", kind: "kb-page", id: "kb", label: "Queue catalog entry", revision: 2, digest: "page-v2", indexOnly: true },
        { ref: "S2", kind: "memory", id: "m", label: "Team queue policy", updatedAt: 1, digest: "memory-sha" },
      ] },
      { id: "second", at: 2, sources: [
        { ref: "S1", kind: "kb-page", id: "kb", label: "Queue runbook", revision: 3, digest: "page-sha" },
        { ref: "S4", kind: "server-reading", id: "r", label: "Worker CPU", observedAt: 1234, digest: "reading-sha", excerpt: "CPU 14%" },
        { ref: "S3", kind: "terminal", id: "t", label: "Worker terminal", observedAt: 2, digest: "term-sha", excerptTruncated: true, excerpt: "connections=7", segments: ["connections=7\n", "waiting=3"] },
      ] },
    ] } };
    const request = vi.fn().mockResolvedValue({ reply });
    vi.stubGlobal("multissh", { aiHubRequest: request });
    const state = {
      task: { id: "task-1", messages, changes: [] },
      timeline: messages.map(message => ({ message })),
      terminalHandoff: { forMessage: () => undefined },
    } as unknown as PanelState;
    render(<Timeline p={state} />);
    const [old, current] = screen.getAllByRole("article");
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(within(old).getByRole("button", { name: "Show sources" }));
    expect(within(old).getByText(/not recorded/)).toBeVisible();
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(within(current).getByRole("button", { name: "Show sources" }));
    expect(await within(current).findByText("Version 3")).toBeVisible();
    expect(request).toHaveBeenCalledExactlyOnceWith({ action: "task-read", taskId: "task-1", detail: "answer-sources", messageId: "a2" });
    expect(within(current).getByText("Model call 2")).toBeVisible();
    expect(within(current).getByText("Queue catalog entry").closest("li")).toHaveTextContent("Index entry only");
    expect(within(current).getByText("Queue catalog entry").closest("li")).toHaveTextContent("Included in request");
    expect(within(current).getByText("Queue runbook").closest("li")).toHaveTextContent("Cited in answer");
    expect(within(current).getByText("Team queue policy").closest("li")).toHaveTextContent("Included in request");
    expect(within(current).getByText("connections=7", { selector: ".ai-receipt-source > pre" })).toBeVisible();
    const summary = within(current).getByText(/Show sent terminal text/);
    fireEvent.click(summary);
    expect(within(current).getByText("Sent segment 2 of 2")).toBeVisible();
    expect(within(current).getByText("waiting=3")).toBeVisible();
    const filter = within(current).getByRole("combobox", { name: "Source filter" });
    fireEvent.change(filter, { target: { value: "terminal" } });
    expect(within(current).queryByText("Queue runbook")).not.toBeInTheDocument();
    expect(within(current).getByText("Worker terminal")).toBeVisible();
    fireEvent.change(filter, { target: { value: "server-reading" } });
    const reading = within(current).getByText("Worker CPU").closest("li")!;
    expect(within(reading).getByText("CPU 14%")).toBeVisible();
    expect(reading.querySelector("time")).toHaveAttribute("datetime", new Date(1234).toISOString());
    expect(within(current).queryByText("Worker terminal")).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "cited" } });
    expect(within(current).getByText("Queue runbook")).toBeVisible();
    expect(within(current).queryByText("Queue catalog entry")).not.toBeInTheDocument();
    fireEvent.change(within(current).getByRole("searchbox"), { target: { value: "missing entry" } });
    expect(within(current).getByRole("status")).toHaveTextContent("No matching sources.");
    expect(within(old).queryByText("Worker terminal")).not.toBeInTheDocument();
  });
});
