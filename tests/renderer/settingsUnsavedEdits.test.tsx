// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { roleDefaultLabel, savedConfigForm, Settings } from "../../src/renderer/src/components/AiHub/SettingsView";

afterEach(cleanup);

const hub = (config: Record<string, unknown> = {}, preferences: Record<string, unknown> = {}): HubSnapshot =>
  ({
    config: { provider: "openai-compatible", model: "llama", baseUrl: "http://10.0.0.5:8000/v1", enabled: true, ...config },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30, ...preferences },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
  }) as unknown as HubSnapshot;

const modelField = (): HTMLInputElement => screen.getByLabelText("Model ID", { selector: "input:not([aria-label])" }) as HTMLInputElement;
const requests = (act: ReturnType<typeof vi.fn>): HubRequest[] => act.mock.calls.map((c) => c[0] as HubRequest);
const local = { id: "p1", name: "local", provider: "openai-compatible", model: "qwen", baseUrl: "http://127.0.0.1:11434/v1", reasoningEffort: "medium", zdrConfirmed: false };

describe("AI settings: an edit that is not saved survives a refresh of the app's state", () => {
  it("keeps a ticked box and a typed number when the same state arrives again", () => {
    const first = hub();
    const view = render(<Settings hub={first} act={vi.fn()} />);
    const box = screen.getByLabelText(/Check every 5 minutes/) as HTMLInputElement;
    fireEvent.click(box);
    const days = screen.getByLabelText(/Keep conversations and terminal history/) as HTMLInputElement;
    fireEvent.change(days, { target: { value: "90" } });
    // The same content as a new object: what every refresh delivers.
    view.rerender(<Settings hub={structuredClone(first)} act={vi.fn()} />);
    expect({ checked: box.checked, days: days.value }).toEqual({ checked: true, days: "90" });
  });

  it("keeps a typed model id when a saved model is chosen for another kind of work", () => {
    const first = hub({ profiles: [local], activeProfileByRole: { fastTriage: "p1" } });
    const view = render(<Settings hub={first} act={vi.fn()} />);
    fireEvent.change(modelField(), { target: { value: "new-model" } });
    view.rerender(<Settings hub={structuredClone(first)} act={vi.fn()} />);
    expect(modelField().value).toBe("new-model");
  });

  it("saves what was typed, not the old value, after a refresh in between", async () => {
    const first = hub();
    const act = vi.fn(async (_r: HubRequest) => first);
    const view = render(<Settings hub={first} act={act} />);
    fireEvent.change(modelField(), { target: { value: "new-model" } });
    fireEvent.change(screen.getByLabelText("Your name in the team's activity"), { target: { value: "Kim" } });
    view.rerender(<Settings hub={structuredClone(first)} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(act).toHaveBeenCalled());
    const sent = requests(act)[0] as Extract<HubRequest, { action: "configure" }>;
    expect(sent.config).toMatchObject({ model: "new-model", actorName: "Kim" });
  });

  it("shows a value that was saved elsewhere in a field the person has not touched, and keeps the touched one", () => {
    const first = hub({ fastModel: "small-1" });
    const view = render(<Settings hub={first} act={vi.fn()} />);
    fireEvent.change(modelField(), { target: { value: "mine" } });
    view.rerender(<Settings hub={hub({ fastModel: "small-2", model: "theirs" })} act={vi.fn()} />);
    expect((screen.getByTestId("ai-fast-model-input") as HTMLInputElement).value).toBe("small-2");
    expect(modelField().value).toBe("mine");
  });

  it("follows the saved values again once the form was saved", async () => {
    const first = hub();
    const act = vi.fn(async (_r: HubRequest) => first);
    const view = render(<Settings hub={first} act={act} />);
    fireEvent.change(modelField(), { target: { value: " typed " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await screen.findByText("Settings saved.");
    // The app saved it trimmed: the field shows what is saved.
    view.rerender(<Settings hub={hub({ model: "typed" })} act={act} />);
    expect(modelField().value).toBe("typed");
  });

  it("tells whether it holds edits that are not saved", async () => {
    const first = hub();
    const onUnsavedChange = vi.fn();
    const act = vi.fn(async (_r: HubRequest) => first);
    render(<Settings hub={first} act={act} onUnsavedChange={onUnsavedChange} />);
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(modelField(), { target: { value: "x" } });
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    // Typed back to what is saved: nothing is unsaved.
    fireEvent.change(modelField(), { target: { value: "llama" } });
    expect(onUnsavedChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByLabelText(/Check every 5 minutes/));
    expect(onUnsavedChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(false));
  });

  it("does not save without a model id, and says so", () => {
    const act = vi.fn(async (_r: HubRequest) => hub());
    render(<Settings hub={hub()} act={act} />);
    fireEvent.change(modelField(), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(act).not.toHaveBeenCalled();
    expect(screen.getByTestId("ai-settings-save-error")).toHaveTextContent("Enter a model ID first.");
  });
});

describe("AI settings: the Model fields are what runs use", () => {
  const withMain = (): HubSnapshot =>
    hub({ model: "old-model", baseUrl: "http://old.example/v1", profiles: [local, { ...local, id: "p2", name: "cloud", provider: "anthropic", model: "claude-x", baseUrl: undefined }], activeProfileByRole: { primary: "p1" } });

  it("shows the saved model that is chosen for the chat and the agents, not the older fields", () => {
    render(<Settings hub={withMain()} act={vi.fn()} />);
    expect(modelField().value).toBe("qwen");
    expect((screen.getByLabelText("Endpoint") as HTMLInputElement).value).toBe("http://127.0.0.1:11434/v1");
    expect(screen.getByTestId("ai-main-profile-note")).toHaveTextContent("The chat and the agents use the saved model “local”.");
  });

  it("saves a change of the model to that saved model, and leaves the older fields to the app", async () => {
    const first = withMain();
    const act = vi.fn(async (_r: HubRequest) => first);
    render(<Settings hub={first} act={act} />);
    fireEvent.change(modelField(), { target: { value: "qwen-big" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(2));
    const [profile, configure] = requests(act) as [Extract<HubRequest, { action: "profile-save" }>, Extract<HubRequest, { action: "configure" }>];
    expect(profile.action).toBe("profile-save");
    expect(profile.profile).toMatchObject({ id: "p1", name: "local", provider: "openai-compatible", model: "qwen-big", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(profile).not.toHaveProperty("apiKey");
    expect(configure.action).toBe("configure");
    expect(configure.config).not.toHaveProperty("model");
    expect(configure.config).not.toHaveProperty("provider");
    expect(configure.config).not.toHaveProperty("baseUrl");
    expect(configure.config.activeProfileByRole).toEqual({ primary: "p1" });
  });

  it("does not touch the saved model when only other settings changed", async () => {
    const first = withMain();
    const act = vi.fn(async (_r: HubRequest) => first);
    render(<Settings hub={first} act={act} />);
    fireEvent.change(screen.getByTestId("ai-fast-model-input"), { target: { value: "small" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(requests(act)[0].action).toBe("configure");
  });

  it("sends a typed key to the saved model, and stops when the saved model could not be saved", async () => {
    const first = withMain();
    const act = vi.fn(async (_r: HubRequest) => undefined);
    render(<Settings hub={first} act={act} />);
    fireEvent.change(screen.getByLabelText(/^API key/), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(requests(act)[0]).toMatchObject({ action: "profile-save", apiKey: "sk-test" });
    // It failed: nothing else was sent, and the key is still in the field.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled());
    expect(act).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText(/^API key/) as HTMLInputElement).value).toBe("sk-test");
  });

  it("shows another saved model's fields when it is chosen as the main model, and drops what was typed for the old one", () => {
    render(<Settings hub={withMain()} act={vi.fn()} />);
    fireEvent.change(modelField(), { target: { value: "typed-for-local" } });
    fireEvent.change(screen.getByTestId("role-select-primary"), { target: { value: "p2" } });
    expect(modelField().value).toBe("claude-x");
    expect(screen.getByTestId("ai-main-profile-note")).toHaveTextContent("“cloud”");
    // No saved model: the settings' own fields are the main model again.
    fireEvent.change(screen.getByTestId("role-select-primary"), { target: { value: "" } });
    expect(modelField().value).toBe("old-model");
    expect(screen.queryByTestId("ai-main-profile-note")).toBeNull();
  });

  it("labels a kind of work without a saved model by what it really uses", () => {
    render(<Settings hub={withMain()} act={vi.fn()} />);
    const fast = within(screen.getByTestId("role-select-fastTriage")).getAllByRole("option")[0];
    expect(fast).toHaveTextContent("Same as the main model: local (qwen)");
    expect(fast).not.toHaveTextContent("old-model");
    expect(within(screen.getByTestId("role-select-primary")).getAllByRole("option")[0]).toHaveTextContent("No saved model: the fields under Model");
  });
});

describe("roleDefaultLabel and savedConfigForm", () => {
  const main = { provider: "openai-compatible" as const, model: "llama", fastModel: "", embeddingModel: "" };
  it("names the model for background work when one is set", () => {
    expect(roleDefaultLabel("backgroundDistill", { ...main, fastModel: "small" })).toBe("The model for background work (small)");
    expect(roleDefaultLabel("fastTriage", main)).toBe("Same as the main model (llama)");
  });
  it("says the search uses words only without an embedding model", () => {
    expect(roleDefaultLabel("embedding", main)).toBe("No model: the search matches words only");
    expect(roleDefaultLabel("embedding", { ...main, embeddingModel: "nomic" })).toBe("The embedding model under Model (nomic)");
    expect(roleDefaultLabel("embedding", { ...main, provider: "anthropic", embeddingModel: "nomic" })).toBe("No model: the search matches words only");
  });
  it("takes the main model's fields from the saved model when one is chosen", () => {
    const config = hub({ model: "old", reasoningEffort: "high" }).config;
    expect(savedConfigForm(config, undefined)).toMatchObject({ model: "old", url: "http://10.0.0.5:8000/v1", reasoningEffort: "high" });
    expect(savedConfigForm(config, { id: "p", name: "n", provider: "anthropic", model: "claude-x", updatedAt: 1 })).toMatchObject({ provider: "anthropic", model: "claude-x", url: "", apiProtocol: "auto", reasoningEffort: "high" });
  });
});

describe("AI settings: Enter in a card saves that card, not the main form", () => {
  it("has no form around the settings, so no field of a card belongs to the main form", () => {
    const { container } = render(<Settings hub={hub()} act={vi.fn()} />);
    fireEvent.click(screen.getByTestId("add-profile-btn"));
    expect(container.querySelector("form.ai-settings-form")).toBeNull();
    const profileForm = screen.getByTestId("profile-form");
    expect(profileForm.tagName).toBe("FORM");
    for (const label of ["Profile name", "Profile model", "Profile API key"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).form).toBe(profileForm);
    }
  });

  it("Enter in the profile editor saves the profile and not the settings", async () => {
    const act = vi.fn(async (_r: HubRequest) => hub());
    render(<Settings hub={hub()} act={act} />);
    fireEvent.click(screen.getByTestId("add-profile-btn"));
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "ollama" } });
    fireEvent.change(screen.getByLabelText("Profile model"), { target: { value: "qwen3" } });
    const field = screen.getByLabelText("Profile model");
    // What a browser does with Enter in a field of a form, unless the key was handled.
    if (fireEvent.keyDown(field, { key: "Enter" })) fireEvent.submit(screen.getByTestId("profile-form"));
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(requests(act)[0]).toMatchObject({ action: "profile-save", profile: { name: "ollama", model: "qwen3" } });
  });

  it("Enter in a text field of the main form still saves the settings", async () => {
    const act = vi.fn(async (_r: HubRequest) => hub());
    render(<Settings hub={hub()} act={act} />);
    fireEvent.change(modelField(), { target: { value: "new-model" } });
    fireEvent.keyDown(modelField(), { key: "Enter" });
    await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
    expect(requests(act)[0]).toMatchObject({ action: "configure", config: { model: "new-model" } });
  });

  it("Enter in a card's field does not save the settings", () => {
    const act = vi.fn(async (_r: HubRequest) => hub());
    render(<Settings hub={hub()} act={act} />);
    fireEvent.click(screen.getByRole("button", { name: "Add a channel" }));
    for (const label of ["Channel name", "Public address"]) {
      const field = screen.queryByLabelText(label);
      if (!field) continue;
      fireEvent.keyDown(field, { key: "Enter" });
    }
    expect(requests(act).filter((r) => r.action === "configure")).toEqual([]);
  });
});
