// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { HubRequest, HubSnapshot } from "@shared/types/aiHub";
import type { SshCaStatus } from "@shared/types/sshCa";

const mockState = vi.hoisted(() => ({
  hub: null as HubSnapshot | null,
  selectedTerminal: "",
  deltaListeners: new Set<(delta: Record<string, unknown>) => void>(),
  hubRequest: vi.fn<(req: HubRequest) => Promise<HubSnapshot>>(),
  selectAiTerminal: vi.fn((id: string) => {
    mockState.selectedTerminal = id;
  }),
  sshCaStatus: { active: false } as SshCaStatus,
  terminalWrite: vi.fn().mockResolvedValue(undefined),
  settingsSave: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => mockState.hub,
  observeHubSnapshot: (observe: (hub: HubSnapshot) => void) => {
    if (mockState.hub) observe(mockState.hub);
    return () => {};
  },
  useSelectedTerminal: () => mockState.selectedTerminal,
  selectAiTerminal: (id: string) => mockState.selectAiTerminal(id),
  hubRequest: (req: HubRequest) => mockState.hubRequest(req),
  onAiHubDelta: (cb: (delta: Record<string, unknown>) => void) => {
    mockState.deltaListeners.add(cb);
    return () => {
      mockState.deltaListeners.delete(cb);
    };
  },
}));

vi.mock("../../src/renderer/src/lib/useSshCa", () => ({
  useSshCa: () => ({
    status: mockState.sshCaStatus,
    loading: false,
    error: null,
    login: vi.fn(),
    logout: vi.fn(),
    renew: vi.fn(),
    refreshStatus: vi.fn(),
  }),
}));

vi.mock("../../src/renderer/src/lib/webClientBridge", () => ({
  isWebBrowserMode: () => false,
}));

// Lightweight child mocks for App-level integration without needing full xterm/monaco runtime.
vi.mock("../../src/renderer/src/components/TerminalView", () => ({
  TerminalView: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid={`mock-terminal-view-${sessionId ?? "none"}`} />
  ),
}));

import { RichMarkdownContent } from "../../src/renderer/src/components/AiHub/RichMarkdownContent";
import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";
import { LABS_ENABLED_STORAGE_KEY } from "../../src/renderer/src/components/AiHub/SettingsView";
import { LandingView } from "../../src/renderer/src/components/LandingView";
import { App } from "../../src/renderer/src/App";

