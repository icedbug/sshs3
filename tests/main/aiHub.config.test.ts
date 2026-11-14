import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const crypto = vi.hoisted(() => ({ available: true, fail: false, userData: "" }));
vi.mock("electron", () => ({
  app: { getPath: () => crypto.userData || os.tmpdir() },
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
import { setDemoModeForTesting } from "../../src/main/demo/demoMode";
describe("AI model credentials", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    crypto.available = true;
    crypto.fail = false;
    crypto.userData = "";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-ai-keys-"));
    file = path.join(dir, "config.json");
  });
  afterEach(async () => {
    setDemoModeForTesting(undefined);
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("shows the person's `codex login` as signed in on the desktop app, and never to a workspace with its own folder or the demo", async () => {
    // A home folder where only `codex login` was run: no sign-in in sshs3's own data folder.
    const home = path.join(dir, "home");
    const userData = path.join(dir, "userData");
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await fs.mkdir(userData, { recursive: true });
    const jwt = (payload: Record<string, unknown>) =>
      `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
    await fs.writeFile(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: jwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            "https://api.openai.com/profile": { email: "sara@example.com" },
          }),
          refresh_token: "rt_cli",
        },
      }),
    );
    vi.spyOn(os, "homedir").mockReturnValue(home);
    crypto.userData = userData;

    // The desktop app (no folder given): the status is the sign-in a run would use.
    const desktop = new AiConfigStore();
    expect(desktop.codexAuthDir()).toBeUndefined();
    expect(await desktop.getView()).toMatchObject({
      codexConnected: true,
      codexAccountEmail: "sara@example.com",
      provider: "openai-codex",
      enabled: false,
    });

    // A workspace with its own folder (a tenant on a shared server): the host's ~/.codex is not its sign-in.
    const tenant = new AiConfigStore(path.join(dir, "tenant", "ai-config.json"));
    expect(tenant.codexAuthDir()).toBe(path.join(dir, "tenant"));
    expect(await tenant.getView()).toMatchObject({ codexConnected: false });

    // The demo keeps to its own folder too, also on the desktop app.
    setDemoModeForTesting(true);
    const demo = new AiConfigStore();
    expect(demo.codexAuthDir()).toBe(userData);
    expect(await demo.getView()).toMatchObject({ codexConnected: false });
  });
  it("stores ciphertext but never returns the key to the renderer", async () => {
    const store = new AiConfigStore(file);
    const view = await store.update({
      apiKey: "test-credential", // pragma: allowlist secret
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
        await store.update({ apiKey: "session-credential" }), // pragma: allowlist secret
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
      store.update({ baseUrl: "https://user:secret@example.test" }), // pragma: allowlist secret
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
  it("reports a Codex sign-in, but never moves a saved configuration to it or switches the assistant on", async () => {
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

    // What was saved holds: the team's endpoint is not quietly swapped for this machine's ChatGPT sign-in.
    const store = new AiConfigStore(file);
    const view = await store.getView();
    expect(view).toMatchObject({
      enabled: true,
      provider: "openai-compatible",
      model: "gpt-sol-latest",
      baseUrl: "https://openrouter.ai/api/v1",
      codexConnected: true,
      codexAccountEmail: "jacob@example.com",
      codexDefaultModel: "gpt-6.1-sol",
      codexModels: ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol"],
    });

    // An Anthropic configuration without its key stays Anthropic (the run says the key is missing).
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
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      codexConnected: true,
    });
    // Switched off stays off.
    await storeAnthropicDefault.update({ enabled: false });
    expect((await new AiConfigStore(file).getView()).enabled).toBe(false);

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

    // Recovers when ai-config.json contains non-object JSON (e.g. null or array): as on a first start, the
    // sign-in found is offered as the provider, and the assistant stays off until a person switches it on.
    await fs.writeFile(file, "null", "utf-8");
    const nullStore = new AiConfigStore(file);
    expect(await nullStore.getView()).toMatchObject({
      enabled: false,
      provider: "openai-codex",
      model: "gpt-6.1-sol",
    });
  });
});


