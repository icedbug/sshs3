// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { WebAuthGate } from "../../src/renderer/src/components/WebAuthGate";
import { openTaskStorageKey } from "../../src/renderer/src/lib/aiHubSession";
import { connectWebClientBridge, disconnectWebClientBridge } from "../../src/renderer/src/lib/webClientBridge";

vi.mock("../../src/renderer/src/lib/webClientBridge", () => ({
  isWebBrowserMode: () => true,
  ensureWebClientBridgeInstalled: () => {},
  connectWebClientBridge: vi.fn(),
  disconnectWebClientBridge: vi.fn(),
  getStoredWebSessionToken: () => null,
  setStoredWebSessionToken: () => {},
  onWebConnectionStateChange: () => () => {},
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

it("uses the confirmed identity before mounting the workspace and forgets it on session expiry", async () => {
  const result = { initialized: true, authenticated: true, user: { id: "member-id", role: "member", username: "member" } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => result }));
  const { unmount } = render(<WebAuthGate><p>Example workspace</p></WebAuthGate>);
  await screen.findByText("Example workspace");
  expect(connectWebClientBridge).toHaveBeenCalledWith(null, "member-id");
  const key = openTaskStorageKey()!;
  window.sessionStorage.setItem(key, "current-task");
  act(() => { window.dispatchEvent(new Event("sshs3:web-auth-expired")); });
  expect(screen.queryByText("Example workspace")).toBeNull();
  expect(screen.getByRole("heading", { name: "Sign in to sshs3" })).toBeTruthy();
  expect(disconnectWebClientBridge).toHaveBeenCalled();
  expect(openTaskStorageKey()).toBeUndefined();
  expect(window.sessionStorage.getItem(key)).toBeNull();
  unmount();
});
