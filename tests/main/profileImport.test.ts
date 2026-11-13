import { describe, expect, it } from "vitest";
import { planProfileImport } from "../../src/main/profile/profileImport";

const opts = {
  valid: (p: Record<string, unknown>) => Boolean(p.host),
  secretFields: ["password", "passphrase"],
  localOnlyFields: ["privateKeyPath", "pkcs11LibPath", "agentPath"],
  identityFields: ["host", "port", "username"],
};

describe("importing profiles", () => {
  const saved = [{ id: "a", host: "pg-01", port: 22, username: "ops", password: "S3cret!", privateKeyPath: "/home/me/.ssh/id", proxy: { host: "p", password: "pp" } }];

  it("keeps saved passwords and local paths when the file has none", () => {
    const plan = planProfileImport([{ id: "a", host: "pg-01", port: 22, username: "ops", name: "Postgres", proxy: { host: "p" } }], saved, opts);
    expect(plan).toMatchObject({ added: 0, updated: 1 });
    expect(plan.save[0]).toMatchObject({ id: "a", name: "Postgres", password: "S3cret!", privateKeyPath: "/home/me/.ssh/id", proxy: { host: "p", password: "pp" } });
  });

  it("never takes machine-local fields from a file", () => {
    const plan = planProfileImport([{ id: "a", host: "pg-01", port: 22, username: "ops", pkcs11LibPath: "/tmp/evil.so" }, { host: "new", agentPath: "/tmp/sock" }], saved, opts);
    expect(plan.save[0]).not.toHaveProperty("pkcs11LibPath");
    expect(plan.save[1]).not.toHaveProperty("agentPath");
  });

  it("adds a profile with the same id but another server as a new one", () => {
    const plan = planProfileImport([{ id: "a", host: "attacker", port: 22, username: "ops" }], saved, opts);
    expect(plan).toMatchObject({ added: 1, updated: 0 });
    expect(plan.save[0].id).not.toBe("a");
    expect(plan.save[0]).not.toHaveProperty("password");
  });

  it("skips what is not a profile", () => {
    expect(planProfileImport([null, 3, [], { port: 22 }], saved, opts).save).toEqual([]);
  });
});
