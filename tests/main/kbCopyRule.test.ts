import { describe, expect, it } from "vitest";
import { standingKbCopy } from "../../src/main/ai/hub/WorkSync";

/**
 * Which copy of a knowledge base document stands when this installation's and the team's differ.
 * The rule for a restored built-in document cannot be reached through the app today (there are
 * built-in documents only in the demo lab, which never syncs), so it is held here on its own.
 */

const doc = (over: { deleted?: boolean; updatedAt: number; restoredAt?: number; title?: string }) => ({ id: "d1", title: "Runbook", ...over });

describe("which copy of a knowledge base document stands", () => {
  it("takes the newer of two copies that are both there, or both removed", () => {
    const older = doc({ updatedAt: 10, title: "old" });
    const newer = doc({ updatedAt: 20, title: "new" });
    expect(standingKbCopy(older, newer, false)).toBe(newer);
    expect(standingKbCopy(newer, older, false)).toBe(newer);
    const goneOld = doc({ deleted: true, updatedAt: 10 });
    const goneNew = doc({ deleted: true, updatedAt: 20 });
    expect(standingKbCopy(goneOld, goneNew, false)).toBe(goneNew);
    // The same age: this installation's stays.
    const mine = doc({ updatedAt: 10, title: "mine" });
    expect(standingKbCopy(mine, doc({ updatedAt: 10, title: "theirs" }), false)).toBe(mine);
  });

  it("lets a removal stand against a copy that is merely newer, and makes it the newest", () => {
    const gone = doc({ deleted: true, updatedAt: 10 });
    const readLater = doc({ updatedAt: 30 });
    // Whichever side the removal is on.
    expect(standingKbCopy(gone, readLater, false)).toEqual({ ...gone, updatedAt: 31 });
    expect(standingKbCopy(readLater, gone, false)).toEqual({ ...gone, updatedAt: 31 });
    // A removal that is already the newer one is kept as it is.
    const goneLater = doc({ deleted: true, updatedAt: 40 });
    expect(standingKbCopy(goneLater, readLater, false)).toBe(goneLater);
  });

  it("does not bring a user's document back even when it carries a restore mark", () => {
    const gone = doc({ deleted: true, updatedAt: 10 });
    const marked = doc({ updatedAt: 30, restoredAt: 30 });
    expect(standingKbCopy(gone, marked, false).deleted).toBe(true);
  });

  it("brings a built-in document back only when it was restored after the removal", () => {
    const gone = doc({ deleted: true, updatedAt: 10 });
    const restored = doc({ updatedAt: 30, restoredAt: 30 });
    expect(standingKbCopy(gone, restored, true)).toBe(restored);
    expect(standingKbCopy(restored, gone, true)).toBe(restored);
    // Merely newer, without a restore: the removal stands.
    expect(standingKbCopy(gone, doc({ updatedAt: 30 }), true).deleted).toBe(true);
    // Restored, and then removed again later: the later removal stands.
    const goneAgain = doc({ deleted: true, updatedAt: 50 });
    expect(standingKbCopy(goneAgain, restored, true)).toBe(goneAgain);
  });
});
