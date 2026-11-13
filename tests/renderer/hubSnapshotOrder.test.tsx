// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/** An answer older than the one on screen is not shown. From the review of feature 13. */

afterEach(() => {
  vi.resetModules();
});

describe("the panel's view of the hub", () => {
  it("is not put back to how it was by a refresh that started before an action", async () => {
    let state = 0;
    let changed: (() => void) | undefined;
    const slow: Array<() => void> = [];
    (window as unknown as { multissh: unknown }).multissh = {
      onAiHubChanged: (cb: () => void) => {
        changed = cb;
        return () => undefined;
      },
      aiHubRequest: (r: { action: string }) =>
        new Promise((resolve) => {
          const seen = { v: r.action === "snapshot" ? state : ++state } as never;
          if (r.action === "snapshot" && slow.length === 0) slow.push(() => resolve(seen));
          else resolve({ v: state } as never);
        }),
    };
    const { hubRequest } = await import("../../src/renderer/src/lib/aiHub");
    const mod = await import("../../src/renderer/src/lib/aiHub");
    // Subscribe through the hook's store: a refresh starts and hangs.
    const { renderHook } = await import("@testing-library/react");
    const { result } = renderHook(() => mod.useHub());
    await Promise.resolve();
    const after = await hubRequest({ action: "kb-save" } as never);
    expect((after as unknown as { v: number }).v).toBe(1);
    // The old refresh (state 0) now comes back late: it is dropped.
    slow[0]();
    await new Promise((r) => setTimeout(r, 10));
    expect((result.current as unknown as { v: number }).v).toBe(1);
    void changed;
  });
});
