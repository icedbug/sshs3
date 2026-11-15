import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

const electronMock = vi.hoisted(() => ({
  available: true,
  fail: false,
  userData: "",
}));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userData || os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => electronMock.available,
    encryptString: (value: string) => {
      if (electronMock.fail) throw new Error("Test keyring unavailable");
      return Buffer.from(value.split("").reverse().join(""));
    },
    decryptString: (value: Buffer) =>
      value.toString().split("").reverse().join(""),
  },
}));

import {
  classifyIpAddress,
  requestJson,
  resolveAndValidateTarget,
  setSharedServerCheck,
  SsrfBlockedError,
} from "../../src/main/oauth/requestJson";
import {
  createWebOidcAuthRequest,
  discoverOidc,
  parseWebOidcCallback,
  signInWithWebRelay,
  validateOidcIssuerUrl,
} from "../../src/main/ca/oidcFlow";
import {
  buildAgentScopedCertSpec,
  SshCaService,
} from "../../src/main/ca/SshCaService";
import { AiConfigStore } from "../../src/main/ai/AiConfigStore";
import { CodexAuthProvider } from "../../src/main/ai/CodexAuthProvider";
import type {
  ISshCaProvider,
  SshCaConfig,
  SshCaSignRequest,
  SshCaSignResponse,
} from "../../src/shared/types/sshCa";
import { buildUserCertificate } from "../helpers/sshTestCert";

