// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubSnapshot } from "../../src/shared/types/aiHub";

afterEach(() => {
  vi.resetModules();
  delete (window as unknown as { multissh?: unknown }).multissh;
});

describe("what a request answers beside the state", () => {
  it("goes to whoever asked, and is not kept in the state the window's views read", async () => {
    const { hubRequest, observeHubSnapshot } = await import("../../src/renderer/src/lib/aiHub");
    const answer = { tasks: [{ id: "t1" }], reply: { mcpKey: { token: "sshs3_mcp_secret", key: { id: "k1" } } } } as unknown as HubSnapshot;
    const plain = { tasks: [{ id: "t1" }, { id: "t2" }] } as unknown as HubSnapshot;
    const request = vi.fn().mockResolvedValueOnce(answer).mockResolvedValueOnce(plain);
    Object.assign(window, { multissh: { aiHubRequest: request } });

    const seen: HubSnapshot[] = [];
    const got = await hubRequest({ action: "mcp-key-create", name: "Cursor", scopes: ["read"] });
    const stop = observeHubSnapshot((snap) => seen.push(snap));
    // The caller has its key.
    expect(got.reply?.mcpKey?.token).toBe("sshs3_mcp_secret");
    // The shared state has the conversations, and no key.
    expect(seen).toHaveLength(1);
    expect(seen[0].tasks).toEqual([{ id: "t1" }]);
    expect(seen[0]).not.toHaveProperty("reply");
    expect(JSON.stringify(seen[0])).not.toContain("sshs3_mcp_secret");

    // A state that came without anything beside it is kept as it is.
    await hubRequest({ action: "snapshot" });
    expect(seen.at(-1)).toBe(plain);
    stop();
  });
});
