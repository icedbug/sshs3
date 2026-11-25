import { describe, expect, it } from "vitest";
import { maskContext } from "../../src/main/ai/hub/privacy";

/**
 * Redis keeps its passwords in lines of its own: `requirepass <password>` and `masterauth <password>`
 * in redis.conf, and `>password` in an ACL rule. `REDIS_PASSWORD=` was masked, but those lines went to
 * the model as they stood: `sudo grep requirepass /etc/redis/redis.conf` would have sent the password.
 */
const PASSWORD = "Zk3vQm9TtLp2Wx8Rb7Nc"; // pragma: allowlist secret

describe("Redis passwords are masked where Redis keeps them", () => {
  it("in redis.conf, also as grep shows it", () => {
    expect(maskContext(`requirepass ${PASSWORD}`)).toBe("requirepass [redacted]");
    expect(maskContext(`masterauth ${PASSWORD}`)).toBe("masterauth [redacted]");
    expect(maskContext(`  requirepass "${PASSWORD}"`)).toBe('  requirepass "[redacted]"');
    expect(maskContext(`/etc/redis/redis.conf:1036:requirepass ${PASSWORD}`)).toBe("/etc/redis/redis.conf:1036:requirepass [redacted]");
  });

  it("in CONFIG SET and in what CONFIG GET prints", () => {
    expect(maskContext(`redis-cli CONFIG SET masterauth ${PASSWORD}`)).toBe("redis-cli CONFIG SET masterauth [redacted]");
    expect(maskContext(`1) "requirepass"\n2) "${PASSWORD}"`)).toBe('1) "requirepass"\n2) "[redacted]"');
    expect(maskContext(`requirepass\n${PASSWORD}\nmaxmemory\n0`)).toBe("requirepass\n[redacted]\nmaxmemory\n0");
  });

  it("in an ACL rule", () => {
    expect(maskContext(`user app on >${PASSWORD} ~shop:* +@read`)).toBe("user app on >[redacted] ~shop:* +@read");
    expect(maskContext(`redis-cli ACL SETUSER app on '>${PASSWORD}' '~shop:*'`)).toBe("redis-cli ACL SETUSER app on '>[redacted]' '~shop:*'");
  });

  it("shows code as it is: a variable, a command substitution or a runbook's placeholder is no password", () => {
    for (const text of [
      "requirepass {{password}}",
      'redis-cli CONFIG SET masterauth "$REDIS_PASSWORD"',
      "masterauth $(cat /run/secrets/redis)",
      "user app on >{{password}} ~shop:* +@read",
      "redis-cli ACL SETUSER app on \">$APP_PASS\"",
    ])
      expect(maskContext(text)).toBe(text);
  });

  it("leaves sentences about them alone", () => {
    for (const text of ["Set requirepass in redis.conf and restart.", "masterauth is set on the replica", "requirepass and masterauth must match."])
      expect(maskContext(text)).toBe(text);
  });
});
