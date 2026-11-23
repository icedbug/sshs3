import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split("").reverse().join("")),
    decryptString: (value: Buffer) => value.toString().split("").reverse().join(""),
  },
}));

import { AiConfigStore } from "../../src/main/ai/AiConfigStore";

/**
 * A run has no limit on how many times it goes round. The setting that once held one did nothing any
 * more, and was still kept in the file and handed to the window. It is neither now, and a file from
 * before still loads.
 */
describe("the old limit on tool turns", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-turns-"));
    file = path.join(dir, "config.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const stored = async (): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;

  it("a file saved before still loads, with its other settings, and the window is not handed the limit", async () => {
    await fs.writeFile(file, JSON.stringify({ enabled: true, provider: "openai-compatible", model: "llama", baseUrl: "http://10.0.0.5:8000/v1", maxToolTurns: 30, maxOutputTokens: 4096 }));
    const view = await new AiConfigStore(file).getView();
    expect(view).toMatchObject({ enabled: true, model: "llama", maxOutputTokens: 4096 });
    expect("maxToolTurns" in view).toBe(false);
    expect("maxToolTurns" in (await new AiConfigStore(file).getConfig())).toBe(false);
    // Reading alone writes nothing.
    expect((await stored()).maxToolTurns).toBe(30);
  });

  it("the next save of any setting leaves it out of the file", async () => {
    await fs.writeFile(file, JSON.stringify({ enabled: true, provider: "openai-compatible", model: "llama", maxToolTurns: 30 }));
    await new AiConfigStore(file).update({ model: "qwen" });
    const after = await stored();
    expect(after.model).toBe("qwen");
    expect("maxToolTurns" in after).toBe(false);
  });

  it("an older window that still sends it is not refused, and what it sends is not kept", async () => {
    const store = new AiConfigStore(file);
    const view = await store.update({ model: "llama", maxToolTurns: 40, maxOutputTokens: 2048 });
    expect(view).toMatchObject({ model: "llama", maxOutputTokens: 2048 });
    expect("maxToolTurns" in view).toBe(false);
    expect("maxToolTurns" in (await stored())).toBe(false);
  });
});