function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("requestJson SSRF protection & IP pinning", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("classifies IPv4, IPv6, and embedded IPv4-mapped addresses accurately", () => {
    expect(classifyIpAddress("127.0.0.1")).toBe("loopback");
    expect(classifyIpAddress("::1")).toBe("loopback");
    expect(classifyIpAddress("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIpAddress("::ffff:7f00:1")).toBe("loopback");
    expect(classifyIpAddress("169.254.169.254")).toBe("link-local");
    expect(classifyIpAddress("::ffff:169.254.169.254")).toBe("link-local");
    expect(classifyIpAddress("fe80::1%eth0")).toBe("link-local");
    expect(classifyIpAddress("fd00:ec2::254")).toBe("never");
    expect(classifyIpAddress("10.1.2.3")).toBe("private");
    expect(classifyIpAddress("172.16.0.1")).toBe("private");
    expect(classifyIpAddress("192.168.1.10")).toBe("private");
    expect(classifyIpAddress("100.64.0.1")).toBe("private");
    expect(classifyIpAddress("64:ff9b::10.0.0.5")).toBe("private");
    expect(classifyIpAddress("fc00::1")).toBe("private");
    expect(classifyIpAddress("0.0.0.0")).toBe("never");
    expect(classifyIpAddress("224.0.0.1")).toBe("never");
    expect(classifyIpAddress("93.184.216.34")).toBe("public");
    expect(classifyIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe("public");
  });

  it("blocks loopback, link-local, metadata, private, embedded credentials, and plain-http public hosts", async () => {
    // Loopback and private addresses are blocked on a shared web server; the desktop app allows them.
    setSharedServerCheck(() => true);
    onTestFinished(() => setSharedServerCheck(undefined));
    await expect(
      requestJson("https://127.0.0.1/token", { method: "GET", timeoutMs: 1000 }),
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      requestJson("https://localhost/token", { method: "GET", timeoutMs: 1000 }),
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      requestJson("https://[::1]/token", { method: "GET", timeoutMs: 1000 }),
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      requestJson("https://169.254.169.254/latest/meta-data", {
        method: "GET",
        timeoutMs: 1000,
        allowPrivate: true,
        allowHttp: true,
      }),
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      requestJson("http://metadata.google.internal/computeMetadata/v1/", {
        method: "GET",
        timeoutMs: 1000,
        allowPrivate: true,
        allowHttp: true,
      }),
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      requestJson("https://[fd00:ec2::254]/latest", {
        method: "GET",
        timeoutMs: 1000,
        allowPrivate: true,
      }),
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      requestJson("https://10.0.0.10/api", { method: "GET", timeoutMs: 1000 }),
    ).rejects.toThrow(SsrfBlockedError);

    await expect(
      requestJson("http://93.184.216.34/api", {
        method: "GET",
        timeoutMs: 1000,
        allowHttp: true,
      }),
    ).rejects.toThrow(/Only https URLs are allowed/);

    await expect(
      requestJson("https://user:secret@example.com/api", {
        method: "GET",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/embedded credentials/);
  });

  it("validates DNS responses against rebinding and pins the resolved IP on the connection", async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://169.254.169.254/latest" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, hostHeader: req.headers.host }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    // Mixed DNS response where second record is metadata: must reject all
    await expect(
      resolveAndValidateTarget("https://rebind.example.test/v1", {
        lookup: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
      }),
    ).rejects.toThrow(SsrfBlockedError);

    // On a shared server a private DNS record is rejected
    setSharedServerCheck(() => true);
    onTestFinished(() => setSharedServerCheck(undefined));
    await expect(
      requestJson(`https://internal-idp.example.test:${port}/x`, {
        method: "GET",
        timeoutMs: 1000,
        lookup: async () => [{ address: "10.20.30.40", family: 4 }],
      }),
    ).rejects.toThrow(SsrfBlockedError);
    setSharedServerCheck(undefined);

    // Opted-in loopback DNS resolution pins 127.0.0.1 without touching real DNS
    const okRes = await requestJson(`http://local-dev.example.test:${port}/ok`, {
      method: "GET",
      timeoutMs: 2000,
      allowHttp: true,
      allowLoopback: true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json).toMatchObject({ ok: true });

    // Redirects are never followed automatically
    const redirRes = await requestJson(`http://127.0.0.1:${port}/redirect`, {
      method: "GET",
      timeoutMs: 2000,
      allowHttp: true,
    });
    expect(redirRes.statusCode).toBe(302);
  });
});

describe("oidcFlow issuer validation & web relay", () => {
  let oidcServer: http.Server | undefined;
  let baseUrl = "";
  let issuedNonce = "";

  afterEach(async () => {
    oidcServer?.closeAllConnections();
    if (oidcServer) {
      await new Promise<void>((resolve) => oidcServer!.close(() => resolve()));
      oidcServer = undefined;
    }
  });

  it("enforces strict issuer URL rules", () => {
    expect(validateOidcIssuerUrl("https://idp.example.com/realms/main/")).toBe(
      "https://idp.example.com/realms/main",
    );
    expect(validateOidcIssuerUrl("http://127.0.0.1:8080/realms/dev")).toBe(
      "http://127.0.0.1:8080/realms/dev",
    );
    expect(() => validateOidcIssuerUrl("http://idp.example.com")).toThrow(/https/);
    expect(() => validateOidcIssuerUrl("http://localhost.evil.com")).toThrow(/https/);
    expect(() => validateOidcIssuerUrl("https://user:pw@idp.example.com")).toThrow(/credentials/);
    expect(() => validateOidcIssuerUrl("https://idp.example.com?foo=bar")).toThrow(/query/);
    expect(() => validateOidcIssuerUrl("https://169.254.169.254")).toThrow(/link-local/);
    expect(validateOidcIssuerUrl("https://10.0.0.5")).toBe("https://10.0.0.5");
    setSharedServerCheck(() => true);
    try {
      expect(() => validateOidcIssuerUrl("https://10.0.0.5")).toThrow(/private/);
    } finally {
      setSharedServerCheck(undefined);
    }
    expect(validateOidcIssuerUrl("https://10.0.0.5", { allowPrivate: true })).toBe("https://10.0.0.5");
  });

  it("rejects OIDC discovery documents whose issuer mismatches the configured issuer", async () => {
    oidcServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: "https://evil-other-issuer.example.com",
          authorization_endpoint: `${baseUrl}/auth`,
          token_endpoint: `${baseUrl}/token`,
        }),
      );
    });
    await new Promise<void>((resolve) => oidcServer!.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`;

    await expect(
      discoverOidc({ issuerUrl: baseUrl, clientId: "sshca" }),
    ).rejects.toThrow(/issuer mismatch/);
  });

  it("completes web-relayed PKCE OIDC sign-in with constant-time state and nonce checks", async () => {
    oidcServer = http.createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/auth`,
            token_endpoint: `${baseUrl}/token`,
          }),
        );
        return;
      }
      if (req.url === "/token" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id_token: fakeJwt({
              sub: "u-web",
              preferred_username: "webalice",
              nonce: issuedNonce,
            }),
            refresh_token: "rt_web_1",
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => oidcServer!.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`;

    const client = { issuerUrl: baseUrl, clientId: "web-client" };
    const endpoints = await discoverOidc(client);

    const authReq = createWebOidcAuthRequest(client, endpoints, "https://sshs3.example.com/api/ca/oidc/callback");
    expect(parseWebOidcCallback(`?code=abc&state=wrong`, authReq.state).kind).toBe("state-mismatch");
    expect(parseWebOidcCallback({ state: authReq.state, error: "access_denied" }, authReq.state)).toEqual({
      kind: "error",
      message: "SSH CA was rejected (access_denied)",
    });

    const controller = new AbortController();
    const result = await signInWithWebRelay(client, endpoints, {
      redirectUri: "https://sshs3.example.com/api/ca/oidc/callback",
      openAuthUrl: async (url) => {
        const parsed = new URL(url);
        issuedNonce = parsed.searchParams.get("nonce") ?? "";
      },
      waitForCallback: async (state) => ({ code: "web-code-123", state }),
      signal: controller.signal,
    });
    expect(result.username).toBe("webalice");
    expect(result.refreshToken).toBe("rt_web_1");
  });
});

describe("SshCaService web relay & agent-scoped cert spec", () => {
  let oidcServer: http.Server | undefined;
  let baseUrl = "";
  let latestNonce = "";

  afterEach(async () => {
    oidcServer?.closeAllConnections();
    if (oidcServer) {
      await new Promise<void>((resolve) => oidcServer!.close(() => resolve()));
      oidcServer = undefined;
    }
  });

  async function startMockOidc() {
    oidcServer = http.createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/auth`,
            token_endpoint: `${baseUrl}/token`,
          }),
        );
        return;
      }
      if (req.url === "/token" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id_token: fakeJwt({
              sub: "agent-user-1",
              preferred_username: "opsbot",
              email: "opsbot@example.com",
              nonce: latestNonce,
            }),
            refresh_token: "rt_ca_web",
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => oidcServer!.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`;
  }

  it("handles web-relayed OIDC callbacks and ignores mismatched states without aborting login", async () => {
    await startMockOidc();

    const mockAgent = {
      addCertifiedEd25519Key: vi.fn().mockResolvedValue(undefined),
      removeIdentities: vi.fn().mockResolvedValue(0),
    } as any;
    let capturedPrincipals: string[] | undefined;
    const provider: ISshCaProvider = {
      id: "step-ca",
      sign: vi.fn().mockImplementation(async (req: SshCaSignRequest): Promise<SshCaSignResponse> => {
        capturedPrincipals = req.principals;
        const cert = buildUserCertificate({ subjectWireBase64: req.publicKeyWireBase64 });
        return { certificateWireBase64: cert.wireBase64, certificateLine: cert.line };
      }),
    };

    const service = new SshCaService({
      appAgent: mockAgent,
      webCallbackUrl: "https://sshs3.example.com/api/ca/oidc/callback",
      providers: new Map([["step-ca", provider]]),
    });

    const config: SshCaConfig = {
      id: "ca-web-1",
      name: "Web CA",
      backend: "step-ca",
      caUrl: "https://ca.example.com",
      oidcIssuerUrl: baseUrl,
      oidcClientId: "sshs3-web",
      keySource: "ephemeral",
      defaultPrincipals: ["opsbot", "deploy"],
    };

    const started = await service.startWebLogin(config, {
      agentScope: {
        agentId: "triage-bot",
        taskId: "task-99",
        allowedPrincipals: ["opsbot", "deploy", "root"],
      },
    });
    latestNonce = new URL(started.authorizationUrl).searchParams.get("nonce") ?? "";

    // Bogus state must be rejected without interrupting the active web flow
    const wrong = await service.handleWebCallback(`?code=forged&state=not-the-state`);
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toMatch(/Invalid or expired/);

    // Valid callback completes the login
    const good = await service.handleWebCallback(`?code=real-code&state=${encodeURIComponent(started.state)}`);
    expect(good.ok).toBe(true);
    expect(good.status?.active).toBe(true);
    expect(good.status?.username).toBe("opsbot");
    expect(capturedPrincipals).toEqual(["opsbot", "deploy"]);
    expect(mockAgent.addCertifiedEd25519Key).toHaveBeenCalledTimes(1);
    const loadedOpts = mockAgent.addCertifiedEd25519Key.mock.calls[0][0];
    expect(loadedOpts.comment).toBe("sshs3-agent:opsbot:triage-bot:task-99");
    expect(loadedOpts.lifetimeSeconds).toBeLessThanOrEqual(900);

    await service.logout();
  });

  it("cancels pending web logins on logout", async () => {
    await startMockOidc();
    const service = new SshCaService({
      appAgent: { addCertifiedEd25519Key: vi.fn(), removeIdentities: vi.fn() } as any,
      webCallbackUrl: "https://sshs3.example.com/api/ca/oidc/callback",
    });

    const started = await service.startWebLogin({
      id: "ca-web-2",
      name: "Web CA",
      backend: "step-ca",
      caUrl: "https://ca.example.com",
      oidcIssuerUrl: baseUrl,
      oidcClientId: "sshs3-web",
      keySource: "ephemeral",
    });

    await service.logout();
    await expect(started.completion).rejects.toThrow(/cancel/i);
  });

  it("builds constrained short-lived agent-scoped SSH CA cert specs", () => {
    const spec = buildAgentScopedCertSpec({
      username: "alice",
      agentId: "investigator-1",
      taskId: "inc-42",
      requestedPrincipals: ["deploy", "readonly", "deploy"],
      allowedPrincipals: ["deploy", "audit"],
      ttlSeconds: 7200, // clamped to 3600
      forceCommand: "/usr/local/bin/ro-check",
      sourceAddresses: ["10.0.0.0/8", "2001:db8::/32"],
      nowSeconds: 1_700_000_000,
    });

    expect(spec.keyId).toBe("sshs3-agent:alice:investigator-1:inc-42");
    expect(spec.principals).toEqual(["deploy"]);
    expect(spec.ttlSeconds).toBe(3600);
    expect(spec.validAfter).toBe(1_700_000_000);
    expect(spec.validBefore).toBe(1_700_003_600);
    expect(spec.criticalOptions).toEqual({
      "force-command": "/usr/local/bin/ro-check",
      "source-address": "10.0.0.0/8,2001:db8::/32",
    });
    expect(spec.extensions).toEqual([]);

    // Rejects root & wildcard by default, invalid CIDRs, and control chars in forceCommand
    expect(() =>
      buildAgentScopedCertSpec({ username: "alice", agentId: "a1", requestedPrincipals: ["root"] }),
    ).toThrow(/not permitted/);
    expect(() =>
      buildAgentScopedCertSpec({ username: "alice", agentId: "a1", requestedPrincipals: ["*"] }),
    ).toThrow(/not permitted/);
    expect(() =>
      buildAgentScopedCertSpec({ username: "alice", agentId: "a1", sourceAddresses: ["not-a-cidr"] }),
    ).toThrow(/Invalid source-address CIDR/);
    expect(() =>
      buildAgentScopedCertSpec({ username: "alice", agentId: "a1", forceCommand: "ls\nrm -rf /" }),
    ).toThrow(/control characters/);
  });
});

describe("AiConfigStore multi-profile, roles & residency/PII persistence", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    electronMock.available = true;
    electronMock.fail = false;
    electronMock.userData = "";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-aiconfig-overhaul-"));
    file = path.join(dir, "ai-config.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("stores encrypted per-profile keys, binds roles & aliases, and persists egressPolicy/zdrConfirmed/piiScrubbing", async () => {
    const store = new AiConfigStore(file);

    const view = await store.update({
      enabled: true,
      egressPolicy: "eu-pinned",
      zdrConfirmed: true,
      piiScrubbing: "strict",
      profiles: [
        {
          id: "prof-reasoning",
          name: "Anthropic EU",
          provider: "anthropic",
          model: "claude-opus-5-5",
          baseUrl: "https://eu.api.anthropic.com",
          reasoningEffort: "high",
          egressPolicy: "eu-pinned",
          zdrConfirmed: true,
        },
        {
          id: "prof-fast",
          name: "Local Ollama",
          provider: "openai-compatible",
          model: "qwen2.5-coder:7b",
          baseUrl: "http://127.0.0.1:11434/v1",
          egressPolicy: "local-only",
        },
      ],
      profileApiKeys: {
        "prof-reasoning": "sk-ant-eu-secret-1", // pragma: allowlist secret
        "prof-fast": "ollama-local-token", // pragma: allowlist secret
      },
      activeProfileByRole: {
        primary: "prof-reasoning",
        fastTriage: "prof-fast",
      },
    });

    expect(view.egressPolicy).toBe("eu-pinned");
    expect(view.zdrConfirmed).toBe(true);
    expect(view.piiScrubbing).toBe("strict");
    expect(view.profiles).toHaveLength(2);
    expect(view.profiles?.[0]).toMatchObject({
      id: "prof-reasoning",
      hasApiKey: true,
      keyStorage: "encrypted",
    });
    expect(view.profiles?.[0]).not.toHaveProperty("apiKey");

    // Disk file must never contain plaintext keys
    const onDisk = await fs.readFile(file, "utf8");
    expect(onDisk).not.toContain("sk-ant-eu-secret-1");
    expect(onDisk).not.toContain("ollama-local-token");

    // Fresh store instance decrypts per-profile keys & resolves canonical + alias roles
    const reloaded = new AiConfigStore(file);
    expect(await reloaded.getProfileSecret("prof-reasoning")).toBe("sk-ant-eu-secret-1");
    expect((await reloaded.getConfig()).apiKey).toBe("sk-ant-eu-secret-1");
    expect((await reloaded.resolveProfileForRole("reasoning"))?.id).toBe("prof-reasoning");
    expect((await reloaded.resolveProfileForRole("fast"))?.id).toBe("prof-fast");
    expect((await reloaded.resolveProfileForRole("summary"))?.id).toBe("prof-reasoning"); // falls back to primary

    // Changing a profile's baseUrl origin clears its stored secret unless a new key is supplied
    await reloaded.upsertProfile({
      id: "prof-reasoning",
      name: "Anthropic Different Origin",
      provider: "anthropic",
      model: "claude-opus-5-5",
      baseUrl: "https://api.anthropic.com",
    });
    expect(await reloaded.getProfileSecret("prof-reasoning")).toBe("");

    // Setting role via alias works & deleting profile clears its key and role binding
    await reloaded.setActiveProfileForRole("summary", "prof-fast");
    expect((await reloaded.resolveProfileForRole("backgroundDistill"))?.id).toBe("prof-fast");
    const afterDelete = await reloaded.deleteProfile("prof-fast");
    expect(afterDelete.profiles?.map((p) => p.id)).toEqual(["prof-reasoning"]);
    expect(afterDelete.activeProfileByRole?.fastTriage).toBeUndefined();
    expect(await reloaded.getProfileSecret("prof-fast")).toBe("");
  });

  it("keeps per-profile keys session-only when encryption is unavailable", async () => {
    electronMock.available = false;
    const store = new AiConfigStore(file);
    const view = await store.upsertProfile({
      id: "p1",
      name: "Custom",
      provider: "openai-compatible",
      model: "llama-3",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "session-only-profile-key", // pragma: allowlist secret
    });
    expect(view.profiles?.[0]).toMatchObject({ hasApiKey: true, keyStorage: "session" });
    expect(await store.getProfileSecret("p1")).toBe("session-only-profile-key");
    expect(await fs.readFile(file, "utf8")).not.toContain("session-only-profile-key");
    expect(await new AiConfigStore(file).getProfileSecret("p1")).toBe("");
  });
});

describe("CodexAuthProvider in-app PKCE & reliable refresh", () => {
  let tmpDir: string;
  let oauthServer: http.Server | undefined;
  let oauthBaseUrl = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-codex-pkce-"));
  });

  afterEach(async () => {
    oauthServer?.closeAllConnections();
    if (oauthServer) {
      await new Promise<void>((resolve) => oauthServer!.close(() => resolve()));
      oauthServer = undefined;
    }
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("completes in-app loopback PKCE login without external CLI and persists ai-auth.json", async () => {
    let seenChallenge = "";
    let seenVerifier = "";

    oauthServer = http.createServer((req, res) => {
      if (req.url === "/oauth/token" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
          seenVerifier = params.get("code_verifier") ?? "";
          const computed = crypto.createHash("sha256").update(seenVerifier).digest("base64url");
          expect(computed).toBe(seenChallenge);

          const access = fakeJwt({
            exp: Math.floor(Date.now() / 1000) + 3600,
            "https://api.openai.com/profile": { email: "pkce-user@example.com" },
            "https://api.openai.com/auth": { chatgpt_account_id: "acct-pkce-1" },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ access_token: access, refresh_token: "rt_pkce_1" }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => oauthServer!.listen(0, "127.0.0.1", () => resolve()));
    oauthBaseUrl = `http://127.0.0.1:${(oauthServer.address() as AddressInfo).port}`;

    const provider = new CodexAuthProvider(tmpDir);
    const creds = await provider.loginWithPkce({
      authorizeUrl: `${oauthBaseUrl}/oauth/authorize`,
      tokenUrl: `${oauthBaseUrl}/oauth/token`,
      allowHttpForTests: true,
      openBrowser: async (authUrl) => {
        const u = new URL(authUrl);
        seenChallenge = u.searchParams.get("code_challenge") ?? "";
        expect(u.searchParams.get("code_challenge_method")).toBe("S256");
        const cb = new URL(u.searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", "auth-code-pkce");
        cb.searchParams.set("state", u.searchParams.get("state")!);
        http.get(cb.toString());
      },
    });

    expect(creds.email).toBe("pkce-user@example.com");
    expect(creds.accountId).toBe("acct-pkce-1");
    expect((await provider.getStatus())).toEqual({
      connected: true,
      email: "pkce-user@example.com",
      defaultModel: undefined,
    });
  });

  it("supports web/headless PKCE callbacks, rejects bad state, and reports structured refresh errors", async () => {
    const provider = new CodexAuthProvider(tmpDir);
    const freshJwt = fakeJwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/profile": { email: "web-codex@example.com" },
    });

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ access_token: freshJwt, refresh_token: "rt_web_1" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant", error_description: "Refresh token revoked" }),
      });

    const started = await provider.startWebPkceLogin({
      redirectUri: "https://sshs3.example.com/api/ai/codex/callback",
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const wrong = await provider.handleWebPkceCallback("?code=x&state=wrong-state");
    expect(wrong.ok).toBe(false);

    const good = await provider.handleWebPkceCallback(`?code=web-code&state=${encodeURIComponent(started.state)}`);
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.credentials.email).toBe("web-codex@example.com");
    }

    const failedRefresh = await provider.refreshNow(mockFetch as unknown as typeof fetch);
    expect(failedRefresh.ok).toBe(false);
    if (!failedRefresh.ok) {
      expect(failedRefresh.oauthError).toBe("invalid_grant");
      expect(failedRefresh.retryable).toBe(false);
      expect(failedRefresh.error).toContain("Refresh token revoked");
    }
    expect(provider.getLastRefreshError()?.oauthError).toBe("invalid_grant");

    await provider.signOut();
    expect((await provider.getStatus()).connected).toBe(false);
  });
});
