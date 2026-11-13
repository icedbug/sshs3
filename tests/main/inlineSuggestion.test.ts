import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SelfLearningService } from "../../src/main/ai/hub/SelfLearningService";
import { KnowledgeBaseService } from "../../src/main/ai/hub/KnowledgeBaseService";
import type { MemoryEntry } from "../../src/shared/types/aiHub";

/** What the terminal's Ctrl+K bar may offer and run. From the review of feature 10. */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

async function hub() {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-inline-"));
  const h = new HubService(
    { changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json"), workspaceServers: async () => [] } as never,
    dir,
  );
  disposals.push(async () => {
    await h.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await h.initialize();
  return h;
}

describe("a suggestion in the terminal", () => {
  it("is classified, and only a single read-only command may run with one key", async () => {
    const h = await hub();
    const ask = async (prompt: string) => (await h.request({ action: "inline-suggest", prompt, shell: "bash" })).reply!.inlineSuggestion!;
    const look = await ask("show disk usage");
    expect(look.riskLevel).toBe("safe");
    expect(look.runnable).toBe(true);
  });

  it("is cleaned of escape codes and never runs a second line by pressing Enter on the first", async () => {
    const { checkedSuggestionForTesting } = await import("../../src/main/ai/hub/HubService");
    const s = checkedSuggestionForTesting({ command: "ls -la\u001b[201~\nrm -rf ~/backups", explanation: "", createdAt: 1 });
    expect(s.command).not.toContain("\u001b");
    expect(s.multiline).toBe(true);
    expect(s.runnable).toBe(false);
    expect(s.riskLevel).toBe("destructive");
  });

  it("does not offer a command saved for another server on a one-word match", () => {
    const learning = new SelfLearningService(new KnowledgeBaseService());
    const wal = {
      id: "m",
      kind: "skill",
      scope: "server:prod-db",
      title: "Fix full disk on prod-db by purging WAL",
      text: "x",
      sourceCommand: "sudo rm -rf /var/lib/postgresql/14/main/pg_wal/*",
      confidence: 0.85,
      updatedAt: 1,
    } as MemoryEntry;
    expect(learning.findBestLearnedCommand([wal], "how much disk space is free")).toBeUndefined();
  });
});
