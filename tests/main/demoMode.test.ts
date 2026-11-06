import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEMO_FLAG,
  demoModeRelaunchArgs,
  demoModeRequested,
  demoWorkspaceDir,
  isDemoMode,
  isDemoTarget,
  setDemoModeForTesting,
} from "../../src/main/demo/demoMode";
import { isDemoMode as isDemoModeFromDemoWorkspace } from "../../src/main/ai/hub/demoWorkspace";
import type { HubHost } from "../../src/main/ai/hub/HubService";
import type { AgentTask } from "../../src/shared/types/aiHub";

const disposals: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  setDemoModeForTesting(undefined);
});

describe("demo mode decision", () => {
  it("is asked for by --demo or SSHS3_DEMO=1 (SSHS3_DEMO_WORKSPACE=1 as an alias), nothing else", () => {
    expect(demoModeRequested(["electron", ".", DEMO_FLAG], {})).toBe(true);
    expect(demoModeRequested(["sshs3"], { SSHS3_DEMO: "1" })).toBe(true);
    expect(demoModeRequested(["sshs3"], { SSHS3_DEMO_WORKSPACE: "1" })).toBe(true);
    expect(demoModeRequested(["sshs3"], {})).toBe(false);
    expect(demoModeRequested(["sshs3", "--demo-lab"], { SSHS3_DEMO: "0" })).toBe(false);
  });

  it("has one source of truth, which only tests can override", () => {
    const atLaunch = isDemoMode();
    setDemoModeForTesting(!atLaunch);
    expect(isDemoMode()).toBe(!atLaunch);
    expect(isDemoModeFromDemoWorkspace()).toBe(!atLaunch);
    setDemoModeForTesting(undefined);
    expect(isDemoMode()).toBe(atLaunch);
  });

  it("cannot be switched by application code at runtime", () => {
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => setDemoModeForTesting(true)).toThrow(/decided at launch/);
    } finally {
      if (vitest !== undefined) process.env.VITEST = vitest;
    }
  });

  it("keeps demo data in a demo-workspace directory inside the normal one, applied idempotently", () => {
    const base = path.join(os.tmpdir(), "sshs3-profile");
    const demoDir = demoWorkspaceDir(base);
    expect(demoDir).toBe(path.join(base, "demo-workspace"));
    expect(demoWorkspaceDir(demoDir)).toBe(demoDir);
  });

  it("relaunches with --demo added or removed and every other argument kept", () => {
    expect(demoModeRelaunchArgs([".", "--no-sandbox"], true)).toEqual([".", "--no-sandbox", "--demo"]);
    expect(demoModeRelaunchArgs([".", "--demo", "--no-sandbox"], true)).toEqual([".", "--no-sandbox", "--demo"]);
    expect(demoModeRelaunchArgs([".", "--demo", "--no-sandbox", "--demo"], false)).toEqual([".", "--no-sandbox"]);
    expect(demoModeRelaunchArgs([], false)).toEqual([]);
  });
});

describe("isDemoTarget", () => {
  it("is false for every target outside demo mode", () => {
    setDemoModeForTesting(false);
    expect(isDemoTarget("demo-netapp-aff-a800-01a")).toBe(false);
    expect(isDemoTarget({ id: "demo-s3-storagegrid" })).toBe(false);
  });

  it("recognises the demo fixtures by explicit identity only", () => {
    setDemoModeForTesting(true);
    expect(isDemoTarget("demo-netapp-aff-a800-01a")).toBe(true);
    expect(isDemoTarget("sftp-demo-netapp-aff-a800-01a")).toBe(true);
    expect(isDemoTarget("s3-demo-s3-storagegrid")).toBe(true);
    expect(isDemoTarget({ id: "6f1c2a9e-1b7d-4a53-9f0e-2d8c4b7a1e35", profileId: "demo-ceph-mon-01" })).toBe(true);
    expect(isDemoTarget("6f1c2a9e-1b7d-4a53-9f0e-2d8c4b7a1e35", "demo-mcp-storagegrid")).toBe(true);
    // A real profile is never treated as fake, whatever its host, IP range or endpoint looks like.
    expect(isDemoTarget({ id: "6f1c2a9e-1b7d-4a53-9f0e-2d8c4b7a1e35" })).toBe(false);
    expect(isDemoTarget("sftp-6f1c2a9e-1b7d-4a53-9f0e-2d8c4b7a1e35")).toBe(false);
    expect(isDemoTarget("s3-my-demo-bucket")).toBe(false);
    expect(isDemoTarget(undefined, null, "")).toBe(false);
  });
});

