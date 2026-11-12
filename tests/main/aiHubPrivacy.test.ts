import { describe, expect, it } from "vitest";
import { maskContext } from "../../src/main/ai/hub/privacy";

describe("maskContext", () => {
  it("masks credentials in the forms they appear in terminal output and configuration", () => {
    const masked = maskContext(
      [
        "export DB_PASSWORD=hunter2secret", // pragma: allowlist secret
        'api_key: "abcd1234efgh"', // pragma: allowlist secret
        "my_service_auth_token = tok_live_999", // pragma: allowlist secret
        "postgres://app:s3cretpw@db.internal:5432/app", // pragma: allowlist secret
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload", // pragma: allowlist secret
        "AKIAABCDEFGHIJKLMNOP", // pragma: allowlist secret
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----", // pragma: allowlist secret
      ].join("\n"),
    );
    for (const secret of ["hunter2secret", "abcd1234efgh", "tok_live_999", "s3cretpw", "eyJhbGciOiJIUzI1NiJ9", "AKIAABCDEFGHIJKLMNOP", "b3BlbnNzaA"])
      expect(masked).not.toContain(secret);
    // What surrounds a secret stays readable.
    expect(masked).toContain("export DB_PASSWORD=[redacted]");
    expect(masked).toContain("postgres://app:[redacted]@db.internal:5432/app");
    expect(masked).toContain("my_service_auth_token = [redacted]");
  });

  it("leaves ordinary output alone", () => {
    const text = "Filesystem Size Used Avail Use%\n/dev/sda1 100G 41G 59G 41% /\nhttps://docs.example.com/guide#tokens";
    expect(maskContext(text)).toBe(text);
  });

  it("stays fast on long unbroken runs (base64, hex dumps, minified data)", () => {
    const inputs = [
      "x".repeat(30_000),
      Buffer.from("x".repeat(22_500)).toString("base64"),
      "a.".repeat(15_000),
      "deadbeef".repeat(4000),
      "key-".repeat(7500),
    ];
    for (const input of inputs) {
      const started = performance.now();
      expect(maskContext(input)).toBe(input);
      // Was 200–900 ms each before the patterns were bounded.
      expect(performance.now() - started).toBeLessThan(100);
    }
  });

  it("still masks a secret that sits right after a long run", () => {
    const masked = maskContext(`${"x".repeat(20_000)} password=hunter2secret`); // pragma: allowlist secret
    expect(masked).not.toContain("hunter2secret");
  });
});
