// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubRequest, HubSnapshot } from "../../src/shared/types/aiHub";
import { savedConfigForm, Settings } from "../../src/renderer/src/components/AiHub/SettingsView";

afterEach(cleanup);

const hub = (config: Record<string, unknown> = {}): HubSnapshot =>
  ({
    config: { provider: "openai-compatible", model: "llama", baseUrl: "http://10.0.0.5:8000/v1", enabled: true, ...config },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
  }) as unknown as HubSnapshot;

describe("the AI settings and the old limit on tool turns", () => {
  it("the form does not hold it, also when an older saved configuration still has it", () => {
    const form = savedConfigForm(hub({ maxToolTurns: 30 }).config, undefined);
    expect("maxToolTurns" in form).toBe(false);
    // What is a setting is still there.
    expect(form).toMatchObject({ maxOutputTokens: 8192, reasoningEffort: "medium" });
  });

  it("saving the settings does not send it", async () => {
    const first = hub({ maxToolTurns: 30 });
    const act = vi.fn(async (_request: HubRequest) => first);
    render(<Settings hub={first} act={act} />);
    fireEvent.change(screen.getByLabelText("Your name in the team's activity"), { target: { value: "Kim" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(act).toHaveBeenCalled());
    const sent = act.mock.calls[0][0] as Extract<HubRequest, { action: "configure" }>;
    expect(sent.action).toBe("configure");
    expect(sent.config).toMatchObject({ actorName: "Kim", maxOutputTokens: 8192 });
    expect("maxToolTurns" in sent.config).toBe(false);
    // Nothing in the settings mentions a limit on turns.
    expect(document.body.textContent).not.toMatch(/tool turns|turn limit/i);
  });
});
