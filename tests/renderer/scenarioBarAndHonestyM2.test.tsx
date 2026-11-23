// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot, SimulationView } from "../../src/shared/types/aiHub";
import { ScenarioBar } from "../../src/renderer/src/components/AiHub/panel/ScenarioBar";
import { ComposerFooter } from "../../src/renderer/src/components/AiHub/panel/ComposerFooter";
import { ChatThread, TeamChatCard } from "../../src/renderer/src/components/AiHub/TeamChatCard";
import { ScenariosCard } from "../../src/renderer/src/components/AiHub/ScenariosCard";
import { InfrastructureView } from "../../src/renderer/src/components/AiHub/InfrastructureView";
import type { PanelState } from "../../src/renderer/src/components/AiHub/panel/usePanelState";
import { getActiveProfileSummary } from "../../src/renderer/src/components/AiHub/panel/panelHelpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sampleScenarios: SimulationView["scenarios"] = [
  {
    id: "k8s-pvc-mount-cascade",
    title: "Kubernetes pod stuck mounting an ONTAP PVC",
    story: "Worker IP missing from ONTAP export policy.",
    target: "k8s-worker-01",
    prompt: "Find why the pod stays in ContainerCreating and restore the mount.",
    tags: ["kubernetes", "ontap", "multi-host"],
  },
  {
    id: "pg-wal-full",
    title: "The database server's disk is filling up",
    story: "The WAL gateway was decommissioned.",
    target: "pg-prod-db01",
    prompt: "Find out why /var/lib/postgresql is filling up.",
    tags: ["postgres", "disk"],
  },
];

function makePanelState(overrides: Partial<PanelState> = {}): PanelState {
  const hub = {
    demoMode: true,
    config: { enabled: true, provider: "openai", model: "placeholder-model", contextWindowTokens: 128000 },
    sessions: [],
    tasks: [],
    workspaceServers: [{ id: "demo-ssh-k8s-worker-01", name: "k8s-worker-01", host: "10.0.0.11", port: 22, username: "ops", shared: false }],
    simulation: { scenarios: sampleScenarios },
  } as unknown as HubSnapshot;

  return {
    hub,
    act: vi.fn(async () => undefined),
    mode: "hub",
    setMode: vi.fn(),
    setView: vi.fn(),
    setWorkforceTicketId: vi.fn(),
    draftMode: "assisted",
    activeProfile: getActiveProfileSummary(hub),
    setAutonomy: vi.fn(),
    setModePicked: vi.fn(),
    setConnection: vi.fn(),
    setMenu: vi.fn(),
    setSettingsOpen: vi.fn(),
    attachments: [],
    fileInput: { current: null },
    attachFileOrImage: vi.fn(),
    ...overrides,
  } as unknown as PanelState;
}

