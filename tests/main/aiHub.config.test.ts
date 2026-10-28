import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const crypto = vi.hoisted(() => ({ available: true, fail: false }));
vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => crypto.available,
    encryptString: (value: string) => {
      if (crypto.fail) throw new Error("Test keyring unavailable");
      return Buffer.from(value.split("").reverse().join(""));
    },
    decryptString: (value: Buffer) =>
      value.toString().split("").reverse().join(""),
  },
}));
import { AiConfigStore } from "../../src/main/ai/AiConfigStore";
describe("AI model credentials", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    crypto.available = true;
    crypto.fail = false;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-ai-keys-"));
    file = path.join(dir, "config.json");
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  it("stores ciphertext but never returns the key to the renderer", async () => {
    const store = new AiConfigStore(file);
    const view = await store.update({
      apiKey: "test-credential",
      model: "test-model",
    });
    expect(view).toMatchObject({ hasApiKey: true, keyStorage: "encrypted" });
    expect(view).not.toHaveProperty("apiKey");
    expect(await fs.readFile(file, "utf8")).not.toContain("test-credential");
    expect((await new AiConfigStore(file).getConfig()).apiKey).toBe(
      "test-credential",
    );
    await store.update({ apiKey: null });
    expect((await store.getView()).hasApiKey).toBe(false);
  });
  it.each(["missing", "failure"])(
    "keeps keys in memory when encryption reports %s",
    async (mode) => {
      crypto.available = mode !== "missing";
      crypto.fail = mode === "failure";
      const store = new AiConfigStore(file);
      expect(
        await store.update({ apiKey: "session-credential" }),
      ).toMatchObject({ keyStorage: "session" });
      expect((await store.getConfig()).apiKey).toBe("session-credential");
      expect(await fs.readFile(file, "utf8")).not.toContain(
        "session-credential",
      );
      expect((await new AiConfigStore(file).getView()).hasApiKey).toBe(false);
    },
  );
  it("does not overwrite corrupt configuration while saving a setting", async () => {
    await fs.writeFile(file, "{broken");
    await expect(
      new AiConfigStore(file).update({ enabled: true }),
    ).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("{broken");
  });
  it("rejects endpoint credentials and preserves concurrent setting updates", async () => {
    const store = new AiConfigStore(file);
    await expect(
      store.update({ baseUrl: "https://user:secret@example.test" }),
    ).rejects.toThrow("API key field");
    await Promise.all([
      store.update({ model: "model" }),
      store.update({ enabled: true }),
    ]);
    expect(await store.getView()).toMatchObject({
      model: "model",
      enabled: true,
    });
  });
  it("auto-detects Codex OAuth and migrates legacy stale gpt-sol-latest OpenRouter config", async () => {
    const hermesDir = path.join(dir, "hermes-native");
    await fs.mkdir(hermesDir, { recursive: true });
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/profile": { email: "jacob@example.com" },
      }),
    ).toString("base64url");
    await fs.writeFile(
      path.join(hermesDir, "auth.json"),
      JSON.stringify({
        version: 1,
        providers: {
          "openai-codex": {
            tokens: {
              access_token: `${header}.${body}.sig`,
              refresh_token: "rt_codex",
            },
          },
        },
      }),
    );
    await fs.writeFile(
      path.join(hermesDir, "config.yaml"),
      "model:\n  default: gpt-6.1-sol\n  provider: openai-codex\n",
    );
    await fs.writeFile(
      path.join(hermesDir, "provider_models_cache.json"),
      JSON.stringify({
        "openai-codex": {
          models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol"],
        },
      }),
    );
    await fs.writeFile(
      file,
      JSON.stringify({
        enabled: true,
        provider: "openai-compatible",
        model: "gpt-sol-latest",
        useHermes: true,
        baseUrl: "https://openrouter.ai/api/v1",
      }),
    );

    const store = new AiConfigStore(file);
    const view = await store.getView();
    expect(view).toMatchObject({
      enabled: true,
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      hasApiKey: true,
      keyStorage: "oauth",
      codexConnected: true,
      codexAccountEmail: "jacob@example.com",
      codexDefaultModel: "gpt-6.1-sol",
      codexModels: ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol"],
    });
    expect(view.baseUrl).toBeUndefined();

    // Also auto-detects when enabled: true with an unconfigured default anthropic config (no apiKey)
    await fs.writeFile(
      file,
      JSON.stringify({
        enabled: true,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      }),
    );
    const storeAnthropicDefault = new AiConfigStore(file);
    expect(await storeAnthropicDefault.getView()).toMatchObject({
      enabled: true,
      provider: "openai-codex",
      model: "gpt-6.1-sol",
      codexConnected: true,
    });

    // Handles UTF-8 BOM in ai-config.json (e.g. written by Windows PowerShell Set-Content)
    await fs.writeFile(
      file,
      "\uFEFF" +
        JSON.stringify({
          enabled: true,
          provider: "openai-codex",
          model: "gpt-6.1-sol",
          useHermes: false,
        }),
    );
    const bomStore = new AiConfigStore(file);
    expect(await bomStore.getView()).toMatchObject({
      enabled: true,
      provider: "openai-codex",
      model: "gpt-6.1-sol",
    });
    await expect(
      bomStore.update({ actorName: "jacob" }),
    ).resolves.toMatchObject({
      actorName: "jacob",
    });

    // Recovers when ai-config.json contains non-object JSON (e.g. null or array)
    await fs.writeFile(file, "null", "utf-8");
    const nullStore = new AiConfigStore(file);
    expect(await nullStore.getView()).toMatchObject({
      enabled: true,
      provider: "openai-codex",
      model: "gpt-6.1-sol",
    });
  });
});


