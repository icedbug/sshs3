// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { Settings } from "../../src/renderer/src/components/AiHub/SettingsView";

vi.mock("../../src/renderer/src/lib/webClientBridge", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  isWebBrowserMode: () => webMode,
}));
let webMode = false;

afterEach(() => {
  cleanup();
  webMode = false;
});

const hub = (extra: Partial<HubSnapshot> = {}): HubSnapshot =>
  ({
    config: { provider: "anthropic", model: "claude-opus-5-5", enabled: true },
    preferences: { background: false, autoStart: false, inventory: false, retentionDays: 30 },
    runtime: { bundled: false },
    sessions: [],
    tasks: [],
    ...extra,
  }) as unknown as HubSnapshot;

describe("letting this person's own agent reach the app", () => {
  it("is off, says what it is for, and shows where it answers once it is on", async () => {
    const act = vi.fn(async () => hub());
    const { rerender } = render(<Settings hub={hub({ localMcp: { enabled: false, keys: [] } })} act={act} />);
    const card = screen.getByTestId("local-mcp");
    const toggle = within(card).getByLabelText("Let your own agents reach this app");
    expect(toggle).not.toBeChecked();
    expect(within(card).getByText(/listens on this computer only/)).toBeVisible();
    // No address while it is off (the sentence explaining it does say 127.0.0.1).
    expect(card.textContent).not.toMatch(/127\.0\.0\.1:\d+\/mcp/);
    expect(within(card).queryByTestId("mcp-keys")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(act).toHaveBeenCalledWith({ action: "mcp-local-set", enabled: true }));

    rerender(
      <Settings
        hub={hub({ localMcp: { enabled: true, address: "http://127.0.0.1:51734/mcp", keys: [] } })}
        act={act}
      />,
    );
    expect(within(screen.getByTestId("local-mcp")).getByText("http://127.0.0.1:51734/mcp")).toBeVisible();
    expect(within(screen.getByTestId("local-mcp")).getByTestId("mcp-keys")).toBeVisible();
  });

  it("says what went wrong instead of looking switched on", () => {
    render(<Settings hub={hub({ localMcp: { enabled: true, keys: [], error: "That port is in use." } })} act={vi.fn()} />);
    expect(within(screen.getByTestId("local-mcp")).getByText(/It could not start: That port is in use\./)).toBeVisible();
  });

  it("is not offered in a browser, where the team server already answers", () => {
    webMode = true;
    render(<Settings hub={hub({ localMcp: { enabled: false, keys: [] } })} act={vi.fn()} />);
    expect(screen.queryByTestId("local-mcp")).not.toBeInTheDocument();
  });

  it("asks for a key that never stops working in so many words, and for 30 days when nothing is chosen", async () => {
    const made = { ...hub(), reply: { mcpKey: { token: "sshs3_mcp_x", key: { id: "k1", name: "Cursor", scopes: ["read"], createdAt: 1 } } } } as unknown as HubSnapshot;
    const act = vi.fn(async () => made);
    render(<Settings hub={hub({ localMcp: { enabled: true, address: "http://127.0.0.1:51734/mcp", keys: [] } })} act={act} />);
    const card = screen.getByTestId("local-mcp");
    fireEvent.change(await within(card).findByLabelText("What the key is for"), { target: { value: "Cursor" } });
    fireEvent.keyDown(within(card).getByLabelText("What the key is for"), { key: "Enter" });
    await waitFor(() => expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp-key-create", name: "Cursor", expiresInDays: 30 })));
    expect((act.mock.calls as unknown as [Record<string, unknown>][]).map((c) => c[0]).find((r) => r.action === "mcp-key-create")).not.toHaveProperty("neverExpires");

    act.mockClear();
    await waitFor(() => expect(within(card).getByLabelText("What the key is for")).toHaveValue(""));
    fireEvent.change(within(card).getByLabelText("What the key is for"), { target: { value: "Robot" } });
    fireEvent.change(within(card).getByLabelText("When the key stops working"), { target: { value: "0" } });
    fireEvent.keyDown(within(card).getByLabelText("What the key is for"), { key: "Enter" });
    await waitFor(() => expect(act).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp-key-create", name: "Robot", neverExpires: true })));
  });

  it("never nests a <form> inside SettingsView and Enter in key name does not save settings", async () => {
    const act = vi.fn(async () => hub());
    const { container } = render(
      <Settings
        hub={hub({
          localMcp: { enabled: true, address: "http://127.0.0.1:51734/mcp", keys: [] },
          chatSources: {
            canChange: true,
            total: 1,
            connections: [],
          },
        })}
        act={act}
      />,
    );
    expect(container.querySelectorAll("form form")).toHaveLength(0);
    const keyInput = await screen.findByLabelText("What the key is for");
    fireEvent.change(keyInput, { target: { value: "Cursor" } });
    fireEvent.keyDown(keyInput, { key: "Enter" });
    expect(act).not.toHaveBeenCalledWith(expect.objectContaining({ action: "configure" }));
  });
});