describe("Milestone 2 frontend honesty and ScenarioBar", () => {
  it("hides ScenarioBar outside demo mode and lists incidents with tags when idle in demo mode", () => {
    const nonDemo = makePanelState({ hub: { demoMode: false, simulation: { scenarios: sampleScenarios } } as unknown as HubSnapshot });
    const { container, unmount } = render(<ScenarioBar p={nonDemo} />);
    expect(container).toBeEmptyDOMElement();
    unmount();

    const p = makePanelState();
    render(<ScenarioBar p={p} />);
    const bar = screen.getByTestId("demo-scenario-bar");
    expect(bar).toHaveTextContent("Demo lab: 2 realistic incidents ready");
    fireEvent.click(screen.getByTestId("scenario-bar-picker-toggle"));
    const picker = screen.getByTestId("scenario-bar-picker");
    expect(picker).toHaveTextContent("Kubernetes pod stuck mounting an ONTAP PVC");
    expect(picker).toHaveTextContent("kubernetes");
    expect(picker).toHaveTextContent("ontap");
    fireEvent.click(screen.getByTestId("scenario-bar-start-k8s-pvc-mount-cascade"));
    expect(p.act).toHaveBeenCalledWith({ action: "sim-start", scenarioId: "k8s-pvc-mount-cascade" });
  });

  it("shows active scenario score, terminal/ticket actions, and scripted walkthrough replay in ScenarioBar", async () => {
    const dispatched: CustomEvent[] = [];
    const onSplit = (ev: Event) => dispatched.push(ev as CustomEvent);
    window.addEventListener("sshs3:open-cluster-split", onSplit);
    try {
      const running: NonNullable<SimulationView["running"]> = {
        id: "k8s-pvc-mount-cascade",
        title: "Kubernetes pod stuck mounting an ONTAP PVC",
        startedAt: 1000,
        target: "k8s-worker-01",
        ticketId: "t-k8s",
        tags: ["kubernetes", "ontap"],
        servers: [{ id: "demo-ssh-k8s-worker-01", name: "k8s-worker-01" }],
        lastReplay: {
          mode: "careful",
          ran: 9,
          at: "2026-11-23T10:00:00Z",
          lines: ["$ kubectl get pods -A", "payments-api   1/1   Running"],
        },
        checks: [
          { id: "c1", kind: "resolved", title: "Pod is running", pass: true, why: "Running" },
          { id: "c2", kind: "no-damage", title: "No force delete", pass: true, why: "Intact" },
        ],
        passed: 2,
        total: 2,
        commands: 9,
        unsupported: [],
      };
      const p = makePanelState({
        hub: {
          demoMode: true,
          sessions: [],
          workspaceServers: [{ id: "demo-ssh-k8s-worker-01", name: "k8s-worker-01", host: "10.0.0.11", port: 22, username: "ops", shared: false }],
          simulation: { scenarios: sampleScenarios, running },
        } as unknown as HubSnapshot,
      });

      render(<ScenarioBar p={p} />);
      expect(screen.getByTestId("scenario-bar-score")).toHaveTextContent("Solved");
      expect(screen.getByTestId("scenario-bar-target")).toHaveTextContent("k8s-worker-01");

      fireEvent.click(screen.getByTestId("scenario-bar-open-terminal"));
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].detail).toEqual({ serverIds: ["demo-ssh-k8s-worker-01"] });
      expect(p.setMode).toHaveBeenCalledWith("panel");

      fireEvent.click(screen.getByTestId("scenario-bar-open-ticket"));
      expect(p.setWorkforceTicketId).toHaveBeenCalledWith("t-k8s");
      expect(p.setView).toHaveBeenCalledWith("Workforce");

      fireEvent.click(screen.getByTestId("scenario-bar-checks-toggle"));
      expect(screen.getByTestId("scenario-bar-replay-transcript")).toHaveTextContent("Scripted walkthrough (no AI model): careful · 9 commands");
      fireEvent.click(screen.getByTestId("scenario-bar-replay-careful"));
      expect(p.act).toHaveBeenCalledWith({ action: "sim-replay", mode: "careful" });
      await waitFor(() => expect(screen.getByTestId("scenario-bar-replay-careless")).toBeEnabled());
      fireEvent.click(screen.getByTestId("scenario-bar-replay-careless"));
      expect(p.act).toHaveBeenCalledWith({ action: "sim-replay", mode: "careless" });
    } finally {
      window.removeEventListener("sshs3:open-cluster-split", onSplit);
    }
  });

  it("shows Demo (simulated) badge in TeamChatCard and suppresses clickable external links on simulated ChatThread", () => {
    const hub = {
      demoMode: true,
      chatSources: {
        canChange: true,
        total: 3,
        connections: [
          {
            service: "slack",
            hasToken: true,
            enabled: true,
            bot: "sshs3-bot",
            workspace: "Demo Lab",
            simulated: true,
            channels: [{ id: "C1", name: "ops", private: false, selected: true, count: 3, readingBack: false }],
          },
        ],
      },
    } as unknown as HubSnapshot;

    render(
      <>
        <TeamChatCard hub={hub} act={vi.fn(async () => undefined)} />
        <ChatThread
          simulated
          hit={{
            service: "slack",
            channelId: "C1",
            channel: "ops",
            threadId: "t1",
            at: Date.parse("2026-11-23T10:00:00Z"),
            link: "https://acme.slack.com/archives/C1/p1",
            lines: ["Sara: pod is stuck mounting PVC"],
          }}
        />
      </>,
    );

    expect(screen.getByTestId("chat-slack-demo-badge")).toHaveTextContent("Demo (simulated)");
    expect(screen.getByTestId("chat-slack-demo-note")).toHaveTextContent(/simulated locally/);
    const thread = screen.getByTestId("chat-thread");
    expect(within(thread).getByTestId("chat-thread-simulated")).toHaveTextContent("Demo (simulated Slack)");
    expect(within(thread).queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows Demo answers (no model) in ComposerFooter when no model is configured in demo mode", () => {
    const p = makePanelState();
    render(<ComposerFooter p={p} hub={p.hub!} />);
    const chip = screen.getByTestId("ai-composer-model-chip");
    expect(chip).toHaveTextContent("Demo answers (no model)");
    expect(chip).not.toHaveTextContent("placeholder-model");
  });

  it("names the model in ComposerFooter once one is set up, also in demo mode", () => {
    const hub = {
      demoMode: true,
      config: { enabled: true, provider: "openai", model: "placeholder-model", baseUrl: "https://models.example.test/v1", contextWindowTokens: 128000 },
      sessions: [],
      tasks: [],
      workspaceServers: [],
      simulation: { scenarios: sampleScenarios },
    } as unknown as HubSnapshot;
    const p = makePanelState({ hub, activeProfile: getActiveProfileSummary(hub) });
    render(<ComposerFooter p={p} hub={hub} />);
    const chip = screen.getByTestId("ai-composer-model-chip");
    expect(chip).toHaveTextContent("placeholder-model");
    expect(chip).not.toHaveTextContent("Demo answers (no model)");
  });

  it("shows tags, Open terminal, and careful/careless scripted walkthrough controls in ScenariosCard", async () => {
    const act = vi.fn(async () => undefined);
    const onOpenTerminal = vi.fn();
    const running: NonNullable<SimulationView["running"]> = {
      id: "k8s-pvc-mount-cascade",
      title: "Kubernetes pod stuck mounting an ONTAP PVC",
      startedAt: 1,
      target: "k8s-worker-01",
      tags: ["kubernetes", "ontap"],
      servers: [{ id: "demo-ssh-k8s-worker-01", name: "k8s-worker-01" }],
      lastReplay: { mode: "careless", ran: 2, at: "2026-11-23T10:00:00Z", lines: ["$ kubectl delete pod --force"] },
      checks: [{ id: "c1", kind: "resolved", title: "Pod is running", pass: false, why: "Still pending" }],
      passed: 0,
      total: 1,
      commands: 2,
      unsupported: [],
    };
    const { unmount } = render(
      <ScenariosCard
        hub={{ simulation: { scenarios: sampleScenarios, running } } as unknown as HubSnapshot}
        act={act}
        onOpenTerminal={onOpenTerminal}
      />,
    );
    expect(screen.getByTestId("scenario-running-tags")).toHaveTextContent("kubernetes");
    fireEvent.click(screen.getByTestId("scenario-open-terminal"));
    expect(onOpenTerminal).toHaveBeenCalledWith("demo-ssh-k8s-worker-01");
    fireEvent.click(screen.getByTestId("scenario-replay-careful"));
    expect(act).toHaveBeenCalledWith({ action: "sim-replay", mode: "careful" });
    await waitFor(() => expect(screen.getByTestId("scenario-replay-careless")).toBeEnabled());
    fireEvent.click(screen.getByTestId("scenario-replay-careless"));
    expect(act).toHaveBeenCalledWith({ action: "sim-replay", mode: "careless" });
    expect(screen.getByTestId("scenario-replay-transcript")).toHaveTextContent("Scripted walkthrough (no AI model): careless · 2 commands");
    unmount();

    render(<ScenariosCard hub={{ simulation: { scenarios: sampleScenarios } } as unknown as HubSnapshot} act={act} />);
    expect(screen.getByTestId("scenario-tags-k8s-pvc-mount-cascade")).toHaveTextContent("multi-host");
  });

  it("highlights active incident servers and shows Open terminal in InfrastructureView", () => {
    const onOpenTerminal = vi.fn();
    render(
      <InfrastructureView
        hub={
          {
            demoMode: true,
            sessions: [],
            inventory: [],
            kbPages: [],
            infraEdges: [],
            workspaceServers: [
              { id: "demo-ssh-k8s-worker-01", name: "k8s-worker-01", host: "10.0.0.11", port: 22, username: "ops", shared: false },
            ],
            simulation: {
              scenarios: sampleScenarios,
              running: {
                id: "k8s-pvc-mount-cascade",
                title: "Kubernetes pod stuck mounting an ONTAP PVC",
                startedAt: 1,
                target: "k8s-worker-01",
                servers: [{ id: "demo-ssh-k8s-worker-01", name: "k8s-worker-01" }],
                checks: [],
                passed: 0,
                total: 1,
                commands: 0,
                unsupported: [],
              },
            },
          } as unknown as HubSnapshot
        }
        act={vi.fn(async () => undefined)}
        busy={false}
        onAsk={() => {}}
        onUseTerminal={() => {}}
        onOpenTerminal={onOpenTerminal}
      />,
    );

    expect(screen.getByTestId("infra-incident-badge-demo-ssh-k8s-worker-01")).toHaveTextContent("Active incident");
    fireEvent.click(screen.getByTestId("infra-open-terminal-demo-ssh-k8s-worker-01"));
    expect(onOpenTerminal).toHaveBeenCalledWith("demo-ssh-k8s-worker-01");
  });
});
