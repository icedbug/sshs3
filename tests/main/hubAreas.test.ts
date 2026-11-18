import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AREA_OF, areaOf } from "../../src/main/ai/hub/areas/routes";
import { mixParts } from "../../src/main/ai/hub/areas/mix";

/**
 * The hub is one object whose code is kept in a file per area (src/main/ai/hub/areas). The compiler
 * holds the table of which part answers which request to the request type. This holds the rest:
 * that each part named has its file and its handler, that a word that is not an action is not taken
 * for one, and that the files stay small enough to read.
 */

const hubDir = path.join(__dirname, "../../src/main/ai/hub");
const parts = [...new Set(Object.values(AREA_OF))];

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function makeHub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-areas-"));
  const hub = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
    dir,
  );
  disposals.push(async () => {
    await hub.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { hub, HubService };
}

describe("the hub's parts", () => {
  it("has a file for every part the table names, and a handler for it on the hub", async () => {
    const { HubService } = await makeHub();
    expect(parts.length).toBeGreaterThan(10);
    for (const name of parts) {
      await expect(fs.access(path.join(hubDir, "areas", `${name}.ts`))).resolves.toBeUndefined();
      const handler = `handle${name[0].toUpperCase()}${name.slice(1)}`;
      expect(typeof (HubService.prototype as unknown as Record<string, unknown>)[handler], handler).toBe("function");
    }
  });

  it("gives every action a part, and the same one each time", () => {
    const actions = Object.keys(AREA_OF);
    expect(new Set(actions).size).toBe(actions.length);
    for (const action of actions) expect(areaOf(action)).toBe(AREA_OF[action as keyof typeof AREA_OF]);
  });

  it("does not take a word that is not an action for one", async () => {
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty", "", "nope"]) expect(areaOf(word), word).toBeUndefined();
    const { hub } = await makeHub();
    await expect(hub.request({ action: "nope" } as never)).rejects.toThrow("Unknown AI request: nope");
    await expect(hub.request({ action: "constructor" } as never)).rejects.toThrow("Unknown AI request: constructor");
    await expect(hub.request({} as never)).rejects.toThrow("Invalid AI request");
  });

  it("answers a request through its part, and still saves and answers as before", async () => {
    const { hub } = await makeHub();
    // One that only reads, and one that writes: both come back as a snapshot.
    const first = await hub.request({ action: "snapshot" });
    expect(Array.isArray(first.tasks)).toBe(true);
    const saved = await hub.request({ action: "ticket-save", ticket: { title: "Renew the certificate" } });
    expect(saved.workTickets?.map((t) => t.title)).toContain("Renew the certificate");
    // What a case leaves in `reply` comes back with the snapshot.
    const searched = await hub.request({ action: "kb-search", query: "certificate" });
    expect(searched.reply).toBeDefined();
  });

  it("refuses two parts that define the same method", () => {
    class Hub {
      own(): string {
        return "own";
      }
    }
    class A {
      shared(): string {
        return "a";
      }
    }
    class B {
      shared(): string {
        return "b";
      }
    }
    class C {
      own(): string {
        return "c";
      }
    }
    mixParts(Hub, [A]);
    expect((new Hub() as unknown as A).shared()).toBe("a");
    expect(() => mixParts(Hub, [B])).toThrow("B.shared is already a method of the hub");
    // Nor may a part put a method over one the class has itself.
    expect(() => mixParts(Hub, [C])).toThrow("C.own is already a method of the hub");
    expect(new Hub().own()).toBe("own");
  });

  it("keeps each file small enough to read", async () => {
    const lines = async (file: string): Promise<number> => (await fs.readFile(file, "utf8")).split("\n").length;
    // The hub's own file: its state, its start and end, the snapshot, the clock and the handing out.
    expect(await lines(path.join(hubDir, "HubService.ts")), "HubService.ts has grown: put the new code in a part (docs/ai-hub.md, Where the hub's code is)").toBeLessThan(2000);
    for (const file of await fs.readdir(path.join(hubDir, "areas"))) {
      if (!file.endsWith(".ts")) continue;
      expect(await lines(path.join(hubDir, "areas", file)), `areas/${file} has grown past 1,500 lines: split it into two parts`).toBeLessThan(1500);
    }
  });
});
