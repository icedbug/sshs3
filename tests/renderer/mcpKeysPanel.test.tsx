// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpKeysPanel } from "../../src/renderer/src/components/McpKeysPanel";

afterEach(cleanup);

const key = (extra: Record<string, unknown> = {}) => ({
  id: "k1",
  name: "Claude Code on my laptop",
  scopes: ["read"],
  createdAt: Date.now(),
  uses: 0,
  expired: false,
  ...extra,
});

describe("keys for a person's own agents", () => {
  it("lists what is there and says when each was last used", async () => {
    const api = vi.fn(async () => ({ keys: [key({ uses: 12, lastUsedAt: Date.now() - 90 * 60_000 })] })) as never;
    render(<McpKeysPanel api={api} origin="https://sshs3.example.com" />);
    const row = await screen.findByTestId("mcp-key-k1");
    expect(within(row).getByText("Claude Code on my laptop")).toBeVisible();
    expect(within(row).getByText(/Read — used 2 h ago, 12 calls/)).toBeVisible();
  });

  it("shows a new key once, with the line to paste into Claude Code", async () => {
    const api = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === "POST") return { token: "s3k_u1.abc.secret-value", key: key({ name: "Cursor" }) };
      return { keys: [] };
    }) as never;
    render(<McpKeysPanel api={api} origin="https://sshs3.example.com" />);
    fireEvent.change(screen.getByLabelText("What the key is for"), { target: { value: "Cursor" } });
    fireEvent.click(screen.getByRole("button", { name: "Make the key" }));
    const shown = await screen.findByTestId("mcp-new-key");
    expect(within(shown).getByText("s3k_u1.abc.secret-value")).toBeVisible();
    expect(within(shown).getByText(/only time it is shown/)).toBeVisible();

    const clipboard = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
    fireEvent.click(within(shown).getByRole("button", { name: "Copy the line for Claude Code" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalled());
    const line = clipboard.mock.calls[0][0];
    expect(line).toContain("claude mcp add --transport http sshs3 https://sshs3.example.com/api/mcp");
    expect(line).toContain("Authorization: Bearer s3k_u1.abc.secret-value");
    // Put away once the person has it.
    fireEvent.click(within(shown).getByRole("button", { name: "I have it" }));
    await waitFor(() => expect(screen.queryByTestId("mcp-new-key")).not.toBeInTheDocument());
  });

  it("will not offer what is not built yet, and always reads", async () => {
    const api = vi.fn(async () => ({ keys: [] })) as never;
    render(<McpKeysPanel api={api} origin="https://x" />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    const read = screen.getByRole("checkbox", { name: /Read/ });
    expect(read).toBeChecked();
    expect(read).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Run commands/ })).toBeDisabled();
    expect(screen.getByText(/this is being built/)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Write tickets/ })).toBeEnabled();
  });

  it("takes a key back", async () => {
    const api = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === "DELETE") return { ok: true };
      return { keys: [key()] };
    }) as never;
    render(<McpKeysPanel api={api} origin="https://x" />);
    fireEvent.click(await screen.findByRole("button", { name: "Take it back" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/mcp-keys/k1", { method: "DELETE" }));
  });

  it("says what went wrong instead of failing quietly", async () => {
    const api = vi.fn(async (_path: string, options?: RequestInit) => {
      if (options?.method === "POST") throw new Error("There are already 20 keys. Revoke one before making another.");
      return { keys: [] };
    }) as never;
    render(<McpKeysPanel api={api} origin="https://x" />);
    fireEvent.change(screen.getByLabelText("What the key is for"), { target: { value: "one more" } });
    fireEvent.click(screen.getByRole("button", { name: "Make the key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Revoke one before making another");
  });
});
