import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Closing the hub writes its store one last time. When that cannot be written, closing still ends
 * and does not end as an error: whoever closes the app (a quit, a test that has removed its folder)
 * often does not wait for it, and an error nobody catches is reported as a crash.
 */
describe("closing the hub when its folder is gone", () => {
  it("ends without an error", async () => {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-dispose-"));
    try {
      const hub = new HubService(
        { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never,
        dir,
      );
      await hub.initialize();
      // The folder becomes a file, so nothing can be written under it any more.
      await fs.rm(dir, { recursive: true, force: true });
      await fs.writeFile(dir, "not a folder");
      await expect(hub.dispose()).resolves.toBeUndefined();
    } finally {
      setDemoModeForTesting(undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
