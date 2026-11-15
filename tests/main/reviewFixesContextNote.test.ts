import { describe, expect, it, vi } from "vitest";
import os from "node:os";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), quit: vi.fn() },
  Notification: { isSupported: () => false },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import { conversationWithToolLog } from "../../src/main/ai/hub/DirectAgentRuntime";
import { CONTEXT_NOTE_PREFIX, type AgentTask } from "../../src/shared/types/aiHub";

describe("what the model is given of a conversation", () => {
  it("includes the summary of a compacted conversation, and leaves out notes meant for the person", () => {
    const task = {
      id: "t",
      messages: [
        { id: "1", role: "system", text: `${CONTEXT_NOTE_PREFIX}Summary of 9 earlier message(s).\nAsked first:\nWhy is nginx down?`, at: 1 },
        { id: "2", role: "system", text: "Model switched to a fallback.", at: 2 },
        { id: "3", role: "user", text: "And now?", at: 3 },
        { id: "4", role: "assistant", text: "Still down.", at: 4 },
      ],
      changes: [],
      sources: [],
    } as unknown as AgentTask;
    const sent = conversationWithToolLog(task);
    expect(sent.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    expect(sent[0].text).toContain("Why is nginx down?");
    expect(sent.some((m) => m.text.includes("fallback"))).toBe(false);
  });
});