function makeHubSnapshot(overrides: Partial<HubSnapshot> = {}): HubSnapshot {
  return {
    demoMode: false,
    config: {
      enabled: true,
      useHermes: true,
      provider: "openai-compatible",
      model: "gpt-4.1",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: true,
      codexConnected: false,
      profiles: [
        {
          id: "prof-cloud",
          name: "Cloud GPT-4.1",
          provider: "openai-compatible",
          model: "gpt-4.1",
          baseUrl: "https://api.openai.com/v1",
        },
        {
          id: "prof-local",
          name: "Local Ollama",
          provider: "openai-compatible",
          model: "qwen2.5-coder",
          baseUrl: "http://127.0.0.1:11434/v1",
        },
      ],
      activeProfileByRole: { primary: "prof-cloud" },
    },
    runtime: { bundled: true },
    preferences: {
      background: false,
      autoStart: false,
      inventory: true,
      retentionDays: 30,
    },
    inventory: [],
    sessions: [
      {
        id: "term-1",
        generation: "gen-1",
        label: "prod-web-01",
        kind: "ssh",
        state: "ready",
        owner: "user",
        updatedAt: Date.now(),
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "Investigate nginx 502",
        mode: "assisted",
        status: "completed",
        createdAt: Date.now() - 10_000,
        updatedAt: Date.now() - 1_000,
        maxCommands: 20,
        maxMinutes: 15,
        commandsUsed: 2,
        verification: "verified",
        target: { sessionId: "term-1", generation: "gen-1", label: "prod-web-01" },
        usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.042 },
        sources: [
          {
            id: "src-1",
            label: "@kb:nginx-502",
            text: "Check upstream socket timeout",
            observedAt: Date.now(),
          },
        ],
        todos: [
          { id: "todo-1", content: "Inspect error.log", status: "completed" },
          { id: "todo-2", content: "Verify upstream health", status: "in_progress" },
        ],
        plan: {
          id: "plan-1",
          goal: "Restore nginx upstream health",
          status: "proposed",
          revision: 1,
          createdAt: Date.now() - 4000,
          review: {
            verdict: "approve",
            findings: [],
          },
          steps: [
            {
              action: "Check upstream status",
              command: "systemctl status php-fpm",
              risk: "low",
              check: "systemctl is-active php-fpm",
            },
          ],
        },
        toolLog: [
          {
            name: "ssh_exec",
            input: "tail -n 20 /var/log/nginx/error.log",
            output: "\u001b[31mERROR\u001b[0m upstream prematurely closed connection",
            at: Date.now() - 5000,
            durationMs: 240,
            exitCode: 0,
            target: "prod-web-01",
            ok: true,
          },
          {
            name: "edit_file",
            input: "/etc/nginx/nginx.conf",
            output: "--- a/etc/nginx/nginx.conf\n+++ b/etc/nginx/nginx.conf\n@@ -1,1 +1,1 @@\n-keepalive_timeout 5;\n+keepalive_timeout 30;\n",
            at: Date.now() - 3000,
            durationMs: 85,
            target: "/etc/nginx/nginx.conf",
            ok: true,
          },
        ],
        messages: [
          { id: "msg-u1", role: "user", text: "Check nginx error logs", at: Date.now() - 8000 },
          {
            id: "msg-a1",
            role: "assistant",
            text: "Upstream timed out per [c1] and `prod-web-01:/etc/nginx/nginx.conf:12`.\n\n```bash\nsudo systemctl reload nginx\n```",
            at: Date.now() - 2000,
          },
        ],
        changes: [
          {
            id: "chg-1",
            ref: "c1",
            kind: "file",
            target: "/etc/nginx/nginx.conf",
            description: "Increase keepalive_timeout",
            diff: "--- a/etc/nginx/nginx.conf\n+++ b/etc/nginx/nginx.conf\n@@ -1,1 +1,1 @@\n-keepalive_timeout 5;\n+keepalive_timeout 30;\n",
            status: "completed",
            at: Date.now() - 2500,
            checkpointId: "ckpt-1",
          } as HubSnapshot["tasks"][number]["changes"][number] & { checkpointId?: string },
        ],
      },
    ],
    memories: [],
    schedules: [],
    workGoals: [],
    workTickets: [],
    agents: [],
    mcpServers: [],
    kbDocuments: [],
    kbPages: [],
    ...overrides,
  };
}

