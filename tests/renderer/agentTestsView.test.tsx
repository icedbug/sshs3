// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { AgentTestsView } from "../../src/renderer/src/components/AiHub/AgentTestsView";

afterEach(cleanup);

const hub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({ tasks: [], agents: [], evalCases: [], ...extra }) as unknown as HubSnapshot;

const evalCase = (extra: Record<string, unknown> = {}) => ({
  id: "e1",
  title: "Backup runs long",
  prompt: "Why is the backup still running?",
  mode: "assisted",
  recordedCalls: 2,
  expect: { mention: ["scrub"], notMention: [], mustCall: [], mustNotRun: [] },
  runs: [],
  createdBy: "jacob",
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe("the tests for the agents", () => {
  it("says what is replayed and what is read as it is now", () => {
    render(<AgentTestsView hub={hub({ evalCases: [evalCase()] as never })} act={vi.fn()} />);
    expect(screen.getByText(/the tools answer from the recording and nothing is run on any system/)).toBeVisible();
    expect(screen.getByText(/knowledge base is read as it is now, not from the recording/)).toBeVisible();
  });

  it("names the calls that went to the knowledge base instead of the recording", () => {
    const withRun = evalCase({
      runs: [
        {
          at: 2,
          passed: true,
          checks: [{ name: "ran to an answer", passed: true }],
          answer: "A scrub was running.",
          calls: [],
          unrecorded: 1,
          live: { sshs3_kb_search: 2 },
          tokens: 10,
        },
      ],
    });
    render(<AgentTestsView hub={hub({ evalCases: [withRun] as never })} act={vi.fn()} />);
    const checks = screen.getByRole("list");
    expect(within(checks).getByText(/had no recording/)).toBeVisible();
    expect(within(checks).getByText(/2 calls to sshs3_kb_search were answered by the knowledge base as it is now/)).toBeVisible();
  });
});
