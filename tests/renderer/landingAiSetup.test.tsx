// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_MODELS } from "../../src/shared/types/ai";
import { LandingView } from "../../src/renderer/src/components/LandingView";

const base = {
  tasks: [], workspaceServers: [], agents: [], sessions: [], recentChanges: [], recentActivity: [], infraEdges: [], presence: [],
  kbDocuments: [], kbPages: [], memories: [], preferences: {},
};
let snapshot: Record<string, unknown>;
let answer: (request: { action: string; config?: Record<string, unknown> }) => Record<string, unknown>;
const aiHubRequest = vi.fn(async (request: { action: string; config?: Record<string, unknown> }) => answer(request));

beforeEach(() => {
  aiHubRequest.mockClear();
  answer = () => snapshot;
  // The shared state is read again on every mount, as when the app tells its windows that something changed.
  (window as unknown as { multissh: unknown }).multissh = { aiHubRequest, onAiHubChanged: () => () => undefined };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { multissh?: unknown }).multissh;
  delete (window as unknown as { __SSHS3_WEB_MODE__?: boolean }).__SSHS3_WEB_MODE__;
});

const renderLanding = (): void => {
  render(
    <LandingView
      recentSSH={[]}
      onConnectRecentSSH={vi.fn()}
      onConnectSFTP={vi.fn()}
      onQuickConnectSSH={vi.fn()}
      onQuickStartTerminal={vi.fn()}
      onNewTab={vi.fn()}
      onOpenProfiles={vi.fn()}
      onNewProfile={vi.fn()}
      onOpenSyncBootstrap={vi.fn()}
      onNavigateToTabBar={vi.fn()}
    />,
  );
};

describe("the start page's AI card says what is true", () => {
  it("does not say 'Connect your AI' when the AI is set up", async () => {
    snapshot = { ...base, config: { provider: "anthropic", model: "claude-test", enabled: true, hasApiKey: true } };
    renderLanding();
    const toggle = await screen.findByTestId("workspace-quick-connect-ai-toggle");
    await waitFor(() => expect(toggle).toHaveTextContent("AI set up (claude-test)"));
    expect(toggle).toHaveAttribute("title", expect.stringContaining("Change how the AI runs"));
    fireEvent.click(toggle);
    const banner = screen.getByTestId("quick-connect-ai-banner");
    expect(screen.getByTestId("quick-connect-ai-heading")).toHaveTextContent("AI set up");
    expect(banner).toHaveTextContent("The AI is set up with the model claude-test. To change how it runs, choose one:");
    expect(banner).not.toHaveTextContent("Connect your AI");
  });

  it("names no model of its own, and asks for the model where the app has no default", async () => {
    snapshot = { ...base, config: { provider: "openai-codex", model: "", enabled: false } };
    renderLanding();
    const banner = await screen.findByTestId("quick-connect-ai-banner");
    expect(screen.getByTestId("quick-connect-ai-heading")).toHaveTextContent("Connect your AI");
    expect(banner).not.toHaveTextContent(/GPT-4\.1|Sonnet 4|claude-3/);
    const save = screen.getByTestId("quick-connect-apikey-btn");
    expect(save).toHaveTextContent("Save the key and turn the AI on");
    expect(banner).not.toHaveTextContent(/keyring/i);
    fireEvent.change(screen.getByTestId("quick-connect-apikey-input"), { target: { value: "sk-test" } });
    // OpenAI: no default the app knows, so the model has to be typed.
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("quick-connect-model-input"), { target: { value: "my-model" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(aiHubRequest).toHaveBeenCalledWith(expect.objectContaining({ action: "configure" })));
    const sent = aiHubRequest.mock.calls.map((c) => c[0]).find((r) => r.action === "configure")!;
    expect(sent.config).toMatchObject({ provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "my-model", apiKey: "sk-test" });
  });

  it("uses the app's own default model for Anthropic when none is typed", async () => {
    snapshot = { ...base, config: { provider: "openai-codex", model: "", enabled: false } };
    renderLanding();
    await screen.findByTestId("quick-connect-ai-banner");
    fireEvent.change(screen.getByLabelText("AI provider"), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByTestId("quick-connect-apikey-input"), { target: { value: "sk-ant-test" } });
    fireEvent.click(screen.getByTestId("quick-connect-apikey-btn"));
    await waitFor(() => expect(aiHubRequest).toHaveBeenCalledWith(expect.objectContaining({ action: "configure" })));
    const sent = aiHubRequest.mock.calls.map((c) => c[0]).find((r) => r.action === "configure")!;
    expect(sent.config).toMatchObject({ provider: "anthropic", model: DEFAULT_AI_MODELS.anthropic });
  });

  const saveKey = async (): Promise<HTMLElement> => {
    renderLanding();
    await screen.findByTestId("quick-connect-ai-banner");
    fireEvent.change(screen.getByTestId("quick-connect-apikey-input"), { target: { value: "sk-test" } });
    fireEvent.change(screen.getByTestId("quick-connect-model-input"), { target: { value: "my-model" } });
    fireEvent.click(screen.getByTestId("quick-connect-apikey-btn"));
    return screen.findByTestId("quick-ai-notice");
  };

  it("says where the key is kept: the operating system on the desktop", async () => {
    snapshot = { ...base, config: { provider: "openai-codex", model: "", enabled: false } };
    answer = (r) => (r.action === "configure" ? { ...base, config: { provider: "openai-compatible", model: "my-model", enabled: true, hasApiKey: true, keyStorage: "encrypted" } } : snapshot);
    expect(await saveKey()).toHaveTextContent("The key is saved, encrypted with help from the operating system. The AI is on, with the model my-model.");
  });

  it("says where the key is kept: the app server on the web", async () => {
    (window as unknown as { __SSHS3_WEB_MODE__?: boolean }).__SSHS3_WEB_MODE__ = true;
    snapshot = { ...base, config: { provider: "openai-codex", model: "", enabled: false } };
    answer = (r) => (r.action === "configure" ? { ...base, config: { provider: "openai-compatible", model: "my-model", enabled: true, hasApiKey: true, keyStorage: "encrypted" } } : snapshot);
    const notice = await saveKey();
    expect(notice).toHaveTextContent("The key is saved, encrypted on the app server.");
    expect(notice).not.toHaveTextContent(/keyring|operating system/i);
  });

  it("says when the key is only in memory", async () => {
    snapshot = { ...base, config: { provider: "openai-codex", model: "", enabled: false } };
    answer = (r) => (r.action === "configure" ? { ...base, config: { provider: "openai-compatible", model: "my-model", enabled: true, hasApiKey: true, keyStorage: "session" } } : snapshot);
    expect(await saveKey()).toHaveTextContent("The key is kept in memory. Enter it again after the app or server restarts.");
  });
});
