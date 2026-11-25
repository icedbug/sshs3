import { describe, expect, it } from "vitest";
import { untilIn, utcMinute } from "../../src/shared/utcMinute";

// Found by the security lead tester: a freeze's end was given as a raw ISO string.
describe("a time in a message the hub writes", () => {
  it("is written as people read it, and read back in that form and in the older ISO one", () => {
    const at = Date.UTC(2026, 10, 25, 20, 15);
    expect(utcMinute(at)).toBe("2026-11-25 20:15 UTC");
    expect(untilIn(`A change freeze holds here until ${utcMinute(at)}. No change card or file write is run here until it ends.`)).toBe(at);
    expect(untilIn("A change freeze holds here until 2026-11-25T20:15:00.000Z. No change card or file write is run here until it ends.")).toBe(at);
    expect(untilIn("Nothing to read here.")).toBeUndefined();
  });

  // Found by the review of the fix: a freeze ending 20:15:45 was said to end at 20:15, so at 20:15:30 a
  // refusal named a time already past. An end is said at the next whole minute, never before it is.
  it("says an end within a minute at the next whole minute, never earlier than it is", () => {
    const at = Date.UTC(2026, 10, 25, 20, 15, 45, 120);
    expect(utcMinute(at)).toBe("2026-11-25 20:16 UTC");
    expect(untilIn(`until ${utcMinute(at)}.`)!).toBeGreaterThanOrEqual(at);
    expect(utcMinute(Date.UTC(2026, 10, 25, 23, 59, 1))).toBe("2026-11-26 00:00 UTC");
  });
});
