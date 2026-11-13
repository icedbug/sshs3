// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { Settings } from "../../src/renderer/src/components/AiHub/SettingsView";
import { dataDestination } from "../../src/renderer/src/components/AiHub/dataDestination";

afterEach(cleanup);

const hub = (config: Record<string, unknown>): HubSnapshot =>
  ({
    config: { provider: "anthropic", model: "claude-opus-5-5", enabled: true, ...config },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
  }) as unknown as HubSnapshot;

describe("saying where the data goes for each AI provider", () => {
  it("names Anthropic, and says secrets are masked first", () => {
    render(<Settings hub={hub({})} act={vi.fn()} />);
    const line = screen.getByTestId("ai-data-destination");
    expect(line).toHaveTextContent("Prompts, terminal output you share and tool results are sent to Anthropic's API.");
    expect(line).toHaveTextContent("Secrets the app recognises, such as keys, tokens and passwords, are masked first.");
  });

  it("names the host of an OpenAI-compatible address and follows what is typed", () => {
    render(<Settings hub={hub({ provider: "openai-compatible", model: "llama", baseUrl: "http://10.0.0.5:8000/v1" })} act={vi.fn()} />);
    const line = screen.getByTestId("ai-data-destination");
    expect(line).toHaveTextContent("sent to the address set below (10.0.0.5:8000). A local server keeps them on your network.");
    fireEvent.change(screen.getByPlaceholderText("http://localhost:11434/v1"), { target: { value: "https://llm.example.com/v1" } });
    expect(line).toHaveTextContent("(llm.example.com)");
  });

  it("says ChatGPT sign-in goes to OpenAI under the person's account", () => {
    render(<Settings hub={hub({ provider: "openai-codex", model: "gpt-6.1-sol" })} act={vi.fn()} />);
    expect(screen.getByTestId("ai-data-destination")).toHaveTextContent("sent to OpenAI under your ChatGPT account.");
  });

  it("names a custom Anthropic endpoint instead of Anthropic", () => {
    expect(dataDestination("anthropic", "https://gateway.corp.example/anthropic")).toContain("the address set below (gateway.corp.example)");
    expect(dataDestination("anthropic", "https://api.anthropic.com")).toContain("Anthropic's API");
    expect(dataDestination("openai-compatible", "")).toContain("sent to the address set below. A local server");
  });
});
