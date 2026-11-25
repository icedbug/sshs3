import { describe, expect, it } from "vitest";
import { computeUsageCostUsd } from "../../src/main/ai/hub/DirectAgentRuntime";

/**
 * What a run costs is shown to the person in the panel, so the prices per million tokens have to be the
 * ones Anthropic bills. In the lab the panel showed $0.617 for a conversation the model calls cost $0.149
 * for: Claude Opus 5.5 was priced as the Opus of two years earlier.
 */

// Input, output, cache read, cache write (5 minutes), USD per million tokens.
const usage = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000 };
const cost = (input: number, output: number, read: number, write: number): number =>
  (usage.input_tokens * input + usage.output_tokens * output + usage.cache_read_input_tokens * read + usage.cache_creation_input_tokens * write) / 1e6;

describe("the price of a Claude model's tokens", () => {
  it.each([
    ["claude-opus-5-5", cost(4, 20, 0.2, 5)],
    ["claude-opus-5", cost(5, 25, 0.5, 6.25)],
    ["claude-opus-4-8", cost(5, 25, 0.5, 6.25)],
    ["claude-opus-4-6", cost(5, 25, 0.5, 6.25)],
    ["claude-sonnet-5-5", cost(2, 10, 0.1, 2.5)],
    ["claude-sonnet-5", cost(2, 10, 0.2, 2.5)],
    ["claude-sonnet-4-6", cost(3, 15, 0.3, 3.75)],
    ["claude-haiku-5-5", cost(0.1, 0.5, 0.01, 0.125)],
    ["claude-haiku-4-5", cost(1, 5, 0.1, 1.25)],
    ["claude-fable-5-2", cost(8, 40, 0.2, 10)],
    ["claude-mythos-5-2", cost(8, 40, 0.2, 10)],
    ["claude-fable-5-1", cost(10, 50, 0.25, 12.5)],
    ["claude-fable-5", cost(10, 50, 1, 12.5)],
  ])("is what Anthropic bills for %s", (model, expected) => {
    expect(computeUsageCostUsd(model, usage)).toBeCloseTo(expected, 8);
  });

  it("is five times as much for Claude Haiku 5.5 when the prompt is over 100K tokens", () => {
    expect(computeUsageCostUsd("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 1_000 })).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 8);
    expect(computeUsageCostUsd("claude-haiku-5-5", { input_tokens: 120_000, output_tokens: 1_000 })).toBeCloseTo((120_000 * 0.5 + 1_000 * 2.5) / 1e6, 8);
  });
});
