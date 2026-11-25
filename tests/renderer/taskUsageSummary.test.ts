import { describe, expect, it } from "vitest";
import { getTaskUsageSummary } from "../../src/renderer/src/components/AiHub/panel/panelHelpers";
import type { AgentTask } from "../../src/shared/types/aiHub";

/**
 * The pill over the chat says how many tokens a conversation used and what that cost. In the lab it read
 * "341 tok · $0.15": the 30 000 tokens read from the cache, which most of the cost was for, were left out.
 */
describe("the tokens a conversation used", () => {
  it("counts every token sent and answered, the ones read from or written to the cache too", () => {
    const task = {
      status: "completed",
      usage: { inputTokens: 300, outputTokens: 41, cacheReadTokens: 30_000, cacheCreationTokens: 2_000, costUsd: 0.0291 },
    } as unknown as AgentTask;
    expect(getTaskUsageSummary(task)).toEqual({ totalTokens: 32_341, cachedTokens: 32_000, costUsd: 0.0291 });
  });

  it("adds the run going on to what the conversation used before", () => {
    const task = {
      status: "running",
      usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.001 },
      runUsage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 1_000, costUsd: 0.0005 },
    } as unknown as AgentTask;
    expect(getTaskUsageSummary(task)).toEqual({ totalTokens: 1_165, cachedTokens: 1_000, costUsd: 0.0015 });
    expect(getTaskUsageSummary(undefined)).toEqual({ totalTokens: 0, cachedTokens: 0, costUsd: 0 });
  });
});
