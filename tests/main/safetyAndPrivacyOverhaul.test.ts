import { describe, expect, it } from "vitest";
import {
  boundedContext,
  boundedHeadTailContext,
  detectHighEntropySecrets,
  headTailTruncate,
  inspectUntrustedText,
  maskContext,
  maskHighEntropySecrets,
  maskSecrets,
  scrubPii,
  stripInvisibleUnicode,
} from "../../src/main/ai/hub/privacy";
import {
  dataDestination,
  describeActiveDataFlow,
  MASKED,
  validateEgressPolicy,
} from "../../src/main/ai/hub/dataDestination";

describe("privacy.ts — Unicode smuggling, Gitleaks signatures, entropy, PII & head/tail", () => {
  it("strips invisible Unicode smuggling while preserving Swedish UTF-8 and emoji", () => {
    const smuggled =
      "\uFEFFHello\u200B \u202Eevil\u202C \u2066iso\u2069 \u{E0001}\u{E0041}räksmörgås åäöÅÄÖ 🚀 👨‍👩‍👧‍👦";
    const inspected = inspectUntrustedText(smuggled);
    expect(inspected.strippedCount).toBe(8);
    expect(inspected.strippedCategories).toEqual(
      expect.arrayContaining(["bom", "zero-width", "bidi-override", "unicode-tags"]),
    );
    expect(inspected.text).toBe("Hello evil iso räksmörgås åäöÅÄÖ 🚀 👨‍👩‍👧‍👦");
    expect(stripInvisibleUnicode("pa\u200Dssword")).toBe("password");
    expect(maskContext("pass\u200Bword=hunter2")).toBe("password=[redacted]");
  });

  it("masks Slack/Teams webhooks, Vault, HuggingFace, S3 presigned sigs, and DB DSNs", () => {
    const samples = [
      "https://hooks.slack.com/services/T012345/B012345/abcDEF123456",
      "https://acme.webhook.office.com/webhookb2/1111-2222/IncomingWebhook/secret999/3333",
      "hvs.CAESIJ9xKmPqR7vLnW8zT1yB5cF0jH3a",
      "hvb.AAAAAQK9xKmPqR7vLnW8zT1yB5cF0jH3a",
      "hf_AbCdEfGhIjKlMnOpQrStUvWxYz1234",
    ];
    for (const s of samples) {
      expect(maskSecrets(`token=${s}`)).not.toContain(s);
      expect(maskSecrets(`x ${s} y`)).toBe("x [redacted] y");
    }

    const s3 =
      "https://bucket.s3.eu-north-1.amazonaws.com/file.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef0123456789abcdef&X-Amz-Security-Token=FwoGZXIvYXdz";
    const maskedS3 = maskSecrets(s3);
    expect(maskedS3).toContain("X-Amz-Signature=[redacted]");
    expect(maskedS3).toContain("X-Amz-Security-Token=[redacted]");
    expect(maskedS3).not.toContain("deadbeef");
    expect(maskedS3).not.toContain("FwoGZXIvYXdz");

    expect(maskSecrets("postgres://admin:S3cr3tPass!@db.internal:5432/prod")).toBe(
      "postgres://admin:[redacted]@db.internal:5432/prod",
    );
    expect(maskSecrets("mysql://root:hunter2@10.0.0.5:3306/app")).toBe(
      "mysql://root:[redacted]@10.0.0.5:3306/app",
    );
    expect(maskSecrets("redis://:onlypass@127.0.0.1:6379")).toBe(
      "redis://:[redacted]@127.0.0.1:6379",
    );
  });

  it("detects high-entropy opaque secrets without breaking SHA-256 hex checksums or UUIDs", () => {
    const sha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const opaque = "K9x!mP2qR7vL4nW8zT1yB5cF0jH3aE6dG9sQ2";
    const text = `sha256=${sha256} id=${uuid} secret_blob=${opaque.replace("!", "Z")}`;

    const hits = detectHighEntropySecrets(text);
    expect(hits.map((h) => h.token)).toContain(opaque.replace("!", "Z"));
    expect(hits.map((h) => h.token)).not.toContain(sha256);
    expect(hits.map((h) => h.token)).not.toContain(uuid);

    const masked = maskHighEntropySecrets(text);
    expect(masked).toContain(sha256);
    expect(masked).toContain(uuid);
    expect(masked).not.toContain("K9xZmP2q");
  });

  it("scrubs PII according to off / standard / strict modes", () => {
    const sample =
      "User alice@example.com called +46 70 123 45 67 from 203.0.113.42 via 10.0.0.5 (local 070-9876543)";

    expect(scrubPii(sample, "off")).toBe(sample);

    const standard = scrubPii(sample, "standard");
    expect(standard).not.toContain("alice@example.com");
    expect(standard).not.toContain("+46 70 123 45 67");
    expect(standard).not.toContain("203.0.113.42");
    expect(standard).toContain("10.0.0.5");

    const strict = scrubPii(sample, "strict");
    expect(strict).not.toContain("10.0.0.5");
    expect(strict).not.toContain("070-9876543");

    expect(maskContext("email=alice@example.com", { piiMode: "standard" })).toBe(
      "email=[email redacted]",
    );
  });

  it("headTailTruncate keeps head (35%) and tail (65%) within maxChars", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${String(i).padStart(3, "0")}: payload`);
    const log = lines.join("\n");
    const out = headTailTruncate(log, 400, 0.35);
    expect(out.length).toBeLessThanOrEqual(400);
    expect(out).toContain("line-000");
    expect(out).toContain("line-099");
    expect(out).toContain("omitted");

    expect(boundedHeadTailContext("password=secret\n" + log, 400)).not.toContain("secret");
    expect(boundedContext("abc", 10)).toBe("abc");
  });
});

describe("dataDestination.ts — egress policy validation & active data flow breakdown", () => {
  it("preserves dataDestination() compatibility", () => {
    expect(dataDestination("anthropic")).toContain("Anthropic's API");
    expect(dataDestination("anthropic")).toContain(MASKED);
    expect(dataDestination("openai-codex")).toContain("OpenAI under your ChatGPT account");
    expect(dataDestination("openai-compatible", "http://10.0.0.5:8000/v1")).toContain("10.0.0.5:8000");
  });

  it("enforces local-only, eu-pinned, HTTPS on non-loopback, and zdrConfirmed", () => {
    // local-only allows loopback HTTP and RFC1918 HTTPS
    expect(
      validateEgressPolicy({
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        egressPolicy: "local-only",
      }).allowed,
    ).toBe(true);

    expect(
      validateEgressPolicy({
        provider: "openai-compatible",
        baseUrl: "https://10.0.0.5:8000/v1",
        egressPolicy: "local-only",
      }).allowed,
    ).toBe(true);

    // Non-loopback HTTP fails HTTPS check
    const httpPrivate = validateEgressPolicy({
      provider: "openai-compatible",
      baseUrl: "http://10.0.0.5:8000/v1",
      egressPolicy: "local-only",
    });
    expect(httpPrivate.allowed).toBe(false);
    expect(httpPrivate.errors.join(" ")).toContain("has to be reached over https. This address is not: http://10.0.0.5:8000.");

    // local-only rejects cloud providers
    expect(
      validateEgressPolicy({
        provider: "anthropic",
        egressPolicy: "local-only",
        zdrConfirmed: true,
      }).allowed,
    ).toBe(false);

    // eu-pinned enforces allowlist + zdrConfirmed
    expect(
      validateEgressPolicy({
        provider: "openai-compatible",
        baseUrl: "https://eu.api.openai.com/v1",
        egressPolicy: "eu-pinned",
        zdrConfirmed: true,
      }).allowed,
    ).toBe(true);

    expect(
      validateEgressPolicy({
        provider: "anthropic",
        egressPolicy: "eu-pinned",
        zdrConfirmed: true,
      }).allowed,
    ).toBe(false);

    // zdrConfirmed required on external cloud endpoints
    const noZdr = validateEgressPolicy({
      provider: "anthropic",
      egressPolicy: "standard",
      zdrConfirmed: false,
    });
    expect(noZdr.allowed).toBe(false);
    expect(noZdr.errors.join(" ")).toContain("You have not confirmed that api.anthropic.com keeps none of what is sent to it");
  });

  it("describes active data flow across LLM, S3 sync, and local storage", () => {
    const flow = describeActiveDataFlow(
      {
        provider: "openai-compatible",
        baseUrl: "https://eu.api.openai.com/v1",
        egressPolicy: "eu-pinned",
        zdrConfirmed: true,
      },
      {
        enabled: true,
        bucket: "ops-team-eu",
        region: "eu-north-1",
        prefix: "sshs3",
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      },
    );

    expect(flow.egressValidation.allowed).toBe(true);
    expect(flow.channels).toHaveLength(3);
    expect(flow.channels.find((c) => c.channel === "llm-inference")?.locality).toBe("eu");
    expect(flow.channels.find((c) => c.channel === "team-s3-sync")?.locality).toBe("eu");
    expect(flow.subprocessors).toHaveLength(2);
    expect(flow.subprocessors[0].zdrConfirmed).toBe(true);
  });
});
