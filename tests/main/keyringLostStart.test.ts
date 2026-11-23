import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * One start without the keyring (a Linux session whose keyring is locked or missing, a server whose key
 * file could not be read) must not lose what is stored encrypted. A secret that cannot be read on a
 * start is empty in memory, as before; what is written back is the ciphertext, unchanged, and the
 * status says the secret could not be read.
 */

const keyring = vi.hoisted(() => ({ available: true }));

vi.mock("electron", async () => {
  const shim = await import("../../src/main/web/electronShim");
  // A keyring that can be taken away: what it encrypted can be read only while it is there.
  const safeStorage = {
    isEncryptionAvailable: () => keyring.available,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`, "utf8"),
    decryptString: (buf: Buffer) => {
      const text = buf.toString("utf8");
      if (!text.startsWith("cipher:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return text.slice("cipher:".length);
    },
  };
  return { ...shim, safeStorage, default: { ...shim.default, safeStorage } };
});

import { isEncryptedSecret, openSecretValue, sealSecretValue, unreadSecretNote } from "../../src/main/crypto/SecretFieldCrypto";
import { AtlassianBridge, type BridgeHost } from "../../src/main/ai/hub/AtlassianBridge";
import { AtlassianStore } from "../../src/main/ai/hub/AtlassianStore";
import { ChatBridge } from "../../src/main/ai/hub/ChatBridge";
import { NotifyStore } from "../../src/main/ai/hub/NotifyStore";
import { S3WorkspaceSyncService } from "../../src/main/ai/hub/S3WorkspaceSyncService";
import type { NotifyChannel } from "../../src/main/ai/hub/Notifier";

const dirs: string[] = [];
const disposals: Array<() => Promise<unknown> | unknown> = [];
const tempDir = async (): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-keyring-"));
  dirs.push(dir);
  return dir;
};
beforeEach(() => {
  keyring.available = true;
});
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8")) as T;
const guard = { server: false, allowPrivate: true, allowPlainHttp: true, lookup: async () => [{ address: "93.184.216.34", family: 4 }] };

describe("a stored secret that cannot be read on this start", () => {
  it("comes back empty with its ciphertext, which is what is written back", () => {
    const stored = sealSecretValue("s3cr3t-value");
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(openSecretValue(stored)).toEqual({ value: "s3cr3t-value" });
    keyring.available = false;
    expect(openSecretValue(stored)).toEqual({ value: "", kept: stored });
    expect(sealSecretValue("", stored)).toBe(stored);
    expect(sealSecretValue(undefined, stored)).toBe(stored);
    // Never encrypted, or nothing stored: there is nothing to keep.
    expect(openSecretValue("plain")).toEqual({ value: "plain" });
    expect(openSecretValue("")).toEqual({ value: "" });
    expect(sealSecretValue("")).toBe("");
    keyring.available = true;
    // A value a person entered replaces what could not be read.
    expect(openSecretValue(sealSecretValue("new-value", stored))).toEqual({ value: "new-value" });
    expect(unreadSecretNote("The bot's token")).toMatch(/^The bot's token could not be read on this start: .* It is kept as it was stored\./);
  });
});

describe("notification channels", () => {
  const channel = (extra: Partial<NotifyChannel> = {}): NotifyChannel => ({ id: "c1", kind: "webhook", name: "pager", url: "https://hooks.example.com/services/T0/B0/abcdef", secret: "signing-secret-1", enabled: true, events: ["approval"], includeCommand: true, ...extra });
  type Stored = { channels: Array<{ id: string; url: string; secret?: string }> };

  it("keep their address and signing secret through a start without the keyring, and a save in between", async () => {
    const file = path.join(await tempDir(), "notify.json");
    const first = new NotifyStore(file);
    await first.load();
    first.data.channels = [channel(), channel({ id: "c2", name: "plain", secret: undefined })];
    await first.save();
    const before = await readJson<Stored>(file);
    expect(before.channels.every((c) => isEncryptedSecret(c.url))).toBe(true);
    expect(isEncryptedSecret(before.channels[0].secret)).toBe(true);

    // The next start has no keyring.
    keyring.available = false;
    const second = new NotifyStore(file);
    await second.load();
    expect(second.data.channels.map((c) => [c.url, c.secret])).toEqual([["", undefined], ["", undefined]]);
    expect(second.unreadOf("c1")).toEqual({ url: true, secret: true });
    expect(second.unreadOf("c2")).toEqual({ url: true, secret: false });
    expect(second.unreadOf("nope")).toEqual({ url: false, secret: false });
    // What the hub does when the first item arrives: it notes it and saves.
    second.data.seen["approval:x"] = Date.now();
    await second.save();
    expect((await readJson<Stored>(file)).channels).toEqual(before.channels);

    // With the keyring back, everything is there again.
    keyring.available = true;
    const third = new NotifyStore(file);
    await third.load();
    expect(third.data.channels.map((c) => [c.url, c.secret])).toEqual([[channel().url, "signing-secret-1"], [channel().url, undefined]]);
    expect(third.unreadOf("c1")).toEqual({ url: false, secret: false });
    expect(third.data.seen["approval:x"]).toBeGreaterThan(0);
  });

  it("take a value a person enters meanwhile, and let go of a channel that is removed", async () => {
    const file = path.join(await tempDir(), "notify.json");
    const first = new NotifyStore(file);
    await first.load();
    first.data.channels = [channel(), channel({ id: "c2", name: "second" })];
    await first.save();
    const before = await readJson<Stored>(file);

    keyring.available = false;
    const second = new NotifyStore(file);
    await second.load();
    // A new address for the first channel; its signing secret is left alone. The second channel is removed.
    second.data.channels = [{ ...second.data.channels[0], url: "https://hooks.example.com/services/NEW" }];
    second.forgetUnread("c1", "url");
    await second.save();
    const after = await readJson<Stored>(file);
    expect(after.channels.map((c) => c.id)).toEqual(["c1"]);
    // No keyring: the new address is stored as it is (the app's fallback), the old secret as it was.
    expect(after.channels[0].url).toBe("https://hooks.example.com/services/NEW");
    expect(after.channels[0].secret).toBe(before.channels[0].secret);
    expect(second.unreadOf("c1")).toEqual({ url: false, secret: true });
    expect(second.unreadOf("c2")).toEqual({ url: false, secret: false });
    // The secret is removed on purpose: it is not written back.
    second.forgetUnread("c1", "secret");
    await second.save();
    expect((await readJson<Stored>(file)).channels[0].secret).toBeUndefined();
  });
});

describe("the hub's notification settings", () => {
  async function makeHub(dir: string) {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
    setDemoModeForTesting(false);
    const hub = new HubService({ changed: () => {}, inventoryTargets: async () => [], backgroundChanged: async () => {}, openSchedule: async () => "s1", show: () => {}, aiConfigFilePath: path.join(dir, "ai.json") } as never, dir);
    disposals.push(async () => {
      await hub.dispose();
      setDemoModeForTesting(undefined);
    });
    await hub.initialize();
    // An address is checked when a channel is saved: the name is looked up here, not on the network.
    (hub as unknown as { outboundGuard(): object }).outboundGuard = () => guard;
    return hub;
  }
  type Stored = { channels: Array<{ id: string; url: string; secret?: string; name: string; enabled: boolean }> };

  it("say that a channel's address could not be read, keep it through other changes, and send nothing to it", async () => {
    const dir = await tempDir();
    const first = await makeHub(dir);
    await first.request({ action: "notify-channel-save", channel: { kind: "webhook", name: "pager", url: "https://hooks.example.com/services/T0/B0/abcdef", secret: "signing-secret-1", events: ["approval"] } } as never);
    const file = (await fs.readdir(dir, { recursive: true })).map((f) => path.join(dir, String(f))).find((f) => path.basename(f).startsWith("notif"))!;
    const before = await readJson<Stored>(file);
    expect(isEncryptedSecret(before.channels[0].url)).toBe(true);
    expect((await first.snapshot()).notifications!.channels[0].secretUnread).toBeUndefined();
    await first.dispose();

    keyring.available = false;
    const second = await makeHub(dir);
    const view = (await second.snapshot()).notifications!.channels[0];
    expect(view).toMatchObject({ name: "pager", host: "", hasSecret: false, secretUnread: true });
    // Another setting of the channel is saved without typing the address again: both secrets stay as stored.
    await second.request({ action: "notify-channel-save", channel: { id: view.id, kind: "webhook", name: "pager duty", enabled: false, events: ["approval"] } } as never);
    let now = await readJson<Stored>(file);
    expect(now.channels[0]).toMatchObject({ name: "pager duty", enabled: false, url: before.channels[0].url, secret: before.channels[0].secret });
    // A test is not sent to nowhere: it says why.
    await expect(second.request({ action: "notify-channel-test", id: view.id })).rejects.toThrow("The channel's address could not be read on this start");
    // Nothing is sent to it, and its status says why.
    await second.request({ action: "notify-channel-save", channel: { id: view.id, kind: "webhook", name: "pager duty", enabled: true, events: ["approval"] } } as never);
    const inner = second as unknown as { sendToChannels: (items: unknown[], since: Map<string, number>) => Promise<void> };
    await inner.sendToChannels([{ id: "approval:1", kind: "approval", title: "Restart nginx" }], new Map());
    expect((await second.snapshot()).notifications!.channels[0].last).toMatchObject({ ok: false, error: expect.stringContaining("The channel's address could not be read on this start") });
    now = await readJson<Stored>(file);
    expect(now.channels[0].url).toBe(before.channels[0].url);
    await second.dispose();

    keyring.available = true;
    const third = await makeHub(dir);
    expect((await third.snapshot()).notifications!.channels[0]).toMatchObject({ name: "pager duty", host: "hooks.example.com", hasSecret: true });
    expect((await third.snapshot()).notifications!.channels[0].secretUnread).toBeUndefined();
  }, 60_000);

  it("take a new address typed while the old one could not be read", async () => {
    const dir = await tempDir();
    const first = await makeHub(dir);
    await first.request({ action: "notify-channel-save", channel: { kind: "slack", name: "ops", url: "https://hooks.example.com/services/OLD", events: ["approval"] } } as never);
    await first.dispose();
    keyring.available = false;
    const second = await makeHub(dir);
    const id = (await second.snapshot()).notifications!.channels[0].id;
    await second.request({ action: "notify-channel-save", channel: { id, kind: "slack", name: "ops", url: "https://hooks.example.com/services/NEW", events: ["approval"] } } as never);
    expect((await second.snapshot()).notifications!.channels[0]).toMatchObject({ host: "hooks.example.com" });
    expect((await second.snapshot()).notifications!.channels[0].secretUnread).toBeUndefined();
    await second.dispose();
    keyring.available = true;
    const third = await makeHub(dir);
    const file = (await fs.readdir(dir, { recursive: true })).map((f) => path.join(dir, String(f))).find((f) => path.basename(f).startsWith("notif"))!;
    expect((await readJson<Stored>(file)).channels[0].url).toBe("https://hooks.example.com/services/NEW");
    expect((await third.snapshot()).notifications!.channels[0].host).toBe("hooks.example.com");
  }, 60_000);
});

describe("the connection to Jira and Confluence", () => {
  const host = { tickets: () => [], putTicket: () => undefined, ticketRuns: async () => false, once: async () => true, guard: () => guard, kbDocs: () => [], ingest: async () => ({ added: [], duplicates: [], failed: [] }), persist: async () => undefined, record: () => undefined, changed: () => undefined } as unknown as BridgeHost;
  type Stored = { jira?: { token: string; projects?: string[]; baseUrl: string }; confluence?: { token: string } };

  it("keeps its token through a start without the keyring, says so, and takes a new one", async () => {
    const file = path.join(await tempDir(), "atlassian.json");
    const first = new AtlassianStore(file);
    await first.load();
    await new AtlassianBridge(first, host).save({ product: "jira", variant: "cloud", baseUrl: "https://acme.atlassian.net", email: "ops@acme.se", token: "jira-token-1", enabled: true, projects: ["OPS"] });
    const before = await readJson<Stored>(file);
    expect(isEncryptedSecret(before.jira!.token)).toBe(true);

    keyring.available = false;
    const store = new AtlassianStore(file);
    await store.load();
    const bridge = new AtlassianBridge(store, host);
    expect(store.data.jira!.token).toBe("");
    expect(store.tokenUnread("jira")).toBe(true);
    expect(bridge.view("jira")).toMatchObject({ hasToken: false, lastError: expect.stringContaining("The token could not be read on this start") });
    expect(await bridge.test("jira")).toMatchObject({ ok: false, error: expect.stringContaining("The token could not be read on this start") });
    await expect(bridge.syncJira(Date.now(), true)).rejects.toThrow("The token could not be read on this start");
    // Another setting is saved for the same site without the token: it stays as stored.
    await bridge.save({ product: "jira", variant: "cloud", baseUrl: "https://acme.atlassian.net", email: "ops@acme.se", enabled: true, projects: ["OPS", "WEB"] });
    let now = await readJson<Stored>(file);
    expect(now.jira).toMatchObject({ token: before.jira!.token, projects: ["OPS", "WEB"] });
    // Another site needs its own token: the old one is not carried there.
    await expect(bridge.save({ product: "jira", variant: "cloud", baseUrl: "https://other.atlassian.net", email: "ops@acme.se", enabled: true })).rejects.toThrow("The address changed, so the token has to be entered again.");
    expect((await readJson<Stored>(file)).jira!.token).toBe(before.jira!.token);

    keyring.available = true;
    const later = new AtlassianStore(file);
    await later.load();
    expect(later.data.jira!.token).toBe("jira-token-1");
    expect(later.tokenUnread("jira")).toBe(false);

    // A token entered while the old one could not be read replaces it; disconnecting lets it go.
    keyring.available = false;
    const again = new AtlassianStore(file);
    await again.load();
    const againBridge = new AtlassianBridge(again, host);
    await againBridge.save({ product: "jira", variant: "cloud", baseUrl: "https://acme.atlassian.net", email: "ops@acme.se", token: "jira-token-2", enabled: true, projects: ["OPS"] });
    now = await readJson<Stored>(file);
    expect(now.jira!.token).toBe("jira-token-2");
    expect(again.tokenUnread("jira")).toBe(false);
    await againBridge.disconnect("jira");
    expect((await readJson<Stored>(file)).jira).toBeUndefined();
  });
});

describe("the team's chat bot", () => {
  type Stored = { connections: Array<{ service: string; token: string; enabled: boolean }>; retentionDays?: number };

  it("keeps its token through a start without the keyring and a change of another setting", async () => {
    const dir = await tempDir();
    const first = new ChatBridge(dir, { guard: () => guard });
    await first.load();
    await first.save({ service: "slack", token: "xoxb-1234-abcdef", enabled: true });
    const file = path.join(dir, "connections.json");
    const before = await readJson<Stored>(file);
    expect(isEncryptedSecret(before.connections[0].token)).toBe(true);

    keyring.available = false;
    const second = new ChatBridge(dir, { guard: () => guard });
    await second.load();
    expect(second.view()[0]).toMatchObject({ hasToken: false, lastError: expect.stringContaining("The bot's token could not be read on this start") });
    expect(await second.test("slack")).toMatchObject({ ok: false, error: expect.stringContaining("The bot's token could not be read on this start") });
    await second.setRetention(30);
    await second.save({ service: "slack", enabled: false });
    const now = await readJson<Stored>(file);
    expect(now).toMatchObject({ retentionDays: 30, connections: [{ service: "slack", token: before.connections[0].token, enabled: false }] });

    keyring.available = true;
    const third = new ChatBridge(dir, { guard: () => guard });
    await third.load();
    expect(third.view()[0]).toMatchObject({ hasToken: true, enabled: false });
    expect(third.view()[0].lastError).toBeUndefined();
    expect(await third.usesToken("slack", "xoxb-1234-abcdef")).toBe(true);
    // Disconnected while unread: nothing of it is written back.
    keyring.available = false;
    const fourth = new ChatBridge(dir, { guard: () => guard });
    await fourth.load();
    await fourth.disconnect("slack", false);
    expect((await readJson<Stored>(file)).connections).toEqual([]);
  });
});

describe("the team bucket's secret key", () => {
  const callbacks = { getLocalState: async () => ({ actor: "a", servers: [], memories: [], activityLog: [], deletedServerIds: {}, deletedMemoryIds: {}, activeTerminals: [] }), applyMergedState: async () => undefined, onStateChanged: () => undefined };
  type Stored = { enabled: boolean; bucket: string; secretAccessKeyEncrypted?: string };

  it("is kept through a start without the keyring, and the status says why the bucket is not synced with", async () => {
    const file = path.join(await tempDir(), "s3-workspace.json");
    const first = new S3WorkspaceSyncService(file, callbacks);
    (first as unknown as { config: Record<string, unknown> }).config = { enabled: true, region: "eu-north-1", bucket: "team", prefix: "sshs3-workspace", accessKeyId: "TEAMKEYID0000000", secretAccessKey: "bucket-secret-1", forcePathStyle: true };
    await first.save();
    const before = await readJson<Stored>(file);
    expect(isEncryptedSecret(before.secretAccessKeyEncrypted)).toBe(true);

    keyring.available = false;
    const second = new S3WorkspaceSyncService(file, callbacks);
    await second.load();
    expect(second.getStatus()).toMatchObject({ configured: false, enabled: true, bucket: "team", hasSecretAccessKey: false, error: expect.stringContaining("The team bucket's secret key could not be read on this start") });
    // Disconnecting saves the settings: the key stays as it was stored.
    await second.disconnect();
    expect(await readJson<Stored>(file)).toMatchObject({ enabled: false, bucket: "team", secretAccessKeyEncrypted: before.secretAccessKeyEncrypted });
    // Switched off, it no longer reports a fault.
    expect(second.getStatus().error).toBeUndefined();

    keyring.available = true;
    const third = new S3WorkspaceSyncService(file, callbacks);
    await third.load();
    expect(third.getStatus()).toMatchObject({ hasSecretAccessKey: true, bucket: "team" });
    expect(third.getStatus().error).toBeUndefined();
    expect((third as unknown as { config: { secretAccessKey: string } }).config.secretAccessKey).toBe("bucket-secret-1");
    await third.dispose();
    await second.dispose();
    await first.dispose();
  });
});
