// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";

let fixture: HubSnapshot | null = null;
const request = vi.fn();
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => "",
  selectAiTerminal: () => {},
  hubRequest: (...args: unknown[]) => request(...args),
  onAiHubDelta: vi.fn(() => () => {}),
}));

import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";
import type { Act } from "../../src/renderer/src/components/AiHub/panelShared";
import { NotificationsCard } from "../../src/renderer/src/components/AiHub/NotificationsCard";
import { SafetyPolicyCard } from "../../src/renderer/src/components/AiHub/SafetyPolicyCard";
import { Settings } from "../../src/renderer/src/components/AiHub/SettingsView";
import { LandingView } from "../../src/renderer/src/components/LandingView";

const makeHub = (overrides: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    config: {
      enabled: true,
      provider: "anthropic",
      model: "claude-opus-5-5",
      useHermes: false,
      hasApiKey: false,
      profiles: [],
      activeProfileByRole: {},
    },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
    memories: [],
    schedules: [],
    inventory: [],
    agents: [],
    mcpServers: [],
    rules: [],
    evalCases: [],
    ...overrides,
  }) as unknown as HubSnapshot;

beforeEach(() => {
  request.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  fixture = null;
});
afterEach(cleanup);

const modelId = (): HTMLInputElement => screen.getByLabelText("Model ID") as HTMLInputElement;
const providerSelect = (): HTMLElement => screen.getAllByLabelText("Provider")[0];

describe("settings: the model follows the provider", () => {
  it("clears another provider's model under OpenAI-compatible and shows the placeholder", () => {
    render(<Settings hub={makeHub()} act={vi.fn()} />);
    expect(modelId()).toHaveValue("claude-opus-5-5");
    fireEvent.change(providerSelect(), { target: { value: "openai-compatible" } });
    expect(modelId()).toHaveValue("");
    expect(modelId()).toHaveAttribute("placeholder", "Model offered by your endpoint");
  });

  it("sets the Anthropic default when the model is not one of Anthropic's", () => {
    const hub = makeHub();
    hub.config.provider = "openai-compatible";
    hub.config.model = "qwen2.5-coder:14b";
    render(<Settings hub={hub} act={vi.fn()} />);
    fireEvent.change(providerSelect(), { target: { value: "anthropic" } });
    expect(modelId()).toHaveValue("claude-opus-5-5");
    // Back on the saved provider, its saved model is there again.
    fireEvent.change(providerSelect(), { target: { value: "openai-compatible" } });
    expect(modelId()).toHaveValue("qwen2.5-coder:14b");
  });

  it("keeps a model the new provider knows", () => {
    const hub = makeHub();
    hub.config.provider = "openai-compatible";
    hub.config.model = "claude-sonnet-5-5";
    render(<Settings hub={hub} act={vi.fn()} />);
    fireEvent.change(providerSelect(), { target: { value: "anthropic" } });
    expect(modelId()).toHaveValue("claude-sonnet-5-5");
  });
});

describe("settings: the name in the team's activity", () => {
  it("says which name is signed with when the field is empty", () => {
    render(<Settings hub={makeHub({ signsAs: "Sofia" })} act={vi.fn()} />);
    const field = screen.getByLabelText("Your name in the team's activity");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "Signs as Sofia");
  });

  it("falls back to Your name", () => {
    render(<Settings hub={makeHub()} act={vi.fn()} />);
    expect(screen.getByLabelText("Your name in the team's activity")).toHaveAttribute("placeholder", "Your name");
  });
});

describe("settings: the save bar is not over the scrolling part", () => {
  it("keeps the save bar outside the scrolling area, with every section inside it", () => {
    const { container } = render(<Settings hub={makeHub()} act={vi.fn()} />);
    const scroll = container.querySelector("form > .ai-scroll");
    const bar = container.querySelector("form > .ai-set-save");
    expect(scroll).not.toBeNull();
    expect(bar).not.toBeNull();
    expect(bar).toContainElement(screen.getByRole("button", { name: "Save settings" }));
    expect(container.querySelectorAll(".ai-scroll .ai-set-save")).toHaveLength(0);
    expect(scroll).toContainElement(screen.getByText("Restore built-in agents, runbooks and skills"));
  });
});

