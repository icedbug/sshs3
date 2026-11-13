import { describe, expect, it } from "vitest";
import { parseCast } from "../../src/renderer/src/lib/asciicast";

const cast = [
  JSON.stringify({ version: 2, width: 100, height: 30, title: "web-1 — run t1" }),
  JSON.stringify([0.1, "o", "$ "]),
  JSON.stringify([0.2, "m", "systemctl status nginx"]),
  JSON.stringify([0.5, "o", "active (running)\r\n"]),
  // An hour of nothing, then the next command.
  JSON.stringify([3600.5, "m", "uptime"]),
  JSON.stringify([3600.7, "o", "up 3 days\r\n"]),
  '[3601, "o", "cut off',
].join("\n");

describe("reading a recording for playback", () => {
  it("keeps the size, the output and the markers, in order", () => {
    const p = parseCast(cast);
    expect(p.width).toBe(100);
    expect(p.height).toBe(30);
    expect(p.events.filter((e) => e.kind === "m").map((e) => e.data)).toEqual(["systemctl status nginx", "uptime"]);
    expect(p.events.filter((e) => e.kind === "o").map((e) => e.data).join("")).toContain("up 3 days");
  });

  it("shortens a long pause, so an hour of nothing plays in two seconds", () => {
    const p = parseCast(cast);
    const uptime = p.events.find((e) => e.data === "uptime")!;
    expect(uptime.t).toBeCloseTo(2.5, 5);
    expect(p.duration).toBeLessThan(3);
  });

  it("plays what it can of a file cut off at the end, and of one with no header", () => {
    expect(parseCast(cast).events).toHaveLength(5);
    const noHeader = parseCast(`not json\n${JSON.stringify([1, "o", "hi"])}`);
    expect(noHeader.width).toBe(120);
    expect(noHeader.events).toHaveLength(1);
  });
});