describe("HubService and demo mode", () => {
  async function createHub(host: Partial<HubHost> = {}, seed?: unknown) {
    const { HubService } = await import("../../src/main/ai/hub/HubService");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sshs3-demo-mode-"));
    if (seed !== undefined) await fs.writeFile(path.join(tmpDir, "hub.json"), JSON.stringify(seed));
    const hub = new HubService(
      {
        changed: () => {},
        inventoryTargets: async () => [],
        backgroundChanged: async () => {},
        openSchedule: async () => "s1",
        show: () => {},
        aiConfigFilePath: path.join(tmpDir, "ai-config.json"),
        ...host,
      },
      tmpDir,
    );
    disposals.push(async () => {
      await hub.dispose();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
    await hub.initialize();
    return { hub, tmpDir };
  }

  it("restarts through the desktop host when the Demo-Lab toggle asks for the other mode", async () => {
    setDemoModeForTesting(false);
    const relaunchForDemoMode = vi.fn(async (_demoMode: boolean) => true);
    const { hub } = await createHub({ relaunchForDemoMode });

    const unchanged = await hub.request({ action: "demo-mode-toggle", enabled: false });
    expect(unchanged.demoMode).toBe(false);
    expect(relaunchForDemoMode).not.toHaveBeenCalled();

    const afterToggle = await hub.request({ action: "demo-mode-toggle", enabled: true });
    expect(relaunchForDemoMode).toHaveBeenCalledTimes(1);
    expect(relaunchForDemoMode).toHaveBeenCalledWith(true);
    // The running process never switches; only the restarted one runs in demo mode.
    expect(afterToggle.demoMode).toBe(false);
    expect(isDemoMode()).toBe(false);
  });

  it("refuses the toggle where the app cannot restart itself (web mode)", async () => {
    setDemoModeForTesting(false);
    const { hub } = await createHub();
    await expect(hub.request({ action: "demo-mode-toggle", enabled: true })).rejects.toThrow(
      /set when the sshs3 server starts/,
    );
    expect(isDemoMode()).toBe(false);
  });

  it("drops the Demo-Lab preference older builds stored, without letting it decide the mode", async () => {
    setDemoModeForTesting(false);
    const { hub, tmpDir } = await createHub(
      {},
      {
        version: 1,
        preferences: {
          background: false,
          autoStart: false,
          inventory: false,
          retentionDays: 30,
          demoLabEnabled: true,
        },
        tasks: [],
        memories: [],
        schedules: [],
        inventory: [],
        history: [],
      },
    );
    expect(isDemoMode()).toBe(false);
    const snap = await hub.snapshot();
    expect(snap.demoMode).toBe(false);
    expect("demoLabEnabled" in snap.preferences).toBe(false);
    const stored = JSON.parse(await fs.readFile(path.join(tmpDir, "hub.json"), "utf8")) as {
      preferences: Record<string, unknown>;
    };
    expect("demoLabEnabled" in stored.preferences).toBe(false);
  });

  it("never lets the AI switch demo mode through a tool", async () => {
    setDemoModeForTesting(false);
    const relaunchForDemoMode = vi.fn(async (_demoMode: boolean) => true);
    const { hub } = await createHub({ relaunchForDemoMode });
    const task: AgentTask = {
      id: "task-demo-mode",
      title: "Switch demo mode",
      mode: "advice",
      status: "running",
      messages: [],
      changes: [],
      sources: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      maxCommands: 10,
      maxMinutes: 5,
      verification: "not-verified",
    };
    const cap = await hub.broker.issue(task);
    const res = (await hub.broker.invoke(cap.key, {
      action: "sshs3_manage_app_and_settings",
      payload: { operation: "update_settings", demoMode: true },
    })) as { ok: boolean; demoMode: boolean; demoModeNote?: string };
    expect(res.ok).toBe(true);
    expect(res.demoMode).toBe(false);
    expect(res.demoModeNote).toMatch(/not changed/);
    expect(isDemoMode()).toBe(false);
    expect(relaunchForDemoMode).not.toHaveBeenCalled();
  });
});
