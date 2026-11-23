// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTask, HubRequest } from "../../src/shared/types/aiHub";
import { Timeline } from "../../src/renderer/src/components/AiHub/panel/Timeline";
import type { PanelState } from "../../src/renderer/src/components/AiHub/panel/usePanelState";

afterEach(() => {
  cleanup();
  delete (window as unknown as { multissh?: unknown }).multissh;
});

const panel = (change: Record<string, unknown>, extra: Record<string, unknown> = {}): PanelState => {
  const task = { id: "t1", title: "x", mode: "assisted", status: "completed", messages: [], changes: [change], sources: [], createdAt: 1, updatedAt: 2 } as unknown as AgentTask;
  return {
    timeline: [{ at: 5, message: undefined, change }],
    task, running: false, busy: false, act: vi.fn(async () => undefined),
    setPrompt: vi.fn(), composer: { current: null }, terminal: undefined, handleForkTask: vi.fn(), copyMessage: vi.fn(), copiedMsgId: null,
    terminalHandoff: { forMessage: () => undefined }, showingMessageTail: false, handleOpenFileRef: vi.fn(), handleRestoreCheckpoint: vi.fn(),
    approvalNotes: {}, setApprovalNotes: vi.fn(), activeAgent: undefined,
    ...extra,
  } as unknown as PanelState;
};

describe("a change in the conversation", () => {
  it("'Verify & Execute Rollback' sends the rollback for this conversation's change", async () => {
    const aiHubRequest = vi.fn(async (_r: HubRequest) => ({ tasks: [] }));
    Object.assign(window, { multissh: { aiHubRequest } });
    const change = {
      id: "c1", kind: "command", target: "web-01", description: "Restart nginx", command: "systemctl restart nginx",
      status: "uncertain", at: 5, rollback: { command: "systemctl start nginx" },
    };
    render(<Timeline p={panel(change)} />);
    fireEvent.click(screen.getByTestId("verify-execute-rollback-btn"));
    fireEvent.click(screen.getByTestId("confirm-execute-rollback-btn"));
    await waitFor(() => expect(aiHubRequest).toHaveBeenCalledWith({ action: "rollback-change", taskId: "t1", changeId: "c1", verify: true }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("'Restore Checkpoint' asks before it puts the file back", () => {
    const handleRestoreCheckpoint = vi.fn();
    const change = { id: "c2", kind: "file", target: "web-01", description: "Edit nginx.conf", status: "completed", at: 5, checkpointId: "cp-1" };
    render(<Timeline p={panel(change, { handleRestoreCheckpoint })} />);
    const button = screen.getByTestId("ai-restore-checkpoint-c2");
    expect(button).toHaveTextContent("Restore Checkpoint");
    fireEvent.click(button);
    expect(handleRestoreCheckpoint).not.toHaveBeenCalled();
    expect(button).toHaveTextContent("Put the file back as it was?");
    // Cancel leaves the file as it is.
    fireEvent.click(screen.getByTestId("confirm-cancel"));
    expect(button).toHaveTextContent("Restore Checkpoint");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(handleRestoreCheckpoint).toHaveBeenCalledWith("c2");
    expect(handleRestoreCheckpoint).toHaveBeenCalledTimes(1);
  });
});
