// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { AgentsAndMcpView } from "../../src/renderer/src/components/AiHub/AgentsAndMcpView";
import type { Act } from "../../src/renderer/src/components/AiHub/panelShared";

afterEach(cleanup);

const baseHub = (overrides: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    config: { enabled: true, provider: "anthropic", model: "m", useHermes: false, hasApiKey: false, egressPolicy: "standard", zdrConfirmed: false, piiScrubbing: "standard", profiles: [], activeProfileByRole: {} },
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
    externalRunners: [],
    ...overrides,
  }) as unknown as HubSnapshot;

type RunnerSave = Extract<HubRequest, { action: "runner-save" }>;
const acting = (hub: HubSnapshot): Mock<Act> => vi.fn<Act>().mockResolvedValue(hub);
const saves = (act: Mock<Act>): RunnerSave[] =>
  act.mock.calls.map((call) => call[0]).filter((request): request is RunnerSave => request.action === "runner-save");

const view = (hub: HubSnapshot, act: Mock<Act>): void => {
  render(<AgentsAndMcpView hub={hub} act={act} selectedAgentId="" onSelectAgentForChat={vi.fn()} onStartedMission={vi.fn()} />);
};

const fill = (form: HTMLElement): void => {
  fireEvent.change(within(form).getByPlaceholderText("Claude Code"), { target: { value: "Claude Code" } });
  fireEvent.change(within(form).getByPlaceholderText("npx"), { target: { value: "npx" } });
  fireEvent.change(within(form).getByPlaceholderText("/home/you/code/the-product"), { target: { value: "/code" } });
};

describe("the environment variables an external agent is given", () => {
  it("has a field for names in the form, and says what it is for", () => {
    view(baseHub(), acting(baseHub()));
    fireEvent.click(screen.getByRole("button", { name: "Add an agent" }));
    const form = screen.getByTestId("runner-form");
    const field = within(form).getByLabelText("Environment variables to pass");
    expect(field).toHaveValue("");
    expect(form).toHaveTextContent("Environment variables to pass (names only, never values)");
    expect(form).toHaveTextContent(
      "Names of variables the program is given on top of the basic ones, separated by commas or spaces: a key the agent reads from the environment, such as ANTHROPIC_API_KEY, must be named here.",
    );
    // The page no longer sends the person to the assistant for it.
    expect(document.body.textContent).not.toContain("ask the assistant to add it");
  });

  it("saves the names that were typed, each once", async () => {
    const hub = baseHub();
    const act = acting(hub);
    view(hub, act);
    fireEvent.click(screen.getByRole("button", { name: "Add an agent" }));
    const form = screen.getByTestId("runner-form");
    fill(form);
    fireEvent.change(within(form).getByLabelText("Environment variables to pass"), { target: { value: "ANTHROPIC_API_KEY, OPENAI_API_KEY ANTHROPIC_API_KEY" } });
    fireEvent.submit(form);
    await waitFor(() => expect(saves(act)).toHaveLength(1));
    expect(saves(act)[0].runner).toMatchObject({ name: "Claude Code", command: "npx", cwd: "/code", env: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] });
  });

  it("shows the names an agent already has, lets them be changed, and takes them away when the field is emptied", async () => {
    const hub = baseHub({ externalRunners: [{ id: "r1", name: "Claude Code", command: "npx", args: ["-y", "x"], cwd: "/code", env: ["ANTHROPIC_API_KEY", "GH_TOKEN"], updatedAt: 1 }] });
    const act = acting(hub);
    view(hub, act);
    // On the card: the names, and nothing that could be a value.
    expect(screen.getByTestId("runner-env-r1")).toHaveTextContent("Also given: ANTHROPIC_API_KEY, GH_TOKEN");

    fireEvent.click(within(screen.getByTestId("runner-r1")).getByRole("button", { name: "Edit" }));
    const form = screen.getByTestId("runner-form");
    const field = within(form).getByLabelText("Environment variables to pass");
    expect(field).toHaveValue("ANTHROPIC_API_KEY, GH_TOKEN");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.submit(form);
    await waitFor(() => expect(saves(act)).toHaveLength(1));
    // An empty list is sent, not left out: left out, the hub would keep the names it had.
    expect(saves(act)[0].runner.env).toEqual([]);
  });

  it("an agent without names has no line about them on its card", () => {
    view(baseHub({ externalRunners: [{ id: "r1", name: "Claude Code", command: "npx", args: [], cwd: "/code", updatedAt: 1 }] }), acting(baseHub()));
    expect(screen.queryByTestId("runner-env-r1")).toBeNull();
  });

  it("does not save a text the hub would drop a part of, and says which part", async () => {
    const hub = baseHub();
    const act = acting(hub);
    view(hub, act);
    fireEvent.click(screen.getByRole("button", { name: "Add an agent" }));
    const form = screen.getByTestId("runner-form");
    fill(form);
    const field = within(form).getByLabelText("Environment variables to pass");

    fireEvent.change(field, { target: { value: "ANTHROPIC_API_KEY SSH_AUTH_SOCK" } });
    expect(within(form).getByTestId("runner-env-problem")).toHaveTextContent("Never passed to an external agent: SSH_AUTH_SOCK.");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.submit(form);
    await Promise.resolve();
    expect(saves(act)).toEqual([]);

    // A value pasted with the name: refused, and the value is not repeated in the message.
    fireEvent.change(field, { target: { value: "ANTHROPIC_API_KEY=sk-ant-not-a-real-key-0123456789" } }); // pragma: allowlist secret
    expect(within(form).getByTestId("runner-env-problem")).toHaveTextContent('Type the name only, without "=" and a value (ANTHROPIC_API_KEY).');
    expect(within(form).getByTestId("runner-env-problem")).not.toHaveTextContent("sk-ant");
    fireEvent.submit(form);
    await Promise.resolve();
    expect(saves(act)).toEqual([]);

    // Put right, it saves.
    fireEvent.change(field, { target: { value: "ANTHROPIC_API_KEY" } });
    expect(within(form).queryByTestId("runner-env-problem")).toBeNull();
    fireEvent.submit(form);
    await waitFor(() => expect(saves(act)).toHaveLength(1));
    expect(saves(act)[0].runner.env).toEqual(["ANTHROPIC_API_KEY"]);
  });
});
