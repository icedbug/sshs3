import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebAuthService } from "../../src/main/web/WebAuthService";

/** What one user of a shared server can do to the others. From the review of feature 12. */

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const d of disposals.splice(0)) await d();
});

async function hub(opts: { shared: boolean; admin: boolean }) {
  const { HubService } = await import("../../src/main/ai/hub/HubService");
  const { setDemoModeForTesting } = await import("../../src/main/demo/demoMode");
  setDemoModeForTesting(false);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-team-"));
  const h = new HubService(
    {
      changed: () => {},
      inventoryTargets: async () => [],
      backgroundChanged: async () => {},
      openSchedule: async () => "s1",
      show: () => {},
      aiConfigFilePath: path.join(dir, "ai.json"),
      workspaceServers: async () => [],
      ...(opts.shared ? { alertHookOwner: "u1", teamAdmin: () => opts.admin } : {}),
    } as never,
    dir,
  );
  disposals.push(async () => {
    await h.dispose();
    setDemoModeForTesting(undefined);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await h.initialize();
  return h;
}

describe("the team's bucket on a shared server", () => {
  it("is set up, changed and disconnected by an administrator only", async () => {
    const member = await hub({ shared: true, admin: false });
    await expect(member.request({ action: "workspace-s3-configure", config: { bucket: "mine", accessKeyId: "A", secretAccessKey: "S" } } as never)).rejects.toThrow(/Only an administrator/);
    await expect(member.request({ action: "workspace-s3-disconnect" })).rejects.toThrow(/Only an administrator/);
    // A member cannot sign the team's records as somebody else either.
    await member.request({ action: "workspace-s3-configure", config: { actorName: "The Boss" } } as never);
    expect((await member.snapshot()).config.actorName ?? "").not.toBe("The Boss");
  });
});

describe("an agent arriving from the team bucket", () => {
  it("cannot be made freer here than a person here made it", async () => {
    const h = await hub({ shared: false, admin: true });
    await h.request({ action: "agent-save", agent: { id: "a", name: "Ops", role: "r", mission: "m", systemPrompt: "", defaultMode: "assisted", allowedTools: ["terminal_command"] } as never });
    const local = h.store.data.agents!.find((x) => x.id === "a")!;
    const { incomingAgentForTesting } = await import("../../src/main/ai/hub/HubService");
    const remote = { ...local, defaultMode: "autonomous" as const, allowedTools: ["terminal_command", "sshs3_change", "file_write"], updatedAt: Date.now() + 365 * 86_400_000 };
    const taken = incomingAgentForTesting(remote, local);
    expect(taken.defaultMode).toBe("assisted");
    expect(taken.allowedTools).toEqual(["terminal_command"]);
    expect(taken.updatedAt).toBeLessThan(Date.now() + 10 * 60_000);
    // A new one arrives at most assisted.
    expect(incomingAgentForTesting({ ...remote, id: "new" }, undefined).defaultMode).toBe("assisted");
  });
});

describe("a password change", () => {
  it("ends every other sign-in of that user, and keeps the one it was made from", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-auth-"));
    disposals.push(() => fs.rm(dir, { recursive: true, force: true }));
    const auth = new WebAuthService(dir);
    await auth.initialize();
    const { user, sessionToken: here } = await auth.setupInitialAdmin({ username: "jacob", password: "test-pass-123", displayName: "Jacob" } as never);
    const { sessionToken: elsewhere } = await auth.login("jacob", "test-pass-123");
    await auth.changePassword(user.id, "test-pass-123", "new-pass-4567", here);
    expect(await auth.verifySession(here)).toBeTruthy();
    expect(await auth.verifySession(elsewhere)).toBeFalsy();
  });
});