describe("Shell Integration Overhaul", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    mockState.selectedTerminal = "term-1";
    mockState.deltaListeners.clear();
    mockState.hub = makeHubSnapshot();
    mockState.sshCaStatus = { active: false };
    mockState.hubRequest.mockReset();
    mockState.hubRequest.mockImplementation(async () => mockState.hub!);
    mockState.selectAiTerminal.mockClear();
    mockState.terminalWrite.mockClear();
    mockState.settingsSave.mockClear();

    Object.defineProperty(window, "multissh", {
      configurable: true,
      writable: true,
      value: {
        terminalWrite: mockState.terminalWrite,
        settingsGet: vi.fn().mockResolvedValue({}),
        settingsSave: mockState.settingsSave,
        sessionsLoad: vi.fn().mockResolvedValue({ tabs: [], activeTabId: "" }),
        sessionsSave: vi.fn().mockResolvedValue(undefined),
        profilesList: vi.fn().mockResolvedValue([]),
        snippetsList: vi.fn().mockResolvedValue([]),
        windowNew: vi.fn().mockResolvedValue(undefined),
        windowList: vi.fn().mockResolvedValue([]),
        sshCaGetStatus: vi.fn().mockResolvedValue({ active: false }),
        onSshCaStatusChanged: vi.fn(() => () => {}),
        aiHubRequest: mockState.hubRequest,
        aiHubSubscribe: vi.fn(() => () => {}),
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("RichMarkdownContent", () => {
    it("renders diff blocks with DiffViewer, ANSI logs with AnsiLogView, shell Stage/Run actions, and clickable file/command refs", () => {
      const onUseCommand = vi.fn();
      const onRunCommand = vi.fn();
      const onOpenRef = vi.fn();
      const onOpenFileRef = vi.fn();

      const md = [
        "See [c1] and prod-web-01:/etc/nginx/nginx.conf:42 for context.",
        "",
        "```bash",
        "systemctl status nginx",
        "```",
        "",
        "```diff",
        "--- a/nginx.conf",
        "+++ b/nginx.conf",
        "@@ -1 +1 @@",
        "-worker_processes 1;",
        "+worker_processes auto;",
        "```",
        "",
        "```ansi",
        "\u001b[31mFATAL\u001b[0m bind failed",
        "```",
      ].join("\n");

      render(
        <RichMarkdownContent
          text={md}
          refs={new Set(["c1"])}
          onOpenRef={onOpenRef}
          onOpenFileRef={onOpenFileRef}
          onUseCommand={onUseCommand}
          onRunCommand={onRunCommand}
        />,
      );

      expect(screen.getByTestId("ai-markdown-diff")).toBeInTheDocument();
      expect(screen.getByTestId("ai-markdown-ansi")).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "c1" }));
      expect(onOpenRef).toHaveBeenCalledWith("c1");

      fireEvent.click(screen.getByTestId("ai-file-ref-btn"));
      expect(onOpenFileRef).toHaveBeenCalledWith(
        expect.objectContaining({ host: "prod-web-01", path: "/etc/nginx/nginx.conf", line: 42 }),
      );

      fireEvent.click(screen.getByRole("button", { name: "Stage in Terminal" }));
      expect(onUseCommand).toHaveBeenCalledWith("systemctl status nginx");

      fireEvent.click(screen.getByRole("button", { name: "Run in Terminal" }));
      expect(onRunCommand).toHaveBeenCalledWith("systemctl status nginx");
    });
  });

  describe("AiHubPanel", () => {
    it("renders unified hub chrome, profile/usage pills, Labs rail toggle, plan mode + Shift+Tab cycle, toolLog, and checkpoint/fork/compact actions", async () => {
      window.sessionStorage.setItem("sshs3.aiHub.openTask", "task-1");
      const setMode = vi.fn();

      render(<AiHubPanel mode="hub" setMode={setMode} />);

      expect(screen.getByText("AI Hub")).toBeInTheDocument();
      expect(screen.getByText("Workspace")).toBeInTheDocument();
      expect(screen.getByTestId("ai-profile-badge")).toHaveTextContent("Cloud GPT-4.1");
      expect(screen.getByTestId("ai-usage-pill")).toHaveTextContent("1.5k tok · $0.042");

      // Core views visible, Labs views hidden until Labs toggle enabled.
      const nav = screen.getByRole("navigation", { name: "Hub views" });
      expect(within(nav).getByText("Infrastructure")).toBeInTheDocument();
      expect(within(nav).queryByText("Schedules")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("ai-hub-labs-toggle"));
      expect(window.localStorage.getItem(LABS_ENABLED_STORAGE_KEY)).toBe("true");
      expect(within(nav).getByText("Schedules")).toBeInTheDocument();

      // Inline toolLog, sources, plan card, todos, and restore checkpoint.
      expect(screen.getByTestId("ai-tool-log-list")).toBeInTheDocument();
      expect(screen.getByTestId("ai-task-sources")).toHaveTextContent("@kb:nginx-502");
      expect(screen.getByTestId("ai-restore-checkpoint-chg-1")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("ai-restore-checkpoint-chg-1"));
      await waitFor(() =>
        expect(mockState.hubRequest).toHaveBeenCalledWith({
          action: "restore-checkpoint",
          taskId: "task-1",
          // The request's typed field: the hub finds the checkpoint by its change.
          changeId: "chg-1",
        }),
      );

      fireEvent.click(screen.getByTestId("ai-task-fork-btn"));
      await waitFor(() =>
        expect(mockState.hubRequest).toHaveBeenCalledWith({
          action: "task-fork",
          taskId: "task-1",
        }),
      );

      fireEvent.click(screen.getByTestId("ai-task-compact-btn"));
      await waitFor(() =>
        expect(mockState.hubRequest).toHaveBeenCalledWith({
          action: "compact-task",
          taskId: "task-1",
        }),
      );

      // Plan mode pill exists and Shift+Tab cycles modes on a fresh chat.
      expect(screen.getByTestId("ai-mode-pill-plan")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      const composer = screen.getByTestId("ai-composer");
      expect(screen.getByTestId("ai-mode-pill-assisted")).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(composer, { key: "Tab", shiftKey: true });
      expect(screen.getByTestId("ai-mode-pill-autonomous")).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(composer, { key: "Tab", shiftKey: true });
      expect(screen.getByTestId("ai-mode-pill-advice")).toHaveAttribute("aria-pressed", "true");
      fireEvent.keyDown(composer, { key: "Tab", shiftKey: true });
      expect(screen.getByTestId("ai-mode-pill-plan")).toHaveAttribute("aria-pressed", "true");
    });

    it("starts a separate conversation for Chat with it when another agent's chat is open", async () => {
      const hub = mockState.hub!;
      const first = { id: "first", name: "First operator", role: "Operations", mission: "Check services", systemPrompt: "", defaultMode: "assisted" as const, updatedAt: 1 };
      const next = { ...first, id: "next", name: "Second operator" };
      hub.agents = [first, next];
      Object.assign(hub.tasks[0], { agentId: first.id, agentName: first.name });
      window.sessionStorage.setItem("sshs3.aiHub.openTask", hub.tasks[0].id);
      render(<AiHubPanel mode="hub" setMode={vi.fn()} />);
      expect(screen.getByText("Check nginx error logs")).toBeVisible();
      const nav = screen.getByRole("navigation", { name: "Hub views" });
      fireEvent.click(screen.getByTestId("ai-hub-labs-toggle"));
      fireEvent.click(within(nav).getByRole("button", { name: /^Agents & MCP/ }));
      const card = await screen.findByTestId("agent-card-next");
      fireEvent.click(within(card).getByRole("button", { name: "Chat with it" }));
      const prompt = "Review the capacity report";
      fireEvent.change(screen.getByTestId("ai-composer"), { target: { value: prompt } });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(mockState.hubRequest).toHaveBeenCalledWith({
        action: "start", task: expect.objectContaining({ prompt, agentId: next.id, agentName: next.name }),
      }));
      expect(mockState.hubRequest).not.toHaveBeenCalledWith(expect.objectContaining({ action: "reply" }));
    });

    it("keeps one visible tool step when its streamed result arrives in the saved snapshot", () => {
      const task = mockState.hub!.tasks[0];
      task.status = "running";
      task.toolLog = [];
      window.sessionStorage.setItem("sshs3.aiHub.openTask", task.id);
      const props = { mode: "panel" as const, setMode: vi.fn() };
      const { rerender } = render(<AiHubPanel {...props} />);
      const record = { name: "workspace_context", input: "inventory", output: "two servers", at: 2100 };
      act(() => {
        for (const listen of mockState.deltaListeners) listen({ taskId: task.id, toolRecord: record });
      });
      const rows = () => within(screen.getByTestId("ai-tool-log-list")).getAllByText(record.name);
      expect(rows()).toHaveLength(1);
      mockState.hub = { ...mockState.hub!, tasks: [{ ...task, toolLog: [{ ...record }] }] };
      rerender(<AiHubPanel {...props} />);
      expect(rows()).toHaveLength(1);
      act(() => {
        for (const listen of mockState.deltaListeners) listen({ taskId: task.id, done: true });
      });
      expect(rows()).toHaveLength(1);
    });

    it("preserves the chat draft, cancels or runs edited CRLF commands and waits for the pod transport", async () => {
      window.sessionStorage.setItem("sshs3.aiHub.openTask", "task-1");
      const hub = mockState.hub!;
      hub.tasks[0].messages[1].text = ["```bash", "pwd", "date", "```"].join("\r\n");
      hub.sessions[0].kind = "k8s";
      let received!: () => void;
      const transport = new Promise<void>((resolve) => { received = resolve; });
      const writePod = vi.fn().mockReturnValue(transport);
      window.multissh!.k8sTerminalWrite = writePod;
      const props = { mode: "panel" as const, setMode: vi.fn() };
      const { rerender } = render(<AiHubPanel {...props} />);
      const stage = () => screen.getByRole("button", { name: "Stage in Terminal" });
      const codeRun = () => screen.getByRole("button", { name: "Run in Terminal" });
      const composer = screen.getByTestId("ai-composer");
      fireEvent.change(composer, { target: { value: "unsent chat" } });
      fireEvent.click(stage());
      const draft = () => screen.getByRole("textbox", { name: "Terminal command draft" });
      expect(draft()).toHaveValue("pwd\ndate");
      expect(composer).toHaveValue("unsent chat");
      fireEvent.change(draft(), { target: { value: "echo discarded" } });
      fireEvent.click(screen.getByRole("button", { name: "Cancel draft" }));
      expect(screen.queryByRole("textbox", { name: "Terminal command draft" })).not.toBeInTheDocument();
      expect(writePod).not.toHaveBeenCalled();
      fireEvent.click(stage());
      fireEvent.change(draft(), { target: { value: "echo first\r\necho second" } });
      fireEvent.click(codeRun());
      expect(writePod).toHaveBeenCalledWith("term-1", "echo first\necho second\n");
      expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
      expect(screen.queryByText("Sent to prod-web-01.")).not.toBeInTheDocument();
      fireEvent.click(codeRun());
      expect(writePod).toHaveBeenCalledTimes(1);
      await act(async () => received());
      expect(screen.getByText("Sent to prod-web-01.")).toBeVisible();
      expect(screen.queryByRole("textbox", { name: "Terminal command draft" })).not.toBeInTheDocument();
      expect(mockState.terminalWrite).not.toHaveBeenCalled();
      fireEvent.click(stage());
      writePod.mockRejectedValueOnce(new Error("Pod transport closed"));
      fireEvent.click(screen.getByRole("button", { name: "Run edited command" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Pod transport closed");
      expect(draft()).toHaveValue("pwd\ndate");
      expect(screen.queryByText("Sent to prod-web-01.")).not.toBeInTheDocument();
      hub.sessions[0].state = "disconnected";
      rerender(<AiHubPanel {...props} />);
      expect(screen.getByRole("button", { name: "Run edited command" })).toBeDisabled();
      hub.sessions[0].state = "ready";
      hub.sessions[0].generation = "replacement";
      rerender(<AiHubPanel {...props} />);
      fireEvent.click(codeRun());
      expect(writePod).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
      expect(composer).toHaveValue("unsent chat");
    });

    it("warns about matching secrets in demo when a real remote model is selected", () => {
      mockState.hub!.demoMode = true;
      render(<AiHubPanel mode="panel" setMode={vi.fn()} />);
      expect(screen.getByTestId("ai-profile-badge").title).toContain("api.openai.com");
      const composer = screen.getByTestId("ai-composer");
      fireEvent.change(composer, { target: { value: "Check key sk-proj-abcdefghijklmnopqrstuvwxyz1234" } });
      fireEvent.keyDown(composer, { key: "Enter" });
      expect(screen.getByTestId("ai-dlp-warning")).toBeInTheDocument();
      expect(mockState.hubRequest).not.toHaveBeenCalled();
    });

    it("streams deltas via onAiHubDelta, supports Stage/Run and ! quick command, DLP warning, and ask-ai events", async () => {
      window.sessionStorage.setItem("sshs3.aiHub.openTask", "task-1");
      mockState.hub = makeHubSnapshot({
        tasks: [
          {
            ...makeHubSnapshot().tasks[0],
            status: "running",
          },
        ],
      });

      const setMode = vi.fn();
      render(<AiHubPanel mode="panel" setMode={setMode} />);

      // Streaming delta event renders live assistant stream.
      act(() => {
        for (const listener of mockState.deltaListeners) {
          listener({ taskId: "task-1", delta: "Checking upstream " });
          listener({ taskId: "task-1", delta: "workers..." });
        }
      });
      expect(screen.getByTestId("ai-streaming-message")).toHaveTextContent("Checking upstream workers...");

      // Stage in Terminal & Run in Terminal handoff from markdown code block.
      fireEvent.click(screen.getAllByRole("button", { name: "Stage in Terminal" })[0]);
      expect(mockState.terminalWrite).toHaveBeenCalledWith("term-1", "sudo systemctl reload nginx");

      fireEvent.click(screen.getAllByRole("button", { name: "Run in Terminal" })[0]);
      expect(mockState.terminalWrite).toHaveBeenCalledWith("term-1", "sudo systemctl reload nginx\n");

      // ! quick command executes directly in terminal without calling hubRequest('start'/'reply').
      const composer = screen.getByTestId("ai-composer");
      fireEvent.change(composer, { target: { value: "!df -h" } });
      fireEvent.keyDown(composer, { key: "Enter" });
      expect(mockState.terminalWrite).toHaveBeenCalledWith("term-1", "df -h\n");
      expect(mockState.hubRequest).not.toHaveBeenCalled();

      // Pre-send DLP warning catches cloud secret and masks on Mask & Send.
      fireEvent.change(composer, { target: { value: "Check key sk-proj-abcdefghijklmnopqrstuvwxyz1234" } });
      fireEvent.keyDown(composer, { key: "Enter" });
      expect(screen.getByTestId("ai-dlp-warning")).toBeInTheDocument();
      expect(mockState.hubRequest).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Mask & Send" }));
      await waitFor(() =>
        expect(mockState.hubRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            action: "reply",
            text: "Check key [REDACTED]",
          }),
        ),
      );

      // sshs3:ask-ai calls preventDefault and populates prompt + attaches context.
      const askEvent = new CustomEvent("sshs3:ask-ai", {
        cancelable: true,
        detail: {
          sessionId: "term-1",
          label: "Selection",
          text: "nginx: [emerg] bind failed",
          prompt: "Explain this nginx error",
        },
      });
      act(() => {
        window.dispatchEvent(askEvent);
      });
      expect(askEvent.defaultPrevented).toBe(true);
      expect(screen.getByTestId("ai-composer")).toHaveValue("Explain this nginx error");
    });
  });

  describe("LandingView", () => {
    it("renders context-anchored starter cards, Privacy & AI Setup quick-connect, and SSH CA status pill", () => {
      mockState.hub = null;
      const openAiListener = vi.fn();
      window.addEventListener("sshs3:ai-open", openAiListener);

      render(
        <LandingView
          recentSSH={[]}
          onConnectRecentSSH={vi.fn()}
          onConnectSFTP={vi.fn()}
          onQuickStartTerminal={vi.fn()}
          onNewTab={vi.fn()}
          onOpenProfiles={vi.fn()}
          onNewProfile={vi.fn()}
          onOpenSyncBootstrap={vi.fn()}
          onNavigateToTabBar={vi.fn()}
          onQuickConnectSSH={vi.fn()}
          sshCaStatus={{ active: true, username: "alice", validSecondsRemaining: 1800 }}
        />,
      );

      expect(screen.getByTestId("landing-ssh-ca-pill")).toHaveTextContent("SSH CA active · alice");
      expect(screen.getByTestId("landing-starter-cards")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("starter-card-kb"));
      expect(openAiListener).toHaveBeenCalled();
      const custom = openAiListener.mock.calls[0][0] as CustomEvent<{ mode: string; view: string }>;
      expect(custom.detail).toEqual({ mode: "hub", view: "Knowledge Base" });

      fireEvent.click(screen.getByTestId("starter-card-privacy"));
      expect(screen.getByTestId("quick-connect-ai-banner")).toBeInTheDocument();
      expect(screen.getByTestId("quick-connect-ollama-btn")).toBeInTheDocument();
      expect(screen.getByTestId("quick-connect-codex-btn")).toBeInTheDocument();

      window.removeEventListener("sshs3:ai-open", openAiListener);
    });
  });

  describe("App Chrome & Per-Tab AI Dock", () => {
    it("renders SSH CA chrome indicator and keeps AI dock state per tab", async () => {
      mockState.sshCaStatus = { active: true, username: "bob", validSecondsRemaining: 3600 };

      render(<App />);

      await waitFor(() => {
        expect(screen.getByTestId("app-ssh-ca-indicator")).toHaveTextContent("CA: bob");
      });

      // Open AI panel on landing tab, then create a new terminal tab and verify its AI dock starts closed.
      fireEvent.click(screen.getByTestId("topbar-chat-toggle-btn"));
      expect(screen.getByTestId("topbar-expand-ai-btn")).toBeInTheDocument();
      expect(screen.getByTestId("ai-composer")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("landing-new-terminal-btn"));
      await waitFor(() => {
        expect(screen.queryByTestId("topbar-expand-ai-btn")).toBeNull();
      });
    });
  });
});
