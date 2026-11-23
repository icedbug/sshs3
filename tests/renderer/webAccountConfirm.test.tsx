// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebAuthGate } from "../../src/renderer/src/components/WebAuthGate";

vi.mock("../../src/renderer/src/lib/webClientBridge", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  isWebBrowserMode: () => true,
  ensureWebClientBridgeInstalled: () => undefined,
  connectWebClientBridge: () => undefined,
  disconnectWebClientBridge: () => undefined,
  getStoredWebSessionToken: () => "tok-test",
  setStoredWebSessionToken: () => undefined,
  onWebConnectionStateChange: () => () => undefined,
}));

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
let calls: { url: string; method: string }[] = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url === "/api/auth/status") {
        return json({
          initialized: true,
          authenticated: true,
          user: { id: "u1", username: "admin", displayName: "Admin", role: "admin", createdAt: 1, sshPublicKey: "ssh-ed25519 AAAA old" },
        });
      }
      if (url === "/api/admin/users") {
        return json({
          users: [
            { id: "u1", username: "admin", displayName: "Admin", role: "admin", sshPublicKey: "ssh-ed25519 AAAA old" },
            { id: "u2", username: "kim", displayName: "Kim Berg", role: "member", sshPublicKey: "ssh-ed25519 BBBB" },
          ],
        });
      }
      if (url === "/api/user/ssh-key") return json({ sshPublicKey: "ssh-ed25519 CCCC new" });
      if (url === "/api/admin/invites") return json({ invites: [] });
      if (url === "/api/mcp-keys") return json({ keys: [] });
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = async (tab: RegExp): Promise<void> => {
  render(
    <WebAuthGate>
      <div>workspace-child</div>
    </WebAuthGate>,
  );
  await screen.findByText("workspace-child");
  fireEvent.click(screen.getByRole("button", { name: tab }));
};

describe("the account window asks before it removes or replaces", () => {
  it("removes a user only after the question is answered yes", async () => {
    await open(/Invite \/ team/);
    const remove = await screen.findByRole("button", { name: "Remove" });
    fireEvent.click(remove);
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Remove this user?");
    expect(dialog).toHaveTextContent("Kim Berg (@kim) is signed out and the account is deleted");
    // The question sits above the account window.
    expect(dialog.className).toContain("z-[10000]");
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(within(await screen.findByTestId("confirm-dialog")).getByRole("button", { name: "Remove the user" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/admin/users/u2", method: "DELETE" }));
  });

  it("Escape answers the question with no and leaves the account window open", async () => {
    await open(/Invite \/ team/);
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await screen.findByTestId("confirm-dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([]);
  });

  it("replaces the SSH key only after the question is answered yes", async () => {
    await open(/SSH/i);
    fireEvent.click(await screen.findByRole("button", { name: "Rotate / generate a new one" }));
    const dialog = await screen.findByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Replace your SSH key?");
    expect(dialog).toHaveTextContent("the old one is deleted");
    expect(calls.filter((c) => c.url === "/api/user/ssh-key")).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("confirm-dialog")).toBeNull());
    expect(calls.filter((c) => c.url === "/api/user/ssh-key")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Rotate / generate a new one" }));
    fireEvent.click(within(await screen.findByTestId("confirm-dialog")).getByRole("button", { name: "Replace the key" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/user/ssh-key", method: "POST" }));
  });
});