describe("notification channels: Enter adds the channel", () => {
  const openEditor = (act: Act): void => {
    render(<Settings hub={makeHub()} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a channel" }));
  };
  // What a browser does with Enter in a field of a form, unless the key was handled.
  const pressEnter = (field: HTMLElement): void => {
    const notHandled = fireEvent.keyDown(field, { key: "Enter" });
    if (notHandled) fireEvent.submit(field.closest("form")!);
  };

  it("adds the channel and does not save the settings", async () => {
    const act = vi.fn(async (_req: HubRequest) => makeHub());
    openEditor(act);
    fireEvent.change(screen.getByLabelText("Channel name"), { target: { value: "#ops" } });
    const address = screen.getByLabelText("Channel address");
    fireEvent.change(address, { target: { value: "https://hooks.slack.com/services/x" } });
    pressEnter(address);
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(act.mock.calls[0][0]).toMatchObject({
      action: "notify-channel-save",
      channel: { name: "#ops", url: "https://hooks.slack.com/services/x" },
    });
    expect(screen.queryByText("Settings saved.")).not.toBeInTheDocument();
  });

  it("does nothing while Add channel is disabled, and still does not save the settings", () => {
    const act = vi.fn(async (_req: HubRequest) => makeHub());
    openEditor(act);
    expect(screen.getByRole("button", { name: "Add channel" })).toBeDisabled();
    pressEnter(screen.getByLabelText("Channel name"));
    expect(act).not.toHaveBeenCalled();
  });

  it("works on the card alone as well", async () => {
    const act = vi.fn(async (_req: HubRequest) => makeHub());
    render(<NotificationsCard hub={makeHub()} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a channel" }));
    fireEvent.change(screen.getByLabelText("Channel address"), { target: { value: "https://ntfy.sh/t" } });
    fireEvent.keyDown(screen.getByLabelText("Channel name"), { key: "Enter" });
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  });
});

describe("safety: two-person approval in a new override", () => {
  const peerBox = (): HTMLElement =>
    within(screen.getByTestId("cluster-policy-form")).getByRole("checkbox", { name: /two-person peer approval/ });

  it("is unticked where nobody else can approve", () => {
    render(<SafetyPolicyCard hub={makeHub()} act={vi.fn()} />);
    fireEvent.click(screen.getByTestId("add-cluster-policy-btn"));
    expect(peerBox()).not.toBeChecked();
    expect(screen.getByText(/Needs a team server with a second account/)).toBeInTheDocument();
  });

  it("is unticked when the flag is false", () => {
    render(<SafetyPolicyCard hub={makeHub({ peerApprovalPossible: false })} act={vi.fn()} />);
    fireEvent.click(screen.getByTestId("add-cluster-policy-btn"));
    expect(peerBox()).not.toBeChecked();
  });

  it("is ticked where a second person can approve", () => {
    render(<SafetyPolicyCard hub={makeHub({ peerApprovalPossible: true })} act={vi.fn()} />);
    fireEvent.click(screen.getByTestId("add-cluster-policy-btn"));
    expect(peerBox()).toBeChecked();
  });
});

function Harness() {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">("panel");
  return <AiHubPanel mode={mode} setMode={setMode} />;
}
const agentPill = (name: string): HTMLElement => screen.getByRole("button", { name: new RegExp(name) });

describe("panel: a new conversation starts empty", () => {
  beforeEach(() => {
    fixture = makeHub({
      agents: [{ id: "dba", name: "Database helper", defaultMode: "advice" }],
    } as unknown as Partial<HubSnapshot>);
    request.mockImplementation(async () => fixture);
  });

  it("clears the draft and the chosen agent when the event brings neither", () => {
    render(<Harness />);
    fireEvent(window, new CustomEvent("sshs3:ai-open", { detail: { agentId: "dba", prompt: "old draft" } }));
    expect(screen.getByTestId("ai-composer")).toHaveValue("old draft");
    expect(agentPill("Database helper")).toHaveClass("active");

    fireEvent(window, new CustomEvent("sshs3:ai-open", { detail: { newTask: true } }));
    expect(screen.getByTestId("ai-composer")).toHaveValue("");
    expect(agentPill("Database helper")).not.toHaveClass("active");
  });

  it("uses the prompt and the agent the event carries", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("ai-composer"), { target: { value: "old draft" } });
    fireEvent(
      window,
      new CustomEvent("sshs3:ai-open", { detail: { newTask: true, agentId: "dba", prompt: "Check the disk" } }),
    );
    expect(screen.getByTestId("ai-composer")).toHaveValue("Check the disk");
    expect(agentPill("Database helper")).toHaveClass("active");
  });

  it("keeps the draft when the event does not start a new conversation", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("ai-composer"), { target: { value: "half written" } });
    fireEvent(window, new CustomEvent("sshs3:ai-open"));
    expect(screen.getByTestId("ai-composer")).toHaveValue("half written");
  });
});

