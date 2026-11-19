// @vitest-environment jsdom
import type { HubSnapshot } from "../../src/shared/types/aiHub";
import { afterEach, describe, expect, it, vi } from "vitest";

/** An answer older than the one on screen is not shown. From the review of feature 13. */

afterEach(() => {
  vi.resetModules();
});

describe("the panel's view of the hub", () => {
  it("starts each web session empty and drops delayed snapshots and action replies from an earlier session", async () => {
    const { setHubWebAccount, openTaskStorageKey } = await import("../../src/renderer/src/lib/aiHubSession");
    const { hubRequest, observeHubSnapshot, selectAiTerminal, useSelectedTerminal } = await import("../../src/renderer/src/lib/aiHub");
    const { renderHook, act } = await import("@testing-library/react");
    const next = (): { result: Promise<HubSnapshot>; resolve: (snap: HubSnapshot) => void } => {
      let resolve!: (snap: HubSnapshot) => void;
      const result = new Promise<HubSnapshot>((done) => { resolve = done; });
      return { result, resolve };
    };
    const staleSnapshot = next(), staleAction = next(), freshSnapshot = next();
    const previous = { tasks: [{ id: "previous" }] } as HubSnapshot;
    const current = { tasks: [{ id: "current" }] } as HubSnapshot;
    const request = vi.fn()
      .mockResolvedValueOnce(previous)
      .mockReturnValueOnce(staleSnapshot.result)
      .mockReturnValueOnce(staleAction.result)
      .mockReturnValueOnce(freshSnapshot.result);
    Object.assign(window, { multissh: { aiHubRequest: request, onAiHubChanged: () => () => {} } });
    setHubWebAccount("first");
    const priorKey = openTaskStorageKey()!;
    window.sessionStorage.setItem(priorKey, "previous");
    await hubRequest({ action: "snapshot" });
    const oldListener = vi.fn();
    const stop = observeHubSnapshot(oldListener);
    expect(oldListener).toHaveBeenCalledWith(previous);
    selectAiTerminal("old-terminal");
    const pending = hubRequest({ action: "snapshot" });
    stop();
    setHubWebAccount(null);
    expect(window.sessionStorage.getItem(priorKey)).toBeNull();
    setHubWebAccount("second");
    expect(openTaskStorageKey()).not.toBe(priorKey);
    const { result, unmount } = renderHook(() => useSelectedTerminal());
    expect(result.current).toBe("");
    const shown = vi.fn();
    const stopAgain = observeHubSnapshot(shown);
    expect(shown).not.toHaveBeenCalled();
    await act(async () => {
      staleSnapshot.resolve(previous);
      staleAction.resolve(previous);
      await expect(pending).rejects.toThrow("workspace session has ended");
    });
    expect(shown).not.toHaveBeenCalled();
    await act(async () => { freshSnapshot.resolve(current); });
    expect(shown.mock.calls).toEqual([[current]]);
    stopAgain();
    unmount();
  });

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
