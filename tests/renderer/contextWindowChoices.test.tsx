// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { Settings } from "../../src/renderer/src/components/AiHub/SettingsView";

afterEach(cleanup);

const hub = (config: Record<string, unknown> = {}): HubSnapshot =>
  ({
    config: { provider: "openai-compatible", model: "llama", baseUrl: "http://10.0.0.5:8000/v1", enabled: true, ...config },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
  }) as unknown as HubSnapshot;

const field = (): HTMLSelectElement => screen.getByLabelText("Max Context Window") as HTMLSelectElement;
const choices = (): string[] => Array.from(field().options).map((option) => option.textContent ?? "");

describe("the context window in the AI settings", () => {
  it("offers only windows an agent can run in: 16k is not among them", () => {
    render(<Settings hub={hub()} act={vi.fn()} />);
    expect(choices()).toEqual(["33k tokens", "66k tokens", "128k tokens (default)", "256k tokens", "900k tokens"]);
    expect(field().value).toBe("128000");
    expect(screen.queryByTestId("context-window-too-small")).toBeNull();
  });

  it("keeps a 16k saved earlier as itself, says agents need more, and lets the person leave it", () => {
    render(<Settings hub={hub({ contextWindowTokens: 16384 })} act={vi.fn()} />);
    // The field shows what is saved, not the first choice of the list.
    expect(field().value).toBe("16384");
    expect(choices()[0]).toBe("16k tokens (saved earlier)");
    expect(screen.getByTestId("context-window-too-small")).toHaveTextContent(
      "Agents need more than this: their tools and instructions take most or all of it, and a run that does not fit ends at once. Choose 33k tokens or more.",
    );

    fireEvent.change(field(), { target: { value: "32768" } });
    expect(field().value).toBe("32768");
    expect(screen.queryByTestId("context-window-too-small")).toBeNull();
    // Until it is saved the old value can still be chosen again, and only as itself.
    expect(choices()).toEqual(["16k tokens (saved earlier)", "33k tokens", "66k tokens", "128k tokens (default)", "256k tokens", "900k tokens"]);
  });

  it("shows a larger value that is not on the list as itself, without the note", () => {
    render(<Settings hub={hub({ contextWindowTokens: 200000 })} act={vi.fn()} />);
    expect(field().value).toBe("200000");
    expect(choices()).toEqual(["33k tokens", "66k tokens", "128k tokens (default)", "200k tokens (saved earlier)", "256k tokens", "900k tokens"]);
    expect(screen.queryByTestId("context-window-too-small")).toBeNull();
  });
});