describe("panel: a failed check is an error, and a settings error goes with the settings", () => {
  it("shows a failed Local Ollama check in the error banner, not as a note", async () => {
    fixture = makeHub();
    fixture.config.enabled = false;
    request.mockImplementation(async (req: { action: string }) =>
      req.action === "ai-probe" ? { ...fixture, reply: { probe: { ok: false, detail: "Nothing answered." } } } : fixture,
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Local Ollama/ }));
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Nothing answered.");
    expect(banner).toHaveClass("ai-error");
    expect(banner).not.toHaveClass("ai-notice");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears the error when the settings dialog closes", async () => {
    fixture = makeHub();
    request.mockImplementation(async (req: { action: string }) => {
      if (req.action === "notify-channel-save") throw new Error("example.invalid could not be found.");
      return fixture;
    });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("ai-profile-badge"));
    const dialog = screen.getByRole("dialog", { name: "AI settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add a channel" }));
    fireEvent.change(within(dialog).getByLabelText("Channel address"), {
      target: { value: "https://example.invalid/hook" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add channel" }));
    expect((await screen.findAllByText("example.invalid could not be found.")).length).toBeGreaterThan(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close AI settings" }));
    expect(screen.queryByRole("dialog", { name: "AI settings" })).not.toBeInTheDocument();
    expect(screen.queryByText("example.invalid could not be found.")).not.toBeInTheDocument();
  });
});

describe("start page: a failed Local Ollama check is not green", () => {
  const renderLanding = (): void => {
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
      />,
    );
    fireEvent.click(screen.getByTestId("starter-card-privacy"));
  };

  it("shows the failure as an alert in the error colour", async () => {
    request.mockImplementation(async (req: { action: string }) =>
      req.action === "ai-probe" ? { reply: { probe: { ok: false, detail: "Nothing answered." } } } : {},
    );
    renderLanding();
    fireEvent.click(screen.getByTestId("quick-connect-ollama-btn"));
    const note = await screen.findByTestId("quick-ai-notice");
    expect(note).toHaveTextContent("Nothing answered.");
    expect(note).toHaveAttribute("role", "alert");
    expect(note.className).toContain("text-rose-300");
    expect(note.className).not.toContain("emerald");
    expect(request.mock.calls.map((c) => c[0].action)).toEqual(["ai-probe"]);
  });

  it("shows a success in green", async () => {
    request.mockImplementation(async (req: { action: string }) =>
      req.action === "ai-probe" ? { reply: { probe: { ok: true, detail: "Answers.", models: ["phi4"] } } } : {},
    );
    renderLanding();
    fireEvent.click(screen.getByTestId("quick-connect-ollama-btn"));
    const note = await screen.findByTestId("quick-ai-notice");
    expect(note).toHaveTextContent("Connected to local Ollama. Model: phi4.");
    expect(note).toHaveAttribute("role", "status");
    expect(note.className).toContain("text-emerald-300");
  });
});
