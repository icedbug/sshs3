import { describe, expect, it } from "vitest";
import { maskContext } from "../../src/main/ai/hub/privacy";

/**
 * Masking hides the value after "password:" or "token:", and it took words out of what a person wrote.
 * In the lab, "...database password: set a new password..." reached the model as "...database
 * password: [redacted] a new password...", and the model refused, thinking it had been given a
 * password it could not see. Settings that count tokens were hidden too. Neither is a secret.
 */
describe("masking leaves a person's own words and counts alone", () => {
  it("keeps a sentence that goes on after password:", () => {
    for (const text of [
      "Rotate the app's database password: set a new password for the app user and restart the app.",
      "Rotate the app's database password: please choose a long one.",
      "The deploy password: the one in the vault, under prod/db.",
      "Admin password: unchanged since the move, ask Maria.",
      "Password: Please use the one from the vault.",
      "db password: in vault/prod/db as usual",
    ])
      expect(maskContext(text)).toBe(text);
  });

  it("keeps a count of tokens", () => {
    for (const text of [
      "contextWindowTokens: 400000",
      "maxOutputTokens: 128000",
      "max_tokens=4096",
      '{"input_tokens": 1234, "output_tokens": 56}',
      "MAX_TOKENS=8192",
    ])
      expect(maskContext(text)).toBe(text);
  });

  it("still hides a password or token given that way", () => {
    expect(maskContext("password: hunter2")).toBe("password: [redacted]"); // pragma: allowlist secret
    expect(maskContext("password: summer")).toBe("password: [redacted]"); // pragma: allowlist secret
    // A word that is no word a sentence goes on with: a password said in passing, still hidden.
    expect(maskContext("my password: sunshine and you know it")).toBe("my password: [redacted] and you know it"); // pragma: allowlist secret
    expect(maskContext("db password: Hunter2-x9Zq please")).toBe("db password: [redacted] please"); // pragma: allowlist secret
    // A word a sentence goes on with, but alone on its line: a value.
    expect(maskContext("password: set")).toBe("password: [redacted]"); // pragma: allowlist secret
    expect(maskContext("password=set a new one")).toBe("password=[redacted] a new one"); // pragma: allowlist secret
    // One token is a secret, whatever it looks like; only a count after a plural name is not.
    expect(maskContext("token: 123456")).toBe("token: [redacted]"); // pragma: allowlist secret
    expect(maskContext("api_tokens: abc123def456")).toBe("api_tokens: [redacted]"); // pragma: allowlist secret
  });
});
