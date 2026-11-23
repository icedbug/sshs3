// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { dataRuleRunsUse, Settings } from "../../src/renderer/src/components/AiHub/SettingsView";

afterEach(cleanup);

const hub = (config: Record<string, unknown> = {}): HubSnapshot =>
  ({
    config: { provider: "openai-compatible", model: "llama", baseUrl: "http://10.0.0.5:8000/v1", enabled: true, ...config },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
  }) as unknown as HubSnapshot;

type ProfileSave = Extract<HubRequest, { action: "profile-save" }>;
const profileSaves = (act: ReturnType<typeof vi.fn>): ProfileSave[] =>
  act.mock.calls.map((call) => call[0] as HubRequest).filter((request): request is ProfileSave => request.action === "profile-save");

describe("a saved model's reasoning effort", () => {
  it("can be chosen for a new saved model, with the choices of the main form, and is saved as chosen", async () => {
    const act = vi.fn(async (_request: HubRequest) => hub());
    render(<Settings hub={hub()} act={act} />);
    fireEvent.click(screen.getByTestId("add-profile-btn"));
    const form = screen.getByTestId("profile-form");
    const effort = within(form).getByLabelText("Profile reasoning effort") as HTMLSelectElement;
    // A new one starts at the middle, as before.
    expect(effort.value).toBe("medium");
    const mainChoices = Array.from((screen.getByLabelText("Reasoning Effort") as HTMLSelectElement).options).map((o) => [o.value, o.textContent]);
    expect(Array.from(effort.options).map((o) => [o.value, o.textContent])).toEqual(mainChoices);
    expect(mainChoices.map(([value]) => value)).toEqual(["low", "medium", "high"]);

    fireEvent.change(within(form).getByLabelText("Profile name"), { target: { value: "deep" } });
    fireEvent.change(within(form).getByLabelText("Profile model"), { target: { value: "qwen3:32b" } });
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.submit(form);
    await waitFor(() => expect(profileSaves(act)).toHaveLength(1));
    expect(profileSaves(act)[0].profile).toMatchObject({ name: "deep", model: "qwen3:32b", reasoningEffort: "high" });
  });

  it("shows what an existing saved model has, and keeps it when something else is changed", async () => {
    const quick = { id: "p1", name: "quick", provider: "openai-compatible", model: "small", baseUrl: "http://127.0.0.1:11434/v1", reasoningEffort: "low", zdrConfirmed: false };
    const act = vi.fn(async (_request: HubRequest) => hub({ profiles: [quick] }));
    render(<Settings hub={hub({ profiles: [quick] })} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = screen.getByTestId("profile-form");
    expect((within(form).getByLabelText("Profile reasoning effort") as HTMLSelectElement).value).toBe("low");
    fireEvent.change(within(form).getByLabelText("Profile model"), { target: { value: "small-2" } });
    fireEvent.submit(form);
    await waitFor(() => expect(profileSaves(act)).toHaveLength(1));
    expect(profileSaves(act)[0].profile).toMatchObject({ id: "p1", model: "small-2", reasoningEffort: "low" });
  });
});

describe("the data rule runs use with a saved model as the main model", () => {
  it("is the settings' rule unless that is any service, and two different strict rules are refused", () => {
    // No saved model, or one without a rule of its own: the settings' rule.
    expect(dataRuleRunsUse("standard", undefined)).toEqual({ rule: "standard", refused: false });
    expect(dataRuleRunsUse("eu-pinned", undefined)).toEqual({ rule: "eu-pinned", refused: false });
    expect(dataRuleRunsUse("local-only", "standard")).toEqual({ rule: "local-only", refused: false });
    // The settings allow any service: the saved model's own rule counts.
    expect(dataRuleRunsUse("standard", "eu-pinned")).toEqual({ rule: "eu-pinned", refused: false });
    expect(dataRuleRunsUse("standard", "local-only")).toEqual({ rule: "local-only", refused: false });
    // The same strict rule twice is one rule.
    expect(dataRuleRunsUse("eu-pinned", "eu-pinned")).toEqual({ rule: "eu-pinned", refused: false });
    // Two different strict rules: no run starts.
    expect(dataRuleRunsUse("eu-pinned", "local-only").refused).toBe(true);
    expect(dataRuleRunsUse("local-only", "eu-pinned").refused).toBe(true);
  });

  const outside = { id: "p1", name: "cloud", provider: "openai-compatible", model: "big", baseUrl: "https://api.example.com/v1", zdrConfirmed: true };

  it("the card follows the saved model's stricter rule, and says whose rule it is", () => {
    // The settings allow any service. The saved model allows this machine and the own network only, and points outside.
    const strict = { ...outside, egressPolicy: "local-only" };
    render(<Settings hub={hub({ egressPolicy: "standard", profiles: [strict], activeProfileByRole: { primary: "p1" } })} act={vi.fn()} />);
    const card = screen.getByTestId("ai-data-flow-card");
    // The field still shows the settings' own rule.
    expect((screen.getByTestId("ai-egress-policy") as HTMLSelectElement).value).toBe("standard");
    expect(within(card).getByTestId("data-flow-status-badge")).toHaveTextContent("Stopped by these settings");
    expect(within(card).getByTestId("data-flow-run-rule")).toHaveTextContent(
      'Runs follow the rule of the saved model "cloud": only this machine and your own network. These settings allow any service, so the saved model\'s own rule counts.',
    );
    expect(within(card).queryByTestId("data-flow-rule-conflict")).toBeNull();
  });

  it("the card is as before when the saved model has no rule of its own", () => {
    render(<Settings hub={hub({ egressPolicy: "standard", profiles: [outside], activeProfileByRole: { primary: "p1" } })} act={vi.fn()} />);
    const card = screen.getByTestId("ai-data-flow-card");
    expect(within(card).getByTestId("data-flow-status-badge")).toHaveTextContent("Allowed by these settings");
    expect(within(card).queryByTestId("data-flow-run-rule")).toBeNull();
    expect(within(card).queryByTestId("data-flow-rule-conflict")).toBeNull();
  });

  it("the card says runs are refused when the two rules are strict and different", () => {
    const local = { id: "p1", name: "ollama", provider: "openai-compatible", model: "qwen", baseUrl: "http://127.0.0.1:11434/v1", egressPolicy: "local-only", zdrConfirmed: false };
    render(<Settings hub={hub({ egressPolicy: "eu-pinned", profiles: [local], activeProfileByRole: { primary: "p1" } })} act={vi.fn()} />);
    const card = screen.getByTestId("ai-data-flow-card");
    expect(within(card).getByTestId("data-flow-status-badge")).toHaveTextContent("Stopped by these settings");
    expect(within(card).getByTestId("data-flow-rule-conflict")).toHaveTextContent(
      'Runs are refused. The saved model "ollama" allows only this machine and your own network, and these settings allow only services in the EU. Make the two the same, or set one of them to any service.',
    );
    expect(within(card).queryByTestId("data-flow-run-rule")).toBeNull();
  });
});
