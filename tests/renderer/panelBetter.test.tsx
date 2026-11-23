// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { signInErrorText } from "../../src/renderer/src/components/WebAuthGate";

let fixture: HubSnapshot;
vi.mock("../../src/renderer/src/lib/aiHub", () => ({
  useHub: () => fixture,
  useSelectedTerminal: () => "",
  selectAiTerminal: () => {},
  hubRequest: async () => fixture,
  onAiHubDelta: vi.fn(() => () => {}),
}));
import { AiHubPanel } from "../../src/renderer/src/components/AiHub/AiHubPanel";

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  fixture = {
    config: { enabled: true, provider: "openai-compatible", model: "local", useHermes: false, hasApiKey: false, baseUrl: "http://localhost:11434/v1" },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: true },
    sessions: [], tasks: [], inventory: [], memories: [], schedules: [], infraEdges: [], workTickets: [],
  } as unknown as HubSnapshot;
});
afterEach(cleanup);

function Harness({ onWidth }: { onWidth?: (w: number) => void }): JSX.Element {
  const [mode, setMode] = useState<"panel" | "hub" | "closed">("panel");
  const [width, setWidth] = useState(420);
  return (
    <AiHubPanel
      mode={mode}
      setMode={setMode}
      width={width}
      onResizeWidth={(w) => {
        setWidth(w);
        onWidth?.(w);
      }}
    />
  );
}

const openSettings = async (): Promise<HTMLInputElement> => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: /settings/i }));
  return (await screen.findByLabelText("Model ID", { selector: "input:not([aria-label])" })) as HTMLInputElement;
};

describe("closing the AI settings", () => {
  it("closes at once with Escape when nothing was changed", async () => {
    await openSettings();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "AI settings" })).toBeNull());
  });

  it("asks before it drops edits, for Escape, the close button and a click beside the window", async () => {
    const model = await openSettings();
    fireEvent.change(model, { target: { value: "typed-model" } });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByTestId("ai-settings-unsaved")).toHaveTextContent("Your changes are not saved yet.");
    expect(screen.getByRole("dialog", { name: "AI settings" })).toBeInTheDocument();
    // Escape on the question goes back to the settings, with the edit still there.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("ai-settings-unsaved")).toBeNull());
    expect(model.value).toBe("typed-model");

    fireEvent.click(screen.getByRole("button", { name: "Close AI settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    expect(model.value).toBe("typed-model");

    fireEvent.mouseDown(document.querySelector(".ai-settings-overlay")!);
    fireEvent.click(await screen.findByRole("button", { name: "Close without saving" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "AI settings" })).toBeNull());
  });
});

describe("the width of the AI panel", () => {
  it("can be changed with the arrow keys", () => {
    const onWidth = vi.fn();
    render(<Harness onWidth={onWidth} />);
    const handle = screen.getByRole("separator", { name: "Width of the AI panel" });
    expect(handle).toHaveAttribute("tabindex", "0");
    expect(handle).toHaveAttribute("aria-valuenow", "420");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(onWidth).toHaveBeenLastCalledWith(436);
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onWidth).toHaveBeenLastCalledWith(372);
    fireEvent.keyDown(handle, { key: "Home" });
    expect(onWidth).toHaveBeenLastCalledWith(300);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onWidth).toHaveBeenLastCalledWith(300);
    fireEvent.keyDown(handle, { key: "a" });
    expect(onWidth).toHaveBeenCalledTimes(4);
  });
});

describe("the sign-in page", () => {
  it("shows the app's own words for an error code, never the text in the address", () => {
    expect(signInErrorText("access_denied")).toBe("Sign-in was cancelled or not allowed.");
    expect(signInErrorText("server_error")).toBe("The sign-in service did not answer. Try again in a moment.");
    const forged = "Your session expired. Call 555-0100 and read out your password";
    expect(signInErrorText(forged)).toBe("Sign-in did not work. Try again.");
    expect(signInErrorText("<img src=x onerror=alert(1)>")).toBe("Sign-in did not work. Try again.");
  });
});
